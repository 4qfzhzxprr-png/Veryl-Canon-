// The provider stub, on its own terms. Canon's side of the flow is tested in
// server/test/auth.test.ts, against this same server booted in-process; what
// is asserted here is that the provider itself is a real one — discovery that
// agrees with the issuer, a JWKS a Node client can build a key from, PKCE that
// is required rather than decorative, codes that die when they are redeemed,
// and quirks that actually deviate in the way they promise.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createIdpApi } from '../src/api.js';
import { IdpStore } from '../src/store.js';

const REDIRECT = 'http://127.0.0.1:9/auth/callback';

interface Rig {
  store: IdpStore;
  server: Server;
  base: string;
  clientId: string;
  clientSecret: string;
  close: () => void;
}

async function rig(): Promise<Rig> {
  const store = new IdpStore();
  const server = createIdpApi(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store.issuer = base;
  const client = store.registerClient({ clientId: 'canon', clientSecret: 'shh', redirectUris: [REDIRECT] });
  store.seedUser({ sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' });
  return {
    store,
    server,
    base,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    close: () => server.close(),
  };
}

/** The challenge for a verifier we already hold, for a second code in one test. */
function pkceFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(
  r: Rig,
  overrides: Record<string, string> = {},
  challenge = '',
): string {
  const url = new URL(`${r.base}/authorize`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: r.clientId,
    redirect_uri: REDIRECT,
    scope: 'openid profile email',
    state: 'st-1',
    nonce: 'no-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: 'dana',
    ...overrides,
  };
  for (const [k, v] of Object.entries(params)) if (v !== '') url.searchParams.set(k, v);
  return url.href;
}

async function getCode(r: Rig, challenge: string, overrides: Record<string, string> = {}): Promise<string> {
  const res = await fetch(authorizeUrl(r, overrides, challenge), { redirect: 'manual' });
  assert.equal(res.status, 302, await res.text());
  return new URL(res.headers.get('location')!).searchParams.get('code')!;
}

async function exchange(r: Rig, body: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${r.base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
      client_id: r.clientId,
      client_secret: r.clientSecret,
      ...body,
    }).toString(),
  });
  return { status: res.status, json: await res.json() };
}

function claimsOf(idToken: string): any {
  return JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8'));
}

test('discovery names the issuer it is served from, and the endpoints under it', async () => {
  const r = await rig();
  try {
    const doc = await (await fetch(`${r.base}/.well-known/openid-configuration`)).json();
    assert.equal(doc.issuer, r.base);
    assert.equal(doc.authorization_endpoint, `${r.base}/authorize`);
    assert.equal(doc.token_endpoint, `${r.base}/token`);
    assert.equal(doc.jwks_uri, `${r.base}/jwks.json`);
    assert.deepEqual(doc.id_token_signing_alg_values_supported, ['RS256']);
    assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  } finally {
    r.close();
  }
});

test('the JWKS publishes one RSA signing key a Node client can build', async () => {
  const r = await rig();
  try {
    const jwks = await (await fetch(`${r.base}/jwks.json`)).json();
    assert.equal(jwks.keys.length, 1);
    const key = jwks.keys[0];
    assert.equal(key.kty, 'RSA');
    assert.equal(key.alg, 'RS256');
    assert.equal(key.use, 'sig');
    assert.ok(key.kid);
    // The private half is never published. A JWKS that leaks `d` is not a
    // JWKS, and this stub is copied from as an example.
    assert.equal(key.d, undefined);
    assert.doesNotThrow(() => createPublicKey({ key, format: 'jwk' }));
  } finally {
    r.close();
  }
});

