import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AgentAuth, AgentSession, passportAuthUnavailable, runInAgentRequestScope } from './agentauth.js';
import {
  devAuthEnabled,
  devAuthRefused,
  identifyFromHeader,
  PersonAuth,
  PersonIdentity,
  visibleActors,
} from './auth.js';
import { freshnessScheduleFor } from './freshness.js';
import { importSpoolDir } from './import.js';
import { countParam, idParam, instantParam, objectBody, optionalCount, optionalString, requiredCount } from './input.js';
import { loggerFromEnv, noteRequest, requestPath, type Logger } from './log.js';
import { KNOWLEDGE_ROUTES, KNOWLEDGE_PREFIX } from './knowledge.js';
import { CanonError } from './model.js';
import { flushNotifications } from './notify.js';
import { BucketName, RateLimiter } from './ratelimit.js';
import { CanonStore } from './store.js';
import { RawResponse } from './csv.js';
import {
  attestationHtmlResponse,
  renderCollectionAttestationHtml,
  renderPageAttestationHtml,
} from './attestation.js';
import type { ProposalStatus } from './proposals.js';

// A deliberately thin HTTP layer over the store. Three doors, never mixed:
//
//   SSO      a session cookie, issued by auth.ts after an OpenID Connect
//            Authorization Code flow with PKCE. The people-facing door.
//   dev      X-Actor-Id, the alpha's stand-in for SSO — now live only when a
//            deployment sets CANON_DEV_AUTH=true, and refused outright
//            otherwise (SECURITY.md R1).
//   passport X-Agent-Passport, verified with the Veryl Agent Registry and
//            resolved to an agent actor by agentauth.ts, which also applies
//            the Registry's limits before the store sees the request. With no
//            Registry configured (no CANON_REGISTRY_URL) passport
//            authentication is refused with a clear message.
//
// A request carries one of the three. A session cookie alongside an
// X-Actor-Id naming somebody else, or alongside a passport, is refused rather
// than resolved in favour of one of them (REGISTRY-CONTRACT.md §2).

type Handler = (ctx: {
  store: CanonStore;
  actorId: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  /**
   * The verified agent behind this request, or null when a person is asking.
   * Most handlers ignore it — the store enforces Canon's permissions from
   * `actorId` alone. It is here for handlers that must govern parts of one
   * response separately, which today means federated references: the same
   * session is also ambient inside the handler via `currentAgentSession()`
   * and `refuseUnpermittedSource()` in agentauth.ts.
   */
  agent: AgentSession | null;
  /**
   * The request's raw headers. Almost every handler ignores them — identity
   * is already resolved into `actorId` and `agent`. Veryl Studio's Knowledge
   * API reads `X-On-Behalf-Of` from here, because a Studio app's call carries
   * two identities: the app's passport and the person it is acting for
   * (STUDIO-CONTRACT.md §3).
   */
  headers: IncomingHttpHeaders;
}) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
  open?: boolean; // no actor required
  /**
   * Exists only while dev authentication is on. A server started without
   * CANON_DEV_AUTH=true answers 404 here — the route is not merely refused,
   * it is not part of that Canon's surface.
   */
  devOnly?: boolean;
  /**
   * The body is an uploaded artifact, not JSON: the pipeline spools it to a
   * temp file under its own (much larger) cap and hands the handler
   * `{ archivePath }`. Today that is /imports/upload and nothing else.
   */
  binary?: boolean;
}

function route(method: string, path: string, handler: Handler, open = false, devOnly = false): Route {
  const names: string[] = [];
  const pattern = new RegExp(
    '^' +
      path
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$',
  );
  return { method, pattern, names, handler, open, devOnly };
}

