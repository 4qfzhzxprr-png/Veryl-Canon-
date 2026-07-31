// The people-facing door, end to end (SECURITY.md R1 and R2; server/src/auth.ts).
//
// Canon's API is booted against the real idp-stub in-process, exactly as
// agentauth.test.ts is booted against the real registry-stub: the flow under
// test is a genuine Authorization Code exchange with PKCE against a genuine
// provider, and the only thing a live identity provider would change is the
// issuer URL.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createIdpApi } from '../../idp-stub/src/api.js';
import { IdpStore } from '../../idp-stub/src/store.js';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { CSRF_HEADER, OidcClient, PersonAuth, safeReturnTo, subjectKey, SESSION_COOKIE } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

// ---------------------------------------------------------------------------
// Rig

/** A hand-rolled cookie jar: `fetch` has none, and cookies are the point here. */
class Jar {
  readonly cookies = new Map<string, string>();

  absorb(res: Response): this {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

/**
 * A port nobody is listening on. Canon's redirect URI has to be registered at
 * the provider before Canon starts, and it must be Canon's real origin,
 * because that origin is also what the CSRF check allows.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Rig {
  idp: IdpStore;
  idpServer: Server;
  registry: RegistryStore;
  registryServer: Server | null;
  canonBase: string;
  db: DatabaseSync;
  store: CanonStore;
  personAuth: PersonAuth;
  call: (
    method: string,
    path: string,
    opts?: { jar?: Jar; actor?: string; passport?: string; csrf?: string; origin?: string; body?: unknown },
  ) => Promise<{ status: number; json: any; res: Response }>;
  signIn: (sub: string, jar?: Jar) => Promise<{ jar: Jar; status: number; res: Response }>;
  csrfFor: (jar: Jar) => Promise<string>;
  close: () => void;
}

async function rig(
  opts: {
    devAuth?: boolean;
    sso?: boolean;
    withRegistry?: boolean;
    sessionTtlMs?: number;
    sessionMaxLifetimeMs?: number;
  } = {},
): Promise<Rig> {
  const idp = new IdpStore();
  const idpServer = createIdpApi(idp);
  await new Promise<void>((resolve) => idpServer.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;

  const port = await freePort();
  const canonBase = `http://127.0.0.1:${port}`;
  const client = idp.registerClient({
    clientId: 'veryl-canon',
    clientSecret: 'canon-test-secret',
    redirectUris: [`${canonBase}/auth/callback`],
  });
  idp.seedUser({ sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' });
  idp.seedUser({ sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' });

  const registry = new RegistryStore();
  let registryServer: Server | null = null;
  let agentAuth: AgentAuth | null = null;
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  if (opts.withRegistry) {
    registryServer = createRegistryApi(registry);
    await new Promise<void>((resolve) => registryServer!.listen(0, '127.0.0.1', resolve));
    agentAuth = new AgentAuth({
      db,
      store,
      registry: new RegistryClient({
        baseUrl: `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`,
        cacheTtlMs: 0,
        requestTimeoutMs: 500,
      }),
    });
  }

  const personAuth = new PersonAuth({
    db,
    store,
    devAuth: opts.devAuth ?? false,
    oidc:
      opts.sso === false
        ? null
        : {
            issuer: idp.issuer,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            redirectUri: `${canonBase}/auth/callback`,
            scope: 'openid profile email',
            clockToleranceSec: 5,
            requestTimeoutMs: 1000,
            metadataTtlMs: 60_000,
          },
    sessionSecret: Buffer.from('a-fixed-test-secret'),
    sessionTtlMs: opts.sessionTtlMs,
    sessionMaxLifetimeMs: opts.sessionMaxLifetimeMs,
    secureCookies: false, // the test rig speaks http, exactly as localhost does
  });

  const canon = createApi(store, agentAuth, undefined, personAuth);
  await new Promise<void>((resolve) => canon.listen(port, '127.0.0.1', resolve));

  const call = async (
    method: string,
    path: string,
    o: { jar?: Jar; actor?: string; passport?: string; csrf?: string; origin?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(canonBase + path, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(o.jar && o.jar.cookies.size ? { cookie: o.jar.header() } : {}),
        ...(o.actor ? { 'x-actor-id': o.actor } : {}),
        ...(o.passport ? { 'x-agent-passport': o.passport } : {}),
        ...(o.csrf ? { [CSRF_HEADER]: o.csrf } : {}),
        ...(o.origin ? { origin: o.origin } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    if (o.jar) o.jar.absorb(res);
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* redirects and empty bodies */
    }
    return { status: res.status, json, res };
  };

  // The whole flow, driven by hand because there is no browser: Canon's
  // /auth/login, the provider's /authorize, and back to Canon's /auth/callback.
  const signIn = async (sub: string, jar = new Jar()) => {
    const login = await fetch(`${canonBase}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302, 'login redirects to the provider');
    const authorize = new URL(login.headers.get('location')!);
    authorize.searchParams.set('login_hint', sub);
    const bounced = await fetch(authorize.href, { redirect: 'manual' });
    assert.equal(bounced.status, 302, await bounced.text());
    const back = new URL(bounced.headers.get('location')!);
    const res = await fetch(`${canonBase}/auth/callback${back.search}`, { redirect: 'manual' });
    jar.absorb(res);
    return { jar, status: res.status, res };
  };

  const csrfFor = async (jar: Jar) => {
    const session = await call('GET', '/auth/session', { jar });
    return session.json.csrfToken as string;
  };

  return {
    idp,
    idpServer,
    registry,
    registryServer,
    canonBase,
    db,
    store,
    personAuth,
    call,
    signIn,
    csrfFor,
    close: () => {
      canon.close();
      idpServer.close();
      registryServer?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The flow

test('SSO: the full Authorization Code flow with PKCE signs a person in', async () => {
  const r = await rig();
  try {
    // The redirect to the provider carries state, nonce and a PKCE challenge —
    // and the challenge, never the verifier.
    const login = await fetch(`${r.canonBase}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const authorize = new URL(login.headers.get('location')!);
    assert.equal(authorize.origin, r.idp.issuer);
    assert.equal(authorize.pathname, '/authorize');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize.searchParams.get('code_challenge'));
    assert.ok(authorize.searchParams.get('state'));
    assert.ok(authorize.searchParams.get('nonce'));
    assert.equal(authorize.searchParams.get('redirect_uri'), `${r.canonBase}/auth/callback`);
    assert.equal(authorize.searchParams.get('code_verifier'), null, 'the verifier never leaves Canon');

    const { jar, status, res } = await r.signIn('dana');
    assert.equal(status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.ok(jar.has(SESSION_COOKIE));

    // The cookie is the credential the whole rest of this file relies on.
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/); // this rig is local http; see the Secure test below

    const session = await r.call('GET', '/auth/session', { jar });
    assert.equal(session.json.mode, 'sso');
    assert.equal(session.json.authenticated, true);
    assert.equal(session.json.actor.name, 'Dana Whitfield');
    assert.equal(session.json.actor.email, 'dana@example.com');
    assert.ok(session.json.csrfToken);

    // And the cookie actually authorises work on the record.
    const csrf = await r.csrfFor(jar);
    const created = await r.call('POST', '/collections', {
      jar,
      csrf,
      origin: r.canonBase,
      body: { name: 'Compliance' },
    });
    assert.equal(created.status, 200);
    const collections = await r.call('GET', '/collections', { jar });
    assert.equal(collections.json.length, 1);
  } finally {
    r.close();
  }
});

