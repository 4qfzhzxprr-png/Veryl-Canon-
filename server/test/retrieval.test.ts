import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  chunkText,
  cosine,
  localEmbeddingProvider,
  type EmbeddingProvider,
} from '../src/embeddings.js';
import { contentTerms, parsePageLinks, passageFor } from '../src/retrieval.js';
import { quotableText } from '../src/plaintext.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

function setup(provider?: EmbeddingProvider) {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} }, provider);
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

async function expectCodeAsync(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

function publishNote(store: CanonStore, actorId: string, collectionId: string, title: string, body: string) {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body });
  return store.publish(actorId, page.id);
}

function publishCanonical(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
  parentId?: string,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title, ...(parentId ? { parentId } : {}) });
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

// A deliberately tiny provider with real semantics: each dimension is one
// concept, and every word in a concept group lands on the same dimension. It
// stands in for a hosted embedding model in the one place the shipped local
// provider genuinely cannot help — see the hybrid test below.
const CONCEPTS: string[][] = [
  ['guest', 'guests', 'visitor', 'visitors'],
  ['badge', 'badges', 'credential', 'credentials'],
  ['lab', 'labs', 'laboratory'],
  ['fire', 'evacuation'],
];

const conceptProvider: EmbeddingProvider = {
  name: 'test-concept-v1',
  dimensions: CONCEPTS.length,
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Array<number>(CONCEPTS.length).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        const index = CONCEPTS.findIndex((group) => group.includes(word));
        if (index !== -1) vector[index] = vector[index]! + 1;
      }
      return vector;
    });
  },
};

test('embeddings: chunking follows paragraph boundaries and overlaps', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  assert.deepEqual(chunkText('One short paragraph.'), ['One short paragraph.']);

  // Six paragraphs of ~250 characters: more than one chunk, split where the
  // paragraphs are, with the tail of each chunk carried into the next.
  const paragraphs = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(
    (word) => `${word} ${`${word} `.repeat(40)}`.trim(),
  );
  const chunks = chunkText(paragraphs.join('\n\n'));
  assert.ok(chunks.length > 1, 'a long body chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= CHUNK_SIZE + CHUNK_OVERLAP + 4, `chunk stays near the target size: ${chunk.length}`);
  }
  // Every paragraph survives somewhere, and consecutive chunks overlap.
  for (const word of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) {
    assert.ok(chunks.some((c) => c.includes(word)), `${word} is present in some chunk`);
  }
  for (let i = 1; i < chunks.length; i += 1) {
    const carried = chunks[i]!.slice(0, 20);
    assert.ok(chunks[i - 1]!.includes(carried), 'each chunk opens with text carried from the previous one');
  }

  // A single paragraph longer than a chunk is windowed, still with overlap.
  const long = 'x'.repeat(2000);
  const windowed = chunkText(long);
  assert.equal(windowed.length, Math.ceil((2000 - CHUNK_OVERLAP) / (CHUNK_SIZE - CHUNK_OVERLAP)));
  assert.ok(windowed.every((c) => c.length <= CHUNK_SIZE));
});

test('embeddings: drafts are never embedded; publishing indexes, archiving clears', async () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Retention' });
  store.editDraft(marc.id, page.id, { body: 'Records are kept for seven years.' });
  await store.embeddings.ready();
  assert.equal(store.embeddings.chunksFor(page.id).length, 0, 'work in progress never enters the index');

  store.publish(marc.id, page.id);
  await store.embeddings.ready();
  const chunks = store.embeddings.chunksFor(page.id);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, 'Records are kept for seven years.');
  assert.equal(chunks[0]!.version, 1);
  assert.equal(chunks[0]!.provider, localEmbeddingProvider.name);
  assert.equal(chunks[0]!.dimensions, localEmbeddingProvider.dimensions);

  // A later draft on top of a published page changes nothing.
  store.editDraft(marc.id, page.id, { body: 'Unreviewed zebra material.' });
  await store.embeddings.ready();
  assert.deepEqual(store.embeddings.chunksFor(page.id), chunks);

  store.archivePage(marc.id, page.id);
  await store.embeddings.ready();
  assert.equal(store.embeddings.chunksFor(page.id).length, 0, 'archived pages leave the index');
});

