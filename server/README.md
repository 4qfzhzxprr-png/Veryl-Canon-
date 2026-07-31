# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md) plus the Epic C status machine.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, and effective date (Policy only).
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked Canonical-first then by relevance, and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Comments and notifications.** Inline comments anchored to a quoted passage (plus optional context) and page-level comments, resolve and reopen, `@<actorId>` mentions, and an outbox-pattern notifications table with a pluggable transport (the dev transport logs to the console and marks sent). Review requests, approvals, and send-backs notify the people involved; mentions notify the mentioned.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date, and exportable as RFC 4180 CSV (`GET /audit.csv`, same filters). The export is bounded by construction: at most 1000 records, newest first, with `x-canon-truncated: true` when the cap was reached — narrow with `from`/`to` to walk a longer log.
- **Import.** Confluence HTML space exports and Google Docs (Takeout) exports, read from an unpacked directory on disk. The Confluence importer recovers the page tree from the export's index and falls back to page breadcrumbs, then to a flat import. Both share a tolerant, dependency-free HTML → structured-text converter (headings, bold, italics, lists, tables, links, code blocks, images as links) that never emits HTML into a page body and never chokes on malformed markup. Everything arrives as a Draft attributed to the importing actor; nothing is ever Canonical on arrival. See [Importing](#importing).
- **The web UI.** A zero-dependency static SPA served from [public/](public/) at the server root: collections and page trees with status badges, the draft editor with the page-lock screen, the full review flow, version history with side-by-side compare and restore, search, comments, and the audit view. Safe-subset markdown rendering (escape-first). Identity via a dev "who are you" screen until SSO lands.

## What is stubbed, and where it goes next

- **Identity.** Actors arrive via the `X-Actor-Id` header. People get SSO and agents get live Agent Passport authentication with per-session certification checks when the Registry contract lands (Epic D, M3).
- **Live email delivery** (notifications land in the outbox with a dev transport today; a real email transport plugs into the same interface), **grounded answers** (Epic D, M3).
- **Import scope.** Archives are not unpacked for you, attachments and image files are not carried into the record, and SharePoint and Notion importers come in a later tier. Import runs through the API, not the web UI.

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
GET    /audit?actor=&action=&from=&to=&limit=
GET    /audit.csv?actor=&action=&from=&to=&limit=   same filters, RFC 4180 CSV download
POST   /imports                                    { source, path, collectionId, type?, runId? } -> run summary
GET    /imports                                    runs in collections the caller belongs to
GET    /imports/:id                                one run, with a per-file outcome for each file
POST   /pages/:id/comments                  { body, anchor? { quote, context? } } — @<actorId> mentions notify
GET    /pages/:id/comments
POST   /comments/:id/resolve | /reopen
GET    /notifications                       the caller's own, newest first
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