test('SSO: `Secure` is set on the cookie when the deployment is not local', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const auth = new PersonAuth({ db, store, devAuth: false, oidc: null, secureCookies: true });
  const session = auth.createSession(store.createActor({ kind: 'person', name: 'Dana' }).id, 'sub-1');
  // The cookie is written by the private setter, so it is observed through a
  // response the way a client would see it.
  const chunks: string[] = [];
  const res = {
    getHeader: () => undefined,
    setHeader: (_n: string, v: string[]) => chunks.push(...v),
  } as unknown as import('node:http').ServerResponse;
  (auth as unknown as { setSessionCookie: (r: unknown, s: unknown) => void }).setSessionCookie(res, session);
  assert.match(chunks[0]!, /Secure/);
  assert.match(chunks[0]!, /HttpOnly/);
});

// ---------------------------------------------------------------------------
// Just-in-time provisioning

test('JIT: a first sign-in provisions an actor; a second reuses it', async () => {
  const r = await rig();
  try {
    assert.equal(r.store.listActors().length, 0);

    const first = await r.signIn('dana');
    assert.equal(first.status, 302);
    const actors = r.store.listActors();
    assert.equal(actors.length, 1);
    assert.equal(actors[0]!.kind, 'person');
    assert.equal(actors[0]!.name, 'Dana Whitfield');
    assert.equal(actors[0]!.email, 'dana@example.com');

    const second = await r.signIn('dana');
    assert.equal(second.status, 302);
    assert.equal(r.store.listActors().length, 1, 'no second actor for the same person');

    // A different subject is a different person.
    await r.signIn('iris');
    assert.equal(r.store.listActors().length, 2);

    const events = r.store.queryAudit(actors[0]!.id, {});
    assert.ok(events.some((e) => e.action === 'person.provisioned'));
    assert.ok(events.some((e) => e.action === 'person.session'));
  } finally {
    r.close();
  }
});

