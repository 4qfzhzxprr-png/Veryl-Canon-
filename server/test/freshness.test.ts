import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { ensurePageFreshnessSchema, isPastReview, today } from '../src/freshness.js';
import type { Notification, NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

// Verification and freshness (FEATURES.md §3): a Canonical page carries a
// review date; when it passes, the page flips to Needs Update and the owner is
// notified. These tests hold that promise to its exact wording — only
// Canonical pages, only passed dates, the owner told once and never twice.

const quiet: NotificationTransport = { deliver() {} };

function setup(transport: NotificationTransport = quiet) {
  const db = openDb(':memory:');
  const store = new CanonStore(db, transport);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { db, store, dana, marc, iris, collection };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

// A policy all the way to Canonical, carrying the review date it was given.
function canonicalPolicy(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
  reviewDate: string,
  ownerId = editorId,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, { body, fields: { ownerId, approverId, reviewDate } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

function ofKind(store: CanonStore, actorId: string, kind: Notification['kind']): Notification[] {
  return store.listNotifications(actorId).filter((n) => n.kind === kind);
}

test('review date: required where the type demands it, refused where it makes no sense', () => {
  const { store, marc, iris, collection } = setup();

  // Policy: FEATURES.md §1 says a Policy requires an owner, a review date, and
  // an approver. Owner and approver alone are not enough to publish.
  const policy = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, policy.id, { body: 'Keep records 7 years.', fields: { ownerId: marc.id, approverId: iris.id } });
  const refused = expectCode(() => store.publish(marc.id, policy.id), 'workflow');
  assert.match(refused!.message, /review date/);
  expectCode(() => store.submitForReview(marc.id, policy.id), 'workflow');

  store.editDraft(marc.id, policy.id, { fields: { reviewDate: '2027-03-01' } });
  const published = store.publish(marc.id, policy.id);
  assert.equal(published.reviewDate, '2027-03-01'); // structured field, on the page

  // Spec and Plan may carry one; neither is made to.
  const spec = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  store.editDraft(marc.id, spec.id, { body: 'Endpoints.', fields: { ownerId: marc.id, approverId: iris.id } });
  assert.equal(store.publish(marc.id, spec.id).reviewDate, null);
  store.editDraft(marc.id, spec.id, { fields: { reviewDate: '2028-01-15' } });
  assert.equal(store.publish(marc.id, spec.id).reviewDate, '2028-01-15');

  // A Note never carries the Canonical mark, so it carries no review date.
  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  expectCode(() => store.editDraft(marc.id, note.id, { fields: { reviewDate: '2027-03-01' } }), 'invalid');

  // And a review date is a date, not prose.
  expectCode(() => store.editDraft(marc.id, spec.id, { fields: { reviewDate: 'next spring' } }), 'invalid');
  expectCode(() => store.editDraft(marc.id, spec.id, { fields: { reviewDate: '2027-13-45' } }), 'invalid');
});

test('freshness sweep: flips only Canonical pages whose review date has passed', () => {
  const { store, dana, marc, iris, collection } = setup();

  const overdue = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention', 'Keep 7 years.', '2026-01-01');
  const future = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Access', 'All access logged.', '2099-01-01');
  // Canonical, but carrying no review date at all: nothing was promised.
  const undated = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  store.editDraft(marc.id, undated.id, { body: 'Endpoints.', fields: { ownerId: marc.id, approverId: iris.id } });
  store.submitForReview(marc.id, undated.id);
  store.approve(iris.id, undated.id);
  // A draft carrying a past review date: never approved, so nothing to lose.
  const draft = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'Draft spec' });
  store.editDraft(marc.id, draft.id, { body: 'Later.', fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2020-01-01' } });
  store.publish(marc.id, draft.id);

  const result = store.sweepFreshness(dana.id, { on: '2026-06-01' });
  assert.equal(result.flipped, 1);
  assert.deepEqual(result.pages.map((p) => p.pageId), [overdue.id]);
  assert.equal(result.pages[0]!.reviewDate, '2026-01-01');
  assert.equal(store.getPage(dana.id, overdue.id).status, 'needs_update');
  assert.equal(store.getPage(dana.id, future.id).status, 'canonical');
  assert.equal(store.getPage(dana.id, undated.id).status, 'canonical');
  assert.equal(store.getPage(dana.id, draft.id).status, 'draft');

  // The day the review falls due is not a day late.
  const onTheDay = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Due today', 'Text.', '2026-07-01');
  assert.equal(store.sweepFreshness(dana.id, { on: '2026-07-01' }).flipped, 0);
  assert.equal(store.getPage(dana.id, onTheDay.id).status, 'canonical');
  assert.equal(store.sweepFreshness(dana.id, { on: '2026-07-02' }).flipped, 1);
  assert.equal(store.getPage(dana.id, onTheDay.id).status, 'needs_update');
});

test('freshness sweep: notifies the owner through the outbox, audits, and is idempotent', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention', 'Keep 7 years.', '2026-01-01', marc.id);

  const first = store.sweepFreshness(dana.id, { on: '2026-06-01' });
  assert.equal(first.flipped, 1);
  assert.equal(first.notified, 1);
  assert.equal(first.unowned, 0);

  // The owner is told, through the same outbox every other notification uses.
  const notices = ofKind(store, marc.id, 'review_due');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.subject, /Past review: Retention/);
  assert.match(notices[0]!.body, /2026-01-01/);
  assert.equal(notices[0]!.link, `/pages/${page.id}`);
  assert.ok(notices[0]!.sentAt, 'delivered by the transport, like any other notification');
  assert.equal(ofKind(store, iris.id, 'review_due').length, 0); // the approver is not the owner

  // The audit event, in the vocabulary the task names.
  const events = store.queryAudit(dana.id, { action: 'page.needs_update' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.pageId, page.id);
  assert.equal(events[0]!.collectionId, collection.id);
  assert.equal(events[0]!.actorId, dana.id);
  assert.equal(events[0]!.details.from, 'canonical');
  assert.equal(events[0]!.details.to, 'needs_update');
  assert.equal(events[0]!.details.reviewDate, '2026-01-01');

  // Idempotence, and it is structural: the page is no longer Canonical, so the
  // second sweep does not see it. No second notification, no second audit event.
  const second = store.sweepFreshness(dana.id, { on: '2026-06-01' });
  assert.deepEqual({ scanned: second.scanned, flipped: second.flipped, notified: second.notified }, { scanned: 0, flipped: 0, notified: 0 });
  assert.equal(ofKind(store, marc.id, 'review_due').length, 1);
  assert.equal(store.queryAudit(dana.id, { action: 'page.needs_update' }).length, 1);
});

test('freshness sweep: an ownerless page flips with nobody to notify, and maintenance needs admin', () => {
  const { db, store, dana, marc, iris, collection } = setup();
  const page = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention', 'Keep 7 years.', '2026-01-01');
  // Ownership can be lost after approval — a leaver, a transfer that never
  // completed. The record says so directly rather than through a workflow that
  // does not exist yet.
  db.prepare('UPDATE pages SET owner_id = NULL WHERE id = ?').run(page.id);

  const result = store.sweepFreshness(dana.id, { on: '2026-06-01' });
  assert.equal(result.flipped, 1);
  assert.equal(result.notified, 0);
  assert.equal(result.unowned, 1);
  assert.equal(result.pages[0]!.notified, false);

  // The sweep is maintenance: it asks for admin on a collection, the same
  // question the notification flush asks, because Core has no global admin.
  expectCode(() => store.sweepFreshness(marc.id, { on: '2026-06-01' }), 'forbidden');
  expectCode(() => store.sweepFreshness(iris.id, { on: '2026-06-01' }), 'forbidden');
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.sweepFreshness(outsider.id, { on: '2026-06-01' }), 'forbidden');
  // And it judges against a date, not a mood.
  expectCode(() => store.sweepFreshness(dana.id, { on: 'soon' }), 'invalid');
});

test('needs update: back to Canonical by the review workflow, and no other way', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention', 'Keep 7 years.', '2026-01-01');
  store.sweepFreshness(dana.id, { on: '2026-06-01' });
  assert.equal(store.getPage(dana.id, page.id).status, 'needs_update');

  // The owner edits, submits, and the named approver accepts. The same three
  // steps that grant the mark in the first place — there is no second path.
  store.editDraft(marc.id, page.id, {
    body: 'Keep records 7 years, reviewed annually.',
    fields: { reviewDate: '2099-01-01' },
  });
  assert.equal(store.submitForReview(marc.id, page.id).status, 'in_review');
  const approved = store.approve(iris.id, page.id);
  assert.equal(approved.status, 'canonical');
  assert.equal(approved.reviewDate, '2099-01-01');

  // And the next sweep leaves it alone, because the promise was renewed.
  assert.equal(store.sweepFreshness(dana.id, { on: '2026-06-02' }).flipped, 0);
});

