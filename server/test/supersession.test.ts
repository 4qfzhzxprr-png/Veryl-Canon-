// Supersession where a reader ARRIVES, not only where they land.
//
// REMEDIATION-PLAN.md 1.6 asked for supersession state "in search, the
// collection table and Related panels". The Related half landed (af3acf2, the
// banner that says a replacement Ask cannot use leaves the subject unanswered);
// the other two did not, so a reader who searched for a superseded page got a
// plain DRAFT chip and no reason to think anything had replaced it. That is the
// tester's original report, reproduced months after the row was marked fixed.
//
// What these tests hold:
//   * both reads a reader arrives through — GET /search and the collection
//     contents (GET /collections/:id/tree) — carry what replaces a page;
//   * the direction of the claim is not fudged: the page that REPLACES is not
//     itself marked as replaced;
//   * answerability travels, because "superseded by X" only means "the answer
//     moved over there" once X is part of the official record;
//   * EXISTENCE, NEVER IDENTITY. When the replacement sits in a collection the
//     reader holds no role in, the mark says the page is superseded and
//     carries not one field of the page at the far end — asserted against the
//     serialized payload, because a marker whose id rides out on the row beside
//     it is decoration (relations.ts learned that one the hard way).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';
import { isSupersessionWithheld, supersessionMarks } from '../src/supersession.js';
import type { SupersededBy, SupersededByPage } from '../src/supersession.js';

const quiet: NotificationTransport = { deliver() {} };
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  // Vera reads Operations and has no standing at all in Compliance: she is the
  // reader the withheld half of the rule is written for.
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const operations = store.createCollection(dana.id, { name: 'Operations' });
  const compliance = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, operations.id, vera.id, 'view');
  store.setMember(dana.id, operations.id, iris.id, 'approve');
  store.setMember(dana.id, compliance.id, iris.id, 'approve');
  return { db, store, dana, iris, vera, operations, compliance };
}

/** A published Note: no owner, no approver, and never Canonical. */
function note(store: CanonStore, actorId: string, collectionId: string, title: string, body = 'Body.'): string {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body });
  store.publish(actorId, page.id, {});
  return page.id;
}

/** A Policy taken all the way to Canonical, which is what Ask may draw on. */
function canonicalPolicy(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body = 'The official answer.',
): string {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body,
    fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(editorId, page.id);
  store.approve(approverId, page.id);
  return page.id;
}

/** A draft page: created, written, and never published. */
function draft(store: CanonStore, actorId: string, collectionId: string, title: string): string {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body: 'Not agreed by anybody.' });
  return page.id;
}

function shown(mark: SupersededBy | null | undefined): SupersededByPage {
  assert.ok(mark, 'expected a supersession mark');
  assert.ok(!isSupersessionWithheld(mark), 'expected the replacement to be shown, not withheld');
  return mark;
}

function hitFor(store: CanonStore, actorId: string, q: string, pageId: string) {
  const hit = store.searchIndex.search(actorId, { q }).find((r) => r.pageId === pageId);
  assert.ok(hit, `expected "${q}" to find the page`);
  return hit;
}

function nodeFor(store: CanonStore, actorId: string, collectionId: string, pageId: string) {
  const node = store.tree(actorId, collectionId).find((n) => n.id === pageId);
  assert.ok(node, 'expected the page in the collection contents');
  return node;
}

// ---------------------------------------------------------------------------
// The two reads a reader arrives through

