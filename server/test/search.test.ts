import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
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

// Publishes a note in one step: create, draft, publish.
function publishNote(
  store: CanonStore,
  actorId: string,
  collectionId: string,
  title: string,
  body: string,
  ownerId?: string,
) {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body, ...(ownerId ? { fields: { ownerId } } : {}) });
  return store.publish(actorId, page.id);
}

// Takes a policy all the way to Canonical through review.
function publishCanonicalPolicy(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

test('search: a body enters the index on publish, never as a draft', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Retention rules' });
  store.editDraft(marc.id, page.id, { body: 'Records are kept for seven years.' });

  // A draft BODY is work in progress; readers search the record, not the
  // draft. The title is a different matter — see the two tests below.
  assert.equal(store.searchIndex.search(marc.id, { q: 'seven years' }).length, 0);

  store.publish(marc.id, page.id);
  const hits = store.searchIndex.search(marc.id, { q: 'seven years' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.pageId, page.id);
  assert.equal(hits[0]!.title, 'Retention rules');
  assert.equal(hits[0]!.collectionId, collection.id);
  assert.equal(hits[0]!.type, 'note');
  assert.match(hits[0]!.snippet, /<mark>seven<\/mark>/i);
});

// USER-TESTING.md T4.6, bug E. A new contributor wrote a page, sent it for
// review, and could not find it by the title she had just typed — it was in
// the tree and in the audit log and nowhere in search, because a page in
// review has published no version and the index was built from published
// versions alone. The title is on screen to every member of the collection;
// search must agree with the screen.
test('search: a page in review is findable by its own title', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Kestrel handling' });
  store.editDraft(marc.id, page.id, {
    body: 'Nobody has agreed to this sentence yet.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, page.id);

  const hits = store.searchIndex.search(marc.id, { q: 'kestrel' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.pageId, page.id);
  assert.equal(hits[0]!.status, 'in_review');
  // The body it is carrying is still unpublished, and still nobody's to read
  // through search.
  assert.equal(store.searchIndex.search(marc.id, { q: 'agreed sentence' }).length, 0);

  // And it is a title, not a licence: a non-member of the collection is told
  // nothing, by the same membership join that has always decided this.
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  assert.equal(store.searchIndex.search(outsider.id, { q: 'kestrel' }).length, 0);
});

test('search: a brand-new draft is findable by title and silent about its contents', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Petrel migration' });
  store.editDraft(marc.id, page.id, { body: 'Half a thought about wombats.' });

  const hits = store.searchIndex.search(marc.id, { q: 'petrel' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.status, 'draft');
  assert.equal(store.searchIndex.search(marc.id, { q: 'wombats' }).length, 0);

  // Archiving it takes it back out again, title and all.
  store.archivePage(marc.id, page.id);
  assert.equal(store.searchIndex.search(marc.id, { q: 'petrel' }).length, 0);
});

test('search: an unpublished draft on top of a published page stays invisible', () => {
  const { store, marc, collection } = setup();
  const page = publishNote(store, marc.id, collection.id, 'Signals', 'The published truth.');
  store.editDraft(marc.id, page.id, { body: 'Unreviewed zebra material.' });

  assert.equal(store.searchIndex.search(marc.id, { q: 'zebra' }).length, 0);
  const published = store.searchIndex.search(marc.id, { q: 'published truth' });
  assert.equal(published.length, 1);
  assert.equal(published[0]!.pageId, page.id);
});

test('search: archived pages leave search', () => {
  const { store, marc, collection } = setup();
  const page = publishNote(store, marc.id, collection.id, 'Old process', 'The obsolete quarterly ritual.');
  assert.equal(store.searchIndex.search(marc.id, { q: 'quarterly ritual' }).length, 1);

  store.archivePage(marc.id, page.id);
  assert.equal(store.searchIndex.search(marc.id, { q: 'quarterly ritual' }).length, 0);
});

test('search: permission-filtered — a non-member sees nothing', () => {
  const { store, dana, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Secret plan', 'The confidential migration plan.');

  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  assert.equal(store.searchIndex.search(outsider.id, { q: 'migration' }).length, 0);

  // Membership at any role includes view, so results appear.
  store.setMember(dana.id, collection.id, outsider.id, 'view');
  assert.equal(store.searchIndex.search(outsider.id, { q: 'migration' }).length, 1);
});

test('search: results respect collection membership per collection', () => {
  const { store, dana, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Shared note', 'The flamingo budget for both teams.');

  const other = store.createCollection(dana.id, { name: 'Leadership only' });
  publishNote(store, dana.id, other.id, 'Private note', 'The flamingo budget, unredacted.');

  // Marc is a member of Compliance but not of Leadership only.
  const hits = store.searchIndex.search(marc.id, { q: 'flamingo budget' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.collectionId, collection.id);

  // Dana is a member of both and sees both.
  assert.equal(store.searchIndex.search(dana.id, { q: 'flamingo budget' }).length, 2);
});

test('search: Canonical pages rank first, then FTS relevance', () => {
  const { store, marc, iris, collection } = setup();
  // The note mentions the term heavily: best bm25 relevance by far.
  publishNote(
    store,
    marc.id,
    collection.id,
    'Encryption scratchpad',
    'encryption encryption encryption encryption encryption everywhere',
  );
  const policy = publishCanonicalPolicy(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Data protection policy',
    'All stored records use encryption at rest.',
  );
  assert.equal(policy.status, 'canonical');

  const hits = store.searchIndex.search(marc.id, { q: 'encryption' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.pageId, policy.id); // the official record outranks raw relevance
  assert.equal(hits[0]!.status, 'canonical');
  assert.equal(hits[1]!.status, 'draft');
});

test('search: within the same status, bm25 relevance orders results', () => {
  const { store, marc, collection } = setup();
  const strong = publishNote(store, marc.id, collection.id, 'Kubernetes runbook', 'kubernetes kubernetes kubernetes');
  const weak = publishNote(store, marc.id, collection.id, 'Misc notes', 'One mention of kubernetes among much other prose here.');

  const hits = store.searchIndex.search(marc.id, { q: 'kubernetes' });
  assert.deepEqual(hits.map((h) => h.pageId), [strong.id, weak.id]);
});

test('search: filters by collection, type, status, and owner', () => {
  const { store, dana, marc, iris, collection } = setup();
  const other = store.createCollection(dana.id, { name: 'Ops' });
  store.setMember(dana.id, other.id, marc.id, 'edit');

  const note = publishNote(store, marc.id, collection.id, 'Badger note', 'The badger project, informally.', marc.id);
  const policy = publishCanonicalPolicy(store, marc.id, iris.id, collection.id, 'Badger policy', 'The badger project, officially.');
  const opsNote = publishNote(store, marc.id, other.id, 'Ops badger', 'The badger project, operationally.', dana.id);

  const all = store.searchIndex.search(marc.id, { q: 'badger project' });
  assert.equal(all.length, 3);

  const inOps = store.searchIndex.search(marc.id, { q: 'badger project', collectionId: other.id });
  assert.deepEqual(inOps.map((h) => h.pageId), [opsNote.id]);

  const policies = store.searchIndex.search(marc.id, { q: 'badger project', type: 'policy' });
  assert.deepEqual(policies.map((h) => h.pageId), [policy.id]);

  const canonical = store.searchIndex.search(marc.id, { q: 'badger project', status: 'canonical' });
  assert.deepEqual(canonical.map((h) => h.pageId), [policy.id]);

  const ownedByDana = store.searchIndex.search(marc.id, { q: 'badger project', ownerId: dana.id });
  assert.deepEqual(ownedByDana.map((h) => h.pageId), [opsNote.id]);
  assert.equal(ownedByDana[0]!.ownerId, dana.id);

  // Marc owns both the note and the policy; canonical still ranks first.
  const ownedByMarc = store.searchIndex.search(marc.id, { q: 'badger project', ownerId: marc.id });
  assert.deepEqual(ownedByMarc.map((h) => h.pageId), [policy.id, note.id]);

  const limited = store.searchIndex.search(marc.id, { q: 'badger project', limit: 1 });
  assert.equal(limited.length, 1);
});

test('search: restore re-indexes the restored content', () => {
  const { store, marc, collection } = setup();
  const page = publishNote(store, marc.id, collection.id, 'Runbook', 'Call the heron team first.');
  store.editDraft(marc.id, page.id, { body: 'Call nobody.' });
  store.publish(marc.id, page.id);
  assert.equal(store.searchIndex.search(marc.id, { q: 'heron' }).length, 0);

  store.restore(marc.id, page.id, 1);
  const hits = store.searchIndex.search(marc.id, { q: 'heron' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.pageId, page.id);
});

test('search: rebuildIndex rebuilds the same results from the record alone', () => {
  const { db, store, dana, marc, iris, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Osprey note', 'The osprey rollout, informally.');
  publishCanonicalPolicy(store, marc.id, iris.id, collection.id, 'Osprey policy', 'The osprey rollout, officially.');
  const archived = publishNote(store, marc.id, collection.id, 'Osprey history', 'The osprey rollout, retired.');
  store.archivePage(marc.id, archived.id);
  const drafted = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Osprey draft' });
  store.editDraft(marc.id, drafted.id, { body: 'The osprey rollout, unpublished.' });

  const before = store.searchIndex.search(dana.id, { q: 'osprey rollout' });
  assert.equal(before.length, 2);
  // By title, the unpublished draft is there too and the archived page is not.
  const byTitle = store.searchIndex.search(dana.id, { q: 'osprey' });
  assert.deepEqual(byTitle.map((r) => r.title).sort(), ['Osprey draft', 'Osprey note', 'Osprey policy']);

  // The index is derived and never authoritative: wipe it outright, then
  // prove the record alone brings back exactly the same results — published
  // bodies in, unpublished bodies out, every live page's title present, and
  // archived pages gone entirely.
  db.exec('DELETE FROM page_search');
  assert.equal(store.searchIndex.search(dana.id, { q: 'osprey rollout' }).length, 0);

  store.searchIndex.rebuildIndex();
  const after = store.searchIndex.search(dana.id, { q: 'osprey rollout' });
  assert.deepEqual(after, before);
  assert.deepEqual(store.searchIndex.search(dana.id, { q: 'osprey' }), byTitle);
});

test('search: input is validated and FTS syntax cannot be injected', () => {
  const { store, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Plain note', 'Nothing fancy here.');

  expectCode(() => store.searchIndex.search(marc.id, { q: '' }), 'invalid');
  expectCode(() => store.searchIndex.search(marc.id, { q: '   ' }), 'invalid');
  expectCode(() => store.searchIndex.search(marc.id, { q: '"""' }), 'invalid');
  expectCode(() => store.searchIndex.search(marc.id, { q: 'x', type: 'memo' }), 'invalid');
  expectCode(() => store.searchIndex.search(marc.id, { q: 'x', status: 'golden' }), 'invalid');
  expectCode(() => store.searchIndex.search('no-such-actor', { q: 'x' }), 'not_found');

  // Operators, quotes, and column syntax arrive as literal words, not syntax.
  assert.equal(store.searchIndex.search(marc.id, { q: 'nothing AND fancy' }).length, 0); // no page contains "and"
  assert.equal(store.searchIndex.search(marc.id, { q: 'title:fancy OR (' }).length, 0);
  assert.doesNotThrow(() => store.searchIndex.search(marc.id, { q: '"nothing" NEAR/2 -fancy *' }));
  assert.equal(store.searchIndex.search(marc.id, { q: 'nothing fancy' }).length, 1);
});

test('API: GET /search returns permission-filtered, highlighted results', async () => {
  const { store, dana, marc, iris, collection } = setup();
  publishCanonicalPolicy(store, marc.id, iris.id, collection.id, 'Access policy', 'Every access to the vault is logged.');
  publishNote(store, marc.id, collection.id, 'Vault chatter', 'Musings about the vault.');

  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (path: string, actor?: string) => {
    const res = await fetch(base + path, { headers: actor ? { 'x-actor-id': actor } : {} });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const unauthenticated = await call('/search?q=vault');
    assert.equal(unauthenticated.status, 401);

    const missing = await call('/search', dana.id);
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'invalid');

    const hits = await call('/search?q=vault', dana.id);
    assert.equal(hits.status, 200);
    assert.equal(hits.json.length, 2);
    assert.equal(hits.json[0].status, 'canonical'); // canonical first
    assert.ok(hits.json[0].snippet.includes('<mark>'));
    // `supersededBy` joined the shape when supersession reached the surfaces a
    // reader arrives through (REMEDIATION-PLAN.md 1.6, and supersession.ts for
    // what it carries and what it withholds). Null here: nothing replaces
    // either of these pages, and the field is present and null rather than
    // absent, so a client can tell "not superseded" from "this read does not
    // say".
    assert.deepEqual(
      Object.keys(hits.json[0]).sort(),
      ['collectionId', 'ownerId', 'pageId', 'pageStanding', 'snippet', 'status', 'supersededBy', 'title', 'type'],
    );
    assert.equal(hits.json[0].supersededBy, null);
    // Present and null when there is no revision in review, the same way
    // supersededBy is: a client can tell "no pending revision" from "this read
    // does not say" (see revisionUnderReviewStanding).
    assert.equal(hits.json[0].pageStanding, null);

    const filtered = await call(`/search?q=vault&type=note&collection=${collection.id}`, dana.id);
    assert.equal(filtered.json.length, 1);
    assert.equal(filtered.json[0].type, 'note');

    const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
    const denied = await call('/search?q=vault', outsider.id);
    assert.equal(denied.status, 200);
    assert.equal(denied.json.length, 0); // sees nothing, learns nothing
  } finally {
    server.close();
  }
});

test('aliases: indexed with the title’s weight, and an old index re-derives itself', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'd@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  const page = store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'Coordination of benefits' });
  store.editDraft(dana.id, page.id, { body: 'Which plan pays first.', fields: { aliases: ['COB'] } });
  store.publish(dana.id, page.id);

  // Findable by a name that appears nowhere in title or body.
  const hits = store.searchIndex.search(dana.id, { q: 'COB' });
  assert.deepEqual(hits.map((h) => h.pageId), [page.id]);

  // A draft's alias teaches nothing until it publishes, like a draft's body.
  const draft = store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'Unpublished' });
  store.editDraft(dana.id, draft.id, { body: 'x', fields: { aliases: ['zzzunique'] } });
  assert.deepEqual(store.searchIndex.search(dana.id, { q: 'zzzunique' }), []);

  // An index built before the aliases column existed is the same wrongness as
  // an old tokenizer, and gets the same repair: dropped and re-derived from
  // the record when the store opens.
  db.exec('DROP TABLE page_search');
  db.exec(`CREATE VIRTUAL TABLE page_search USING fts5(
    page_id UNINDEXED, title, body, tokenize = 'porter unicode61 remove_diacritics 2')`);
  db.prepare('INSERT INTO page_search (page_id, title, body) VALUES (?, ?, ?)').run(page.id, 'Coordination of benefits', 'Which plan pays first.');
  const reopened = new CanonStore(db, { deliver() {} });
  const again = reopened.searchIndex.search(dana.id, { q: 'COB' });
  assert.deepEqual(again.map((h) => h.pageId), [page.id], 'the reopened store rebuilt the index with aliases in it');
});

// ---------------------------------------------------------------------------
// Round seven, Phase 8. Search was the weakest surface in the product and the
// findings were about the shape of it rather than about ranking:
//
//   * `toMatchQuery` quoted every term whole and put no `*` on any of them, so
//     the box answered nothing until the last letter of the last word was in
//     place. Somebody who does not already know the word the record uses never
//     gets to the end of it.
//   * One letter wrong and the answer was "Nothing you can see matches",
//     which reads as a fact about the record rather than about the spelling.
//   * Enter did nothing and there was no results page — the dropdown was the
//     whole surface, so a search could not be kept, linked, or read past
//     twelve hits.

test('search: a word half typed finds the page, and only the last word is a prefix', () => {
  const { store, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Retention periods', 'Vendor contracts are kept for seven years.');
  publishNote(store, marc.id, collection.id, 'Costume policy', 'What to wear at the holiday party.');

  // The finding, as its fix: "reten" is a page nobody could reach.
  assert.equal(store.searchIndex.search(marc.id, { q: 'reten' }).length, 0, 'without the flag, unchanged');
  assert.equal(store.searchIndex.search(marc.id, { q: 'reten', prefix: true }).length, 1);

  // And only the LAST term, because the earlier ones were finished by the
  // person typing a space after them. "cost" is a word; it must not drag in
  // "costume" while somebody is still typing the term after it.
  const both = store.searchIndex.search(marc.id, { q: 'cost vendor', prefix: true });
  assert.deepEqual(both.map((r) => r.title), [], 'the finished first term stays a whole word');
});

test('search: retrieval does not silently inherit prefix matching', () => {
  // Widening the pool an ANSWER may be grounded in is a change to what Canon
  // will state as fact. It does not get made as a side effect of fixing a
  // search box, and the default is what pins that.
  const { store, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Retention periods', 'Vendor contracts are kept for seven years.');
  assert.equal(store.searchIndex.search(marc.id, { q: 'reten' }).length, 0);
});

test('search: a typo is answered with an offer, not with an empty record', () => {
  const { store, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Retention periods', 'Vendor contracts are kept for seven years.');
  assert.equal(store.searchIndex.search(marc.id, { q: 'vendr', prefix: true }).length, 0);
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'vendr' }), 'vendor');
  // Typing PAST the stem looks identical to a typo from here, and is answered
  // the same way — see toMatchQuery for why "retenti" cannot match `retent`.
  assert.equal(store.searchIndex.search(marc.id, { q: 'retenti', prefix: true }).length, 0);
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'retenti' }), 'retent');
  // A query that already works is never second-guessed.
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'retention' }), null);
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'reten' }), null, 'nor one the prefix already answers');
});

