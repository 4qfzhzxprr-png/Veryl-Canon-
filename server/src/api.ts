import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { CanonError } from './model.js';
import { CanonStore } from './store.js';

// A deliberately thin HTTP layer over the store. Actor identity arrives in
// the X-Actor-Id header for now; people get SSO and agents get Agent
// Passport authentication when the Registry contract lands (Epic D).

type Handler = (ctx: {
  store: CanonStore;
  actorId: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
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
    return { ...page, current };
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

  route('POST', '/ask', ({ store, actorId, body }) => store.ask(actorId, body ?? {})),
  route('GET', '/pages/:id/related', ({ store, actorId, params, query }) =>
    store.related(actorId, params.id!, {
      canonicalOnly: query.get('canonical') === 'true',
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    }),
  ),
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

export function createApi(store: CanonStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://canon');
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      const actorId = (req.headers['x-actor-id'] as string) ?? '';
      if (!match.open && !actorId) {
        send(res, 401, { error: 'unauthenticated', message: 'X-Actor-Id header required' });
        return;
      }
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await match.handler({ store, actorId, params, query: url.searchParams, body });
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof CanonError) {
        send(res, err.httpStatus, { error: err.code, message: err.message, ...err.details });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    }
  });
}