test('embeddings: rebuildAll reproduces the index from the record alone', async () => {
  const { db, store, marc, iris, collection } = setup();
  publishNote(store, marc.id, collection.id, 'Osprey note', 'The osprey rollout, informally.\n\nA second paragraph.');
  publishCanonical(store, marc.id, iris.id, collection.id, 'Osprey policy', 'The osprey rollout, officially.');
  const archived = publishNote(store, marc.id, collection.id, 'Osprey history', 'The osprey rollout, retired.');
  store.archivePage(marc.id, archived.id);
  const drafted = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Osprey draft' });
  store.editDraft(marc.id, drafted.id, { body: 'The osprey rollout, unpublished.' });
  await store.embeddings.ready();

  const all = () => db.prepare('SELECT * FROM embeddings ORDER BY page_id, chunk_index').all();
  const before = all();
  assert.equal(before.length, 2, 'the two published, unarchived pages, and nothing else');

  // The index is derived and never authoritative: wipe it, prove the record
  // brings back exactly the same rows.
  db.exec('DELETE FROM embeddings');
  assert.equal(all().length, 0);
  await store.embeddings.rebuildAll();
  assert.deepEqual(all(), before);
  assert.equal(store.embeddings.chunksFor(archived.id).length, 0);
  assert.equal(store.embeddings.chunksFor(drafted.id).length, 0);
});

test('embeddings: rows from another provider are ignored, then re-derived', async () => {
  const { db, store, marc, collection } = setup();
  const page = publishNote(store, marc.id, collection.id, 'Kestrel', 'The kestrel migration schedule.');
  await store.embeddings.ready();

  // A row in a foreign vector space can never surface: provider and
  // dimensions are part of every match, so it is invisible to search.
  db.prepare(
    `INSERT INTO embeddings (page_id, version, chunk_index, text, vector, provider, dimensions)
     VALUES (?, 1, 99, 'ghostly osprey wording', ?, 'ghost-provider', 3)`,
  ).run(page.id, JSON.stringify([1, 0, 0]));
  const hits = await store.embeddings.similar(marc.id, { question: 'ghostly osprey wording' });
  assert.equal(hits.filter((h) => h.chunkIndex === 99).length, 0);

  // Now make every row foreign, as a provider swap would. A store opened over
  // that database re-derives from the record rather than mixing spaces.
  db.exec("UPDATE embeddings SET provider = 'ghost-provider'");
  const swapped = new CanonStore(db, { deliver() {} });
  await swapped.embeddings.ready();
  const rows = db.prepare('SELECT DISTINCT provider FROM embeddings').all() as { provider: string }[];
  assert.deepEqual(rows.map((r) => r.provider), [localEmbeddingProvider.name]);
  assert.equal(swapped.embeddings.chunksFor(page.id).length, 1);
  assert.ok((await swapped.embeddings.similar(marc.id, { question: 'kestrel migration' })).length > 0);
});

