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
// - Enforcing the Registry's `permittedCollections`, `permittedSources`, and
//   `permittedActions` as an INTERSECTION with Canon's own collection
//   permissions. This module applies the Registry half before the store sees
//   the request; the store applies Canon's half exactly as it does for people.
//   Neither can widen the other, so an agent acts only where both allow.
// - Governing federated sources on exactly those terms. A source is a governed
//   object (DATA-BACKBONE.md §6): if agents reached external systems directly,
//   the Registry's limits would stop at Canon's door and an agent barred from a
//   collection could read the same facts through the source behind it. Whole
//   requests about a source are settled in `enforce`; individual references on
//   a readable page are settled by `refuseUnpermittedSource`, which the
//   reference layer calls per reference (see "the reference layer's one call").
// - Failing closed. Unknown passport, lapsed certification, revocation, or an
//   unreachable Registry all refuse the request, with the contract's statuses.
//   Staleness is impossible by construction: the RegistryClient's cache is
//   clamped to the sixty-second revocation guarantee and an outage is never
//   cached as an answer.
// - Auditing. Every fresh (uncached) verification is an `agent.session` event;
//   refusals are `agent.auth_failed`; limit denials are `agent.denied`.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { narrowRecordGraph, type RecordGraph } from './graph.js';
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
  /** Source ids this agent may resolve references from; `"*"` for all, `[]` for none. */
  permittedSources: string[];
  permittedActions: string[];
  /** True when this request re-asked the Registry rather than using its cache. */
  fresh: boolean;
  /**
   * May this agent resolve a reference from this source? The Registry's half
   * of the intersection only — the page's own readability is Canon's half and
   * is decided by the store, as it is for people.
   */
  permitsSource(sourceId: string): boolean;
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
  | { kind: 'reference'; id: string } // collection resolved from the reference's page
  | { kind: 'bodyCollection' } // collection id in the request body
  | { kind: 'newCollection' } // creates a collection: only '*' can reach it
  | { kind: 'source'; id: string } // source id in the path
  | { kind: 'sourceAdmin' } // registers or changes a source: only '*' can reach it
  | { kind: 'divergence'; id: string } // collection resolved from the divergence's page
  | { kind: 'filtered'; filter: FilteredScope }; // spans collections or sources