const routes: Route[] = [
  route('GET', '/health', () => ({ ok: true, product: 'Veryl Canon', stage: 'alpha' }), true),

  // Minting an identity is no longer a thing anyone can do (SECURITY.md R1).
  // People arrive by SSO, where the actor is provisioned from a verified ID
  // token; agents arrive by passport, where agentauth.ts creates the actor
  // from the Registry's answer. Neither needs this route, so what is left of
  // it is the dev door's own: open exactly as dev mode is open, and absent
  // from a Canon that did not ask for dev mode.
  route('POST', '/actors', ({ store, body }) => store.createActor(body), true, true),
  // The directory, narrowed (SECURITY.md R2). `?collection=<id>` is a
  // collection's member list, to anyone who may view it; without it, the
  // whole directory for an operator and only actual colleagues for everyone
  // else. See visibleActors in auth.ts for why each case is what it is.
  route('GET', '/actors', ({ store, actorId, query }) =>
    visibleActors(store, actorId, query.get('collection') ?? undefined),
  ),

  route('POST', '/collections', ({ store, actorId, body }) => store.createCollection(actorId, body)),
  // Every collection carries what this actor may do IN it. The listing carries
  // it too, and that is not padding: asserting that two pages conflict needs
  // `edit` on BOTH pages' collections, so the dialog that asserts one has to
  // know its answer for a collection the reader is not looking at — including
  // the sentence naming who holds the role THERE (USER-TESTING.md T4.4, second
  // round). A projection of the checks, never one of them; see
  // `collectionAbilities`.
  route('GET', '/collections', ({ store, actorId }) =>
    store.listCollections(actorId).map((c) => ({ ...c, abilities: store.collectionAbilities(actorId, c.id) })),
  ),
  route('GET', '/collections/:id', ({ store, actorId, params }) => ({
    ...store.getCollection(actorId, params.id!),
    abilities: store.collectionAbilities(actorId, params.id!),
  })),
  route('GET', '/collections/:id/tree', ({ store, actorId, params }) => store.tree(actorId, params.id!)),
  route('GET', '/collections/:id/members', ({ store, actorId, params }) => store.listMembers(actorId, params.id!)),
  route('PUT', '/collections/:id/members/:memberId', ({ store, actorId, params, body }) => {
    store.setMember(actorId, params.id!, params.memberId!, body.role);
    return { ok: true };
  }),
  // Withdrawing a membership withdraws the HAND grant. The answer carries what
  // is left — `{ removed, remaining, groups }` — because a directory group may
  // still be granting this person a role here (SECURITY.md R10), and an
  // administrator who was not told would believe they had removed something.
  route('DELETE', '/collections/:id/members/:memberId', ({ store, actorId, params }) =>
    store.removeMember(actorId, params.id!, params.memberId!),
  ),

  route('POST', '/pages', ({ store, actorId, body }) => store.createPage(actorId, body)),
  route('GET', '/pages/:id', ({ store, actorId, params }) => {
    const page = store.getPage(actorId, params.id!, { logView: true });
    const current = page.currentVersion ? store.getVersion(actorId, page.id, page.currentVersion) : null;
    // References travel inside the page payload the UI already fetches
    // (DATA-BACKBONE.md §6) — unresolved descriptors, so rendering the page
    // costs no external call. Resolution stays on GET /pages/:id/references.
    const references = store.listReferences(actorId, page.id);
    // What is pending while the page is In Review — the draft's fields and the
    // approver `approve` will accept (store.ts, "the review workflow"
    // invariant). It travels inside the payload the UI already fetches for the
    // same reason references do: naming the right approver must not depend on
    // a second request that a reader without `edit` is refused. Null on every
    // page that is not in review.
    const review = store.reviewState(actorId, page.id);
    // The approver's refusal, where it is still the last word on this page
    // (USER-TESTING.md T4.3). It rides along for the same reason `review` does:
    // the author must meet it on the page, not in a global audit log, and a
    // banner that needed a second request would be a banner that is sometimes
    // missing.
    const sentBack = store.sentBack(actorId, page.id);
    // What this actor may actually do to this page, so a screen can stop
    // offering what the server is about to refuse (USER-TESTING.md T4.4). It is
    // a projection of the checks, never one of them; see `pageAbilities`.
    const abilities = store.pageAbilities(actorId, page.id);
    // The baseline a review must be judged against: the last version to HOLD
    // the Canonical mark, which `current` is not whenever something published
    // between the mark and the submission. A review surface that diffs against
    // `current` folds those unreviewed publishes into its baseline and asks
    // the approver to certify changes it never showed them (USER-TESTING.md,
    // third round, finding 1). Carried only while the page is in review — it
    // is the review's baseline, and no other screen reads it. Null, when
    // carried, means no version has ever held the mark and the whole draft is
    // new to review.
    // Which of the body's own links point at pages this reader may not open.
    // Travels with the payload the UI already fetches, for the same reason
    // `references` does: the renderer needs it on the first paint, and a body
    // that briefly shows a withheld title before a second request comes back
    // has already shown it.
    const withheldLinks = current ? store.withheldLinks(actorId, current.body) : [];
    return {
      ...page,
      current,
      references,
      review,
      sentBack,
      abilities,
      withheldLinks,
      ...(review ? { lastCanonical: store.lastCanonicalVersion(actorId, page.id) } : {}),
    };
  }),
  route('POST', '/pages/:id/move', ({ store, actorId, params, body }) =>
    store.movePage(actorId, params.id!, { parentId: body.parentId ?? null }),
  ),
  route('POST', '/pages/:id/archive', ({ store, actorId, params }) => store.archivePage(actorId, params.id!)),

  route('GET', '/pages/:id/draft', ({ store, actorId, params }) => store.getDraft(actorId, params.id!)),
  // An empty PUT — no title, no body, no fields — is how the editor opens,
  // and opening is a question, not an edit: it answers with what the editor
  // would hold (and the lock refusal, where somebody else holds it) and
  // writes nothing. The draft row, the queue entry, the audit event and the
  // lock all wait for the first PUT that carries content (fourth round,
  // finding 4: walking in the door used to take the lock).
  route('PUT', '/pages/:id/draft', ({ store, actorId, params, body }) => {
    const input = (body ?? {}) as { title?: string; body?: string; fields?: unknown };
    return input.title === undefined && input.body === undefined && input.fields === undefined
      ? store.openDraft(actorId, params.id!)
      : store.editDraft(actorId, params.id!, body);
  }),
  route('DELETE', '/pages/:id/draft', ({ store, actorId, params }) => {
    store.discardDraft(actorId, params.id!);
    return { ok: true };
  }),

  route('POST', '/pages/:id/publish', ({ store, actorId, params, body }) =>
    store.publish(actorId, params.id!, body ?? {}),
  ),
  route('POST', '/pages/:id/submit', ({ store, actorId, params }) => store.submitForReview(actorId, params.id!)),
  route('POST', '/pages/:id/approve', ({ store, actorId, params, body }) =>
    store.approve(actorId, params.id!, body ?? {}),
  ),
  route('POST', '/pages/:id/send-back', ({ store, actorId, params, body }) =>
    store.sendBack(actorId, params.id!, body ?? {}),
  ),
  // The author's own way out of a submission nobody has acted on yet
  // (USER-TESTING.md T4.5). Its own route rather than a flag on send-back,
  // because it is a different act by a different person and the log has to say
  // so; only the actor who submitted it is accepted.
  route('POST', '/pages/:id/withdraw', ({ store, actorId, params, body }) =>
    store.withdrawFromReview(actorId, params.id!, body ?? {}),
  ),

  route('GET', '/pages/:id/versions', ({ store, actorId, params }) => store.listVersions(actorId, params.id!)),
  // An OLD version leaks a linked title exactly as the current one does — the
  // body is the body — so the same withheld-link list travels with it.
  route('GET', '/pages/:id/versions/:n', ({ store, actorId, params }) => {
    const version = store.getVersion(actorId, params.id!, countParam(params.n!, 'version')!);
    return { ...version, withheldLinks: store.withheldLinks(actorId, version.body) };
  }),
  route('POST', '/pages/:id/restore', ({ store, actorId, params, body }) =>
    store.restore(actorId, params.id!, requiredCount(body.version, 'version')),
  ),

  route('GET', '/search', ({ store, actorId, query }) =>
    store.searchIndex.search(actorId, {
      q: query.get('q') ?? '',
      collectionId: query.get('collection') ?? undefined,
      type: query.get('type') ?? undefined,
      status: query.get('status') ?? undefined,
      ownerId: query.get('owner') ?? undefined,
      limit: countParam(query.get('limit'), 'limit'),
    }),
  ),

  // One page of the log, newest first. `?before=<event id>` walks older: the
  // cursor for the next page is the id of the last event in this one. The
  // shape is unchanged — an array of events — because every existing caller
  // and test reads it that way; how many matched in total is a different
  // question with its own route below.
  route('GET', '/audit', ({ store, actorId, query }) =>
    store.queryAudit(actorId, {
      ...auditFilterFrom(query),
      before: countParam(query.get('before'), 'before'),
      limit: countParam(query.get('limit'), 'limit'),
    }),
  ),
  // How big the filtered population is, and which actions are in it. Both are
  // things the screen cannot honestly draw without: a table showing a page and
  // saying nothing about the rest asserts a completeness it does not have, and
  // an action list hard-coded in the client was missing ten action types the
  // record actually writes while offering four it never does.
  route('GET', '/audit/summary', ({ store, actorId, query }) =>
    store.auditSummary(actorId, auditFilterFrom(query)),
  ),

  route('POST', '/pages/:id/comments', ({ store, actorId, params, body }) =>
    store.createComment(actorId, params.id!, body),
  ),
  route('GET', '/pages/:id/comments', ({ store, actorId, params }) => store.listComments(actorId, params.id!)),
  route('POST', '/comments/:id/resolve', ({ store, actorId, params }) => store.resolveComment(actorId, params.id!)),
  route('POST', '/comments/:id/reopen', ({ store, actorId, params }) => store.reopenComment(actorId, params.id!)),
  route('GET', '/notifications', ({ store, actorId }) => store.listNotifications(actorId)),
  // Delivery pass over the notification outbox; a deployment runs it on a timer.
  route('POST', '/notifications/flush', ({ store, actorId, body }) =>
    flushNotifications(store, actorId, optionalCount(body?.limit, 'limit')),
  ),

  route('POST', '/ask', ({ store, actorId, body }) => store.ask(actorId, body ?? {})),

  // The refused-questions loop (gaps.ts): operator-only, because a gap is a
  // question's text and question text is operators' to read — the same rule
  // the audit log applies. The asker is never in the payload; the table that
  // feeds this has no column for one.
  route('GET', '/gaps', ({ store, actorId, query }) =>
    store.listGaps(actorId, { status: query.get('status') ?? undefined }),
  ),
  route('POST', '/gaps/:id/close', ({ store, actorId, params, body }) =>
    store.closeGap(actorId, params.id!, {
      outcome: optionalString(body?.outcome, 'outcome'),
      note: optionalString(body?.note, 'note') ?? null,
    }),
  ),
  route('GET', '/pages/:id/related', ({ store, actorId, params, query }) =>
    store.related(actorId, params.id!, {
      canonicalOnly: query.get('canonical') === 'true',
      limit: countParam(query.get('limit'), 'limit'),
    }),
  ),

  // Epic E, M4: the audit log as a CSV download, same filters as GET /audit,
  // and the Confluence and Google Docs importers.
  // The export carries the WHOLE filtered population, so it deliberately takes
  // no `limit` — and refuses one rather than ignoring it. A file holding the
  // most recent N rows of a filter, with nothing on it to say so, is a sample
  // presented as a population, and this is the artefact that gets attached to
  // a report. Narrowing is what `from`/`to` are for; `x-canon-truncated` says
  // so when even the whole population did not fit.
  route('GET', '/audit.csv', ({ store, actorId, query }) => {
    if (query.has('limit')) {
      throw new CanonError(
        'invalid',
        'An export carries every event matching its filters, so it takes no limit. Narrow it with from and to instead.',
        { field: 'limit' },
      );
    }
    return store.auditCsv(actorId, auditFilterFrom(query));
  }),

  route('POST', '/imports', ({ store, actorId, body }) => store.runImport(actorId, body)),
  // The same importer, fed by an UPLOAD instead of a server-side path — the
  // difference between "ask whoever has shell access" and "bring your export".
  // Parameters ride the query string because the body is the archive itself.
  {
    ...route('POST', '/imports/upload', ({ store, actorId, query, body }) =>
      store.runImportUpload(actorId, {
        source: (query.get('source') ?? '') as never,
        collectionId: query.get('collectionId') ?? '',
        type: (query.get('type') ?? undefined) as never,
        runId: query.get('runId') ?? undefined,
        archivePath: body.archivePath,
      }),
    ),
    binary: true,
  },
  route('GET', '/imports', ({ store, actorId }) => store.listImportRuns(actorId)),
  route('GET', '/imports/:id', ({ store, actorId, params }) => store.getImportRun(actorId, params.id!)),

  // Federation (DATA-BACKBONE.md §6): registered sources, and resolving a
  // page's reference fields for the asking actor.
  route('POST', '/sources', ({ store, actorId, body }) => store.createSource(actorId, body)),
  // Each row carries what this actor may do to it, so the register stops
  // offering a red Delete to somebody the server refuses (USER-TESTING.md
  // T4.4). Same projection as a page's `abilities`, same one rule: a mirror of
  // the checks in sources.ts, never one of them.
  route('GET', '/sources', ({ store, actorId }) =>
    store.listSources(actorId).map((source) => ({ ...source, abilities: store.sourceAbilities(actorId, source) })),
  ),
  // The one control that exists before a source does. It sits above
  // `/sources/:id` because `routes.find` takes the first match and a source id
  // is a UUID, so the two can never be the same path.
  route('GET', '/sources/new', ({ store, actorId }) => store.sourceRegisterAbility(actorId)),
  route('GET', '/sources/:id', ({ store, actorId, params }) => {
    const source = store.getSource(actorId, params.id!);
    return { ...source, abilities: store.sourceAbilities(actorId, source) };
  }),
  route('PUT', '/sources/:id', ({ store, actorId, params, body }) => store.updateSource(actorId, params.id!, body)),
  route('DELETE', '/sources/:id', ({ store, actorId, params }) => {
    store.deleteSource(actorId, params.id!);
    return { ok: true };
  }),
  route('GET', '/pages/:id/references', ({ store, actorId, params }) => store.resolveReferences(actorId, params.id!)),
  route('POST', '/pages/:id/references', ({ store, actorId, params, body }) =>
    store.addReference(actorId, params.id!, body),
  ),
  route('DELETE', '/references/:id', ({ store, actorId, params }) => {
    store.removeReference(actorId, params.id!);
    return { ok: true };
  }),

  // Divergence (DATA-BACKBONE.md §7). Two reads and one decision.
  //
  // There is deliberately no route that OPENS one: a divergence is observed by
  // the reference layer when a corroborating source disagrees with its
  // authority, and it appears on `GET /pages/:id/references` as a marker on
  // the references involved — so a page shows the disagreement without a
  // second call. These routes are for the list and the settlement.
  //
  // `POST /divergences/:id/close` requires a reason and is a PERSON's act,
  // absent from agentauth.ts's route table exactly as the proposal decisions
  // are. See the note there and in divergence.ts.
  route('GET', '/pages/:id/divergences', ({ store, actorId, params, query }) =>
    store.listPageDivergences(actorId, params.id!, {
      state: (query.get('state') as 'open' | 'closed' | null) ?? undefined,
    }),
  ),
  route('GET', '/divergences', ({ store, actorId, query }) =>
    store.listDivergences(actorId, {
      state: (query.get('state') as 'open' | 'closed' | null) ?? undefined,
      collectionId: query.get('collection') ?? undefined,
      limit: countParam(query.get('limit'), 'limit'),
    }),
  ),
  route('GET', '/divergences/:id', ({ store, actorId, params }) => store.getDivergence(actorId, params.id!)),
  route('POST', '/divergences/:id/close', ({ store, actorId, params, body }) =>
    store.closeDivergence(actorId, params.id!, body ?? {}),
  ),

  // Agent proposals (FEATURES.md §5, the Next tier). Proposing is an edit act
  // and available to agents; accepting and rejecting are a person's act and
  // are deliberately absent from agentauth.ts's route table, so an agent
  // presenting a passport is refused at the door.
  route('POST', '/pages/:id/proposals', ({ store, actorId, params, body }) =>
    store.createProposal(actorId, params.id!, body),
  ),
  route('GET', '/pages/:id/proposals', ({ store, actorId, params, query }) =>
    store.listProposals(actorId, params.id!, {
      status: (query.get('status') as ProposalStatus | null) ?? undefined,
    }),
  ),
  route('POST', '/proposals/:id/accept', ({ store, actorId, params, body }) =>
    store.acceptProposal(actorId, params.id!, body ?? {}),
  ),
  route('POST', '/proposals/:id/reject', ({ store, actorId, params, body }) =>
    store.rejectProposal(actorId, params.id!, body ?? {}),
  ),

  // Page relations (DATA-BACKBONE.md §7, "Two pages contradict each other").
  // Asserting one takes `edit` on BOTH pages' collections and is a person's
  // act: POST and DELETE are deliberately absent from agentauth.ts's route
  // table, exactly as accepting a proposal is, so an agent presenting a
  // passport is refused at the door. Reading them is an ordinary read of the
  // record and is classified there.
  route('POST', '/pages/:id/relations', ({ store, actorId, params, body }) =>
    store.assertRelation(actorId, params.id!, body ?? {}),
  ),
  route('GET', '/pages/:id/relations', ({ store, actorId, params }) => store.listRelations(actorId, params.id!)),
  route('DELETE', '/relations/:id', ({ store, actorId, params }) => {
    store.removeRelation(actorId, params.id!);
    return { ok: true };
  }),
  // Veryl Studio's Knowledge API (STUDIO-CONTRACT.md). Its handlers live in
  // knowledge.ts, mounted here as ordinary routes so they meet the same
  // passport authentication and the same Registry enforcement as everything
  // else; what they add on top is the person the app is acting for, and the
  // three-way intersection that follows from naming both.
  ...KNOWLEDGE_ROUTES.map((r) => route(r.method, r.path, r.handler)),
  // Freshness (FEATURES.md §3). The sweep flips Canonical pages whose review
  // date has passed to Needs Update and notifies their owners; a deployment
  // runs it on a timer exactly as it runs the notification flush, and this
  // route exists so an operator can also run it by hand. Idempotent: the second
  // run finds nothing, because the first one changed the status it selects on.
  route('POST', '/maintenance/freshness', ({ store, actorId, body }) =>
    store.sweepFreshness(actorId, {
      on: body?.on ?? undefined,
      limit: optionalCount(body?.limit, 'limit'),
    }),
  ),
  // What this deployment actually does about review dates: whether the timer is
  // running, how often, whom the flips are attributed to, and how far an owner's
  // notice travels. Readable by ANY authenticated actor, and deliberately so —
  // the person who needs to know whether a review date does anything is the
  // policy author typing one into the editor, not the operator reading stdout.
  // It discloses no record content: an interval, a boolean, and the constants
  // that describe Canon's own actor. See freshnessScheduleFor in freshness.ts.
  route('GET', '/maintenance/freshness', ({ store }) => freshnessScheduleFor(store)),

  // Structured queries (FEATURES.md §6). A typed filter object, not a query
  // language: `{ collectionIds, types, statuses, ownerIds, approverIds,
  // awaitingApprovalBy, sentBackTo, draftHeldBy, hasOwner, hasReviewDate,
  // hasEffectiveDate, hasEffectiveDateBasis, backdated,
  // reviewDateBefore/After, updatedBefore/After, createdBefore/After, sort,
  // direction, limit }`. `awaitingApprovalBy` is the one that reads the DRAFT's
  // approver rather than the page row's, and the three after `approverIds` are
  // what the queue is built from (queue.ts). `backdated: true` with
  // `hasEffectiveDateBasis: false` is the sample behind record health's
  // `backdatedWithoutBasis` count (USER-TESTING.md T1.5): the pages claiming to
  // pre-date this record with nothing recorded about why. Naming `savedQueryId` runs
  // a stored filter instead; anything else in the body still overrides it, so a
  // dashboard can pin a query and page through it.
  route('POST', '/queries/run', ({ store, actorId, body }) => {
    const { savedQueryId, ...query } = body ?? {};
    return savedQueryId ? store.runSavedQuery(actorId, String(savedQueryId), query) : store.runQuery(actorId, query);
  }),
  route('POST', '/queries', ({ store, actorId, body }) =>
    store.saveQuery(actorId, { name: body?.name, query: body?.query }),
  ),
  route('GET', '/queries', ({ store, actorId }) => store.listQueries(actorId)),
  route('GET', '/queries/:id', ({ store, actorId, params }) => store.getQuery(actorId, params.id!)),
  route('DELETE', '/queries/:id', ({ store, actorId, params }) => {
    store.deleteQuery(actorId, params.id!);
    return { ok: true };
  }),

  // The knowledge map: one collection's explicit graph — the tree, the links
  // people wrote, and the sources its pages reference — with each node's
  // provenance (DATA-BACKBONE.md §5 and §6). Read-only, and permission-filtered
  // in the SQL that selects its nodes, so a page the asker cannot see is absent
  // rather than redacted.
  route('GET', '/collections/:id/graph', ({ store, actorId, params }) =>
    store.collectionGraph(actorId, params.id!),
  ),
  // The same map at the record's altitude. `?collection=<id>`, repeatable,
  // selects collections; with none named it draws every collection the asker
  // may view. It is a SPANNING read, so a collection the asker cannot see
  // contributes nothing rather than refusing the request — the same treatment
  // search and the query surface give, and the treatment
  // REGISTRY-CONTRACT.md §4.2 requires for an agent.
  route('GET', '/graph', ({ store, actorId, query }) =>
    store.recordGraph(actorId, { collectionIds: query.getAll('collection') }),
  ),

  // Attestation and export (FEATURES.md §7). Three reads, all derived from
  // immutable history rather than from anything stored:
  //
  //   GET /audit/verify            walk the audit hash chain, name the first
  //                                break. Operator-only, like the sweep.
  //   GET /pages/:id/as-of?at=…    what this page said at that instant, what
  //                                standing it held, and who granted it.
  //   GET /pages/:id/attestation   the whole bundle an auditor is handed.
  //   GET /collections/:id/attestation
  //                                the register of Canonical pages as at a date.
  //
  // `?format=html` on either attestation returns the self-contained HTML
  // rendering as a download — same builder, same permission, same audit event;
  // only the rendering differs. It is the one other non-JSON response path
  // besides the audit CSV, and it uses the same RawResponse.
  //
  // None of these appear in agentauth.ts's classification table, so an agent
  // presenting a passport is refused at all four. That is the decision, not an
  // omission: an attestation is the artefact a person hands a regulator, and
  // `GET /audit.csv` is closed to agents for exactly the same reason.
  route('GET', '/audit/verify', ({ store, actorId, query }) =>
    store.verifyAuditChain(actorId, {
      limit: countParam(query.get('limit'), 'limit'),
    }),
  ),
  route('GET', '/pages/:id/as-of', ({ store, actorId, params, query }) =>
    store.pageAsOf(actorId, params.id!, query.get('at') ?? ''),
  ),
  route('GET', '/pages/:id/attestation', ({ store, actorId, params, query }) => {
    const format = query.get('format') === 'html' ? 'html' : 'json';
    const bundle = store.pageAttestation(actorId, params.id!, {
      at: query.get('at') ?? undefined,
      format,
    });
    return format === 'html'
      ? attestationHtmlResponse(
          renderPageAttestationHtml(bundle),
          bundle.page.title,
          bundle.manifest.generatedAt,
        )
      : bundle;
  }),
  route('GET', '/collections/:id/attestation', ({ store, actorId, params, query }) => {
    const format = query.get('format') === 'html' ? 'html' : 'json';
    const bundle = store.collectionAttestation(actorId, params.id!, {
      at: query.get('at') ?? undefined,
      format,
    });
    return format === 'html'
      ? attestationHtmlResponse(
          renderCollectionAttestationHtml(bundle),
          bundle.collection.name,
          bundle.manifest.generatedAt,
        )
      : bundle;
  }),

  // The queue (USER-TESTING.md T2.1): everything the record is waiting on the
  // ASKING actor for, assembled from the permission-filtered reads above and
  // nothing else. There is no `/queue/:actorId` and no `?actor=` — the subject
  // is whoever is asking, which is the argument queue.ts makes at length.
  //
  // Deliberately absent from agentauth.ts's route table, so a passport is
  // refused at the door. Two reasons, and the second is the load-bearing one:
  // a queue is a person's morning screen, and the Registry's narrowing works by
  // filtering a flat list of rows by `collectionId` — it cannot reach page rows
  // nested inside six named strands, which is the same reason `GET /queries/:id`
  // returns a definition and never results.
  route('GET', '/queue', ({ store, actorId, query }) =>
    store.myQueue(actorId, { on: query.get('on') ?? undefined }),
  ),

  // Record health (FEATURES.md §8), built on the query surface above.
  route('GET', '/collections/:id/health', ({ store, actorId, params, query }) =>
    store.collectionHealth(actorId, params.id!, {
      staleDraftDays: countParam(query.get('draftDays'), 'draftDays'),
      on: query.get('on') ?? undefined,
    }),
  ),
];

