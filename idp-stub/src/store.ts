// The provider's state: users, clients, issued codes, and the one quirk it
// has been told to exhibit. All in memory and disposable, exactly as
// registry-stub's RegistryStore is.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { base64url, SigningKey, unsignedToken } from './keys.js';
import { AuthCode, IdpClient, IdpError, IdpUser, Quirk, QUIRKS, RefreshToken } from './model.js';

const CODE_TTL_MS = 60_000;
const ID_TOKEN_TTL_SEC = 300;

function s256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function normaliseGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  return [...new Set(groups.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim()))];
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token: string;
  scope: string;
  refresh_token?: string;
}

export class IdpStore {
  /**
   * The issuer this provider claims to be. Set after `listen(0)` in a test,
   * because the issuer is a URL and the port is not known until then; the
   * discovery document, the `iss` claim and every published endpoint are all
   * derived from it, so one assignment moves the whole provider.
   */
  issuer: string;

  private readonly key = new SigningKey();
  /** A second key, never published, used to forge the `bad_signature` quirk. */
  private readonly impostor = new SigningKey();
  private readonly users = new Map<string, IdpUser>();
  private readonly clients = new Map<string, IdpClient>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, { sub: string; expiresAt: number }>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  /**
   * Which claim the groups are issued in. Configurable because Canon's claim
   * name is configurable (`CANON_OIDC_GROUPS_CLAIM`), and a provider that only
   * ever says `groups` cannot prove that the setting does anything: Entra says
   * `groups`, Okta is usually `groups` but is configured per authorization
   * server, and plenty of deployments use `roles`.
   */
  private groupsClaim = 'groups';
  private quirk: Quirk = 'none';
  private readonly now: () => number;

  constructor(options: { issuer?: string; now?: () => number } = {}) {
    this.issuer = options.issuer ?? 'http://127.0.0.1:3200';
    this.now = options.now ?? (() => Date.now());
  }

  // ---- administrative face ---------------------------------------------

  seedUser(input: {
    sub?: string;
    name: string;
    email?: string | null;
    emailVerified?: boolean;
    groups?: string[];
    disabled?: boolean;
  }): IdpUser {
    if (!input.name?.trim()) throw new IdpError('invalid_request', 'A user requires a name');
    const sub = input.sub?.trim() || `sub-${randomUUID()}`;
    const user: IdpUser = {
      sub,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      emailVerified: input.emailVerified ?? true,
      groups: normaliseGroups(input.groups),
      disabled: input.disabled === true,
    };
    this.users.set(sub, user);
    return user;
  }