test('supersession: a search hit says the record has moved on, and names where to', () => {
  const { store, dana, iris, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const replacement = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident management');
  store.assertRelation(dana.id, replacement, { toPageId: old, kind: 'supersedes' });

  const hit = hitFor(store, dana.id, 'runbook', old);
  const mark = shown(hit.supersededBy);
  assert.equal(mark.pageId, replacement);
  assert.equal(mark.title, 'Incident management');
  assert.equal(mark.status, 'canonical');
  assert.equal(mark.answerable, true);
});

test('supersession: the collection contents carry the same mark as search', () => {
  const { store, dana, iris, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const replacement = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident management');
  store.assertRelation(dana.id, replacement, { toPageId: old, kind: 'supersedes' });

  const node = nodeFor(store, dana.id, operations.id, old);
  const inTable = shown(node.supersededBy);
  const inSearch = shown(hitFor(store, dana.id, 'runbook', old).supersededBy);
  // One computation behind both, so the table and the dropdown cannot come to
  // disagree about what the record says.
  assert.deepEqual(inTable, inSearch);
});

test('supersession: a page nothing replaces carries null, not a missing field', () => {
  const { store, dana, operations } = setup();
  const alone = note(store, dana.id, operations.id, 'Badge printer instructions');

  assert.equal(hitFor(store, dana.id, 'badge printer', alone).supersededBy, null);
  assert.equal(nodeFor(store, dana.id, operations.id, alone).supersededBy, null);
});

test('supersession: the page that replaces is not itself drawn as replaced', () => {
  const { store, dana, iris, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const replacement = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident management');
  store.assertRelation(dana.id, replacement, { toPageId: old, kind: 'supersedes' });

  // The stored row reads "from replaces to". Reading it the wrong way round
  // would put a Superseded chip on the page that is the answer.
  assert.equal(hitFor(store, dana.id, 'incident', replacement).supersededBy, null);
  assert.equal(nodeFor(store, dana.id, operations.id, replacement).supersededBy, null);
});

// ---------------------------------------------------------------------------
// Answerability: "superseded by X" is only "the answer moved over there" once
// X is part of the official record. This is the seeded case a reviewer found.

test('supersession: a replacement Ask cannot use is marked unanswerable', () => {
  const { store, dana, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const halfBuilt = draft(store, dana.id, operations.id, 'Incident management');
  store.assertRelation(dana.id, halfBuilt, { toPageId: old, kind: 'supersedes' });

  const mark = shown(hitFor(store, dana.id, 'runbook', old).supersededBy);
  assert.equal(mark.status, 'draft');
  assert.equal(mark.answerable, false);
});

test('supersession: a page in review still serving its marked version is answerable', () => {
  const { store, dana, iris, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const replacement = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident management');
  store.assertRelation(dana.id, replacement, { toPageId: old, kind: 'supersedes' });
  // A new draft submitted for review: the page reads In Review, and what it is
  // SERVING is still the version its approver accepted — retrieval's derived
  // half of answerability (markServingInReview), which a status list alone
  // would get wrong in the direction that matters.
  store.editDraft(dana.id, replacement, { body: 'A revision, not yet accepted.' });
  store.submitForReview(dana.id, replacement);

  const mark = shown(hitFor(store, dana.id, 'runbook', old).supersededBy);
  assert.equal(mark.status, 'in_review');
  assert.equal(mark.answerable, true);
});

test('supersession: the record’s latest word wins when a page was replaced twice', () => {
  const { store, dana, iris, operations } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const first = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident management');
  const second = canonicalPolicy(store, dana.id, iris.id, operations.id, 'Incident response');
  store.assertRelation(dana.id, first, { toPageId: old, kind: 'supersedes' });
  store.assertRelation(dana.id, second, { toPageId: old, kind: 'supersedes' });

  assert.equal(shown(hitFor(store, dana.id, 'runbook', old).supersededBy).pageId, second);
});

// ---------------------------------------------------------------------------
// Existence, never identity (REMEDIATION-PLAN.md, policy question 1)

test('supersession: a reader who cannot see the replacement is told the page is superseded', () => {
  const { store, dana, iris, vera, operations, compliance } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const secret = canonicalPolicy(store, dana.id, iris.id, compliance.id, 'Kestrel incident protocol');
  store.assertRelation(dana.id, secret, { toPageId: old, kind: 'supersedes' });

  // Vera reads Operations and holds nothing in Compliance.
  const mark = hitFor(store, vera.id, 'runbook', old).supersededBy;
  assert.ok(mark, 'the relation the record states about a page she holds is disclosed');
  assert.ok(isSupersessionWithheld(mark), 'and the far end is withheld');
});

test('supersession: a withheld replacement travels as a marker and nothing else', () => {
  const { store, dana, iris, vera, operations, compliance } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const secret = canonicalPolicy(store, dana.id, iris.id, compliance.id, 'Kestrel incident protocol');
  store.assertRelation(dana.id, secret, { toPageId: old, kind: 'supersedes' });

  for (const mark of [
    hitFor(store, vera.id, 'runbook', old).supersededBy,
    nodeFor(store, vera.id, operations.id, old).supersededBy,
  ]) {
    assert.ok(mark);
    // The whole object, not a field of it: no id, no title, no type, no
    // status, no collection — and no `answerable`, which is a statement about
    // the withheld page's standing.
    assert.deepEqual(Object.keys(mark).sort(), ['withheld']);
    const serialized = JSON.stringify(mark);
    for (const secretThing of [secret, 'Kestrel', compliance.id, 'canonical']) {
      assert.ok(!serialized.includes(secretThing), `the marker carries "${secretThing}"`);
    }
  }
});

test('supersession: nobody can ask about a page they hold no role in', () => {
  const { store, db, dana, iris, vera, operations, compliance } = setup();
  const inside = note(store, dana.id, compliance.id, 'Kestrel runbook');
  const replacement = canonicalPolicy(store, dana.id, iris.id, compliance.id, 'Kestrel incident protocol');
  store.assertRelation(dana.id, replacement, { toPageId: inside, kind: 'supersedes' });

  // The disclosure is bounded to pages that came out of a permission-filtered
  // read: Vera's search never returns this page, so nothing about it is
  // reachable through the mark either. Reaching the helper directly with an id
  // she was never given is the shape of an oracle, and it is the caller's
  // permission filter — not this function — that keeps it out of her hands.
  assert.equal(store.searchIndex.search(vera.id, { q: 'kestrel' }).length, 0);
  assert.throws(() => store.tree(vera.id, compliance.id));
  // And the marker she cannot get to says nothing either way about identity.
  const direct = supersessionMarks(db, vera.id, [inside]).get(inside);
  assert.ok(direct && isSupersessionWithheld(direct));
});

test('supersession: the Knowledge API’s second reader narrows the replacement too', () => {
  const { db, store, dana, iris, vera, operations, compliance } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const secret = canonicalPolicy(store, dana.id, iris.id, compliance.id, 'Kestrel incident protocol');
  store.assertRelation(dana.id, secret, { toPageId: old, kind: 'supersedes' });

  // A Studio app reads as itself and is bounded by the person in front of it
  // (STUDIO-CONTRACT.md §4). Dana — standing in here for an app with wide
  // membership — can see the replacement; Vera cannot, and the app must not
  // narrate its title to her.
  assert.ok(!isSupersessionWithheld(supersessionMarks(db, dana.id, [old]).get(old)!));
  const bounded = supersessionMarks(db, dana.id, [old], { alsoVisibleTo: vera.id }).get(old)!;
  assert.ok(isSupersessionWithheld(bounded), 'the second reader decides the name too');

  // And through the read the Knowledge API actually calls.
  const node = store.tree(dana.id, operations.id, { alsoVisibleTo: vera.id }).find((n) => n.id === old);
  assert.ok(node?.supersededBy && isSupersessionWithheld(node.supersededBy));
  const hit = store.searchIndex
    .search(dana.id, { q: 'runbook', alsoVisibleTo: vera.id })
    .find((h) => h.pageId === old);
  assert.ok(hit?.supersededBy && isSupersessionWithheld(hit.supersededBy));
});

// ---------------------------------------------------------------------------
// Over the wire: two endpoints, because the client reads these and not the
// store.

test('supersession: GET /search and the collection contents carry the field', async () => {
  const { store, dana, iris, vera, operations, compliance } = setup();
  const old = note(store, dana.id, operations.id, 'On-call runbook');
  const secret = canonicalPolicy(store, dana.id, iris.id, compliance.id, 'Kestrel incident protocol');
  store.assertRelation(dana.id, secret, { toPageId: old, kind: 'supersedes' });

  const server = createApi(store).listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const get = async (path: string, actorId: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-Actor-Id': actorId } });
      assert.equal(res.status, 200);
      return res.json() as Promise<Record<string, unknown>[]>;
    };

    const hits = await get('/search?q=runbook', dana.id);
    const hit = hits.find((h) => h.pageId === old);
    assert.ok(hit);
    assert.equal((hit.supersededBy as SupersededByPage).pageId, secret);

    const tree = await get(`/collections/${operations.id}/tree`, vera.id);
    const node = tree.find((n) => n.id === old);
    assert.ok(node);
    assert.deepEqual(node.supersededBy, { withheld: true });

    // The response body as a whole, not just the field: the withheld title
    // must not arrive anywhere on this read.
    const raw = JSON.stringify(await get('/search?q=runbook', vera.id));
    assert.ok(raw.includes('"withheld":true'));
    assert.ok(!raw.includes('Kestrel'));
  } finally {
    server.close();
  }
});
