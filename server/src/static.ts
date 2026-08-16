import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static serving for the Canon web UI (server/public). Kept apart from the
// API on purpose: api.ts stays a pure JSON surface, and this module wraps
// the server's request listener so unmatched GETs can fall through to the
// API's own 404. One call from index.ts is the entire integration.

// Compiled file lives at dist/server/src/static.js (the build is rooted a
// level up so tests can reach the registry-stub); the served directories ship
// beside each other three levels up from there.
//
//   public/      the original client — index.html, app.js, styles.css
//   public-app/  the React client's build output (web/, see web/MIGRATION.md)
//
// Both ship in every image. Which one `/` serves is CANON_UI's decision, and
// the other is always reachable, because the two clients hand routes to each
// other while the migration is in progress.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const APP_DIR = join(ROOT, 'public-app');

/** Which client `/` serves. See CONFIGURATION.md, CANON_UI. */
export type Ui = 'react' | 'classic';

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

// One directory deep, and only into a directory a build actually writes.
//
// The rule used to be "a plain file name directly inside public/" — no
// separator at all — which was right for a client that was three files and
// wrong the moment one of them was a bundler. Vite emits `assets/index-<hash>.js`
// and copies `web/public/fonts/` verbatim, so a flat-only rule serves the
// document and then 404s every script it references: a blank page, and nothing
// in the log saying why.
//
// This is the smallest widening that admits those two and nothing else. Every
// segment still has to pass the same strict pattern, so `..`, a dotfile, a
// backslash and an empty segment are all still refused — and they are refused
// AFTER percent-decoding, which is where an encoded traversal would otherwise
// slip through.
const NESTED_DIRS = new Set(['assets', 'fonts']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The path this request names, relative to a served directory, or null if it
 *  is not a name we will ever serve.
 *
 *  Exported for its own tests. It is the whole of the path safety here, and it
 *  is worth proving directly rather than only through a client that normalises
 *  half the interesting inputs before they reach the wire. */
export function requestedFile(pathname: string): string | null {
  let raw: string;
  try {
    raw = decodeURIComponent(pathname.slice(1));
  } catch {
    return null; // a malformed escape is not a file name
  }
  const parts = raw.split('/');
  if (parts.length > 2) return null;
  if (parts.length === 2 && !NESTED_DIRS.has(parts[0]!)) return null;
  if (!parts.every((segment) => SEGMENT.test(segment))) return null;
  return parts.join('/');
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  type: string,
  hsts: boolean,
  immutable: boolean,
): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.byteLength,
      // A bundler puts the content's hash in the file name, so the URL changes
      // whenever the bytes do and this can be cached forever. Everything else —
      // the document above all — stays `no-cache`, because a cached index.html
      // points at chunk names that the next deploy deleted.
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
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

/**
 * Serve a file if the request names one. Returns true when the response has
 * been handled, false to fall through to the API — including for anything that
 * fails the name rules above, which is why a rejected path gets the API's own
 * 404 rather than a static one.
 *
 * There is deliberately NO single-page-app fallback here: an unmatched path
 * does not become index.html. Canon's clients route on the fragment, which
 * never reaches the server, so nothing needs it — and a catch-all would answer
 * every mistyped API path with an HTML document, which is how a fetch starts
 * reporting "unexpected token <" instead of 404.
 */
function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  dirs: { app: string; classic: string },
  ui: Ui,
  hsts: boolean,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url ?? '/', 'http://canon').pathname;

  // The two documents. `/` is whichever client this deployment serves, and
  // `/classic.html` is ALWAYS the original — that is the address the React
  // client sends a route it has not taken over to, so it cannot be allowed to
  // depend on the flag.
  if (pathname === '/' || pathname === '/classic.html') {
    const dir = pathname === '/' && ui === 'react' ? dirs.app : dirs.classic;
    return send(req, res, join(dir, 'index.html'), 'text/html; charset=utf-8', hsts, false);
  }

  const name = requestedFile(pathname);
  if (name === null) return false;
  const type = CONTENT_TYPES[extname(name).toLowerCase()];
  if (!type) return false;

  // Both directories are searched whichever client is active, because both
  // clients are reachable at once: `/classic.html` needs app.js and styles.css
  // out of public/ even on a deployment serving React from public-app/. The
  // only name they share is index.html, which never reaches here.
  const immutable = name.startsWith('assets/');
  for (const dir of [dirs.app, dirs.classic]) {
    if (send(req, res, join(dir, name), type, hsts, immutable)) return true;
  }
  return false;
}

export interface StaticOptions {
  /** The original client. Defaults to the shipped `public/`. */
  publicDir?: string;
  /** The React client's build output. Defaults to the shipped `public-app/`. */
  appDir?: string;
  /** Which client `/` serves. Defaults to the original. */
  ui?: Ui;
  /**
   * The deployment's HTTPS signal — index.ts derives it from CANON_BASE_URL, so
   * the upgrade is only pinned where the edge is genuinely secure.
   */
  hsts?: boolean;
}

// Wrap the server's request handling: try the static files first, then fall
// through to whatever listeners (the API) were already attached. One call from
// index.ts is the entire integration.
export function attachStatic(server: Server, opts: StaticOptions = {}): Server {
  const dirs = { app: opts.appDir ?? APP_DIR, classic: opts.publicDir ?? PUBLIC_DIR };
  const ui = opts.ui ?? 'classic';
  const hsts = opts.hsts ?? false;
  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (serveStatic(req, res, dirs, ui, hsts)) return;
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}

/**
 * Which client this deployment should serve, given the operator's setting and
 * whether the React client was actually built into the image.
 *
 * Asking for `react` without the build present is a broken deploy, not a
 * security fault, so it degrades to the client that IS there rather than
 * refusing to start — a Canon serving the old UI is a working Canon, and a
 * Canon that will not boot is not. It has to be loud, though: `reason` is
 * returned for the caller to log, because the failure mode this replaces is
 * "the flag is on and nobody can tell it did nothing".
 */
export function resolveUi(
  requested: string | undefined,
  appDir: string = APP_DIR,
): { ui: Ui; reason?: string } {
  const want = (requested ?? '').trim().toLowerCase();
  if (want !== 'react') return { ui: 'classic' };
  try {
    if (statSync(join(appDir, 'index.html')).isFile()) return { ui: 'react' };
  } catch {
    /* not built */
  }
  return {
    ui: 'classic',
    reason: `CANON_UI=react but no built client at ${appDir}; serving the original one`,
  };
}
