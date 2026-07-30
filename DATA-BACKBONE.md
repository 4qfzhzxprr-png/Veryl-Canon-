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
5. **Attribution is universal.** Every write names its actor — person or agent — and nothing is anonymous. The same record serves collaboration and audit.

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

## 4. How the data is organized

Organization is what turns a store into a record. Three structures do the work:

- **The tree gives knowledge a place.** Collections at the top, page trees below, without depth limit. A branch moves with its children, and every page keeps a stable link through any reorganization. Location is meaningful — a spec under its plan, a procedure under its policy — but never load-bearing for identity.
- **Types and fields give knowledge a shape.** A page's type declares what it is and what it must carry. Because fields are data, the record can be queried like a database — every Canonical policy owned by Compliance, every spec awaiting review — while still reading like a document.
- **Status gives knowledge a standing.** The Canonical mark, earned through the type's workflow and visible everywhere the page appears, is what separates the official record from working notes. Grounded answers and Studio apps draw only from Canonical material, so standing is not a badge; it is the boundary of what the suite will act on.

Underneath, storage separates by lifecycle: the current record (pages, fields, permissions) optimized for live reads and writes; immutable history (versions, audit events) optimized for append and proof; and derived indexes (search, query) that can always be rebuilt from the first two. Any technology choice that respects this separation is acceptable; any that blurs it is not.

## 5. What Registry and Studio depend on

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

The Knowledge API lands in the Next tier ([FEATURES.md](FEATURES.md), what ships first). The contract is stated now so nothing in Core forecloses it — which is Core's standing rule for all deferred work.

## 6. What this means for build order

The Core plan already sequences the product correctly for this role; the backbone framing changes emphasis, not order.

- **The data model is the contract.** Epics A and B build the entities in section 3. They must be built as if Registry and Studio were already reading them, because they will be: stable page identity, fields as data, append-only history are backbone requirements, not polish.
- **The Registry contract comes first among integrations.** Core's plan already requires agreeing the Passport and certification-check contract before M1 ends. This document adds the reason: it is the suite's trust boundary, not just a Canon feature.
- **The Knowledge API is the third product's foundation.** It ships in the Next tier, but its shape — actor on every call, permission per call, Canonical-only grounding — is fixed now. Studio's timeline depends on it, so the Next tier should open with it.

## 7. Open questions

Beyond the Core plan's open questions, the backbone role raises three of its own:

- Does Studio need read access to any non-Canonical material — for example, an app that helps a team work on drafts — or is the Canonical-only boundary absolute for apps? Leaning absolute for answers, permitted-with-attribution for working tools.
- Where an app acts for a person, does Canon record the person, the app, or both as the actor? Leaning both, always: the audit question is "who did what, through what."
- Does the Registry need a push channel from Canon (agent activity streamed as it happens) or is pull from the audit log sufficient for its compliance views? Resolve alongside the Passport contract discussion.

---

*Naming per the brief: Veryl Canon in full on first mention and in headings; Canon once inside product context.*
