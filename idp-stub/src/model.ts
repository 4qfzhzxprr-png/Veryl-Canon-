// The vocabulary of the OpenID Connect provider stub.
//
// Mirrors registry-stub/src/model.ts: an error type with an HTTP status, and
// the handful of records the store keeps. Nothing here is OIDC-specific
// cleverness — it is the smallest set of things a provider must remember to
// run an Authorization Code flow with PKCE.

export type IdpErrorCode = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'not_found' | 'unsupported';

const HTTP_STATUS: Record<IdpErrorCode, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  not_found: 404,
  unsupported: 400,
};

export class IdpError extends Error {
  readonly code: IdpErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: IdpErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IdpError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

/** A person the provider knows about. `sub` is the stable identity. */
export interface IdpUser {
  sub: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  /**
   * The directory groups this person belongs to, as opaque strings. Canon maps
   * these onto collection and org roles (SECURITY.md R10), so the stub has to
   * be able to issue them — and, more importantly, to STOP issuing one, which
   * is what proves a removed group removes the access it granted.
   */
  groups: string[];
  /**
   * Disabled at the provider. The person keeps existing — an audit trail is not
   * a thing to delete — but every refresh of an existing session is refused,
   * which is exactly the event SECURITY.md R9 is about: someone is switched off
   * at the identity provider while they hold a live session at Canon.
   */
  disabled: boolean;
}

/** A relying party. Canon is one of these. */
export interface IdpClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

/**
 * An issued refresh token. A real provider's is opaque and revocable, and so is
 * this one: it names the person and the client, and it is rotated on use, which
 * is what a client that stores one has to survive.
 */
export interface RefreshToken {
  token: string;
  clientId: string;
  sub: string;
  scope: string;
}

/** An issued authorization code, held until it is redeemed exactly once. */
export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  sub: string;
  nonce: string | null;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
  redeemed: boolean;
}

/**
 * A deliberate misbehaviour, set by the administrative face.
 *
 * A stub exists to be pushed off the happy path. Canon's ID-token validator
 * has to refuse a wrong issuer, a wrong audience, an expired token, a bad
 * signature, an unknown key and a wrong nonce — and the only honest way to
 * test that is to have a real provider actually send one. So the stub can be
 * told to lie, one lie at a time, and every lie is otherwise a well-formed
 * flow. `none` is the default and the only setting a demonstration uses.
 */
export type Quirk =
  | 'none'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'bad_signature'
  | 'unknown_kid'
  | 'wrong_nonce'
  | 'no_nonce'
  | 'alg_none'
  /**
   * Issue no refresh token. A real provider does this when the client did not
   * ask for `offline_access`, or when policy forbids it — and a Canon session
   * that cannot be confirmed is a Canon session that must not be served past
   * its window, so the refusal needs a provider that really behaves this way.
   */
  | 'no_refresh_token';

export const QUIRKS: readonly Quirk[] = [
  'none',
  'wrong_issuer',
  'wrong_audience',
  'expired',
  'bad_signature',
  'unknown_kid',
  'wrong_nonce',
  'no_nonce',
  'alg_none',
  'no_refresh_token',
];
