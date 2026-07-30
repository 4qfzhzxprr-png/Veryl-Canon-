# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md) plus the Epic C status machine.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, and effective date (Policy only).
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked Canonical-first then by relevance, and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date.

## What is stubbed, and where it goes next

- **Identity.** Actors arrive via the `X-Actor-Id` header. People get SSO and agents get live Agent Passport authentication with per-session certification checks when the Registry contract lands (Epic D, M3).
- **Comments and email notifications** (Epic C, M2), **grounded answers** (Epic D, M3), **audit CSV export and import** (Epic E, M4).

## Running it

Node 22+ (uses the built-in `node:sqlite`; no runtime dependencies).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + invariant test suite
npm start     # serve on :3000, record in ./canon.db (CANON_DB, PORT to override)
```

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
```
