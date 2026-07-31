import { createServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AgentAuth, AgentSession, passportAuthUnavailable, runInAgentRequestScope } from './agentauth.js';
import { KNOWLEDGE_ROUTES } from './knowledge.js';
import { CanonError } from './model.js';
import { flushNotifications } from './notify.js';
import { CanonStore } from './store.js';
import { RawResponse } from './csv.js';

// A deliberately thin HTTP layer over the store. Actor identity arrives in
// the X-Actor-Id header for now; people get SSO later.
//
// Agents arrive by the other door (Epic D): a request carrying X-Agent-Passport is
// verified with the Veryl Agent Registry and resolved to an agent actor by
// agentauth.ts, which also applies the Registry's limits before the store
// sees the request. With no Registry configured (no CANON_REGISTRY_URL),
// Canon runs in dev mode: X-Actor-Id only, passport authentication refused
// with a clear message.

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
}

function route(method: string, path: string, handler: Handler, open = false): Route {
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
  return { method, pattern, names, handler, open };
}

const routes: Route[] = [
  route('GET', '/health', () => ({ ok: true, product: 'Veryl Canon', stage: 'alpha' }), true),

  route('POST', '/actors', ({ store, body }) => store.createActor(body), true),
  route('GET', '/actors', ({ store }) => store.listActors()),

  route('POST', '/collections', ({ store, actorId, body }) => store.createCollection(actorId, body)),
  route('GET', '/collections', ({ store, actorId }) => store.listCollections(actorId)),
  route('GET', '/collections/:id', ({ store, actorId, params }) => store.getCollection(actorId, params.id!)),
  route('GET', '/collections/:id/tree', ({ store, actorId, params }) => store.tree(actorId, params.id!)),
  route('GET', '/collections/:id/members', ({ store, actorId, params }) => store.listMembers(actorId, params.id!)),
  route('PUT', '/collections/:id/members/:memberId', ({ store, actorId, params, body }) => {
    store.setMember(actorId, params.id!, params.memberId!, body.role);
    return { ok: true };
  }),
  route('DELETE', '/collections/:id/members/:memberId', ({ store, actorId, params }) => {
    store.removeMember(actorId, params.id!, params.memberId!);
    return { ok: true };
  }),

  route('POST', '/pages', ({ store, actorId, body }) => store.createPage(actorId, body)),
  route('GET', '/pages/:id', ({ store, actorId, params }) => {
    const page = store.getPage(actorId, params.id!, { logView: true });
    const current = page.currentVersion ? store.getVersion(actorId, page.id, page.currentVersion) : null;
    // References travel inside the page payload the UI already fetches
    // (DATA-BACKBONE.md §6) — unresolved descriptors, so rendering the page
    // costs no external call. Resolution stays on GET /pages/:id/references.
    const references = store.listReferences(actorId, page.id);
    return { ...page, current, references };
  }),
  route('POST', '/pages/:id/move', ({ store, actorId, params, body }) =>
    store.movePage(actorId, params.id!, { parentId: body.parentId ?? null }),
  ),
  route('POST', '/pages/:id/archive', ({ store, actorId, params }) => store.archivePage(actorId, params.id!)),

  route('GET', '/pages/:id/draft', ({ store, actorId, params }) => store.getDraft(actorId, params.id!)),
  route('PUT', '/pages/:id/draft', ({ store, actorId, params, body }) => store.editDraft(actorId, params.id!, body)),
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

  route('GET', '/pages/:id/versions', ({ store, actorId, params }) => store.listVersions(actorId, params.id!)),
  route('GET', '/pages/:id/versions/:n', ({ store, actorId, params }) =>
    store.getVersion(actorId, params.id!, Number(params.n)),
  ),
  route('POST', '/pages/:id/restore', ({ store, actorId, params, body }) =>
    store.restore(actorId, params.id!, Number(body.version)),
  ),

  route('GET', '/search', ({ store, actorId, query }) =>
    store.searchIndex.search(actorId, {
      q: query.get('q') ?? '',
      collectionId: query.get('collection') ?? undefined,
      type: query.get('type') ?? undefined,
      status: query.get('status') ?? undefined,
      ownerId: query.get('owner') ?? undefined,
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    }),
  ),

  route('GET', '/audit', ({ store, actorId, query }) =>
    store.queryAudit(actorId, {
      actorId: query.get('actor') ?? undefined,
      action: query.get('action') ?? undefined,
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    }),
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
    flushNotifications(store, actorId, body?.limit === undefined ? undefined : Number(body.limit)),
  ),

  route('POST', '/ask', ({ store, actorId, body }) => store.ask(actorId, body ?? {})),
  route('GET', '/pages/:id/related', ({ store, actorId, params, query }) =>
    store.related(actorId, params.id!, {
      canonicalOnly: query.get('canonical') === 'true',
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    }),
  ),

  // Epic E, M4: the audit log as a CSV download, same filters as GET /audit,
  // and the Confluence and Google Docs importers.
  route('GET', '/audit.csv', ({ store, actorId, query }) =>
    store.auditCsv(actorId, {
      actorId: query.get('actor') ?? undefined,
      action: query.get('action') ?? undefined,
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    }),
  ),

  route('POST', '/imports', ({ store, actorId, body }) => store.runImport(actorId, body)),
  route('GET', '/imports', ({ store, actorId }) => store.listImportRuns(actorId)),
  route('GET', '/imports/:id', ({ store, actorId, params }) => store.getImportRun(actorId, params.id!)),

  // Federation (DATA-BACKBONE.md §6): registered sources, and resolving a
  // page's reference fields for the asking actor.
  route('POST', '/sources', ({ store, actorId, body }) => store.createSource(actorId, body)),
  route('GET', '/sources', ({ store, actorId }) => store.listSources(actorId)),
  route('GET', '/sources/:id', ({ store, actorId, params }) => store.getSource(actorId, params.id!)),
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

  // Veryl Studio's Knowledge API (STUDIO-CONTRACT.md). Its handlers live in
  // knowledge.ts, mounted here as ordinary routes so they meet the same
  // passport authentication and the same Registry enforcement as everything
  // else; what they add on top is the person the app is acting for, and the
  // three-way intersection that follows from naming both.
  ...KNOWLEDGE_ROUTES.map((r) => route(r.method, r.path, r.handler)),
];

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new CanonError('invalid', 'Request body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

export function createApi(store: CanonStore, agentAuth: AgentAuth | null = null): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://canon');
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      // An Agent Passport, when presented, wins: it is verified with the
      // Registry and resolved to the agent's actor (Epic D). X-Actor-Id
      // remains the path for people (and dev mode).
      const passport = (req.headers['x-agent-passport'] as string) ?? '';
      let actorId = (req.headers['x-actor-id'] as string) ?? '';
      let session: AgentSession | null = null;
      if (passport) {
        if (!agentAuth) throw passportAuthUnavailable();
        session = await agentAuth.authenticate(passport, actorId);
        actorId = session.actorId;
      }
      if (!match.open && !actorId) {
        send(res, 401, { error: 'unauthenticated', message: 'X-Actor-Id header required' });
        return;
      }
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
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
        send(res, err.httpStatus, { error: err.code, message: err.message, ...err.details });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    }
  });
}
