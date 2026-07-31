# The Registry ⇄ Canon Contract

Veryl Canon does not decide which agents to trust. Veryl Agent Registry does. This document is the contract between them: how an agent proves who it is at Canon's door, how Canon keeps checking that the proof still holds, what the Registry tells Canon the agent may touch, and what happens when any part of that fails.

[DATA-BACKBONE.md](DATA-BACKBONE.md) (section 7) states the contract's principles; [CORE-PLAN.md](CORE-PLAN.md) names it the risk to retire first: Epic D depends on this integration, so the contract is agreed before M1 ends and Epic D is built against a stub until the live Registry is ready. That stub lives in [registry-stub/](registry-stub/). It implements exactly the endpoints below, no more, so that the day the live Registry arrives, Canon changes one base URL and nothing else. The M3 exit — "revoking it in the Registry cuts its access within a minute, demonstrated live" — is demonstrated against this contract, whichever side of it is real.

---

## 1. The shape of the relationship

One sentence, from the backbone document: the Registry defines identity, certification, and limits, and Canon enforces them at its own door.

Everything below follows from three rules:

1. **The Registry is the only source of agent trust.** Canon holds no agent credentials, no certification state, and no separate agent permission system. The only thing Canon stores about an agent's standing is a reference — the agent's Registry identity — attached to the agent's actor record for attribution and audit.
2. **Canon asks; the Registry answers; Canon enforces.** Verification is a live call from Canon to the Registry. The answer carries the agent's identity and its limits. Canon applies those limits to the request in hand and throws the answer away when it goes stale. Nothing in the answer is durable in Canon.
3. **No answer means no.** If the Registry is unreachable, slow, or returns something Canon cannot parse, the agent does not get in. Canon fails closed, always. An outage of the Registry degrades agent access, never widens it.

## 2. The Agent Passport handshake

Every agent holds an Agent Passport: an opaque bearer token issued by the Registry when the agent is registered. The passport is the agent's only credential for Canon. Canon never sees, stores, or issues one.

The handshake:

