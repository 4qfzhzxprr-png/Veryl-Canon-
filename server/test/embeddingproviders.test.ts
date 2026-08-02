import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import { cosine, type EmbeddingProvider } from '../src/embeddings.js';
import {
  EMBEDDING_MODES,
  EmbeddingProviderError,
  MAX_EMBEDDING_RESPONSE_BYTES,
  embeddingProviderFromEnv,
  httpEmbeddingProvider,
  localModelEmbeddingProvider,
  parseEmbeddings,
  policyForEndpoint,
} from '../src/embeddingproviders.js';
import type { OutboundRequest, OutboundResponse } from '../src/pinnedhttp.js';
import { validateConfig } from '../src/config.js';

// The two ways a real embedding model is plugged in (embeddingproviders.ts).
//
// WHAT IS EXERCISED HERE AND WHAT IS NOT, stated plainly because the gap
// matters. The HTTP provider is tested end to end against a substituted
// transport: the request it forms, the answer it accepts, and every answer it
// refuses. The in-process provider's WIRING is tested against a substituted
// module — which module it loads, what it says when the optional dependency is
// absent, how it batches, that it checks the width of what comes back — but the
// MODEL has never run in this environment, because fetching its weights needs a
// host this environment cannot reach. That path wants one run somewhere with
// network access before anybody trusts it, and it is the default nowhere.

const TODAY = new Date().toISOString().slice(0, 10);

/** A resolver that answers without DNS, so these tests are offline. */
const fixedResolver = async () => [{ address: '203.0.113.7', family: 4 }];

function recordingTransport(reply: (req: OutboundRequest) => Partial<OutboundResponse>) {
  const seen: OutboundRequest[] = [];
  const transport = async (request: OutboundRequest): Promise<OutboundResponse> => {
    seen.push(request);
    return { status: 200, headers: {}, body: '{}', peerAddress: request.address, ...reply(request) };
  };
  return { seen, transport };
}

/** An answer in the shape every OpenAI-compatible endpoint sends. */
function vectorsFor(texts: string[], dimensions: number): string {
  return JSON.stringify({
    data: texts.map((text, index) => ({
      index,
      embedding: Array.from({ length: dimensions }, (_, d) => ((text.length + d) % 7) / 7),
    })),
  });
}

// ---------------------------------------------------------------------------
// The request

test('http provider: one POST per batch, carrying the model and the texts', async () => {
  const { seen, transport } = recordingTransport((req) => {
    const sent = JSON.parse(req.body ?? '{}') as { input: string[] };
    return { body: vectorsFor(sent.input, 4) };
  });
  const provider = httpEmbeddingProvider({
    url: 'https://models.example.com/v1/embeddings',
    model: 'text-embedding-3-small',
    dimensions: 4,
    batchSize: 2,
    apiKey: 'sk-secret',
    transport,
    resolver: fixedResolver,
  });

  const vectors = await provider.embed(['one', 'two', 'three', 'four', 'five']);
  assert.equal(vectors.length, 5);
  assert.ok(vectors.every((v) => v.length === 4));

  assert.equal(seen.length, 3, 'five texts at a batch size of two is three requests');
  const first = seen[0]!;
  assert.equal(first.method, 'POST');
  assert.equal(first.host, 'models.example.com');
  assert.equal(first.address, '203.0.113.7', 'the socket goes to the address the policy judged');
  assert.equal(first.headers.authorization, 'Bearer sk-secret');
  assert.equal(first.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(first.body!), {
    model: 'text-embedding-3-small',
    input: ['one', 'two'],
  });
  // A batch of vectors is legitimately far larger than a federated scalar, and
  // the caller says so rather than the transport raising the ceiling for
  // everybody.
  assert.equal(first.maxBytes, MAX_EMBEDDING_RESPONSE_BYTES);
});

