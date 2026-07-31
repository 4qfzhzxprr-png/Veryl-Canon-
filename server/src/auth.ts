// The people-facing door: OpenID Connect, sessions, and who may see whom.
//
// Canon has three doors and this file is one of them:
//
//   SSO      a person signs in at their organization's identity provider and
//            carries a session cookie (this file)
//   dev      `X-Actor-Id` names an actor and nothing is verified — the alpha
//            stand-in, now behind an explicit opt-in (this file decides
//            whether it is live; api.ts honours the answer)
//   passport an agent presents `X-Agent-Passport`, verified with the Veryl
//            Agent Registry (agentauth.ts — untouched by any of this)
//
// The three never mix. REGISTRY-CONTRACT.md §2 states the rule for the first
// two against the third — "a request carries a person's identity or an
// agent's passport, not both" — and it is enforced here and in api.ts for
// every pairing, including a session cookie arriving alongside an `X-Actor-Id`
// naming somebody else.
//
// What this closes, from SECURITY.md §3:
//
//   R1  "There is no authentication." `X-Actor-Id` was an assertion anyone
//       could make and `POST /actors` was open to unauthenticated callers.
//       Now: a person's identity comes from a verified ID token, sessions are
//       server-side so revocation is real, and `X-Actor-Id` is refused unless
//       a deployment explicitly asked for it with CANON_DEV_AUTH=true.
//   R2  "GET /actors discloses the whole directory." Now: a collection's
//       member list to its members, and nothing global to anyone but an
//       operator (see `visibleActors`).
//
// And what it opens, which §4 said would happen: "CSRF is not applicable …
// This stops being true the moment SSO introduces a session cookie." It has.
// See `assertCsrf`.
//
// Zero runtime dependencies: `node:crypto` verifies RS256 against a JWK, so
// the JWKS is fetched, cached, keyed by `kid`, and the signature checked here
// rather than by a library.

import {
  createHmac,
  createPublicKey,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CanonError } from './model.js';
import type { Actor } from './model.js';
import type { CanonStore } from './store.js';

// ---------------------------------------------------------------------------
// Storage
//
// Sessions and in-flight logins are server-side, in the record's own database.
// A session cookie is a pointer, never a bearer of claims: logging out or
// revoking a session deletes the row, and the next request finds nothing —
// which is what makes revocation real rather than a matter of waiting for a
// signed token to expire.

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  absolute_end  TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_actor ON auth_sessions(actor_id);

CREATE TABLE IF NOT EXISTS auth_flows (
  state         TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Configuration

export interface OidcConfig {
  /** The issuer, exactly as it appears in the `iss` claim. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where the provider sends the person back. Registered at the provider verbatim. */
  redirectUri: string;
  scope: string;
  /** Seconds of clock skew tolerated on `exp` and `nbf`. */
  clockToleranceSec: number;
  requestTimeoutMs: number;
  /** How long a discovery document and a JWKS may be reused. */
  metadataTtlMs: number;
}

export interface PersonAuthOptions {
  db: DatabaseSync;
  store: CanonStore;
  /** `X-Actor-Id` accepted. False refuses it outright. */
  devAuth: boolean;
  oidc: OidcConfig | null;
  /** HMAC key for the session cookie. Generated per process when absent. */
  sessionSecret?: Buffer;
  /** Idle lifetime: a session unused for this long is dead. */
  sessionTtlMs?: number;
  /** Hard ceiling: no amount of renewal carries a session past this. */
  sessionMaxLifetimeMs?: number;
  /** `Secure` on the cookie. Defaults to "on unless the deployment is local". */
  secureCookies?: boolean;
  /** Origins a cookie-authenticated write may come from. */
  allowedOrigins?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const SESSION_COOKIE = 'canon_session';
export const CSRF_HEADER = 'x-canon-csrf';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // idle
const DEFAULT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000; // absolute
const FLOW_TTL_MS = 10 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Is dev authentication live? One environment variable, spelled out, and the
 * default is no. A deployment that forgets to set anything gets a Canon that
 * refuses `X-Actor-Id`, which is the whole point of R1: running open must take
 * a deliberate act, never an omission.
 */
export function devAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CANON_DEV_AUTH ?? '').trim().toLowerCase() === 'true';
}

function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return url.protocol !== 'https:';
  } catch {
    return true;
  }
}

/**
 * Read the OIDC half of the configuration. Absent `CANON_OIDC_ISSUER`, SSO is
 * simply not configured — the same shape of switch `CANON_REGISTRY_URL` is for
 * agents, and for the same reason: one variable turns a door on, and swapping
 * the stub for the real provider changes that one variable.
 */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.CANON_OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const clientId = env.CANON_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.CANON_OIDC_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('CANON_OIDC_ISSUER is set, so CANON_OIDC_CLIENT_ID and CANON_OIDC_CLIENT_SECRET are required');
  }
  const base = (env.CANON_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const redirectUri = env.CANON_OIDC_REDIRECT_URI?.trim() || `${base}/auth/callback`;
  const tolerance = Number(env.CANON_OIDC_CLOCK_TOLERANCE_SEC ?? '');
  const timeout = Number(env.CANON_OIDC_TIMEOUT_MS ?? '');
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    redirectUri,
    scope: env.CANON_OIDC_SCOPE?.trim() || 'openid profile email',
    clockToleranceSec: Number.isFinite(tolerance) && env.CANON_OIDC_CLOCK_TOLERANCE_SEC ? tolerance : 60,
    requestTimeoutMs: Number.isFinite(timeout) && env.CANON_OIDC_TIMEOUT_MS ? timeout : 5000,
    metadataTtlMs: 10 * 60 * 1000,
  };
}