test('needs update: ranked below Canonical and above everything unreviewed in search', () => {
  const { store, dana, marc, iris, collection } = setup();
  const stale = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Badger policy (stale)', 'Badger handling is documented.', '2026-01-01');
  const current = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Badger policy', 'Badger handling is documented.', '2099-01-01');
  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Badger scratch' });
  store.editDraft(marc.id, note.id, { body: 'Badger handling is documented, roughly.' });
  store.publish(marc.id, note.id);

  store.sweepFreshness(dana.id, { on: '2026-06-01' });
  const hits = store.searchIndex.search(marc.id, { q: 'badger handling' });
  assert.deepEqual(hits.map((h) => h.pageId), [current.id, stale.id, note.id]);
  assert.equal(hits[1]!.status, 'needs_update');

  // And it is a first-class filter value, not a status search refuses to speak.
  const filtered = store.searchIndex.search(marc.id, { q: 'badger', status: 'needs_update' });
  assert.deepEqual(filtered.map((h) => h.pageId), [stale.id]);
});

test('needs update: grounded answers may cite it, and say it is past review', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const policy = canonicalPolicy(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Pangolin retention policy',
    'The pangolin retention period is seven years.',
    '2026-01-01',
  );

  const before = await store.ask(marc.id, { question: 'What is the pangolin retention period?' });
  assert.equal(before.refused, false);
  assert.equal(before.pastReview, undefined); // nothing to flag while it is current

  store.sweepFreshness(dana.id, { on: '2026-06-01' });

  // The decision, defended in answers.ts: a Needs Update page is still the
  // record's own answer, so it is still cited — and the answer says so.
  const after = await store.ask(marc.id, { question: 'What is the pangolin retention period?' });
  assert.equal(after.refused, false, 'refusing here would punish the owner for setting a review date at all');
  assert.deepEqual(after.citations.map((c) => c.pageId), [policy.id]);
  assert.ok(after.answer!.includes('seven years'));
  assert.match(after.answer!, /past review/);
  assert.deepEqual(after.pastReview, [{ pageId: policy.id, title: 'Pangolin retention policy' }]);

  // The boundary did not move for anything else: an archived page is still gone.
  store.archivePage(marc.id, policy.id);
  const archived = await store.ask(marc.id, { question: 'What is the pangolin retention period?' });
  assert.equal(archived.refused, true);
});