test('the happy path: code, PKCE, and an ID token that verifies against the JWKS', async () => {
  const r = await rig();
  try {
    const { verifier, challenge } = pkce();
    const authorize = await fetch(authorizeUrl(r, {}, challenge), { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const back = new URL(authorize.headers.get('location')!);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'st-1'); // state comes back unchanged

    const { status, json } = await exchange(r, { code: back.searchParams.get('code')!, code_verifier: verifier });
    assert.equal(status, 200);
    assert.equal(json.token_type, 'Bearer');
    assert.ok(json.id_token);

    const [header, payload, signature] = json.id_token.split('.');
    const jwks = await (await fetch(`${r.base}/jwks.json`)).json();
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).kid, jwks.keys[0].kid);
    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .end()
      .verify(createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url'));
    assert.ok(ok, 'the ID token verifies against the published key');

    const claims = claimsOf(json.id_token);
    assert.equal(claims.iss, r.base);
    assert.equal(claims.aud, 'canon');
    assert.equal(claims.sub, 'dana');
    assert.equal(claims.nonce, 'no-1');
    assert.equal(claims.email, 'dana@example.com');
    assert.ok(claims.exp > claims.iat);

    // The access token reaches userinfo, and userinfo agrees with the token.
    const info = await (
      await fetch(`${r.base}/userinfo`, { headers: { authorization: `Bearer ${json.access_token}` } })
    ).json();
    assert.equal(info.sub, 'dana');
    assert.equal(info.email, 'dana@example.com');
  } finally {
    r.close();
  }
});

test('PKCE is required, and only S256', async () => {
  const r = await rig();
  try {
    const noPkce = await fetch(authorizeUrl(r, {}, ''), { redirect: 'manual' });
    assert.equal(noPkce.status, 302); // refused back through the validated redirect
    assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');

    const { challenge } = pkce();
    const plain = await fetch(authorizeUrl(r, { code_challenge_method: 'plain' }, challenge), { redirect: 'manual' });
    assert.equal(new URL(plain.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  } finally {
    r.close();
  }
});

test('a redirect_uri that is not registered is refused here, never redirected to', async () => {
  const r = await rig();
  try {
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(r, { redirect_uri: 'http://evil.example/steal' }, challenge), {
      redirect: 'manual',
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null, 'an unvalidated redirect_uri is never bounced to');

    const unknownClient = await fetch(authorizeUrl(r, { client_id: 'nobody' }, challenge), { redirect: 'manual' });
    assert.equal(unknownClient.status, 401);
    assert.equal(unknownClient.headers.get('location'), null);
  } finally {
    r.close();
  }
});

test('a code is redeemable once, by the client it was issued to, with the right verifier', async () => {
  const r = await rig();
  try {
    const { verifier, challenge } = pkce();

    const wrongVerifier = await exchange(r, { code: await getCode(r, challenge), code_verifier: 'not-the-verifier' });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.json.error, 'invalid_grant');

    const badSecret = await fetch(`${r.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: await getCode(r, challenge),
        redirect_uri: REDIRECT,
        client_id: r.clientId,
        client_secret: 'wrong',
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(badSecret.status, 401);

    const code = await getCode(r, challenge);
    assert.equal((await exchange(r, { code, code_verifier: verifier })).status, 200);
    const replay = await exchange(r, { code, code_verifier: verifier });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');

    const movedRedirect = await exchange(r, {
      code: await getCode(r, challenge),
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:9/elsewhere',
    });
    assert.equal(movedRedirect.status, 400);
  } finally {
    r.close();
  }
});

test('client_secret_basic authenticates the token call as well as client_secret_post', async () => {
  const r = await rig();
  try {
    const { verifier, challenge } = pkce();
    const res = await fetch(`${r.base}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${r.clientId}:${r.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: await getCode(r, challenge),
        redirect_uri: REDIRECT,
        client_id: r.clientId,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(res.status, 200);
  } finally {
    r.close();
  }
});

test('the administrative face seeds users and changes what is asserted about them', async () => {
  const r = await rig();
  try {
    const created = await (
      await fetch(`${r.base}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'marc', name: 'Marc Ellery', email: 'marc@old.example' }),
      })
    ).json();
    assert.equal(created.sub, 'marc');

    await fetch(`${r.base}/admin/users/marc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'marc@new.example' }),
    });

    const { verifier, challenge } = pkce();
    const code = await getCode(r, challenge, { login_hint: 'marc' });
    const { json } = await exchange(r, { code, code_verifier: verifier });
    const claims = claimsOf(json.id_token);
    // The subject is untouched by an email change. That is the whole property
    // Canon's provisioning depends on.
    assert.equal(claims.sub, 'marc');
    assert.equal(claims.email, 'marc@new.example');
  } finally {
    r.close();
  }
});

test('an unknown login_hint is refused rather than invented', async () => {
  const r = await rig();
  try {
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(r, { login_hint: 'nobody' }, challenge), { redirect: 'manual' });
    assert.equal(new URL(res.headers.get('location')!).searchParams.get('error'), 'not_found');
  } finally {
    r.close();
  }
});

