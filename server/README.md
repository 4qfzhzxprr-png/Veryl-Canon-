# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md) plus the Epic C status machine.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, and effective date (Policy only).
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked Canonical-first then by relevance, and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Comments and notifications.** Inline comments anchored to a quoted passage (plus optional context) and page-level comments, resolve and reopen, `@<actorId>` mentions, and an outbox-pattern notifications table with a pluggable transport (the dev transport logs to the console and marks sent). Review requests, approvals, and send-backs notify the people involved; mentions notify the mentioned.
- **Agents at the door.** Approved agents authenticate with an Agent Passport verified against the Veryl Agent Registry, resolve to their own Canon actor, and act only inside the intersection of the Registry's limits and Canon's collection permissions. See "Two ways in" below.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date.
- **The web UI.** A zero-dependency static SPA served from [public/](public/) at the server root: collections and page trees with status badges, the draft editor with the page-lock screen, the full review flow, version history with side-by-side compare and restore, search, comments, and the audit view. Safe-subset markdown rendering (escape-first). Identity via a dev "who are you" screen until SSO lands. The Ask view (grounded answers — question box, cited answer, refusal state) is built against the `POST /ask` contract in [DATA-BACKBONE.md](../DATA-BACKBONE.md) §5 and feature-detects it: while the endpoint returns 404, the whole experience stays hidden, exactly as search and comments do.

## Two ways in: people and agents

Canon has one door and two credentials at it. A request carries a person's identity or an agent's passport, never both.

| Mode | Header | Live when | What it means |
| --- | --- | --- | --- |
| **Dev mode** (default) | `X-Actor-Id: <actorId>` | always | The alpha's stand-in for SSO. Any actor id names its actor; nothing is verified. |
| **Agent Passport** | `X-Agent-Passport: <token>` | `CANON_REGISTRY_URL` is set | The passport is verified with the Veryl Agent Registry on every session, resolved to an agent actor, and the Registry's limits are enforced on the request. |

With no Registry configured, Canon runs dev mode only: a request carrying `X-Agent-Passport` is refused with `503 unavailable` and a message naming the missing setting. Setting one environment variable turns passport authentication on, and swapping the stub for the live Registry is the same one variable:

```sh
CANON_REGISTRY_URL=http://127.0.0.1:3100 npm start   # passport authentication live
# CANON_REGISTRY_TTL_MS=30000    how long a verified answer may be reused; clamped to 60s, 0 = verify every request
# CANON_REGISTRY_TIMEOUT_MS=3000 how long to wait for the Registry before failing closed
```

How an agent request is handled ([`src/agentauth.ts`](src/agentauth.ts), per [REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md)):

- **Verified, not trusted locally.** The passport goes to the Registry's `POST /verify`. Canon stores no credential of any kind: it matches the answer's `agentId` against the actor's `registryRef`, creating the agent actor on first sight (named by the Registry, kind `agent`) and reusing it after.
- **Limits enforced as an intersection.** The answer's `permittedCollections` and `permittedActions` (`read`, `comment`, `write`) are applied before the store sees the request; Canon's own collection roles are applied by the store as usual. An agent acts only where **both** allow — the Registry can narrow what Canon's membership grants, never widen it, and vice versa. Responses that span collections (collection listings, search, the audit log) are narrowed to permitted collections rather than refused.
- **Fail closed.** Unknown passport → `401`, lapsed or revoked certification → `403`, unreachable or unparseable Registry → `503`. No answer is ever an allowance, and an outage is never cached, so recovery is immediate. Verified answers live at most sixty seconds, which is the revocation guarantee: revoking an agent in the Registry cuts its access in Canon inside a minute.
- **Audited.** Each fresh verification is an `agent.session` event, refusals are `agent.auth_failed` (against the agent where it is known, otherwise a one-way fingerprint of the presented passport — never the passport), limit denials are `agent.denied`, and every agent action carries `actorKind: 'agent'` into history and the audit log.

## What is stubbed, and where it goes next

- **Identity.** People arrive via the `X-Actor-Id` header until SSO lands. Agents authenticate with their Agent Passport (above); the Registry behind it is the stub in [registry-stub/](../registry-stub/) until the live service is ready.
- **Live email delivery** (notifications land in the outbox with a dev transport today; a real email transport plugs into the same interface), **grounded answers** (Epic D, M3), **audit CSV export and import** (Epic E, M4).

## Running it

Node 22+ (uses the built-in `node:sqlite`; no runtime dependencies).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + invariant test suite
npm start     # serve on :3000, record in ./canon.db (CANON_DB, PORT to override)
```

## API sketch

All requests JSON; identity via `X-Actor-Id`, or `X-Agent-Passport` for agents (see above).

```
GET    /health
POST   /actors                              create person or agent (agents need registryRef)
POST   /collections                         { name, description?, restricted? }
GET    /collections | /collections/:id | /collections/:id/tree | /collections/:id/members
PUT    /collections/:id/members/:actorId    { role }
POST   /pages                               { collectionId, parentId?, type, title }
GET    /pages/:id                           page + current published version
PUT    /pages/:id/draft                     { title?, body?, fields? } — acquires the page lock
DELETE /pages/:id/draft                     discard
POST   /pages/:id/publish                   { note? }
POST   /pages/:id/submit | /approve | /send-back
POST   /pages/:id/move                      { parentId }
POST   /pages/:id/archive
GET    /pages/:id/versions | /versions/:n
POST   /pages/:id/restore                   { version }
GET    /search?q=&collection=&type=&status=&owner=&limit=
GET    /audit?actor=&action=&from=&to=
POST   /pages/:id/comments                  { body, anchor? { quote, context? } } — @<actorId> mentions notify
GET    /pages/:id/comments
POST   /comments/:id/resolve | /reopen
GET    /notifications                       the caller's own, newest first
```
