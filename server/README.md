# Veryl Canon server

The first running slice of Veryl Canon: the data storage and organization backbone described in [DATA-BACKBONE.md](../DATA-BACKBONE.md), implementing the M1 foundation from [CORE-PLAN.md](../CORE-PLAN.md), the Epic C status machine, the Epic D retrieval and grounded-answer path, and the first Next-tier feature: the agent proposal loop from [FEATURES.md](../FEATURES.md) §5.

## What works today

- **The record.** Collections with role-based membership (view, comment, edit, approve, admin), pages nesting into trees without depth limit, branch moves that carry children, stable page identity through any move, and the four Core document types (Policy, Spec, Plan, Note) with structured fields stored as data: owner, approver, status, effective date (Policy only, and a Policy requires one), and review date (Policy requires one; Spec and Plan may carry one; a Note carries none, because it never holds the Canonical mark). An effective date earlier than the page's own first publication is allowed — that is what migrating a real corpus looks like — but it must carry an `effectiveDateBasis` saying where the date comes from, and it is surfaced as such in the attestation and counted in record health. Canon records the basis and cannot verify it, and says so.
- **Writing and publishing.** Drafts held apart from the published record, the Core page lock (one editor at a time, with a visible "being edited by"), one-step publishing, and append-only version history with restore-as-new-version. History immutability is enforced by the storage layer itself (SQLite triggers), not just application code.
- **Status and review.** Draft → In Review → Canonical → Needs Update, driven by document type: Notes publish directly and never carry the Canonical mark; Policy and Spec require a named approver; publishing after Canonical drops the mark, because the mark applies to reviewed content. A page the freshness sweep flipped to **Needs Update** returns to Canonical through this same workflow and no other — it may be submitted for review directly, so the return path is edit → submit → approve, exactly as the first grant of the mark was.
- **Freshness.** Canonical pages carry a review date; when it passes, a sweep flips the page to **Needs Update**, writes a notice for its owner to the existing outbox, and writes a `page.needs_update` audit event. **It runs on every deployment, configured or not** — hourly, and once at start-up before the port is bound — which is what makes "stale knowledge announces itself" a claim about the product rather than about deployments that read the start-up log. It runs as **Canon itself** (`system:canon`, `src/system.ts`), not as a borrowed person; `CANON_MAINTENANCE_ACTOR_ID` still names another actor for a deployment that deliberately wants one. `POST /maintenance/freshness` runs the sweep on demand (the org-level **operator** role required, the same question the notification flush asks — see "Who runs this Canon" below) and `GET /maintenance/freshness` says what this deployment actually does, which is what the editor now tells the author instead of promising a flip in general. **Idempotent by construction, not by bookkeeping**: the sweep selects Canonical pages, and a page it has already flipped is no longer Canonical, so a second run notifies nobody twice. There is no "already notified" flag to drift out of step with the record. The sweep is deliberately closed to agents — see "Two ways in" below.
- **What "the owner is notified" actually means, said in the editor.** [FEATURES.md](../FEATURES.md) §3 promises the owner is notified, and the editor used to repeat it flatly under the review-date field. The sweep does write a `review_due` notice to the outbox for every flip — that part was always true — but with no `CANON_SMTP_URL` the dev transport logs it to the server's console, and Canon has **no inbox screen**: `GET /notifications` exists and nothing in the web UI calls it. So an owner with eight stale pages saw nothing, anywhere, and the editor had told them they would. Notification integrations are in FEATURES.md's **Later** tier and this round did not move them, so the promise was **narrowed to what is true** rather than made true: with a relay configured the editor says the owner is emailed, and without one it says the notice is written to the record and that nothing carries it to the owner until a relay or an inbox exists. The start-up log says the same thing to the operator. Building the inbox is separate work and this line will get shorter when it lands.
- **Canon's own actor.** A third `ActorKind`, `system`, and exactly one actor of it: `system:canon`, named *Canon*. It exists because the audit log states an actor and a kind on every event, and an event that said `person` for work no person did would be a falsehood in the one place this product promises there are none. It is deliberately not a UUID, so it is recognisable on sight in a raw row or a CSV export. It **cannot be signed in as** (refused at the `X-Actor-Id` header and at session creation), **cannot be created** (`POST /actors` refuses `kind: system`), **cannot hold a role** (`setMember`, `setOrgRole` and the bootstrap all refuse it), and is **not in the actor directory**, because it is nobody you can name as an owner, an approver or a member. Its authority to run the sweep is not a grant — it is the one thing in the product that calls it. See [`src/system.ts`](src/system.ts), which argues the whole thing.
- **Search.** Full-text search (SQLite FTS5) over the published record only — drafts are never indexed, and archived pages leave search. Results are permission-filtered to collections where the searcher holds at least view, ranked by standing then by relevance — Canonical first, **Needs Update second** (a page past its review date is still the official answer, so it outranks working notes and ranks below current Canonical material), everything else after — and filterable by collection, type, status, and owner. The index is derived and rebuildable from the record; it is never the source of truth.
- **Structured queries.** `POST /queries/run` takes a typed filter object — `collectionIds`, `types`, `statuses`, `ownerIds`, `approverIds`, `hasOwner`, `hasReviewDate`, `reviewDateBefore/After`, `updatedBefore/After`, `createdBefore/After`, `sort`, `direction`, `limit` — and answers the [FEATURES.md](../FEATURES.md) §6 example directly: *all Canonical policies owned by Compliance with a review date in the next 60 days*. **A filter, not a query language**: the moment a filter is a string somebody builds one by concatenation, and the fields the rules depend on are back inside prose. Every member names a real column, is validated against a fixed vocabulary before any SQL exists (a typo is a `400`, never a silently empty dashboard), and reaches the database as a bound parameter. Permission filtering is in the `SELECT` — the membership join, not a pass afterwards — so a non-member's query returns nothing because nothing was ever selected. Archived pages are excluded unless `statuses` names them. Queries can be saved (`POST /queries`), each owned by its creator and refused at save time if it names a collection the creator cannot see.
- **Record health.** `GET /collections/:id/health` returns the [FEATURES.md](../FEATURES.md) §8 list in its smallest honest form, built on the query surface above: pages past review, pages currently Needs Update, pages without owners (only of types that *require* one — an unowned Note is not a health problem, and `TYPE_RULES` decides that, not the summary), orphaned pages (parentless and not the collection home, which is read as the first root page until the record carries a home pointer), and drafts untouched for longer than `?draftDays=` (default 30). One bounded scan, with `truncated: true` when it hits the cap rather than a quietly low number.
- **The knowledge map.** `GET /collections/:id/graph` returns one collection's record as `{ nodes, edges }`, answering two questions at once. *How is this knowledge related* — and the edges are only ever the **explicit** graph [DATA-BACKBONE.md §5](../DATA-BACKBONE.md) insists on: parent → child from the tree, and page → page from links written in **published** bodies, parsed with retrieval's own `parsePageLinks` rather than a second parser that could drift from it. There is no similarity edge and no clustering; an inferred graph drawn as a picture is believed, and Canon does not have one to draw. *Where does its material come from* — every page node carries a provenance of `authored`, `imported` (with the run's source system and file, so a migration's still-traceable pages are visible as one set, which §6 says should be short), or `federated`, and each registered **Source** its pages reference is a node of its own kind, so "which pages depend on the benefits system" is answerable by looking. A page that was imported *and* reads from a live source is labelled federated — the stronger true statement about where its material comes from now — with its origin still named. Status is on every node. **Permission filtering is in the SQL that selects nodes**, so a page the asker cannot see is not a node, and the edge that would have reached it is dropped rather than drawn to a placeholder: on a restricted collection, the placeholder *is* the disclosure. The map deliberately follows links out of the collection, which is the only way that filter ever has work to do.
- **The whole record as one map.** `GET /graph` draws the same explicit graph at the record's altitude: **every collection the asker may view**, or the subset named by a repeatable `?collection=<id>`, with the pages, sources, and edges between them. What it shows that the per-collection map never can is the **cross-collection link** — a page in Compliance linking a page in Product — and that is exactly where the permission rule earns its keep: an edge is drawn only when the asker may see **both** of its ends, and an edge to an invisible page is dropped rather than drawn to a placeholder. Every node carries two numbers the layout needs: `degree`, its edge count, and `rootId`, the top-most visible ancestor within its collection, which a client clusters by. **Both are computed over the filtered graph** — the nodes that survived permission and the cap — so hiding a collection makes the degree of a page that linked into it fall, rather than leaking a number about a graph the asker cannot see. A spanning read is **narrowed, never refused**: a collection the asker is not a member of contributes nothing, naming one in `?collection=` narrows the answer, and an agent's Registry limits narrow it the same way ([REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md) §4.2). Past the page cap the payload says so, with `truncated: { limit, total }` carrying the cap and the record's true total — a quietly short map is a picture of a record with pages missing and no sign that any are. Provenance is classified in exactly one place (`classifyProvenance` in [`src/graph.ts`](src/graph.ts)), so the two views can never disagree about whether a page is imported.
- **Retrieval.** The four deterministic steps of [DATA-BACKBONE.md §5](../DATA-BACKBONE.md): hybrid candidate search (the FTS5/BM25 index unioned with cosine similarity over chunk embeddings, fused by Reciprocal Rank Fusion with k=60), permission filtering *before* ranking — enforced in the SQL that generates candidates, so material the asker cannot see never influences the ranking — and graph expansion along real edges only: parent, children, and explicitly linked pages (`/pages/<id>` and `[[<id>]]`), depth 1 by default, capped, permission-checked, and Canonical-only when expanding for answers. No inferred graph, no model-written community summaries; the explicit graph people maintain is the one we walk.
- **Embeddings.** A second derived index over the published record: overlapping ~800-character chunks split on paragraph boundaries, keyed by page and version, rebuildable in full with `rebuildAll()`. Drafts are never embedded and archived pages leave the index. The provider is pluggable (`EmbeddingProvider`); the default is a dependency-free, deterministic hashed bag of words, which is deliberately **not** semantically strong — it exists so the whole system, and the whole test suite, runs with no external calls and no record text leaving the machine. Rows written by a different provider are ignored by every query and re-derived, so a provider swap never mixes vector spaces.
- **Grounded answers.** `POST /ask` returns `{ answer, citations, refused, reason?, pastReview?, disagreement? }`. The official record only — never a Draft, never a Note, never an archived page — permission-filtered per asker, every answer carrying at least one citation *by construction* (the answer is composed from cited passages, so an uncited answer cannot exist), and refusing with `no_canonical_match` when the record is silent. The generator is a seam (`AnswerGenerator`) for a real model later; the shipped default is extractive and quotes the record verbatim rather than faking an LLM. Every ask lands in the audit log with the question, the refusal flag, the cited page ids, and — when there was one — the pages that disagreed.

  **An answer never smooths a contradiction** ([DATA-BACKBONE.md §7](../DATA-BACKBONE.md), the sharpest rule in that section). Before generation, the passages an answer is about to be composed from are checked against each other; when they conflict, the response carries `disagreement: { pageIds, note }`, **all** the disagreeing pages are cited, the answer text states that the record gives more than one answer and quotes both, and Canon does not choose. Refusal would be the wrong move here — two cited answers and a warning serve the reader better than silence.

  What is detected is deliberately narrow and deliberately honest, because a false claim of contradiction is its own kind of confident wrong answer: **quantity conflict** (different values, in exactly convertible units, for what reads as the same subject — "seven years" against "ten years", `$1,500` against `$1,200`, "80 percent" against "50 percent") and **explicit polarity conflict** ("approval is required" against "approval is not required", where the denial is a literal negation cue sitting on a word the other passage uses). A number counts only when it carries a unit, so version numbers, dates and step counts never enter the comparison; bounded and excepted figures ("at least seven years", "20 percent are exempt") are dropped rather than compared; units that do not convert exactly (days against months) are never claimed to agree or disagree; and a page is never played off against itself. General semantic contradiction is **not** attempted and there is no model pretending to — two passages that conflict in meaning without a number or a negation are invisible here, which is the correct failure.

  Detection lives in `answers.ts`, *outside* the `AnswerGenerator` seam and before it is called, because a model told "here are three passages" will reconcile them. The generator is handed the disagreement as an advisory so it can present it well, and has no channel to deny or withdraw one: the `disagreement` field is set from detection, every page it names is cited whether the generator cited it or not, and if the returned prose does not carry the note verbatim Canon writes the notice itself and puts it in front of whatever the generator wrote.

  **A Needs Update page may be cited, and the answer says so.** This is the one judgement freshness forced, and it is argued in full above `eligible` in [`src/answers.ts`](src/answers.ts). In short: a Needs Update page was approved, still has an owner, and nothing has replaced it — dropping it does not give the asker a better answer, it tells them the record is silent about a policy that plainly exists. And refusing would make the feature punish honesty: if setting a review date means the page vanishes from answers the day it comes due, the rational move is never to set one, and freshness dies of its own incentives. So the passage is cited, marked *past review* in the answer text, and named in the response's `pastReview` array. Archived pages are still gone and Drafts and Notes still cannot be cited at all; Needs Update is the only addition, because it is the only status that means "Canonical, and overdue" rather than "not Canonical".
