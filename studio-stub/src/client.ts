// The Knowledge API client: the whole of this app's dependency on Veryl Canon
// (STUDIO-CONTRACT.md §6).
//
// Two headers, on every call, and no third way in:
//
//   X-Agent-Passport   the app's Agent Passport, issued by the Registry
//   X-On-Behalf-Of     the Canon actor id of the person the app is acting for
//
// The app holds no permissions of its own. It does not cache what Canon told
// it last time, it does not remember that a page was readable a minute ago,
// and it mints nothing that outlives a call — because the contract's guarantee
// is that a permission change or a revocation is effective on the very next
// call, and a client that cached answers would quietly break it.

import { Answer, CollectionSummary, KnowledgeError, SearchHit, Whoami } from './model.js';

export interface KnowledgeClientOptions {
  /** Canon's base URL, e.g. http://127.0.0.1:3000. */
  baseUrl: string;
  /** The app's Agent Passport. Opaque: never parsed, never derived from. */
  passport: string;
  requestTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 5_000;

export class KnowledgeClient {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  private readonly passport: string;

  constructor(options: KnowledgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.passport = options.passport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Who is asking, and what does the intersection currently come to? */
  whoami(onBehalfOf: string): Promise<Whoami> {
    return this.request<Whoami>('GET', '/knowledge/whoami', onBehalfOf);
  }

  collections(onBehalfOf: string): Promise<CollectionSummary[]> {
    return this.request<CollectionSummary[]>('GET', '/knowledge/collections', onBehalfOf);
  }

  search(onBehalfOf: string, q: string, opts: { collectionId?: string; limit?: number } = {}): Promise<SearchHit[]> {
    const query = new URLSearchParams({ q });
    if (opts.collectionId) query.set('collection', opts.collectionId);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    return this.request<SearchHit[]>('GET', `/knowledge/search?${query.toString()}`, onBehalfOf);
  }

  ask(onBehalfOf: string, request: { question: string; collectionId?: string; limit?: number }): Promise<Answer> {
    return this.request<Answer>('POST', '/knowledge/ask', onBehalfOf, request);
  }

  // ---- internals -------------------------------------------------------

  private async request<T>(method: string, path: string, onBehalfOf: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-agent-passport': this.passport,
          'x-on-behalf-of': onBehalfOf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      // Canon did not answer. That is not an empty result and it is certainly
      // not permission to answer from something else.
      throw new KnowledgeError(0, 'unreachable', `Canon did not answer: ${(err as Error).message}`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new KnowledgeError(res.status, 'unparseable', 'Canon answered something this app cannot read');
    }

    if (!res.ok) {
      const details = (payload ?? {}) as Record<string, unknown>;
      throw new KnowledgeError(
        res.status,
        typeof details.error === 'string' ? details.error : 'error',
        typeof details.message === 'string' ? details.message : `Canon refused with ${res.status}`,
        details,
      );
    }
    return payload as T;
  }
}
