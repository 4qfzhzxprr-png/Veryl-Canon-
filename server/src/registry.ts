// Canon's client for the Veryl Agent Registry, per REGISTRY-CONTRACT.md.
//
// This module is Canon's entire view of the Registry: present a passport,
// get back the agent's identity and limits, or a typed refusal. It is
// deliberately self-contained (no imports from the rest of the server) so
// it can be exercised against the registry-stub in isolation and wired
// into the API auth path (Epic D) without touching anything else first.
//
// Two properties carry the contract's guarantees:
//
// - Verified answers are cached for at most sixty seconds — the smaller of
//   the configured TTL, the Registry's own `recheckAfterSeconds`, and the
//   hard cap below. That arithmetic is what makes "revocation takes effect
//   in Canon within one minute" true (REGISTRY-CONTRACT.md §3).
// - Canon fails closed. An unreachable Registry, a timeout, or an answer
//   Canon cannot parse is a refusal, never an allowance, and is never
//   cached, so recovery is immediate when the Registry returns (§5).

export interface AgentVerification {
  agentId: string;
  name: string;
  certified: true;
  permittedCollections: string[];
  /**
   * The federated source ids this agent may resolve references from
   * (REGISTRY-CONTRACT.md §4). `"*"` means all; `[]` means none, and none is
   * what an answer that omits the field is read as — a Registry predating
   * federation must not accidentally grant an agent every source. Present but
   * not an array of strings is malformed, and malformed fails closed.
   */
  permittedSources: string[];
  permittedActions: string[];
}

export type VerifyFailureReason =
  | 'unknown_passport'
  | 'certification_lapsed'
  | 'revoked'
  | 'registry_unreachable';

export type VerifyResult =
  | { ok: true; agent: AgentVerification; checkedAt: string; cached: boolean }
  | { ok: false; reason: VerifyFailureReason; message: string };

// The one-minute guarantee (CORE-PLAN.md, Epic D; REGISTRY-CONTRACT.md §3).
// No verification result may be acted on for longer than this.
export const REVOCATION_GUARANTEE_MS = 60_000;

export interface RegistryClientOptions {
  /** Base URL of the Registry (stub or live), e.g. http://127.0.0.1:3100 */
  baseUrl: string;
  /**
   * How long a definitive answer may be cached. Clamped to the sixty-second
   * guarantee; pass 0 to re-ask the Registry on every request (the
   * "session-level immediate cutoff" posture from the open question).
   * Default 30 seconds.
   */
  cacheTtlMs?: number;
  /** How long to wait for the Registry before failing closed. Default 3s. */
  requestTimeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  result: VerifyResult;
  expiresAt: number;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null;
  return value as string[];
}

export class RegistryClient {
  readonly baseUrl: string;
  readonly cacheTtlMs: number;
  readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: RegistryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.cacheTtlMs = Math.min(Math.max(options.cacheTtlMs ?? 30_000, 0), REVOCATION_GUARANTEE_MS);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Present a passport to the Registry. Returns the agent's identity and
   * limits, or a typed refusal. Never throws: every failure mode collapses
   * into a refusal, because there is no failure mode that grants access.
   */
  async verifyPassport(passport: string): Promise<VerifyResult> {
    if (!passport || !passport.trim()) {
      return { ok: false, reason: 'unknown_passport', message: 'No passport presented' };
    }

    const hit = this.cache.get(passport);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.result.ok ? { ...hit.result, cached: true } : hit.result;
    }
    this.cache.delete(passport);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passport }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      return this.failClosed(`Registry unreachable: ${(err as Error).message}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failClosed('Registry answered with something other than JSON');
    }
    const body = (payload ?? {}) as Record<string, unknown>;

    if (response.ok) {
      const permittedCollections = stringArray(body.permittedCollections);
      const permittedActions = stringArray(body.permittedActions);
      // Silence means none; nonsense means no (REGISTRY-CONTRACT.md §6). An
      // absent permittedSources is the empty list — a Registry that predates
      // federation grants no source rather than every source — but a field
      // that is present and unreadable makes the whole answer malformed.
      const permittedSources = body.permittedSources === undefined ? [] : stringArray(body.permittedSources);
      if (
        body.certified !== true ||
        typeof body.agentId !== 'string' ||
        typeof body.name !== 'string' ||
        !permittedCollections ||
        !permittedSources ||
        !permittedActions
      ) {
        return this.failClosed('Registry verification answer was malformed');
      }
      const recheckMs =
        typeof body.recheckAfterSeconds === 'number' && body.recheckAfterSeconds >= 0
          ? body.recheckAfterSeconds * 1000
          : REVOCATION_GUARANTEE_MS;
      const result: VerifyResult = {
        ok: true,
        agent: {
          agentId: body.agentId,
          name: body.name,
          certified: true,
          permittedCollections,
          permittedSources,
          permittedActions,
        },
        checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : new Date().toISOString(),
        cached: false,
      };
      this.remember(passport, result, Math.min(this.cacheTtlMs, recheckMs));
      return result;
    }

    // Definitive refusals per the contract's error table. Anything else —
    // 5xx, unexpected codes, unknown error names — is "no usable answer".
    const error = body.error;
    const message = typeof body.message === 'string' ? body.message : `Registry refused (${response.status})`;
    if (
      (response.status === 404 && error === 'unknown_passport') ||
      (response.status === 403 && (error === 'certification_lapsed' || error === 'revoked'))
    ) {
      const result: VerifyResult = { ok: false, reason: error as VerifyFailureReason, message };
      this.remember(passport, result, this.cacheTtlMs);
      return result;
    }
    return this.failClosed(message);
  }

  /** Drop cached answers — one passport's, or all of them. */
  invalidate(passport?: string): void {
    if (passport === undefined) this.cache.clear();
    else this.cache.delete(passport);
  }

  // "No usable answer" is never cached (REGISTRY-CONTRACT.md §5): the next
  // request tries the Registry again, so recovery is immediate.
  private failClosed(message: string): VerifyResult {
    return { ok: false, reason: 'registry_unreachable', message };
  }

  private remember(passport: string, result: VerifyResult, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.cache.set(passport, { result, expiresAt: Date.now() + Math.min(ttlMs, REVOCATION_GUARANTEE_MS) });
  }
}
