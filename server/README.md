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
- **Agents at the door.** Approved agents authenticate with an Agent Passport verified against the Veryl Agent Registry, resolve to their own Canon actor, and act only inside the intersection of the Registry's limits and Canon's collection permissions. See "Two ways in" below.
- **Email delivery.** A real SMTP client written on `node:net` and `node:tls` — STARTTLS or direct TLS, `AUTH PLAIN` and `AUTH LOGIN`, dot-stuffed `DATA` — sends the notifications the outbox holds. Messages are RFC 5322 with a plain-text and an HTML part, and each one carries a deep link straight to the page or its review, which is what CORE-PLAN.md section 7 names as the answer to review friction. Delivery is retried with backoff and bounded attempts; a permanently refused message (5xx, no address on record) is marked dead rather than retried forever, with the reason kept on the row. Configured entirely by environment variables (below); with none set, behaviour is exactly as it was — the dev transport logs to the console.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date, and exportable as RFC 4180 CSV (`GET /audit.csv`, same filters). The export is bounded by construction: at most 1000 records, newest first, with `x-canon-truncated: true` when the cap was reached — narrow with `from`/`to` to walk a longer log.
- **Import.** Confluence HTML space exports and Google Docs (Takeout) exports, read from an unpacked directory on disk. The Confluence importer recovers the page tree from the export's index and falls back to page breadcrumbs, then to a flat import. Both share a tolerant, dependency-free HTML → structured-text converter (headings, bold, italics, lists, tables, links, code blocks, images as links) that never emits HTML into a page body and never chokes on malformed markup. Everything arrives as a Draft attributed to the importing actor; nothing is ever Canonical on arrival. See [Importing](#importing).
- **Federation.** Facts other systems own are referenced, never copied ([DATA-BACKBONE.md §6](../DATA-BACKBONE.md)). A **Source** is a registered external system (`name`, `kind`, `baseUrl`, `authMode`, `freshnessWindowMs`, and the collections it may be referenced from — an empty scope means Canon-wide); registering or changing one takes `admin` on those collections, and every change is an audit event. **Canon stores no credential for a source**: there is no credential column, a per-asker credential is never held, and a service credential belongs to the deployment's configuration. A **reference field** on a page is `{ sourceId, selector, key }` — structured data on the page, never parsed from its body — and resolves to `{ value, resolvedAt, fromCache, stale, sourceName, error? }`. The last resolved value is cached with its fetch time: past the source's freshness window it is still returned, but marked `stale` rather than presented as current, and a connector failure returns the cached value stale **with the error**, or an error and no value when nothing was ever cached. Nothing is ever invented. `per_asker` sources carry the asking actor's identity into the source and cache per asker, so one reader's entitled value can never reach another's screen; `service` sources resolve once and that value is visible to everyone who can view the collection — which is what choosing that mode means. Every resolution is a `reference.resolve` audit event naming who asked, which source, page and selector, and whether the value came from the source or the cache.
- **Connectors.** The integration seam, `resolve(source, request: { selector, key, asker }) -> { value, resolvedAt }`, registered by `source.kind` so a real connector plugs in without touching federation's logic. The shipped default is a hermetic static connector (`kind: 'static'`, `baseUrl` naming a fixture set) — a **test double, not an integration**: it exists so the whole system and the whole suite run with no external calls. A kind with no connector registered fails visibly (`No connector is registered for source kind …`) rather than resolving to nothing.
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
- **Limits enforced as an intersection.** The answer's `permittedCollections`, `permittedSources`, and `permittedActions` (`read`, `comment`, `write`) are applied before the store sees the request; Canon's own collection roles are applied by the store as usual. An agent acts only where **both** allow — the Registry can narrow what Canon's membership grants, never widen it, and vice versa. Responses that span collections (collection listings, search, the audit log) are narrowed to permitted collections rather than refused; a source listing is narrowed to permitted sources the same way.
- **Sources governed like collections.** A federated source is a governed object, so the passport carries which sources an agent may resolve references from — otherwise an agent barred from a collection could read the same facts through the source behind it. Resolving a page's references is `read` and needs the page's collection; registering, changing, or removing a source is `write` and needs `"*"`, exactly as creating a collection does. A page carrying references the agent may not resolve stays readable and each such reference comes back refused in place, never silently dropped: agentauth exposes `refuseUnpermittedSource(sourceId, { pageId, selector, key })`, which returns `null` when the reference may be resolved and a `source_not_permitted` record to occupy its slot when it may not.
- **Fail closed.** Unknown passport → `401`, lapsed or revoked certification → `403`, unreachable or unparseable Registry → `503`. No answer is ever an allowance, and an outage is never cached, so recovery is immediate. Verified answers live at most sixty seconds, which is the revocation guarantee: revoking an agent in the Registry cuts its access in Canon inside a minute.
- **Audited.** Each fresh verification is an `agent.session` event, refusals are `agent.auth_failed` (against the agent where it is known, otherwise a one-way fingerprint of the presented passport — never the passport), limit denials are `agent.denied` — including a refused reference, which names the source withheld and the page it sat on — and every agent action carries `actorKind: 'agent'` into history and the audit log.

