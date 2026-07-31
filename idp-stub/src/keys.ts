// RSA signing, JWKS publication, and compact JWS assembly — `node:crypto`
// only, no runtime dependency.
//
// The provider signs ID tokens with RS256 because that is what a Node client
// can verify without a library: `crypto.verify('RSA-SHA256', …)` against a
// public key built from the JWK this file publishes.

import { createSign, generateKeyPairSync, KeyObject, randomUUID } from 'node:crypto';

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function jsonSegment(value: unknown): string {
  return base64url(JSON.stringify(value));
}

/** One signing key: private half for tokens, public half for the JWKS. */
export class SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(kid = `k-${randomUUID().slice(0, 8)}`) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.kid = kid;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  /** The public half as a JWK, with `kid`, `use` and `alg` a client can key off. */
  jwk(): Record<string, unknown> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    return { ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  /**
   * Sign a claim set into a compact JWS.
   *
   * `kid` overrides the header's key id without changing the key used, which
   * is how the `unknown_kid` quirk produces a token whose header points at a
   * key the JWKS does not publish.
   */
  sign(claims: Record<string, unknown>, options: { kid?: string } = {}): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: options.kid ?? this.kid };
    const input = `${jsonSegment(header)}.${jsonSegment(claims)}`;
    const signature = createSign('RSA-SHA256').update(input).end().sign(this.privateKey);
    return `${input}.${base64url(signature)}`;
  }
}

/**
 * A token whose header says `alg: none` and which carries no signature at all.
 * Kept here rather than in the store so every way this stub can produce a
 * token is in one file: a client that honours `alg` from the header rather
 * than from its own policy accepts this, and that is the bug it tests for.
 */
export function unsignedToken(claims: Record<string, unknown>): string {
  return `${jsonSegment({ alg: 'none', typ: 'JWT' })}.${jsonSegment(claims)}.`;
}