/** The whole people-facing door, assembled from the environment. */
export function personAuthFromEnv(
  db: DatabaseSync,
  store: CanonStore,
  env: NodeJS.ProcessEnv = process.env,
): PersonAuth {
  const secret = env.CANON_SESSION_SECRET?.trim();
  const ttl = Number(env.CANON_SESSION_TTL_MS ?? '');
  const maxLife = Number(env.CANON_SESSION_MAX_LIFETIME_MS ?? '');
  const secureRaw = env.CANON_COOKIE_SECURE?.trim().toLowerCase();
  return new PersonAuth({
    db,
    store,
    devAuth: devAuthEnabled(env),
    oidc: oidcConfigFromEnv(env),
    sessionSecret: secret ? Buffer.from(secret, 'utf8') : undefined,
    sessionTtlMs: Number.isFinite(ttl) && env.CANON_SESSION_TTL_MS ? ttl : undefined,
    sessionMaxLifetimeMs: Number.isFinite(maxLife) && env.CANON_SESSION_MAX_LIFETIME_MS ? maxLife : undefined,
    secureCookies: secureRaw === 'true' ? true : secureRaw === 'false' ? false : !isLocalUrl(env.CANON_BASE_URL),
    allowedOrigins: (env.CANON_ALLOWED_ORIGINS ?? '')
      .split(/[,\s]+/)
      .map((o) => o.trim())
      .filter(Boolean),
  });
}

// ---------------------------------------------------------------------------
// The OIDC client
//
// Discovery, JWKS with `kid`, the code exchange, and ID-token validation.
// Nothing here trusts anything the token itself says about how to check it:
// the algorithm is our policy (RS256), the issuer is our configuration, and
// the audience is our client id. A token that nominates its own verification
// is the classic way a JWT check becomes a rubber stamp.

interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | null;
}

export interface IdTokenClaims {
  sub: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  raw: Record<string, unknown>;
}

export interface TokenSet {
  idToken: string;
  accessToken: string | null;
}

