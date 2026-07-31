import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

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
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01' } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

test('search: pages enter the index on publish, never as drafts', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Retention rules' });
  store.editDraft(marc.id, page.id, { body: 'Records are kept for seven years.' });

  // A draft is work in progress; readers search the record, not the draft.
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

  // The index is derived and never authoritative: wipe it outright, then
  // prove the record alone brings back exactly the same results —
  // published pages in, drafts and archived pages out.
  db.exec('DELETE FROM page_search');
  assert.equal(store.searchIndex.search(dana.id, { q: 'osprey rollout' }).length, 0);

  store.searchIndex.rebuildIndex();
  const after = store.searchIndex.search(dana.id, { q: 'osprey rollout' });
  assert.deepEqual(after, before);
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
    assert.deepEqual(
      Object.keys(hits.json[0]).sort(),
      ['collectionId', 'ownerId', 'pageId', 'snippet', 'status', 'title', 'type'],
    );

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
