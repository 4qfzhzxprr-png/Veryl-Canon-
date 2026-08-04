import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import { EmbeddingStore, type EmbeddingProvider } from '../src/embeddings.js';

// Per-collection embedding egress control, the index-time sibling of the
// answer-time model-egress work. A hosted embedder (CANON_EMBEDDINGS=http)
// sends the record's text over the network; a `restricted` collection's pages
// must not go, unless a deployment with a data-processing agreement allows it.
//
// The provider here is a SPY that egresses: it records the texts handed to it,
// so an empty record is the proof that a restricted page never left.

const TODAY = new Date().toISOString().slice(0, 10);

function spyProvider(): { provider: EmbeddingProvider; embedded: () => string[] } {
  const seen: string[] = [];
  const provider: EmbeddingProvider = {
    name: 'spy-egress',
    dimensions: 4,
    egresses: true,
    async embed(texts: string[]): Promise<number[][]> {
      seen.push(...texts);
      // A deterministic non-zero vector so a page is genuinely indexed.
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  return { provider, embedded: () => seen };
}

function publishCanonical(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
): string {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body: 'Claims records are retained for seven years from final determination.',
    fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(editorId, page.id);
  store.approve(approverId, page.id);
  return page.id;
}

async function fixture(opts: { restricted: boolean; allowRestrictedEgress: boolean }) {
  const db = openDb(':memory:');
  const { provider, embedded } = spyProvider();
  // The store builds its own EmbeddingStore; swap in one wired to the spy with
  // the chosen egress policy, then index through the store's normal hooks.
  const store = new CanonStore(db, { deliver() {} });
  const embeddings = new EmbeddingStore(db, provider, opts.allowRestrictedEgress);
  (store as unknown as { embeddings: EmbeddingStore }).embeddings = embeddings;
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'd@x.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'm@x.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'i@x.com' });
  const col = store.createCollection(dana.id, { name: 'Compliance', restricted: opts.restricted });
  store.setMember(dana.id, col.id, marc.id, 'edit');
  store.setMember(dana.id, col.id, iris.id, 'approve');
  const pageId = publishCanonical(store, marc.id, iris.id, col.id, 'Retention of claims records');
  // Index the page explicitly through the swapped store and settle the queue.
  embeddings.indexPage(pageId);
  await embeddings.ready();
  return { db, embedded, pageId };
}

function vectorCount(db: ReturnType<typeof openDb>, pageId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE page_id = ?').get(pageId) as { n: number }).n;
}

test('a restricted page is never sent to an egressing embedder, and gets no vectors', async () => {
  const { db, embedded, pageId } = await fixture({ restricted: true, allowRestrictedEgress: false });
  assert.equal(embedded().length, 0, 'the egressing embedder was never called with a restricted page');
  assert.equal(vectorCount(db, pageId), 0, 'the page is absent from the semantic channel (found lexically instead)');
});

test('an unrestricted page is embedded normally', async () => {
  const { db, embedded, pageId } = await fixture({ restricted: false, allowRestrictedEgress: false });
  assert.ok(embedded().length > 0, 'a non-restricted page may be embedded');
  assert.ok(vectorCount(db, pageId) > 0, 'and is present in the semantic channel');
});

test('CANON_EMBEDDINGS_ALLOW_RESTRICTED opts a deployment back in', async () => {
  const { db, embedded, pageId } = await fixture({ restricted: true, allowRestrictedEgress: true });
  assert.ok(embedded().length > 0, 'with a data-processing agreement declared, a restricted page may egress');
  assert.ok(vectorCount(db, pageId) > 0);
});

test('a non-egressing (on-box) provider indexes restricted pages regardless', async () => {
  const db = openDb(':memory:');
  const seen: string[] = [];
  const onBox: EmbeddingProvider = {
    name: 'on-box',
    dimensions: 4,
    // egresses omitted → falsy: makes no external call.
    async embed(texts: string[]): Promise<number[][]> {
      seen.push(...texts);
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  const store = new CanonStore(db, { deliver() {} });
  const embeddings = new EmbeddingStore(db, onBox, false); // egress not allowed, but provider doesn't egress
  (store as unknown as { embeddings: EmbeddingStore }).embeddings = embeddings;
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'd@x.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'm@x.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'i@x.com' });
  const col = store.createCollection(dana.id, { name: 'Secret', restricted: true });
  store.setMember(dana.id, col.id, marc.id, 'edit');
  store.setMember(dana.id, col.id, iris.id, 'approve');
  const pageId = publishCanonical(store, marc.id, iris.id, col.id, 'Retention');
  embeddings.indexPage(pageId);
  await embeddings.ready();
  assert.ok(seen.length > 0, 'an on-box embedder indexes a restricted page — nothing leaves the process');
  assert.ok(vectorCount(db, pageId) > 0);
});