function b64urlToBuffer(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlToBuffer(segment).toString('utf8'));
  } catch {
    throw new CanonError('unauthenticated', `The ID token's ${what} is not JSON`, { reason: 'malformed_id_token' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CanonError('unauthenticated', `The ID token's ${what} is not an object`, { reason: 'malformed_id_token' });
  }
  return parsed as Record<string, unknown>;
}

export class OidcClient {
  readonly config: OidcConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private metadata: { at: number; value: ProviderMetadata } | null = null;
  private jwks: { at: number; keys: Map<string, Record<string, unknown>> } | null = null;

  constructor(config: OidcConfig, options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init));
    this.now = options.now ?? (() => Date.now());
  }

  private async getJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch (err) {
      throw new CanonError('unavailable', `The identity provider is unreachable: ${(err as Error).message}`, {
        reason: 'idp_unreachable',
      });
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new CanonError('unavailable', 'The identity provider answered with something that is not JSON', {
        reason: 'idp_malformed',
      });
    }
    if (!res.ok) {
      const detail = (body as { error_description?: string; error?: string } | null) ?? {};
      throw new CanonError('unauthenticated', `The identity provider refused: ${detail.error_description ?? detail.error ?? res.status}`, {
        reason: 'idp_refused',
      });
    }
    return body;
  }

  /** The discovery document, cached, and checked to be who it claims to be. */
  async discover(): Promise<ProviderMetadata> {
    if (this.metadata && this.now() - this.metadata.at < this.config.metadataTtlMs) return this.metadata.value;
    const doc = (await this.getJson(`${this.config.issuer}/.well-known/openid-configuration`)) as Record<string, unknown>;
    const issuer = typeof doc?.issuer === 'string' ? doc.issuer.replace(/\/+$/, '') : '';
    // The discovery document must agree with where we fetched it from.
    // Without this check, an issuer that redirects becomes an issuer that
    // substitutes, and every later `iss` comparison is against a value the
    // attacker chose.
    if (issuer !== this.config.issuer) {
      throw new CanonError('unavailable', 'The identity provider’s discovery document names a different issuer', {
        reason: 'issuer_mismatch',
        expected: this.config.issuer,
        found: issuer,
      });
    }
    const value: ProviderMetadata = {
      issuer,
      authorizationEndpoint: String(doc.authorization_endpoint ?? ''),
      tokenEndpoint: String(doc.token_endpoint ?? ''),
      jwksUri: String(doc.jwks_uri ?? ''),
      endSessionEndpoint: typeof doc.end_session_endpoint === 'string' ? doc.end_session_endpoint : null,
    };
    if (!value.authorizationEndpoint || !value.tokenEndpoint || !value.jwksUri) {
      throw new CanonError('unavailable', 'The identity provider’s discovery document is incomplete', {
        reason: 'idp_malformed',
      });
    }
    this.metadata = { at: this.now(), value };
    return value;
  }

  /**
   * The signing key for a `kid`. An unknown `kid` refetches the JWKS once —
   * that is how key rotation is survived without a restart — but no more often
   * than the metadata TTL allows, so a token carrying a made-up `kid` cannot
   * be used to hammer the provider.
   */
  private async keyFor(kid: string | null): Promise<Record<string, unknown>> {
    const fresh = this.jwks && this.now() - this.jwks.at < this.config.metadataTtlMs;
    if (!fresh) await this.refreshJwks();
    let key = this.pickKey(kid);
    if (!key && fresh) {
      await this.refreshJwks();
      key = this.pickKey(kid);
    }
    if (!key) {
      throw new CanonError('unauthenticated', 'The ID token is signed by a key the provider does not publish', {
        reason: 'unknown_kid',
        kid,
      });
    }
    return key;
  }

  private pickKey(kid: string | null): Record<string, unknown> | null {
    const keys = this.jwks?.keys;
    if (!keys || keys.size === 0) return null;
    if (kid) return keys.get(kid) ?? null;
    // No `kid` in the header is legal when the provider publishes one key.
    // With several it is ambiguous, and guessing is not verification.
    return keys.size === 1 ? [...keys.values()][0]! : null;
  }

  private async refreshJwks(): Promise<void> {
    const { jwksUri } = await this.discover();
    const doc = (await this.getJson(jwksUri)) as { keys?: unknown };
    const keys = new Map<string, Record<string, unknown>>();
    if (Array.isArray(doc?.keys)) {
      for (const entry of doc.keys as Record<string, unknown>[]) {
        // RSA signing keys only: those are the ones this client can verify,
        // and an EC or symmetric key in the set is not a reason to accept one.
        if (entry?.kty !== 'RSA') continue;
        if (entry.use && entry.use !== 'sig') continue;
        keys.set(String(entry.kid ?? ''), entry);
      }
    }
    this.jwks = { at: this.now(), keys };
  }

  /** Where to send the person, with PKCE, state and nonce already in it. */
  async authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const { authorizationEndpoint } = await this.discover();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scope);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }

  /** Redeem the code. The verifier travels here and nowhere else. */
  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenSet> {
    const { tokenEndpoint } = await this.discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: params.codeVerifier,
    });
    const body = (await this.getJson(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // client_secret_basic: the secret stays out of the form body, which
        // is the half of the request most likely to end up in a log.
        authorization:
          'Basic ' +
          Buffer.from(
            `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
          ).toString('base64'),
      },
      body: form.toString(),
    })) as Record<string, unknown>;
    const idToken = typeof body?.id_token === 'string' ? body.id_token : '';
    if (!idToken) {
      throw new CanonError('unauthenticated', 'The identity provider returned no ID token', { reason: 'no_id_token' });
    }
    return { idToken, accessToken: typeof body.access_token === 'string' ? body.access_token : null };
  }

  /**
   * Signature first, then claims. Every check is against configuration or
   * against what we sent, never against what the token asserts about itself.
   */
  async validateIdToken(token: string, expected: { nonce: string }): Promise<IdTokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new CanonError('unauthenticated', 'The ID token is not a compact JWS', { reason: 'malformed_id_token' });
    }
    const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
    const header = decodeSegment(headerSeg, 'header');

    // The algorithm is ours, not the token's. `none` and any HMAC algorithm
    // are refused here rather than by failing to find a key, so the refusal
    // says what actually happened.
    if (header.alg !== 'RS256') {
      throw new CanonError('unauthenticated', `The ID token's signing algorithm is not accepted: ${String(header.alg)}`, {
        reason: 'bad_algorithm',
        alg: String(header.alg ?? ''),
      });
    }
    if (!signatureSeg) {
      throw new CanonError('unauthenticated', 'The ID token carries no signature', { reason: 'no_signature' });
    }

    const jwk = await this.keyFor(typeof header.kid === 'string' ? header.kid : null);
    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    } catch {
      throw new CanonError('unavailable', 'The identity provider published a key Canon cannot read', {
        reason: 'bad_jwk',
      });
    }
    const signed = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8');
    const ok = verifySignature('RSA-SHA256', signed, publicKey, b64urlToBuffer(signatureSeg));
    if (!ok) {
      throw new CanonError('unauthenticated', 'The ID token’s signature does not verify', { reason: 'bad_signature' });
    }

    const claims = decodeSegment(payloadSeg, 'payload');
    const nowSec = Math.floor(this.now() / 1000);
    const tolerance = this.config.clockToleranceSec;

    if (typeof claims.iss !== 'string' || claims.iss.replace(/\/+$/, '') !== this.config.issuer) {
      throw new CanonError('unauthenticated', 'The ID token was issued by another issuer', {
        reason: 'wrong_issuer',
        expected: this.config.issuer,
      });
    }

    const audience = Array.isArray(claims.aud) ? (claims.aud as unknown[]).map(String) : [String(claims.aud ?? '')];
    if (!audience.includes(this.config.clientId)) {
      throw new CanonError('unauthenticated', 'The ID token was issued for another client', { reason: 'wrong_audience' });
    }
    // Several audiences means the token was minted for more than us, so the
    // provider must say which party it was authorized to: OIDC Core 3.1.3.7.
    if (audience.length > 1 && claims.azp !== this.config.clientId) {
      throw new CanonError('unauthenticated', 'The ID token has several audiences and is not authorized to Canon', {
        reason: 'wrong_audience',
      });
    }

    const exp = Number(claims.exp);
    if (!Number.isFinite(exp) || exp + tolerance <= nowSec) {
      throw new CanonError('unauthenticated', 'The ID token has expired', { reason: 'expired' });
    }
    if (claims.nbf !== undefined) {
      const nbf = Number(claims.nbf);
      if (!Number.isFinite(nbf) || nbf - tolerance > nowSec) {
        throw new CanonError('unauthenticated', 'The ID token is not valid yet', { reason: 'not_yet_valid' });
      }
    }
    const iat = Number(claims.iat);
    if (!Number.isFinite(iat) || iat - tolerance > nowSec) {
      throw new CanonError('unauthenticated', 'The ID token was issued in the future', { reason: 'bad_iat' });
    }

    // The nonce binds this token to the login this browser started. Absent or
    // different, the token may be a perfectly valid one replayed from
    // somewhere else, which is the whole attack the nonce exists to stop — so
    // "missing" is refused exactly as "wrong" is.
    if (typeof claims.nonce !== 'string' || !claims.nonce) {
      throw new CanonError('unauthenticated', 'The ID token carries no nonce', { reason: 'missing_nonce' });
    }
    if (!constantTimeEqual(claims.nonce, expected.nonce)) {
      throw new CanonError('unauthenticated', 'The ID token’s nonce is not the one Canon sent', { reason: 'bad_nonce' });
    }

    const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    if (!sub) {
      throw new CanonError('unauthenticated', 'The ID token names no subject', { reason: 'no_subject' });
    }

    return {
      sub,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
      email: typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : null,
      emailVerified: claims.email_verified === true,
      raw: claims,
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Sessions

export interface CanonSession {
  id: string;
  actorId: string;
  subject: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  absoluteEnd: string;
}

/** What identity resolution produced for one request. */
export interface PersonIdentity {
  actorId: string;
  /** True when the identity came from a session cookie — the ambient-credential case. */
  viaCookie: boolean;
  session: CanonSession | null;
}

/**
 * The header-only path, for a Canon assembled without a PersonAuth (which is
 * how the in-process test rigs build one). The rule is the same rule: without
 * `CANON_DEV_AUTH=true`, `X-Actor-Id` is refused.
 */
export function identifyFromHeader(req: IncomingMessage, devAuth: boolean): PersonIdentity {
  const header = ((req.headers['x-actor-id'] as string) ?? '').trim();
  if (!header) return { actorId: '', viaCookie: false, session: null };
  if (!devAuth) throw devAuthRefused();
  return { actorId: header, viaCookie: false, session: null };
}

export function devAuthRefused(): CanonError {
  return new CanonError(
    'unauthenticated',
    'X-Actor-Id is not accepted by this Canon: it is the development stand-in for SSO and is off. ' +
      'Sign in at /auth/login, or start the server with CANON_DEV_AUTH=true.',
    { reason: 'dev_auth_disabled', header: 'X-Actor-Id' },
  );
}

function mixedIdentities(): CanonError {
  return new CanonError(
    'forbidden',
    'A request carries a person’s identity or an agent’s passport, never both',
    { reason: 'identity_mismatch' },
  );
}

// ---------------------------------------------------------------------------
// Cookies

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name || out[name] !== undefined) continue;
    out[name] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader('set-cookie');
  if (existing === undefined) res.setHeader('set-cookie', [value]);
  else res.setHeader('set-cookie', Array.isArray(existing) ? [...existing.map(String), value] : [String(existing), value]);
}