test('JIT: the match is on the subject, never on the email address', async () => {
  const r = await rig();
  try {
    await r.signIn('dana');
    const before = r.store.listActors()[0]!;

    // Dana marries and her address changes. Same person, same subject.
    r.idp.updateUser('dana', { email: 'dana.whitfield@example.com', name: 'Dana Whitfield-Amos' });
    await r.signIn('dana');
    const after = r.store.listActors();
    assert.equal(after.length, 1, 'an email change is not a new person');
    assert.equal(after[0]!.id, before.id);
    assert.equal(after[0]!.email, 'dana.whitfield@example.com', 'the claim follows the provider');
    assert.equal(after[0]!.name, 'Dana Whitfield-Amos');

    // And her old address, reassigned to somebody else, is somebody else.
    r.idp.seedUser({ sub: 'newcomer', name: 'Sam Reyes', email: 'dana@example.com' });
    await r.signIn('newcomer');
    const withNewcomer = r.store.listActors();
    assert.equal(withNewcomer.length, 2, 'reusing an address does not inherit an identity');
    assert.notEqual(withNewcomer.find((a) => a.name === 'Sam Reyes')!.id, before.id);
  } finally {
    r.close();
  }
});

test('JIT: the stored key is qualified by issuer, so two providers cannot collide', () => {
  assert.equal(subjectKey('https://a.example', 'user-1'), 'https://a.example#user-1');
  assert.notEqual(subjectKey('https://a.example', 'user-1'), subjectKey('https://b.example', 'user-1'));
});

// ---------------------------------------------------------------------------
// ID-token validation: every refusal, driven by a provider that really lies

for (const [quirk, reason] of [
  ['bad_signature', 'bad_signature'],
  ['unknown_kid', 'unknown_kid'],
  ['wrong_issuer', 'wrong_issuer'],
  ['wrong_audience', 'wrong_audience'],
  ['expired', 'expired'],
  ['wrong_nonce', 'bad_nonce'],
  ['no_nonce', 'missing_nonce'],
  ['alg_none', 'bad_algorithm'],
] as const) {
  test(`validation: an ID token with ${quirk.replace(/_/g, ' ')} is refused (${reason})`, async () => {
    const r = await rig();
    try {
      r.idp.setQuirk(quirk);
      const { jar, status, res } = await r.signIn('dana');
      assert.equal(status, 401, `${quirk} must not sign anybody in`);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'unauthenticated');
      assert.equal(body.reason, reason);
      assert.equal(jar.has(SESSION_COOKIE), false, 'no session is issued on a refusal');
      assert.equal(r.store.listActors().length, 0, 'and nobody is provisioned');
    } finally {
      r.close();
    }
  });
}

