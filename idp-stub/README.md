# Veryl Canon IdP stub

A small standalone OpenID Connect provider that stands in for an organization's real identity provider — Entra ID, Okta, Google Workspace, Keycloak — so Canon's people-facing single sign-on can be built, tested and demonstrated now, and pointed at the real thing later by changing one base URL.

It exists for the same reason [registry-stub/](../registry-stub/) does. Canon's agent door is real because the Registry behind it is; until this stub, Canon's *people* door was `X-Actor-Id`, which [SECURITY.md](../SECURITY.md) §3 R1 calls "an assertion, not a credential" and names as the assumption the whole security model rested on. Closing R1 needed a provider to close it against, and a design partner's tenant is not a thing you can run a test suite against.

## What it implements

The three faces of a provider:

- **Discovery** — `GET /.well-known/openid-configuration` and `GET /jwks.json`. The discovery document names the issuer it is served from, and the JWKS publishes one RSA signing key with its `kid`, `use` and `alg`. The private half is never published.
- **The flow** — `GET /authorize`, `POST /token`, `GET /userinfo`. Authorization Code with **PKCE required and only `S256`**: no `code_challenge` is refused, and `plain` is refused, because a provider that accepts `plain` lets a client believe it has protection it does not have. The `redirect_uri` must match a registered one exactly — never by prefix — and an unregistered one is refused *here* rather than redirected to, which is the difference between a provider and an open redirect. A code is single-use, expires in sixty seconds, is bound to its client and its `redirect_uri`, and dies on any failed check rather than staying available for the next attempt.
- **The refresh grant** — `POST /token` with `grant_type=refresh_token`. The code exchange issues a refresh token; presenting it returns a **new ID token carrying the person's current claims**, and rotates the refresh token so the presented one dies with the exchange, exactly as a real provider does. This is what Canon confirms a live session against ([SECURITY.md](../SECURITY.md) R9): a **disabled** person's refresh is refused with `invalid_grant`, which is the event the whole sixty-second guarantee for people is about.
- **Administration** — `POST /admin/users`, `PUT /admin/users/:sub`, `GET /admin/users`, `POST /admin/clients`, `POST /admin/quirk`, `POST /admin/groups-claim`. This is what the demonstration and the test suite drive.

ID tokens are RS256, signed with a key generated at start-up, carrying `iss`, `sub`, `aud`, `exp`, `iat`, `nonce`, `name`, `email`, `email_verified` and — when the person is in one — their **groups**. RS256 because that is the algorithm a Node client can verify with no dependency at all: `crypto.verify('RSA-SHA256', …)` against a public key built from the published JWK.

## Groups, and switching somebody off

Two things a provider does that Canon now depends on, so the stub does them properly:

```sh
# Group membership is a property of the person, changed while a session is live.
curl -s :3200/admin/users/dana -X PUT -d '{"groups":["Canon-Compliance-Editors"]}'
curl -s :3200/admin/users/dana -X PUT -d '{"groups":[]}'          # and taken away again

# The claim name is configuration: Entra says `groups`, plenty of Okta
# authorization servers say `roles`. Canon's own is CANON_OIDC_GROUPS_CLAIM.
curl -s :3200/admin/groups-claim -d '{"claim":"roles"}'

# Switched off at the provider. Every refresh is refused from this moment, so
# Canon ends the person's sessions at their next confirmation — within a minute.
curl -s :3200/admin/users/dana -X PUT -d '{"disabled":true}'
```

The claim is **absent** rather than an empty array when somebody is in no group, because both are real provider behaviours and Canon has to read either as "no groups".

## Quirks: a stub you can push off the happy path

Canon's validator has to refuse a wrong issuer, a wrong audience, an expired token, a bad signature, an unknown key, a missing or wrong nonce, and `alg: none`. The only honest way to test that is to have a real provider actually send one, so this stub can be told to lie — one lie at a time, every other part of the flow unchanged:

```sh
curl -s :3200/admin/quirk -d '{"quirk":"bad_signature"}'   # signed by a key the JWKS does not publish
curl -s :3200/admin/quirk -d '{"quirk":"none"}'            # back to honest
```

`none` (the default), `wrong_issuer`, `wrong_audience`, `expired`, `bad_signature`, `unknown_kid`, `wrong_nonce`, `no_nonce`, `alg_none`, and `no_refresh_token` — a provider that issues none, so Canon's "a session it cannot confirm does not survive its window" path is tested against a provider that really behaves that way. Nothing but a stub should ever have this, which is one of the reasons this is not deployable.

## Honest liberties of a test double

The same two registry-stub takes, and one more:

- State is in-memory and disposable; every demonstration starts from a clean provider.
- The administrative face is unauthenticated. A real provider authenticates its own.
- **There is no authentication of the person.** `GET /authorize?login_hint=<sub>` issues a code for that subject on the spot, with no password, no second factor and no consent screen — which is exactly what makes the whole flow drivable from a test with no browser. Without a `login_hint` it renders a one-line picker so a person can walk the flow by hand.

**Never run this anywhere real.** That is what "stub" is doing in the name.

## Running it

Node 22+, zero runtime dependencies (`node:http`, `node:crypto`, `node:test`).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + the provider's own suite
npm start     # serve on :3200 (PORT to override)
```

`npm start` seeds a client (`veryl-canon` / `canon-dev-secret`, redirecting to `http://127.0.0.1:3000/auth/callback`) and two users (`dana`, `iris`), and prints all of it, because a stub that needs a setup script is a stub nobody starts. `IDP_ISSUER`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET` and `IDP_REDIRECT_URIS` override.

## A demonstration by hand

```sh
npm start &
# Discovery, and the key Canon will verify against.
curl -s :3200/.well-known/openid-configuration | head -c 400
curl -s :3200/jwks.json

# Start Canon against it, with dev authentication off.
CANON_OIDC_ISSUER=http://127.0.0.1:3200 \
CANON_OIDC_CLIENT_ID=veryl-canon \
CANON_OIDC_CLIENT_SECRET=canon-dev-secret \
CANON_BASE_URL=http://127.0.0.1:3000 \
npm --prefix ../server start

# Then open http://127.0.0.1:3000 and press "Sign in with your organization
# account". Canon redirects to :3200/authorize, the picker chooses a user, and
# the callback lands you in the record with a session cookie and a Canon actor
# provisioned from the ID token's claims.
```

To watch the subject-not-email rule work, change an address at the provider and sign in again — same Canon actor, new address on it:

```sh
curl -s :3200/admin/users/dana -X PUT -d '{"email":"dana.whitfield@example.com"}'
```

## Wiring into Canon

Canon's side lives in [`server/src/auth.ts`](../server/src/auth.ts): the Authorization Code flow with PKCE, ID-token validation against this JWKS, just-in-time provisioning matched on the **subject** (never the email — an address changes and can be reassigned), server-side sessions behind a signed `HttpOnly` cookie, and CSRF protection for the writes that cookie now makes possible. One environment variable turns it on, and it is the same one that will point at the real provider:

```sh
CANON_OIDC_ISSUER=http://127.0.0.1:3200   # plus CANON_OIDC_CLIENT_ID / _SECRET
```

`server/test/auth.test.ts` boots this stub in-process and runs the whole flow against it, refusals included — exactly as `server/test/agentauth.test.ts` does with registry-stub.