// ---------------------------------------------------------------------------
// Which routes are rate limited, and which are deliberately not
//
// A table of its own rather than a field on every route, for the same reason
// agentauth.ts keeps its classification separate: a route added above is
// UNLIMITED by default, and that is the right default here — the opposite of
// agentauth's, because the failure to avoid there is a route silently opened
// to agents, and the failure to avoid here is a person unable to read the
// record. Everything in this table is a route where one cheap request buys a
// lot of work; see ratelimit.ts for the argument per bucket.
//
// Nothing that reads the record is here. `GET /pages/:id`, `GET /search`,
// `GET /collections`, `GET /audit`, `GET /notifications` and the whole
// Knowledge read surface are unlimited by design: a limiter that can lock a
// person out of a policy at the moment they need it has cost more than it saved.
const RATE_LIMITED: { method: string; pattern: RegExp; bucket: BucketName }[] = [
  // Retrieval over the visible corpus, then generation. Both doors to it, and
  // the Studio door carries a second bucket as well — see `chargesFor`.
  { method: 'POST', pattern: /^\/ask$/, bucket: 'ask' },
  { method: 'POST', pattern: new RegExp(`^${KNOWLEDGE_PREFIX}/ask$`), bucket: 'ask' },
  // Reaches an external system, once per reference on the page. Listing the
  // reference descriptors (which travels inside GET /pages/:id) is not here:
  // it makes no outbound call.
  { method: 'GET', pattern: /^\/pages\/[^/]+\/references$/, bucket: 'references' },
  // Walks an operator-named directory and writes a page per document.
  { method: 'POST', pattern: /^\/imports$/, bucket: 'import' },
  { method: 'POST', pattern: /^\/imports\/upload$/, bucket: 'import' },
];

