// Agent Passport authentication and Registry-granted limits (CORE-PLAN.md
// Epic D, M3; REGISTRY-CONTRACT.md).
//
// This is the door Canon opens for agents. Everything it does follows the
// contract's three rules: the Registry is the only source of agent trust,
// Canon asks and then enforces, and no answer means no.
//
// What lives here and nowhere else:
//
// - Resolving an `X-Agent-Passport` header to a Canon actor. Canon stores no
//   credentials: the passport is presented to the Registry, and the answer's
//   `agentId` is matched against the actor's `registryRef`. An agent seen for
//   the first time gets an actor row created for it, named by the Registry.
// - Enforcing the Registry's `permittedCollections` and `permittedActions` as
//   an INTERSECTION with Canon's own collection permissions. This module
//   applies the Registry half before the store sees the request; the store
//   applies Canon's half exactly as it does for people. Neither can widen the
//   other, so an agent acts only where both allow.
// - Failing closed. Unknown passport, lapsed certification, revocation, or an
//   unreachable Registry all refuse the request, with the contract's statuses.
//   Staleness is impossible by construction: the RegistryClient's cache is
//   clamped to the sixty-second revocation guarantee and an outage is never
//   cached as an answer.
// - Auditing. Every fresh (uncached) verification is an `agent.session` event;
//   refusals are `agent.auth_failed`; limit denials are `agent.denied`.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CanonError, ErrorCode } from './model.js';
import { AgentVerification, RegistryClient, VerifyFailureReason } from './registry.js';
import type { CanonStore } from './store.js';

/** The Registry's fixed action vocabulary (REGISTRY-CONTRACT.md §4). */
export type AgentAction = 'read' | 'comment' | 'write';

/** One authenticated agent request: identity resolved, limits in hand. */
export interface AgentSession {
  actorId: string; // the Canon actor the passport resolved to
  agentId: string; // the Registry identity, stored as the actor's registryRef
  name: string;
  permittedCollections: string[];
  permittedActions: string[];
  /** True when this request re-asked the Registry rather than using its cache. */
  fresh: boolean;
}

/** What enforcement hands back: the narrowing to apply to the response. */
export interface Enforcement {
  action: AgentAction;
  collectionId: string | null;
  narrow(result: unknown): unknown;
}

export interface AgentAuthOptions {
  db: DatabaseSync;
  store: CanonStore;
  registry: RegistryClient;
}

// ---- route classification ---------------------------------------------
//
// The Registry speaks of collections and three actions; HTTP speaks of paths
// and methods. This table translates, and it is deliberately separate from
// api.ts's route table: an unclassified route is refused to agents rather
// than guessed at, so a route added elsewhere cannot silently widen agent
// access. Fail closed applies to Canon's own surface too.

type Scope =
  | { kind: 'none' } // touches no collection (health, own notifications)
  | { kind: 'collection'; id: string } // collection id in the path
  | { kind: 'page'; id: string } // collection resolved from the page
  | { kind: 'comment'; id: string } // collection resolved from the comment's page
  | { kind: 'bodyCollection' } // collection id in the request body
  | { kind: 'newCollection' } // creates a collection: only '*' can reach it
  | { kind: 'filtered'; filter: 'collections' | 'search' | 'audit' }; // spans collections

interface Rule {
  method: string;
  pattern: RegExp;
  action: AgentAction;
  scope: (groups: string[]) => Scope;
}

const NONE = (): Scope => ({ kind: 'none' });
const PAGE = (groups: string[]): Scope => ({ kind: 'page', id: groups[0] ?? '' });

