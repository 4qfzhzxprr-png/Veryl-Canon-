// The three faces of an OpenID Connect provider, as a stub.
//
// 1. The discovery face — `/.well-known/openid-configuration` and
//    `/jwks.json` — which a client reads before it does anything.
// 2. The flow face — `/authorize`, `/token`, `/userinfo` — which carries an
//    Authorization Code flow with PKCE.
// 3. An administrative face — `/admin/…` — to seed users and clients, change
//    a user's email, and tell the provider to misbehave in one named way.
//
// Like registry-stub and source-stub, the administrative face is deliberately
// unauthenticated and this stub is not deployable. That is what "stub" is
// doing in the name.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { IdpError } from './model.js';
import { IdpStore } from './store.js';

type Handler = (ctx: { store: IdpStore; params: Record<string, string>; body: any }) => unknown;

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

// Everything that answers with plain JSON. `/authorize` and `/token` are not
// here: one redirects and one speaks form encoding, so both are handled by
// hand below.
const routes: Route[] = [
  route('GET', '/health', ({ store }) => ({ ok: true, product: 'Veryl Canon IdP', stage: 'stub', issuer: store.issuer })),
  route('GET', '/.well-known/openid-configuration', ({ store }) => store.discovery()),
  route('GET', '/jwks.json', ({ store }) => store.jwks()),

  route('POST', '/admin/users', ({ store, body }) => store.seedUser(body ?? {})),
  route('GET', '/admin/users', ({ store }) => store.listUsers()),
  route('PUT', '/admin/users/:sub', ({ store, params, body }) => store.updateUser(params.sub!, body ?? {})),
  route('POST', '/admin/clients', ({ store, body }) => store.registerClient(body ?? {})),
  route('POST', '/admin/quirk', ({ store, body }) => store.setQuirk(String(body?.quirk ?? 'none'))),
  route('GET', '/admin/quirk', ({ store }) => ({ quirk: store.currentQuirk() })),
  // Which claim the groups are issued in. A deployment's is configuration, so
  // a stub that could only ever say `groups` could not test that Canon's own
  // setting does anything.
  route('POST', '/admin/groups-claim', ({ store, body }) => store.setGroupsClaim(String(body?.claim ?? 'groups'))),
  route('GET', '/admin/groups-claim', ({ store }) => ({ claim: store.currentGroupsClaim() })),
];

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    // A provider has no reason to accept a large body; refusing early keeps
    // one request from holding the process's memory.
    if (size > 1024 * 1024) {
      req.destroy();
      throw new IdpError('invalid_request', 'Request body is too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new IdpError('invalid_request', 'Request body must be JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Client authentication: `client_secret_basic` or `client_secret_post`. */
function clientCredentials(req: IncomingMessage, form: URLSearchParams): { clientId: string; clientSecret: string } {
  const header = req.headers.authorization;
  if (header && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, colon)),
        clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
      };
    }
  }
  return { clientId: form.get('client_id') ?? '', clientSecret: form.get('client_secret') ?? '' };
}

// ---- /authorize ----------------------------------------------------------
//
// A real provider shows a login screen. This one accepts `login_hint` naming
// the subject and issues the code straight away, which is what makes the
// whole flow drivable from a test with no browser; without one it renders the
// smallest possible picker so a person can still walk the flow by hand.

function handleAuthorize(store: IdpStore, url: URL, res: ServerResponse): void {
  const q = url.searchParams;
  const redirectUri = q.get('redirect_uri') ?? '';
  const state = q.get('state');
  const loginHint = q.get('login_hint');

  if (!loginHint) {
    const users = store.listUsers();
    const rows = users
      .map((u) => {
        const next = new URL(url.href);
        next.searchParams.set('login_hint', u.sub);
        return `<li><a href="${esc(next.pathname + next.search)}">${esc(u.name)}${
          u.email ? ` &lt;${esc(u.email)}&gt;` : ''
        }</a></li>`;
      })
      .join('');
    sendHtml(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>Sign in</title>` +
        `<h1>Sign in (stub identity provider)</h1>` +
        (users.length
          ? `<p>Choose who you are. This provider verifies nothing; it is a test double.</p><ul>${rows}</ul>`
          : `<p>No users are seeded. POST /admin/users first.</p>`),
    );
    return;
  }

  try {
    const { code } = store.authorize({
      clientId: q.get('client_id') ?? '',
      redirectUri,
      responseType: q.get('response_type') ?? '',
      scope: q.get('scope') ?? 'openid',
      nonce: q.get('nonce'),
      codeChallenge: q.get('code_challenge') ?? '',
      codeChallengeMethod: q.get('code_challenge_method') ?? '',
      sub: loginHint,
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    res.writeHead(302, { location: back.href, 'cache-control': 'no-store' });
    res.end();
  } catch (err) {
    // An error reaches the client through the redirect only when the redirect
    // itself was validated. Anything wrong with `client_id` or `redirect_uri`
    // is answered here, because bouncing to an unvalidated URI is how a
    // provider becomes an open redirect.
    const failed = err as IdpError;
    const redirectable = failed.code !== 'invalid_client' && redirectUri && !/redirect_uri/.test(failed.message);
    if (redirectable) {
      try {
        const back = new URL(redirectUri);
        back.searchParams.set('error', failed.code);
        back.searchParams.set('error_description', failed.message);
        if (state) back.searchParams.set('state', state);
        res.writeHead(302, { location: back.href, 'cache-control': 'no-store' });
        res.end();
        return;
      } catch {
        /* not a URL; fall through to the JSON refusal */
      }
    }
    send(res, failed.httpStatus ?? 400, { error: failed.code ?? 'invalid_request', error_description: failed.message });
  }
}

export function createIdpApi(store: IdpStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', store.issuer);

      if (url.pathname === '/authorize' && req.method === 'GET') {
        handleAuthorize(store, url, res);
        return;
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readRaw(req));
        const { clientId, clientSecret } = clientCredentials(req, form);
        const tokens = store.exchange({
          grantType: form.get('grant_type') ?? '',
          code: form.get('code') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          clientId,
          clientSecret,
          codeVerifier: form.get('code_verifier') ?? '',
          refreshToken: form.get('refresh_token') ?? '',
        });
        send(res, 200, tokens);
        return;
      }

      if (url.pathname === '/userinfo' && req.method === 'GET') {
        const header = req.headers.authorization ?? '';
        send(res, 200, store.userinfo(header.startsWith('Bearer ') ? header.slice(7) : ''));
        return;
      }

      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        send(res, 404, { error: 'not_found', error_description: `No route: ${req.method} ${url.pathname}` });
        return;
      }
      const groups = url.pathname.match(match.pattern)!.slice(1);
      const params: Record<string, string> = {};
      match.names.forEach((name, i) => (params[name] = decodeURIComponent(groups[i]!)));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      send(res, 200, match.handler({ store, params, body }) ?? { ok: true });
    } catch (err) {
      if (err instanceof IdpError) {
        send(res, err.httpStatus, { error: err.code, error_description: err.message, ...err.details });
      } else {
        send(res, 500, { error: 'server_error', error_description: (err as Error).message });
      }
    }
  });
}