  /**
   * Change what the provider asserts about someone. This is the whole point
   * of the administrative face for Canon's purposes: an email address changes,
   * and Canon must land on the same actor because it matched the subject.
   */
  updateUser(
    sub: string,
    patch: { name?: string; email?: string | null; groups?: string[]; disabled?: boolean },
  ): IdpUser {
    const user = this.users.get(sub);
    if (!user) throw new IdpError('not_found', `No such user: ${sub}`);
    const updated: IdpUser = {
      ...user,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.email === undefined ? {} : { email: patch.email }),
      ...(patch.groups === undefined ? {} : { groups: normaliseGroups(patch.groups) }),
      ...(patch.disabled === undefined ? {} : { disabled: patch.disabled === true }),
    };
    this.users.set(sub, updated);
    return updated;
  }

  /** Which claim groups are issued in. `POST /admin/groups-claim`. */
  setGroupsClaim(claim: string): { claim: string } {
    if (!claim.trim()) throw new IdpError('invalid_request', 'A claim name cannot be empty');
    this.groupsClaim = claim.trim();
    return { claim: this.groupsClaim };
  }

  currentGroupsClaim(): string {
    return this.groupsClaim;
  }

  listUsers(): IdpUser[] {
    return [...this.users.values()];
  }

  getUser(sub: string): IdpUser | null {
    return this.users.get(sub) ?? null;
  }

  registerClient(input: { clientId?: string; clientSecret?: string; redirectUris: string[] }): IdpClient {
    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new IdpError('invalid_request', 'A client requires at least one redirect URI');
    }
    const client: IdpClient = {
      clientId: input.clientId?.trim() || `client-${randomUUID().slice(0, 8)}`,
      clientSecret: input.clientSecret?.trim() || randomUUID(),
      redirectUris: input.redirectUris,
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): IdpClient | null {
    return this.clients.get(clientId) ?? null;
  }

  setQuirk(quirk: string): { quirk: Quirk } {
    if (!QUIRKS.includes(quirk as Quirk)) {
      throw new IdpError('invalid_request', `Unknown quirk: ${quirk}`, { known: QUIRKS });
    }
    this.quirk = quirk as Quirk;
    return { quirk: this.quirk };
  }

  currentQuirk(): Quirk {
    return this.quirk;
  }

  // ---- discovery and keys ----------------------------------------------

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      jwks_uri: `${this.issuer}/jwks.json`,
      end_session_endpoint: `${this.issuer}/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'name', 'email', 'email_verified', this.groupsClaim],
    };
  }

  jwks(): { keys: Record<string, unknown>[] } {
    return { keys: [this.key.jwk()] };
  }

  // ---- the authorization endpoint --------------------------------------

  /**
   * Validate an authorization request and mint a code for a named subject.
   *
   * PKCE is required, and only S256: `plain` is refused rather than accepted
   * quietly, because a provider that accepts `plain` lets a client believe it
   * has protection it does not have.
   */
  authorize(params: {
    clientId: string;
    redirectUri: string;
    responseType: string;
    scope: string;
    nonce: string | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    sub: string;
  }): { code: string } {
    const client = this.requireRedirect(params.clientId, params.redirectUri);
    if (params.responseType !== 'code') {
      throw new IdpError('unsupported', 'Only response_type=code is supported');
    }
    if (!params.codeChallenge) throw new IdpError('invalid_request', 'PKCE is required: code_challenge is missing');
    if (params.codeChallengeMethod !== 'S256') {
      throw new IdpError('invalid_request', 'Only code_challenge_method=S256 is supported');
    }
    if (!this.users.has(params.sub)) throw new IdpError('not_found', `No such user: ${params.sub}`);

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      code,
      clientId: client.clientId,
      redirectUri: params.redirectUri,
      sub: params.sub,
      nonce: params.nonce,
      scope: params.scope || 'openid',
      codeChallenge: params.codeChallenge,
      expiresAt: this.now() + CODE_TTL_MS,
      redeemed: false,
    });
    return { code };
  }

  private requireRedirect(clientId: string, redirectUri: string): IdpClient {
    const client = this.clients.get(clientId);
    if (!client) throw new IdpError('invalid_client', `No such client: ${clientId}`);
    // Exact match, never a prefix: a prefix match is how an open redirect gets
    // into a provider.
    if (!client.redirectUris.includes(redirectUri)) {
      throw new IdpError('invalid_request', 'redirect_uri does not match a registered redirect URI');
    }
    return client;
  }

  // ---- the token endpoint ----------------------------------------------

  exchange(params: {
    grantType: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    codeVerifier: string;
    refreshToken?: string;
  }): TokenResponse {
    const client = this.clients.get(params.clientId);
    if (!client || !constantTimeEqual(client.clientSecret, params.clientSecret)) {
      throw new IdpError('invalid_client', 'Client authentication failed');
    }
    if (params.grantType === 'refresh_token') return this.refresh(client, params.refreshToken ?? '');
    if (params.grantType !== 'authorization_code') {
      throw new IdpError('unsupported', 'Only grant_type=authorization_code and refresh_token are supported');
    }
    const record = this.codes.get(params.code);
    if (!record) throw new IdpError('invalid_grant', 'Unknown authorization code');
    // A redeemed code is deleted, not reused: a code presented twice is the
    // signature of a stolen one, so the grant dies rather than replaying.
    if (record.redeemed || record.expiresAt <= this.now()) {
      this.codes.delete(params.code);
      throw new IdpError('invalid_grant', 'Authorization code is expired or already redeemed');
    }
    // Every check below is one a legitimate client passes by construction, so
    // failing one means the code is in the wrong hands. The grant dies rather
    // than staying available for the next attempt — including the real
    // client's, which is the point: a code that has been fumbled at is a code
    // somebody else may be holding.
    try {
      if (record.clientId !== params.clientId) throw new IdpError('invalid_grant', 'Code was issued to another client');
      if (record.redirectUri !== params.redirectUri) {
        throw new IdpError('invalid_grant', 'redirect_uri does not match the authorization request');
      }
      if (!params.codeVerifier) throw new IdpError('invalid_grant', 'code_verifier is required');
      if (!constantTimeEqual(record.codeChallenge, s256(params.codeVerifier))) {
        throw new IdpError('invalid_grant', 'code_verifier does not match the code_challenge');
      }
    } catch (err) {
      this.codes.delete(params.code);
      throw err;
    }

    record.redeemed = true;
    this.codes.delete(params.code);

    const user = this.users.get(record.sub);
    if (!user) throw new IdpError('invalid_grant', 'The authenticated user no longer exists');
    // A disabled person cannot start a session either. Canon's R9 guarantee is
    // about the sessions they already hold; this is the ordinary front door.
    if (user.disabled) throw new IdpError('invalid_grant', 'This account is disabled');

    return this.issue(user, client, record.scope, record.nonce);
  }

  /**
   * The refresh grant — what Canon confirms a live session with (SECURITY.md
   * R9). Three properties this stub has on purpose, because Canon has to
   * survive all three:
   *
   *  - A DISABLED person is refused, which is the whole event under test.
   *  - The token is ROTATED: the presented one dies and a new one comes back,
   *    so a client that fails to store the new one loses the session. Real
   *    providers do this and a stub that did not would hide the bug.
   *  - The new ID token carries the person's CURRENT claims, groups included,
   *    which is what makes a group removed here remove access over there.
   */
  private refresh(client: IdpClient, presented: string): TokenResponse {
    const held = presented ? this.refreshTokens.get(presented) : undefined;
    if (!held) throw new IdpError('invalid_grant', 'Unknown or already-used refresh token');
    this.refreshTokens.delete(presented);
    if (held.clientId !== client.clientId) {
      throw new IdpError('invalid_grant', 'Refresh token was issued to another client');
    }
    const user = this.users.get(held.sub);
    if (!user) throw new IdpError('invalid_grant', 'The authenticated user no longer exists');
    if (user.disabled) throw new IdpError('invalid_grant', 'This account is disabled');
    return this.issue(user, client, held.scope, null);
  }

  private issue(user: IdpUser, client: IdpClient, scope: string, nonce: string | null): TokenResponse {
    const accessToken = `at-${randomUUID()}`;
    this.accessTokens.set(accessToken, { sub: user.sub, expiresAt: this.now() + ID_TOKEN_TTL_SEC * 1000 });
    const response: TokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_SEC,
      id_token: this.idToken(user, client, nonce),
      scope,
    };
    if (this.quirk !== 'no_refresh_token') {
      const refreshToken = `rt-${randomUUID()}`;
      this.refreshTokens.set(refreshToken, { token: refreshToken, clientId: client.clientId, sub: user.sub, scope });
      response.refresh_token = refreshToken;
    }
    return response;
  }

  userinfo(accessToken: string): Record<string, unknown> {
    const held = this.accessTokens.get(accessToken);
    if (!held || held.expiresAt <= this.now()) throw new IdpError('invalid_grant', 'Unknown or expired access token');
    const user = this.users.get(held.sub);
    if (!user) throw new IdpError('not_found', 'No such user');
    return {
      sub: user.sub,
      name: user.name,
      email: user.email,
      email_verified: user.emailVerified,
      [this.groupsClaim]: user.groups,
    };
  }

  // ---- ID tokens, honest and otherwise ---------------------------------

  private idToken(user: IdpUser, client: IdpClient, nonce: string | null): string {
    const issuedAt = Math.floor(this.now() / 1000);
    const quirk = this.quirk;
    const claims: Record<string, unknown> = {
      iss: quirk === 'wrong_issuer' ? 'https://issuer.invalid' : this.issuer,
      sub: user.sub,
      aud: quirk === 'wrong_audience' ? 'some-other-client' : client.clientId,
      exp: quirk === 'expired' ? issuedAt - 60 : issuedAt + ID_TOKEN_TTL_SEC,
      iat: quirk === 'expired' ? issuedAt - 360 : issuedAt,
      auth_time: issuedAt,
      name: user.name,
      email: user.email,
      email_verified: user.emailVerified,
    };
    // The group claim is present only when the person is in a group: a
    // provider that sends an empty array and one that sends nothing at all are
    // both real, and Canon reads either as "no groups".
    if (user.groups.length > 0) claims[this.groupsClaim] = user.groups;
    if (quirk === 'wrong_nonce') claims.nonce = `not-${nonce ?? 'the-nonce'}`;
    else if (quirk !== 'no_nonce' && nonce) claims.nonce = nonce;

    if (quirk === 'alg_none') return unsignedToken(claims);
    // Signed by a key the JWKS does not publish, but announced under the
    // published key id: the signature verifies against nothing a client can
    // fetch, which is exactly the "someone else signed this" case.
    if (quirk === 'bad_signature') return this.impostor.sign(claims, { kid: this.key.kid });
    if (quirk === 'unknown_kid') return this.key.sign(claims, { kid: 'k-never-published' });
    return this.key.sign(claims);
  }
}
