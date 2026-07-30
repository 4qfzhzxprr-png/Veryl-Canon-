import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { RegistryError } from './model.js';
import { RegistryStore } from './store.js';

// The two faces of REGISTRY-CONTRACT.md §6: the verification face Canon
// calls (POST /verify) and the administrative face the demonstration
// drives (register, certify, revoke, permissions, listing). The real
// Registry authenticates its administrative face; the stub, being a test
// double, leaves it open — and that is the only liberty it takes.

type Handler = (ctx: {
  store: RegistryStore;
  params: Record<string, string>;
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
  route('GET', '/health', () => ({ ok: true, product: 'Veryl Agent Registry', stage: 'stub' })),

  // Verification face: the whole of Canon's dependency.
  route('POST', '/verify', ({ store, body }) => store.verify(body.passport)),

  // Administrative face.
  route('POST', '/agents', ({ store, body }) => store.register(body)),
  route('GET', '/agents', ({ store }) => store.list()),
  route('POST', '/agents/:id/certify', ({ store, params, body }) => store.certify(params.id!, body ?? {})),
  route('POST', '/agents/:id/revoke', ({ store, params, body }) => store.revoke(params.id!, body ?? {})),
  route('PUT', '/agents/:id/permissions', ({ store, params, body }) => store.setPermissions(params.id!, body ?? {})),
];

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RegistryError('invalid', 'Request body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createRegistryApi(store: RegistryStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://registry');
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = match.handler({ store, params, body });
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof RegistryError) {
        send(res, err.httpStatus, { error: err.code, message: err.message, ...err.details });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    }
  });
}
