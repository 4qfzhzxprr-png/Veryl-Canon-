// Where a real embedding model is plugged in.
//
// embeddings.ts defines the seam (`EmbeddingProvider`) and ships one
// implementation: a hashed bag of words, honest about being no such thing as
// semantic. It exists so the product runs, and the tests run hermetically, with
// no external call and no record text leaving the machine. What it cannot do is
// the thing semantic retrieval is FOR: recognise that "files about people who
// have left the company" and "employment records" are the same subject. The
// measured cost of that is in scripts/eval-retrieval.ts — that exact question
// comes back tenth, behind three pages about retaining claims — and no amount
// of tuning the lexical channel moves it, because there is no shared word to
// tune (see the note over `lexicalRanking` in retrieval.ts, where the cheaper
// answer was tried and did not pay).
//
// This module is the other end of that seam. Two providers, and the difference
// between them is the one that matters to a regulated partner:
//
//   http          the record's text is sent to a model over the network. Any
//                 OpenAI-compatible /v1/embeddings endpoint: a hosted API, or —
//                 more to the point — a text-embeddings server the partner runs
//                 themselves, inside their own network.
//   transformers  the model runs in this process. Nothing leaves the machine.
//                 Costs a dependency and a few hundred megabytes of weights.
//
// The default remains `local`, and changing that default is a decision an
// operator makes, not one this file makes for them: one of these sends the
// company's policies to a server and the other adds a large dependency, and
// neither should happen because a config file was left empty.
//
// THE PROVIDER NAME CARRIES THE MODEL, and that is load-bearing rather than
// cosmetic. Every stored vector records the provider that made it, and every
// query matches only vectors made by the provider now running; a mismatch is
// detected when the store opens and repaired by re-deriving from the record
// (embeddings.ts). Two models produce two unrelated vector spaces, so a change
// of model has to look like a change of provider, or the index would quietly
// rank one space's vectors against another's.

import type { EmbeddingProvider } from './embeddings.js';
import {
  OutboundPolicy,
  OutboundRefused,
  resolveOutboundTarget,
  systemResolver,
  type AddressResolver,
} from './outbound.js';
import { OutboundTransport, isConnectFailure, pinnedHttpRequest } from './pinnedhttp.js';

/** How many texts go in one request. A page is a handful of chunks. */
export const DEFAULT_BATCH = 32;
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * A batch of vectors is legitimately large: 32 texts at 1024 dimensions is
 * about 800KB of JSON, and a bigger model or a bigger batch is more. The
 * federated-value ceiling (1MB, sized for one scalar) would refuse correct
 * answers, so this caller states its own.
 */
export const MAX_EMBEDDING_RESPONSE_BYTES = 32 * 1024 * 1024;

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

export interface HttpEmbeddingOptions {
  /** The full endpoint, as it appears in the model server's own documentation. */
  url: string;
  /** The model name, sent in the request and carried in the provider's name. */
  model: string;
  /**
   * The width of the vectors this model returns. Stated by the operator rather
   * than discovered, and checked against every answer: a model that returns a
   * different width than the index was built for is a misconfiguration, and
   * silently storing mixed widths would make the index meaningless in a way
   * nothing would report.
   */
  dimensions: number;
  apiKey?: string;
  batchSize?: number;
  timeoutMs?: number;
  transport?: OutboundTransport;
  resolver?: AddressResolver;
  /**
   * Which hosts this provider may reach. Defaults to exactly the host in `url`,
   * private addresses included.
   *
   * That default is wider than the one federated sources get, and the reason it
   * is defensible is the reason it is different: a Source is registered by a
   * USER through the API, so its address is untrusted input and the whole
   * SSRF apparatus in outbound.ts exists to bound it. This endpoint comes from
   * the operator's own environment and names one host. Refusing it for being on
   * a private network would refuse the deployment the partners who care most
   * about this actually want — a model server inside their own perimeter.
   */
  outbound?: OutboundPolicy;
}

/**
 * An OpenAI-compatible embeddings endpoint: `POST /v1/embeddings` with
 * `{ model, input: string[] }`, answering `{ data: [{ embedding: number[] }] }`.
 *
 * That shape is not a bet on one vendor. It is what OpenAI, Azure OpenAI,
 * vLLM, Ollama, LM Studio, LocalAI and Hugging Face's text-embeddings-inference
 * all speak, which makes it the one wire format that reaches both a hosted API
 * and a self-hosted server without a second implementation.
 *
 * EVERY FAILURE THROWS. There is no substituted vector on any path here, for
 * the same reason httpconnector.ts substitutes no value: a plausible-looking
 * vector is a wrong answer that ranks. A throw leaves the page out of the
 * semantic channel, retrieval degrades to lexical and graph, and
 * `EmbeddingStore.error` reports why.
 */