/**
 * The audit filters, read from a query string in ONE place.
 *
 * Three routes ask the same questions of the log — the listing, the summary
 * that tells a reader how many matched, and the export. An auditor's whole
 * ability to trust a sample rests on those three agreeing, and the previous
 * shape had each of them spelling the parameters out inline: the listing read
 * four, the export read four different ones, and `collection` and `page` were
 * read by neither while being accepted by both. Ruth's report is precise about
 * why that is worse than refusing them outright — a filter that is accepted
 * and ignored returns an answer that LOOKS narrowed and is not.
 *
 * Every reader here refuses what it cannot honour (input.ts), so `?from=last
 * Tuesday` is a 400 naming the field rather than a silently unfiltered log.
 */
function auditFilterFrom(query: URLSearchParams) {
  return {
    actorId: idParam(query.get('actor'), 'actor'),
    action: idParam(query.get('action'), 'action'),
    collectionId: idParam(query.get('collection'), 'collection'),
    pageId: idParam(query.get('page'), 'page'),
    from: instantParam(query.get('from'), 'from', 'start'),
    to: instantParam(query.get('to'), 'to', 'end'),
  };
}

function bucketFor(method: string, pathname: string): BucketName | null {
  return RATE_LIMITED.find((r) => r.method === method && r.pattern.test(pathname))?.bucket ?? null;
}