1. The agent calls Canon's API with its passport in the `X-Agent-Passport` header. (People authenticate separately; in the current alpha server that is the `X-Actor-Id` header, and SSO later. The two paths never mix: a request carries a person's identity or an agent's passport, not both.)
2. Canon presents the passport to the Registry's `POST /verify` endpoint.
3. The Registry answers with the agent's identity, its certification standing, and its limits — permitted collections and permitted actions — or with a refusal.
4. On a verified answer, Canon resolves the agent to its actor record (creating one on first contact, holding the Registry's `agentId` as the `registryRef`), enforces the limits against the request, and attributes the action to that actor in history and the audit log.
5. On any refusal, or no answer, Canon rejects the request. See section 5.

The passport is opaque to Canon by design. Canon must not parse it, derive anything from it, or compare it to anything except the Registry's answer. Treating it as a structureless string is what lets the Registry rotate token formats without Canon noticing.

## 3. The certification check and the one-minute guarantee

Registration is identity; certification is standing. An agent that exists in the Registry but has not earned certification — or whose certification has expired or been revoked — verifies as refused, not as a lesser kind of yes.

Canon checks certification with the Registry:

- **At the start of every agent session.** No agent request is served on the strength of a previous session.
- **On a cadence within a session.** Canon may cache a verified answer to avoid a Registry round-trip on every request, but for no more than sixty seconds. The Registry states its own ceiling in each answer (`recheckAfterSeconds`); Canon honors the smaller of that value and its own sixty-second maximum.

The sixty-second cap is not a tuning knob; it is the guarantee. CORE-PLAN commits Core to "revocation in the Registry takes effect in Canon within one minute," and M3's exit criterion demonstrates it live. The arithmetic is simple: if no verified answer outlives sixty seconds, then within sixty seconds of a revocation every cached answer has expired, the next request re-asks the Registry, and the Registry says no. Canon must never serve a stale cached answer past its expiry — not even when the Registry is down. An expired cache entry plus an unreachable Registry equals a refused request (section 5), because the alternative is an agent whose access outlives its revocation.

Whether one minute is tight enough is an open question, recorded in section 7.

## 4. Permitted collections and actions

The verification answer carries the agent's limits, set in the Registry by the organization's administrators:

- **`permittedCollections`** — the Canon collection IDs the agent may touch, as opaque strings. The single entry `"*"` means all collections. The Registry does not know Canon's collections; administrators copy the IDs in. Canon enforces: a request touching a collection outside the list is forbidden, whatever Canon's own membership tables say.
- **`permittedActions`** — what the agent may do inside its permitted collections, from a fixed vocabulary of three: `read`, `comment`, `write`. `read` covers viewing pages, trees, versions, and grounded answers; `comment` covers commenting; `write` covers drafting, publishing, and page operations, and only where Canon's own workflow allows agents to write at all (Core keeps agents read-mostly; see CORE-PLAN, scope).

Enforcement is an intersection, never a union. An agent acts only where **both** the Registry's limits and Canon's own collection permissions allow. The Registry's answer can narrow what an agent's collection membership would permit; it can never widen it. And per the backbone principles, Canon stores none of this: the limits live in the Registry, arrive with each verification, are enforced against the request in hand, and expire with the cached answer. A limits change in the Registry therefore propagates exactly as fast as a revocation — within the same minute.

Two cases the list of collection IDs does not decide on its own, settled when Epic D wired this contract into Canon's door:

- **A request that spans collections** — a collection listing, a search, the audit log — is narrowed to the agent's permitted collections rather than refused. Refusing a search because the record holds a collection the agent may not see would be a strange reading of "permitted"; the guarantee that matters is that nothing outside the list reaches the agent, and narrowing keeps it.
- **A request that touches no existing collection**, such as creating one, cannot be checked against a list of IDs that necessarily excludes it. Canon requires `"*"` for these: an agent limited to named collections cannot mint itself a new one.

Both rules follow the same principle as the rest of this section — where the limits are silent, the agent gets less, not more.

## 5. Error semantics: fail closed

Every failure mode has one outcome — the agent's request is refused — but Canon distinguishes them, because the audit log and the agent's operator need to know why.

| Registry answer | Meaning | Canon's response to the agent |
| --- | --- | --- |
| `unknown_passport` (404) | No registered agent holds this passport | 401, request refused |
| `certification_lapsed` (403) | The agent is registered but not currently certified — never earned it, or it expired. The Registry does not say which; Canon does not care | 403, request refused |
| `revoked` (403) | Certification was revoked. Terminal | 403, request refused |
| No usable answer | The Registry is unreachable, timed out, or answered something Canon cannot parse | 503, request refused — fail closed |

Two rules sharpen the last row. First, Canon never converts "no answer" into any of the definitive refusals or, worse, into an allowance; it reports the outage as an outage. Second, definitive answers — verified or refused — may be cached up to the sixty-second ceiling, but "no usable answer" is never cached: the next request tries the Registry again, so recovery is immediate when the Registry returns.

Every refused agent request is an audit event in Canon, attributed to the passport's agent where the agent is known. Where it is not — an unknown passport names no agent, and a refusal carries no `agentId` — the event is recorded against a one-way fingerprint of the presented passport, never the passport itself. Rule 1 admits no exception for the audit log: a refused credential written down verbatim is still a credential Canon stores, and a fingerprint correlates repeated attempts without ever being replayable.

## 6. Endpoints

Exact shapes. All requests and responses are JSON. Errors everywhere use the same envelope Canon uses: `{ "error": "<code>", "message": "<human sentence>" }`, plus code-specific fields noted below.

The contract has two faces. The **verification face** (`/verify`) is the one Canon calls; it is the whole of Canon's dependency. The **administrative face** (register, certify, revoke, permissions, listing) is how the Registry's own record is managed; Canon never calls it, but the stub implements it so the M3 demonstration can drive the full lifecycle. In the live Registry the administrative face sits behind the Registry's own authentication; the stub, being a test double, leaves it open and says so.

### The verification face (called by Canon)

**`POST /verify`** — present a passport, get the agent's standing and limits.

Request:

```json
{ "passport": "vap_9f2c47a1..." }
```

Response `200` — the agent is registered and currently certified:

```json
{
  "agentId": "7c9e6679-7425-40de-963d-7806dca2f2f1",
  "name": "PolicyBot",
  "certified": true,
  "permittedCollections": ["c1a2...", "d4b8..."],
  "permittedActions": ["read", "comment"],
  "checkedAt": "2026-07-30T12:00:00.000Z",
  "recheckAfterSeconds": 60
}
```

`certified` is always literally `true` in a `200`; there is no certified-false success. `recheckAfterSeconds` is the Registry's ceiling on how long Canon may act on this answer without re-asking; Canon applies the smaller of this and sixty seconds.

Response `400` `{ "error": "invalid", ... }` — no `passport` field.

Response `404` `{ "error": "unknown_passport", ... }`.

Response `403` `{ "error": "certification_lapsed", ... }` — registered, not currently certified (never certified, or expired).

Response `403` `{ "error": "revoked", "revokedAt": "2026-07-30T11:59:40.000Z", ... }`.

### The administrative face (Registry-side)

**`POST /agents`** — register an agent and issue its passport.

Request:

```json
{
  "name": "PolicyBot",
  "permittedCollections": ["c1a2..."],
  "permittedActions": ["read", "comment"]
}
```

`permittedCollections` defaults to `[]` (nowhere), `permittedActions` to `["read"]`. Unknown actions are `400 invalid`.

Response `200`:

```json
{
  "agentId": "7c9e6679-7425-40de-963d-7806dca2f2f1",
  "name": "PolicyBot",
  "passport": "vap_9f2c47a1...",
  "certification": { "state": "pending", "certifiedAt": null, "expiresAt": null, "revokedAt": null, "reason": null },
  "permittedCollections": ["c1a2..."],
  "permittedActions": ["read", "comment"],
  "createdAt": "2026-07-30T12:00:00.000Z"
}
```

The passport appears here, once, and never again — not in listings, not in any later response. A newly registered agent is `pending`: it holds a passport but verifies as `certification_lapsed` until certified. Identity is not standing.

**`POST /agents/:agentId/certify`** — grant certification.

Request: `{ "expiresAt": "2026-10-30T00:00:00.000Z" }` — optional; `null` or absent means no expiry. Response `200`: the agent record (as above, without `passport`), `certification.state` now `"certified"` with `certifiedAt` set. A revoked agent cannot be re-certified in the stub: `409 conflict`. Revocation is terminal; register a new agent.

**`POST /agents/:agentId/revoke`** — revoke certification.

Request: `{ "reason": "Retired after incident review" }` — optional. Response `200`: the agent record, `certification.state` now `"revoked"` with `revokedAt` and `reason` set. Idempotent: revoking twice keeps the first `revokedAt`.

**`PUT /agents/:agentId/permissions`** — replace limits.

Request: `{ "permittedCollections": ["*"], "permittedActions": ["read"] }` — either field may be omitted to leave it unchanged; a present field replaces the old value entirely. Response `200`: the agent record.

**`GET /agents`** — administrative listing.

Response `200`: an array of agent records (no passports). Each record's `certification.state` is the *effective* state: `"lapsed"` is reported for a certified agent whose `expiresAt` has passed, so an administrator reads standing directly instead of doing date arithmetic.

**`GET /health`** — `{ "ok": true, "product": "Veryl Agent Registry", "stage": "stub" }`.

Unknown agent IDs on any administrative route are `404 not_found`.

## 7. Open questions

- **Session-level immediate cutoff versus the one-minute window.** CORE-PLAN's open question, restated here because this contract is where it lands: is a sub-sixty-second revocation window acceptable to compliance teams, or must revocation sever live sessions immediately? The contract as written guarantees the minute; immediate cutoff would add a push channel or per-request verification (cache TTL of zero — which this contract already permits, at the cost of a Registry round-trip per request). Resolve with the Registry team and the first design partner; nothing in this contract forecloses either answer.
- **Push versus pull for the audit trail.** DATA-BACKBONE asks whether the Registry needs agent activity streamed from Canon or can pull from the audit log. Resolve alongside the question above; the same push channel would serve both.
- **Limits vocabulary growth.** Three actions suffice for Core's read-mostly agents. The Next tier's agent proposals will want a `propose` action; adding one is additive and Canon must reject actions it does not recognize rather than guessing.

---

*Naming per the brief: Veryl Canon and Veryl Agent Registry in full on first mention and in headings; Canon and the Registry once inside context.*
