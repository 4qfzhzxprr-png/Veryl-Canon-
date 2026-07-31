# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md) plus the Epic C status machine.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, and effective date (Policy only).
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked Canonical-first then by relevance, and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Comments and notifications.** Inline comments anchored to a quoted passage (plus optional context) and page-level comments, resolve and reopen, `@<actorId>` mentions, and an outbox-pattern notifications table with a pluggable transport (the dev transport logs to the console and marks sent). Review requests, approvals, and send-backs notify the people involved; mentions notify the mentioned.
- **Email delivery.** A real SMTP client written on `node:net` and `node:tls` — STARTTLS or direct TLS, `AUTH PLAIN` and `AUTH LOGIN`, dot-stuffed `DATA` — sends the notifications the outbox holds. Messages are RFC 5322 with a plain-text and an HTML part, and each one carries a deep link straight to the page or its review, which is what CORE-PLAN.md section 7 names as the answer to review friction. Delivery is retried with backoff and bounded attempts; a permanently refused message (5xx, no address on record) is marked dead rather than retried forever, with the reason kept on the row. Configured entirely by environment variables (below); with none set, behaviour is exactly as it was — the dev transport logs to the console.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date.
- **The web UI.** A zero-dependency static SPA served from [public/](public/) at the server root: collections and page trees with status badges, the draft editor with the page-lock screen, the full review flow, version history with side-by-side compare and restore, search, comments, and the audit view. Safe-subset markdown rendering (escape-first). Identity via a dev "who are you" screen until SSO lands.

## What is stubbed, and where it goes next

- **Identity.** Actors arrive via the `X-Actor-Id` header. People get SSO and agents get live Agent Passport authentication with per-session certification checks when the Registry contract lands (Epic D, M3).
- **Grounded answers** (Epic D, M3), **audit CSV export and import** (Epic E, M4).

## Running it

Node 22+ (uses the built-in `node:sqlite`; no runtime dependencies).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + invariant test suite
npm start     # serve on :3000, record in ./canon.db (CANON_DB, PORT to override)
```

### Email

Set `CANON_SMTP_URL` and notifications go out by email; leave it unset and they are logged by the dev transport, as before.

| Variable | Meaning |
| --- | --- |
| `CANON_SMTP_URL` | The relay, e.g. `smtp://user:pass@relay.internal:587`. `smtp://` upgrades with STARTTLS (required whenever credentials are present, so a password never crosses in clear); `smtps://` is TLS from the first byte, default port 465. Optional flags: `?starttls=required\|opportunistic\|off`, `?insecure=true` for a self-signed relay certificate, `?name=` for the EHLO name, `?timeout=` in milliseconds. |
| `CANON_MAIL_FROM` | The sender, e.g. `Veryl Canon <canon@example.com>` or a bare address. Required once `CANON_SMTP_URL` is set. |
| `CANON_BASE_URL` | Where Canon is reachable, e.g. `https://canon.example.com`. Deep links in the emails are built from it; without it they point at `http://localhost:3000`. |
| `CANON_PRODUCT_NAME` | Optional; the name in the email footer. Defaults to `Veryl Canon`. |
| `CANON_FLUSH_INTERVAL_MS` | Optional; how often the server runs its own delivery pass. Defaults to 60000. Set `0` to turn it off and drive `POST /notifications/flush` from your own scheduler. |

Delivery is an outbox, never an inline send: the notification row is written first, and a delivery pass hands it to the relay. **A real deployment runs that pass on a timer** — the built-in one every `CANON_FLUSH_INTERVAL_MS`, or `POST /notifications/flush` from cron or a Kubernetes CronJob every minute or so. Each pass takes a bounded batch (`{ "limit": n }`, default 25), retries a transient failure with backoff (1, 5, 15, 60 minutes, then dead after five attempts), and never delivers a row twice.

## API sketch

All requests JSON; identity via `X-Actor-Id` (see above).

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
POST   /notifications/flush                 { limit? } — deliver queued notifications (requires admin somewhere)
```