// ---------------------------------------------------------------------------
// PersonAuth

export class PersonAuth {
  readonly devAuth: boolean;
  readonly oidc: OidcClient | null;
  private readonly db: DatabaseSync;
  private readonly store: CanonStore;
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly maxLifetimeMs: number;
  private readonly secureCookies: boolean;
  private readonly allowedOrigins: Set<string>;
  private readonly now: () => number;
  /** True when no CANON_SESSION_SECRET was supplied and one was invented. */
  readonly ephemeralSecret: boolean;

  constructor(options: PersonAuthOptions) {
    this.db = options.db;
    this.store = options.store;
    this.devAuth = options.devAuth;
    this.now = options.now ?? (() => Date.now());
    this.ephemeralSecret = !options.sessionSecret;
    this.secret = options.sessionSecret ?? randomBytes(32);
    this.ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxLifetimeMs = options.sessionMaxLifetimeMs ?? Math.max(DEFAULT_SESSION_MAX_LIFETIME_MS, this.ttlMs);
    this.secureCookies = options.secureCookies ?? true;
    this.oidc = options.oidc
      ? new OidcClient(options.oidc, { fetchImpl: options.fetchImpl, now: this.now })
      : null;
    this.allowedOrigins = new Set<string>();
    for (const origin of options.allowedOrigins ?? []) this.addOrigin(origin);
    if (options.oidc) this.addOrigin(options.oidc.redirectUri);

    this.db.exec(AUTH_SCHEMA);
    this.ensureSubjectColumn();
  }