const RULES: Rule[] = [
  { method: 'GET', pattern: /^\/health$/, action: 'read', scope: NONE },
  { method: 'GET', pattern: /^\/actors$/, action: 'read', scope: NONE },
  { method: 'GET', pattern: /^\/notifications$/, action: 'read', scope: NONE },

  { method: 'GET', pattern: /^\/collections$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'collections' }) },
  { method: 'POST', pattern: /^\/collections$/, action: 'write', scope: () => ({ kind: 'newCollection' }) },
  {
    method: 'GET',
    pattern: /^\/collections\/([^/]+)(?:\/(?:tree|members))?$/,
    action: 'read',
    scope: (g) => ({ kind: 'collection', id: g[0] ?? '' }),
  },
  {
    method: 'PUT',
    pattern: /^\/collections\/([^/]+)\/members\/[^/]+$/,
    action: 'write',
    scope: (g) => ({ kind: 'collection', id: g[0] ?? '' }),
  },
  {
    method: 'DELETE',
    pattern: /^\/collections\/([^/]+)\/members\/[^/]+$/,
    action: 'write',
    scope: (g) => ({ kind: 'collection', id: g[0] ?? '' }),
  },

  { method: 'POST', pattern: /^\/pages$/, action: 'write', scope: () => ({ kind: 'bodyCollection' }) },
  { method: 'GET', pattern: /^\/pages\/([^/]+)(?:\/(?:draft|versions|comments))?$/, action: 'read', scope: PAGE },
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/versions\/[^/]+$/, action: 'read', scope: PAGE },
  { method: 'POST', pattern: /^\/pages\/([^/]+)\/comments$/, action: 'comment', scope: PAGE },
  {
    method: 'POST',
    pattern: /^\/pages\/([^/]+)\/(?:move|archive|publish|submit|approve|send-back|restore)$/,
    action: 'write',
    scope: PAGE,
  },
  { method: 'PUT', pattern: /^\/pages\/([^/]+)\/draft$/, action: 'write', scope: PAGE },
  { method: 'DELETE', pattern: /^\/pages\/([^/]+)\/draft$/, action: 'write', scope: PAGE },

  {
    method: 'POST',
    pattern: /^\/comments\/([^/]+)\/(?:resolve|reopen)$/,
    action: 'comment',
    scope: (g) => ({ kind: 'comment', id: g[0] ?? '' }),
  },

  { method: 'GET', pattern: /^\/search$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'search' }) },
  { method: 'GET', pattern: /^\/audit$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'audit' }) },
];

function classify(method: string, pathname: string): { action: AgentAction; scope: Scope } | null {
  for (const rule of RULES) {
    if (rule.method !== method) continue;
    const match = pathname.match(rule.pattern);
    if (!match) continue;
    const groups = match.slice(1).map((g) => decodeURIComponent(g ?? ''));
    return { action: rule.action, scope: rule.scope(groups) };
  }
  return null;
}

/** `"*"` means every collection; otherwise the id must be listed verbatim. */
export function permitsCollection(permitted: readonly string[], collectionId: string): boolean {
  return permitted.includes('*') || permitted.includes(collectionId);
}

// The contract's error table (§5), in Canon's vocabulary.
const REFUSAL_CODE: Record<VerifyFailureReason, ErrorCode> = {
  unknown_passport: 'unauthenticated', // 401
  certification_lapsed: 'forbidden', // 403
  revoked: 'forbidden', // 403
  registry_unreachable: 'unavailable', // 503, fail closed
};

/**
 * A passport arrived at a Canon that has no Registry configured. Dev mode is
 * `X-Actor-Id` only; passport authentication is unavailable, and says so.
 */
export function passportAuthUnavailable(): CanonError {
  return new CanonError(
    'unavailable',
    'Agent Passport authentication is not configured on this Canon; set CANON_REGISTRY_URL to enable it',
    { header: 'X-Agent-Passport', configured: false },
  );
}

// Canon holds no credentials, so a refusal it cannot attribute to an agent is
// recorded against a one-way fingerprint of the presented passport — enough to
// correlate repeated attempts, never enough to replay one.
function fingerprint(passport: string): string {
  return `passport:${createHash('sha256').update(passport).digest('hex').slice(0, 16)}`;
}

export class AgentAuth {
  private readonly db: DatabaseSync;
  private readonly store: CanonStore;
  readonly registry: RegistryClient;

  constructor(options: AgentAuthOptions) {
    this.db = options.db;
    this.store = options.store;
    this.registry = options.registry;
  }

