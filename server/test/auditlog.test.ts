import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { setHandOrgRole } from '../src/orgrole.js';
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

// USER-TESTING.md T4.9. A non-technical contributor found her typed questions
// in the audit log, readable by other people. `auditWhere` already restricted
// an ask that named NO collection to the asker and to operators — but an ask
// scoped to a collection is an event naming that collection, so it reached
// every member, question text and all. Measured on a running server before
// this: a colleague holding only `view` could read "how do I raise a grievance
// about my manager".
test('audit: a question is readable by the person who asked it and by an operator, and by nobody else', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const priya = store.createActor({ kind: 'person', name: 'Priya' });
  const colleague = store.createActor({ kind: 'person', name: 'Colleague' });
  const operator = store.createActor({ kind: 'person', name: 'Ops' });
  const stranger = store.createActor({ kind: 'person', name: 'Stranger' });
  const collection = store.createCollection(priya.id, { name: 'People' });
  store.setMember(priya.id, collection.id, colleague.id, 'view');
  // The operator is given a role here too, and that is not incidental: an ask
  // that NAMES a collection is an event naming that collection, so `auditWhere`
  // rule 1 governs it and an operator holding no role in the collection cannot
  // see the event at all — the org role widens nothing on its own. So the two
  // readers who get the text are "the person who asked" and "somebody who can
  // already see the event AND is an operator", and the second only exists
  // where a role puts them in the collection.
  store.setMember(priya.id, collection.id, operator.id, 'view');
  setHandOrgRole(db, operator.id, 'operator', null);

  const QUESTION = 'how do I raise a grievance about my manager';
  db.prepare(
    `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
     VALUES (?, ?, 'person', 'answer.ask', ?, NULL, ?)`,
  ).run('2026-08-01T10:00:00.000Z', priya.id, collection.id, JSON.stringify({ question: QUESTION, refused: false }));

  const asked = (actorId: string) => store.queryAudit(actorId, { action: 'answer.ask' });

  assert.equal(asked(priya.id)[0]!.details.question, QUESTION, 'the asker reads her own question');
  assert.equal(asked(operator.id)[0]!.details.question, QUESTION, 'an operator investigating an incident reads it');

  // The colleague still sees THAT it happened — that is genuine audit material
  // and answers "who looked at this before that decision" — but not the words.
  const seen = asked(colleague.id);
  assert.equal(seen.length, 1, 'the event is not hidden, only the sentence');
  assert.match(String(seen[0]!.details.question), /^\[redacted/);
  assert.doesNotMatch(String(seen[0]!.details.question), /grievance/);
  assert.equal(seen[0]!.actorId, priya.id, 'who asked, and when, is still attributable');

  assert.equal(asked(stranger.id).length, 0, 'somebody with no role sees no event at all');

  // And an operator with no role in the collection sees nothing either: being
  // an operator is not a way into a collection's events.
  const outsideOperator = store.createActor({ kind: 'person', name: 'Ops2' });
  setHandOrgRole(db, outsideOperator.id, 'operator', null);
  assert.equal(asked(outsideOperator.id).length, 0);

  // The stored event is untouched: redaction is on the way out, so an operator
  // keeps the record and the hash chain still covers the row as written.
  const stored = db.prepare('SELECT details_json FROM audit_events WHERE action = ?').get('answer.ask') as {
    details_json: string;
  };
  assert.equal(JSON.parse(stored.details_json).question, QUESTION);
});

// ---------------------------------------------------------------------------
// The export in the browser (third round, Ruth — confirmed at source): a bare
// <a href="/audit.csv"> is a navigation, not an app request, so it carried no
// X-Actor-Id and the export failed under header auth for exactly the person
// it exists for. Pinned in the shipped file, the way pageview.test.ts pins
// the editor: the anchor is gone, the click goes through the one helper that
// attaches identity in both auth modes, and the server's truncation mark is
// surfaced rather than dropped on the floor.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