/** What a spanning response is narrowed by, and how (see `narrow` below). */
type FilteredScope = 'collections' | 'search' | 'audit' | 'sources' | 'graph' | 'divergences';

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
    // `health` joins tree and members here rather than getting a rule of its
    // own: the record health of a collection is a read of that collection, and
    // the collection in the path is the thing to check it against.
    pattern: /^\/collections\/([^/]+)(?:\/(?:tree|members|health))?$/,
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

  // Grounded answers. REGISTRY-CONTRACT.md §4 puts these under `read`
  // explicitly — "read covers viewing pages, trees, versions, and grounded
  // answers". An ask that names a collection is checked against it like any
  // other; an ask that names none needs no collection check, because the
  // answer path already filters candidates by the asker's own permissions, so
  // an agent can never be told something its collections do not hold.
  { method: 'POST', pattern: /^\/ask$/, action: 'read', scope: () => ({ kind: 'bodyCollection' }) },
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/related$/, action: 'read', scope: PAGE },

  // Federation (DATA-BACKBONE.md §6; REGISTRY-CONTRACT.md §4). The reference
  // layer itself — sources.ts, connectors.ts, references.ts — is another
  // stream's work; these rules are written ahead of it deliberately, because
  // an unclassified route is refused to agents and a federation surface that
  // arrived unclassified would be silently closed to every agent rather than
  // silently open. Classifying now means the merge changes behaviour once,
  // visibly, in the direction the contract states.
  //
  // Resolving a page's references is `read`, scoped to the page's collection:
  // the page's readability is the collection question, and each individual
  // reference is then filtered by `permittedSources` inside the handler (see
  // refuseUnpermittedSource). A page whose references the agent may not
  // resolve is still readable; the references come back refused in place.
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/references$/, action: 'read', scope: PAGE },

  // Authoring a reference on a page is `write` on that page's collection, and
  // needs no `"*"`: a reference belongs to exactly one page, so the collection
  // that governs the page governs it. (Registering the *source* it points at
  // is the other case entirely — see below.) Removing one is the same act
  // reversed, but the path names the reference rather than the page, so the
  // collection is resolved through the reference's page.
  { method: 'POST', pattern: /^\/pages\/([^/]+)\/references$/, action: 'write', scope: PAGE },
  {
    method: 'DELETE',
    pattern: /^\/references\/([^/]+)$/,
    action: 'write',
    scope: (g) => ({ kind: 'reference', id: g[0] ?? '' }),
  },

  // Divergence (DATA-BACKBONE.md §7). READING one is `read`, scoped to the
  // page's collection: a divergence says that two of the systems behind a page
  // disagree, which is a fact about that page and readable by whoever may read
  // the page. Nothing about it is a separate permission — an agent that may
  // resolve a page's references can already see both values, so hiding the
  // observation that they differ would protect nothing and would leave an
  // agent composing an answer from two numbers it had no way to know conflict.
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/divergences$/, action: 'read', scope: PAGE },
  {
    method: 'GET',
    pattern: /^\/divergences\/([^/]+)$/,
    action: 'read',
    scope: (g) => ({ kind: 'divergence', id: g[0] ?? '' }),
  },
  // The record-wide listing SPANS collections by design — "where do my systems
  // disagree" is a question about the whole record — so it takes §4.2's rule
  // for a spanning request: narrowed to the agent's permitted collections,
  // never refused because the record holds a collection the agent may not see.
  // A divergence carries a `pageId` rather than a `collectionId` (§7's shape is
  // exactly that and is not padded to suit this layer), so the narrowing
  // resolves the page's collection; hence its own filter rather than reusing
  // `search`.
  { method: 'GET', pattern: /^\/divergences$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'divergences' }) },

  // CLOSING ONE IS DELIBERATELY ABSENT, on exactly the precedent
  // POST /proposals/:id/accept and /reject set above, and this comment is the
  // rule rather than an omission to be tidied up later.
  //
  // §7 is explicit that a divergence "is closed by a person, with a reason",
  // and that closing it "is a decision the record keeps, not a flag that
  // silently clears". The reasons it names — the copy was wrong and has been
  // corrected upstream, the definitions differ and here is why, this source
  // should not have been corroborating this field — are all claims about
  // external systems that Canon cannot verify and that somebody has to be
  // accountable for. The Registry's vocabulary is `read`, `comment` and
  // `write` (REGISTRY-CONTRACT.md §4), and none of them means "may settle a
  // contradiction"; granting it would mean stretching `write` to cover
  // something no passport ever meant to grant, which is the same argument that
  // keeps the freshness sweep out of this table.
  //
  // So POST /divergences/:id/close is in no rule here: an agent's request for
  // it is refused by `classify` returning null — 403,
  // `route_not_available_to_agents`, audited as `agent.denied`. divergence.ts
  // refuses an actor of kind `agent` a second time, which is the check that
  // also holds in dev mode where no passport is presented at all. An agent
  // that knows why the systems differ has the path FEATURES.md §5 gives it:
  // raise a proposal, and a person settles it.

  // Reading the source register is `read`, and the listing is narrowed to the
  // agent's permitted sources rather than refused — the same treatment
  // collection listings and searches get (REGISTRY-CONTRACT.md §4.2).
  { method: 'GET', pattern: /^\/sources$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'sources' }) },
  { method: 'GET', pattern: /^\/sources\/([^/]+)$/, action: 'read', scope: (g) => ({ kind: 'source', id: g[0] ?? '' }) },

  // Structured queries (FEATURES.md §6) are `read`. Running one spans
  // collections, so its result is narrowed exactly as a search result is —
  // `filter: 'search'` is reused deliberately rather than copied: the narrowing
  // is "keep the rows whose `collectionId` the Registry permits", and a query
  // result row carries `collectionId` for the same reason a search hit does.
  // Reusing it means the day that rule changes, it changes once.
  { method: 'POST', pattern: /^\/queries\/run$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'search' }) },
  // A saved query is a stored filter belonging to the actor who saved it, not a
  // piece of the record: it names no collection, holds no page content, and is
  // only ever readable by its owner. So these are `read` with no collection to
  // check — the same treatment `GET /notifications` gets, and for the same
  // reason. Note that `GET /queries/:id` deliberately returns the DEFINITION and
  // no results: results would span collections inside an object, where the
  // narrowing above cannot reach them. Results come from POST /queries/run.
  { method: 'POST', pattern: /^\/queries$/, action: 'read', scope: NONE },
  { method: 'GET', pattern: /^\/queries$/, action: 'read', scope: NONE },
  { method: 'GET', pattern: /^\/queries\/([^/]+)$/, action: 'read', scope: NONE },
  { method: 'DELETE', pattern: /^\/queries\/([^/]+)$/, action: 'read', scope: NONE },

  // The freshness sweep is NOT classified, and that is the decision, not an
  // omission. An unclassified route is refused to agents (see `classify` and
  // `enforce` below), so `POST /maintenance/freshness` is closed to every agent
  // however wide its passport. FEATURES.md §5 draws the line in these words:
  // agents "help keep the record true … nudging owners when review dates near.
  // People stay the approvers; agents do the tedious watching." The sweep is not
  // watching — it changes the status of pages across every collection at once
  // and mails their owners, which is an operator's act with the blast radius of
  // one call. The Registry's vocabulary cannot express "may run maintenance"
  // (REGISTRY-CONTRACT.md §4 has read, comment, write and nothing else), so
  // granting it would mean stretching `write` to cover something no passport
  // ever meant to grant. Default no; if a deployment wants an unattended sweep,
  // it runs the built-in timer under a named maintenance actor (index.ts), which
  // is attributable and configured once rather than delegated per agent.

  // Registering, changing, or removing a source is `write` AND requires `"*"`,
  // exactly as creating a collection does, and for the same reason: a source
  // is not scoped to one collection, so there is no collection to check it
  // against. Being permitted to read *through* a source is not being permitted
  // to *redefine* it — an agent that could retarget an external system would
  // be writing its own limits.
  { method: 'POST', pattern: /^\/sources$/, action: 'write', scope: () => ({ kind: 'sourceAdmin' }) },
  { method: 'PUT', pattern: /^\/sources\/([^/]+)$/, action: 'write', scope: () => ({ kind: 'sourceAdmin' }) },
  { method: 'DELETE', pattern: /^\/sources\/([^/]+)$/, action: 'write', scope: () => ({ kind: 'sourceAdmin' }) },

  // Agent proposals (FEATURES.md §5; proposals.ts). Proposing a change is
  // `write`, scoped to the page's collection, exactly as authoring a reference
  // on a page is: a proposal belongs to one page, so the collection that
  // governs the page governs it, and no `"*"` is involved. Reading the open
  // proposals on a page is `read` on the same collection.
  //
  // Note what proposing is NOT: it is not publishing. `write` plus Canon's
  // `edit` role lets an agent offer a change; nothing about it puts words into
  // the record. That is what makes it safe to give an agent `write` on
  // material it may not publish, which is the whole point of the feature.
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/proposals$/, action: 'read', scope: PAGE },
  { method: 'POST', pattern: /^\/pages\/([^/]+)\/proposals$/, action: 'write', scope: PAGE },

  // ACCEPTING AND REJECTING ARE DELIBERATELY ABSENT, and this comment is the
  // rule rather than an omission to be tidied up later. FEATURES.md §5 says
  // "People stay the approvers; agents do the tedious watching", and Canon
  // keeps that literally: POST /proposals/:id/accept and .../reject are in no
  // rule above, so an agent's request for either is refused by `classify`
  // returning null — 403, `route_not_available_to_agents`, audited as
  // `agent.denied`. There is no `permittedActions` value that opens them,
  // because the Registry's vocabulary is about what an agent may do to the
  // record and this is a question about who takes responsibility for it.
  // proposals.ts refuses an actor of kind `agent` a second time, which is the
  // check that also holds in dev mode, where no passport is presented at all.
  // If a future tier ever wants a certified agent to accept another agent's
  // proposal, it takes a deliberate change here AND there, plus a paragraph in
  // FEATURES.md — never a quiet route addition.

  // Page relations (DATA-BACKBONE.md §7; relations.ts). READING them is
  // `read`, scoped to the page's collection, exactly as reading its proposals
  // or its references is: "this page conflicts with that one" is a fact of the
  // record, and an agent that may read the page should be able to see it —
  // indeed noticing it is the thing agents are for. Each relation is then
  // filtered by whether the asker may see its OTHER end, inside the handler,
  // by the same collection-membership join the map uses.
  { method: 'GET', pattern: /^\/pages\/([^/]+)\/relations$/, action: 'read', scope: PAGE },

  // ASSERTING AND REMOVING ONE ARE DELIBERATELY ABSENT, on the same terms as
  // accepting a proposal. §7 asks for a relation "asserted by a person or
  // proposed by an agent and accepted by one", and Canon keeps that literally:
  // POST /pages/:id/relations and DELETE /relations/:id are in no rule above,
  // so an agent's request for either is refused by `classify` returning null —
  // 403, `route_not_available_to_agents`, audited as `agent.denied`. There is
  // no `permittedActions` value that opens them: `write` is about changing what
  // the record SAYS, and asserting that two Canonical policies contradict each
  // other is a judgement about the record that a person takes responsibility
  // for. The agent's path is the one that already exists and needs nothing
  // here — it raises a PROPOSAL carrying its reasoning (POST
  // /pages/:id/proposals, classified above), and a person settles it by making
  // the assertion. relations.ts refuses an actor of kind `agent` a second
  // time, which is the check that also holds in dev mode.

  // Veryl Studio's Knowledge API (STUDIO-CONTRACT.md). A Studio app is an
  // agent and reaches Canon through this same door: its passport is verified
  // by the Registry, and the Registry's limits are applied here, before the
  // handler, exactly as for any other agent. There is no second credential
  // model and no second limits vocabulary — `read`, `comment` and `write`
  // mean on `/knowledge/...` what they mean everywhere else.
  //
  // What the Knowledge API adds — the person the app is acting for, and the
  // third gate that follows — is settled inside the handler, in knowledge.ts,
  // because it is a Canon permission question rather than a Registry one.
  { method: 'GET', pattern: /^\/knowledge\/whoami$/, action: 'read', scope: NONE },
  {
    method: 'GET',
    pattern: /^\/knowledge\/collections$/,
    action: 'read',
    scope: () => ({ kind: 'filtered', filter: 'collections' }),
  },
  {
    method: 'GET',
    pattern: /^\/knowledge\/collections\/([^/]+)(?:\/tree)?$/,
    action: 'read',
    scope: (g) => ({ kind: 'collection', id: g[0] ?? '' }),
  },
  { method: 'GET', pattern: /^\/knowledge\/pages\/([^/]+)$/, action: 'read', scope: PAGE },
  { method: 'GET', pattern: /^\/knowledge\/pages\/([^/]+)\/versions$/, action: 'read', scope: PAGE },
  { method: 'GET', pattern: /^\/knowledge\/pages\/([^/]+)\/versions\/[^/]+$/, action: 'read', scope: PAGE },
  { method: 'GET', pattern: /^\/knowledge\/search$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'search' }) },
  { method: 'POST', pattern: /^\/knowledge\/ask$/, action: 'read', scope: () => ({ kind: 'bodyCollection' }) },

  // The write surface. `write` on the app's side, and — settled in the
  // handler — `edit` on both Canon sides, so an app cannot write where the
  // person it acts for could not. Approval is deliberately absent: the
  // Canonical mark is granted by a person in Canon, never through an app.
  { method: 'POST', pattern: /^\/knowledge\/pages$/, action: 'write', scope: () => ({ kind: 'bodyCollection' }) },
  { method: 'PUT', pattern: /^\/knowledge\/pages\/([^/]+)\/draft$/, action: 'write', scope: PAGE },
  { method: 'POST', pattern: /^\/knowledge\/pages\/([^/]+)\/(?:publish|submit)$/, action: 'write', scope: PAGE },
  { method: 'POST', pattern: /^\/knowledge\/pages\/([^/]+)\/comments$/, action: 'comment', scope: PAGE },

  // The knowledge map (GET /collections/:id/graph). `read`, scoped to the
  // collection in the path: a map is a read of that collection's tree, its
  // links, and the sources its pages reference, and REGISTRY-CONTRACT.md §4
  // puts "viewing pages, trees, versions" under `read`. It gets a rule of its
  // own rather than joining the `tree|members|health` alternation above so this
  // classification is additive — but the effect is the same one that
  // alternation has, and the day they merge, nothing changes.
  //
  // No narrowing is needed on the way out. The map's nodes are selected with
  // the asking actor's own membership join, and the Registry's collection limit
  // is checked here against the one collection the map is of, so an agent
  // barred from it never reaches the handler at all.
  {
    method: 'GET',
    pattern: /^\/collections\/([^/]+)\/graph$/,
    action: 'read',
    scope: (g) => ({ kind: 'collection', id: g[0] ?? '' }),
  },

  // The whole-record map (GET /graph). `read` like the map above, but this one
  // SPANS collections by design — a page in Compliance linking a page in
  // Product is the thing it exists to show — so it takes §4.2's rule for a
  // spanning request: narrowed to the agent's permitted collections, never
  // refused because the record holds a collection the agent may not see. The
  // narrowing is a payload of objects rather than a list of rows, so it is
  // `narrowRecordGraph` in graph.ts that performs it; what belongs here is the
  // classification, and this is it.
  { method: 'GET', pattern: /^\/graph$/, action: 'read', scope: () => ({ kind: 'filtered', filter: 'graph' }) },
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

