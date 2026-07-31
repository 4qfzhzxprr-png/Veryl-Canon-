// A Canon with a real identity provider behind it, for the tests that need
// one: org roles (Part 1), session confirmation (R9) and group mapping (R10).
//
// `auth.test.ts` builds its own rig for the sign-in flow itself and is left
// alone; this one is the same arrangement with the three knobs those tests
// need — a confirmation window, a group mapping, and a chance to create
// collections BEFORE the door is built, because a mapping naming a collection
// that does not exist is refused at construction and that refusal is itself
// under test.
//
// Everything runs in process against the real `idp-stub`, exactly as
// `agentauth.test.ts` runs against the real `registry-stub`.

import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createIdpApi } from '../../idp-stub/src/api.js';
import { IdpStore } from '../../idp-stub/src/store.js';
import { createApi } from '../src/api.js';
import { CSRF_HEADER, PersonAuth, SESSION_COOKIE } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { parseGroupRules } from '../src/groupmap.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

const quiet: NotificationTransport = { deliver() {} };

/** A hand-rolled cookie jar: `fetch` has none, and cookies are the point here. */
export class Jar {
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

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface SeededUser {
  sub: string;
  name: string;
  email?: string;
  groups?: string[];
}

export interface RigOptions {
  /** R9's window. 0 confirms on every request; the default is the guarantee. */
  confirmWindowMs?: number;
  /** People the provider knows about, with their directory groups. */
  users?: SeededUser[];
  /** Which claim the provider issues groups in. */
  groupsClaim?: string;
  /** Canon's own claim name, when it differs from the provider's on purpose. */
  canonGroupsClaim?: string;
  /** Run before the door is built, so a mapping can name what it creates. */
  prepare?: (store: CanonStore, db: DatabaseSync) => Record<string, string>;
  /** The mapping rules, given whatever `prepare` returned. */
  rules?: (seeded: Record<string, string>) => string;
  bootstrapSubjects?: string[];
  sessionTtlMs?: number;
  devAuth?: boolean;
}

export interface AuthRig {
  idp: IdpStore;
  idpServer: Server;
  /** How many requests the provider has served: what "it did not re-ask" means. */
  idpRequests: () => number;
  canonBase: string;
  db: DatabaseSync;
  store: CanonStore;
  personAuth: PersonAuth;
  seeded: Record<string, string>;
  call: (
    method: string,
    path: string,
    opts?: { jar?: Jar; actor?: string; csrf?: string; origin?: string; body?: unknown },
  ) => Promise<{ status: number; json: any; res: Response }>;
  signIn: (sub: string, jar?: Jar) => Promise<{ jar: Jar; status: number; res: Response }>;
  csrfFor: (jar: Jar) => Promise<string>;
  /** A cookie-authenticated write, with the CSRF dance already done. */
  write: (
    method: string,
    path: string,
    jar: Jar,
    body?: unknown,
  ) => Promise<{ status: number; json: any; res: Response }>;
  close: () => void;
}

export async function authRig(opts: RigOptions = {}): Promise<AuthRig> {
  const idp = new IdpStore();
  let idpRequests = 0;
  const idpServer = createIdpApi(idp);
  idpServer.on('request', () => {
    idpRequests += 1;
  });
  await new Promise<void>((resolve) => idpServer.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
  if (opts.groupsClaim) idp.setGroupsClaim(opts.groupsClaim);

  const port = await freePort();
  const canonBase = `http://127.0.0.1:${port}`;
  const client = idp.registerClient({
    clientId: 'veryl-canon',
    clientSecret: 'canon-test-secret',
    redirectUris: [`${canonBase}/auth/callback`],
  });
  for (const user of opts.users ?? [{ sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' }]) {
    idp.seedUser({ sub: user.sub, name: user.name, email: user.email ?? null, groups: user.groups ?? [] });
  }

  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const seeded = opts.prepare ? opts.prepare(store, db) : {};

  const personAuth = new PersonAuth({
    db,
    store,
    devAuth: opts.devAuth ?? false,
    oidc: {
      issuer: idp.issuer,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: `${canonBase}/auth/callback`,
      scope: 'openid profile email offline_access',
      clockToleranceSec: 5,
      requestTimeoutMs: 1000,
      metadataTtlMs: 60_000,
    },
    mapping: {
      claim: opts.canonGroupsClaim ?? opts.groupsClaim ?? 'groups',
      rules: parseGroupRules(opts.rules ? opts.rules(seeded) : ''),
    },
    bootstrapSubjects: opts.bootstrapSubjects ?? [],
    sessionSecret: Buffer.from('a-fixed-test-secret'),
    sessionTtlMs: opts.sessionTtlMs,
    confirmWindowMs: opts.confirmWindowMs,
    secureCookies: false, // the rig speaks http, exactly as localhost does
  });

  const canon = createApi(store, null, undefined, personAuth);
  await new Promise<void>((resolve) => canon.listen(port, '127.0.0.1', resolve));

  const call: AuthRig['call'] = async (method, path, o = {}) => {
    const res = await fetch(canonBase + path, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(o.jar && o.jar.cookies.size ? { cookie: o.jar.header() } : {}),
        ...(o.actor ? { 'x-actor-id': o.actor } : {}),
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

  const write: AuthRig['write'] = async (method, path, jar, body) => {
    const csrf = await csrfFor(jar);
    return call(method, path, { jar, csrf, origin: canonBase, body });
  };

  return {
    idp,
    idpServer,
    idpRequests: () => idpRequests,
    canonBase,
    db,
    store,
    personAuth,
    seeded,
    call,
    signIn,
    csrfFor,
    write,
    close: () => {
      canon.close();
      idpServer.close();
    },
  };
}

export { SESSION_COOKIE };
