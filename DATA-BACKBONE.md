# Veryl Canon as the Data Backbone

Veryl Canon is not only a product in the Veryl suite. It is the layer the suite stands on: the place where the company's knowledge is stored, organized, and served, for people, for Veryl Agent Registry, and for Veryl Studio.

This document defines that role. It describes what Canon stores, how the data is organized, what Registry and Studio depend on Canon for, and where the boundaries sit. [FEATURES.md](FEATURES.md) describes Canon as a product people use; this document describes Canon as infrastructure the suite builds on. The two are the same system. That is the point.

---

## 1. Why the backbone is Canon

The Veryl promise is that rules are set once and carried everywhere. That promise only holds if there is one copy of the material the rules protect. The moment knowledge is exported into a second store so another product can use it, the rules stop at the export.

So the suite is built the other way around. Canon holds the record, once. Registry governs who may touch it. Studio builds on it. Neither Registry nor Studio keeps its own copy of company knowledge, and Canon keeps no copy of theirs. Every product reads and writes the same store, live, under the same rules.

Concretely:

- **Registry** defines identity, certification, and limits, and Canon enforces them at its own door. In return, the record Registry governs — and the audit trail proving governance worked — lives in Canon.
- **Studio** apps are only as trustworthy as the data they answer from. A Studio app draws on Canonical pages through Canon's Knowledge API, live, with the asker's and the app's permissions carried in. No export step, no stale mirror, no second permission system.

## 2. Principles

Five rules govern how Canon holds data. Everything in the model below follows from them.

1. **One store.** A fact lives in exactly one place. Anything that looks like a copy — a search index, a cache — is derived, rebuildable, and never authoritative.
2. **Structure over prose.** Whatever a rule, query, or product must depend on is a structured field, not a sentence in a page body. Prose is for people; fields are for the suite.
3. **History is append-only.** Published versions, status changes, approvals, and audit events are never rewritten. Corrections are new entries, not edits to old ones.
4. **Permissions are data, evaluated at read time.** Who can see or change what is stored alongside the record and checked on every access, so a permission change or a Registry revocation takes effect immediately, everywhere, including in Studio apps mid-session.
5. **Attribution is universal, and true.** Every write names its actor — a person, an agent, or Canon itself — and nothing is anonymous. Work Canon does on its own clock is attributed to a single named `system` actor that nobody can sign in as, rather than to whichever person a deployment nominated: an unattributed write and a *misattributed* one are both failures of this principle, and the second is worse, because it is a falsehood the record's own history vouches for. The same record serves collaboration and audit.

## 3. What Canon stores

The data model, from the outside in. These are the entities every other product in the suite can rely on existing.

### The record

- **Collection.** The top-level container: name, description, home page, member list, and access rules. Access is defined at this level and refined below it.
- **Page.** The unit of knowledge. A page belongs to one collection, sits at one place in its tree, and carries a stable identity that survives moves and renames. The tree is data: parent, position, children.
- **Version.** An immutable snapshot of a page's body and fields at publication, with author, timestamp, and note. The current version is a pointer, not a special copy.
- **Document type.** What kind of record a page is — Policy, Spec, Plan, Note in Core — and therefore which fields it must carry and which workflow governs it.
- **Field.** Structured data on a page: owner, status, type, effective date, and, as tiers advance, review date, applies-to, and custom fields. Fields are typed, queryable, and stored as data, never parsed out of prose.
- **Label.** Freeform tags that cross collections for cross-cutting themes.

### The working layer

- **Draft.** Unpublished work in progress, visible only to editors, held separately from the published record so readers never see half-finished material.
- **Comment.** Inline or page-level, anchored to a passage where inline, with a resolution state and full attribution.
- **Status and workflow state.** Where a page sits in its lifecycle — Draft, In Review, Canonical, Needs Update, Archived — and the transitions and approvals that moved it there.

### The trust layer