/** One bucket this request draws on, and the key it draws on it under. */
interface Charge {
  bucket: BucketName;
  key: string;
}

/**
 * Which buckets this request spends from, and under what key.
 *
 * Everywhere but Veryl Studio the answer is "one bucket, keyed by the actor",
 * because there the actor IS the caller. On the Knowledge API it is not: the
 * actor is the app, and one app is a whole company (USER-TESTING.md T3.8). So
 * a Studio ask draws on two buckets and needs a token from each —
 *
 *   `ask`, keyed by the app AND the person it names, so one person's questions
 *   cannot exhaust everybody else's share;
 *   `askApp`, keyed by the app alone, so the total an app can spend does not
 *   depend on how many people it claims to be acting for.
 *
 * The second is what makes it safe to key the first on `X-On-Behalf-Of`, which
 * the app asserts and Canon does not verify (STUDIO-CONTRACT.md §3). An app
 * inventing a person per request mints itself as many `ask` buckets as it
 * likes and gets no further, because every one of those calls also spends from
 * the one bucket whose key it cannot choose: its own actor, resolved from its
 * passport by the Registry. Assertion is used only to SUBDIVIDE a budget, never
 * to enlarge one. See ratelimit.ts for the argument at length.
 *
 * The person is taken verbatim rather than resolved. A limiter that looked
 * actors up would be a second place that decides who a caller is, running
 * before the handler that actually decides it, and the two would drift; and it
 * would buy nothing, because a forged key is already bounded by `askApp`. An
 * unresolvable person is refused by knowledge.ts a moment later, and — being a
 * refusal that reaches no retrieval — spends nothing at all.
 */