test('validation: a replayed callback is refused, because state and nonce are single-use', async () => {
  const r = await rig();
  try {
    const login = await fetch(`${r.canonBase}/auth/login`, { redirect: 'manual' });
    const authorize = new URL(login.headers.get('location')!);
    authorize.searchParams.set('login_hint', 'dana');
    const bounced = await fetch(authorize.href, { redirect: 'manual' });
    const back = new URL(bounced.headers.get('location')!);

    const first = await fetch(`${r.canonBase}/auth/callback${back.search}`, { redirect: 'manual' });
    assert.equal(first.status, 302);

    // The same code and the same state, presented again.
    const replay = await fetch(`${r.canonBase}/auth/callback${back.search}`, { redirect: 'manual' });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).reason, 'unknown_state');
  } finally {
    r.close();
  }
});

test('validation: a callback that started nowhere is refused', async () => {
  const r = await rig();
  try {
    const forged = await fetch(`${r.canonBase}/auth/callback?code=whatever&state=invented`, { redirect: 'manual' });
    assert.equal(forged.status, 401);
    assert.equal((await forged.json()).reason, 'unknown_state');
  } finally {
    r.close();
  }
});

test('validation: a mismatched PKCE verifier cannot redeem the code', async () => {
  const r = await rig();
  try {
    const client = new OidcClient({
      issuer: r.idp.issuer,
      clientId: 'veryl-canon',
      clientSecret: 'canon-test-secret',
      redirectUri: `${r.canonBase}/auth/callback`,
      scope: 'openid profile email',
      clockToleranceSec: 5,
      requestTimeoutMs: 1000,
      metadataTtlMs: 60_000,
    });

    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: challenge }));
    url.searchParams.set('login_hint', 'dana');
    const bounced = await fetch(url.href, { redirect: 'manual' });
    const code = new URL(bounced.headers.get('location')!).searchParams.get('code')!;

    // Somebody who stole the code but not the verifier.
    await assert.rejects(
      () => client.exchangeCode({ code, codeVerifier: randomBytes(48).toString('base64url') }),
      (err: any) => err.code === 'unauthenticated' && err.details.reason === 'idp_refused',
    );
    // The honest holder still cannot use it: the provider killed the grant.
    await assert.rejects(() => client.exchangeCode({ code, codeVerifier: verifier }));
  } finally {
    r.close();
  }
});

