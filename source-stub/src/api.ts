import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { ASKER_HEADER, BenefitsError } from './model.js';
import { BenefitsStore } from './store.js';

// The two faces of the benefits administrator: the lookup face Canon's
// connector calls (GET /lookup, by key and selector, for a named caller) and
// the administrative face a test or demonstration drives (seed plans, grant
// entitlements, break the system on purpose). The real system authenticates
// its administrative face; the stub, being a test double, leaves it open —
// the same liberty registry-stub takes, and the only one taken here.
//
// The lookup face is deliberately narrow. GET /search exists only to answer
// 501: a record system that cannot enumerate cannot be ranked, and a stub
// that quietly grew a search endpoint would let Canon be designed against a
// capability the real system does not have.

type Handler = (ctx: {
  store: BenefitsStore;
  params: Record<string, string>;
  query: URLSearchParams;
  asker: string | undefined;
  body: any;
}) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
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
  return { method, pattern, names, handler };
}

const routes: Route[] = [
  route('GET', '/health', () => ({ ok: true, product: 'Benefits Administration', stage: 'stub' })),

  // Lookup face: the whole of Canon's dependency.
  route('GET', '/lookup', ({ store, query, asker }) =>
    store.lookup(asker, query.get('key'), query.get('selector')),
  ),

  // Not an oversight. See the note above.
  route('GET', '/search', () => {
    throw new BenefitsError(
      'not_supported',
      'This system answers by key and selector only. There is no search, and nothing here can be enumerated or ranked.',
    );
  }),

  // Administrative face.
  route('POST', '/admin/plans', ({ store, body }) => store.seedPlan(body ?? {})),
  route('GET', '/admin/plans', ({ store }) => store.listPlans()),
  route('PUT', '/admin/entitlements/:asker', ({ store, params, body }) =>
    store.setEntitlements(params.asker!, body ?? {}),
  ),
  route('GET', '/admin/entitlements', ({ store }) => store.listEntitlements()),
  route('PUT', '/admin/behaviour', ({ store, body }) => store.setBehaviour(body ?? {})),
  route('GET', '/admin/behaviour', ({ store }) => store.behaviour),
];

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BenefitsError('invalid', 'Request body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createBenefitsApi(store: BenefitsStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://benefits');
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const header = req.headers[ASKER_HEADER];
      const asker = Array.isArray(header) ? header[0] : header;
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await match.handler({ store, params, query: url.searchParams, asker, body });
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof BenefitsError) {
        send(res, err.httpStatus, { error: err.code, message: err.message, ...err.details });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    }
  });
}
