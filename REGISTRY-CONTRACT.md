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
3. The Registry answers with the agent's identity, its certification standing, and its limits — permitted collections, permitted sources, and permitted actions — or with a refusal.
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

## 4. Permitted collections, sources, and actions

The verification answer carries the agent's limits, set in the Registry by the organization's administrators:

- **`permittedCollections`** — the Canon collection IDs the agent may touch, as opaque strings. The single entry `"*"` means all collections. The Registry does not know Canon's collections; administrators copy the IDs in. Canon enforces: a request touching a collection outside the list is forbidden, whatever Canon's own membership tables say.
- **`permittedSources`** — the Canon source IDs the agent may resolve references from, as opaque strings, on exactly the same terms. The single entry `"*"` means all sources. Absent or empty means none: an agent whose limits say nothing about sources resolves no federated value at all.
- **`permittedActions`** — what the agent may do inside its permitted collections, from a fixed vocabulary of three: `read`, `comment`, `write`. `read` covers viewing pages, trees, versions, grounded answers, and resolving a page's references; `comment` covers commenting; `write` covers drafting, publishing, page operations, and registering or changing a source, and only where Canon's own workflow allows agents to write at all (Core keeps agents read-mostly; see CORE-PLAN, scope).

`permittedSources` exists because a collection limit that stops at Canon's door is not a limit. [DATA-BACKBONE.md](DATA-BACKBONE.md) (section 6) makes a connection to an external system a governed object for exactly this reason: if agents reach external systems directly, "rules set once, carried everywhere" quietly becomes false, and an agent barred from a collection could read the same facts through the source behind it. So the passport carries which sources the agent may reach alongside which collections it may read, and Canon enforces both at the same door.

### 4.1 The intersection

Enforcement is an intersection, never a union. An agent acts only where **both** the Registry's limits and Canon's own collection permissions allow. The Registry's answer can narrow what an agent's collection membership would permit; it can never widen it. And per the backbone principles, Canon stores none of this: the limits live in the Registry, arrive with each verification, are enforced against the request in hand, and expire with the cached answer. A limits change in the Registry therefore propagates exactly as fast as a revocation — within the same minute.

For sources the rule is word for word the same: an agent resolves a reference only where **both** the Registry permits the source AND Canon's own permissions permit the page the reference sits on. Neither side widens the other. A source in `permittedSources` grants nothing on a page the agent cannot read; a readable page grants nothing through a source the Registry withheld. And because federation resolves with the asker's identity wherever the source can accept it (DATA-BACKBONE, section 6), the source system's own access model is a third narrowing, applied after both of these — three gates in series, no union among them.

### 4.2 Cases the lists of IDs do not decide on their own

Settled when Epic D wired this contract into Canon's door, and extended when sources joined it:

- **A request that spans collections** — a collection listing, a search, the audit log — is narrowed to the agent's permitted collections rather than refused. Refusing a search because the record holds a collection the agent may not see would be a strange reading of "permitted"; the guarantee that matters is that nothing outside the list reaches the agent, and narrowing keeps it. A listing of sources is narrowed the same way, to `permittedSources`.
- **A page that carries references the agent may not resolve** is narrowed, not refused, on the same reasoning. If the page's collection is permitted, the page is readable; the references drawn from permitted sources resolve as usual, and each reference from an unpermitted source comes back **refused in place**. The whole page is never denied because one field behind it was governed elsewhere — that would let a single withheld source blank out a policy the agent is plainly entitled to read.
- **A refused reference must be visibly refused, never silently omitted.** This is the part that is not merely a courtesy. A reference's slot on a page is a claim that a value exists there; a slot that quietly disappears reads as *no such value* — the deductible is unset, the headcount is zero, the claim is not on file. Canon would then be asserting something false on behalf of a system it never asked. So the refusal occupies the slot: the reference is returned with its `sourceId`, no `value`, and `error: "source_not_permitted"`, and any answer that would have leaned on it says it could not read that value rather than composing around the hole. The same discipline the backbone requires of staleness — degrade visibly, never substitute a guess — applies to a refusal, which is just a degradation with a governance cause.
- **A request that touches no existing collection**, such as creating one, cannot be checked against a list of IDs that necessarily excludes it. Canon requires `"*"` for these: an agent limited to named collections cannot mint itself a new one.
- **A request that registers or changes a source** is the same case one level up, and Canon requires `"*"` in `permittedSources` for it, for the same reason creating a collection requires `"*"` in `permittedCollections`: a source is not scoped to one collection, so there is no collection to check the request against. Being permitted to *read through* a source is also not being permitted to *redefine* it — an agent that could repoint a source's `baseUrl` or widen the collections it may be referenced from would be writing its own limits, which is the one thing rule 1 of section 1 forbids. Registering, changing, or removing a source is `write` **and** `"*"`; reading through one is `read` and a named id.
- **A request that authors or removes a reference on a page** needs no `"*"` at all, and this is the distinction that keeps the previous rule honest. A reference belongs to exactly one page, so the collection that governs the page governs the reference: authoring one is `write` on that collection, removing one is `write` on the collection of the page the reference sits on. What the reference *points at* is the governed source, and pointing at a source the Registry withheld resolves to a refusal like any other. An agent may therefore write a reference into a page it may edit without being able to register the system behind it, which is the right split: composing the record is editorial work, and admitting a new external system into Canon is governance.