test('audit export: no bare anchor — the CSV is fetched with the caller’s identity attached', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  // The defect, pinned as its absence: nothing may point a plain link at the
  // CSV route, because a navigation bypasses every header the app attaches.
  assert.ok(!/href=["'`]\/audit\.csv/.test(source), 'a bare audit.csv anchor carries no X-Actor-Id');
  assert.ok(!source.includes("setAttribute('href', `/audit.csv"), 'nor one assembled at runtime');
  // The road it takes instead: downloadFromApi, which mirrors api()'s rule —
  // X-Actor-Id under the dev door, ambient cookie under SSO, never both.
  assert.match(source, /downloadFromApi\(`\/audit\.csv/);
  const helper = source.slice(source.indexOf('async function downloadFromApi('), source.indexOf('function attestationPreviewHTML('));
  assert.match(helper, /headers\['X-Actor-Id'\] = actorId/);
  assert.match(helper, /credentials: 'same-origin'/, 'the cookie mode rides on the same call');
  assert.match(helper, /return res;/, 'the response comes back so the caller can read what the server said about the file');
});

test('audit export: the truncation mark survives the download as a sentence, not a lost header', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewAudit('), source.indexOf('// Sources — registered external systems'));
  assert.match(view, /x-canon-truncated/);
  assert.match(view, /NOT the whole filtered log/, 'the header becomes the sentence an auditor needs');
  assert.match(view, /Narrow with From\/To/, 'and the way out is named beside it');
});

// Fourth round, Ada and Tomas: the rule about question text — kept in the
// audit log, readable by the asker and by operators — was stated honestly
// everywhere except to the person it most concerns. The Ask screen now says
// it where the typing happens, quietly, next to the grounding sentence.
test('ask screen: the asker is told their question is recorded, and for whom', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewAsk('), source.indexOf("const idleHTML"));
  assert.match(view, /Questions are kept in the audit log, readable by you and by\s+this record's operators\./);
});

// Round seven, Phase 5. The audit screen draws from two routes — `/audit` for
// the rows, `/audit/summary` for the size of the population — and let them
// speak separately. The count line was written ONLY in the branch that had
// rows, so narrowing a filter down to nothing left the previous filter's
// sentence standing over a fresh empty panel: "168 events match these filters"
// and "No matching events", on screen together, about two different filters.
//
// The rule this pins: never render an empty result as a factual claim of
// absence, and never enable an action whose consequences have not loaded.

/** A top-level `function NAME(` lifted out of the shipped browser file, the
 *  way pageview.test.ts and markdown.test.ts lift theirs. */
function liftFunction(source: string, name: string): string {
  const found = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(found, `public/app.js declares ${name}()`);
  return found[0];
}

const auditClient = readFileSync(findPublicFile('app.js'), 'utf8');
const auditCountLine = new Function(
  `${liftFunction(auditClient, 'auditCountLine')}\nreturn auditCountLine;`,
)() as (shown: number, matching: number) => string;
const auditEmptyHeading = new Function(
  `${liftFunction(auditClient, 'auditEmptyHeading')}\nreturn auditEmptyHeading;`,
)() as (matching: number) => string;

test('audit count: an empty population says so in its own words, not by silence', () => {
  assert.equal(auditCountLine(0, 0), 'No events in the log match these filters.');
  assert.equal(auditEmptyHeading(0), 'No matching events');
});

test('audit count: a count and an empty listing that disagree are reported as a disagreement', () => {
  // Neither number wins. A screen that picked one would state a falsehood in a
  // compliance artefact with full confidence; saying the walk is unreliable is
  // the only claim that is true whichever route is wrong.
  const line = auditCountLine(0, 168);
  assert.match(line, /168/, 'the count is not silently dropped');
  assert.match(line, /Reload/, 'and the reader is told the listing cannot be trusted as empty');
  assert.doesNotMatch(line, /All of them are shown/);
  assert.notEqual(auditEmptyHeading(168), 'No matching events', 'the heading may not claim absence');
});

test('audit count: a partial page is never rendered as the whole population', () => {
  assert.equal(auditCountLine(200, 1187), 'Showing the 200 most recent of 1,187 matching events.');
  assert.equal(auditCountLine(1187, 1187), '1,187 events match these filters. All of them are shown.');
  assert.equal(auditCountLine(1, 1), '1 event matches these filters. All of them are shown.');
});

test('audit screen: the count line is written before the empty branch can return', () => {
  // The defect was structural, not textual: an early `return` above the only
  // assignment. Pinned where it happened, because a future edit that moves the
  // assignment back below the guard reintroduces the exact stale sentence.
  const view = auditClient.slice(
    auditClient.indexOf('async function viewAudit('),
    auditClient.indexOf('// Sources — registered external systems'),
  );
  const render = view.slice(view.indexOf('const render = (matching) => {'));
  const assigned = render.indexOf('countHost.textContent = auditCountLine(');
  const guard = render.indexOf('if (!shown.length)');
  assert.ok(assigned !== -1 && guard !== -1, 'both the assignment and the empty guard are still there');
  assert.ok(assigned < guard, 'the count is written before the empty listing can return');
  // And a new load drops the old population entirely rather than letting it
  // describe the next one.
  assert.match(view, /clearPopulation\('Enables when the log has loaded\.'\)/);
});

test('audit export: the button does not offer to download a population nobody has counted', () => {
  const view = auditClient.slice(
    auditClient.indexOf('async function viewAudit('),
    auditClient.indexOf('// Sources — registered external systems'),
  );
  assert.match(view, /id="audit-export" type="button" disabled/, 'it ships disabled');
  assert.match(view, /exportBtn\.disabled = false;/, 'and is enabled only once the summary has landed');
  // A failed load knows nothing about the population either.
  assert.match(view, /clearPopulation\('The log did not load/);
});

test('gaps: an empty tab describes that tab, never the whole record', () => {
  // One sentence served all three tabs: "No <status> gaps. Every question the
  // record refused has been looked at." On the Resolved tab, empty means
  // nothing has been resolved — the opposite of what it said.
  const view = auditClient.slice(auditClient.indexOf('async function viewGaps('), auditClient.indexOf('async function viewAudit('));
  assert.match(view, /No gap has been resolved yet/);
  assert.match(view, /No gap has been dismissed/);
  assert.doesNotMatch(view, /No \$\{esc\(status\)\} gaps/, 'the status is no longer interpolated into a claim about the record');
});