test('http provider: the model is part of the provider name, so a swap re-derives the index', () => {
  const one = httpEmbeddingProvider({ url: 'https://m/v1/embeddings', model: 'small', dimensions: 8 });
  const two = httpEmbeddingProvider({ url: 'https://m/v1/embeddings', model: 'large', dimensions: 8 });
  assert.notEqual(one.name, two.name);
  assert.equal(one.name, 'http:small');
});

test('http provider: the endpoint is the only host it may reach', () => {
  const policy = policyForEndpoint(new URL('https://models.internal:8443/v1/embeddings'));
  assert.deepEqual(policy.allow, [{ host: 'models.internal', wildcard: false, port: 8443 }]);
  assert.deepEqual(policy.schemes, ['https']);
  // Deliberately wider than a federated source gets, and for a reason that does
  // not apply to a source: this address comes from the operator's environment,
  // not from a user calling the API. A model server inside a partner's own
  // network is the deployment this exists for.
  assert.equal(policy.allowPrivate, true);
});

// ---------------------------------------------------------------------------
// The answer, checked rather than trusted
//
// Every one of these is a case where returning SOMETHING would rank: a vector
// of the wrong width, a vector attached to the wrong text, a vector that is not
// numbers. There is no substituted value on any path, exactly as there is none
// in httpconnector.ts, because a plausible wrong vector cites the wrong page
// confidently and nothing on the screen would say so.

test('parseEmbeddings: refuses a width the index was not built for', () => {
  assert.throws(
    () => parseEmbeddings(vectorsFor(['a'], 384), 1, 768, 'https://m'),
    (err: Error) => err instanceof EmbeddingProviderError && /384 dimensions where the index is built for 768/.test(err.message),
  );
});

test('parseEmbeddings: refuses a different number of vectors than texts', () => {
  assert.throws(
    () => parseEmbeddings(vectorsFor(['a', 'b'], 4), 3, 4, 'https://m'),
    (err: Error) => err instanceof EmbeddingProviderError && /2 vectors for 3 texts/.test(err.message),
  );
});

test('parseEmbeddings: refuses vectors that are not numbers, and answers that are not JSON', () => {
  const notNumbers = JSON.stringify({ data: [{ index: 0, embedding: ['1', '2'] }] });
  assert.throws(() => parseEmbeddings(notNumbers, 1, 2, 'https://m'), EmbeddingProviderError);
  const infinite = JSON.stringify({ data: [{ index: 0, embedding: [1, Number.POSITIVE_INFINITY] }] });
  assert.throws(() => parseEmbeddings(JSON.stringify(JSON.parse(infinite)), 1, 2, 'https://m'), EmbeddingProviderError);
  assert.throws(() => parseEmbeddings('<html>502</html>', 1, 2, 'https://m'), EmbeddingProviderError);
  assert.throws(() => parseEmbeddings('{"error":"nope"}', 1, 2, 'https://m'), EmbeddingProviderError);
});

