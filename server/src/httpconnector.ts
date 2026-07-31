// Canon's HTTP connector for federated values, per DATA-BACKBONE.md §6.
//
// This module is Canon's entire view of an external record system: ask a
// registered Source for one field, by the key the page already carries, on
// behalf of a named actor, and get back a value with the time it was
// resolved — or a typed failure. It is deliberately self-contained (no
// imports from the rest of the server) so it can be exercised against the
// source-stub in isolation and wired into the reference layer without
// touching anything else first, exactly as registry.ts is.
//
// Three properties carry the section's guarantees:
//
// - **Whose permissions.** A `per_asker` source is called with the asking
//   actor's own identity in a header, so the source applies its own access
//   model to the real reader. A `service` source is called with a configured
//   service identity, which is a decision to publish the value to everyone
//   who can view the collection — the reference layer is what must say so on
//   the page. Canon holds no per-asker credential either way; it passes a
//   name and lets the source decide.
//
// - **Two kinds of failure, and they are not the same.** "The source said
//   no" (403, 404) is a real answer about this reference: the caller is not
//   entitled, or there is nothing under that key. Retrying cannot change it,
//   and the reference layer should show a refusal rather than a stale value
//   dressed as current. "The source did not answer" (timeout, 5xx,
//   unreachable, unparseable) is not an answer at all: the last resolved
//   value, labelled and timestamped, is the honest thing to show.
//
// - **Never a guess.** There is no default, no fallback, no zero, no empty
//   string on any path through this file. Every failure throws. A connector
//   that substitutes a plausible number for a deductible it could not fetch
//   is worse than no integration at all, and the tests assert this by
//   construction as well as by behaviour.

/**
 * The registered external system, per DATA-BACKBONE.md §6 ("The shapes").
 *
 * NOTE FOR MERGE: the federation core (`server/src/sources.ts`) owns the
 * canonical `Source` type. This is the minimal structural subset the
 * connector actually reads; a fuller `Source` carrying `owner`, permitted
 * collections and the rest satisfies it without change.
 */
import type { Asker, Connector as CoreConnector, ResolveResult } from './connectors.js';

export interface ConnectorSource {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: 'per_asker' | 'service';
  freshnessWindowMs: number;
}

/** What to ask, the page-held identifier to ask it with, and who is asking. */
export interface ResolveRequest {
  selector: string;
  key: string;
  /**
   * The asking actor's id. Sent as-is for a `per_asker` source; for a
   * `service` source it is ignored in favour of the configured service
   * identity, but it is still required, because every resolution is an audit
   * event naming who asked.
   */
  asker: Asker | null;
}

/** A federated value is a scalar. A source returning an object is telling us we asked the wrong question. */
export type ResolvedValue = string | number | boolean;

/** The seam's answer. `resolvedAt` is when Canon got it, not when the source last changed it. */
export interface Resolved {
  value: ResolvedValue;
  resolvedAt: string;
}

/**
 * The seam an integration plugs into, parallel to the embedding provider in
 * section 5. A hermetic default lives with the federation core so the system
 * and its tests run with no external calls; this file is the real one.
 */
export interface Connector {
  readonly name: string;
  resolve(source: ConnectorSource, request: ResolveRequest): Promise<Resolved>;
}

/**
 * Whether the source gave an answer about this reference or failed to answer
 * at all. The reference layer branches on this and nothing else:
 *
 * - `refused` — the source answered, and the answer is no. Do not retry, do
 *   not fall back to a cached value as though it were current.
 * - `unanswered` — no answer was obtained. Retry is legitimate, and showing
 *   the last resolved value with its timestamp is legitimate.
 */
export type ConnectorFailureKind = 'refused' | 'unanswered';