test('freshness: the sweep over HTTP, and closed to agents by classification', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor-id': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
    const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
    const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
    const collection = store.createCollection(dana.id, { name: 'Compliance' });
    store.setMember(dana.id, collection.id, marc.id, 'edit');
    store.setMember(dana.id, collection.id, iris.id, 'approve');
    const page = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention', 'Keep 7 years.', '2026-01-01');

    const unauthenticated = await call('POST', '/maintenance/freshness');
    assert.equal(unauthenticated.status, 401);

    const refused = await call('POST', '/maintenance/freshness', marc.id, { on: '2026-06-01' });
    assert.equal(refused.status, 403);

    const swept = await call('POST', '/maintenance/freshness', dana.id, { on: '2026-06-01' });
    assert.equal(swept.status, 200);
    assert.equal(swept.json.flipped, 1);
    assert.equal(swept.json.pages[0].pageId, page.id);

    const again = await call('POST', '/maintenance/freshness', dana.id, { on: '2026-06-01' });
    assert.equal(again.json.flipped, 0);

    // A passport presented to a Canon with no Registry is refused outright, so
    // this asserts the route's shape rather than the classification; the
    // classification itself is that `/maintenance/freshness` appears in NO rule
    // in agentauth.ts, and an unclassified route is refused to every agent.
    const agentAttempt = await fetch(`${base}/maintenance/freshness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-passport': 'anything' },
      body: '{}',
    });
    assert.equal(agentAttempt.status, 503);
  } finally {
    server.close();
  }
});

test('freshness: a database written before review dates existed is brought forward', () => {
  // The pre-freshness pages table, verbatim from the schema of that build: no
  // review_date column, and a CHECK that does not admit needs_update.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE pages (
      id              TEXT PRIMARY KEY,
      collection_id   TEXT NOT NULL REFERENCES collections(id),
      parent_id       TEXT REFERENCES pages(id),
      position        INTEGER NOT NULL DEFAULT 0,
      type            TEXT NOT NULL CHECK (type IN ('policy', 'spec', 'plan', 'note')),
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'in_review', 'canonical', 'archived')),
      owner_id        TEXT REFERENCES actors(id),
      approver_id     TEXT REFERENCES actors(id),
      effective_date  TEXT,
      current_version INTEGER,
      created_by      TEXT NOT NULL REFERENCES actors(id),
      created_at      TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run('c1', 'Compliance');
  db.prepare('INSERT INTO actors (id, name) VALUES (?, ?)').run('a1', 'Marc');
  db.prepare(
    `INSERT INTO pages (id, collection_id, position, type, title, status, owner_id, current_version, created_by, created_at)
     VALUES ('p1', 'c1', 0, 'policy', 'Retention', 'canonical', 'a1', 1, 'a1', '2026-01-01T00:00:00.000Z')`,
  ).run();

  // Before the migration the old CHECK refuses the new status outright.
  assert.throws(() => db.prepare("UPDATE pages SET status = 'needs_update' WHERE id = 'p1'").run());

  ensurePageFreshnessSchema(db);

  const columns = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes('review_date'));
  db.prepare("UPDATE pages SET review_date = '2026-01-01', status = 'needs_update' WHERE id = 'p1'").run();
  const row = db.prepare('SELECT title, status, owner_id, current_version FROM pages WHERE id = ?').get('p1') as Record<
    string,
    unknown
  >;
  assert.equal(row.title, 'Retention'); // the row survived the rebuild intact
  assert.equal(row.status, 'needs_update');
  assert.equal(row.owner_id, 'a1');
  assert.equal(row.current_version, 1);
  // Idempotent: running it again on the migrated database changes nothing.
  ensurePageFreshnessSchema(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n, 1);
});

test('freshness: the date helpers count days, not instants', () => {
  assert.equal(today(new Date('2026-07-31T23:59:59.999Z')), '2026-07-31');
  assert.equal(isPastReview('2026-07-30', '2026-07-31'), true);
  assert.equal(isPastReview('2026-07-31', '2026-07-31'), false); // due today is not late
  assert.equal(isPastReview('2026-08-01', '2026-07-31'), false);
  assert.equal(isPastReview(null, '2026-07-31'), false);
});