- **Actor.** Every person and every agent that touches the record. People come from the organization's identity provider; agents come from the Registry via their Agent Passport. One actor model, so permissions, attribution, and audit treat both uniformly.
- **Permission entry.** Who or what can view, comment, edit, approve, or administer, at collection level refined per tree or page. Agent entries hold a Registry reference, not a copied credential.
- **Audit event.** An append-only log of every meaningful action: views of restricted material, edits, publications, status changes, approvals, permission changes, and all agent activity. Filterable, exportable, tamper-evident.

### What Canon deliberately does not store

- **Agent credentials or certification state.** Those are the Registry's record. Canon stores only the reference and checks the Registry live; a lapsed certification means lapsed access with no cleanup step in Canon.
- **Registry's operational data.** Identities, passports, certification histories, and limits live in the Registry. Canon holds the *documents about* governance — policies, criteria, procedures — as pages like any others.
- **Studio apps themselves.** App definitions, configuration, and run state belong to Studio. Canon holds the knowledge the apps draw on and the audit trail of every access they make.
- **Facts owned by other systems.** Headcount, claim status, prices, ticket state. Canon holds a reference and resolves the value when it is read; it never holds the value as its own. See section 6.

## 4. How the data is organized

Organization is what turns a store into a record. Three structures do the work:

- **The tree gives knowledge a place.** Collections at the top, page trees below, without depth limit. A branch moves with its children, and every page keeps a stable link through any reorganization. Location is meaningful — a spec under its plan, a procedure under its policy — but never load-bearing for identity.
- **Types and fields give knowledge a shape.** A page's type declares what it is and what it must carry. Because fields are data, the record can be queried like a database — every Canonical policy owned by Compliance, every spec awaiting review — while still reading like a document.
- **Status gives knowledge a standing.** The Canonical mark, earned through the type's workflow and visible everywhere the page appears, is what separates the official record from working notes. Grounded answers and Studio apps draw only from Canonical material, so standing is not a badge; it is the boundary of what the suite will act on.

Underneath, storage separates by lifecycle: the current record (pages, fields, permissions) optimized for live reads and writes; immutable history (versions, audit events) optimized for append and proof; and derived indexes (search, query) that can always be rebuilt from the first two. Any technology choice that respects this separation is acceptable; any that blurs it is not.

## 5. How the record is retrieved

Storing the record is half the job. The other half is answering from it — for a person using the question box, for an approved agent, and for a Studio app. This section fixes how retrieval works, because the answer determines whether the trust promises above survive contact with generated text.

### The rule that governs everything here

Retrieval is derived. Every index it uses — full-text, vector, or otherwise — is rebuildable from pages and versions, and none of it is ever authoritative. Nothing enters an index that is not already in the record, and nothing an index produces is treated as fact on its own. This is principle 1 applied to answers: a fact lives in exactly one place, and that place is a page.

### Why not GraphRAG

The obvious modern answer to "how do we answer from a corpus" is GraphRAG: have a model extract entities and relationships across the whole body of material, cluster them into communities, and pre-write summaries that answers draw on. It is a genuinely strong technique for global questions over large, unstructured, low-governance corpora. Canon is none of those things, and it fails us on three specific counts:

- **Provenance.** Our promise is that answers cite Canonical pages and refuse when the record is silent. GraphRAG answers are grounded in model-written community summaries — derived prose no owner approved and no approver ever saw. Putting synthesized intermediate text between the record and the answer is precisely how a confident wrong answer gets made, and one of those costs more than many right ones earn.
- **Permissions.** Access is evaluated per asker, per call. A community summary blends many pages into one artifact; if the asker may see only some of its sources, the summary leaks. Pre-computing a summary per permission scope multiplies cost by the number of distinct scopes, and filtering after generation cannot un-leak what the text already merged.
- **Freshness.** Canon exists to remove the gap between what people know and what agents use. A graph index that costs model calls per edit is expensive to keep current, so in practice it lags — reintroducing the very drift the product is against.