All of these follow the same principle as the rest of this section — where the limits are silent, the agent gets less, not more.

## 5. Error semantics: fail closed

Every failure mode has one outcome — the agent's request is refused — but Canon distinguishes them, because the audit log and the agent's operator need to know why.

| Registry answer | Meaning | Canon's response to the agent |
| --- | --- | --- |
| `unknown_passport` (404) | No registered agent holds this passport | 401, request refused |
| `certification_lapsed` (403) | The agent is registered but not currently certified — never earned it, or it expired. The Registry does not say which; Canon does not care | 403, request refused |
| `revoked` (403) | Certification was revoked. Terminal | 403, request refused |
| No usable answer | The Registry is unreachable, timed out, or answered something Canon cannot parse | 503, request refused — fail closed |

Two rules sharpen the last row. First, Canon never converts "no answer" into any of the definitive refusals or, worse, into an allowance; it reports the outage as an outage. Second, definitive answers — verified or refused — may be cached up to the sixty-second ceiling, but "no usable answer" is never cached: the next request tries the Registry again, so recovery is immediate when the Registry returns.

Those four are refusals of the *whole request*, decided before Canon's store sees it. A limit denied inside a request Canon did serve is reported in the body rather than the status line, with a machine-readable `reason` so an operator can tell the cases apart:

| Canon's `reason` | Meaning | How it reaches the agent |
| --- | --- | --- |
| `route_not_available_to_agents` | The route is not in the agent vocabulary at all | 403, request refused |
| `action_not_permitted` | `permittedActions` does not carry the action this route needs | 403, request refused |
| `collection_not_permitted` | `permittedCollections` does not carry this collection, or the request creates one without `"*"` | 403, request refused |
| `source_not_permitted` | `permittedSources` does not carry this source | 403 for a request *about* the source; `error: "source_not_permitted"` in the reference's own slot for a reference *through* it (section 4.2) |
| `source_administration_not_permitted` | Registering, changing, or removing a source without `"*"` | 403, request refused |