function chargesFor(method: string, pathname: string, actorId: string, headers: IncomingHttpHeaders): Charge[] {
  const bucket = bucketFor(method, pathname);
  if (!bucket) return [];
  if (bucket !== 'ask' || !pathname.startsWith(`${KNOWLEDGE_PREFIX}/`)) return [{ bucket, key: actorId }];
  const raw = headers['x-on-behalf-of'];
  const person = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return [
    { bucket: 'ask', key: person ? `${actorId}/${person}` : actorId },
    { bucket: 'askApp', key: actorId },
  ];
}

/**
 * The key for the authentication bucket. It is the ONE bucket that cannot be
 * keyed by actor, because the actor is precisely what an unverified passport
 * is asserting — keying a brute-force limiter by the credential being guessed
 * would limit nothing. So it keys by the connection's origin, and only a
 * FAILED authentication spends a token: a busy honest agent never meets it.
 *
 * When SSO lands (SECURITY.md R1), its login route belongs in this bucket, on
 * this key, for exactly the same reason.
 */
function authKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// A page body, an imported document, and a question are all bodies a person
// legitimately sends, so the cap is generous — but it is a cap. Without one,
// a single unauthenticated request can hold the process's memory: the body is
// buffered whole before anything looks at who is asking. The check runs per
// chunk, so an oversized body is refused as it arrives rather than after it
// has all been accepted.
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Uploaded-archive cap (CANON_IMPORT_UPLOAD_MAX_BYTES, default 256 MiB). Its
 * own limit because an export archive is the one legitimate large body this
 * server accepts, and raising the JSON cap to fit it would raise it for every
 * route that has no business being large.
 */
