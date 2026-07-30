# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md), the Epic C status machine, and the Epic D retrieval and grounded-answer path.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, and effective date (Policy only).
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked Canonical-first then by relevance, and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Retrieval.** The four deterministic steps of [DATA-BACKBONE.md §5](../DATA-BACKBONE.md): hybrid candidate search (the FTS5/BM25 index unioned with cosine similarity over chunk embeddings, fused by Reciprocal Rank Fusion with k=60), permission filtering *before* ranking — enforced in the SQL that generates candidates, so material the asker cannot see never influences the ranking — and graph expansion along real edges only: parent, children, and explicitly linked pages (`/pages/<id>` and `[[<id>]]`), depth 1 by default, capped, permission-checked, and Canonical-only when expanding for answers. No inferred graph, no model-written community summaries; the explicit graph people maintain is the one we walk.
- **Embeddings.** A second derived index over the published record: overlapping ~800-character chunks split on paragraph boundaries, keyed by page and version, rebuildable in full with `rebuildAll()`. Drafts are never embedded and archived pages leave the index. The provider is pluggable (`EmbeddingProvider`); the default is a dependency-free, deterministic hashed bag of words, which is deliberately **not** semantically strong — it exists so the whole system, and the whole test suite, runs with no external calls and no record text leaving the machine. Rows written by a different provider are ignored by every query and re-derived, so a provider swap never mixes vector spaces.
- **Grounded answers.** `POST /ask` returns `{ answer, citations, refused, reason? }`. Canonical pages only — never a Draft, never a Note, never an archived page — permission-filtered per asker, every answer carrying at least one citation *by construction* (the answer is composed from cited passages, so an uncited answer cannot exist), and refusing with `no_canonical_match` when the record is silent. The generator is a seam (`AnswerGenerator`) for a real model later; the shipped default is extractive and quotes the record verbatim rather than faking an LLM. Every ask lands in the audit log with the question, the refusal flag, and the cited page ids.
- **Comments and notifications.** Inline comments anchored to a quoted passage (plus optional context) and page-level comments, resolve and reopen, `@<actorId>` mentions, and an outbox-pattern notifications table with a pluggable transport (the dev transport logs to the console and marks sent). Review requests, approvals, and send-backs notify the people involved; mentions notify the mentioned.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date.
- **The web UI.** A zero-dependency static SPA served from [public/](public/) at the server root: collections and page trees with status badges, the draft editor with the page-lock screen, the full review flow, version history with side-by-side compare and restore, search, comments, and the audit view. Safe-subset markdown rendering (escape-first). Identity via a dev "who are you" screen until SSO lands.

## What is stubbed, and where it goes next

- **Identity.** Actors arrive via the `X-Actor-Id` header. People get SSO and agents get live Agent Passport authentication with per-session certification checks when the Registry contract lands (Epic D, M3).
- **The embedding provider and the answer generator.** Both are interfaces with hermetic defaults: a hashed bag of words and an extractive generator. A hosted or self-hosted embedding model and a real language model plug into the same seams, and nothing else in retrieval changes. Until then the vector channel catches partial term overlap rather than paraphrase, and answers quote rather than compose prose.
- **Live email delivery** (notifications land in the outbox with a dev transport today; a real email transport plugs into the same interface), **audit CSV export and import** (Epic E, M4).

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
POST   /pages/:id/comments                  { body, anchor? { quote, context? } } — @<actorId> mentions notify
GET    /pages/:id/comments
POST   /comments/:id/resolve | /reopen
GET    /notifications                       the caller's own, newest first
POST   /ask                                 { question, collectionId?, limit? }
                                            -> { answer | null, citations: [{ pageId, title, version, snippet }],
                                                 refused, reason? }
GET    /pages/:id/related?canonical=&limit=  parent, children, and linked pages, permission-filtered
```