  /**
   * Verify a passport with the Registry and resolve it to a Canon actor.
   * Throws a CanonError on every refusal — there is no failure mode that
   * grants access. `actorHeader` is the `X-Actor-Id` value, if any: the
   * passport wins, and a header naming anyone else is rejected outright,
   * because a request carries a person's identity or an agent's passport.
   */
  async authenticate(passport: string, actorHeader = ''): Promise<AgentSession> {
    const result = await this.registry.verifyPassport(passport);
    if (!result.ok) {
      this.audit(fingerprint(passport), 'agent', 'agent.auth_failed', {
        details: { reason: result.reason, message: result.message },
      });
      throw new CanonError(REFUSAL_CODE[result.reason], result.message, { reason: result.reason });
    }

    const actorId = this.actorForAgent(result.agent);
    const session: AgentSession = {
      actorId,
      agentId: result.agent.agentId,
      name: result.agent.name,
      permittedCollections: result.agent.permittedCollections,
      permittedActions: result.agent.permittedActions,
      fresh: !result.cached,
    };

    if (actorHeader && actorHeader !== actorId) {
      this.audit(actorId, 'agent', 'agent.auth_failed', {
        details: { reason: 'identity_mismatch', presented: actorHeader },
      });
      throw new CanonError(
        'forbidden',
        'A request carries a person’s X-Actor-Id or an agent’s X-Agent-Passport, never both',
        { reason: 'identity_mismatch' },
      );
    }

    // "At the start of every agent session" (REGISTRY-CONTRACT.md §3): a
    // verification that actually reached the Registry is a session start;
    // requests riding the sub-minute cache are that same session continuing.
    if (session.fresh) {
      this.audit(actorId, 'agent', 'agent.session', {
        details: {
          registryRef: session.agentId,
          name: session.name,
          permittedCollections: session.permittedCollections,
          permittedActions: session.permittedActions,
          checkedAt: result.checkedAt,
        },
      });
    }
    return session;
  }

  /**
   * Apply the Registry's half of the intersection to the request in hand,
   * before the store sees it. Canon's own collection permissions are applied
   * by the store as usual; whichever side denies, the request is refused.
   * Returns the narrowing for responses that span collections.
   */
  enforce(session: AgentSession, req: { method: string; pathname: string; body?: unknown }): Enforcement {
    const classified = classify(req.method, req.pathname);
    if (!classified) {
      this.deny(session, 'route', { method: req.method, path: req.pathname });
      throw new CanonError('forbidden', `This route is not available to agents: ${req.method} ${req.pathname}`, {
        reason: 'route_not_available_to_agents',
      });
    }
    const { action, scope } = classified;

    // Unknown actions in the Registry's answer are ignored rather than
    // guessed at (REGISTRY-CONTRACT.md §7): membership of our fixed
    // vocabulary is the only thing that grants anything.
    if (!session.permittedActions.includes(action)) {
      this.deny(session, 'action', { action });
      throw new CanonError('forbidden', `The Registry does not permit this agent to ${action}`, {
        reason: 'action_not_permitted',
        action,
        permittedActions: session.permittedActions,
      });
    }

    const collectionId = this.collectionFor(scope, req.body);
    if (scope.kind === 'newCollection' && !session.permittedCollections.includes('*')) {
      this.deny(session, 'collection', { action, newCollection: true });
      throw new CanonError('forbidden', 'The Registry permits this agent only in named collections, so it cannot create one', {
        reason: 'collection_not_permitted',
        permittedCollections: session.permittedCollections,
      });
    }
    if (collectionId && !permitsCollection(session.permittedCollections, collectionId)) {
      this.deny(session, 'collection', { action, collectionId });
      throw new CanonError('forbidden', 'The Registry does not permit this agent in this collection', {
        reason: 'collection_not_permitted',
        collectionId,
        permittedCollections: session.permittedCollections,
      });
    }

    const filter = scope.kind === 'filtered' ? scope.filter : null;
    return {
      action,
      collectionId,
      narrow: (result: unknown) => (filter ? this.narrow(session, filter, result) : result),
    };
  }

  // ---- internals -------------------------------------------------------

  // Resolve the collection a request touches, where it touches exactly one.
  // A target that does not exist resolves to null: the handler answers with
  // Canon's own not_found rather than this layer inventing one.
  private collectionFor(scope: Scope, body: unknown): string | null {
    switch (scope.kind) {
      case 'collection':
        return scope.id || null;
      case 'page':
        return this.collectionOfPage(scope.id);
      case 'comment':
        return this.collectionOfComment(scope.id);
      case 'bodyCollection': {
        const value = (body as { collectionId?: unknown } | undefined)?.collectionId;
        return typeof value === 'string' && value ? value : null;
      }
      default:
        return null;
    }
  }

