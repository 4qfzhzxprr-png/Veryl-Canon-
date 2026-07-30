# Veryl Agent Registry stub

A small standalone service that stands in for the Veryl Agent Registry until the live one exists. It implements [REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md) — exactly, and nothing beyond it — so Canon's Epic D can be built, tested, and demonstrated now, and swapped onto the live Registry later by changing one base URL. This is the mitigation named in [CORE-PLAN.md](../CORE-PLAN.md) (risks): agree the contract before M1 ends, build Epic D against a stub.

The M3 exit criterion — "revoking it in the Registry cuts its access within a minute, demonstrated live" — is what this stub exists to demonstrate. The test suite runs that exact scenario against Canon's `RegistryClient`.

## What it implements

Per the contract, two faces:

- **Verification** (the only thing Canon calls): `POST /verify` — passport in, identity plus certification standing plus permitted collections and actions out, or a typed refusal (`unknown_passport`, `certification_lapsed`, `revoked`).
- **Administration** (what the demonstration drives): `POST /agents` (register, issue passport — shown once, never listed), `POST /agents/:id/certify`, `POST /agents/:id/revoke` (terminal), `PUT /agents/:id/permissions`, `GET /agents` (listing with effective states), `GET /health`.

Honest liberties of a test double, both declared in the contract: state is in-memory and disposable (every demonstration starts from a clean Registry), and the administrative face is unauthenticated (the live Registry authenticates its own).

## Running it

Node 22+, zero runtime dependencies (`node:http`, `node:crypto`, `node:test`).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + stub endpoint suite + Canon's RegistryClient run against the stub in-process
npm start     # serve on :3100 (PORT to override)
```

The test build also compiles [`../server/src/registry.ts`](../server/src/registry.ts) — Canon's client — and runs it against the stub in-process: issue → verify, revoke → cut off within the TTL, cache expiry, and fail-closed with the Registry down.

## A demonstration by hand

```sh
npm start &
# Register and certify an agent; note the passport (shown only here).
curl -s :3100/agents -d '{"name":"PolicyBot","permittedCollections":["*"],"permittedActions":["read"]}'
curl -s :3100/agents/<agentId>/certify -X POST -d '{}'
curl -s :3100/verify -d '{"passport":"vap_..."}'        # 200, certified, limits attached
curl -s :3100/agents/<agentId>/revoke -X POST -d '{}'
curl -s :3100/verify -d '{"passport":"vap_..."}'        # 403 revoked — Canon's cache expires within 60s
```

## Wiring into Canon

`server/src/registry.ts` ships now; plugging it into Canon's auth path is a deliberate follow-up change to `server/src/api.ts` (Epic D), not part of this commit. The shape of that change:

Today `createApi` reads `X-Actor-Id` and hands the actor to the store. The follow-up accepts `X-Agent-Passport` as the agent alternative: verify it through the `RegistryClient`, resolve the agent to a Canon actor (by `registryRef`, creating one on first contact), and enforce the Registry's limits before the store sees the request. Sketch:

```ts
// api.ts (follow-up): construct once, TTL within the one-minute guarantee.
const registry = new RegistryClient({
  baseUrl: process.env.REGISTRY_URL ?? 'http://127.0.0.1:3100',
  cacheTtlMs: 30_000, // clamped to 60s regardless; 0 = re-verify every request
});

// In the request handler, where X-Actor-Id is read today:
const passport = req.headers['x-agent-passport'] as string | undefined;
if (passport) {
  const verified = await registry.verifyPassport(passport);
  if (!verified.ok) {
    // Fail closed. unknown_passport → 401; lapsed/revoked → 403;
    // registry_unreachable → 503. Audit the refusal either way.
    return send(res, statusFor(verified.reason), { error: verified.reason, message: verified.message });
  }
  // Resolve or create the agent actor: kind 'agent', registryRef = agentId.
  actorId = store.actorForRegistryAgent(verified.agent).id;
  // Enforce limits as an intersection with Canon's own permissions:
  // the route's collection must be in agent.permittedCollections (or '*'),
  // and the route's action class (read/comment/write) in permittedActions.
  agentLimits = verified.agent;
}
```

Requests carry a person's `X-Actor-Id` or an agent's `X-Agent-Passport`, never both. Nothing from the verification is stored beyond the client's sub-minute cache — a Registry revocation or limits change is live in Canon on the next uncached request, inside the guarantee.