test('retrieval: hybrid fusion beats either channel alone', async () => {
  // The shipped local provider is a hashed bag of words: it has no notion of
  // synonymy, so it cannot find a page that says "visitor credential" from a
  // question that says "guest badge" — the honest limitation stated in
  // embeddings.ts. The last assertion here proves that limitation rather than
  // hiding it. The rest of the test uses the pluggable provider seam with a
  // tiny concept provider, so the hybrid mechanics are exercised for real.
  const { store, marc, collection } = setup(conceptProvider);
  const question = 'Do guests need a badge in the lab?';

  // Only the lexical channel can find this one: it shares a question word
  // ("need") and no concept at all.
  const lexOnly = publishNote(store, marc.id, collection.id, 'Gate ledger', 'Everyone will need to sign the ledger at the gate.');
  // Only the semantic channel can find this one: it shares no question word,
  // but every concept.
  const semOnly = publishNote(store, marc.id, collection.id, 'Site rules', 'Every visitor must carry a credential inside the laboratory.');
  // Both channels find this one.
  const both = publishNote(store, marc.id, collection.id, 'Access notes', 'Guests need a badge. Guests carry a credential into the laboratory.');
  await store.embeddings.ready();

  // Channel by channel: neither is sufficient on its own.
  const lexical = store.searchIndex.search(marc.id, { q: 'badge' }).map((h) => h.pageId);
  assert.ok(!lexical.includes(semOnly.id), 'the lexical channel cannot reach the paraphrased page');
  const semantic = (await store.embeddings.similar(marc.id, { question })).map((h) => h.pageId);
  assert.ok(!semantic.includes(lexOnly.id), 'the semantic channel cannot reach the page with no shared concept');
  assert.ok(semantic.includes(semOnly.id));

  // Fused: both pages are candidates, and the page found by both channels
  // outranks each channel's own top hit. That is what RRF buys.
  const fused = await store.retrieve(marc.id, { question });
  const ids = fused.map((c) => c.pageId);
  assert.ok(ids.includes(lexOnly.id) && ids.includes(semOnly.id) && ids.includes(both.id));
  assert.equal(ids[0], both.id);
  assert.deepEqual(new Set(fused.find((c) => c.pageId === both.id)!.channels), new Set(['lexical', 'semantic']));
  assert.deepEqual(fused.find((c) => c.pageId === lexOnly.id)!.channels, ['lexical']);
  assert.deepEqual(fused.find((c) => c.pageId === semOnly.id)!.channels, ['semantic']);

  // The same corpus under the shipped local provider: the paraphrased page is
  // out of reach of both channels, and retrieval degrades honestly to lexical.
  const local = setup();
  publishNote(local.store, local.marc.id, local.collection.id, 'Gate ledger', 'Everyone will need to sign the ledger at the gate.');
  const localSem = publishNote(local.store, local.marc.id, local.collection.id, 'Site rules', 'Every visitor must carry a credential inside the laboratory.');
  await local.store.embeddings.ready();
  const localHits = await local.store.retrieve(local.marc.id, { question });
  assert.ok(!localHits.map((c) => c.pageId).includes(localSem.id));
});

test('retrieval: permission filtering happens before ranking, not after', async () => {
  // Two identical records, except that one of them also holds a page in a
  // collection the asker is not a member of. The asker's results must be
  // byte-for-byte the same: an invisible page cannot influence the ranking,
  // the context, or the answer, because it is excluded in the SQL that
  // generates candidates rather than filtered out of the final list.
  const question = 'What is the pelican escalation path?';
  const build = (withHidden: boolean) => {
    const { store, dana, marc, collection } = setup();
    publishNote(store, marc.id, collection.id, 'Visible pelican', 'The pelican escalation path runs through the duty desk.');
    if (withHidden) {
      const secret = store.createCollection(dana.id, { name: 'Leadership only' });
      publishNote(store, dana.id, secret.id, 'Hidden pelican', 'The pelican escalation path, pelican pelican, unredacted.');
    }
    return { store, marc };
  };

  const plain = build(false);
  const withHidden = build(true);
  await plain.store.embeddings.ready();
  await withHidden.store.embeddings.ready();

  const a = await plain.store.retrieve(plain.marc.id, { question });
  const b = await withHidden.store.retrieve(withHidden.marc.id, { question });
  assert.equal(a.length, 1);
  assert.deepEqual(
    b.map((c) => ({ title: c.title, score: c.score, channels: c.channels })),
    a.map((c) => ({ title: c.title, score: c.score, channels: c.channels })),
  );
  assert.ok(!b.some((c) => c.title === 'Hidden pelican'));

  // The hidden page is not merely absent from the answer: it is absent from
  // both channels for this asker.
  const hiddenStore = withHidden.store;
  assert.ok(!hiddenStore.searchIndex.search(withHidden.marc.id, { q: 'pelican' }).some((h) => h.title === 'Hidden pelican'));
  const semantic = await hiddenStore.embeddings.similar(withHidden.marc.id, { question });
  assert.equal(semantic.length, 1);
});