- **Comments and notifications.** Inline comments anchored to a quoted passage (plus optional context) and page-level comments, resolve and reopen, `@<actorId>` mentions, and an outbox-pattern notifications table with a pluggable transport (the dev transport logs to the console and marks sent). Review requests, approvals, and send-backs notify the people involved; mentions notify the mentioned.
- **Agents at the door.** Approved agents authenticate with an Agent Passport verified against the Veryl Agent Registry, resolve to their own Canon actor, and act only inside the intersection of the Registry's limits and Canon's collection permissions. See "Two ways in" below.
- **Agent proposals.** The propose-and-review loop from [FEATURES.md](../FEATURES.md) §5, the piece Core deferred: an agent that spots a stale figure or a gap drafts the change and submits it for review, and a person turns it into the record. A proposal is **not** a draft and never takes the page lock — it lives in its own table, so one page carries any number of open proposals from any number of agents and people while someone edits it normally. Every proposal states **why** (`rationale`; a proposal without one is refused), and is written against a base version. Accepting publishes it through the same path `publish()` uses, so the type's rules survive intact: a Policy still needs its owner and named approver, and an accepted proposal lands at **Draft** — Canonical is still only reachable through `submitForReview` and the named approver. The new version is **authored by the proposer** with the accepting person recorded on the proposal, in the version's note, and in the audit log. If the page moved on since the proposal was written, acceptance is refused with `409 conflict` and the proposal is marked superseded, so newer content is never silently clobbered; accepting one proposal supersedes the rest on that page for the same reason. Proposing takes the Registry's `write` **and** Canon's `edit`; accepting and rejecting are a person's act and are closed to agents at both the door and the store. The whole loop is audited as `proposal.create`, `proposal.accept`, `proposal.reject`, `proposal.supersede`.
- **The Knowledge API.** Veryl Studio's door into the record ([STUDIO-CONTRACT.md](../STUDIO-CONTRACT.md), [`src/knowledge.ts`](src/knowledge.ts)), under `/knowledge/…`. A Studio app *is* an agent — same passport, same Registry limits, no second credential model — and additionally names the person it is acting for in `X-On-Behalf-Of`, on every call. The effective permission is the **intersection of three things**: the app's Registry limits, the app's Canon permissions, and that person's Canon permissions. An app can never lend a person access the person does not have, and a person can never lend the app access the app does not have. Nothing is cached and no grant is minted, so a permission change or a revocation is effective on the very next call; every call is an audit event naming the app, the person, and what was touched. Grounded answers through it are the same `ask` the question box uses — Canonical only, cited, refusing when the record is silent — with the person's permissions and the Registry's collection limit carried into the candidate SQL *before* ranking, never applied to citations afterwards. The worked example is [studio-stub/](../studio-stub/).
- **Email delivery.** A real SMTP client written on `node:net` and `node:tls` — STARTTLS or direct TLS, `AUTH PLAIN` and `AUTH LOGIN`, dot-stuffed `DATA` — sends the notifications the outbox holds. Messages are RFC 5322 with a plain-text and an HTML part, and each one carries a deep link straight to the page or its review, which is what CORE-PLAN.md section 7 names as the answer to review friction. Delivery is retried with backoff and bounded attempts; a permanently refused message (5xx, no address on record) is marked dead rather than retried forever, with the reason kept on the row. Configured entirely by environment variables (below); with none set, behaviour is exactly as it was — the dev transport logs to the console.
- **Trust.** Every write attributed to its actor; agents are actors that require a Registry reference (Agent Passport) and carry their kind into history and audit. The append-only audit log records all writes, plus page views on restricted collections, filterable by actor, action, and date, and exportable as RFC 4180 CSV (`GET /audit.csv`, same filters). The export is bounded by construction: at most 1000 records, newest first, with `x-canon-truncated: true` when the cap was reached — narrow with `from`/`to` to walk a longer log.
- **A tamper-evident audit log, and honesty about what that means.** Every audit event carries a SHA-256 link over its own content plus the previous event's link, written by an `AFTER INSERT` trigger rather than by application code — eleven call sites append audit events, and a helper each of them had to remember to call would be a chain with eleven ways to have a gap. `GET /audit/verify` (and `npm run verify:audit`, which exits non-zero on a break) walks the chain and names the **first** break: a tampered event, a deleted one (its orphaned link is the evidence), a reordering, or an event inserted without a link. **What this proves:** no event has been altered, deleted, reordered or inserted since it was written. **What it does not:** the chain lives in the same SQLite file as the events, so somebody who can write to that file and knows the recipe can delete an event and recompute every later link, and the check would then report clean; and no chain says anything about events that were never written. Closing the first gap needs **periodic external anchoring** of the head hash — publish `{ headEventId, headHash, takenAt }` somewhere Canon cannot write, and a wholesale recomputation can no longer reproduce an anchored head. Canon gives an anchor everything it needs and deliberately does not perform one: where you publish it is your trust boundary, not ours. An existing record is chained **from its head forward**; events written before are reported as `unchained` for ever, because links computed for them now would be computed from their present contents and would prove nothing.
- **Attestation and export.** The artefact a regulated buyer asks for in the first meeting ([FEATURES.md](../FEATURES.md) §7). `GET /pages/:id/as-of?at=<ISO>` reconstructs what a page said at an instant, the fields and status **as they were**, and the approval that granted the standing it held then — from immutable history, not from a stored snapshot, so anyone with access can recompute it and get the same answer. A page that did not exist yet says so; a page archived by then says that, rather than serving the nearest version as though it were the record. `GET /pages/:id/attestation` assembles the whole bundle — identity, every published version with author, timestamp and note, the full field history, every status change with its actor, the approvals named, the audit events touching the page each with its chain link, the point-in-time answer when `at` is given, and a **manifest** carrying what the bundle asserts, who generated it and when, the chain head at generation, the id of the audit event recording the generation, and step-by-step instructions for checking the claim without trusting the file. `GET /collections/:id/attestation` is the register: which pages held the Canonical mark on a date, with owners, approvers and review dates — and which did not. Two renderings from one builder: JSON for machines, and a **self-contained HTML document** for people — inline CSS, no script, no image, no font, no external reference of any kind, printing cleanly to PDF from any browser with no PDF library involved. Generating either is itself an audited act (`attestation.generate`), and reading a restricted page through `as-of` leaves a `page.view` behind exactly as reading it normally does.
- **Import.** Confluence HTML space exports and Google Docs (Takeout) exports, read from an unpacked directory on disk. The Confluence importer recovers the page tree from the export's index and falls back to page breadcrumbs, then to a flat import. Both share a tolerant, dependency-free HTML → structured-text converter (headings, bold, italics, lists, tables, links, code blocks, images as links) that never emits HTML into a page body and never chokes on malformed markup. Everything arrives as a Draft attributed to the importing actor; nothing is ever Canonical on arrival. See [Importing](#importing).
- **Federation.** Facts other systems own are referenced, never copied ([DATA-BACKBONE.md §6](../DATA-BACKBONE.md)). A **Source** is a registered external system (`name`, `kind`, `baseUrl`, `authMode`, `freshnessWindowMs`, and the collections it may be referenced from — an empty scope means Canon-wide); registering or changing one takes `admin` on those collections, and every change is an audit event. **Canon stores no credential for a source**: there is no credential column, a per-asker credential is never held, and a service credential belongs to the deployment's configuration. A **reference field** on a page is `{ sourceId, selector, key }` — structured data on the page, never parsed from its body — and resolves to `{ value, resolvedAt, fromCache, stale, sourceName, error? }`. The last resolved value is cached with its fetch time: past the source's freshness window it is still returned, but marked `stale` rather than presented as current, and a connector failure returns the cached value stale **with the error**, or an error and no value when nothing was ever cached. Nothing is ever invented. `per_asker` sources carry the asking actor's identity into the source and cache per asker, so one reader's entitled value can never reach another's screen; `service` sources resolve once and that value is visible to everyone who can view the collection — which is what choosing that mode means. Every resolution is a `reference.resolve` audit event naming who asked, which source, page and selector, and whether the value came from the source or the cache.
- **Authority, corroboration, and divergence.** What happens when the record disagrees with itself ([DATA-BACKBONE.md §7](../DATA-BACKBONE.md)), and the short answer is that **Canon does not decide**. A reference declares which system owns the fact it names: `role: 'authority'` (the default, so every reference written before this kept its meaning) or `'corroborating'`. At most one authority per `(page, selector, key)` — a second is a `409`, because two authorities for one fact is a contradiction in the *model* rather than in the data — and a corroborating reference requires an authority to corroborate, because §7's precedence rule is "there is an authority and there are copies". **The authority's value is what displays, always**: a corroborating source never replaces it, never overrides it when fresher, and never blanks it when it disagrees. *Freshness is not authority* — a stale answer from the system that owns a fact still beats a fresh one from a system that does not. When a page's references resolve, each corroborating value is compared against its authority's, and a mismatch writes a **Divergence** — which reference, which sources, what each said, when it was observed — notifies the page's owner through the existing outbox, and lands in the audit log as `divergence.open`. Two values are the same fact when both parse as numbers (`1500`, `"1500"`, `1500.0`) and otherwise only when they are exactly equal: `"1,500"` and `"$1500"` are **not** normalised, because a thousands separator is a decimal point in half of Europe and the unit is part of the fact. Nothing is opened when either side failed, is stale, or was withheld by the Registry — an unknown value is not a disagreeing value, and treating it as one would turn every source outage into a wave of false contradictions. One row per disagreeing pair, carrying the latest observation, so a page read a thousand times does not write a thousand rows. Closing one takes a **required reason**, records who closed it and when, and **stays closed**: a pair that diverges again later is a new divergence and the old one remains as history, because a flag that silently clears when two systems drift back into agreement is not a decision the record keeps. There is no automatic merge, no per-source trust score, and no way to assert a divergence by hand.
- **Connectors.** The integration seam, `resolve(source, request: { selector, key, asker }) -> { value, resolvedAt }`, registered by `source.kind` so a real connector plugs in without touching federation's logic. The shipped default is a hermetic static connector (`kind: 'static'`, `baseUrl` naming a fixture set) — a **test double, not an integration**: it exists so the whole system and the whole suite run with no external calls. A kind with no connector registered fails visibly (`No connector is registered for source kind …`) rather than resolving to nothing.
- **The web UI.** A zero-dependency static SPA served from [public/](public/) at the server root: collections and page trees with status badges, the draft editor with the page-lock screen, the full review flow, version history with side-by-side compare and restore, search, comments, and the audit view. Safe-subset markdown rendering (escape-first). Identity via a dev "who are you" screen until SSO lands. The Ask view (grounded answers — question box, cited answer, refusal state) is built against the `POST /ask` contract in [DATA-BACKBONE.md](../DATA-BACKBONE.md) §5 and feature-detects it: while the endpoint returns 404, the whole experience stays hidden, exactly as search and comments do. The Map view draws the explicit graph as inline SVG in two layouts. The **constellation** is a seeded force-directed layout — velocity Verlet with link, charge, community and collision forces, run to a fixed iteration count *before* the first paint and then stopped — clustered by the collection a page is in and by the tree root it hangs from, with node size scaled by √degree so the pages everything hangs off are visibly the hubs, hue for community, and rings for provenance and standing (a Needs Update page wears the only amber ring on the map). Every random draw comes from a PRNG seeded off the node's own id, never `Math.random`, so the same record settles into the same picture on every reload, pixel for pixel; what is animated on load is the reveal, not the physics, and `prefers-reduced-motion` turns even that off. The **tidy tree** — one column per depth, sources in a column of their own — stays the default for a single collection with a single tree in it, because that is genuinely the better reading of it; anything with more than one root, and the whole record, opens as the constellation, and one control switches. Both pan, zoom, are reachable by keyboard (every node is a link in the tab order), light a node's neighbourhood on hover and dim the rest, name their hubs at every zoom and everything else as the reader zooms in, explain themselves in a legend, filter by collection, provenance, status and edge kind, and fall back to a nested list carrying the same data, automatically past a documented node cap. `#/map` is the whole record and `#/collections/:id/map` is one of them; both are feature-detected, and where `GET /graph` is not served the whole-record entry is simply not there. The **Attestation** affordance sits on the page view and on the collection view: pick a moment in your own clock, preview what the record said then, and download the bundle as JSON or as the printable HTML document. It is feature-detected the same way everything else is — one bounded probe (`GET /audit/verify?limit=1`, which has no side effect and costs one link), and where the endpoint answers 404 the button is simply not there.

