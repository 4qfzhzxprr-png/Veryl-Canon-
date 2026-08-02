// The Knowledge API: Veryl Studio's door into Veryl Canon
// (STUDIO-CONTRACT.md; DATA-BACKBONE.md §7).
//
// A Studio app is an agent. It presents an Agent Passport exactly as any
// other agent does, and everything REGISTRY-CONTRACT.md says about that
// handshake applies here unchanged — this module invents no second credential
// model and holds no credential of its own. What it adds is one thing the
// agent surface does not have: the person the app is acting for.
//
// DATA-BACKBONE.md §9 asked whether Canon should record the person, the app,
// or both. The answer implemented here is BOTH, ALWAYS, because the audit
// question is "who did what, through what". So:
//
//   * `X-On-Behalf-Of` carries a Canon actor id, and it is required on every
//     Knowledge API call. An app with no person behind it has no business on
//     this surface; it can use the agent surface, where it acts for itself.
//   * The effective permission of a call is the INTERSECTION of three things:
//         the app's Registry limits          (agentauth.ts, before the handler)
//       ∩ the person's Canon permissions     (checked here, per call)
//       ∩ the app's own Canon permissions    (the store, as it always does)
//     An app can never lend a person access the person does not have, and a
//     person can never lend the app access the app does not have. Neither can
//     widen the Registry. Every gate narrows; none widens.
//   * Nothing is cached and nothing is remembered. There is no session, no
//     grant, no token minted here. Each call re-verifies the passport (subject
//     to the Registry contract's sixty-second ceiling) and re-reads both
//     actors' permissions from the record, so a permission change or a
//     revocation is effective on the very next call.
//   * Every call is an audit event naming the app, the person, and what was
//     touched — including the calls that were refused.
//
// There is exactly one implementation of permissions, retrieval and answers in
// Canon, and it is not in this file. Reads and writes go through the store's
// existing methods with the APP's actor id, which is what makes an app's work
// attributable to the app; the person's half is asked of the same store, and
// the answer path's `alsoVisibleTo` narrowing is the store's own SQL, applied
// before ranking and before generation.

import type { IncomingHttpHeaders } from 'node:http';
import { permitsCollection, type AgentSession } from './agentauth.js';
import { Actor, CanonError, Role, ROLE_RANK } from './model.js';
import type { CanonStore } from './store.js';

/** The header carrying the Canon actor id of the person the app acts for. */
export const ON_BEHALF_OF_HEADER = 'X-On-Behalf-Of';

/** The prefix every Knowledge API route sits under. */
export const KNOWLEDGE_PREFIX = '/knowledge';

/**
 * The request context a Knowledge handler receives. Structurally the context
 * api.ts hands every handler; declared here so this module never imports the
 * API layer that mounts it.
 */
export interface KnowledgeRequest {
  store: CanonStore;
  /** The app's Canon actor, resolved from its passport by agentauth.ts. */
  actorId: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  agent: AgentSession | null;
  headers: IncomingHttpHeaders;
}

export type KnowledgeHandler = (ctx: KnowledgeRequest) => unknown;

export interface KnowledgeRouteSpec {
  method: string;
  path: string;
  handler: KnowledgeHandler;
}

/** App and person, both resolved, for one call. Neither outlives the call. */
export interface Attribution {
  app: AgentSession;
  person: Actor;
}

/** A resolved call: the context, plus the two actors it is attributed to. */
interface KnowledgeCall extends KnowledgeRequest, Attribution {}

/** What a handler returns: the payload, and what the audit event should name. */
interface Outcome {
  result: unknown;
  collectionId?: string | null;
  pageId?: string | null;
  details?: Record<string, unknown>;
}

// ---- attribution --------------------------------------------------------

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the two actors behind a Knowledge API call, or refuse it.
 *
 * Both halves are required and neither is inferred. An app that presents no
 * passport is not an app as far as this surface is concerned; a call that
 * names no person is not an app acting for someone, and "both, always" has no
 * meaning if one of the two may be omitted at the caller's discretion.
 */