## What is stubbed, and where it goes next

- **Identity.** People arrive via the `X-Actor-Id` header until SSO lands. Agents authenticate with their Agent Passport (above); the Registry behind it is the stub in [registry-stub/](../registry-stub/) until the live service is ready.
- **The connector.** The only connector shipped is the hermetic `static` one, whose fixture data is supplied per source. It is a test double: it reaches nothing. A real integration implements `Connector` and registers itself on the store's `ConnectorRegistry` at start-up, keyed by the `kind` its sources carry; nothing else in federation changes.
- **The embedding provider and the answer generator.** Both are interfaces with hermetic defaults: a hashed bag of words and an extractive generator. A hosted or self-hosted embedding model and a real language model plug into the same seams, and nothing else in retrieval changes. Until then the vector channel catches partial term overlap rather than paraphrase, and answers quote rather than compose prose.

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

All requests JSON; identity via `X-Actor-Id`, or `X-Agent-Passport` for agents (see above).

```
GET    /health
POST   /actors                              create person or agent (agents need registryRef)
POST   /collections                         { name, description?, restricted? }
GET    /collections | /collections/:id | /collections/:id/tree | /collections/:id/members
PUT    /collections/:id/members/:actorId    { role }
POST   /pages                               { collectionId, parentId?, type, title }
GET    /pages/:id                           page + current published version + its reference descriptors
PUT    /pages/:id/draft                     { title?, body?, fields? } — acquires the page lock
DELETE /pages/:id/draft                     discard
POST   /pages/:id/publish                   { note? }
POST   /pages/:id/submit | /approve | /send-back
POST   /pages/:id/move                      { parentId }
POST   /pages/:id/archive
GET    /pages/:id/versions | /versions/:n
POST   /pages/:id/restore                   { version }
GET    /search?q=&collection=&type=&status=&owner=&limit=
GET    /audit?actor=&action=&from=&to=&limit=
GET    /audit.csv?actor=&action=&from=&to=&limit=   same filters, RFC 4180 CSV download
POST   /imports                                    { source, path, collectionId, type?, runId? } -> run summary
GET    /imports                                    runs in collections the caller belongs to
GET    /imports/:id                                one run, with a per-file outcome for each file
POST   /pages/:id/comments                  { body, anchor? { quote, context? } } — @<actorId> mentions notify
GET    /pages/:id/comments
POST   /comments/:id/resolve | /reopen
GET    /notifications                       the caller's own, newest first
POST   /ask                                 { question, collectionId?, limit? }
                                            -> { answer | null, citations: [{ pageId, title, version, snippet }],
                                                 refused, reason? }
GET    /pages/:id/related?canonical=&limit=  parent, children, and linked pages, permission-filtered
POST   /notifications/flush                 { limit? } — deliver queued notifications (requires admin somewhere)
POST   /sources                             { name, kind, baseUrl?, authMode, freshnessWindowMs, collectionIds? }
                                            requires admin on the scoped collections (admin somewhere if unscoped)
GET    /sources | /sources/:id              sources scoped to your collections, plus Canon-wide ones
PUT    /sources/:id                         same fields, all optional; admin under the old and the new scope
DELETE /sources/:id                         refuses (409) while any page still references it
POST   /pages/:id/references                { sourceId, selector, key, label? } — requires edit
DELETE /references/:id                      requires edit
GET    /pages/:id/references                resolve this page's references for the asking actor
                                            -> [{ value, resolvedAt, fromCache, stale, sourceName, error? }]
```

## Importing

Import is how a partner's existing material becomes the record. Everything it produces is a **Draft** attributed to the person who ran it; nothing arrives Canonical, and nothing skips review.

### 1. Get the export, and unpack it yourself

Canon reads a directory, never an archive. The operator unzips first. This is deliberate: one less format to get wrong between a partner's corpus and the record.

**Confluence** — in Confluence, *Space settings → Content tools → Export → HTML → Normal export*. You get `<SPACEKEY>.html.zip`. Unpack it:

```sh
unzip MB.html.zip -d ~/exports/member-benefits
ls ~/exports/member-benefits          # index.html, <Page+Title>_<id>.html, attachments/, images/, styles/
```

The importer wants the directory that directly contains `index.html`. Some zips nest one level (`MB/index.html`); point the import at the inner directory.

**Google Docs** — from [Google Takeout](https://takeout.google.com), select Drive, choose **HTML** as the document format, and download. Unpack it and point the import at the folder holding the `.html` documents:

```sh
unzip takeout-20260730.zip -d ~/exports/takeout
ls ~/exports/takeout/Takeout/Drive    # Benefits Enrolment Guide.html, Pharmacy Notes/, images/
```

Sub-folders are walked (up to six levels), so a whole Drive folder can be imported in one run. `images/` and `assets/` directories are skipped.

The directory must be readable by the Canon server process, on the server's own filesystem — `path` is a server-side path, not an upload.

### 2. Choose a collection and a type

Create (or pick) the collection the material belongs in; the importer requires **edit** access to it. Then choose the document type every imported page will carry. `note` is the default and the right answer for a bulk first import: Notes publish directly, so each page arrives with its body as version 1 and is immediately readable and searchable. Types that require a named approver (Policy, Spec) cannot publish without one, so their imported body waits in the page's draft and the run summary says so, per file.

### 3. Run it

```sh
curl -sS -X POST http://localhost:3000/imports \
  -H 'content-type: application/json' \
  -H "x-actor-id: $ACTOR" \
  -d '{"source":"confluence","path":"/home/ops/exports/member-benefits","collectionId":"'"$COLLECTION"'","type":"note"}'
```

`source` is `confluence` or `google-docs`. `type` defaults to `note`. The response is the run summary:

```jsonc
{
  "runId": "9f1c…",
  "source": "confluence",
  "hierarchy": "tree",                 // how the page tree was recovered
  "counts": { "found": 7, "imported": 6, "updated": 0, "skipped": 0, "failed": 1 },
  "files": [
    { "file": "Benefits+Overview_65601.html", "outcome": "imported", "pageId": "…",
      "title": "Benefits Overview", "parentFile": null, "published": true, "reason": null },
    { "file": "Broken+Export_65607.html", "outcome": "failed", "pageId": null,
      "reason": "no readable content: the file parsed to an empty document" }
  ]
}
```

`GET /imports/:id` recalls a run and its per-file outcomes later; `GET /imports` lists the runs in collections you belong to. Every run also writes `import.start`, one `import.page` per file, and `import.finish` to the audit log, naming the source system, the file, and the resulting page — so `GET /audit.csv?action=import.page` is a complete, exportable record of what arrived and from where.

### What the importer guarantees

- **Draft on arrival, always.** Imported pages are created as Draft and published (where the type allows) in the state that keeps them Draft. An import cannot produce a Canonical page.
- **Attribution.** The actor who ran the import is the creator of every page and the author of every version it writes. For types that require an owner, the importer is set as the initial owner; the approver is never assumed.
- **Structure where the export has it.** Confluence hierarchy comes from the nested list in `index.html`; pages the index does not mention fall back to their breadcrumb trail; anything still unplaced lands at the root. The summary's `hierarchy` field says which of `tree`, `breadcrumbs`, or `flat` the run used. Google Docs has no page tree, so its imports are always flat.
- **A bad file never stops the run.** A file that parses to nothing is reported as `failed` with a reason and the run continues. Files over 4 MB are `skipped`. A run reads at most 2000 documents; the rest are reported as skipped so nothing disappears silently.
- **Re-running is safe, per run id.** Pass the `runId` of an earlier run to resume or retry it: files whose content is byte-for-byte unchanged are skipped, and files whose content changed become a **new version of the same page** — never a duplicate. Omitting `runId` starts a new run, which is a fresh import and will create new pages. So: retry with the run id, start over without it.

### What survives, and what does not

Carried over: headings, paragraphs and reading order, bold and italics (including Google Docs' class-based and inline-style emphasis), ordered and unordered lists with nesting, tables (as GFM pipe tables), links (with Google's redirect wrapper unwrapped), inline code, fenced code blocks with their language where the export names it, blockquotes, Confluence info/note/warning macros (as blockquotes), and images as links to where the file sat in the export.

Not carried over: attachment and image **files** (the link records what was there; the bytes stay in the export directory), Confluence macros beyond the info family (they arrive as their rendered text), comments, labels, page restrictions, version history from the source system, and anything the export itself did not write. Cell merges in tables are padded out rather than merged, and inline code containing a backtick degrades to plain text because the editor's safe subset cannot express it.