test('retrieval: graph expansion pulls in a child procedure and a linked page', async () => {
  const { store, marc, iris, collection } = setup();
  const linked = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Escort register retention',
    'Escort registers are kept for three years.',
  );
  // The policy carries the register page's stable link in its published body.
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Contractor access policy',
    `Contractors may enter the building only with an escort. See /pages/${linked.id} for the register.`,
  );
  const procedure = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Contractor escort procedure',
    'Step one: the duty officer countersigns the escort register. Step two: the escort stays for the whole visit.',
    policy.id,
  );
  await store.embeddings.ready();

  const candidates = await store.retrieve(marc.id, { question: 'Which contractors may enter the building?' });
  const byId = new Map(candidates.map((c) => [c.pageId, c]));
  assert.ok(byId.has(policy.id), 'the policy is a direct hit');

  // The child procedure carries "Contractor" in its own title, so once the
  // index learned to stem, "contractors" reaches it and it is a DIRECT hit —
  // and it is still the policy's child. Those are two different facts and the
  // candidate records both: `via` is null because it did not need the edge to
  // be found, and `neighbourOf` names the edge that is there regardless. Before
  // they were separated, being findable cost this page its place in the answer.
  const child = byId.get(procedure.id);
  assert.ok(child, 'the child procedure is in the context — this is where multi-hop answers come from');
  assert.equal(child.via, null, 'it was found on its own words, so it did not arrive through the edge');
  assert.deepEqual(child.neighbourOf, [policy.id], 'and the edge to its parent is recorded anyway');

  // The linked page shares not one word with the question. It is here only
  // because somebody wrote the link, which is what expansion is for.
  const viaLink = byId.get(linked.id);
  assert.ok(viaLink, 'the explicitly linked page joins too');
  assert.deepEqual(viaLink.via, { fromPageId: policy.id, edge: 'link' });
  assert.deepEqual(viaLink.channels, ['graph']);
  assert.ok(
    viaLink.score < byId.get(policy.id)!.score,
    'expanded context ranks below the hit that pulled it in',
  );

  // Depth 0 turns expansion off. The pages the question reaches on their own
  // stay; the page that exists here only as a neighbour goes, and so does the
  // record of the edge, because nothing walked it.
  const shallow = await store.retrieve(marc.id, { question: 'Which contractors may enter the building?', depth: 0 });
  assert.deepEqual(new Set(shallow.map((c) => c.pageId)), new Set([policy.id, procedure.id]));
  assert.deepEqual(shallow.find((c) => c.pageId === procedure.id)!.neighbourOf, []);

  // related() is the same walk, on demand.
  const related = store.related(marc.id, policy.id);
  assert.deepEqual(new Set(related.map((c) => c.pageId)), new Set([procedure.id, linked.id]));
});

test('retrieval: expansion is permission-checked and Canonical-only for answers', async () => {
  const { store, dana, marc, iris, collection } = setup();
  // A page in a collection the asker cannot see, linked from a page they can.
  const secret = store.createCollection(dana.id, { name: 'Leadership only' });
  const hidden = publishNote(store, dana.id, secret.id, 'Heron budget', 'The heron budget, unredacted.');
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Heron policy',
    `Herons are counted each quarter. See /pages/${hidden.id}.`,
  );
  // A child that never reached Canonical (a Note never can).
  const roughChild = store.createPage(marc.id, { collectionId: collection.id, parentId: policy.id, type: 'note', title: 'Heron scratch' });
  store.editDraft(marc.id, roughChild.id, { body: 'Rough heron counting notes.' });
  store.publish(marc.id, roughChild.id);
  await store.embeddings.ready();

  const open = await store.retrieve(marc.id, { question: 'How often are herons counted?' });
  assert.ok(open.some((c) => c.pageId === roughChild.id), 'a published child expands into general retrieval');
  assert.ok(!open.some((c) => c.pageId === hidden.id), 'a link into an invisible collection expands to nothing');

  const forAnswers = await store.retrieve(marc.id, { question: 'How often are herons counted?', canonicalOnly: true });
  assert.ok(forAnswers.some((c) => c.pageId === policy.id));
  assert.ok(!forAnswers.some((c) => c.pageId === roughChild.id), 'answers expand into Canonical neighbours only');
});

test('retrieval: question and actor are validated', async () => {
  const { store, marc } = setup();
  await expectCodeAsync(() => store.retrieve(marc.id, { question: '   ' }), 'invalid');
  await expectCodeAsync(() => store.retrieve('no-such-actor', { question: 'anything' }), 'not_found');
  expectCode(() => store.related(marc.id, 'no-such-page'), 'not_found');
});

