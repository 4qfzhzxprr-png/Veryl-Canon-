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
  // The brand typeface, served from this origin. `default-src 'self'` already
  // covers font-src, so no policy change is needed — but the extension has to
  // be listed here or the file is simply not served and the page silently
  // falls back to the system stack, which is how a suite stops looking like one.
  '.woff2': 'font/woff2',
};

// The web UI's Content-Security-Policy. Canon's front end is deliberately
// self-contained — index.html loads one stylesheet and one ES module, both
// same-origin, and app.js carries no inline <script>, no inline event handler,
// and no eval — so `script-src 'self'` costs the app nothing and shuts the
// main injection vector. `style-src` must allow inline styles: app.js sets a
// handful of style="" attributes on skeleton widths and on the SVG map's CSS
// custom properties (--h, --d), which inline styles cannot execute script and
// which a strict policy would only break. Images allow data: (the favicon is a
// data URI) and https: (a policy page may embed one), never http:. Everything
// else falls back to `self`; framing, plugins and a rewritten <base> are shut
// outright, which is the clickjacking and base-tag protection X-Frame-Options
// only half gives.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
].join('; ');

/**
 * The headers every response from Canon should carry, whatever it serves. Kept
 * here beside the CSP so the web UI and the JSON API set the same baseline from
 * one definition. HSTS is the one that depends on the deployment: a browser
 * ignores it over plain HTTP (Canon speaks HTTP behind a TLS proxy), and
 * sending it when the record is genuinely served over HTTPS is what pins the
 * upgrade — so it is emitted only when the operator's base URL says the edge is
 * secure. `nosniff` and a tight referrer policy are safe on every transport and
 * always sent.
 */
export function securityHeaders(opts: { html: boolean; hsts: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (opts.html) {
    headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
    headers['x-frame-options'] = 'DENY';
    headers['cross-origin-opener-policy'] = 'same-origin';
  }
  if (opts.hsts) {
    // Two years, subdomains included, preload-eligible — the modern default.
    headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains; preload';
  }
  return headers;
}

// Serve a file from public/ if the request names one (or "/", which serves
// index.html). Returns true when the response has been handled. Only plain
// file names directly inside public/ are ever served: no separators, no
// dotfiles, no traversal.
function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, hsts: boolean): boolean {
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
      // The document carries the full policy; sub-resources carry the transport
      // headers only. `nosniff` matters on every one of them.
      ...securityHeaders({ html: type.startsWith('text/html'), hsts }),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

// Wrap the server's request handling: try the static files first, then fall
// through to whatever listeners (the API) were already attached. `hsts` is the
// deployment's HTTPS signal (index.ts derives it from CANON_BASE_URL), so the
// upgrade is only pinned where the edge is genuinely secure.
export function attachStatic(server: Server, publicDir: string = PUBLIC_DIR, hsts = false): Server {
  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (serveStatic(req, res, publicDir, hsts)) return;
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}