export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.CANON_IMPORT_UPLOAD_MAX_BYTES ?? '');
  return Number.isFinite(configured) && configured > 0 ? configured : 256 * 1024 * 1024;
}

/** Stream a binary body to the import spool, capped. Returns the file path.
 * Over the cap, the request dies mid-stream and the partial file is removed —
 * buffering an oversized corpus to refuse it afterwards would be the DoS. */
async function spoolBinaryBody(req: IncomingMessage): Promise<string> {
  const limit = maxUploadBytes();
  const dir = importSpoolDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `upload-${randomUUID()}.zip`);
  const sink = createWriteStream(path, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > limit) {
        req.destroy();
        throw new CanonError('invalid', `Upload is larger than ${limit} bytes`, {
          limit,
          hint: 'Split the export, or raise CANON_IMPORT_UPLOAD_MAX_BYTES',
        });
      }
      if (!sink.write(chunk)) await new Promise<void>((r) => sink.once('drain', () => r()));
    }
    await new Promise<void>((r, j) => sink.end((err?: Error | null) => (err ? j(err) : r())));
    return path;
  } catch (err) {
    sink.destroy();
    rmSync(path, { force: true });
    throw err;
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      req.destroy();
      throw new CanonError('invalid', `Request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes`, {
        limit: MAX_REQUEST_BODY_BYTES,
      });
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CanonError('invalid', 'Request body must be JSON');
  }
  // Well-formed JSON is not the same as a body. `42`, `"hello"`, `null` and
  // `[…]` all parse, and every handler beneath here reads fields off the
  // result — so a bare string body silently becomes "no fields were sent"
  // rather than the mistake it is. See input.ts.
  return objectBody(parsed);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    // Defence in depth on the JSON surface: never let a browser sniff an API
    // response into something executable, and never leak the URL (which can
    // name a page) in a referrer. The document's full CSP lives in static.ts.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