  /** Which face is live, for the start-up banner and for `GET /auth/session`. */
  get mode(): 'sso' | 'dev' | 'closed' {
    if (this.oidc) return 'sso';
    return this.devAuth ? 'dev' : 'closed';
  }

  private addOrigin(raw: string): void {
    try {
      this.allowedOrigins.add(new URL(raw).origin);
    } catch {
      /* not a URL; a bare origin string is added verbatim below */
      if (raw.startsWith('http://') || raw.startsWith('https://')) this.allowedOrigins.add(raw.replace(/\/+$/, ''));
    }
  }

  // The IdP subject is the stable identity, so it needs a column of its own.
  // Added here rather than in db.ts's schema, the way notify.ts brings its own
  // delivery columns up to date: a record created by an earlier build gains
  // the column on the first start with SSO configured.
  private ensureSubjectColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(actors)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'sso_subject')) {
      this.db.exec('ALTER TABLE actors ADD COLUMN sso_subject TEXT');
    }
    // Two actors can never share a subject. The uniqueness is in the storage
    // layer rather than only in the lookup below, so no future code path can
    // produce a second actor for one person.
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_sso_subject ON actors(sso_subject) WHERE sso_subject IS NOT NULL',
    );
  }

  // ---- identity on an ordinary request ---------------------------------

  /**
   * Resolve who is asking. The session cookie wins; `X-Actor-Id` is the dev
   * fallback and is refused outright when dev authentication is off.
   *
   * `res` is taken because resolving can have a side effect on the response:
   * a renewed session re-sets its cookie, and a cookie that no longer points
   * at a live session is cleared rather than left to be presented again.
   */
  identify(req: IncomingMessage, res: ServerResponse): PersonIdentity {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE];
    const header = ((req.headers['x-actor-id'] as string) ?? '').trim();

    if (raw) {
      const session = this.sessionFromCookie(raw);
      if (session) {
        if (header && header !== session.actorId) throw mixedIdentities();
        const renewed = this.touch(session);
        if (renewed) this.setSessionCookie(res, renewed);
        return { actorId: session.actorId, viaCookie: true, session: renewed ?? session };
      }
      this.clearSessionCookie(res);
    }

    if (!header) return { actorId: '', viaCookie: false, session: null };
    if (!this.devAuth) throw devAuthRefused();
    return { actorId: header, viaCookie: false, session: null };
  }

  // ---- CSRF ------------------------------------------------------------
  //
  // SECURITY.md §4 said "CSRF is not applicable (no cookies)". A session
  // cookie is an ambient credential, so it is applicable now, and the answer
  // here is two checks rather than one:
  //
  //   1. ORIGIN. An unsafe request whose `Origin` (or, absent that, `Referer`)
  //      is not one of ours is refused. Modern browsers send `Origin` on every
  //      cross-site POST including form submissions, so this catches the
  //      classic attack outright and costs the honest caller nothing.
  //   2. A SESSION-BOUND TOKEN in `X-Canon-CSRF`. The token is minted with the
  //      session, stored beside it server-side, and compared in constant time.
  //      This is a synchronizer token, not a double-submit cookie: a
  //      double-submit is forgeable by anyone who can write a cookie on the
  //      domain — a sibling subdomain, a network position on plain HTTP — and
  //      Canon holds a regulated corpus, so the cheaper pattern is not worth
  //      the caveat. A custom header also cannot be produced by a form post at
  //      all, and cross-origin JS cannot read the token because Canon emits no
  //      CORS headers.
  //
  // Both, because either alone has a gap: origin checking fails open on a
  // request with no `Origin` and no `Referer`, and a token alone would be
  // spent the moment one is leaked into a URL or a log.
  //
  // Requests that carry no cookie are exempt, and that is correct rather than
  // convenient: `X-Actor-Id` and `X-Agent-Passport` are not ambient, so no
  // cross-site page can cause one to be sent.
  assertCsrf(req: IncomingMessage, identity: PersonIdentity): void {
    if (!identity.viaCookie || !identity.session) return;
    if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return;

    const origin = (req.headers.origin as string) ?? '';
    const referer = (req.headers.referer as string) ?? '';
    const declared = origin || referer;
    if (declared && declared !== 'null') {
      let candidate: string;
      try {
        candidate = new URL(declared).origin;
      } catch {
        throw new CanonError('forbidden', 'This request declares an origin Canon cannot read', {
          reason: 'csrf_origin_unreadable',
        });
      }
      if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(candidate)) {
        throw new CanonError('forbidden', 'This request comes from another origin and carries a Canon session', {
          reason: 'csrf_origin_mismatch',
          origin: candidate,
        });
      }
    } else if (origin === 'null') {
      throw new CanonError('forbidden', 'This request comes from an opaque origin and carries a Canon session', {
        reason: 'csrf_origin_mismatch',
      });
    }

    const presented = ((req.headers[CSRF_HEADER] as string) ?? '').trim();
    if (!presented) {
      throw new CanonError('forbidden', `A cookie-authenticated write requires the ${CSRF_HEADER} header`, {
        reason: 'csrf_token_missing',
        header: CSRF_HEADER,
      });
    }
    if (!constantTimeEqual(presented, identity.session.csrfToken)) {
      throw new CanonError('forbidden', 'The CSRF token does not belong to this session', {
        reason: 'csrf_token_mismatch',
      });
    }
  }

  // ---- the auth routes -------------------------------------------------

  /** Does this path belong to the door rather than to the record? */
  handles(pathname: string): boolean {
    return pathname.startsWith('/auth/');
  }

  /**
   * Serve one of the door's own routes. Returns true when it answered.
   * Called from api.ts before route matching, so none of these ever reach the
   * record's route table — and, being absent from agentauth's table too, an
   * agent presenting a passport at them is refused by the rule that already
   * refuses every unclassified route.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname;

    if (path === '/auth/session' && method === 'GET') {
      this.sendJson(res, 200, this.describeSession(req, res));
      return true;
    }
    if (path === '/auth/login' && method === 'GET') {
      await this.beginLogin(req, res, url);
      return true;
    }
    if (path === '/auth/callback' && method === 'GET') {
      await this.completeLogin(req, res, url);
      return true;
    }
    if (path === '/auth/logout' && method === 'POST') {
      this.logout(req, res);
      return true;
    }
    if (path === '/auth/dev/actors' && method === 'GET') {
      // The dev identity picker's own door, open exactly as the dev door is
      // open, and gone entirely when dev authentication is off. Keeping it
      // here rather than on `GET /actors` is what lets the record's directory
      // route carry one rule for everybody (see `visibleActors`).
      if (!this.devAuth) {
        this.sendJson(res, 404, { error: 'not_found', message: 'No route: GET /auth/dev/actors' });
        return true;
      }
      this.sendJson(res, 200, this.store.listActors());
      return true;
    }
    if (path.startsWith('/auth/')) {
      this.sendJson(res, 404, { error: 'not_found', message: `No route: ${method} ${path}` });
      return true;
    }
    return false;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  private describeSession(req: IncomingMessage, res: ServerResponse): Record<string, unknown> {
    let identity: PersonIdentity = { actorId: '', viaCookie: false, session: null };
    try {
      identity = this.identify(req, res);
    } catch {
      // A refused `X-Actor-Id` is not an error worth 401-ing the "who am I"
      // probe over: the honest answer is "nobody, and here is how to sign in".
    }
    let actor: Actor | null = null;
    if (identity.actorId) {
      try {
        actor = this.store.getActor(identity.actorId);
      } catch {
        actor = null;
      }
    }
    return {
      mode: this.mode,
      sso: this.oidc !== null,
      devAuth: this.devAuth,
      authenticated: actor !== null,
      viaCookie: identity.viaCookie,
      actor: actor ? { id: actor.id, name: actor.name, kind: actor.kind, email: actor.email } : null,
      csrfToken: identity.session?.csrfToken ?? null,
      csrfHeader: CSRF_HEADER,
      loginUrl: this.oidc ? '/auth/login' : null,
    };
  }

  private async beginLogin(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.oidc) {
      this.sendJson(res, 503, {
        error: 'unavailable',
        message: 'Single sign-on is not configured on this Canon; set CANON_OIDC_ISSUER to enable it',
        reason: 'sso_not_configured',
      });
      return;
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const returnTo = safeReturnTo(url.searchParams.get('return'));

    const at = this.now();
    this.db
      .prepare(
        'INSERT INTO auth_flows (state, nonce, code_verifier, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(state, nonce, codeVerifier, returnTo, new Date(at).toISOString(), new Date(at + FLOW_TTL_MS).toISOString());
    this.sweepFlows();

    try {
      const target = await this.oidc.authorizationUrl({ state, nonce, codeChallenge });
      res.writeHead(302, { location: target, 'cache-control': 'no-store' });
      res.end();
    } catch (err) {
      this.db.prepare('DELETE FROM auth_flows WHERE state = ?').run(state);
      this.sendError(res, err);
    }
  }

  private async completeLogin(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.oidc) {
      this.sendJson(res, 503, {
        error: 'unavailable',
        message: 'Single sign-on is not configured on this Canon',
        reason: 'sso_not_configured',
      });
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    // The flow row is taken and deleted in one step, so a state — and with it
    // the nonce and the code verifier — is usable exactly once. A replayed
    // callback finds nothing and is refused as an unknown state, which is the
    // same refusal a forged one gets.
    const flow = this.takeFlow(state);
    if (!flow) {
      this.failLogin(res, new CanonError('unauthenticated', 'This sign-in did not start here, or it has expired', {
        reason: 'unknown_state',
      }));
      return;
    }

    const providerError = url.searchParams.get('error');
    if (providerError) {
      this.failLogin(res, new CanonError('unauthenticated', `The identity provider refused: ${providerError}`, {
        reason: 'idp_refused',
      }));
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) {
      this.failLogin(res, new CanonError('unauthenticated', 'The identity provider returned no authorization code', {
        reason: 'no_code',
      }));
      return;
    }

    try {
      const tokens = await this.oidc.exchangeCode({ code, codeVerifier: flow.codeVerifier });
      const claims = await this.oidc.validateIdToken(tokens.idToken, { nonce: flow.nonce });
      const { actor, provisioned } = this.provision(claims);
      const session = this.createSession(actor.id, claims.sub);
      this.setSessionCookie(res, session);
      this.audit(actor.id, provisioned ? 'person.provisioned' : 'person.session', {
        subject: claims.sub,
        issuer: this.oidc.config.issuer,
        // The email is recorded because a provisioning is a change to the
        // record's actor table and the log has to be able to say what it was.
        // The ID token itself never lands here, and neither does the code.
        email: actor.email,
        sessionId: session.id,
      });
      res.writeHead(302, { location: flow.returnTo, 'cache-control': 'no-store' });
      res.end();
    } catch (err) {
      this.failLogin(res, err);
    }
  }

  private failLogin(res: ServerResponse, err: unknown): void {
    const canon = err instanceof CanonError ? err : new CanonError('unauthenticated', (err as Error).message);
    this.audit('sso:unauthenticated', 'person.auth_failed', {
      reason: canon.details.reason ?? canon.code,
      message: canon.message,
    });
    this.sendJson(res, canon.httpStatus, { error: canon.code, message: canon.message, ...canon.details });
  }

  private sendError(res: ServerResponse, err: unknown): void {
    const canon = err instanceof CanonError ? err : new CanonError('unavailable', (err as Error).message);
    this.sendJson(res, canon.httpStatus, { error: canon.code, message: canon.message, ...canon.details });
  }

  private logout(req: IncomingMessage, res: ServerResponse): void {
    const identity = this.identify(req, res);
    if (identity.viaCookie && identity.session) {
      this.assertCsrf(req, identity);
      // Revocation is a deletion. Nothing survives it: the cookie still names
      // a session id, and there is no longer a row for that id to point at.
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(identity.session.id);
      this.audit(identity.session.actorId, 'person.logout', { sessionId: identity.session.id });
    }
    this.clearSessionCookie(res);
    this.sendJson(res, 200, { ok: true });
  }

  // ---- just-in-time provisioning ---------------------------------------

  /**
   * Match on the IdP subject, never on the email address.
   *
   * An email address changes and can be reassigned to somebody else; the
   * subject is the identity the provider promises is stable. Matching on
   * email would mean that giving a leaver's address to a new hire hands them
   * the leaver's history, their collection roles, and their audit trail.
   */
  provision(claims: IdTokenClaims): { actor: Actor; provisioned: boolean } {
    const key = subjectKey(this.oidc?.config.issuer ?? '', claims.sub);
    const row = this.db
      .prepare("SELECT id FROM actors WHERE sso_subject = ? AND kind = 'person'")
      .get(key) as { id: string } | undefined;

    if (row) {
      const actor = this.store.getActor(row.id);
      // Claims follow the provider, so attribution stays true when someone
      // marries, or moves to a new address. Same actor, new label.
      const name = claims.name ?? actor.name;
      const email = claims.email ?? actor.email;
      if (name !== actor.name || email !== actor.email) {
        this.db.prepare('UPDATE actors SET name = ?, email = ? WHERE id = ?').run(name, email, actor.id);
      }
      return { actor: this.store.getActor(actor.id), provisioned: false };
    }

    const created = this.store.createActor({
      kind: 'person',
      name: claims.name ?? claims.email ?? claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
    });
    this.db.prepare('UPDATE actors SET sso_subject = ? WHERE id = ?').run(key, created.id);
    return { actor: this.store.getActor(created.id), provisioned: true };
  }

  // ---- session plumbing ------------------------------------------------

  createSession(actorId: string, subject: string): CanonSession {
    const at = this.now();
    const session: CanonSession = {
      id: randomUUID(),
      actorId,
      subject,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.ttlMs).toISOString(),
      absoluteEnd: new Date(at + this.maxLifetimeMs).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, actor_id, subject, csrf_token, created_at, expires_at, absolute_end, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.actorId,
        session.subject,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
        session.absoluteEnd,
        session.createdAt,
      );
    this.sweepSessions();
    return session;
  }

  /** Every live session for an actor — the surface a "sign me out everywhere" needs. */
  revokeSessionsFor(actorId: string): number {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE actor_id = ?').get(actorId) as {
      n: number;
    };
    this.db.prepare('DELETE FROM auth_sessions WHERE actor_id = ?').run(actorId);
    return Number(before?.n ?? 0);
  }

  private sign(sessionId: string): string {
    return createHmac('sha256', this.secret).update(sessionId).digest('base64url');
  }

  private sessionFromCookie(raw: string): CanonSession | null {
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const id = raw.slice(0, dot);
    const mac = raw.slice(dot + 1);
    // The signature is checked before the database is asked anything, so an
    // unsigned or tampered cookie never becomes a lookup.
    if (!constantTimeEqual(mac, this.sign(id))) return null;
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const session: CanonSession = {
      id: row.id as string,
      actorId: row.actor_id as string,
      subject: row.subject as string,
      csrfToken: row.csrf_token as string,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      absoluteEnd: row.absolute_end as string,
    };
    const at = this.now();
    if (Date.parse(session.expiresAt) <= at || Date.parse(session.absoluteEnd) <= at) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(session.id);
      return null;
    }
    return session;
  }

  /**
   * Slide the idle window, but never past the absolute end. Returns the
   * renewed session when the cookie has to be re-sent, and null when the
   * existing one is still good — so a busy session is not re-cookied on every
   * request.
   */
  private touch(session: CanonSession): CanonSession | null {
    const at = this.now();
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(new Date(at).toISOString(), session.id);
    const remaining = Date.parse(session.expiresAt) - at;
    if (remaining > this.ttlMs / 2) return null;
    const capped = Math.min(at + this.ttlMs, Date.parse(session.absoluteEnd));
    if (capped <= Date.parse(session.expiresAt)) return null;
    const expiresAt = new Date(capped).toISOString();
    this.db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(expiresAt, session.id);
    return { ...session, expiresAt };
  }

  private setSessionCookie(res: ServerResponse, session: CanonSession): void {
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - this.now()) / 1000));
    appendSetCookie(
      res,
      [
        `${SESSION_COOKIE}=${encodeURIComponent(`${session.id}.${this.sign(session.id)}`)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAge}`,
        ...(this.secureCookies ? ['Secure'] : []),
      ].join('; '),
    );
  }

  private clearSessionCookie(res: ServerResponse): void {
    appendSetCookie(
      res,
      [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(this.secureCookies ? ['Secure'] : [])].join(
        '; ',
      ),
    );
  }

  private takeFlow(state: string): { nonce: string; codeVerifier: string; returnTo: string } | null {
    if (!state) return null;
    const row = this.db.prepare('SELECT * FROM auth_flows WHERE state = ?').get(state) as
      | Record<string, unknown>
      | undefined;
    this.db.prepare('DELETE FROM auth_flows WHERE state = ?').run(state);
    if (!row) return null;
    if (Date.parse(row.expires_at as string) <= this.now()) return null;
    return {
      nonce: row.nonce as string,
      codeVerifier: row.code_verifier as string,
      returnTo: row.return_to as string,
    };
  }

  private sweepFlows(): void {
    this.db.prepare('DELETE FROM auth_flows WHERE expires_at <= ?').run(new Date(this.now()).toISOString());
  }

  private sweepSessions(): void {
    const at = new Date(this.now()).toISOString();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR absolute_end <= ?').run(at, at);
  }

  // Written straight to the append-only log, as agentauth.ts does: these are
  // authentication events rather than store operations.
  private audit(actorId: string, action: string, details: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, 'person', ?, NULL, NULL, ?)`,
      )
      .run(new Date(this.now()).toISOString(), actorId, action, JSON.stringify(details));
  }
}

/**
 * The stored key for an identity: issuer plus subject.
 *
 * Qualified by issuer because a subject is only unique within the provider
 * that minted it. A deployment that ever adds a second provider must not have
 * `user-1` at one mean the same person as `user-1` at the other.
 */
export function subjectKey(issuer: string, sub: string): string {
  return `${issuer}#${sub}`;
}