test('retrieval: term and link parsing are simple and documented', () => {
  assert.deepEqual(contentTerms('What is the retention period?'), ['retention', 'period']);
  assert.deepEqual(contentTerms('WHO who Who'), []);
  assert.deepEqual(contentTerms('escort escort escort'), ['escort']);

  assert.deepEqual(parsePageLinks('see /pages/abc-123-def for detail'), ['abc-123-def']);
  assert.deepEqual(parsePageLinks('see [[abc-123-def]] and [[ abc-123-def ]]'), ['abc-123-def']);
  assert.deepEqual(parsePageLinks('no links here, and /pages/ is not one'), []);
});

test('embeddings: the local provider is deterministic and normalised', async () => {
  const [a, b] = await localEmbeddingProvider.embed(['escort register retention', 'escort register retention']);
  assert.deepEqual(a, b);
  assert.equal(a!.length, localEmbeddingProvider.dimensions);
  assert.ok(Math.abs(cosine(a!, b!) - 1) < 1e-12);
  const [unrelated] = await localEmbeddingProvider.embed(['flamingo budget spreadsheet']);
  assert.ok(cosine(a!, unrelated!) < 0.2);
});

// USER-TESTING.md T4.1's open half. A page body is Markdown, and the passage
// builder used to flatten it with a whitespace collapse — which is right for
// the whitespace and wrong for everything else, because the newline was the
// only thing separating a heading from the paragraph under it. Two testers
// reported the result and both took it for a rendering bug: one saw `## Scope`
// printed inside what "the record says", the other saw a page footer and a raw
// `/pages/<uuid>` link quoted as though they were policy. No renderer can reach
// a mark that is already mid-line inside a quotation.
test('quotableText: the marks go, the words stay exactly', () => {
  const body = [
    '# Records Retention Schedule',
    '',
    'Claims records are kept for **seven years** from the closing date.',
    '',
    '## How long we keep each class',
    '',
    '- Claims and appeals: seven years',
    '- Access logs: 90 days',
    '',
    'See [the deletion procedure](/pages/8f14e45f-ceea-467a-9f0b-1c2d3e4f5061) for how.',
    '',
    '---',
    '',
    'Owner: Compliance. Reviewed annually.',
  ].join('\n');

  const text = quotableText(body);

  // Nothing that exists to instruct a renderer survives.
  for (const mark of ['##', '**', '- ', '](', '---', '/pages/']) {
    assert.ok(!text.includes(mark), `"${mark}" should not appear in a quotation: ${text}`);
  }
  // Every word does.
  for (const words of [
    'Records Retention Schedule',
    'Claims records are kept for seven years from the closing date',
    'How long we keep each class',
    'Claims and appeals: seven years',
    'Access logs: 90 days',
    'Owner: Compliance',
  ]) {
    assert.ok(text.includes(words), `"${words}" should survive: ${text}`);
  }
  // A link keeps its text and loses its target: a URL is an instruction to a
  // browser, not something a policy says.
  assert.ok(text.includes('See the deletion procedure for how'));
  // A heading does not run into the paragraph beneath it and make a sentence
  // nobody wrote.
  assert.ok(!/Schedule Claims records/.test(text), `heading ran into the body: ${text}`);
});

test('quotableText: a table quotes as its cells, not as its pipes', () => {
  const text = quotableText(
    ['| Record type | Retention |', '| --- | ---: |', '| Claims records | 7 years |', '| Access logs | 90 days |'].join('\n'),
  );
  assert.ok(!text.includes('|'), text);
  assert.ok(!text.includes('---'), text);
  assert.ok(text.includes('Claims records — 7 years'), text);
  assert.ok(text.includes('Record type — Retention'), text);
});

test('quotableText: a fenced block is somebody’s example and is kept as written', () => {
  const text = quotableText(['Send this:', '', '```', 'GET /audit?limit=50', '```', '', 'and read the reply.'].join('\n'));
  assert.ok(text.includes('GET /audit?limit=50'), text);
  assert.ok(!text.includes('```'), text);
});

test('passageFor: a quotation from a structured body carries no syntax', () => {
  const body = ['## Retention', '', 'Claims and appeals records are kept for *seven years*.'].join('\n');
  const passage = passageFor(body, ['claims', 'retention']);
  assert.ok(!/[#*|]/.test(passage), `passage still carries syntax: ${passage}`);
  assert.ok(passage.includes('Claims and appeals records are kept for seven years'), passage);
});