export function httpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  const url = new URL(options.url);
  const model = options.model.trim();
  if (!model) throw new EmbeddingProviderError('An embedding endpoint requires a model name');
  if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
    throw new EmbeddingProviderError('An embedding endpoint requires the width of its vectors');
  }
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const transport = options.transport ?? pinnedHttpRequest;
  const resolver = options.resolver ?? systemResolver;
  const outbound = options.outbound ?? policyForEndpoint(url);

  return {
    name: `http:${model}`,
    dimensions: options.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        out.push(...(await embedBatch(batch)));
      }
      return out;
    },
  };

  async function embedBatch(batch: string[]): Promise<number[][]> {
    let pinned;
    try {
      pinned = await resolveOutboundTarget(url, outbound, resolver);
    } catch (err) {
      if (err instanceof OutboundRefused) {
        throw new EmbeddingProviderError(`Canon may not reach the embedding model at ${url.origin}: ${err.message}`);
      }
      throw err;
    }

    const body = JSON.stringify({ model, input: batch });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

    // The policy hands back every address it judged, in resolver order. A host
    // that refuses the connection on its first address may answer on its
    // second; anything past the connection — a timeout, a TLS failure, a
    // status — is an answer of a kind, and trying the next address would be
    // shopping for a friendlier one. Same rule as httpconnector.ts.
    let response;
    let last: unknown = null;
    for (const at of pinned.addresses) {
      try {
        response = await transport({
          url: pinned.url,
          method: 'POST',
          headers,
          timeoutMs,
          host: pinned.host,
          port: pinned.port,
          address: at.address,
          family: at.family,
          body,
          maxBytes: MAX_EMBEDDING_RESPONSE_BYTES,
        });
        break;
      } catch (err) {
        last = err;
        if (!isConnectFailure(err)) break;
      }
    }
    if (!response) {
      throw new EmbeddingProviderError(
        `The embedding model at ${url.origin} did not answer: ${(last as Error)?.message ?? 'no addresses'}`,
      );
    }

    if (response.status < 200 || response.status > 299) {
      // The body is NOT quoted back. A model server's error can carry the
      // request that caused it, and the request is the record's own text.
      throw new EmbeddingProviderError(
        `The embedding model at ${url.origin} answered ${response.status}`,
      );
    }
    return parseEmbeddings(response.body, batch.length, options.dimensions, url.origin);
  }
}

/** The answer, checked rather than trusted. */
export function parseEmbeddings(
  body: string,
  expected: number,
  dimensions: number,
  origin: string,
): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EmbeddingProviderError(`The embedding model at ${origin} answered something that is not JSON`);
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new EmbeddingProviderError(`The embedding model at ${origin} answered without a data array`);
  }
  if (data.length !== expected) {
    throw new EmbeddingProviderError(
      `The embedding model at ${origin} returned ${data.length} vectors for ${expected} texts`,
    );
  }
  // Ordered by `index` where the endpoint sends one, because the contract says
  // the answers correspond to the inputs and a vector attached to the wrong
  // chunk is worse than no vector: it cites the wrong page, confidently.
  const rows = [...data];
  if (rows.every((r) => typeof (r as { index?: unknown })?.index === 'number')) {
    rows.sort((a, b) => (a as { index: number }).index - (b as { index: number }).index);
  }
  return rows.map((row, at) => {
    const vector = (row as { embedding?: unknown })?.embedding;
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(`The embedding model at ${origin} returned no vector for text ${at}`);
    }
    if (vector.length !== dimensions) {
      throw new EmbeddingProviderError(
        `The embedding model at ${origin} returned ${vector.length} dimensions where the index is built ` +
          `for ${dimensions}. Set CANON_EMBEDDINGS_DIMENSIONS to the model's real width; the index will ` +
          `re-derive itself from the record.`,
      );
    }
    for (const n of vector) {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new EmbeddingProviderError(`The embedding model at ${origin} returned a vector that is not numbers`);
      }
    }
    return vector as number[];
  });
}