### What we do instead

Canon does not need an inferred graph, because it already has an explicit one. Trees, page links, owners, types, labels, and status are structured data that people maintain deliberately. That graph is more trustworthy than anything extraction would produce, and it is free. Retrieval is therefore four deterministic steps:

1. **Hybrid candidate search.** Lexical retrieval (the existing FTS5/BM25 index) unioned with semantic retrieval over chunk embeddings, then reranked. Lexical catches exact policy language and proper nouns; semantic catches the question asked in different words than the record uses. Neither alone is sufficient for a knowledge record.
2. **Permission filtering before ranking, not after.** The asker's collections bound the candidate set at query time, exactly as search already does, so material the asker cannot see never influences the ranking, the context, or the answer.
3. **Graph expansion along real edges.** For each surviving candidate, pull in its Canonical neighbours — parent, children, explicitly linked pages — up to a small, fixed depth. This is where multi-hop answers come from ("the policy states the rule, its child procedure states the steps"), and it costs a tree query rather than a model call. Every expanded page is a real page with a real citation.
4. **Generation under the record's rules.** Canonical pages only, never Drafts or Notes. Every claim cites page and version. When the filtered, expanded context does not answer the question, the answer is that the record does not say so — refusal is a correct answer, not a failure.

### What this requires, and what it does not

Semantic retrieval needs an embedding model, which would be Canon's first runtime dependency on an outside service. It is therefore optional and configurable: with an embedding provider, retrieval is hybrid; without one, it degrades to lexical retrieval plus graph expansion, which is a respectable answer engine on its own and keeps the whole system runnable with no external calls. The same applies to generation. Embeddings are stored as a derived table keyed by page and version, rebuilt when a page publishes and reconstructible in full from the record.

At alpha scale — one design partner, thousands of pages — exact similarity over stored vectors is fast enough, and choosing a vector database is a decision we do not have to make yet. The interface is what matters: as long as retrieval asks for "candidates for this query, visible to this actor," the storage behind it can change without touching the contract.

### The answer contract

One shape, used by Canon's own question box, by agents, and by Studio apps through the Knowledge API:

```
POST /ask   { question, collectionId?, limit? }
    ->      { answer | null,
              citations: [{ pageId, title, version, snippet, status? }],
              refused: bool, reason?: "no_canonical_match" | ...,
              pastReview?: [{ pageId, title }],
              disagreement?: { pageIds: [...], note, asserted? },
              supersession?: { ... },
              sourceDisagreement?: { ... } }
```

An answer without citations is never returned. `refused: true` with an empty citation list is the honest response to a silent record, and it is the response we would rather ship than a plausible guess.

A citation carries the `status` of the page it quotes — `canonical`, or `needs_update` when that page is past its review date. It is there because a citation is an invitation to act on a quotation, and whether the page behind it is current is part of what the reader is being asked to weigh; a caller that has to fetch each cited page to find out will either guess or not bother. Absent means *this response cannot say*, never *canonical*: a client that defaults a missing status to the mark that means "approved and current" is asserting the most trust-bearing thing in the product on no evidence, and should render nothing instead.

### When we would revisit this

If design partners turn out to ask genuinely global questions — "what themes run across all our policies," "where does the record contradict itself" — that is the shape GraphRAG is good at, and this decision should be reopened. Even then it would arrive as a clearly labelled derived layer computed per permission scope, with its summaries treated as navigation aids that point at pages, never as sources an answer may cite directly.

## 6. How other systems connect

Canon holds the company's documents. It does not hold the company's every fact, and it must not try to. The HRIS owns headcount, the claims system owns claim status, the benefits administrator owns the deductible. This section fixes how Canon reaches material that lives elsewhere, because getting it wrong in either direction is fatal: copy everything and Canon becomes a stale mirror of five systems, copy nothing and the record is a library of prose that cannot answer a real question.