test('search: a suggestion never discloses a word from a collection the asker cannot open', () => {
  // THE LOAD-BEARING ONE. The FTS5 vocabulary table is corpus-wide and cannot
  // be permission-filtered — it is a property of the index. Offering a term
  // straight out of it would turn the search box into an oracle: type "zeph",
  // be told "did you mean zephyrus", and you have learned a codename out of a
  // collection you hold no role in, one letter at a time. That is exactly the
  // disclosure the record's rule refuses (policy question 1: existence is
  // disclosed where the record states a relationship to a page you HOLD, never
  // in answer to an arbitrary term anybody can type).
  const { store, dana, marc, collection } = setup();
  const secret = store.createCollection(dana.id, { name: 'Corporate development' });
  publishNote(store, dana.id, secret.id, 'Project Zephyrus', 'The acquisition of Northwind closes in March.');
  publishNote(store, marc.id, collection.id, 'Retention periods', 'Vendor contracts are kept for seven years.');

  // Dana holds the restricted collection and is helped. (The offer is the
  // index's stem, `zephyru` — see SearchIndex.suggest for why that is the
  // honest thing to hand back rather than a prettier word it does not hold.)
  assert.equal(store.searchIndex.suggest(dana.id, { q: 'zepyrus' }), 'zephyru');
  assert.equal(store.searchIndex.suggest(dana.id, { q: 'nortwind' }), 'northwind');
  // Marc does not, and is told nothing — not the word, not that it exists.
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'zepyrus' }), null);
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'nortwind' }), null);
  // He is still helped with material he can read, so this is a filter and not
  // a switch that turns the feature off.
  assert.equal(store.searchIndex.suggest(marc.id, { q: 'vendr' }), 'vendor');
});

test('search: the suggestion route answers with a query, never with results', () => {
  const { store, marc, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Retention periods', 'Vendor contracts are kept for seven years.');
  const suggested = store.searchIndex.suggest(marc.id, { q: 'vendr contract' });
  // It replaces the word it can name and leaves the rest of the query alone —
  // a search box that quietly answers a different question than the one asked
  // is the same failure as a record that quietly corrects what somebody wrote.
  assert.equal(suggested, 'vendor contract');
});
