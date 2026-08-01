import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { AUDIT_PAGE_DEFAULT, CanonStore } from '../src/store.js';

// USER-TESTING.md T2.2. An external auditor found the log capped at 1,000 rows
// with no offset, cursor or page parameter, so 187 events of 1,187 were
// unreachable by any documented route; no count of what matched; and
// `collectionId`/`pageId` accepted and silently ignored, which she was explicit
// is worse than refusing them.
//
// The load-bearing test here is the WALK. A cursor that returns a page is easy;
// a cursor that reaches the end of the log without dropping or repeating a row
// is the claim an auditor's sample actually rests on, and it is the one that
// broke in the browser while every other test stayed green — the join that put
// a page's title on each row made the cursor's bare `id < ?` ambiguous against
// `pages.id`, and nothing exercised `before` against the joined query.

function busyRecord() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  const other = store.createCollection(dana.id, { name: 'Engineering' });
  for (let i = 0; i < AUDIT_PAGE_DEFAULT + 30; i += 1) {
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: `Note ${i}` });
  }
  const elsewhere = store.createPage(dana.id, { collectionId: other.id, type: 'note', title: 'Elsewhere' });
  return { store, dana, collection, other, elsewhere };
}

test('audit: the walk reaches every event, exactly once', () => {
  const { store, dana } = busyRecord();
  const total = store.auditSummary(dana.id).matching;
  assert.ok(total > AUDIT_PAGE_DEFAULT, 'the record must be longer than one page for this to mean anything');

  const seen = new Set<number>();
  let before: number | undefined;
  let pages = 0;
  for (;;) {
    const page = store.queryAudit(dana.id, { before, limit: 50 });
    if (page.length === 0) break;
    for (const e of page) {
      assert.ok(!seen.has(e.id), `event ${e.id} came back twice`);
      seen.add(e.id);
    }
    // Newest first, and strictly descending, or the cursor means nothing.
    const ids = page.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    before = ids[ids.length - 1];
    pages += 1;
    assert.ok(pages < 100, 'runaway walk');
  }
  assert.equal(seen.size, total, 'the walk reached every matching event');
});

test('audit: an event written mid-walk cannot displace one the reader has not seen', () => {
  const { store, dana, collection } = busyRecord();
  const first = store.queryAudit(dana.id, { limit: 50 });
  const cursor = first[first.length - 1]!.id;

  // Somebody keeps working while the auditor is paging. Under an OFFSET this
  // is exactly where a row is silently seen twice and another never seen at
  // all: every new event is inserted at the end already read, shifting the
  // tail down. An id cursor names the same set of older rows regardless.
  for (let i = 0; i < 10; i += 1) {
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: `Late ${i}` });
  }

  const second = store.queryAudit(dana.id, { before: cursor, limit: 50 });
  const overlap = second.filter((e) => first.some((f) => f.id === e.id));
  assert.deepEqual(overlap, [], 'the second page repeats nothing from the first');
  assert.ok(second.every((e) => e.id < cursor), 'the second page is strictly older than the cursor');
});

test('audit: the count is the population, not the page', () => {
  const { store, dana } = busyRecord();
  const page = store.queryAudit(dana.id);
  const summary = store.auditSummary(dana.id);
  assert.equal(page.length, AUDIT_PAGE_DEFAULT, 'one page');
  assert.ok(summary.matching > page.length, 'and the population is larger than it');
  // `before` is a position within a walk; the size of the population is not a
  // property of how far the reader has got.
  assert.equal(store.auditSummary(dana.id, { before: page[page.length - 1]!.id }).matching, summary.matching);
});