test('validation: the discovery document must name the issuer it was fetched from', async () => {
  const r = await rig();
  try {
    const client = new OidcClient(
      {
        issuer: r.idp.issuer,
        clientId: 'veryl-canon',
        clientSecret: 'canon-test-secret',
        redirectUri: `${r.canonBase}/auth/callback`,
        scope: 'openid',
        clockToleranceSec: 5,
        requestTimeoutMs: 1000,
        metadataTtlMs: 60_000,
      },
      {
        // A provider that answers discovery with somebody else's issuer.
        fetchImpl: async () =>
          new Response(JSON.stringify({ ...r.idp.discovery(), issuer: 'https://elsewhere.example' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    );
    await assert.rejects(
      () => client.discover(),
      (err: any) => err.details.reason === 'issuer_mismatch',
    );
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// Sessions

test('sessions: an idle session expires, and a used one renews up to its absolute end', async () => {
  const r = await rig({ sessionTtlMs: 200, sessionMaxLifetimeMs: 600 });
  try {
    const { jar } = await r.signIn('dana');
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);

    // Used before the idle window closes: renewed, and still alive past where
    // it would have died.
    await sleep(140);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    await sleep(140);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200, 'renewal slid the idle window');

    // Renewal never carries a session past its absolute end.
    await sleep(400);
    const dead = await r.call('GET', '/collections', { jar });
    assert.equal(dead.status, 401);
  } finally {
    r.close();
  }
});

test('sessions: an idle session simply dies', async () => {
  const r = await rig({ sessionTtlMs: 120, sessionMaxLifetimeMs: 5000 });
  try {
    const { jar } = await r.signIn('dana');
    await sleep(220);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 401);
    // The dead cookie is cleared rather than left to be presented again.
    assert.equal(jar.has(SESSION_COOKIE), false);
  } finally {
    r.close();
  }
});

test('sessions: logout invalidates server-side, so the same cookie is dead afterwards', async () => {
  const r = await rig();
  try {
    const { jar } = await r.signIn('dana');
    const csrf = await r.csrfFor(jar);
    const held = jar.header(); // keep the cookie an attacker would have kept

    const out = await r.call('POST', '/auth/logout', { jar, csrf, origin: r.canonBase });
    assert.equal(out.status, 200);
    assert.equal(jar.has(SESSION_COOKIE), false);

    // Presenting the very same cookie value again finds nothing.
    const replay = await fetch(`${r.canonBase}/collections`, { headers: { cookie: held } });
    assert.equal(replay.status, 401);

    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number };
    assert.equal(Number(rows.n), 0, 'the session row is gone, not merely expired');
  } finally {
    r.close();
  }
});

test('sessions: a forged or tampered cookie is refused before the database is asked', async () => {
  const r = await rig();
  try {
    const { jar } = await r.signIn('dana');
    const real = jar.cookies.get(SESSION_COOKIE)!;
    const id = decodeURIComponent(real).split('.')[0]!;

    for (const forged of [`${id}.not-a-signature`, id, `${id}.`, 'nonsense']) {
      const res = await fetch(`${r.canonBase}/collections`, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` },
      });
      assert.equal(res.status, 401, `a cookie of ${forged} must not authenticate`);
    }
  } finally {
    r.close();
  }
});

test('sessions: revoking an actor’s sessions cuts every one of them', async () => {
  const r = await rig();
  try {
    const laptop = (await r.signIn('dana')).jar;
    const phone = (await r.signIn('dana')).jar;
    assert.equal((await r.call('GET', '/collections', { jar: phone })).status, 200);

    const actorId = r.store.listActors()[0]!.id;
    assert.equal(r.personAuth.revokeSessionsFor(actorId), 2);

    assert.equal((await r.call('GET', '/collections', { jar: laptop })).status, 401);
    assert.equal((await r.call('GET', '/collections', { jar: phone })).status, 401);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// CSRF

test('CSRF: a cross-origin write carrying the session cookie is blocked', async () => {
  const r = await rig();
  try {
    const { jar } = await r.signIn('dana');
    const csrf = await r.csrfFor(jar);

    // The attacker's page. It cannot read the token, but assume the worst and
    // give it one anyway: the origin alone is disqualifying.
    const cross = await r.call('POST', '/collections', {
      jar,
      csrf,
      origin: 'https://evil.example',
      body: { name: 'Taken' },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.reason, 'csrf_origin_mismatch');

    // What an attacker can actually manage — a form post, same-origin-less,
    // with no custom header at all — is blocked by the token requirement.
    const noToken = await r.call('POST', '/collections', { jar, origin: r.canonBase, body: { name: 'Taken' } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.reason, 'csrf_token_missing');

    // A token from somewhere else is not this session's token.
    const wrongToken = await r.call('POST', '/collections', {
      jar,
      csrf: randomBytes(32).toString('base64url'),
      origin: r.canonBase,
      body: { name: 'Taken' },
    });
    assert.equal(wrongToken.status, 403);
    assert.equal(wrongToken.json.reason, 'csrf_token_mismatch');

    // An opaque origin (a sandboxed iframe, a data: document) is not ours.
    const opaque = await r.call('POST', '/collections', { jar, csrf, origin: 'null', body: { name: 'Taken' } });
    assert.equal(opaque.status, 403);
    assert.equal(opaque.json.reason, 'csrf_origin_mismatch');

    assert.equal(r.store.listCollections(r.store.listActors()[0]!.id).length, 0, 'nothing was created');

    // And the honest request still works.
    const ok = await r.call('POST', '/collections', { jar, csrf, origin: r.canonBase, body: { name: 'Compliance' } });
    assert.equal(ok.status, 200);
  } finally {
    r.close();
  }
});

test('CSRF: safe methods and non-cookie identities are exempt, and correctly so', async () => {
  const r = await rig({ devAuth: true, withRegistry: true });
  try {
    const { jar } = await r.signIn('dana');
    // A GET carries no CSRF token and is fine: it changes nothing.
    assert.equal((await r.call('GET', '/collections', { jar, origin: 'https://evil.example' })).status, 200);

    // X-Actor-Id is not ambient — no cross-site page can cause one to be sent —
    // so a header-identified write needs no token.
    const dana = r.store.createActor({ kind: 'person', name: 'Dana' });
    const viaHeader = await r.call('POST', '/collections', {
      actor: dana.id,
      origin: 'https://evil.example',
      body: { name: 'Header-made' },
    });
    assert.equal(viaHeader.status, 200);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The dev door

test('dev mode: X-Actor-Id is refused when dev authentication is off', async () => {
  const r = await rig({ devAuth: false });
  try {
    const dana = r.store.createActor({ kind: 'person', name: 'Dana' });
    const refused = await r.call('GET', '/collections', { actor: dana.id });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.reason, 'dev_auth_disabled');
    assert.match(refused.json.message, /CANON_DEV_AUTH/);

    // Not merely on reads: naming an actor buys nothing anywhere.
    const write = await r.call('POST', '/collections', { actor: dana.id, body: { name: 'Taken' } });
    assert.equal(write.status, 401);

    // And POST /actors is not a route on this Canon at all.
    const minted = await r.call('POST', '/actors', { body: { kind: 'person', name: 'Mallory' } });
    assert.equal(minted.status, 404);
    assert.equal(r.store.listActors().length, 1, 'nobody was minted');

    const session = await r.call('GET', '/auth/session');
    assert.equal(session.json.devAuth, false);
    assert.equal(session.json.mode, 'sso');
    // The dev picker's directory is gone with the dev door.
    assert.equal((await r.call('GET', '/auth/dev/actors')).status, 404);
  } finally {
    r.close();
  }
});

test('dev mode: X-Actor-Id works when dev authentication is explicitly on', async () => {
  const r = await rig({ devAuth: true });
  try {
    const minted = await r.call('POST', '/actors', { body: { kind: 'person', name: 'Dana' } });
    assert.equal(minted.status, 200);
    const created = await r.call('POST', '/collections', { actor: minted.json.id, body: { name: 'Compliance' } });
    assert.equal(created.status, 200);

    const session = await r.call('GET', '/auth/session');
    assert.equal(session.json.devAuth, true);

    const picker = await r.call('GET', '/auth/dev/actors');
    assert.equal(picker.status, 200);
    assert.equal(picker.json.length, 1);
  } finally {
    r.close();
  }
});

test('dev mode: a Canon with no door open refuses everybody', async () => {
  const r = await rig({ devAuth: false, sso: false });
  try {
    assert.equal(r.personAuth.mode, 'closed');
    const dana = r.store.createActor({ kind: 'person', name: 'Dana' });
    assert.equal((await r.call('GET', '/collections', { actor: dana.id })).status, 401);
    // Sign-in says what is missing rather than failing obscurely.
    const login = await r.call('GET', '/auth/login');
    assert.equal(login.status, 503);
    assert.equal(login.json.reason, 'sso_not_configured');
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The three doors never mix

test('mixing: a session cookie alongside an Agent Passport is refused', async () => {
  const r = await rig({ withRegistry: true, devAuth: true });
  try {
    const { jar } = await r.signIn('dana');
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: ['*'], permittedActions: ['read'] });
    r.registry.certify(bot.agentId);

    const mixed = await r.call('GET', '/collections', { jar, passport: bot.passport });
    assert.equal(mixed.status, 403);
    assert.equal(mixed.json.reason, 'identity_mismatch');
  } finally {
    r.close();
  }
});

test('mixing: a session cookie alongside an X-Actor-Id naming somebody else is refused', async () => {
  const r = await rig({ devAuth: true });
  try {
    const { jar } = await r.signIn('dana');
    const other = r.store.createActor({ kind: 'person', name: 'Somebody Else' });
    const mixed = await r.call('GET', '/collections', { jar, actor: other.id });
    assert.equal(mixed.status, 403);
    assert.equal(mixed.json.reason, 'identity_mismatch');

    // The same actor id as the session is consistent, not a mix.
    const self = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal((await r.call('GET', '/collections', { jar, actor: self.id })).status, 200);
  } finally {
    r.close();
  }
});

test('passport authentication is entirely unaffected by any of this', async () => {
  // Dev authentication off, SSO on: the agent door does not care about either.
  const r = await rig({ withRegistry: true, devAuth: false });
  try {
    const { jar } = await r.signIn('dana');
    const csrf = await r.csrfFor(jar);
    const collection = (
      await r.call('POST', '/collections', { jar, csrf, origin: r.canonBase, body: { name: 'Compliance' } })
    ).json;

    const bot = r.registry.register({
      name: 'PolicyBot',
      permittedCollections: [collection.id],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);

    // First contact provisions the agent actor, as it always did.
    const first = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, []);
    const agent = r.store.listActors().find((a) => a.kind === 'agent')!;
    assert.equal(agent.registryRef, bot.agentId);

    // Canon's own half of the intersection, granted by the signed-in person.
    const dana = r.store.listActors().find((a) => a.kind === 'person')!;
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, {
      jar,
      csrf,
      origin: r.canonBase,
      body: { role: 'view' },
    });
    assert.ok(dana);
    const second = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(second.json.length, 1);

    // An agent presenting no passport and no cookie is refused, and a passport
    // never needs a CSRF token: it is not ambient.
    const noCsrf = await r.call('POST', '/collections', { passport: bot.passport, body: { name: 'Agent-made' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.reason, 'action_not_permitted');

    // Revocation still cuts it, which is the M3 guarantee.
    r.registry.revoke(bot.agentId, { reason: 'still works' });
    assert.equal((await r.call('GET', '/collections', { passport: bot.passport })).status, 403);
  } finally {
    r.close();
  }
});

test('mixing: the auth routes are not part of the record’s surface for agents', async () => {
  const r = await rig({ withRegistry: true });
  try {
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: ['*'], permittedActions: ['read'] });
    r.registry.certify(bot.agentId);
    // /auth/session is answered by the door itself and never reaches the route
    // table, so it carries no record content and cannot be a way in.
    const probe = await r.call('GET', '/auth/session', { passport: bot.passport });
    assert.equal(probe.status, 200);
    assert.equal(probe.json.authenticated, false);
    assert.equal(probe.json.actor, null);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The directory (SECURITY.md R2)

test('directory: GET /actors no longer hands the whole organization to anyone', async () => {
  const r = await rig({ devAuth: true });
  try {
    const dana = r.store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
    const marc = r.store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
    const zoe = r.store.createActor({ kind: 'person', name: 'Zoe', email: 'zoe@example.com' });
    const compliance = r.store.createCollection(dana.id, { name: 'Compliance' });
    r.store.setMember(dana.id, compliance.id, marc.id, 'view');
    const secrets = r.store.createCollection(zoe.id, { name: 'Zoe’s own' });
    assert.ok(secrets);

    // An operator — admin somewhere — sees the directory, because granting a
    // role means naming somebody you have not met.
    const asDana = await r.call('GET', '/actors', { actor: dana.id });
    assert.equal(asDana.json.length, 3);

    // An ordinary contributor sees themselves and the people they actually
    // share a collection with, and nobody's address but their own.
    const asMarc = await r.call('GET', '/actors', { actor: marc.id });
    const names = asMarc.json.map((a: any) => a.name).sort();
    assert.deepEqual(names, ['Dana', 'Marc']);
    assert.equal(asMarc.json.find((a: any) => a.name === 'Marc').email, 'marc@example.com');
    assert.equal(asMarc.json.find((a: any) => a.name === 'Dana').email, null, 'no directory of addresses');
    assert.equal(
      asMarc.json.some((a: any) => a.name === 'Zoe'),
      false,
      'somebody you share nothing with is not in your directory',
    );

    // A member list per collection is legitimate and is served as one.
    const members = await r.call('GET', `/actors?collection=${compliance.id}`, { actor: marc.id });
    assert.deepEqual(members.json.map((a: any) => a.name).sort(), ['Dana', 'Marc']);

    // And a collection you cannot see has no member list for you.
    const outsider = await r.call('GET', `/actors?collection=${secrets.id}`, { actor: marc.id });
    assert.equal(outsider.status, 403);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// Odds and ends that would each be a hole

test('login: `return` is confined to this server, so /auth/login is not an open redirect', async () => {
  assert.equal(safeReturnTo('https://evil.example/'), '/');
  assert.equal(safeReturnTo('//evil.example/'), '/');
  assert.equal(safeReturnTo('/\\evil.example'), '/');
  assert.equal(safeReturnTo(null), '/');
  assert.equal(safeReturnTo('#/collections/abc'), '/');
  assert.equal(safeReturnTo('/#/collections/abc'), '/#/collections/abc');

  const r = await rig();
  try {
    const login = await fetch(`${r.canonBase}/auth/login?return=${encodeURIComponent('https://evil.example')}`, {
      redirect: 'manual',
    });
    const authorize = new URL(login.headers.get('location')!);
    authorize.searchParams.set('login_hint', 'dana');
    const bounced = await fetch(authorize.href, { redirect: 'manual' });
    const back = new URL(bounced.headers.get('location')!);
    const callback = await fetch(`${r.canonBase}/auth/callback${back.search}`, { redirect: 'manual' });
    assert.equal(callback.headers.get('location'), '/', 'never bounced off this server');
  } finally {
    r.close();
  }
});

test('login: an unknown /auth route is a 404 rather than a fall-through to the record', async () => {
  const r = await rig();
  try {
    assert.equal((await r.call('GET', '/auth/nonsense')).status, 404);
    assert.equal((await r.call('POST', '/auth/login')).status, 404);
  } finally {
    r.close();
  }
});

test('login: a provider that refuses is reported rather than retried into a session', async () => {
  const r = await rig();
  try {
    const login = await fetch(`${r.canonBase}/auth/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const denied = await fetch(`${r.canonBase}/auth/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
      redirect: 'manual',
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).reason, 'idp_refused');
    assert.equal(r.store.listActors().length, 0);
  } finally {
    r.close();
  }
});

test('audit: a refused sign-in is recorded, and no token or code is ever in the log', async () => {
  const r = await rig();
  try {
    r.idp.setQuirk('bad_signature');
    await r.signIn('dana');
    r.idp.setQuirk('none');
    await r.signIn('dana');

    const rows = r.db.prepare('SELECT action, details_json FROM audit_events').all() as {
      action: string;
      details_json: string;
    }[];
    assert.ok(rows.some((e) => e.action === 'person.auth_failed'));
    assert.ok(rows.some((e) => e.action === 'person.provisioned'));
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes('eyJ'), false, 'no JWT is written to the audit log');
    assert.equal(blob.includes('code-'), false, 'no authorization code is written to the audit log');
    assert.equal(blob.includes('canon-test-secret'), false, 'no client secret is written to the audit log');
  } finally {
    r.close();
  }
});