export type ConnectorFailureCode =
  // refused: the source answered, and the answer is no.
  | 'forbidden' // 403 — this asker may not see this value
  | 'not_found' // 404 — nothing under that key or selector
  // unanswered: no usable answer was obtained.
  | 'unauthenticated' // 401 — the source did not accept who we said we were
  | 'timeout' // the source was too slow
  | 'unreachable' // connection refused, DNS, TLS, socket closed
  | 'source_error' // 5xx, or any status this connector cannot classify
  | 'unparseable' // not JSON, no scalar value, or an answer about something else
  | 'misconfigured'; // Canon cannot even form the request honestly

const REFUSAL_CODES: readonly ConnectorFailureCode[] = ['forbidden', 'not_found'];

export class ConnectorError extends Error {
  readonly kind: ConnectorFailureKind;
  readonly code: ConnectorFailureCode;
  readonly sourceId: string;
  readonly selector: string;
  readonly key: string;
  readonly status: number | null;

  constructor(
    code: ConnectorFailureCode,
    message: string,
    context: { source: ConnectorSource; request: ResolveRequest; status?: number | null },
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.kind = REFUSAL_CODES.includes(code) ? 'refused' : 'unanswered';
    this.sourceId = context.source.id;
    this.selector = context.request.selector;
    this.key = context.request.key;
    this.status = context.status ?? null;
  }

  /** A refusal is a real answer; retrying it only annoys the source. */
  get retryable(): boolean {
    return this.kind === 'unanswered';
  }
}

export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError;
}

export interface HttpConnectorOptions {
  /**
   * The service identity presented for `service` sources. Required before a
   * `service` source can resolve: without it there is no honest request to
   * make, and the connector fails rather than resolving anonymously.
   */
  serviceIdentity?: string;
  /** How long to wait for the source. Default 3s — a page render is waiting on this. */
  requestTimeoutMs?: number;
  /** Header naming the asking actor. Default `X-Asker`. */
  askerHeader?: string;
  /** Lookup path on the source's baseUrl. Default `/lookup`. */
  lookupPath?: string;
  /** Query parameter names the source expects. Defaults `key` and `selector`. */
  keyParam?: string;
  selectorParam?: string;
  /** Field of the JSON answer holding the value. Default `value`. */
  valueField?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Structured lookup over HTTP: `GET {baseUrl}{lookupPath}?key=…&selector=…`
 * with the asker named in a header. This is the record-system pattern from
 * DATA-BACKBONE.md §6 — the page supplies the key, the connector supplies the
 * value — and it is the only shape offered, because a source that answers
 * only by key is exactly the case that cannot be ranked or enumerated.
 *
 * Filters are pushed down: one field, one key, one request. Canon never
 * fetches a plan and picks a field out of it locally.
 */
export class HttpConnector implements Connector, CoreConnector {
  /** Matches `source.kind`; the core's ConnectorRegistry keys on it. */
  readonly kind = 'http';
  readonly name = 'http-lookup-v1';
  readonly requestTimeoutMs: number;
  readonly askerHeader: string;
  readonly lookupPath: string;
  private readonly serviceIdentity: string | null;
  private readonly keyParam: string;
  private readonly selectorParam: string;
  private readonly valueField: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpConnectorOptions = {}) {
    this.serviceIdentity = options.serviceIdentity?.trim() || null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.askerHeader = options.askerHeader ?? 'X-Asker';
    this.lookupPath = options.lookupPath ?? '/lookup';
    this.keyParam = options.keyParam ?? 'key';
    this.selectorParam = options.selectorParam ?? 'selector';
    this.valueField = options.valueField ?? 'value';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolve one reference. Returns the value and the moment it was resolved,
   * or throws a `ConnectorError`. It never returns a substituted value, and
   * there is no argument by which it could: every path below either returns
   * a value parsed out of the source's own answer, or throws.
   */
  async resolve(source: ConnectorSource, request: ResolveRequest): Promise<Resolved> {
    // Every failure below is `throw failure(...)`. There is no branch that
    // returns something instead.
    const failure = (code: ConnectorFailureCode, message: string, status?: number | null): ConnectorError =>
      new ConnectorError(code, message, { source, request, status });

    const key = request.key?.trim();
    const selector = request.selector?.trim();
    if (!key) {
      throw failure('misconfigured', 'A reference must carry the key its page holds');
    }
    if (!selector) {
      throw failure('misconfigured', 'A reference must name a selector');
    }

    // Identity first, because resolving without one is the failure mode this
    // whole design exists to prevent.
    const identity = this.identityFor(source, request);
    if (!identity) {
      throw failure(
        'misconfigured',
        source.authMode === 'service'
          ? `Source ${source.name} is service-resolved but this deployment configured no service identity`
          : `Source ${source.name} resolves per asker and no asking actor was named`,
      );
    }

    let url: URL;
    try {
      url = new URL(this.lookupPath.replace(/^\/+/, ''), `${source.baseUrl.replace(/\/+$/, '')}/`);
    } catch {
      throw failure('misconfigured', `Source ${source.name} has an unusable baseUrl: ${source.baseUrl}`);
    }
    url.searchParams.set(this.keyParam, key);
    url.searchParams.set(this.selectorParam, selector);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', [this.askerHeader]: identity },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw failure('timeout', `${source.name} did not answer within ${this.requestTimeoutMs}ms`);
      }
      throw failure('unreachable', `${source.name} could not be reached: ${(err as Error).message}`);
    }