Every refused agent request is an audit event in Canon, attributed to the passport's agent where the agent is known. A refused reference is one too — the `agent.denied` event names the reference, the source that was withheld, and the page the reference sat on, so the log answers "what did this agent try to reach, and through what" rather than only "what did it read". DATA-BACKBONE (section 6) requires every resolution to be an audit event naming who asked, which source, and which reference; a resolution refused on the Registry's limits is that same event with the reason in place of the value, and it borrows the vocabulary of the `reference.resolve` event rather than inventing a parallel one — the same `referenceId`, `sourceId`, `sourceName`, `authMode`, `selector`, and `key`, with `origin: "none"` for a value that came from neither source nor cache. One audit query then follows a reference across both families, which is the question a compliance lead actually asks. Where it is not — an unknown passport names no agent, and a refusal carries no `agentId` — the event is recorded against a one-way fingerprint of the presented passport, never the passport itself. Rule 1 admits no exception for the audit log: a refused credential written down verbatim is still a credential Canon stores, and a fingerprint correlates repeated attempts without ever being replayable.

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
  "permittedSources": ["src-benefits-admin"],
  "permittedActions": ["read", "comment"],
  "checkedAt": "2026-07-30T12:00:00.000Z",
  "recheckAfterSeconds": 60
}
```

`certified` is always literally `true` in a `200`; there is no certified-false success. `recheckAfterSeconds` is the Registry's ceiling on how long Canon may act on this answer without re-asking; Canon applies the smaller of this and sixty seconds.

`permittedSources` is the one field Canon tolerates the absence of, and it tolerates it in the safe direction: a Registry that predates federation sends no such field, and Canon reads that as the empty list — the agent resolves no references and everything else about the answer stands. A `permittedSources` that is present but is not an array of strings is a malformed answer, refused like any other (section 5, last row). Silence means none; nonsense means no.

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
  "permittedSources": ["src-benefits-admin"],
  "permittedActions": ["read", "comment"]
}
```

`permittedCollections` defaults to `[]` (nowhere), `permittedSources` to `[]` (no source), `permittedActions` to `["read"]`. Unknown actions are `400 invalid`; a `permittedCollections` or `permittedSources` that is not an array of non-empty strings is `400 invalid`.

Response `200`:

```json
{
  "agentId": "7c9e6679-7425-40de-963d-7806dca2f2f1",
  "name": "PolicyBot",
  "passport": "vap_9f2c47a1...",
  "certification": { "state": "pending", "certifiedAt": null, "expiresAt": null, "revokedAt": null, "reason": null },
  "permittedCollections": ["c1a2..."],
  "permittedSources": ["src-benefits-admin"],
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

Request: `{ "permittedCollections": ["*"], "permittedSources": ["src-benefits-admin"], "permittedActions": ["read"] }` — any field may be omitted to leave it unchanged; a present field replaces the old value entirely. Omitting `permittedSources` therefore leaves an agent's source limits alone rather than clearing them; sending `[]` is how an administrator takes federation away. Response `200`: the agent record.

**`GET /agents`** — administrative listing.

Response `200`: an array of agent records (no passports), each carrying `permittedCollections`, `permittedSources`, and `permittedActions`. Each record's `certification.state` is the *effective* state: `"lapsed"` is reported for a certified agent whose `expiresAt` has passed, so an administrator reads standing directly instead of doing date arithmetic.

**`GET /health`** — `{ "ok": true, "product": "Veryl Agent Registry", "stage": "stub" }`.

Unknown agent IDs on any administrative route are `404 not_found`.

## 7. Open questions

- **Session-level immediate cutoff versus the one-minute window.** CORE-PLAN's open question, restated here because this contract is where it lands: is a sub-sixty-second revocation window acceptable to compliance teams, or must revocation sever live sessions immediately? The contract as written guarantees the minute; immediate cutoff would add a push channel or per-request verification (cache TTL of zero — which this contract already permits, at the cost of a Registry round-trip per request). Resolve with the Registry team and the first design partner; nothing in this contract forecloses either answer.
- **Push versus pull for the audit trail.** DATA-BACKBONE asks whether the Registry needs agent activity streamed from Canon or can pull from the audit log. Resolve alongside the question above; the same push channel would serve both.
- **Limits vocabulary growth.** Three actions suffice for Core's read-mostly agents. The Next tier's agent proposals will want a `propose` action; adding one is additive and Canon must reject actions it does not recognize rather than guessing.
- **Granularity below the source.** `permittedSources` limits an agent to whole sources, which is the right grain while a source is one record system reached by one connector. If a design partner needs an agent permitted a source's headcount selector but not its salary selector, the limit wants a selector dimension — an extension of this field, not a new one. Resolve when a real connector exists; nothing here forecloses it, and until then the source is the unit of governance because the source is the unit of registration.

---

*Naming per the brief: Veryl Canon and Veryl Agent Registry in full on first mention and in headings; Canon and the Registry once inside context.*