export function createApi(
  store: CanonStore,
  agentAuth: AgentAuth | null = null,
  // One limiter per server, built from the deployment's environment
  // (ratelimit.ts). Passed in rather than reached for so a test can hand in a
  // tiny one — and so two servers in one process never share a bucket.
  limiter: RateLimiter = new RateLimiter(),
  /**
   * The people-facing door (auth.ts): SSO sessions, the dev opt-in, CSRF, and
   * the `/auth/…` routes. Optional so an in-process test rig can boot a bare
   * Canon; when it is absent the dev opt-in is still read from the
   * environment, so `X-Actor-Id` is refused there too unless
   * CANON_DEV_AUTH=true.
   */
  personAuth: PersonAuth | null = null,
  /**
   * Where a bug goes. The request LINE is written by `attachRequestLog` outside
   * this server (log.ts); what api.ts owns is the two things only it knows —
   * who the request resolved to, and the correlation id a `500` handed back —
   * which it hangs on the response with `noteRequest` for that wrapper to pick
   * up, plus the error line itself.
   */
  log: Logger = loggerFromEnv(),
): Server {
  const devAuth = personAuth ? personAuth.devAuth : devAuthEnabled();
  return createServer(async (req, res) => {
    // What this request will owe if it does the work. Declared out here so the
    // failure path can decide whether to charge it: a CanonError is a refusal
    // Canon reached without doing the work the bucket bounds — a malformed
    // body, a missing header, a closed gate — and none of those spends a
    // token. Anything else is a bug that got far enough to cost something, and
    // it pays.
    let charges: Charge[] = [];
    // A binary upload is streamed to the spool BEFORE the handler runs, so a
    // throw in between — an agent whose action vocabulary excludes this route,
    // a narrowing refusal — would orphan a file up to the upload cap. The
    // handler's own `finally` cleans it on the paths that reach the handler;
    // this is the belt for the paths that don't. rmSync(force) is idempotent,
    // so cleaning an already-cleaned file is a no-op.
    let spooledArchive: string | null = null;
    try {
      const url = new URL(req.url ?? '/', 'http://canon');
      // The door's own routes, before the record's route table: sign in, sign
      // out, and "who am I". They are deliberately absent from agentauth's
      // classification table, so an agent presenting a passport at one is
      // refused by the rule that already refuses every unclassified route.
      if (personAuth && personAuth.handles(url.pathname)) {
        if (await personAuth.handle(req, res, url)) return;
      }
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match || (match.devOnly && !devAuth)) {
        send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      // Who is asking. A session cookie is a person signed in through SSO;
      // X-Actor-Id is the dev stand-in and is refused when dev mode is off.
      // Awaited: past its window a session is re-confirmed with the identity
      // provider before it is served (SECURITY.md R9, auth.ts `confirm`), which
      // is a live call — the people-facing half of the sixty-second guarantee
      // the agent door already keeps.
      const identity: PersonIdentity = personAuth
        ? await personAuth.identify(req, res)
        : identifyFromHeader(req, devAuth);
      // An Agent Passport, when presented, wins over the dev header: it is
      // verified with the Registry and resolved to the agent's actor (Epic D).
      // It never wins over a session cookie — that is two identities in one
      // request, and the answer to that is a refusal.
      const passport = (req.headers['x-agent-passport'] as string) ?? '';
      let actorId = identity.actorId;
      let session: AgentSession | null = null;
      if (passport) {
        if (identity.viaCookie) {
          throw new CanonError(
            'forbidden',
            'A request carries a person’s identity or an agent’s passport, never both',
            { reason: 'identity_mismatch' },
          );
        }
        if (!agentAuth) throw passportAuthUnavailable();
        // Brute force is a sequence of FAILURES, so the bucket is checked
        // before the attempt and charged only when the attempt fails.
        limiter.check('auth', authKey(req));
        try {
          session = await agentAuth.authenticate(passport, actorId);
        } catch (err) {
          limiter.take('auth', authKey(req));
          throw err;
        }
        actorId = session.actorId;
        noteRequest(res, { actor: actorId, agent: true });
      } else if (personAuth) {
        // Cookies are ambient credentials, so an unsafe request that rode in
        // on one has to prove it was meant. See assertCsrf in auth.ts.
        personAuth.assertCsrf(req, identity);
      }
      // Who this request turned out to be, for the request line. The id and
      // nothing else: a name and an email address are what the directory is
      // for, and the audit log joins on the id anyway.
      if (actorId && !session) noteRequest(res, { actor: actorId });
      if (!match.open && !actorId) {
        if (!personAuth && !devAuth) throw devAuthRefused();
        send(res, 401, {
          error: 'unauthenticated',
          message: devAuth
            ? 'X-Actor-Id header required'
            : 'Sign in at /auth/login: this request carries no session and no Agent Passport',
        });
        return;
      }
      // Rate limiting, once identity is settled so the buckets can be keyed by
      // who is asking (SECURITY.md R8). CHECKED here — before the body is read
      // and long before any work is done, because an empty bucket must refuse
      // without first buffering eight megabytes — and CHARGED after the
      // handler returns, so a malformed body or a refusal at a gate costs
      // nobody a question (USER-TESTING.md T3.8). See `chargesFor` for why a
      // Studio ask draws on two buckets.
      charges = chargesFor(req.method ?? '', url.pathname, actorId, req.headers);
      for (const c of charges) limiter.check(c.bucket, c.key);
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const body = match.binary
        ? { archivePath: (spooledArchive = await spoolBinaryBody(req)) }
        : req.method === 'GET' || req.method === 'DELETE'
          ? {}
          : await readBody(req);
      // The Registry's half of the intersection, applied before the store
      // applies Canon's own permissions. Neither side can widen the other.
      const limits = session
        ? agentAuth!.enforce(session, {
            method: req.method ?? '',
            pathname: url.pathname,
            body,
            // Carried for the audit log only: a Registry refusal of a Studio
            // app's call still names the person the call was made for.
            onBehalfOf: (req.headers['x-on-behalf-of'] as string) ?? undefined,
          })
        : null;
      // Awaited: grounded answers are async (the embedding provider interface
      // is) and so is the outbox flush, which waits on a mail relay. Awaiting
      // a plain value changes nothing for every other handler.
      //
      // The handler runs inside the agent's request scope, so code beneath it
      // can ask who is asking without every signature carrying the answer.
      // That is how the reference layer refuses an individual reference whose
      // source the Registry withheld while still serving the page around it.
      const result = await runInAgentRequestScope(agentAuth, session, () =>
        match.handler({ store, actorId, params, query: url.searchParams, body, agent: session, headers: req.headers }),
      );
      // The work happened, so it is paid for. `charge` never refuses: a
      // concurrent request may have emptied the bucket while this one was
      // running, and an answer that has already been retrieved, generated and
      // cited must not be thrown away over an accounting race.
      for (const c of charges) limiter.charge(c.bucket, c.key);
      // Almost everything here is JSON; a handler that needs another content
      // type (the audit CSV download) returns a RawResponse and writes itself.
      // An agent's narrowing never applies to it: the CSV routes are not in
      // the agent action vocabulary, so agentauth refuses them outright.
      if (result instanceof RawResponse) result.writeTo(res);
      else {
        const payload = result ?? { ok: true };
        send(res, 200, limits ? limits.narrow(payload) : payload);
      }
    } catch (err) {
      if (err instanceof CanonError) {
        // A CanonError's message is WRITTEN FOR THE PERSON READING IT and is
        // kept exactly as it is. "This page is being edited by Marc", "A policy
        // requires a named approver before it can publish", "Only the named
        // approver can grant the Canonical mark" — those sentences are the
        // product telling somebody what to do next, and blanking them in the
        // name of security would make Canon unusable to protect nothing: every
        // one of them is composed here, from the record, for a caller the
        // store has already decided may know it.
        send(res, err.httpStatus, { error: err.code, message: err.message, ...err.details });
      } else {
        // Anything else is a bug, and its message was written for us, not for
        // the caller (SECURITY.md R7). `(err as Error).message` here used to
        // hand out SQLite statement text, absolute server filesystem paths and
        // whatever internals happened to be in the throw. The caller now gets
        // a correlation id and nothing else; the id, the method, the path and
        // the whole error — stack included — go to the server's log, where an
        // operator holding the id from a bug report can find the one line that
        // explains it. Correlatable, not disclosed.
        for (const c of charges) limiter.charge(c.bucket, c.key);
        const errorId = randomUUID();
        noteRequest(res, { errorId });
        // Through the logger rather than `console.error`, for two reasons. The
        // structured line is what an operator's collector can find by id, and
        // everything in it is scrubbed on the way out — where this used to
        // print `req.url` whole, it now prints the path with the query string
        // cut off, because `/auth/callback?code=…` is an authorization code and
        // `/search?q=…` is a sentence somebody typed.
        log.error('unhandled request error', {
          errorId,
          method: req.method ?? '',
          path: requestPath(req.url),
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        send(res, 500, {
          error: 'internal',
          message: 'Canon could not complete this request. Quote the error id when reporting it.',
          errorId,
        });
      }
    } finally {
      if (spooledArchive) rmSync(spooledArchive, { force: true });
    }
  });
}