function attribute(ctx: KnowledgeRequest): Attribution {
  const app = ctx.agent;
  if (!app) {
    throw new CanonError(
      'unauthenticated',
      'The Knowledge API is for Veryl Studio apps: present an Agent Passport in X-Agent-Passport',
      { reason: 'app_passport_required', header: 'X-Agent-Passport' },
    );
  }
  const personId = headerValue(ctx.headers, ON_BEHALF_OF_HEADER);
  if (!personId) {
    throw new CanonError(
      'unauthenticated',
      `Every Knowledge API call names the person it is made for: set ${ON_BEHALF_OF_HEADER} to a Canon actor id`,
      { reason: 'on_behalf_of_required', header: ON_BEHALF_OF_HEADER },
    );
  }
  let person: Actor;
  try {
    person = ctx.store.getActor(personId);
  } catch {
    // Fail closed, and say so as a refusal rather than as a lookup failure:
    // an app naming an actor Canon has never heard of is refused, not served.
    throw new CanonError('forbidden', 'No such actor in Canon, so the app may not act for them', {
      reason: 'on_behalf_of_unknown',
      onBehalfOf: personId,
    });
  }
  if (person.kind !== 'person') {
    throw new CanonError('forbidden', 'An app acts on behalf of a person, never on behalf of another agent', {
      reason: 'on_behalf_of_not_a_person',
      onBehalfOf: personId,
      kind: person.kind,
    });
  }
  return { app, person };
}

// ---- the intersection ---------------------------------------------------

/**
 * The person's half. `requireRoleFor` is the store's own `requireRole`, made
 * public for exactly this: the Knowledge API has to ask "may this person do
 * this here?" without doing it, and a second copy of that question would be a
 * second permission system.
 *
 * A refusal is re-thrown as a *person* refusal, so the operator of an app can
 * tell "my app is not permitted here" from "the person it is acting for is
 * not permitted here" — which are different problems with different fixes.
 */
function requirePerson(call: KnowledgeCall, collectionId: string, needed: Role): void {
  try {
    call.store.requireRoleFor(call.person.id, collectionId, needed);
  } catch (err) {
    if (err instanceof CanonError && err.code === 'forbidden') {
      throw new CanonError(
        'forbidden',
        `${call.person.name} does not hold ${needed} access to this collection, ` +
          'so the app may not exercise it on their behalf',
        {
          ...err.details,
          reason: 'person_not_permitted',
          refusedBy: 'person',
          onBehalfOf: call.person.id,
          needed,
          collectionId,
        },
      );
    }
    throw err;
  }
}

/**
 * The app's half, asked directly rather than as a side effect of a store call.
 *
 * Almost everywhere on this surface the app's gate needs no code at all: the
 * store call is made with the app's actor id, so Canon's own permission model
 * decides it and `asApp` only has to label the refusal. `ask` is the exception,
 * and USER-TESTING.md T3.7 is the report of what that exception cost. A
 * grounded answer does not *refuse* when the asker cannot see a collection —
 * it narrows the candidate set, which is exactly right for an open question
 * and exactly wrong for a question that named one collection and got back a
 * response indistinguishable from "the record is silent". So when the caller
 * names the collection, the app's role in it is asked as a question of its own,
 * in the same words the person's gate is asked, and refused in the same shape.
 *
 * It cannot widen anything: `requireRoleFor` is the store's own `requireRole`,
 * and a call that passes it still meets every narrowing it met before.
 */
function requireApp(call: KnowledgeCall, collectionId: string, needed: Role): void {
  try {
    call.store.requireRoleFor(call.app.actorId, collectionId, needed);
  } catch (err) {
    if (err instanceof CanonError && err.code === 'forbidden') {
      throw new CanonError(
        'forbidden',
        `${call.app.name} does not hold ${needed} access to this collection, ` +
          'so it cannot answer from it for anyone',
        {
          ...err.details,
          reason: 'app_not_permitted',
          refusedBy: 'app',
          app: call.app.agentId,
          needed,
          collectionId,
        },
      );
    }
    throw err;
  }
}