## Three ways in: people, developers, and agents

Canon has one door and three credentials at it. A request carries exactly one of them — a person's session, a dev header, or an agent's passport — and any pairing is refused with `403 identity_mismatch` rather than resolved in favour of one.

| Mode | Credential | Live when | What it means |
| --- | --- | --- | --- |
| **SSO** | `Cookie: canon_session=…` | `CANON_OIDC_ISSUER` is set | A person signs in at the organization's identity provider through an OpenID Connect Authorization Code flow with PKCE. The ID token's issuer, audience, expiry, nonce and **signature** are all verified (RS256 against the provider's JWKS, keyed by `kid`); the person gets a Canon actor provisioned from their verified claims on first sight, matched on the IdP **subject** thereafter. The session lives server-side, so signing out actually ends it. |
| **Dev** | `X-Actor-Id: <actorId>` | `CANON_DEV_AUTH=true` | The alpha's stand-in for SSO. Any actor id names its actor and **nothing is verified**. Off by default: a server started without the variable refuses the header outright with `401 dev_auth_disabled`, and `POST /actors` does not exist on it. |
| **Agent Passport** | `X-Agent-Passport: <token>` | `CANON_REGISTRY_URL` is set | The passport is verified with the Veryl Agent Registry on every session, resolved to an agent actor, and the Registry's limits are enforced on the request. Entirely unaffected by the other two. |

Each is one environment variable, and the server says at start-up which are live — loudly, and in the case of dev mode alarmingly, because a deployment must never have to read the code to find out whether it is running open.

### Single sign-on

```sh
CANON_OIDC_ISSUER=http://127.0.0.1:3200 \
CANON_OIDC_CLIENT_ID=veryl-canon \
CANON_OIDC_CLIENT_SECRET=… \
CANON_BASE_URL=https://canon.example.com \
npm start
```

| Variable | Meaning |
| --- | --- |
| `CANON_OIDC_ISSUER` | The provider's issuer URL. Setting it turns SSO on; unset, people cannot sign in. Discovery is read from `<issuer>/.well-known/openid-configuration` and **must name the same issuer**, so a provider that redirects cannot become a provider that substitutes. |
| `CANON_OIDC_CLIENT_ID`, `CANON_OIDC_CLIENT_SECRET` | Required once the issuer is set. The secret authenticates the token call with `client_secret_basic`, so it stays out of the form body. |
| `CANON_OIDC_REDIRECT_URI` | Optional; defaults to `<CANON_BASE_URL>/auth/callback`. Register it at the provider verbatim. |
| `CANON_OIDC_SCOPE` | Optional; defaults to `openid profile email`. |
| `CANON_OIDC_CLOCK_TOLERANCE_SEC` | Optional; skew allowed on `exp`/`nbf`/`iat`. Defaults to 60. |
| `CANON_OIDC_TIMEOUT_MS` | Optional; how long to wait for the provider. Defaults to 5000. |
| `CANON_SESSION_SECRET` | The HMAC key the session cookie is signed with. **Set it.** Without one, a key is invented at start-up: every restart signs everybody out, and no second instance can read the first's cookies. |
| `CANON_SESSION_TTL_MS` | Optional; idle lifetime, renewed on use. Defaults to 8 hours. |
| `CANON_SESSION_MAX_LIFETIME_MS` | Optional; the ceiling no amount of renewal passes. Defaults to 24 hours. |
| `CANON_SESSION_CONFIRM_MS` | Optional; how long a session may be served before it is re-confirmed with the identity provider. **Defaults to 60000, and is clamped to 60000** — the ceiling is the revocation guarantee below, not a tuning knob. `0` re-confirms on every request. |
| `CANON_BOOTSTRAP_ADMIN_SUBJECT` | Optional but recommended; the IdP subject (`sub`, or `issuer#sub`) of the person who administers this Canon. They are made an **administrator** on every sign-in. With this unset and no administrator in the record, the first person to sign in becomes one, loudly. |
| `CANON_COOKIE_SECURE` | Optional; `true`/`false` to force the cookie's `Secure` flag. Defaults to on unless `CANON_BASE_URL` is plain `http`. |
| `CANON_ALLOWED_ORIGINS` | Optional; extra origins a cookie-authenticated write may come from. The redirect URI's own origin is always allowed. |

The routes are `GET /auth/login` (optionally `?return=<path on this server>`; anything else is confined to `/`, because an open redirect on a login endpoint is a phishing primitive), `GET /auth/callback`, `POST /auth/logout`, and `GET /auth/session` — which is open and answers `{ mode, sso, devAuth, authenticated, actor, csrfToken, csrfHeader, loginUrl }`. The web UI reads it at start-up and shows a real sign-in button, a dev picker, or a plain "no sign-in is configured" accordingly. None of these routes are in the record's route table or in agentauth's, so an agent presenting a passport at one is refused exactly as at any unclassified route.

**Just-in-time provisioning** matches on the IdP subject, qualified by issuer, and never on the email address. An address changes and can be reassigned; giving a leaver's address to a new hire must not hand them the leaver's history, roles and audit trail. Name and email follow the provider on every sign-in, so attribution stays true.

#### The revocation guarantee, for people

> **Canon confirms a person's session with their identity provider at least once every sixty seconds. Disabling somebody at the provider therefore ends their access to Canon within a minute, whatever session they are holding — and an operator can end it immediately.**

That is the same sentence [REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md) §3 states for agents ("revocation in the Registry takes effect in Canon within one minute"), and it is kept the same way, so the two can be compared line for line:

| | Agents (`agentauth.ts`, `registry.ts`) | People (`auth.ts`) |
| --- | --- | --- |
| What is re-asked | the Registry's `POST /verify`, with the passport | the provider's token endpoint, with the session's refresh token |
| How often | at most every `CANON_REGISTRY_TTL_MS`, clamped to **60s** | at most every `CANON_SESSION_CONFIRM_MS`, clamped to **60s** |
| Who says no | the Registry (revoked, lapsed) | the provider (disabled, grant withdrawn) |
| On "no" | request refused `403` | request refused `401`, and **every** session that person holds is deleted |
| On no answer at all | request refused `503`; nothing cached | request refused `503`; **nothing deleted**, so recovery is immediate |
| Immediately | remove the agent in the Registry | `DELETE /auth/sessions/:actorId`, by an operator |

Three things are worth stating plainly rather than leaving to be discovered:

- **The confirmation is made with a refresh token, which Canon stores.** It is the one credential Canon holds. It belongs to a single session, dies with it (logout, revocation, expiry, or a refused confirmation all delete the row), is sealed at rest with AES-256-GCM under a key derived from `CANON_SESSION_SECRET`, and never leaves Canon except to the provider's own token endpoint. `CANON_OIDC_SCOPE` therefore asks for `offline_access` by default. See [SECURITY.md](../SECURITY.md) §5, where the old assumption "nothing in Canon ever stores a credential" is amended rather than quietly broken.
- **A session that cannot be confirmed does not survive its first window.** If the provider issues no refresh token, or returns no ID token on refresh, the session is ended and the person signs in again — usually an invisible redirect, because they are still signed in at the provider. A session Canon cannot confirm is a session outside the guarantee, and the guarantee is the point.
- **A burst of requests past the window costs one round-trip**, not one per request: confirmations are single-flighted per session, which also matters because real providers rotate refresh tokens on use.

**CSRF.** A session cookie is an ambient credential, so an unsafe request carrying one must prove it was meant. Canon requires **both** an acceptable `Origin`/`Referer` **and** a session-bound token in `X-Canon-CSRF` (fetched from `GET /auth/session`). The token is a synchronizer token held server-side beside the session, not a double-submit cookie — a double-submit is forgeable by anyone who can write a cookie on the domain. Requests identified by `X-Actor-Id` or `X-Agent-Passport` are exempt and correctly so: neither is ambient, so no cross-site page can cause one to be sent.

### Who runs this Canon: the organisation role

Canon has collection roles (`view` … `admin`) and, above them, one **organisation role** per actor. It is stored as data, defaults to `member`, and is what five checks now ask instead of "does this actor hold `admin` on *any* collection?" — a stand-in that was wrong in both directions, since a team lead who administers one collection is not an operator of the record and a genuine operator with no collection membership was invisible to it.

| Org role | What it means |
| --- | --- |
| `member` | The default, and the absence of a grant. Everything a member can do comes from their collection roles and nothing else. |
| `operator` | Runs this Canon: flush the notification outbox, run the freshness sweep, register a Canon-wide source, read audit events that name no collection, list the actor directory, end a person's sessions. **No access to any collection's content**, and no way to grant any. |
| `administrator` | An operator who also administers permissions: sets other people's org roles, and may grant or remove collection membership anywhere. |

**`administrator` does not imply collection access, deliberately.** An administrator holds no `view` anywhere they were not given one: they cannot read a page, search a body, retrieve a passage, or be answered from material they hold no collection role in. Running the system is not the same job as being entitled to the corpus, which is the separation a regulated buyer asks about. What they *can* do is grant themselves a role — a Canon whose last collection admin leaves must not become unadministrable — and that grant is an ordinary `collection.member_set` audit event with their name on it, made before the read rather than discovered after it. Accountable access, not silent access. It is recorded as the residual it is in [SECURITY.md](../SECURITY.md) F11.

**The first administrator.** Nobody can be authorised to make the first grant, because the authority to make it is the thing being granted. So: `CANON_BOOTSTRAP_ADMIN_SUBJECT` names a person at the identity provider and re-asserts the role on every sign-in (recommended — it grants nothing to whoever arrives first, and cannot be locked out); with it unset and no administrator in the record, the first person to sign in becomes one, with a loud console line and an `org_role.bootstrap` audit event naming them. That window is exactly one person wide and closes permanently at the first sign-in. On a dev machine running `CANON_DEV_AUTH=true`, where nobody signs in, `CANON_BOOTSTRAP_ADMIN_ACTOR_ID` names an actor id instead.

```
GET    /auth/org-roles                      who holds one (operator)
PUT    /auth/org-roles/:actorId             { role } — member | operator | administrator (administrator)
GET    /auth/access/:actorId                why this person holds what (yourself, or operator)
DELETE /auth/sessions/:actorId              end every session this person holds, now (operator)
GET    /auth/mapping                        the group → role rules, as configured (operator)
```

### Provisioning from the directory: group claims

A person who signs in with no Canon role sees an empty Canon. That is the right default, and it does not scale to a partner with three hundred staff — so a deployment can map the identity provider's **group claim** onto Canon roles. It is configuration, not a UI: mapping a directory group onto a role in a regulated record is a decision made once, reviewed where the rest of the deployment's configuration is reviewed.

| Variable | Meaning |
| --- | --- |
| `CANON_OIDC_GROUPS_CLAIM` | Optional; the ID-token claim the groups arrive in. Defaults to `groups`. Groups are an array of opaque strings; a single bare string is accepted, and anything else reads as *no groups* rather than being guessed at. |
| `CANON_GROUP_MAP` | The rules, one per line (or separated by `;`), `#` starts a comment. |
| `CANON_GROUP_MAP_FILE` | Optional; a file of the same rules, appended to the above. |

```sh
CANON_GROUP_MAP='
  # who edits Compliance
  Canon-Compliance-Editors -> collection:8f14e45f-…:edit
  Canon-Compliance-Leads   -> collection:8f14e45f-…:admin
  Canon-Operators          -> org:operator
'
```

- **Applied on every confirmation, not only at first sign-in.** A group added at the provider grants its role within the same sixty seconds a revocation takes; a group removed there removes exactly what it granted, in the same window.
- **Mapped access is not hand-granted access, and the two are stored apart.** `collection_members` stays the effective role — the stronger of the two sides — so every membership join in search, retrieval, queries and the graph is untouched; underneath it, `collection_hand_grants` holds what an administrator granted and `collection_group_grants` holds what each group grants. Revoking a group therefore cannot delete a hand grant, and withdrawing a hand grant leaves no phantom mapping. `DELETE /collections/:id/members/:actorId` answers `{ removed, remaining, groups }`, so an administrator taking their grant back is *told* when a directory group is still holding the person's access up.
- **It never widens the record's own permission model.** A rule grants a collection role from Canon's fixed vocabulary or an org role, and there is no third kind of target: a group cannot make somebody a page's approver, bypass a document type's rules, or reach a collection no rule named. A mapped `edit` is `edit`.
- **A rule naming a collection or a role that does not exist is refused at configuration time** — the server does not start, and says which rule is wrong. A mapping quietly ignored shows up weeks later as somebody holding less access than the operator believes they granted.
- **Inspectable, because "why does this person have edit here" is a real question.** `GET /auth/mapping` returns the rules as configured; `GET /auth/access/:actorId` returns the person's org role (hand and mapped halves separately), the groups their last confirmed ID token carried, and per collection the hand grant, the group grants, and the effective role.

### Dev authentication

```sh
CANON_DEV_AUTH=true npm start   # X-Actor-Id accepted; POST /actors and GET /auth/dev/actors exist
```

This is what the test suite runs under and what local work uses. It is off unless the variable says `true`, so no deployment can end up open by forgetting something. With it off, `X-Actor-Id` is refused, `POST /actors` answers `404` (people arrive by SSO, agents by passport; neither needs it), and the web UI's identity picker is replaced by a real sign-in.

### Agent Passports

With no Registry configured, a request carrying `X-Agent-Passport` is refused with `503 unavailable` and a message naming the missing setting. Setting one environment variable turns passport authentication on, and swapping the stub for the live Registry is the same one variable:

```sh
CANON_REGISTRY_URL=http://127.0.0.1:3100 npm start   # passport authentication live
# CANON_REGISTRY_TTL_MS=30000    how long a verified answer may be reused; clamped to 60s, 0 = verify every request
# CANON_REGISTRY_TIMEOUT_MS=3000 how long to wait for the Registry before failing closed
```

How an agent request is handled ([`src/agentauth.ts`](src/agentauth.ts), per [REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md)):

- **Verified, not trusted locally.** The passport goes to the Registry's `POST /verify`. Canon stores no credential of any kind: it matches the answer's `agentId` against the actor's `registryRef`, creating the agent actor on first sight (named by the Registry, kind `agent`) and reusing it after.
- **Limits enforced as an intersection.** The answer's `permittedCollections`, `permittedSources`, and `permittedActions` (`read`, `comment`, `write`) are applied before the store sees the request; Canon's own collection roles are applied by the store as usual. An agent acts only where **both** allow — the Registry can narrow what Canon's membership grants, never widen it, and vice versa. Responses that span collections (collection listings, search, the audit log, and the whole-record map at `GET /graph`) are narrowed to permitted collections rather than refused; a source listing is narrowed to permitted sources the same way. The map is the one spanning response that is not a list of rows, so narrowing it drops the withheld collections' pages, every edge with an end among them, and any source left with nothing referencing it, and then **recomputes `degree`** — a degree over edges that are no longer in the payload would be a number about a graph nobody can see.
- **Sources governed like collections.** A federated source is a governed object, so the passport carries which sources an agent may resolve references from — otherwise an agent barred from a collection could read the same facts through the source behind it. Resolving a page's references is `read` on the page's collection, and authoring or removing one is `write` on it, needing no `"*"`: a reference belongs to a page, so the page's collection governs it. Registering, changing, or removing a *source* is `write` and needs `"*"`, exactly as creating a collection does, because a source is not scoped to one collection. A page carrying references the agent may not resolve stays readable and each such reference comes back refused in place, never silently dropped: agentauth exposes `refuseUnpermittedSource(sourceId, context)`, which returns `null` when the reference may be resolved and a `source_not_permitted` record — carrying `origin: 'none'`, ready to spread over the reference's result slot — when it may not. The refusal is audited as `agent.denied` in `reference.resolve`'s own vocabulary, so one query follows a reference across both event families.
- **Proposing is not publishing, and reviewing is a person's job.** `POST /pages/:id/proposals` is `write` scoped to the page's collection, exactly as authoring a reference on a page is — a proposal belongs to one page, so the page's collection governs it, and no `"*"` is involved. `POST /proposals/:id/accept` and `/reject` are deliberately **absent from the route table**, so an agent asking for either is refused with `403 route_not_available_to_agents` and the attempt is audited; `proposals.ts` refuses an actor of kind `agent` a second time, which is the check that also holds in dev mode where no passport is presented. There is no `permittedActions` value that opens them: FEATURES.md §5 says people stay the approvers, and admitting an agent to that side would take a deliberate change in both places plus a paragraph in FEATURES.md, never a quiet route addition.
- **A divergence is readable; settling one is not.** `GET /pages/:id/divergences` and `GET /divergences/:id` are `read` scoped to the page's collection, and the record-wide `GET /divergences` is a spanning read narrowed to permitted collections — an agent that may resolve a page's references can already see both values, so hiding the observation that they differ would protect nothing and would leave an agent composing an answer from two numbers it had no way to know conflict. `POST /divergences/:id/close` is deliberately **absent from the route table**, on the same precedent as the proposal decisions: DATA-BACKBONE.md §7 says a divergence "is closed by a person, with a reason", and the reasons it names — *the copy was wrong and has been corrected upstream*, *the definitions differ and here is why* — are claims about external systems that Canon cannot verify and somebody has to be accountable for. `divergence.ts` refuses an actor of kind `agent` a second time, which is the check that also holds in dev mode. An agent that knows why the systems differ raises a proposal, and a person settles it.
- **Queries are `read`; maintenance is nobody's.** Running a structured query, reading a saved one, and reading a collection's health are all `read`. A query result spans collections, so it is narrowed to permitted ones exactly as a search result is; `GET /queries/:id` deliberately returns the *definition* and no results, because results inside an object are where a narrowing quietly stops reaching. The **freshness sweep appears in no rule at all**, and that is the decision rather than an oversight: an unclassified route is refused to every agent, however wide its passport. FEATURES.md §5 says agents do the watching and people stay the approvers — the sweep is not watching, it restatuses pages across every collection at once and mails their owners, and the Registry's vocabulary (`read`, `comment`, `write`) has no word for "may run maintenance". The unattended sweep is the built-in timer, which runs as Canon's own system actor: attributable, configured nowhere, and reachable by nobody over HTTP. `GET /maintenance/freshness` — which reads only the deployment's own schedule and no record content — is unclassified for the same reason and is therefore refused to agents too.
- **Fail closed.** Unknown passport → `401`, lapsed or revoked certification → `403`, unreachable or unparseable Registry → `503`. No answer is ever an allowance, and an outage is never cached, so recovery is immediate. Verified answers live at most sixty seconds, which is the revocation guarantee: revoking an agent in the Registry cuts its access in Canon inside a minute.
- **Audited.** Each fresh verification is an `agent.session` event, refusals are `agent.auth_failed` (against the agent where it is known, otherwise a one-way fingerprint of the presented passport — never the passport), limit denials are `agent.denied` — including a refused reference, which names the source withheld and the page it sat on — and every agent action carries `actorKind: 'agent'` into history and the audit log.

## What is stubbed, and where it goes next

- **Identity.** People sign in through OpenID Connect (above); the provider behind it is the stub in [idp-stub/](../idp-stub/) until the design partner's tenant is wired up, and swapping to it is `CANON_OIDC_ISSUER`. Agents authenticate with their Agent Passport; the Registry behind it is the stub in [registry-stub/](../registry-stub/) on exactly the same terms. `X-Actor-Id` survives as an explicit development opt-in and nothing else.
- **The connector.** The only connector shipped is the hermetic `static` one, whose fixture data is supplied per source. It is a test double: it reaches nothing. A real integration implements `Connector` and registers itself on the store's `ConnectorRegistry` at start-up, keyed by the `kind` its sources carry; nothing else in federation changes.
- **The embedding provider and the answer generator.** Both are interfaces with hermetic defaults: a hashed bag of words and an extractive generator. A hosted or self-hosted embedding model and a real language model plug into the same seams, and nothing else in retrieval changes. Until then the vector channel catches partial term overlap rather than paraphrase, and answers quote rather than compose prose.

## Running it

Node 22+ (uses the built-in `node:sqlite`; no runtime dependencies).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + invariant test suite (runs with CANON_DEV_AUTH=true, stated in package.json)
npm start     # serve on :3000, record in ./canon.db (CANON_DB, PORT to override)
npm run backup -- --out ../backups   # a verified snapshot; safe while serving
npm run restore -- --verify <artefact>
```

Or in a container, from the repository root: `docker build -t veryl-canon:local
--target canon .`, and `docker compose up --build` for a demo stack with the
stubs. **[OPERATIONS.md](../OPERATIONS.md)** is the runbook — install, upgrade,
back up, restore, rotate secrets, read the logs, what each timer does and what
breaks if it stops, and a first-hour checklist — and
**[CONFIGURATION.md](../CONFIGURATION.md)** is every environment variable below
in one table, with which are required and which are development-only.

### Two probes, two questions

`GET /health` is **liveness**: the process is up. It stays 200 while the
Registry is down, because restarting Canon does not fix somebody else's outage.

`GET /ready` is **readiness**: this process can serve — the record is reachable,
its schema is the version this binary expects, and every configured door
(identity provider, Registry) answers. Point a load balancer and a container
health check at this one. It answers 503 with the failing check named
([`src/ready.ts`](src/ready.ts)).

### Start-up refuses an incoherent configuration

Several settings are only meaningful in combination, so a deployment can be
coherent in each individual variable and incoherent as a whole. Canon checks
before it binds a port and exits 78 naming the variable
([`src/config.ts`](src/config.ts)): single sign-on with no
`CANON_SESSION_SECRET`, `CANON_DEV_AUTH=true` beside a real identity provider,
`CANON_SOURCE_ALLOWED_HOSTS` naming a host that does not resolve, a relay with
no sender, an issuer with no client credentials or nowhere to send people back
to, and any URL or number that is neither. Warnings cover the merely unwise.

### Migrations

The schema is versioned and forward-only ([`src/migrate.ts`](src/migrate.ts)).
Migrations apply in order, each inside a transaction with the version row
written in the same transaction, so a migration that throws leaves the database
exactly as it was. Migration 1 *is* the old bootstrap, so a fresh database and
one written by any earlier build converge on the same version. A database
written by a **newer** Canon makes this binary refuse to start rather than
misread columns it does not know about. How to add a table from now on is in
[OPERATIONS.md](../OPERATIONS.md), "Adding a table".

### Backups, briefly

The audit log is a compliance artefact with no second copy. `npm run backup`
takes a consistent snapshot with `VACUUM INTO` — safe while the server is
serving — and **verifies it before calling it a backup**: integrity check,
foreign keys, schema version, every core table read back with its row count, and
the audit hash chain where a verifier for one exists in the build. **Never `cp
canon.db`**: under WAL that copies a file whose newest commits are in a WAL it
did not copy, and the result looks perfectly healthy while missing the end of the
audit log. Restore verifies twice, before and after. Retention, and what a
partner is expected to do with the artefact, are in
[OPERATIONS.md](../OPERATIONS.md).

### A demo corpus

`npm run seed:demo` builds a record that looks like a regulated company's: five collections
(Compliance, Member Benefits, Clinical Policy, People and Workplace, Engineering), a few hundred
pages in trees three and four deep, every document type and every status including **Needs Update**
and **In Review**, two import runs so imported provenance is real, three registered sources with
reference fields so federated provenance is real, and links that cross collections — which is what
`GET /graph` exists to draw.

```sh
npm run seed:demo -- --db demo.db          # write it somewhere that is not ./canon.db
npm run seed:demo -- --seed 7              # a different, equally reproducible corpus
npm run seed:demo -- --db demo.db --force  # add it to a record that already holds something
CANON_DEV_AUTH=true CANON_DB=demo.db npm start
```

**It is a development tool and it says so, in its header comment and on every run.** Never point it
at a deployment: it invents people, writes hundreds of pages under their names, and registers
external sources, and history is append-only so none of that can be taken back. It **refuses** a
record that already holds any actor, collection, or page unless `--force`, and it prints exactly
what it created — pages per collection, the status, type and provenance breakdown, the edge counts,
and the number of links that cross a collection.

**Deterministic by construction.** Every choice comes from a seeded PRNG (`--seed`, default
`20260731`); `Math.random` appears nowhere in it, so the same command produces the same corpus and a
screenshot of the map is reproducible. Page IDs are UUIDs and timestamps are clock readings, so those
differ between runs and nothing in the seeder depends on either.

One honest wrinkle: the seeder resolves each reference field once, against its own hermetic fixture
connector, so the demo record carries a labelled last-known value. A server started without those
fixtures configured shows each value as that last-known one, marked **stale** and carrying the
error — which is precisely what [DATA-BACKBONE.md §6](../DATA-BACKBONE.md) asks federation to look
like when a source cannot be reached: degrade visibly, never substitute a guess.

### Email

Set `CANON_SMTP_URL` and notifications go out by email; leave it unset and they are logged by the dev transport, as before.

| Variable | Meaning |
| --- | --- |
| `CANON_SMTP_URL` | The relay, e.g. `smtp://user:pass@relay.internal:587`. `smtp://` upgrades with STARTTLS (required whenever credentials are present, so a password never crosses in clear); `smtps://` is TLS from the first byte, default port 465. Optional flags: `?starttls=required\|opportunistic\|off`, `?insecure=true` for a self-signed relay certificate, `?name=` for the EHLO name, `?timeout=` in milliseconds. |
| `CANON_MAIL_FROM` | The sender, e.g. `Veryl Canon <canon@example.com>` or a bare address. Required once `CANON_SMTP_URL` is set. |
| `CANON_BASE_URL` | Where Canon is reachable, e.g. `https://canon.example.com`. Deep links in the emails are built from it; without it they point at `http://localhost:3000`. |
| `CANON_PRODUCT_NAME` | Optional; the name in the email footer. Defaults to `Veryl Canon`. |
| `CANON_FLUSH_INTERVAL_MS` | Optional; how often the server runs its own delivery pass. Defaults to 60000. Set `0` to turn it off and drive `POST /notifications/flush` from your own scheduler. |

### Federation: which hosts Canon may reach

A registered Source carries a `baseUrl`, and Canon fetches it server-side when a page's reference resolves. That makes the register of sources a way to aim the server at anything on the network, so **a deployment states which hosts Canon may reach, and nothing else is reachable**. Unset means no outbound federation, not "anything" — the `static:` fixture connector still works, and a source pointing at a real system is refused when it is registered and again when it resolves. See [SECURITY.md](../SECURITY.md).

| Variable | Meaning |
| --- | --- |
| `CANON_SOURCE_ALLOWED_HOSTS` | Comma- or space-separated allowlist. Each entry is `host`, `host:port`, or `*.domain` (any subdomain, not the apex); a host with no port permits any port on it. A full URL is accepted and reduced to its host. **Unset or empty means Canon federates with nothing.** |
| `CANON_SOURCE_ALLOWED_SCHEMES` | Optional; defaults to `https,http`. Set to `https` alone where the record systems support it. No other scheme is ever reachable. |
| `CANON_SOURCE_ALLOW_PRIVATE` | Optional; `true` permits loopback, link-local and private address ranges, including the cloud metadata address. **Development only** — it is what lets the test suite reach a stub on `127.0.0.1`. |
| `CANON_SOURCE_SERVICE_IDENTITY` | The identity a `service`-mode source is resolved with. Absent, a service source fails visibly rather than resolving anonymously. |
| `CANON_SOURCE_TIMEOUT_MS` | Optional; how long to wait for a source. Defaults to 3000, and it bounds the whole exchange — connect, handshake, headers and body. |

**The connection goes where the check went.** Canon resolves a source's hostname itself, applies the rules above to every address that answer contained, and then connects to an address from *that* answer, supplied to the socket directly (`server/src/pinnedhttp.ts`). No second name resolution happens between the check and the connect, so a name cannot be re-pointed at an internal address in between, and every redirect hop repeats the whole of it. TLS is unaffected: the certificate is still validated against the **hostname**, not against the pinned address, so an allowlisted `https://` source with the wrong certificate is refused exactly as before. What this does not do is make an allowlisted host safe, authenticate the DNS answer it was built from, or protect a plain `http://` source from the network between here and there — see [SECURITY.md](../SECURITY.md) F1 for the full statement.

### Importing: where an import may read from

| Variable | Meaning |
| --- | --- |
| `CANON_IMPORT_ROOTS` | Optional; colon- or comma-separated directories an import may read from. Unset means unrestricted, which is the historical behaviour. Set it in any deployment where `admin` on a collection is not the same trust level as shell access — the import path is operator input, and the server reads it. A file that resolves outside the run's own root (a symlink) is refused whether or not this is set. |

Running an import takes **`admin`** on the target collection, not `edit`: it names a server-side path, reads it, and lands up to two thousand pages in one call. Reading a run's record (`GET /imports`, `GET /imports/:id`) stays at `view` — the bar is on aiming the run, not on seeing what it did.

### Rate limiting

Four buckets, each a token bucket per actor, in process and per server. They cover only the routes where one cheap request buys a lot of work; **nothing that reads the record is limited**, because a limiter that can lock somebody out of a policy at the moment they need it has cost more than it saved. A refusal is `429` with `{ "error": "rate_limited", "bucket": …, "retryAfterSeconds": … }`.

| Variable | Meaning |
| --- | --- |
| `CANON_RATE_LIMIT` | Optional; `off` turns every bucket off in one move, for a deployment whose front door already limits. |
| `CANON_RATE_LIMIT_ASK` | `POST /ask` and `POST /knowledge/ask`, per actor. `burst/perMinute`, or `off`. Defaults to `12/12`. Retrieval runs over the whole visible corpus and then a generator; with a hosted embedding provider it is also a per-request bill. |
| `CANON_RATE_LIMIT_REFERENCES` | `GET /pages/:id/references`, per actor. Defaults to `60/60`. This is the route that reaches an external system, once per reference, with Canon's own service identity on the request. |
| `CANON_RATE_LIMIT_IMPORT` | `POST /imports`, per actor. Defaults to `2/0.5` — two back to back, then one every two minutes. An import is an operator's act measured in minutes, not in requests. |
| `CANON_RATE_LIMIT_AUTH` | Failed Agent Passport authentications, keyed by the connection's origin rather than by actor — the actor is precisely what an unverified passport is asserting. Defaults to `20/20`. **Only a failure spends a token**, so a busy honest agent never meets this bucket. When SSO lands, the login route belongs in it. |

The limiter is in process: several Canon processes limit per process. That is proportionate for the alpha and it is stated rather than implied — a distributed limiter needs a shared store Canon does not have.

### Freshness

The sweep runs on a timer, exactly as the outbox flush does, and for the same reason: "stale knowledge announces itself" is only true if nobody has to remember to press anything.

| Variable | Meaning |
| --- | --- |
| `CANON_FRESHNESS_INTERVAL_MS` | Optional; how often the sweep runs, on top of one immediate pass at start-up. Defaults to 3600000 (hourly). Review dates are days, so a shorter period buys nothing. Set `0` to drive `POST /maintenance/freshness` from your own scheduler — and note that the editor then stops promising authors a flip, because it would not be true. |
| `CANON_MAINTENANCE_ACTOR_ID` | Optional, and normally left unset. The actor the timed sweep runs as; unset, it is Canon itself (`system:canon`). Set it only if you deliberately want a named service account's name on this work — it must hold the org-level `operator` role, and an id this record does not hold logs an error and falls back to `system:canon` rather than stopping the sweep. Attribution is universal ([DATA-BACKBONE.md](../DATA-BACKBONE.md) §2, principle 5) and it is now also **truthful**: Canon writes to its own log under an identity that is named, singular, and unmistakably not a person. |

### Verifying the audit chain

```sh
CANON_DB=canon.db npm run verify:audit     # exit 0 intact, 1 broken, 2 unreadable
```

The same walk `GET /audit/verify` performs, without a running server and without an actor — deliberately, because anyone who can run it already reads the database file directly, which is stronger access than any Canon role. The HTTP route is the one that needs a permission check and has one (`admin` on a collection).

Run it from cron, from the job that verifies your backups, and from the deployment step that publishes the head hash to an **external anchor**. That last one is the recommendation this feature exists to make: a chain in the same file as the data proves internal consistency, and an attacker who can write to the file can restore internal consistency after deleting an event. An anchored head cannot be reproduced by a recomputed chain, so everything up to the last anchor becomes genuinely immutable rather than merely consistent. Where you anchor — a write-once bucket, a counter-signed mail to the compliance owner, a customer-held file, a transparency log — is your choice and not Canon's, which is why Canon gives you the head and stops there.

Delivery is an outbox, never an inline send: the notification row is written first, and a delivery pass hands it to the relay. **A real deployment runs that pass on a timer** — the built-in one every `CANON_FLUSH_INTERVAL_MS`, or `POST /notifications/flush` from cron or a Kubernetes CronJob every minute or so. Each pass takes a bounded batch (`{ "limit": n }`, default 25), retries a transient failure with backoff (1, 5, 15, 60 minutes, then dead after five attempts), and never delivers a row twice.

## API sketch

All requests JSON; identity via the session cookie, `X-Actor-Id` in dev mode, or `X-Agent-Passport` for agents (see above).

```
GET    /health
GET    /auth/session                        open: which door is open, who you are, your CSRF token
GET    /auth/login | GET /auth/callback     SSO only
POST   /auth/logout                         ends the session server-side
GET    /auth/dev/actors                     dev mode only: the identity picker's directory
GET    /auth/org-roles | PUT /auth/org-roles/:actorId    who runs this Canon (see above)
GET    /auth/access/:actorId                             why this person holds what
DELETE /auth/sessions/:actorId                           end their sessions now (operator)
GET    /auth/mapping                                     the group → role rules (operator)
POST   /actors                              DEV MODE ONLY — 404 otherwise; people arrive by SSO, agents by passport
GET    /actors[?collection=<id>]            a collection's members, or your colleagues; the whole directory
                                            only to an operator of this Canon
POST   /collections                         { name, description?, restricted? }
GET    /collections | /collections/:id | /collections/:id/tree | /collections/:id/members
PUT    /collections/:id/members/:actorId    { role } — collection admin, or an org administrator
DELETE /collections/:id/members/:actorId    withdraws the HAND grant only
                                            -> { removed, remaining, groups } — `remaining` names a role a
                                               directory group is still granting, rather than leaving it a surprise
POST   /pages                               { collectionId, parentId?, type, title }
GET    /pages/:id                           page + current published version + its reference descriptors
                                            + `review`: while In Review, the draft's fields and the approver
                                              `approve` will accept; null otherwise
PUT    /pages/:id/draft                     { title?, body?, fields? } — acquires the page lock
DELETE /pages/:id/draft                     discard
POST   /pages/:id/publish                   { note? }
POST   /pages/:id/submit | /approve | /send-back
POST   /pages/:id/withdraw                  { reason? } — the author takes their own submission back, before
                                            anyone has acted on it; only the actor who submitted it
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
POST   /notifications/flush                 { limit? } — deliver queued notifications (operator)
POST   /sources                             { name, kind, baseUrl?, authMode, freshnessWindowMs, collectionIds? }
                                            admin on the scoped collections; operator if unscoped (Canon-wide)
GET    /sources | /sources/:id              sources scoped to your collections, plus Canon-wide ones
PUT    /sources/:id                         same fields, all optional; admin under the old and the new scope
DELETE /sources/:id                         refuses (409) while any page still references it
POST   /pages/:id/references                { sourceId, selector, key, label?, role? } — requires edit
                                            role is `authority` (the default) or `corroborating`. At most one
                                            authority per (page, selector, key) — a second is a 409 — and a
                                            corroborating reference requires an authority to corroborate
DELETE /references/:id                      requires edit; refuses (409) while copies of an authority remain
GET    /pages/:id/references                resolve this page's references for the asking actor
                                            -> [{ value, resolvedAt, fromCache, stale, sourceName, role,
                                                  error?, divergence? }]
                                            The AUTHORITY's value is what displays, always: a corroborating
                                            source never replaces it, overrides it when fresher, or blanks it
                                            when it disagrees. `divergence` is present only while the
                                            reference is part of an open disagreement:
                                            { side: 'authority' | 'corroborating', open: [Divergence] }
GET    /pages/:id/divergences?state=        open | closed; requires view on the page's collection
GET    /divergences?state=&collection=&limit=
                                            across the record, filtered to your collections (a spanning read)
GET    /divergences/:id                     -> { id, referenceId, pageId, authoritySourceId, authorityValue,
                                                 otherSourceId, otherValue, observedAt, state,
                                                 closedBy?, closedAt?, reason? }
POST   /divergences/:id/close               { reason } — REQUIRED; requires edit; people only. It stays
                                            closed: a pair that diverges again later is a NEW divergence,
                                            and the old one remains as history
POST   /pages/:id/proposals                 { rationale, title?, body?, fields? } — requires edit (agents: + write)
                                            rationale is required; anything omitted carries over from the
                                            current version. Takes no page lock.
GET    /pages/:id/proposals?status=          open | accepted | rejected | superseded; `stale` is computed
POST   /proposals/:id/accept                { note? } -> { proposal, page }; people only.
                                            409 when the page has moved past the proposal's base version
POST   /proposals/:id/reject                { comment } — required; people only
POST   /maintenance/freshness               { on?, limit? } — flip Canonical pages past their review date to
                                            Needs Update, notify owners, audit. Requires the operator role;
                                            idempotent; closed to agents. Canon already runs it on a timer.
GET    /maintenance/freshness               -> { scheduled, intervalMs, actor, ownerNotice, reason? } — what
                                            THIS deployment does about review dates. Any authenticated
                                            reader: the person who needs it is the author in the editor.
POST   /queries/run                         { collectionIds?, types?, statuses?, ownerIds?, approverIds?,
                                              hasOwner?, hasReviewDate?, hasEffectiveDate?,
                                              hasEffectiveDateBasis?, backdated?,
                                              reviewDateBefore?, reviewDateAfter?,
                                              updatedBefore?, updatedAfter?, createdBefore?, createdAfter?,
                                              sort?, direction?, limit?, savedQueryId? }
                                            -> [{ pageId, collectionId, parentId, type, title, status, ownerId,
                                                  approverId, effectiveDate, effectiveDateBasis, reviewDate,
                                                  currentVersion, createdAt, updatedAt, firstPublishedAt,
                                                  pastReview, backdated, backdatedWithoutBasis, notYetInForce }]
                                            `backdated: true, hasEffectiveDateBasis: false` is the sample
                                            behind health's backdatedWithoutBasis count.
POST   /queries                             { name, query } — save a filter; owned by its creator
GET    /queries | /queries/:id              your own saved queries (the definition; results via /queries/run)
DELETE /queries/:id                         your own only
GET    /collections/:id/health?draftDays=   -> { pastReview, needsUpdate, withoutOwner, orphaned, staleDrafts,
                                                 staleDraftDays, canonicalWithoutEffectiveDate,
                                                 backdatedEffectiveDate, backdatedWithoutBasis, notYetInForce,
                                                 pages, truncated }
GET    /audit/verify?limit=                 walk the audit hash chain; requires admin on a collection
                                            -> { ok, format, algorithm, recipe, events, chainedFromEventId,
                                                 unchained, verified, partial, head: { eventId, hash },
                                                 firstBreak: { kind, eventId, at, action, expected, found,
                                                               explanation } | null, proves, limits }
GET    /pages/:id/as-of?at=<ISO>            what this page said at that instant, and who had approved it
                                            -> { existed, reason, answer, title, status, canonical, archivedAt,
                                                 version, fields, approval, statusHistory }
GET    /pages/:id/attestation?at=&format=   the attestation bundle: identity, every version, the field and
                                            status history, the approvals, the chained audit trail, the
                                            point-in-time answer, and a manifest saying how to verify it.
                                            `format=html` returns the self-contained HTML document instead.
GET    /collections/:id/attestation?at=&format=
                                            the register: which pages held the Canonical mark at that
                                            instant, with owners, approvers, approval dates and review dates
                                            — and which did not, named rather than omitted.
GET    /collections/:id/graph               the knowledge map: the explicit graph, with provenance
                                            -> { collectionId, generatedAt, counts, truncated,
                                                 nodes: [{ id, kind: 'page', title, type, status, collectionId,
                                                           parentId, external, provenance, origin, references,
                                                           version }
                                                      | { id, kind: 'source', name, type, status: null, authMode,
                                                           freshnessWindowMs, provenance, references }],
                                                 edges: [{ from, to, kind: 'child' | 'link' | 'reference' }] }
GET    /graph?collection=&collection=       the whole record: every collection you may view, or the ones
                                            named. Repeatable; omitted means all of them.
                                            -> { collections: [{ id, name }],
                                                 nodes: [{ id, kind: 'page' | 'source', title, collectionId,
                                                           type, status, provenance,
                                                           importSource?, importFile?, degree, rootId }],
                                                 edges: [{ from, to, kind: 'child' | 'link' | 'reference' }],
                                                 truncated?: { limit, total } }
```

On the record view's node shape: `collectionId` is `null` on a **source**, which belongs to no one
collection, and a source's `rootId` is its own id, so a client clustering by `rootId` gives it a
cluster of its own rather than dropping it. `status` is `null` on a source for the same reason it is
in the per-collection map: only pages carry standing. `type` is the document type for a page and the
connector kind for a source. `importSource` and `importFile` are present whenever an import run
created the page — including on a page labelled `federated`, because the precedence rule loses the
label, never the origin. `truncated` is present **only** when the cap bit, and then `total` is the
record's true page count rather than the payload's.

The Knowledge API, for Veryl Studio apps. Every call carries **both** `X-Agent-Passport` and
`X-On-Behalf-Of: <person actorId>`; see [STUDIO-CONTRACT.md](../STUDIO-CONTRACT.md) for the exact shapes.

```
GET    /knowledge/whoami                    the intersection as it stands: app, person, effective roles
GET    /knowledge/collections               narrowed by the Registry, the app, and the person
GET    /knowledge/collections/:id | /:id/tree
GET    /knowledge/pages/:id                 page + current published version
GET    /knowledge/pages/:id/versions | /versions/:n
GET    /knowledge/search?q=&collection=&type=&status=&owner=&limit=
POST   /knowledge/ask                       { question, collectionId?, limit? } — the §5 answer contract
POST   /knowledge/pages                     { collectionId, parentId?, type, title }
PUT    /knowledge/pages/:id/draft           { title?, body?, fields? }
POST   /knowledge/pages/:id/publish | /submit
POST   /knowledge/pages/:id/comments        { body, anchor? }
```

Approval is deliberately absent: an app can carry work to the door of review, and a person grants
the Canonical mark, in Canon.

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