/** Exactly the configured host, and nothing else. */
export function policyForEndpoint(url: URL): OutboundPolicy {
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : null;
  return {
    allow: [{ host, wildcard: false, port }],
    schemes: [url.protocol.replace(/:$/, '').toLowerCase()],
    allowPrivate: true,
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// The in-process model
//
// An optional dependency, imported only if a deployment asks for it, so that
// `npm install` for everybody else does not pull several hundred megabytes of
// ONNX runtime for a feature they have not turned on. A deployment that names
// this provider and has not installed it is told exactly that.

export interface LocalModelOptions {
  /** A model id, or a path to one already on disk. */
  model: string;
  dimensions: number;
  batchSize?: number;
  /**
   * The module to load. Defaults to '@huggingface/transformers'. Injectable so
   * the wiring around it can be tested without the dependency present.
   */
  moduleName?: string;
  /** Test seam: what `import(moduleName)` should yield. */
  load?: (moduleName: string) => Promise<unknown>;
}

interface FeatureExtractionModule {
  pipeline(task: string, model: string, options?: unknown): Promise<unknown>;
}

type Extractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * A sentence-transformer running in this process, over ONNX. Mean-pooled and
 * L2-normalised, which is what these models are trained to be compared as and
 * what `cosine` in embeddings.ts expects.
 *
 * BE CLEAR ABOUT WHAT HAS AND HAS NOT BEEN EXERCISED. The wiring below is
 * tested: which module is loaded, what happens when it is absent, how texts are
 * batched, that the width of what comes back is checked. The MODEL ITSELF has
 * never run in this repository's test environment, because fetching its weights
 * needs a host that environment cannot reach. So this path wants one run on a
 * machine that can before it is trusted with a deployment, and it is the
 * default nowhere.
 */
export function localModelEmbeddingProvider(options: LocalModelOptions): EmbeddingProvider {
  const moduleName = options.moduleName ?? '@huggingface/transformers';
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const load = options.load ?? ((name: string) => import(/* @vite-ignore */ name));
  let extractor: Promise<Extractor> | null = null;

  const open = (): Promise<Extractor> => {
    extractor ??= (async () => {
      let module: FeatureExtractionModule;
      try {
        module = (await load(moduleName)) as FeatureExtractionModule;
      } catch (err) {
        throw new EmbeddingProviderError(
          `Canon is configured to run the embedding model ${options.model} in this process, which needs ` +
            `the optional dependency ${moduleName}. Install it, or set CANON_EMBEDDINGS to http or local. ` +
            `(${(err as Error).message})`,
        );
      }
      if (typeof module?.pipeline !== 'function') {
        throw new EmbeddingProviderError(`${moduleName} does not look like a transformers module`);
      }
      return (await module.pipeline('feature-extraction', options.model)) as Extractor;
    })();
    return extractor;
  };

  return {
    name: `local-model:${options.model}`,
    dimensions: options.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const run = await open();
      const out: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const result = await run(batch, { pooling: 'mean', normalize: true });
        const vectors = result.tolist();
        if (vectors.length !== batch.length) {
          throw new EmbeddingProviderError(
            `${options.model} returned ${vectors.length} vectors for ${batch.length} texts`,
          );
        }
        for (const vector of vectors) {
          if (vector.length !== options.dimensions) {
            throw new EmbeddingProviderError(
              `${options.model} returned ${vector.length} dimensions where the index is built for ` +
                `${options.dimensions}. Set CANON_EMBEDDINGS_DIMENSIONS to the model's real width.`,
            );
          }
          out.push(vector);
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration

export const EMBEDDING_MODES = ['local', 'http', 'transformers'] as const;
export type EmbeddingMode = (typeof EMBEDDING_MODES)[number];

/**
 * The provider a deployment asked for, or null for the built-in local one.
 *
 * Null rather than the local provider itself so the caller keeps the existing
 * default in one place — `new CanonStore(db, mail, undefined)` already means
 * "the local provider" and there is no reason for two spellings of it.
 *
 * Throws on a configuration that cannot mean anything. A deployment that asks
 * for a model and does not say where it is has made a mistake that will
 * otherwise show up as an index that is quietly empty.
 */
export function embeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  const mode = (env.CANON_EMBEDDINGS ?? '').trim().toLowerCase();
  if (!mode || mode === 'local') return null;
  if (!EMBEDDING_MODES.includes(mode as EmbeddingMode)) {
    throw new EmbeddingProviderError(
      `CANON_EMBEDDINGS is "${mode}"; it must be one of ${EMBEDDING_MODES.join(', ')}`,
    );
  }
  const model = (env.CANON_EMBEDDINGS_MODEL ?? '').trim();
  const dimensions = Number(env.CANON_EMBEDDINGS_DIMENSIONS ?? '');
  if (!model) throw new EmbeddingProviderError('CANON_EMBEDDINGS is set, so CANON_EMBEDDINGS_MODEL is required');
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new EmbeddingProviderError(
      'CANON_EMBEDDINGS is set, so CANON_EMBEDDINGS_DIMENSIONS must be the width of the model’s vectors',
    );
  }
  const batchSize = Number(env.CANON_EMBEDDINGS_BATCH ?? '') || undefined;

  if (mode === 'transformers') {
    return localModelEmbeddingProvider({ model, dimensions, batchSize });
  }
  const url = (env.CANON_EMBEDDINGS_URL ?? '').trim();
  if (!url) {
    throw new EmbeddingProviderError('CANON_EMBEDDINGS=http, so CANON_EMBEDDINGS_URL is required');
  }
  return httpEmbeddingProvider({
    url,
    model,
    dimensions,
    apiKey: (env.CANON_EMBEDDINGS_API_KEY ?? '').trim() || undefined,
    batchSize,
    timeoutMs: Number(env.CANON_EMBEDDINGS_TIMEOUT_MS ?? '') || undefined,
  });
}