    // The body is read whatever the status: a source's refusal usually
    // explains itself, and that explanation belongs in the audit event.
    let payload: unknown;
    let parsedJson = true;
    try {
      payload = await response.json();
    } catch {
      parsedJson = false;
    }
    const body = (parsedJson && payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const detail = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;

    if (!response.ok) {
      // The two refusals: a real answer about this reference, not to be retried.
      if (response.status === 403) {
        throw failure('forbidden', `${source.name} refused: ${detail}`, response.status);
      }
      if (response.status === 404) {
        throw failure('not_found', `${source.name} has nothing under ${selector}/${key}: ${detail}`, response.status);
      }
      // Canon named an actor the source would not accept. Not an answer about
      // the value — Canon's own configuration is what is wrong.
      if (response.status === 401) {
        throw failure(
          'unauthenticated',
          `${source.name} did not accept the caller identity Canon presented: ${detail}`,
          response.status,
        );
      }
      // Everything else — 5xx, 429, 501, anything unclassified — is "no answer".
      throw failure('source_error', `${source.name} failed to answer: ${detail}`, response.status);
    }

    if (!parsedJson) {
      throw failure('unparseable', `${source.name} answered with something other than JSON`, response.status);
    }

    const value = body[this.valueField];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw failure(
        'unparseable',
        `${source.name} answered without a scalar \`${this.valueField}\` for ${selector}/${key}`,
        response.status,
      );
    }

    // A source that echoes the question must have answered the one we asked.
    // Silently accepting a value filed under a different key is how a reader
    // ends up shown another plan's deductible.
    const echoedKey = body[this.keyParam];
    if (typeof echoedKey === 'string' && echoedKey !== key) {
      throw failure('unparseable', `${source.name} answered about key ${echoedKey}, not ${key}`, response.status);
    }
    const echoedSelector = body[this.selectorParam];
    if (typeof echoedSelector === 'string' && echoedSelector !== selector) {
      throw failure(
        'unparseable',
        `${source.name} answered about ${echoedSelector}, not ${selector}`,
        response.status,
      );
    }

    return { value, resolvedAt: new Date().toISOString() };
  }

  /**
   * Who this request is made as. Per DATA-BACKBONE.md §6: the asker's own
   * identity wherever the source can accept it, a configured service identity
   * where it cannot — and that second choice is a decision to publish the
   * value to the collection, which the reference layer states on the page.
   */
  private identityFor(source: ConnectorSource, request: ResolveRequest): string | null {
    if (source.authMode === 'service') return this.serviceIdentity;
    const asker = request.asker?.actorId?.trim();
    return asker ? asker : null;
  }
}