/**
 * The app's half where it IS the store call itself — made with the app's actor
 * id, so Canon's own permission model decides it exactly as it does for
 * anyone. The wrapper only labels the refusal, so the two halves are told
 * apart in the response and in the log.
 */
async function asApp<T>(call: KnowledgeCall, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CanonError && err.code === 'forbidden' && err.details.refusedBy === undefined) {
      throw new CanonError('forbidden', err.message, {
        ...err.details,
        reason: 'app_not_permitted',
        refusedBy: 'app',
        app: call.app.agentId,
      });
    }
    throw err;
  }
}

/**
 * The Registry's collection limit as an allow-list retrieval and search can be
 * bounded by, or `undefined` for `"*"` (no narrowing needed). agentauth checks
 * a request that names one collection; a question that names none must still
 * not be answered from a collection the Registry withheld, and this is what
 * carries that bound into the candidate SQL rather than filtering after
 * generation — which cannot un-leak what the text already merged
 * (DATA-BACKBONE.md §5).
 */
function registryScope(app: AgentSession): string[] | undefined {
  return app.permittedCollections.includes('*') ? undefined : [...app.permittedCollections];
}

/** The lower of two roles: the effective role of an (app, person) pair. */
function narrower(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/** One collection the (app, person) pair may read, and at what role. */
interface EffectiveCollection {
  id: string;
  name: string;
  appRole: Role;
  personRole: Role;
  role: Role;
}

/**
 * The intersection as it stands for this call: the collections the Registry
 * permits, the app is a member of, and the person is a member of, with the
 * narrower of the two roles. It is `whoami`'s whole answer, and it is also what
 * `ask` consults when it has refused — one function, so the two can never
 * disagree about what "this pair can read nothing" means.
 *
 * Everything here is the caller's own standing and nothing here is the
 * record's contents: it names collections both actors already hold a role in,
 * which is why `whoami` may hand it back in full without disclosing anything.
 */
function effectiveCollections(call: KnowledgeCall): EffectiveCollection[] {
  return call.store
    .listCollections(call.app.actorId)
    .filter((c) => permitsCollection(call.app.permittedCollections, c.id))
    .flatMap((c) => {
      const appRole = call.store.roleOf(call.app.actorId, c.id);
      const personRole = call.store.roleOf(call.person.id, c.id);
      if (!appRole || !personRole) return [];
      return [{ id: c.id, name: c.name, appRole, personRole, role: narrower(appRole, personRole) }];
    });
}

/**
 * A page's collection, established through the PERSON — which is both the
 * lookup and the person's view check in one call, in the store's own code.
 * A page that does not exist is a not_found from the store, untouched; a page
 * the person may not see is a person refusal.
 */
function pageCollectionForPerson(call: KnowledgeCall, pageId: string): string {
  try {
    return call.store.getPage(call.person.id, pageId).collectionId;
  } catch (err) {
    if (err instanceof CanonError && err.code === 'forbidden') {
      throw new CanonError(
        'forbidden',
        `${call.person.name} cannot see this page, so the app may not read it on their behalf`,
        {
          ...err.details,
          reason: 'person_not_permitted',
          refusedBy: 'person',
          onBehalfOf: call.person.id,
          pageId,
        },
      );
    }
    throw err;
  }
}

// ---- audit --------------------------------------------------------------

// Every Knowledge API call is an audit event naming the app, the person, and
// what was touched. The event is attributed to the APP's actor — the app is
// what acted — and carries the person in `onBehalfOf`, so one query answers
// "everything this app did", another answers "everything done for this
// person", and the pair answers "who did what, through what".
function auditCall(call: KnowledgeCall, action: string, outcome: Outcome): void {
  call.store.recordAudit(call.app.actorId, action, {
    collectionId: outcome.collectionId ?? undefined,
    pageId: outcome.pageId ?? undefined,
    details: {
      surface: 'knowledge',
      onBehalfOf: call.person.id,
      personName: call.person.name,
      app: call.app.name,
      registryRef: call.app.agentId,
      ...(outcome.details ?? {}),
    },
  });
}

// A refusal is an audit event too, and it names both actors and which side
// refused. An app whose calls are being denied and a person who cannot see
// what they expected are the same log entry read two ways.
function auditDenied(store: CanonStore, who: Attribution | null, appActorId: string, operation: string, err: CanonError): void {
  store.recordAudit(appActorId, 'knowledge.denied', {
    details: {
      surface: 'knowledge',
      operation,
      error: err.code,
      ...(who ? { onBehalfOf: who.person.id, personName: who.person.name, app: who.app.name, registryRef: who.app.agentId } : {}),
      ...err.details,
    },
  });
}

// ---- the route table ----------------------------------------------------

type Work = (call: KnowledgeCall) => Outcome | Promise<Outcome>;

/**
 * One Knowledge API route. The wrapper is where "no session state, no cached
 * grant" is made structural: attribution is resolved from the headers of the
 * request in hand, the work runs, the call is audited with both actors, and
 * nothing survives the return.
 */
function knowledge(method: string, path: string, operation: string, work: Work): KnowledgeRouteSpec {
  return {
    method,
    path,
    handler: async (ctx: KnowledgeRequest) => {
      let who: Attribution | null = null;
      try {
        who = attribute(ctx);
        const call: KnowledgeCall = { ...ctx, app: who.app, person: who.person };
        const outcome = await work(call);
        auditCall(call, `knowledge.${operation}`, outcome);
        return outcome.result;
      } catch (err) {
        // A refusal Canon can attribute to an app is recorded against it. One
        // it cannot — no passport at all — was already refused (and audited)
        // by agentauth or is a person's request that never belonged here.
        if (err instanceof CanonError && ctx.agent) {
          auditDenied(ctx.store, who, ctx.agent.actorId, operation, err);
        }
        throw err;
      }
    },
  };
}

export const KNOWLEDGE_ROUTES: KnowledgeRouteSpec[] = [
  // Who is asking, and what does the intersection currently come to? A
  // derived view of the three gates, not a fourth gate: it reports what the
  // other three would decide, computed from the same data, per call.
  knowledge('GET', `${KNOWLEDGE_PREFIX}/whoami`, 'whoami', (call) => {
    const effective = effectiveCollections(call);
    return {
      result: {
        app: {
          actorId: call.app.actorId,
          registryRef: call.app.agentId,
          name: call.app.name,
          permittedCollections: call.app.permittedCollections,
          permittedActions: call.app.permittedActions,
          permittedSources: call.app.permittedSources,
        },
        person: { actorId: call.person.id, name: call.person.name },
        collections: effective,
        evaluatedAt: new Date().toISOString(),
      },
      details: { collections: effective.length },
    };
  }),

  // ---- the read surface -------------------------------------------------

  knowledge('GET', `${KNOWLEDGE_PREFIX}/collections`, 'collections', (call) => {
    // The app's own membership bounds the listing (the store), the person's
    // membership narrows it again (here), and the Registry narrows what is
    // left (api.ts, through agentauth's `narrow`). Three gates, in series.
    const result = call.store
      .listCollections(call.app.actorId)
      .filter((c) => call.store.roleOf(call.person.id, c.id) !== null);
    return { result, details: { count: result.length } };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/collections/:id`, 'collection', async (call) => {
    const collectionId = call.params.id!;
    requirePerson(call, collectionId, 'view');
    const result = await asApp(call, () => call.store.getCollection(call.app.actorId, collectionId));
    return { result, collectionId };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/collections/:id/tree`, 'tree', async (call) => {
    const collectionId = call.params.id!;
    requirePerson(call, collectionId, 'view');
    const result = await asApp(call, () => call.store.tree(call.app.actorId, collectionId));
    return { result, collectionId };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/pages/:id`, 'page', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    const page = await asApp(call, () => call.store.getPage(call.app.actorId, pageId, { logView: true }));
    const current = page.currentVersion
      ? call.store.getVersion(call.app.actorId, page.id, page.currentVersion)
      : null;
    return { result: { ...page, current }, collectionId, pageId };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/pages/:id/versions`, 'versions', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    const result = await asApp(call, () => call.store.listVersions(call.app.actorId, pageId));
    return { result, collectionId, pageId };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/pages/:id/versions/:n`, 'version', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    const number = Number(call.params.n);
    const result = await asApp(call, () => call.store.getVersion(call.app.actorId, pageId, number));
    return { result, collectionId, pageId, details: { version: number } };
  }),

  knowledge('GET', `${KNOWLEDGE_PREFIX}/search`, 'search', (call) => {
    const q = call.query.get('q') ?? '';
    const result = call.store.searchIndex.search(call.app.actorId, {
      q,
      collectionId: call.query.get('collection') ?? undefined,
      type: call.query.get('type') ?? undefined,
      status: call.query.get('status') ?? undefined,
      ownerId: call.query.get('owner') ?? undefined,
      limit: call.query.get('limit') ? Number(call.query.get('limit')) : undefined,
      // The other two gates, in the same SQL that already filters by the
      // app's permissions: the person must see it too, and the Registry's
      // collection limit bounds the candidate set before anything is ranked.
      alsoVisibleTo: call.person.id,
      collectionIds: registryScope(call.app),
    });
    return { result, details: { q, hits: result.length } };
  }),

  // Grounded answers through the Knowledge API obey DATA-BACKBONE.md §5
  // unchanged, because they ARE §5: this calls the same `store.ask` Canon's
  // own question box calls. Canonical pages only, every claim cited, refusal
  // when the record is silent. The only thing added is the narrowing, and it
  // is applied to the candidates before generation — filtering citations
  // afterwards cannot un-leak what the answer text already merged.
  //
  // ---- "not permitted" and "the record is silent" (USER-TESTING.md T3.7) ----
  //
  // Both used to come back as the same three bytes — `refused: true`,
  // `no_canonical_match` — and STUDIO-CONTRACT.md §9 tells apps not to render
  // the two the same way while giving them no way to tell them apart. That is
  // a real defect and it is in real tension with the other half of the
  // testing: the same indistinguishability is exactly why an auditor probing
  // nine routes into a collection she could not see found no leak, in the
  // count or in the error. Both findings are right, so the fix has to be drawn
  // narrowly enough to keep the second one true.
  //
  // THE LINE THIS DRAWS: a distinction is only ever offered to an asker who
  // ALREADY KNOWS the collection exists, and never as an answer to an open
  // question over the whole record.
  //
  //   * An ask that NAMES a `collectionId` is such an asker. To have named it,
  //     the app must hold a Registry limit that lets that id through — an
  //     administrator wrote the name into the app's `permittedCollections`, so
  //     the collection's existence is something the app was told on purpose,
  //     by a person, outside Canon. Answering "you are not permitted to read
  //     the collection you named" discloses nothing that was not already
  //     disclosed by the grant. So all three gates refuse a scoped ask out
  //     loud, with §9's codes: the Registry's in agentauth.ts, the person's
  //     and — new, and the whole of what T3.7 asked for — the app's, here.
  //     A scoped ask that comes back `no_canonical_match` now means one thing
  //     only: all three gates opened, and the record inside that collection
  //     had nothing to say.
  //
  //   * An ask that names NO collection stays exactly as it was, deliberately.
  //     "Some collection you may not read holds the answer" is a statement
  //     about the record's contents and about the existence of a container the
  //     asker was never told about, and it is the one sentence the auditor's
  //     nine probes were checking for. It is not worth having, so it is not
  //     said, and STUDIO-CONTRACT.md §9 now says so as a decision rather than
  //     leaving it to be read as an oversight.
  //
  // THE ONE THING AN OPEN QUESTION MAY BE TOLD is that the pair asking it can
  // read NOTHING AT ALL — `nothing_readable` below. That is a fact about the
  // caller's own standing rather than about the record: it says "you hold no
  // readable collection", never "there is something here you are missing", and
  // it is precisely what `GET /knowledge/whoami` already hands the same caller
  // in full, computed by the same function. An app whose Registry limit is
  // empty, or whose actor an administrator never gave a Canon role, is the
  // commonest way a Studio integration fails on its first afternoon, and
  // telling it "the record does not say" is a false statement about the record
  // — the failure DATA-BACKBONE.md §5 spends its length avoiding, pointed the
  // other way.
  knowledge('POST', `${KNOWLEDGE_PREFIX}/ask`, 'ask', async (call) => {
    const body = (call.body ?? {}) as { question?: string; collectionId?: string; limit?: number };
    if (body.collectionId) {
      requirePerson(call, body.collectionId, 'view');
      requireApp(call, body.collectionId, 'view');
    }
    const answer = await asApp(call, () =>
      call.store.ask(call.app.actorId, {
        question: body.question ?? '',
        collectionId: body.collectionId,
        limit: body.limit,
        alsoVisibleTo: call.person.id,
        collectionIds: registryScope(call.app),
      }),
    );
    // Only for an unscoped ask: a scoped one has already passed all three
    // gates on the collection it named, so the pair demonstrably reads
    // something and `nothing_readable` could not be true of it.
    const result =
      answer.refused && !body.collectionId && effectiveCollections(call).length === 0
        ? { ...answer, reason: 'nothing_readable' as const }
        : answer;
    return {
      result,
      collectionId: body.collectionId ?? null,
      details: {
        question: body.question ?? '',
        refused: result.refused,
        ...(result.refused && result.reason ? { reason: result.reason } : {}),
        citedPageIds: result.citations.map((c) => c.pageId),
      },
    };
  }),

  // ---- the write surface ------------------------------------------------
  //
  // An app writes as ITSELF, with the person recorded. History says the app
  // authored the version; the audit log says which person it was acting for.
  // Nothing here bypasses Canon's workflow: the draft lock, the type rules,
  // the review gate and the approval rule are the store's, unchanged, so an
  // app cannot publish what a person could not — and cannot grant the
  // Canonical mark at all, because `approve` is not in this vocabulary.

  knowledge('POST', `${KNOWLEDGE_PREFIX}/pages`, 'page_create', async (call) => {
    const collectionId = String(call.body?.collectionId ?? '');
    if (!collectionId) throw new CanonError('invalid', 'A page requires a collectionId');
    requirePerson(call, collectionId, 'edit');
    const result = await asApp(call, () => call.store.createPage(call.app.actorId, call.body));
    return { result, collectionId, pageId: (result as { id: string }).id };
  }),

  knowledge('PUT', `${KNOWLEDGE_PREFIX}/pages/:id/draft`, 'draft', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    requirePerson(call, collectionId, 'edit');
    const result = await asApp(call, () => call.store.editDraft(call.app.actorId, pageId, call.body ?? {}));
    return { result, collectionId, pageId };
  }),

  knowledge('POST', `${KNOWLEDGE_PREFIX}/pages/:id/publish`, 'publish', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    requirePerson(call, collectionId, 'edit');
    const result = await asApp(call, () => call.store.publish(call.app.actorId, pageId, call.body ?? {}));
    return { result, collectionId, pageId };
  }),

  knowledge('POST', `${KNOWLEDGE_PREFIX}/pages/:id/submit`, 'submit', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    requirePerson(call, collectionId, 'edit');
    const result = await asApp(call, () => call.store.submitForReview(call.app.actorId, pageId));
    return { result, collectionId, pageId };
  }),

  knowledge('POST', `${KNOWLEDGE_PREFIX}/pages/:id/comments`, 'comment', async (call) => {
    const pageId = call.params.id!;
    const collectionId = pageCollectionForPerson(call, pageId);
    requirePerson(call, collectionId, 'comment');
    const result = await asApp(call, () => call.store.createComment(call.app.actorId, pageId, call.body ?? {}));
    return { result, collectionId, pageId };
  }),
];