### The question to ask of each system

Not "how do we sync it" but **does that system own documents, or does it own facts?** The answer picks the pattern, and there are only three.

**Migration — copy once, and Canon becomes the record.** Confluence, Google Docs, SharePoint, Notion. These hold prose a person writes and maintains, and there is no reason for two copies to exist. This is the importer, already built. The discipline that makes it honest is what happens to the source afterwards: a migrated space is retired or made read-only. Leave it live and editable and the organization now has two versions of the same policy, both writable, neither authoritative — precisely the drift Canon exists to end. An import that does not end with a retired source has not finished.

**Federation — never copy, resolve when read.** Systems that own facts and will keep owning them. Canon holds a page that *references* the value, and the value is fetched when the page is read or an answer is composed. Copying here is not merely wasteful, it is a correctness bug: the moment a deductible is synced into Canon, Canon is asserting a number it does not own and cannot keep true.

**Indexed reach — copy text for finding, cite outward.** A corpus that cannot be migrated yet. Canon indexes enough to retrieve it, but the material never carries the Canonical mark, and an answer drawing on it cites and links to the source system rather than claiming it. This is legitimate under principle 1 exactly because an index is derived and rebuildable; what would not be legitimate is presenting it as Canon's record.

What Canon never builds is a general-purpose sync engine. There is no fourth pattern where facts are copied in on a schedule and kept fresh by effort. That is the architecture this product was created to replace.

### Federation is the hard one

Three problems decide whether it works, and all three are about trust rather than plumbing.

**Whose permissions.** The source system has its own access model. Resolve every reference with one service account and Canon will cheerfully show a reader a figure they are not entitled to see in the system that owns it — Canon becomes a permission-laundering machine, which for a regulated buyer is worse than having no integration at all. So resolution carries the asker's identity wherever the source can accept it. Where it cannot, the reference is marked service-resolved, and a service-resolved value is treated as visible to everyone who can view its collection — stated on the page, not buried in configuration. An administrator choosing that mode is choosing to publish the value to the collection, and the product should say so in those words.

**Staleness is unavoidable, so it is displayed rather than hidden.** A page that will not render because an API is down is a bad page. Canon therefore keeps the last resolved value with the time it was fetched, and shows both. That is a copy — and it is allowed, because it is labelled, timestamped, and never authoritative. Each reference carries a freshness window; past it, the value is shown as stale rather than presented as current, and an answer that would have to lean on a stale value says so or refuses. This is the same discipline as the Registry's sixty-second revocation window: bounded, stated, enforced.

**Citations get stronger, not weaker.** Section 5 requires every claim to cite page and version. A federated value extends the citation rather than escaping it: *the deductible is $1,500, per the Benefits policy version 4, resolved from Benefits Admin at 09:14 today*. The page is cited for the rule, the source is cited for the number, and the reader can check both. An answer may never present a federated value without naming its source and resolution time.

### Querying other systems effectively

Capability decides the method, not preference. **You cannot rank what you cannot enumerate**, so semantic retrieval across an API that only answers by key is a dead end, and designing for it wastes months.

- A **crawlable corpus** — documents, pages, files — is indexed and ranked like the rest of the record, under indexed reach above.
- A **record system** is queried by structured lookup, keyed by an identifier the page already carries: a benefits policy page holds the plan id, and that id is what resolves. The page supplies the key; the connector supplies the value.

Beyond that, two rules that matter in practice: push filters down to the source rather than fetching broadly and filtering inside Canon, and set each reference's freshness window from how fast that field actually changes and what the compliance owner will accept — never one global default.

### Connectors are governed, like agents

The Veryl promise is that rules are set once and carried everywhere. If agents reach external systems directly, the Registry's limits stop at Canon's door and that promise quietly becomes false — an agent barred from a collection could read the same facts through the source behind it.