/**
 * `"*"` means every source; otherwise the id must be listed verbatim, and an
 * empty list means none. Identical to permitsCollection by design rather than
 * by accident: the contract governs a source exactly as it governs a
 * collection, and the day the two rules diverge it should be because someone
 * changed this function on purpose.
 */
export function permitsSource(permitted: readonly string[], sourceId: string): boolean {
  return permitted.includes('*') || permitted.includes(sourceId);
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
    const permittedSources = result.agent.permittedSources;
    const session: AgentSession = {
      actorId,
      agentId: result.agent.agentId,
      name: result.agent.name,
      permittedCollections: result.agent.permittedCollections,
      permittedSources,
      permittedActions: result.agent.permittedActions,
      fresh: !result.cached,
      permitsSource: (sourceId: string) => permitsSource(permittedSources, sourceId),
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
          permittedSources: session.permittedSources,
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
  enforce(
    session: AgentSession,
    req: {
      method: string;
      pathname: string;
      body?: unknown;
      /**
       * The person a Veryl Studio app is acting for, from `X-On-Behalf-Of`
       * (STUDIO-CONTRACT.md §3). It plays no part in this gate — the
       * Registry's limits are about the app alone — but a refusal here is
       * still a refusal of a call made for someone, and the audit log has to
       * be able to say who. Absent for every other agent request.
       */
      onBehalfOf?: string;
    },
  ): Enforcement {
    const onBehalfOf = req.onBehalfOf?.trim() || undefined;
    const classified = classify(req.method, req.pathname);
    if (!classified) {
      this.deny(session, 'route', { method: req.method, path: req.pathname, onBehalfOf });
      throw new CanonError('forbidden', `This route is not available to agents: ${req.method} ${req.pathname}`, {
        reason: 'route_not_available_to_agents',
      });
    }
    const { action, scope } = classified;

    // Unknown actions in the Registry's answer are ignored rather than
    // guessed at (REGISTRY-CONTRACT.md §7): membership of our fixed
    // vocabulary is the only thing that grants anything.
    if (!session.permittedActions.includes(action)) {
      this.deny(session, 'action', { action, onBehalfOf });
      throw new CanonError('forbidden', `The Registry does not permit this agent to ${action}`, {
        reason: 'action_not_permitted',
        action,
        permittedActions: session.permittedActions,
      });
    }

    const collectionId = this.collectionFor(scope, req.body);
    if (scope.kind === 'newCollection' && !session.permittedCollections.includes('*')) {
      this.deny(session, 'collection', { action, newCollection: true, onBehalfOf });
      throw new CanonError('forbidden', 'The Registry permits this agent only in named collections, so it cannot create one', {
        reason: 'collection_not_permitted',
        permittedCollections: session.permittedCollections,
      });
    }
    if (collectionId && !permitsCollection(session.permittedCollections, collectionId)) {
      this.deny(session, 'collection', { action, collectionId, onBehalfOf });
      throw new CanonError('forbidden', 'The Registry does not permit this agent in this collection', {
        reason: 'collection_not_permitted',
        collectionId,
        permittedCollections: session.permittedCollections,
      });
    }

    // Sources, on exactly the terms collections get. Administration first:
    // redefining a source is not something a named-source grant can cover,
    // because the thing it would redefine is the grant's own subject.
    if (scope.kind === 'sourceAdmin' && !session.permittedSources.includes('*')) {
      this.deny(session, 'source', { action, sourceAdministration: true, onBehalfOf });
      throw new CanonError(
        'forbidden',
        'The Registry permits this agent only named sources, so it cannot register or change one',
        { reason: 'source_administration_not_permitted', permittedSources: session.permittedSources },
      );
    }
    if (scope.kind === 'source' && !permitsSource(session.permittedSources, scope.id)) {
      this.deny(session, 'source', { action, sourceId: scope.id, onBehalfOf });
      throw new CanonError('forbidden', 'The Registry does not permit this agent to reach this source', {
        reason: 'source_not_permitted',
        sourceId: scope.id,
        permittedSources: session.permittedSources,
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
      case 'reference':
        return this.collectionOfReference(scope.id);
      case 'divergence':
        return this.collectionOfDivergence(scope.id);
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

  // The same shape as collectionOfComment: a reference belongs to a page, and
  // the page's collection is what governs it. The table name is quoted because
  // REFERENCES is a reserved word in SQLite — unquoted, this is a syntax error
  // rather than a missing row, which is the sort of thing that only shows up
  // the first time an agent deletes a reference.
  private collectionOfReference(referenceId: string): string | null {
    const row = this.db
      .prepare('SELECT p.collection_id FROM page_references r JOIN pages p ON p.id = r.page_id WHERE r.id = ?')
      .get(referenceId) as { collection_id: string } | undefined;
    return row?.collection_id ?? null;
  }

  // The same shape again, one join further out: a divergence belongs to a
  // page, and the page's collection is what governs reading it.
  private collectionOfDivergence(divergenceId: string): string | null {
    const row = this.db
      .prepare('SELECT p.collection_id FROM divergences d JOIN pages p ON p.id = d.page_id WHERE d.id = ?')
      .get(divergenceId) as { collection_id: string } | undefined;
    return row?.collection_id ?? null;
  }

  // Responses that span collections are narrowed to the permitted ones, so a
  // listing, a search, or the audit log never carries an agent something the
  // Registry does not permit it to see.
  private narrow(session: AgentSession, filter: FilteredScope, result: unknown): unknown {
    // The one spanning response that is not a list of rows. A graph narrowed
    // by dropping rows would keep edges pointing at nodes that are no longer
    // there, so the whole payload is narrowed together, by the module that
    // knows what one is.
    if (filter === 'graph') {
      return result && typeof result === 'object'
        ? narrowRecordGraph(result as RecordGraph, session.permittedCollections)
        : result;
    }
    if (!Array.isArray(result)) return result;
    if (filter === 'collections') {
      return result.filter((c) => permitsCollection(session.permittedCollections, (c as { id: string }).id));
    }
    if (filter === 'sources') {
      return result.filter((s) => permitsSource(session.permittedSources, (s as { id: string }).id));
    }
    if (filter === 'search') {
      return result.filter((r) => permitsCollection(session.permittedCollections, (r as { collectionId: string }).collectionId));
    }
    if (filter === 'divergences') {
      // §7's shape carries `pageId`, not `collectionId`, so the collection is
      // resolved per row rather than read off it. A row whose page has gone is
      // dropped: an unresolvable collection cannot be shown to be permitted,
      // and fail closed is the rule everywhere else in this file.
      return result.filter((d) => {
        const collectionId = this.collectionOfPage((d as { pageId: string }).pageId);
        return collectionId !== null && permitsCollection(session.permittedCollections, collectionId);
      });
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

  /**
   * A reference the Registry will not let this agent resolve, recorded in the
   * `agent.denied` family and naming the source — DATA-BACKBONE §6 asks every
   * resolution to be an audit event naming who asked, which source, and which
   * reference; a refused resolution is that same event with the reason where
   * the value would have been. Public because the reference layer refuses
   * individual references long after `enforce` has let the request through.
   *
   * The details borrow the `reference.resolve` vocabulary rather than inventing
   * a parallel one — same `referenceId`, `sourceId`, `sourceName`, `authMode`,
   * `selector`, `key`, and `origin: 'none'` for a value that came from neither
   * source nor cache — so one audit query can follow a reference across both
   * event families. `fromCache` and `stale` are left out because `origin:
   * 'none'` already answers them; nothing was fetched to be fresh or stale.
   */
  denySource(session: AgentSession, sourceId: string, context: ReferenceContext = {}): void {
    this.deny(session, 'source', {
      sourceId,
      ...(context.referenceId ? { referenceId: context.referenceId } : {}),
      ...(context.pageId ? { pageId: context.pageId } : {}),
      ...(context.sourceName ? { sourceName: context.sourceName } : {}),
      ...(context.authMode ? { authMode: context.authMode } : {}),
      ...(context.selector ? { selector: context.selector } : {}),
      ...(context.key ? { key: context.key } : {}),
      origin: 'none',
      error: 'source_not_permitted',
    });
  }

  private deny(
    session: AgentSession,
    reason: 'route' | 'action' | 'collection' | 'source',
    details: Record<string, unknown>,
  ): void {
    this.audit(session.actorId, 'agent', 'agent.denied', {
      collectionId: typeof details.collectionId === 'string' ? details.collectionId : undefined,
      pageId: typeof details.pageId === 'string' ? details.pageId : undefined,
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

// ---- the reference layer's one call ------------------------------------
//
// `enforce` settles whole requests, before a handler runs. Federated
// references are not whole requests: one page can carry references from
// several sources, its collection may be permitted while some of those
// sources are not, and the contract (REGISTRY-CONTRACT.md §4.2) says the page
// stays readable while each unpermitted reference comes back refused in place.
// So the check has to happen per reference, inside the handler, in code that
// has no reason to know about HTTP headers or passports.
//
// The seam is a request-scoped session. `runInAgentRequestScope` wraps handler
// execution in api.ts; anything called from inside a handler — however deep,
// across as many awaits as it likes, which matters because
// `store.resolveReferences` is async — can ask who is asking without that
// question being threaded through every signature. For a person there is no
// scope, and every function here answers "permitted": people are governed by
// Canon's own permissions alone, which the store applies as it always has.
//
// The reference layer's whole obligation is one call per reference, inside
// resolveReferences' loop, before the connector is asked for anything:
//
//     const refusal = refuseUnpermittedSource(source.id, {
//       referenceId: ref.id, pageId, sourceName: source.name,
//       authMode: source.authMode, selector: ref.selector, key: ref.key,
//     });
//     if (refusal) { results.push({ ...slot, value: null, ...refusal }); continue; }
//
// It returns null when the reference may be resolved and a refusal record when
// it may not, having already written the audit event. The record carries
// `origin: 'none'` and an `error`, so spreading it over the reference's result
// slot produces a well-formed refused reference in the shape the rest of the
// layer already speaks. Spreading rather than dropping is the point: a refused
// reference must never vanish from the payload, because a silently missing
// value reads as "no such value" — the deductible unset, the headcount zero.
//
// Never fail the whole call for a refusal. `resolveReferences` does not throw
// when a source is down, and a source withheld by the Registry is the same
// kind of event with a governance cause instead of a network one.

/** Everything the reference layer knows about the reference being refused. */
export interface ReferenceContext {
  referenceId?: string;
  pageId?: string;
  sourceName?: string;
  authMode?: string;
  selector?: string;
  key?: string;
}

/**
 * What occupies a reference's slot when the Registry withholds its source.
 * Shaped to spread over a resolved-reference result: `origin` and `error` are
 * the fields `reference.resolve` already uses for a value that never arrived.
 */
export interface SourceRefusal {
  error: 'source_not_permitted';
  message: string;
  sourceId: string;
  /** Nothing was fetched — from neither the source nor the cache. */
  origin: 'none';
  /** Which side of the intersection refused. Canon's own half says `canon`. */
  refusedBy: 'registry';
}

interface AgentRequestScope {
  auth: AgentAuth;
  session: AgentSession;
}

const agentRequestScope = new AsyncLocalStorage<AgentRequestScope>();

/**
 * Run a request handler with its agent session in scope. Called by api.ts
 * around handler execution; a person's request passes a null session and runs
 * with no scope at all, which is exactly what "people are unaffected" means.
 */
export function runInAgentRequestScope<T>(auth: AgentAuth | null, session: AgentSession | null, fn: () => T): T {
  if (!auth || !session) return fn();
  return agentRequestScope.run({ auth, session }, fn);
}

/** The agent behind the request in hand, or null when a person is asking. */
export function currentAgentSession(): AgentSession | null {
  return agentRequestScope.getStore()?.session ?? null;
}

/**
 * May the asker resolve a reference from this source? True for people, and
 * for an agent whose `permittedSources` carries the id or `"*"`. Audits
 * nothing — use it for shaping work (skipping a fetch, counting refusals);
 * use `refuseUnpermittedSource` for the refusal itself.
 */
export function permitsSourceForRequest(sourceId: string): boolean {
  const scope = agentRequestScope.getStore();
  return scope ? scope.session.permitsSource(sourceId) : true;
}

/**
 * Null when this source may be resolved for the asker; a refusal record to put
 * in the reference's slot when it may not. Writes the `agent.denied` audit
 * event naming the source as a side effect, so a caller that honours the
 * return value cannot forget to log the refusal.
 */
export function refuseUnpermittedSource(sourceId: string, context: ReferenceContext = {}): SourceRefusal | null {
  const scope = agentRequestScope.getStore();
  if (!scope || scope.session.permitsSource(sourceId)) return null;
  scope.auth.denySource(scope.session, sourceId, context);
  return {
    error: 'source_not_permitted',
    message: 'The Registry does not permit this agent to resolve references from this source',
    sourceId,
    origin: 'none',
    refusedBy: 'registry',
  };
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