test('audit: the filters that used to be accepted and ignored actually filter', () => {
  const { store, dana, collection, other, elsewhere } = busyRecord();
  const all = store.auditSummary(dana.id).matching;

  const byCollection = store.auditSummary(dana.id, { collectionId: other.id }).matching;
  assert.ok(byCollection > 0 && byCollection < all, `collection narrowed ${all} to ${byCollection}`);
  assert.ok(
    store.queryAudit(dana.id, { collectionId: other.id }).every((e) => e.collectionId === other.id),
    'every row belongs to the collection asked for',
  );

  const byPage = store.auditSummary(dana.id, { pageId: elsewhere.id }).matching;
  assert.ok(byPage > 0 && byPage < byCollection, `page narrowed ${byCollection} to ${byPage}`);
  assert.ok(store.queryAudit(dana.id, { pageId: elsewhere.id }).every((e) => e.pageId === elsewhere.id));

  // A range that excludes everything returns nothing rather than everything —
  // the failure mode of an ignored filter is the UNFILTERED answer, so this
  // asserts the direction that matters.
  assert.equal(store.auditSummary(dana.id, { to: '1999-12-31T23:59:59Z' }).matching, 0);
  assert.equal(store.auditSummary(dana.id, { from: '2999-01-01T00:00:00Z' }).matching, 0);
  assert.equal(store.queryAudit(dana.id, { collectionId: collection.id, action: 'page.create' }).length > 0, true);
});

test('audit: the action vocabulary comes from the record, and survives choosing one', () => {
  const { store, dana } = busyRecord();
  const actions = store.auditSummary(dana.id).actions;
  const names = actions.map((a) => a.action);
  assert.ok(names.includes('page.create') && names.includes('collection.create'));
  assert.deepEqual(names, [...names].sort(), 'stable order, so a dropdown does not reshuffle');
  assert.equal(
    actions.find((a) => a.action === 'page.create')!.count,
    store.auditSummary(dana.id, { action: 'page.create' }).matching,
  );
  // Choosing an action must not collapse the list to the one already chosen —
  // there would be no way back to any other.
  assert.deepEqual(
    store.auditSummary(dana.id, { action: 'page.create' }).actions.map((a) => a.action),
    names,
  );
});

test('audit: a row names the page it is about, and the name is current rather than historical', () => {
  const { store, dana, elsewhere } = busyRecord();
  const [event] = store.queryAudit(dana.id, { pageId: elsewhere.id });
  assert.equal(event!.pageTitle, 'Elsewhere');
  assert.equal(event!.collectionName, 'Engineering');

  // Renaming the page changes what the log DISPLAYS, because the title is
  // joined at read time and is answering "which page is this?" — not "what was
  // it called then", which is a point-in-time question with its own route.
  store.editDraft(dana.id, elsewhere.id, { title: 'Renamed', body: 'x' });
  store.publish(dana.id, elsewhere.id, {});
  assert.equal(store.queryAudit(dana.id, { pageId: elsewhere.id })[0]!.pageTitle, 'Renamed');
});

test('API: the log pages, counts and exports over HTTP', async () => {
  const { store, dana, other } = busyRecord();
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string) => {
    const res = await fetch(base + path, { headers: { 'x-actor-id': dana.id } });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text.startsWith('[') || text.startsWith('{') ? JSON.parse(text) : text };
  };

  try {
    const summary = (await call('/audit/summary')).json;
    const first = (await call('/audit?limit=50')).json;
    assert.equal(first.length, 50);
    // The walk over HTTP, which is where the ambiguous-column bug actually bit.
    const second = (await call(`/audit?limit=50&before=${first[49].id}`)).json;
    assert.equal(second.length, 50);
    assert.equal(second.filter((e: any) => first.some((f: any) => f.id === e.id)).length, 0);

    const scoped = (await call(`/audit/summary?collection=${other.id}`)).json;
    assert.ok(scoped.matching > 0 && scoped.matching < summary.matching);

    // Refused rather than ignored — a filter that cannot be honoured must not
    // return the unfiltered log wearing a filtered label.
    for (const bad of ['/audit?from=last%20Tuesday', '/audit?collection=', '/audit?before=abc', '/audit?to=2026-13-01']) {
      assert.equal((await call(bad)).status, 400, `${bad} should be refused`);
    }

    // The export is the population the count describes, not the page.
    const csv = await call(`/audit.csv?collection=${other.id}`);
    assert.equal(csv.headers.get('x-canon-rows'), String(scoped.matching));
    assert.equal((csv.json as string).split('\r\n').filter(Boolean).length - 1, scoped.matching);
    assert.equal((await call('/audit.csv?limit=10')).status, 400);
  } finally {
    server.close();
  }
});