test('without a login_hint the provider renders a picker rather than choosing for you', async () => {
  const r = await rig();
  try {
    const { challenge } = pkce();
    const url = new URL(authorizeUrl(r, {}, challenge));
    url.searchParams.delete('login_hint');
    const res = await fetch(url.href, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /Dana Whitfield/);
    assert.match(body, /login_hint=dana/);
  } finally {
    r.close();
  }
});

test('each quirk deviates in exactly the way it names, and nothing else', async () => {
  const r = await rig();
  try {
    const setQuirk = (quirk: string) =>
      fetch(`${r.base}/admin/quirk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quirk }),
      });

    const tokenFor = async () => {
      const { verifier, challenge } = pkce();
      const code = await getCode(r, challenge);
      const { json } = await exchange(r, { code, code_verifier: verifier });
      return json.id_token as string;
    };

    await setQuirk('wrong_issuer');
    assert.equal(claimsOf(await tokenFor()).iss, 'https://issuer.invalid');

    await setQuirk('wrong_audience');
    assert.equal(claimsOf(await tokenFor()).aud, 'some-other-client');

    await setQuirk('expired');
    assert.ok(claimsOf(await tokenFor()).exp < Math.floor(Date.now() / 1000));

    await setQuirk('wrong_nonce');
    assert.notEqual(claimsOf(await tokenFor()).nonce, 'no-1');

    await setQuirk('no_nonce');
    assert.equal(claimsOf(await tokenFor()).nonce, undefined);

    await setQuirk('unknown_kid');
    const strange = await tokenFor();
    const header = JSON.parse(Buffer.from(strange.split('.')[0]!, 'base64url').toString('utf8'));
    assert.equal(header.kid, 'k-never-published');

    await setQuirk('alg_none');
    const unsigned = await tokenFor();
    assert.equal(JSON.parse(Buffer.from(unsigned.split('.')[0]!, 'base64url').toString('utf8')).alg, 'none');
    assert.equal(unsigned.split('.')[2], '');

    await setQuirk('bad_signature');
    const forged = await tokenFor();
    const jwks = await (await fetch(`${r.base}/jwks.json`)).json();
    const [h, p, s] = forged.split('.');
    assert.equal(
      createVerify('RSA-SHA256')
        .update(`${h}.${p}`)
        .end()
        .verify(createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(s!, 'base64url')),
      false,
      'the forged token does not verify against the published key',
    );

    await setQuirk('none');
    assert.equal(claimsOf(await tokenFor()).iss, r.base);

    const unknown = await setQuirk('be-generally-untrustworthy');
    assert.equal(unknown.status, 400);
  } finally {
    r.close();
  }
});

test('the token endpoint refuses anything but the authorization_code grant', async () => {
  const r = await rig();
  try {
    const res = await exchange(r, { grant_type: 'password', code: 'x', code_verifier: 'y' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'unsupported');
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// Group claims and the refresh grant.
//
// Both exist for Canon's sake — R10 maps a group onto a role, and R9 confirms a
// live session with a refresh token — and both are only worth having if the
// stub behaves the way a real provider does when the answer changes: the group
// stops being issued, and a disabled person's refresh is refused.

test('groups: the claim is issued only when the person is in one, under a configurable name', async () => {
  const r = await rig();
  try {
    r.store.updateUser('dana', { groups: ['Canon-Compliance-Editors', 'Canon-Board'] });
    const { verifier, challenge } = pkce();
    const first = await exchange(r, { code: await getCode(r, challenge), code_verifier: verifier });
    assert.deepEqual(claimsOf(first.json.id_token).groups, ['Canon-Compliance-Editors', 'Canon-Board']);

    // A deployment's claim name is configuration — Entra says `groups`, plenty
    // of Okta authorization servers say `roles` — so the stub can say either.
    r.store.setGroupsClaim('roles');
    const second = await exchange(r, { code: await getCode(r, pkceFor(verifier)), code_verifier: verifier });
    const claims = claimsOf(second.json.id_token);
    assert.deepEqual(claims.roles, ['Canon-Compliance-Editors', 'Canon-Board']);
    assert.equal(claims.groups, undefined);
    assert.equal((await (await fetch(`${r.base}/admin/groups-claim`)).json()).claim, 'roles');

    // Nobody's group: the claim is absent rather than an empty array, which is
    // the other thing real providers do.
    r.store.setGroupsClaim('groups');
    r.store.updateUser('dana', { groups: [] });
    const third = await exchange(r, { code: await getCode(r, pkceFor(verifier)), code_verifier: verifier });
    assert.equal(claimsOf(third.json.id_token).groups, undefined);
  } finally {
    r.close();
  }
});

test('refresh: the grant returns a new ID token carrying the person’s CURRENT claims', async () => {
  const r = await rig();
  try {
    r.store.updateUser('dana', { groups: ['Canon-Compliance-Editors'] });
    const { verifier, challenge } = pkce();
    const first = await exchange(r, { code: await getCode(r, challenge), code_verifier: verifier });
    assert.ok(first.json.refresh_token, 'the code exchange issues one');

    // The directory changes while the session is alive.
    r.store.updateUser('dana', { groups: ['Canon-Board'], name: 'Dana Whitfield-Amos' });
    const refreshed = await exchange(r, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    const claims = claimsOf(refreshed.json.id_token);
    assert.deepEqual(claims.groups, ['Canon-Board'], 'the token says what is true now');
    assert.equal(claims.name, 'Dana Whitfield-Amos');
    assert.equal(claims.sub, 'dana');
    assert.equal(claims.nonce, undefined, 'a refreshed token carries no nonce: nothing went through a browser');
  } finally {
    r.close();
  }
});

test('refresh: the token is rotated, so the presented one dies with the exchange', async () => {
  const r = await rig();
  try {
    const { verifier, challenge } = pkce();
    const first = await exchange(r, { code: await getCode(r, challenge), code_verifier: verifier });
    const second = await exchange(r, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token });
    assert.ok(second.json.refresh_token);
    assert.notEqual(second.json.refresh_token, first.json.refresh_token);

    const replay = await exchange(r, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');

    const invented = await exchange(r, { grant_type: 'refresh_token', refresh_token: 'rt-nonsense' });
    assert.equal(invented.status, 400);
  } finally {
    r.close();
  }
});

test('refresh: a disabled person is refused — the event Canon’s R9 guarantee is about', async () => {
  const r = await rig();
  try {
    const { verifier, challenge } = pkce();
    const first = await exchange(r, { code: await getCode(r, challenge), code_verifier: verifier });

    r.store.updateUser('dana', { disabled: true });
    const refused = await exchange(r, { grant_type: 'refresh_token', refresh_token: first.json.refresh_token });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'invalid_grant');
    assert.match(refused.json.error_description, /disabled/);

    // And they cannot start a new session either.
    const fresh = await exchange(r, { code: await getCode(r, pkceFor(verifier)), code_verifier: verifier });
    assert.equal(fresh.status, 400);
    assert.equal(fresh.json.error, 'invalid_grant');
  } finally {
    r.close();
  }
});

test('refresh: the no_refresh_token quirk issues none, so a client must cope with a provider that will not', async () => {
  const r = await rig();
  try {
    r.store.setQuirk('no_refresh_token');
    const { verifier, challenge } = pkce();
    const issued = await exchange(r, { code: await getCode(r, challenge), code_verifier: verifier });
    assert.equal(issued.status, 200);
    assert.ok(issued.json.id_token);
    assert.equal(issued.json.refresh_token, undefined);
  } finally {
    r.close();
  }
});