test('parseEmbeddings: an out-of-order answer is put back in the order of the texts', () => {
  // The contract is that answer N belongs to text N. An endpoint that sends
  // them shuffled with their indexes attached is within the contract; taking
  // them as they arrive would attach every vector to the wrong chunk, and the
  // failure would be silent and total.
  const body = JSON.stringify({
    data: [
      { index: 2, embedding: [3, 3] },
      { index: 0, embedding: [1, 1] },
      { index: 1, embedding: [2, 2] },
    ],
  });
  assert.deepEqual(parseEmbeddings(body, 3, 2, 'https://m'), [
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
});

test('http provider: a refusal from the model is a failure, not an empty vector', async () => {
  const { transport } = recordingTransport(() => ({ status: 429, body: 'rate limited: your text was "…"' }));
  const provider = httpEmbeddingProvider({
    url: 'https://models.example.com/v1/embeddings',
    model: 'm',
    dimensions: 4,
    transport,
    resolver: fixedResolver,
  });
  await assert.rejects(
    () => provider.embed(['anything']),
    (err: Error) =>
      err instanceof EmbeddingProviderError &&
      err.message.includes('429') &&
      // The endpoint's body is not quoted back: an error from a model server
      // can carry the request that caused it, and the request is the record.
      !err.message.includes('your text'),
  );
});

// ---------------------------------------------------------------------------
// What a failing provider does to the product

test('a provider that cannot answer leaves retrieval lexical rather than wrong', async () => {
  const failing: EmbeddingProvider = {
    name: 'always-fails',
    dimensions: 4,
    async embed() {
      throw new Error('the model is down');
    },
  };
  const store = new CanonStore(openDb(':memory:'), { deliver() {} }, failing);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'd@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'i@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  const page = store.createPage(dana.id, { collectionId: collection.id, type: 'policy', title: 'Vault access' });
  store.editDraft(dana.id, page.id, {
    body: 'Every access to the vault is logged and reviewed each month.',
    fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(dana.id, page.id);
  store.approve(iris.id, page.id);
  await store.embeddings.ready();

  // The failure is reported rather than swallowed...
  assert.ok(store.embeddings.error, 'the store knows the provider failed');
  assert.equal(store.embeddings.chunksFor(page.id).length, 0);
  // ...and the product still answers, out of the lexical channel and the graph.
  const answer = await store.ask(dana.id, { question: 'Is vault access logged?' });
  assert.equal(answer.refused, false);
  assert.ok(answer.citations.some((c) => c.pageId === page.id));
});

// ---------------------------------------------------------------------------
// The in-process model: its wiring, which is what can be tested here

test('local model provider: batches, checks the width, and names the model', async () => {
  const calls: string[][] = [];
  const fakeModule = {
    async pipeline(task: string, model: string) {
      assert.equal(task, 'feature-extraction');
      assert.equal(model, 'Xenova/all-MiniLM-L6-v2');
      return async (texts: string[], options: { pooling: string; normalize: boolean }) => {
        assert.deepEqual(options, { pooling: 'mean', normalize: true });
        calls.push(texts);
        return { tolist: () => texts.map(() => [0.6, 0.8]) };
      };
    },
  };
  const provider = localModelEmbeddingProvider({
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 2,
    batchSize: 2,
    load: async () => fakeModule,
  });

  assert.equal(provider.name, 'local-model:Xenova/all-MiniLM-L6-v2');
  const vectors = await provider.embed(['a', 'b', 'c']);
  assert.deepEqual(calls, [['a', 'b'], ['c']], 'three texts at a batch size of two');
  assert.equal(vectors.length, 3);
  // Mean-pooled and normalised is what the model is asked for and what cosine
  // in embeddings.ts assumes; a unit vector against itself is 1.
  assert.ok(Math.abs(cosine(vectors[0]!, vectors[0]!) - 1) < 1e-9);

  // The pipeline is opened once and reused, not per call.
  await provider.embed(['d']);
  assert.equal(calls.length, 3);
});

test('local model provider: a wrong width is refused rather than stored', async () => {
  const provider = localModelEmbeddingProvider({
    model: 'm',
    dimensions: 768,
    load: async () => ({ async pipeline() { return async (t: string[]) => ({ tolist: () => t.map(() => [1, 2, 3]) }); } }),
  });
  await assert.rejects(() => provider.embed(['a']), /3 dimensions where the index is built for 768/);
});

test('local model provider: the missing optional dependency says so, and says what to do', async () => {
  const provider = localModelEmbeddingProvider({
    model: 'm',
    dimensions: 8,
    moduleName: '@nobody/not-installed',
    load: async (name) => {
      throw new Error(`Cannot find package '${name}'`);
    },
  });
  await assert.rejects(
    () => provider.embed(['a']),
    (err: Error) =>
      err instanceof EmbeddingProviderError &&
      err.message.includes('@nobody/not-installed') &&
      err.message.includes('CANON_EMBEDDINGS'),
  );
});

// ---------------------------------------------------------------------------
// Configuration

test('config: the default is the built-in local provider and nothing is configured', () => {
  assert.equal(embeddingProviderFromEnv({}), null);
  assert.equal(embeddingProviderFromEnv({ CANON_EMBEDDINGS: 'local' }), null);
});

test('config: a half-configured provider is refused at the point of construction', () => {
  assert.throws(() => embeddingProviderFromEnv({ CANON_EMBEDDINGS: 'magic' }), /must be one of/);
  assert.throws(() => embeddingProviderFromEnv({ CANON_EMBEDDINGS: 'http' }), /CANON_EMBEDDINGS_MODEL/);
  assert.throws(
    () => embeddingProviderFromEnv({ CANON_EMBEDDINGS: 'http', CANON_EMBEDDINGS_MODEL: 'm' }),
    /CANON_EMBEDDINGS_DIMENSIONS/,
  );
  assert.throws(
    () =>
      embeddingProviderFromEnv({
        CANON_EMBEDDINGS: 'http',
        CANON_EMBEDDINGS_MODEL: 'm',
        CANON_EMBEDDINGS_DIMENSIONS: '768',
      }),
    /CANON_EMBEDDINGS_URL/,
  );
});

test('config: a whole configuration builds the provider it names', () => {
  const provider = embeddingProviderFromEnv({
    CANON_EMBEDDINGS: 'http',
    CANON_EMBEDDINGS_URL: 'https://models.example.com/v1/embeddings',
    CANON_EMBEDDINGS_MODEL: 'text-embedding-3-small',
    CANON_EMBEDDINGS_DIMENSIONS: '1536',
  });
  assert.equal(provider?.name, 'http:text-embedding-3-small');
  assert.equal(provider?.dimensions, 1536);

  const inProcess = embeddingProviderFromEnv({
    CANON_EMBEDDINGS: 'transformers',
    CANON_EMBEDDINGS_MODEL: 'Xenova/all-MiniLM-L6-v2',
    CANON_EMBEDDINGS_DIMENSIONS: '384',
  });
  assert.equal(inProcess?.name, 'local-model:Xenova/all-MiniLM-L6-v2');
  assert.deepEqual([...EMBEDDING_MODES], ['local', 'http', 'transformers']);
});

test('config: start-up validation refuses an incomplete provider and warns about plaintext', async () => {
  const base = { CANON_DEV_AUTH: 'true', CANON_SKIP_DNS_CHECK: 'true' };
  const incomplete = await validateConfig(
    { ...base, CANON_EMBEDDINGS: 'http' },
    { skipDns: true },
  );
  assert.equal(incomplete.ok, false);
  assert.deepEqual(
    incomplete.problems.map((p) => p.variable).sort(),
    ['CANON_EMBEDDINGS_DIMENSIONS', 'CANON_EMBEDDINGS_MODEL', 'CANON_EMBEDDINGS_URL'],
  );

  // Every published page in the record goes through this endpoint. Over plain
  // http, off this machine, every published page crosses the network in clear.
  const plaintext = await validateConfig(
    {
      ...base,
      CANON_EMBEDDINGS: 'http',
      CANON_EMBEDDINGS_URL: 'http://models.internal/v1/embeddings',
      CANON_EMBEDDINGS_MODEL: 'm',
      CANON_EMBEDDINGS_DIMENSIONS: '768',
    },
    { skipDns: true },
  );
  assert.equal(plaintext.ok, true, 'it works exactly as asked, so it is a warning');
  assert.ok(plaintext.warnings.some((w) => w.variable === 'CANON_EMBEDDINGS_URL'));

  // A model on this machine over http is not crossing anything.
  const loopback = await validateConfig(
    {
      ...base,
      CANON_EMBEDDINGS: 'http',
      CANON_EMBEDDINGS_URL: 'http://localhost:8080/v1/embeddings',
      CANON_EMBEDDINGS_MODEL: 'm',
      CANON_EMBEDDINGS_DIMENSIONS: '768',
    },
    { skipDns: true },
  );
  assert.ok(!loopback.warnings.some((w) => w.variable === 'CANON_EMBEDDINGS_URL'));
});