So a connection to an external system is a governed object, registered and limited the way agents are, and an agent's passport carries which sources it may reach alongside which collections it may read. Every resolution is an audit event naming who asked, which source, which reference, and whether the value came from the source or from cache. That log is what makes federation defensible to a compliance lead, and it is the same log that already covers page edits.

### The shapes

Concretely, three additions to the model in section 3:

**Source** — a registered external system: `id`, `name`, `kind`, `baseUrl`, `authMode` (`per_asker` | `service`), `freshnessWindowMs`, owner, and the collections it may be referenced from. Canon stores no secret material for a source beyond what a deployment's configuration supplies, and never stores a per-asker credential.

**Reference field** — a structured field on a page whose value is not stored but resolved:

```
{ sourceId, selector, key }        // what to ask, and the page-held identifier to ask it with
```

resolving to:

```
{ value, resolvedAt, fromCache, stale, sourceName, error? }
```

**Connector** — the seam an integration plugs into, parallel to the embedding provider in section 5:

```
resolve(source, request: { selector, key, asker }) -> { value, resolvedAt }
```

with the same discipline: a hermetic default so the system runs and tests run with no external calls, a real connector configured per deployment, and failure that degrades visibly rather than silently substituting a guess. The API surface is `POST /sources`, `GET /sources`, `GET /pages/:id/references` (resolve this page's references for the asking actor), and references travel inside the page payload the UI already fetches.

### When we would revisit this

If a design partner needs a fact to be *governed* rather than merely read — reviewed, approved, carrying the Canonical mark — then it is not a federated value at all; it is a page, and it belongs in the record with an owner. The test is whether the organization wants to argue about the number. Facts nobody argues about federate; facts that need an approver are documents wearing a number's clothing.

## 7. What happens when the record disagrees with itself

Federation brings in facts Canon does not own, and import brings in pages Canon did not write. Both make contradiction possible: two systems can answer the same question differently, a page's prose can contradict the value displayed beside it, and two Canonical pages can state opposite rules. This section fixes what Canon does about that, and the short answer is that **Canon does not decide**.

### The rule

Canon surfaces contradiction. It does not resolve it. There is no averaging, no last-write-wins, no preferring the fresher answer, no confidence score that quietly ranks one system above another.

The reasoning is the same one that rejected an inferred graph in section 5. A reconciliation nobody can audit is indistinguishable from an invention: it produces a single confident number with no way to ask where it came from or who agreed to it. For a record whose entire claim is that you can always ask that question, silent reconciliation is the worst thing the system could do — worse than showing two values and admitting they disagree, and far worse than refusing.

So contradiction is treated exactly as staleness is: made visible, attributed, and routed to the person accountable for the page. *Stale knowledge announces itself* was the freshness promise; contradicted knowledge announces itself too.

### Ownership is the only legitimate precedence

One case is not really a disagreement. If the claims system merely caches a figure the benefits administrator owns, then the benefits administrator is right by definition and the claims system is a copy that drifted. There is no judgement to make — there is an authority and there are copies.

That gives the only form of precedence Canon will encode, and it is a modelling decision rather than a runtime one: **authority belongs to a field, not to a source.** A reference declares which system is authoritative for that fact. Any other source answering the same question is **corroboration**, and its disagreement is a signal about the systems, never a vote about the value.

Where two systems genuinely both own their answer — headcount from the HR system and from payroll, computed to different definitions — there is no authority to name, and Canon must not invent one. That is a definitions problem wearing a data problem's clothes. Both values are shown, both are labelled, and the page's prose is where the difference gets explained by a person.

### The four shapes it takes

- **Two systems, one fact.** Handled by authority and corroboration above. The check is worth running even when an authority is named, because a corroborating source that has drifted is telling the organization something true about its own systems.
- **A value contradicts the prose beside it.** The most common and the most dangerous, because the sentence was approved and the number was not: a policy reads "the deductible is $1,500" while the reference resolves to $1,200. Canon cannot check this by parsing, and will not try — principle 2 runs the other way, and a system that extracted facts from prose to police prose would be inventing the very structure it claims not to have. The remedy is one discipline and one loop. The discipline is that a page should *display* the reference rather than restate it. The loop is that an agent which notices the contradiction raises a **proposal** carrying its reasoning, and a person settles it — which is exactly what FEATURES.md §5 means by agents flagging pages that contradict each other, and needs no mechanism that does not already exist.
- **Two pages contradict each other.** Never merged, never auto-resolved. Canon gains an explicit **relation** between pages — *conflicts with*, *superseded by* — asserted by a person or proposed by an agent and accepted by one. Because it is explicit it may be drawn: contradiction becomes something visible on the knowledge map rather than something discovered during an audit.
- **An imported page contradicts an authored one.** A migration artefact, and section 6 already names the cure: a migrated source is retired. Until it is, the map shows the duplicate pair, which is the point.

### Divergence is a record, not a decision

When a corroborating source disagrees with its authority, Canon writes a **Divergence**: which reference, which sources, what each said, and when it was observed. The authoritative value continues to display — an unexplained disagreement is not a reason to blank a field a system is entitled to answer — and the page shows that a divergence exists. The page's owner is notified through the same outbox that carries review requests, and the whole thing lands in the audit log.

A divergence is closed by a person, with a reason: *the copy was wrong and has been corrected upstream*, *the definitions differ and here is why*, *this source should not have been corroborating this field*. Closing it is a decision the record keeps, not a flag that silently clears when the values happen to agree again.

### Answers must never smooth a contradiction

This is the sharpest rule in the section. Grounded answers compose from several Canonical passages. If two of those passages disagree, an answer that reads them into one fluent sentence has done the thing this entire document exists to prevent, and it has done it invisibly, with citations attached that make it look verified.

So: when the passages an answer draws on conflict, the answer says so, cites both, and does not choose. *The record gives two answers here and they differ* is a correct, useful answer. It is also the product demonstrating its own integrity at the exact moment that matters, which is worth more than a fluent guess.

### The shapes

```
Reference field   { sourceId, selector, key, role: 'authority' | 'corroborating' }
Divergence        { id, referenceId, pageId, authoritySourceId, authorityValue,
                    otherSourceId, otherValue, observedAt, state: 'open' | 'closed',
                    closedBy?, closedAt?, reason? }
Page relation     { fromPageId, toPageId, kind: 'conflicts_with' | 'supersedes',
                    assertedBy, assertedAt, note }
Answer            …, disagreement?: { pageIds: [...], note, asserted? },
                     supersession?, sourceDisagreement?
```

An answer reports a contradiction from whichever of the three places the record holds one, and says which: `disagreement.asserted` carries the person who put their name to a `conflicts_with` relation, their words and the date, and is absent when Canon inferred the conflict from the passages' text instead. The two are not equivalent evidence and the reader is not asked to treat them as such.

`supersession` and `sourceDisagreement` are siblings rather than more `disagreement`, because neither is two Canonical pages in unresolved conflict. A supersession has already been *settled* by a person — reporting it as a disagreement would tell a reader the opposite of what the record says. A source divergence is one page and two external systems: there is no second page to quote, and the remedy is a decision about the sources, not about the record.

### What Canon will not build

No automatic merge. No per-source trust score that outranks a named authority. No rule that the fresher value wins — freshness is not authority, and a stale answer from the system that owns a fact still beats a fresh one from a system that does not. No silent closure of a divergence because two systems drifted back into agreement.

## 8. What Registry and Studio depend on

These are the contracts. They name what each product may assume about Canon, and what Canon assumes in return.

### Registry ⇄ Canon

- Canon authenticates every agent session against the Agent Passport and checks certification with the Registry on every session; revocation takes effect in Canon within one minute, with session-level cutoff under discussion (see [CORE-PLAN.md](CORE-PLAN.md), open questions).
- Canon enforces the Registry's permitted collections and actions and adds no separate agent permission system.
- Canon returns the audit trail: every agent action in the record, attributed and exportable, so the Registry's governance claims can be proven from Canon's log.
- The governance documents themselves — certification policies, usage rules, procedures — live in Canon as pages, reviewed to Canonical like any policy, so the rules that govern agents are held to the same standard as the rest of the record.

### Studio ⇄ Canon

- The Knowledge API gives Studio apps read and, where permitted, write access to the record — the same store, live, with no export or sync.
- Every API call carries an actor: the app's agent identity from the Registry, and where an app acts for a person, that person too. Canon evaluates permissions per call and logs per call.
- Apps that answer questions ground them the way Canon's own answers are grounded: Canonical pages only, permission-filtered to the asker, cited, and refusing when the record is silent.
- A permission change or revocation in Canon or the Registry is effective on the next API call. Studio apps never hold data rights of their own; they borrow them, per call, from the record.

The Knowledge API lands in the Next tier ([FEATURES.md](FEATURES.md), what ships first). The contract is stated now so nothing in Core forecloses it — which is Core's standing rule for all deferred work. It is written out in full in [STUDIO-CONTRACT.md](STUDIO-CONTRACT.md), which is to Studio what [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) is to the Registry, and is built on that contract rather than beside it: a Studio app *is* an agent, and presents an Agent Passport exactly as one.

## 9. What this means for build order

The Core plan already sequences the product correctly for this role; the backbone framing changes emphasis, not order.

- **The data model is the contract.** Epics A and B build the entities in section 3. They must be built as if Registry and Studio were already reading them, because they will be: stable page identity, fields as data, append-only history are backbone requirements, not polish.
- **The Registry contract comes first among integrations.** Core's plan already requires agreeing the Passport and certification-check contract before M1 ends. This document adds the reason: it is the suite's trust boundary, not just a Canon feature.
- **The Knowledge API is the third product's foundation.** It ships in the Next tier, but its shape — actor on every call, permission per call, Canonical-only grounding — is fixed now. Studio's timeline depends on it, so the Next tier should open with it.

## 10. Open questions

Beyond the Core plan's open questions, the backbone role raises four of its own:

- Do design partners accept service-resolved references at all, or must every federated value carry the asker's own identity into the source system? The answer decides how much of a partner's integration surface is reachable in the alpha, since per-asker resolution needs identity mapping the partner may not have.
- Which embedding provider. The seam now has three implementations and the question is which one a partner picks, not whether one exists: the built-in hashed bag of words (no dependency, no network, and no notion of paraphrase), an OpenAI-compatible endpoint — which reaches a hosted API *and* a model server the partner runs inside their own network, and is the same code either way — or the model in Canon's own process, which costs an optional dependency and sends nothing anywhere. A partner who will not have their record's text leave the machine has two answers rather than none. What is still open is which model, measured against their corpus rather than ours.

- Does Studio need read access to any non-Canonical material — for example, an app that helps a team work on drafts — or is the Canonical-only boundary absolute for apps? Leaning absolute for answers, permitted-with-attribution for working tools.
- Does the Registry need a push channel from Canon (agent activity streamed as it happens) or is pull from the audit log sufficient for its compliance views? Resolve alongside the Passport contract discussion.

**Resolved — where an app acts for a person, Canon records both.** The app is the actor in history and in the audit event; the person is named alongside it, on every call, via the `X-On-Behalf-Of` header, and the effective permission is the intersection of the app's Registry limits, the app's Canon permissions and the person's Canon permissions. See [STUDIO-CONTRACT.md](STUDIO-CONTRACT.md) (sections 3 and 4).

---

*Naming per the brief: Veryl Canon in full on first mention and in headings; Canon once inside product context.*
