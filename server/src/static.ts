import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static serving for the Canon web UI (server/public). Kept apart from the
// API on purpose: api.ts stays a pure JSON surface, and this module wraps
// the server's request listener so unmatched GETs can fall through to the
// API's own 404. One call from index.ts is the entire integration.

// Compiled file lives at dist/server/src/static.js (the build is rooted a
// level up so tests can reach the registry-stub); public/ ships at
// server/public, three levels up from there.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Serve a file from public/ if the request names one (or "/", which serves
// index.html). Returns true when the response has been handled. Only plain
// file names directly inside public/ are ever served: no separators, no
// dotfiles, no traversal.
function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url ?? '/', 'http://canon').pathname;
  const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  const type = CONTENT_TYPES[extname(name).toLowerCase()];
  if (!type) return false;
  const file = join(dir, name);
  try {
    if (!statSync(file).isFile()) return false;
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.byteLength,
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

// Wrap the server's request handling: try the static files first, then fall
// through to whatever listeners (the API) were already attached.
export function attachStatic(server: Server, publicDir: string = PUBLIC_DIR): Server {
  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (serveStatic(req, res, publicDir)) return;
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}