/**
 * Where to send the person after a successful sign-in. Anything that is not a
 * plain path on this server becomes `/`: an open redirect on a login endpoint
 * is a phishing primitive, and `return=https://evil.example` is the standard
 * way one gets in.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

// ---------------------------------------------------------------------------
// The directory (SECURITY.md R2)
//
// `GET /actors` returned every actor and every email address to anyone who
// could name an actor id. The rule now:
//
//   - `?collection=<id>` — that collection's members, to anyone who may view
//     it. A member list is a legitimate thing for a member to have: it is who
//     you can name as an owner, an approver, or a mention.
//   - no parameter, and the asker holds `admin` somewhere — the whole
//     directory. An administrator sets up permissions (CORE-PLAN.md §2) and
//     cannot grant a role to somebody they cannot find. This is the same
//     "admin on at least one collection" operator stand-in `sources.ts` and
//     `notify.ts` already use, and it is a stand-in: see SECURITY.md.
//   - no parameter, anyone else — themselves, plus the people they actually
//     share a collection with, with email addresses omitted for everyone but
//     themselves.
//
// A global directory to every actor is gone in all three cases.

export function visibleActors(store: CanonStore, actorId: string, collectionId?: string): Actor[] {
  if (collectionId) {
    // listMembers checks the asker's own `view` on the collection first, so a
    // non-member learns nothing, not even the size of the list.
    const members = store.listMembers(actorId, collectionId);
    const ids = new Set(members.map((m) => m.actorId));
    const admin = store.roleOf(actorId, collectionId) === 'admin';
    return store
      .listActors()
      .filter((a) => ids.has(a.id))
      .map((a) => (admin || a.id === actorId ? a : { ...a, email: null }));
  }

  const mine = store.listCollections(actorId);
  const operator = mine.some((c) => store.roleOf(actorId, c.id) === 'admin');
  if (operator) return store.listActors();

  const visible = new Set<string>([actorId]);
  for (const collection of mine) {
    for (const member of store.listMembers(actorId, collection.id)) visible.add(member.actorId);
  }
  return store
    .listActors()
    .filter((a) => visible.has(a.id))
    .map((a) => (a.id === actorId ? a : { ...a, email: null }));
}