  private collectionOfPage(pageId: string): string | null {
    const row = this.db.prepare('SELECT collection_id FROM pages WHERE id = ?').get(pageId) as
      | { collection_id: string }
      | undefined;
    return row?.collection_id ?? null;
  }

  private collectionOfComment(commentId: string): string | null {
    const row = this.db
      .prepare('SELECT p.collection_id FROM comments c JOIN pages p ON p.id = c.page_id WHERE c.id = ?')
      .get(commentId) as { collection_id: string } | undefined;
    return row?.collection_id ?? null;
  }

  // Responses that span collections are narrowed to the permitted ones, so a
  // listing, a search, or the audit log never carries an agent something the
  // Registry does not permit it to see.
  private narrow(session: AgentSession, filter: 'collections' | 'search' | 'audit', result: unknown): unknown {
    if (!Array.isArray(result)) return result;
    if (filter === 'collections') {
      return result.filter((c) => permitsCollection(session.permittedCollections, (c as { id: string }).id));
    }
    if (filter === 'search') {
      return result.filter((r) => permitsCollection(session.permittedCollections, (r as { collectionId: string }).collectionId));
    }
    // Audit events that name no collection (sessions, refusals) are not
    // collection-scoped and stay; the rest are narrowed like everything else.
    return result.filter((e) => {
      const collectionId = (e as { collectionId: string | null }).collectionId;
      return collectionId === null || permitsCollection(session.permittedCollections, collectionId);
    });
  }

  // The Registry owns agent identity; Canon holds a reference to it. First
  // sight creates the actor, later sightings reuse it, and the name follows
  // the Registry so attribution stays true.
  private actorForAgent(agent: AgentVerification): string {
    const row = this.db
      .prepare("SELECT id, name FROM actors WHERE registry_ref = ? AND kind = 'agent'")
      .get(agent.agentId) as { id: string; name: string } | undefined;
    if (row) {
      if (row.name !== agent.name) {
        this.db.prepare('UPDATE actors SET name = ? WHERE id = ?').run(agent.name, row.id);
      }
      return row.id;
    }
    return this.store.createActor({ kind: 'agent', name: agent.name, registryRef: agent.agentId }).id;
  }

  private deny(session: AgentSession, reason: 'route' | 'action' | 'collection', details: Record<string, unknown>): void {
    this.audit(session.actorId, 'agent', 'agent.denied', {
      collectionId: typeof details.collectionId === 'string' ? details.collectionId : undefined,
      details: { reason, registryRef: session.agentId, ...details },
    });
  }

  // Audit rows are written here directly, as comments.ts does: the audit log
  // is append-only storage, and these events belong to authentication rather
  // than to any store operation.
  private audit(
    actorId: string,
    actorKind: 'agent',
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        actorId,
        actorKind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}

/**
 * Canon runs with no Registry by default: dev mode, `X-Actor-Id` only. Set
 * `CANON_REGISTRY_URL` and passport authentication is live — the one switch,
 * and the one base URL that changes when the live Registry replaces the stub.
 *
 * `CANON_REGISTRY_TTL_MS` (default 30s, clamped to the sixty-second
 * revocation guarantee; 0 re-verifies on every request) and
 * `CANON_REGISTRY_TIMEOUT_MS` (default 3s) tune the client.
 */
export function agentAuthFromEnv(
  db: DatabaseSync,
  store: CanonStore,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth | null {
  const baseUrl = env.CANON_REGISTRY_URL?.trim();
  if (!baseUrl) return null;
  const ttl = Number(env.CANON_REGISTRY_TTL_MS ?? '');
  const timeout = Number(env.CANON_REGISTRY_TIMEOUT_MS ?? '');
  return new AgentAuth({
    db,
    store,
    registry: new RegistryClient({
      baseUrl,
      cacheTtlMs: Number.isFinite(ttl) && env.CANON_REGISTRY_TTL_MS ? ttl : undefined,
      requestTimeoutMs: Number.isFinite(timeout) && env.CANON_REGISTRY_TIMEOUT_MS ? timeout : undefined,
    }),
  });
}
