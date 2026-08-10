# Remediation plan — Registry, Studio, Canon

From the 50-tester user test (`USER-TESTING.md` in agent-studio and Veryl-Studio,
`USER-TESTING-ROUND-7.md` here). **421 defect rows: ~37 blocker, ~258 major, ~271
minor/cosmetic.** Many are the same defect found by several testers; deduplicated they
collapse to roughly **30 root causes**, which is what this plan is built around. Fixing
by root cause rather than by row is the difference between a multi-month grind and a
few focused weeks.

Sequencing decisions taken before writing this:

- **Priority: things that mislead a person come first.** A product that states something
  false to someone acting on it is worse than one that refuses.
- **Registry: both, in order.** The demo-honesty and product-code fixes proceed now,
  because they are independent of the backend. Standing up the FastAPI service and
  re-running the Registry personas against it is a parallel workstream that feeds a
  second round.
- **Implement immediately**, phase by phase, on the existing branches.

---

## Ground rules for every fix in this plan

1. **Do not reverse a documented decision without asking.** Worked example, hit on the
   first fix attempted: the Canon finding "a reader is told a contested page is
   uncontested" looks like a filtering bug, and `relations.ts:89-92` plus the test
   *"a relation whose other end the asker cannot see is absent, never a placeholder"*
   show the hiding is deliberate and pinned. The real defect was one line of UI copy
   turning a permission-filtered list into a claim about the record. **When a finding
   and a test disagree, the test is evidence of intent — fix the narrower thing and
   raise the policy question.**
2. **Every fix lands with a test that pins the intent**, in the voice of the existing
   suites. Several of these defects exist because the intent was never pinned.
3. **Honour the standing rules.** Frozen contracts (`contracts.py` ⇆ `api.ts`,
   `db/models.py`, design tokens, trust rendering) change only in coordinated edits;
   any nav/section/feature change bumps `APP_DOCS` + `APP_DOCS_VERSION` in the same PR;
   new surfaces pass the `docs/SURFACES.md` checklist; install/setup copy stays
   non-technical; touch controls stay ≥16px.
4. **Separate "the demo lies" from "the product is wrong"** in every commit message.
   Six findings were withdrawn or narrowed during the test for exactly this reason.

---

## Phase 1 — Things that mislead a person acting on them

The highest-harm, mostly-smallest fixes. Ship as one release per product.

### Canon

| # | Defect | Fix |
|---|---|---|
| 1.1 | Page states "The record does not hold a conflict or a supersession for this page" when relations exist but are permission-filtered | **DONE** — copy now describes the listing, not the record. Non-disclosure preserved. |
| 1.2 | Ask labels `ANSWER — drawn from N Canonical pages` on topical overlap alone; reproduced on an excerpt truncated one clause before the number asked for | Require a **responsive extracted span** before the ANSWER label; highlight it; otherwise refuse with *"these Canonical pages are about this subject; none of them states one"*. Widen the excerpt window to end on a sentence boundary. |
| 1.3 | Version history, page header, compare header and attestation JSON all name the **approver** as author | One display bug in every provenance artifact. Source author from the `draft.start` actor, as the audit log already does. |
| 1.4 | ~~Approve pane says "there is no reviewed baseline"; "Show me the changes" is dead; a version note states a false diff~~ | **WITHDRAWN — three non-defects.** (a) "No reviewed baseline" means no version ever held the *Canonical* mark, which is not the version-to-version diff `#/compare` shows; approving certifies the whole document including previously-unreviewed published text, so the unmarked wall is deliberate and argued at `app.js:2439-2443`. (b) The button is not dead — it closes the modal and scrolls to the panel, and the note is preserved by design (`app.js:3016`). (c) The false note is free text an approver typed into `input.note`, not generated. Possible additive improvement, not a fix: offer the published-version diff *alongside* the full text. |
| 1.5 | `#/queue` tells the owner of a conflicted page "No conflict has been asserted against a page you own"; `#/map` reports `Conflicts with 0` | Same class as 1.1 — owner-scoped and permission-scoped filters rendered as facts. Reword to describe the view. |
| 1.6 | Superseded page shows a plain `DRAFT` chip everywhere a reader arrives from, and its replacement is `IN REVIEW`, which Ask never uses — so the subject has no canonical answer while the banner implies one | Show supersession state in search, the collection table and Related panels; warn when a supersession points at a page Ask cannot use. |
| 1.7 | A canonical page publishes different federated values to different readers with no marker | Mark per-asker resolution in place, as service-resolved refs already are. |

### Studio

| # | Defect | Fix |
|---|---|---|
| 1.8 | Approvals review panel keyed by app id, not app+version — an approver reading v1 rejects v2 | Key by app+version. **Highest-severity Studio defect: it records a human judgement that was never made.** |
| 1.9 | Refetch races unsaved edits and persists the reverted state while the header reads `✓ All changes saved` — 4 reproductions, one of which makes sum/average charts impossible to build at all | Fix the race (drop in-flight GETs while the editor is dirty, or reconcile on merge); never show "saved" while a write is pending; remove the simultaneous "saved"/"Saving…" state. |
| 1.10 | `View as` reports a deactivated user can still open a published board (`canOpen:true`) | Consult `deactivatedAt`. The runtime is correct — only the verification tool lies. |
| 1.11 | Every published app card prints and copies a hostname that does not resolve; "copy link" navigates instead of copying; publish panel shows the stale pre-rename slug | Pair every hostname with the working preview link the publish dialog already uses; fix the clipboard handler; recompute the slug after rename. |
| 1.12 | AI generator ignores the prompt and reports success (`notices: []`) — three unrelated prompts produced the same app | Return what it could not honour; refuse rather than substitute. |
| 1.13 | Mock AI output is indistinguishable from real, and the only disclosure lives in a console builders cannot open | Label mock provider output where it renders. |
| 1.14 | Company pipeline funnel reports "128.6% the size of Negotiation" | Stop presenting independent stage counts as funnel conversions. |

### Registry (demo honesty — these are the demo, and the demo is what people judge)

| # | Defect | Fix |
|---|---|---|
| 1.15 | Canned interview/preview answers stamped "Based on the verified knowledge sources" with citation chips — identical text for five different questions, and for PHI / capital-of-France / liability | Label canned responses as canned wherever they render. |
| 1.16 | `Chain intact ✓` and a per-row hash column rendered over fabricated `row_hash` values | Either compute a real chain in the fixture or replace the assurance panel with an honest "demo data — not a verified chain" state. |
| 1.17 | "Extract decisions" fabricates provenance — a coffee-machine transcript produced a formulary SLA decision "by Pharmacy Expert" | Make the mock echo only what it was given, or disable extraction in the demo. |
| 1.18 | Assistant answers billing with an invented paid invoice, and roles with a cited-but-wrong walkthrough | Point the mock responder at the real `APP_DOCS` (`executive_assistant.py:224-233`), which already documents what five testers were told it could not answer. |
| 1.19 | Realistic placeholder on an empty Canon-grant permission field | Blank it. It caused a trained tester to report access that does not exist. |
| 1.20 | `StatusBadge.tsx:24` lets `report.certified_by` outvote the agent's own state; never-verified and quarantined agents show re-verification countdowns; two freshness clocks on one screen | **Product code, not mock** — will misreport against the real backend too. |

---

## Phase 2 — Destructive and irreversible actions

| # | Product | Defect | Fix |
|---|---|---|---|
| 2.1 | Canon | Sole-admin self-removal orphans a collection permanently; even the global admin gets "No access"; no archive or delete | Refuse the last admin's self-removal (Registry already does this: *"You can't remove your own Admin role."*). Add recovery. **Two collections on the test server are currently unrecoverable.** |
| 2.2 | Studio | "Reset password" fires on one click with no confirmation and ends every session | Confirm. This locked out an admin account mid-test and three testers misdiagnosed the fallout. |
| 2.3 | Studio | Re-sharing a template returns HTTP 500 on `/studio` for everyone who instantiated it, with no recovery path (`Event handlers cannot be passed to Client Component props`) | Fix the Server Component boundary. Verified: jordan 500 / sam 200 / casey 200 on the same route. Also fires on `/admin` and the editor. |
| 2.4 | Registry | Granting Admin and emailing Admin invites take zero confirmations, while "Reset 2FA" and "Deactivate" are guarded; "Allow self-verification (solo mode)" removes segregation of duties org-wide on one unguarded click | Guard privilege escalation at least as tightly as 2FA reset; make solo mode two-step and audited. |
| 2.5 | Studio | Publish dialog clickable while empty with **"Everyone at the company" preselected** on a three-group app; Revoke live while its impact line is still computing | Disable until loaded. See Phase 5 — same root cause. |

---

## Phase 3 — Governance enforcement

| # | Product | Defect | Fix |
|---|---|---|---|
| 3.1 | Registry | Quarantine displays "blocked on every surface" while the agent still shows Verified in the catalog and answers in rooms | Propagate. **Re-test against the real backend before deciding scope** — this may be mock-only. |
| 3.2 | Registry | Certification gate: four testers, four roles, none got an agent through; one self-verified with solo mode off | Enforce reviewer ≠ owner server-side; make submission actually reach the queue; resolve the three contradictory states on one screen. |
| 3.3 | Registry | Reviewer can mark a check Pass while the engine on the same screen reports FAILED 61% / 8 uncited claims, and the UI says "All checks pass or warn" | Refuse or record an explicit override with a reason. |
| 3.4 | Registry | Audit vocabulary missing role changes, deactivations, policy changes, certification decisions, quarantines, money events, connector grants, meetings, workflows | Add the action types. The page claims "every privileged action". |
| 3.5 | Canon | `agentauth.ts` folds `approve`/`publish` into `write`; `REGISTRY-CONTRACT.md:52` offers only read/comment/write — **no grant can let an agent draft without letting it make pages canonical** | Contract-level change: add a distinct action. Coordinate with the Registry contract. |
| 3.6 | Studio | Free text typed into a Text component is ungoverned — confidential values ship verbatim to viewers denied the same data; publish diff returns `riskFlags: []` | Classify or scan Text literals against withheld values at publish time. |
| 3.7 | Studio | A builder can send company data outward from an unpublished draft with no approval; destination invisible (`url: ""` shown as healthy); failed deliveries record no actor and cannot be retried | Govern egress like ingress. |
| 3.8 | Canon | Refused access is never audited — five 403s produced zero rows in a log advertising "every … view of restricted material" | Log denials. Examiners ask for them specifically. |
| 3.9 | Canon | Page bodies render cross-collection links unfiltered, leaking restricted titles into the page, search snippets and Ask answers | Filter body-rendered links at render time; warn at publish. |
| 3.10 | Studio | `/apps/<slug>` resolves before authorizing, exposing app names, builders and emails by slug-walking | Authorize first. The guest path already does this correctly. |
| 3.11 | Registry | No route lists or bulk-revokes a user's sessions (backend has `revoke_session`); no server-side password minimum on the invite path | Add both. |

---

## Phase 4 — Close the loops

**The single most valuable cross-product finding.** All three model handoffs between
people and none reports back to the person who acted.

- **Canon**: comments notify nobody; @mention accepts only raw UUIDs; the send-back
  banner promises reply/resolve that exist server-side (`api.ts:288-289`,
  `resolved_at`/`resolved_by`) and have no UI; authors lose sight of submitted work
  ("You have no drafts in progress").
- **Registry**: agents submitted for verification never reach the queue; no reviewer
  record of their own decisions; no reviewer name, ETA or nudge after submitting.
- **Studio**: `digest_ready`/`alert_fired` render and `sendMail` is never called with
  them; `approvalNote` is written and read by no surface; subscribe reports success
  without persisting; no notifications area at all (`/notifications` 404s); admin
  actions notify nobody.

Do this as one design, once, and adopt it in all three.

### 8.1 — landed early, because it was one line and it was everywhere

Studio's zero horizontal padding was reported as a mobile finding; it is not. The
shared chrome lives in `packages/shell`, every Tailwind config globbed `./app` and
`./components` and nothing else, and `px-lg` / `py-xl` / `gap-md` / `py-sm` appear ONLY
in the shell — so they were never generated for **any of the three apps**. The header,
the notice bar and the `<main>` wrapper had no padding at all: text against the edge of
the viewport on every authenticated screen, worst on a phone.

It survived because the failure has no error and no wrong markup. The class is in the
DOM, the stylesheet just has no rule for it, so it reads as a design choice — nobody
looks for a missing CSS rule when the component looks like it was written that way. And
nothing in the apps' own files happens to use those four classes, so there was no
accidental rescue either.

Proven rather than assumed: compiling each config before the change emits none of the
four; after, all four. The guard that keeps it fixed reads the class names **out of the
shell's source** rather than hardcoding them, so adding a `gap-2xl` to the header fails
the test until the globs cover it — and it checks all three apps, because one of them
quietly re-narrowing its globs is the regression it exists to catch. Verified by
mutation: reverting Canon's config alone reddens Canon's case and no other.

**Observed while running these:** `apps/registry/tests/bootstrap.test.ts` — "creates the
principal … then never again" — is intermittently red (roughly one run in four). Its
`onEmptyRegistry` helper deletes every principal inside a transaction it rolls back,
which isolates its own writes but not a peer suite committing a principal mid-transaction
under READ COMMITTED. Unrelated to anything in this branch (it reproduces with the branch's
changes stashed) and not fixed here: I could not reproduce it deterministically, and a
fix I cannot verify against the actual failure is a guess. Recorded so it is not
mistaken for noise.

### 3.9 — landed, and honest about the half it cannot reach

A body is prose, and prose names things. A page written by somebody with wider access
can say "superseded by [Q3 Workforce Reduction Plan](/pages/…)" and Canon showed that
sentence verbatim to every reader of *this* page — in the page, in a search snippet, and
inside an extractive answer that quotes the passage.

Link *traversal* was already correct (`retrieval.ts` hydrates every hop through the
asker's permissions). The leak was the label. So: a link whose target the reader cannot
open loses its label and its href, replaced by "a page you do not have access to". Both
link forms, including the wiki form that carries a bare id — an id is a handle.

**What it does not fix, stated rather than glossed:** a body that merely *mentions* a
title in prose is indistinguishable from any other sentence, and no permission check can
find it. The link is the findable half because it carries an id that can be tested. The
rest needs a publish-time warning to the **author**, who is the only one who can judge
prose — worth building, not built here.

Two things that could have gone wrong and are pinned instead:

- **Never a rewritten body.** The withheld ids are served as a list for the renderer to
  match on. Redacting the stored text on read would mean an author loading the same
  version in the editor and saving their own link away.
- **Never the author's own draft.** The editor's live preview renders from the textarea
  and never applies the list. A hole where their link is would invite them to "fix" it.

## Phase 4 — done, and half of it was not what was reported

The plan said to do this as one design adopted three times. In the event the three
products needed three different things, because they had three different amounts of it
already built — and checking first was worth more here than anywhere else in the test.

**Canon: "comments notify nobody" — wrong.** Canon has eleven notification kinds, an
outbox with delivery attempts, and a non-disclosure rule that *withholds* a mention
rather than refusing the comment, so `@`-ing an outsider does not mail them a restricted
page's title. What was real underneath:

- Mentions had **no usable address**. `@<actorId>` was the only form and an actor id is
  a UUID; the composer was a bare textarea that said nothing about it. Names resolve
  now, scoped to the collection's members — the set that can be *named* is the set that
  can be *reached*, so nothing is learned by guessing. Longest-first ordering alone was
  not enough and a test caught it: `@Dana Reyes` contains `@Dana`, so without claiming
  the matched span the shorter name is a permanent false positive of the longer.
- A comment naming nobody **reached nobody**, including the person §3 makes accountable
  for the page. New `comment_added` kind, weaker than a mention: you were not asked,
  your page was discussed. A page with no owner still tells nobody, and that is pinned —
  it is the record being honest, not a dropped message.
- **Resolve had routes and no button.** `POST /comments/:id/resolve` and `/reopen` have
  existed since resolve was written, and `resolved_at`/`resolved_by` are stored — so the
  send-back banner's promise that a comment "can be replied to and resolved" was half
  true. The client was also dropping who resolved it and when, so "resolved" rendered as
  a conversation closed by nobody at no time.
- **Authors could not see submitted work.** `myDrafts` excludes `in_review` because the
  move is the approver's — right about whose turn it is, wrong about what the author
  needs. New strand, deliberately **outside the count**: the badge is what is waiting on
  *you*, and a badge you cannot clear is ignored within a week. Naming the approver hit
  the trap the codebase warns about — `pages.approver_id` is the *published* version's
  and is null on a page that never published — so it reads the same `fields_json` column
  `approve` enforces against.

**Registry: one demo defect, one real one.** "Agents submitted never reach the queue" is
the fixture: session-created agents live in `CREATED_AGENTS`, `agentByVersion` was
taught about that when submitted drafts stayed "Draft" forever, and `mockQueue` never
was. Same bug, second half, different function — only the half somebody reported got
fixed. "No reviewer record of their own decisions" is real and the data was never
missing: `verification_run` has carried `reviewer_id` and `reviewer_decision` since
sign-off was written. `GET /review/decisions` reads it back; the strip merges it behind
this sitting's entries so a decision made ten seconds ago does not wait on a refetch.
Deliberately the caller's own record only — an admin wanting the team's has the audit
log, which 3.4 made filterable. An advisory engine run is not a decision, and listing it
would credit a person with a machine's output.

**Studio: one real, two not.** `approvalNote` was written by the approve route and read
by **nothing** — the only other mention in the codebase is the seed. An approver who
sent a version back and typed why sent it nowhere; nothing in the builder's surfaces
renders `rejected` at all. A decision now writes a notification carrying the note. The
doorbell rule (rings carry no data) is about governed data crossing a channel that
checked nobody's access — an approver's sentence about somebody's own work is not that.

Not what was reported: there **is** a notifications area (the bell is mounted in the
shell, backed by a real API with server-side read state), and the unused
`digest_ready`/`alert_fired` templates are dead code rather than a broken delivery,
because a digest goes out through a workflow connection.

Canon 836 passing, Registry 2223 backend + 366 web + 358 E2E, Studio 1680.

---

## Phase 5 — Loading and empty-state discipline

One pattern, ~12 surfaces, and the cause of several Phase 1/2 defects. **No product has
a loading, timeout or retry state anywhere**, so latency turns into wrong decisions and
duplicate writes rather than a spinner.

Rule to adopt: **never render an empty result as a factual claim of absence, and never
enable an action whose consequences have not loaded.** Covers Studio's People / Data &
classification / Access requests / approvals / app list / Domains (whose stale list
induces a duplicate write and a `400`), Canon's audit count line that reads "168 events
match" and "No matching events" simultaneously, and Registry's review queue.

---

## Phase 6 — Accessibility

Measured, specific, shared between products.

- **Silent route changes** — `document.title` never updates in either product (Registry:
  literal `"Veryl"` on 8 routes; Canon: never reassigned, 9 routes); focus never moves
  to the new `<h1>`; no live region fires.
- **`aria-current`** — Registry marks the wrong link on `/audit`, `/new`, `/agents/:id`;
  Canon has none at all.
- **Focus ring contrast** — Registry ~1.8:1 across 112 controls; Canon 1.08:1, and
  removed entirely on the Ask textarea. Both fail SC 1.4.11.
- **Canon modal** has no focus trap, no Escape, no focus restore (`app.js:588`).
- **Registry's assistant launcher** is unreachable by keyboard on any scrolling page —
  its scroll-duck sets `aria-hidden`/`tabindex="-1"`, and tabbing is what scrolls.
- **85 tab stops** to Canon's main column, no skip link, `<a>` nested in `<summary>`.

Keep what works: Registry has zero unnamed controls across seven routes; Canon exposes
page standing as real text everywhere, never colour-only.

---

## Phase 7 — Surfaces that do not exist

Each of these blocked a tester outright.

| Product | Missing |
|---|---|
| Canon | Import UI (server routes exist, nothing renders them); no retry for the failed import; imported pages land with no owner/approver/review date |
| Canon | Gaps for collection stewards (operator-only; the prescribed remedy lives in the steward's editor) |
| Canon | Per-page visibility; request-access from a refusal; an admin inbox for those requests |
| Studio | Guest administration (no guest surface in 13 admin tabs) and guest invitation (gated behind four hidden, currently unsatisfiable preconditions) |
| Studio | Directory surface; group control of any kind |
| Studio | Which apps bind the most sensitive class (`viaApps: []` for drafts) |
| Registry | "Sell an agent" has no form behind its primary CTA; external agents can never be verified, so never sold |
| Registry | Calendar has no attendees (`ScheduledMeetingOut` has no field — frozen contract) |
| Registry | Buyer-side invoices; spend attribution (`PurchaseOut` has no buyer/approver/cost-centre — frozen contract); `actor` on connector grants (`ConnectorGrantOut`) |

---

## Phase 8 — Mobile, vocabulary, polish

- Studio: zero horizontal padding on every authenticated screen — `tailwind.config.ts`
  `content` globs exclude `packages/shell`, so its `px-lg`/`gap-*` are never generated.
- Canon: 15px search box (iOS zoom); 37.5% sticky header; no prefix matching, no typo
  tolerance, no acronyms, no results page, Enter does nothing
  (`search.ts::toMatchQuery` quotes terms with no `*`).
- Registry: plain `<a>` excluded from the 44px tap floor (one-line fix — add
  `a:not(.tap-inline)`); delete-confirm requires a character absent from the iOS
  keyboard; "+ Add to a room" picker renders off-viewport.
- Registry: apply the non-technical-voice rule to **trust** copy, not just install copy
  (`Invocable`, `rubric`, `sha256`, `JWS · EDDSA`, `voyage-3-large`, `P95`), and settle
  on one word per state — `certified` / `reviewer-signed` / `Verified` are the same thing.
- Canon: `effectiveDateBasis` leaking into user-facing refusal copy.

## Phase 9 — Remaining minor and cosmetic

~271 rows, batched per product once the above lands.

---

## Policy questions for the team — decisions, not bugs

These came out of the test and should be answered by a person, not chosen by whoever
picks up the ticket.

1. **Canon: does a reader learn that something exists they cannot see?** — **ANSWERED:
   existence, never identity.** Ask disclosed contested-ness without naming the page;
   the relations panel deliberately disclosed nothing (`relations.ts:89-92`, pinned by a
   test); search claimed "Nothing in the record matches" over a permission-scoped result
   set. Two surfaces, opposite policies, and the one that disclosed was the one built
   after a compliance director found the gap.

   The rule now, in all four places: **a relationship the record states about a page you
   hold is disclosed; nothing identifying about the far page is.** No id, no title, no
   type, no status, no collection — and not the asserter's *note* either, because a note
   explaining why two pages contradict is a description of the page being withheld. The
   asserter's **name** does travel: that is a structured fact about an assertion made
   against a page you hold, not prose about one you were refused.

   Two boundaries the answer deliberately does **not** cross:

   - **Search is scoped, not widened.** "Nothing you can see matches" replaces the
     absolute claim, and no hidden-match count is reported. Search takes an arbitrary
     term, so a count is an oracle you could binary-search titles with. Existence is
     disclosed where the record *states a relationship to something you hold* — not in
     answer to any question anyone can type.
   - **The knowledge map still draws only what it can place.** Same reason: its node
     selection is a broad query, and phantom nodes there would count and cluster hidden
     pages. The legend now points at the page panel for the rest.

   Landed in `ed3a4c9` (relations, Ask, search) and `75c5166` (3.9, body links).
2. **Registry: is the demo meant to simulate enforcement, or to be visibly a demo?**
   Determines whether 1.16/1.17 get real implementations or honest labels.
3. **Studio: should Text components be classifiable at all,** or is authored prose
   always the builder's responsibility?
4. **Canon: correct the one page carrying a false version note** from defect 1.4, or
   leave the record as it was written?
5. **Should an end user be told an AI answer came from the offline mock?** Today the
   marker is stripped for viewers by design and shown only in the builder preview. The
   argument for stripping is good; the consequence is that a published app can present
   canned text with citation chips and no hedge, which is the single most repeated
   defect shape across all three products.

---

## Status

**Fixed and pushed**

| # | Product | What changed |
|---|---|---|
| 1.1 | Canon | Relations empty state describes the listing, not the record |
| 1.2 | Canon | A quotation finishes its sentence instead of ellipsing the answer away — the clinician's "seventy-two hours" is now inside the citation |
| 1.3 | Canon | Approval records the drafter as author, not the approver |
| 1.8 | Studio | Approvals keyed by app+version — no more deciding a version you never opened |
| 1.9 | Studio | A late load no longer adopts over unsaved work |
| 1.10 | Studio | `View as` consults `deactivatedAt`, so a leaver reads as blocked |
| 1.19 | Registry | Empty Canon-grant fields read "none granted" instead of sample ids |

Each verified rather than assumed: 1.2, 1.3 and 1.9 have tests that fail without the
change; 1.9 and 1.10 were reproduced against the running product and re-checked after.

**Withdrawn on inspection — four findings that were not defects**

| # | Why |
|---|---|
| 1.4 | "No reviewed baseline" means no version ever held the Canonical mark, which is not `#/compare`'s version diff; approving certifies the whole document, so the unmarked wall is deliberate (`app.js:2439-2443`). The diff button scrolls and preserves the note. The false version note was free text an approver typed. |
| 1.14 | The funnel never claims a conversion. `gateway/index.ts:1547-1554` refuses that word explicitly and states the ratio "can exceed 100% here whenever a later stage is simply busier". The tester read a funnel shape and inferred progression. |
| — | Registry's audit hash chain (real keyed HMAC in `services/api`; the fabricated one is the demo fixture) |
| — | Canon's hidden relations (deliberate non-disclosure, pinned by a test) |

A fifth was avoided mid-flight: the first attempt at 1.2 added answer-shape scoring to
window selection, which `retrieval.ts:103-109` records as already tried and measured
useless ("on a schedule every window holds a figure"). Reverted; the real fault was the
window's END, not its start.

**Also landed since:** 1.5 (Canon queue + map legend say what is shown, not what the
record holds) and the clipboard half of 1.11 — `copy link` now copies on every browser
and context, via one helper with a real fallback. Four call sites shared a
`navigator.clipboard?.writeText(t).then(...)` that throws a TypeError when the API is
absent; the guest invitation was the one that mattered, since mail is unconfigured and
that link must be handed over by hand.

**Two more narrowed rather than fixed**

| # | Finding | What is actually true |
|---|---|---|
| 1.11 | "Published URLs don't resolve" | Split in two. The clipboard bug is fixed. The address itself — `<slug>.<domain>` — is a DNS and served-domains deployment gap (tester 36 proved host routing works when the Host header is set), not an application defect. Left open as a deployment item. |
| 1.13 | "A builder cannot tell mock AI from real" | Mostly already built. `splitProviderNotice` lifts the mock's self-identification out of the answer and all three AI components render it as `⚙️ {notice}` — but only in the builder preview (`mode === "draft"`). Hiding it from end users is deliberate: "infrastructure configuration on a salesperson's screen, and an invitation to doubt the content next to it." Whether an end user should nonetheless be told the answer came from a demo model is a **policy question**, added below. |

**Also landed:** 1.17, 1.18, 1.20, and the shared-report halves of 1.15/1.16.

| # | Product | What changed |
|---|---|---|
| 1.17 | Registry | Decision extraction quotes the transcript or extracts nothing — the coffee-machine case now yields no decision |
| 1.18 | Registry | The assistant answers Passport / Verified / who-approves / what-is-an-agent from the real `APP_DOCS` wording, and no longer invents a paid invoice |
| 1.20 | Registry | Each agent gets its own verification report, provenance following its state |

1.20 also closed the "identical report hash across nine agents" and "byte-identical
evidence across four agents" findings: one shared `REPORT` constant was the cause of
all three. Reported as a precedence bug in `StatusBadge`; it was not — trust rendering
is a frozen contract and behaved correctly, the fixture was contradicting the agent's
own state.

**Phase 1 is complete.** The last three:

| # | Product | What changed |
|---|---|---|
| 1.6 | Canon | A supersession says so when its replacement is not in the official record yet, so "superseded by X" cannot imply an approved answer that does not exist |
| 1.7 | Canon | A per-asker federated value is marked "resolved for you" — the unmarked half of the rule that already marks service-resolved values |
| 1.12 | Studio | The generation relevance check no longer counts function words. One shared "with" between a lasagna-recipe prompt and the Opportunities description was suppressing the notice |

1.12 also moved the predicate into `lib/generation-relevance.ts`: it lived inside the
route handler, which is why the existing generation suite could not have caught it.

---

## Phase 1 scorecard

**15 fixed** — 1.1, 1.2, 1.3, 1.5, 1.6, 1.7 (Canon); 1.8, 1.9, 1.10, 1.11a, 1.12
(Studio); 1.15, 1.16, 1.17, 1.18, 1.19, 1.20 (Registry).

**6 withdrawn after reading the code they accused** — 1.4, 1.13, 1.14, plus Registry's
"fake" hash chain (real keyed HMAC in `services/api`), Canon's hidden relations
(documented non-disclosure, pinned by a test), and the half of 1.11 that is a DNS
deployment gap rather than an application defect.

**1 approach abandoned mid-implementation** — answer-shape scoring in `bestWindow`,
which `retrieval.ts:103-109` records as already tried and measured useless.

Roughly two real defects per non-defect. Every fix was reproduced or proven before it
was written, and three carry tests that fail without the change.

---

## Phase 2 — complete

| # | Product | What changed |
|---|---|---|
| 2.1 | Canon | The last administrator of a collection cannot step down alone — hand the role on first. Test pins it. |
| 2.2 | Studio | Resetting a password confirms, naming both consequences: every session ends, and no mail is sent so you hand the new one over yourself |
| 2.3 | Studio | Studio home no longer 500s for anyone whose template was re-shared. Verified 500 → 200. |
| 2.4 | Registry | Granting Admin and enabling solo mode both confirm. Only in the widening direction — narrowing needs no ceremony. |
| 2.5 | Studio | Publish is disabled until the preflight lands, so the dialog can keep the rule it already states |

**Narrowed:** 2.1 is not permanent — `requirePermissionAdmin` has a documented
break-glass for "a collection whose last admin left" and the abilities mirror reports
it, so an org administrator can recover one. What was missing is anything stopping a
person walking into that state, and any way back for someone who is only a collection
admin. **2.5's second half does not reproduce**: the admin console's revoke button
already carries `disabled={busy || !impact}`.

---

## Phase 3 — read the backend first, and most of it dissolved

The plan said to check Registry's enforcement claims against the real service before
fixing them from what the demo does. Doing that changed the phase. The FastAPI backend
was read directly (it needs Python 3.12, pgvector and Redis to run; the source and its
tests answer the question without it).

| # | Claim | What the backend actually does |
|---|---|---|
| 3.1 | "The kill switch does not kill" — a quarantined agent kept answering in rooms while the catalog still showed Verified | **WITHDRAWN.** `agent_registry.py:181` raises `403 revoked — "This agent has been quarantined by its Registry"`, and rooms, MCP and Teams each return the canonical block notice for a quarantined agent (`rooms.py:10`, `mcp.py:189`, `teams_install.py:481`). The demo does not propagate. The product does. |
| 3.2 | The certification gate is unenforced — a reviewer self-verified with solo mode off | **WITHDRAWN.** `review._assert_distinct_reviewer` raises 403 when the reviewer is the owner or the author, and only `allow_self=True` lifts it. `test_review_self_verify.py` pins both halves. |
| 3.3 | A reviewer can mark a check Pass while the engine reports FAILED, and the UI says "all checks pass" | **CONFIRMED, and fixed.** `record_review` never read the engine's run at all — see below. |
| 3.4 | The audit log records none of it | **Narrowed, and real.** The events are recorded — but the whole service has only ten action names (`create`, `data_access`, `export`, `invoke`, `login`, `logout`, `mail_connect`, `register`, `state_change`, `update`). A role change, a quarantine and a connector grant all land as `state_change` or `export` with the specifics in `detail`, so the filter can never offer "Connector · granted" and an examiner cannot select the events they came for. Not "unaudited" — **indistinguishable**, which is a contract-shaped fix, not a logging one. |

**That is two more of the test's biggest findings withdrawn**, both from the same
cause: the Registry personas were judging a demo. It is also the strongest argument in
this document for finishing the demo-honesty work in Phase 1 — the fixture is what a
buyer, an auditor and a new employee actually meet.

**Still real, and still to do:** 3.5 Canon's agent `write` folding in
`approve`/`publish` (verified in `agentauth.ts` against `REGISTRY-CONTRACT.md:52`),
3.6 ungoverned Text components, 3.8 unaudited denials in Canon,
3.9 body-link leaks, 3.10 slug-walking before authorization, 3.11 session management.

### 3.11 — landed

Two halves, both real.

**A password floor the browser enforced and the server did not.** Self-serve register
and password-reset confirm both pin `min_length=8`, and the accept-invitation screen
tells the invitee "At least 8 characters" — but `AcceptInvitationRequest.password` was a
bare `str`. Anything posting straight at the endpoint could set a one-character
password, which put the weakest credential in a company on the path an admin uses to
add people. Now pinned to the same floor, with tests for the refusal, for the exactly-8
boundary, and for the invitation surviving a rejected attempt so the real link still
works. Login stays `min_length=1` on purpose: it checks a password, it does not create
one, and a floor there would leak which passwords are too short to be real. The field's
shape is unchanged, so `api.ts` still mirrors it.

**Sessions you could not see and could not end.** `revoke_session` had exactly one
caller — logout — which only ever ends the session making the request. Someone who
stayed signed in on a shared machine had no remedy short of an admin deactivating their
whole account. Added `GET /auth/sessions` and `POST /auth/sessions/revoke-others`, plus
**Account security → Where you're signed in**.

The `session` table records only `created_at`/`expires_at`, which cannot tell two
sessions apart — a list of three identical rows is not something anyone can act on.
Rather than restructure a frozen model, each entry recovers its origin from the audit
row that minted it: `audit.record` already folds the request's IP and user-agent into
every row, and login/register write `session_id` there. When that row is gone to
retention the fields come back null and the panel says *"We no longer have a record of
where this one started"* rather than printing "Unknown device" as though that were a
device. Eleven backend tests and eight component tests, including the ones that matter:
a revoked session actually stops authenticating, one person's revoke never touches
another's sessions, expired rows are never reported as signed in, and dismissing the
confirmation signs nobody out.

Deliberately *not* "sign out everywhere including here" — the act of securing an
account should not also log you out of the screen you are securing it from. Sign out
covers that one.

### 3.3 — landed

The tester was right, and the mechanism was simpler than the claim. `record_review`
never looked at the automated run. The engine and the checklist score two of the same
categories (`grounding_fidelity`, `security_probes`), so a reviewer could mark
`security_probes` pass while the engine's own run had failed it, and the report that
came out said pass with nothing recorded anywhere that a machine had disagreed. The
catalog badge, the certification built on it, and anyone reading the report months
later all saw a clean sign-off.

The fix is not a veto. The human is the authority and the engine is explicitly
advisory; blocking the override would be the wrong product. What was wrong is that the
override was invisible. Now:

- every human check carries the engine's verdict on the same category, when it scored
  one (`engine_result`);
- clearing a category the engine **failed** is recorded as an override on the report,
  with the reviewer's reason;
- an override with no written reason is refused (422) — your judgement stands, but it
  goes on the record;
- the certified report carries the overrides forward, so certification cannot launder a
  contested sign-off into a clean one;
- the reviewer meets the rule while deciding rather than as a 422 after committing: the
  checklist reads the same run the server reads, shows the engine's verdict inline,
  opens the note with *"Why is the automated failure not a real problem here?"*, and
  keeps both decision buttons disabled until it is answered;
- `ReportView` can no longer print the unqualified *"All checks passed — clear to
  verify"* over an override. It now says how many categories were passed over an
  automated failure, names them, and quotes the reason.

An engine `warn` the reviewer passes is deliberately **not** an override — a warning is
advisory, and treating a judgement call as a reversal would make the signal noise. The
engine's result is still shown either way.

Contract change (mirrored in the same commit, per the frozen-contract rule):
`VerificationCheck.engine_result` and `VerificationReport.overrides`, both optional. A
report with no engine run is byte-identical to what it was before, so existing stored
report hashes still reproduce — pinned by a test.

Backend 2209 passing (12 new), web 358 passing (8 new), 357 E2E passing (1 new, which
drives the whole override flow through the browser). `APP_DOCS` documents the
disagreement rule; v86.

### 3.4 — landed

The narrowing held: the events were never missing, they were unselectable and
unreadable. Every one of them is in `detail.event` — 184 distinct names across the
service — while `action` carries ten values total, so a role change, a quarantine and
a connector grant all arrive as `state_change` or `export`. The viewer's ACTION column
rendered the action, so it said *"State change"* about all three, and the filter offered
only those ten. A log that cannot say what happened is not the record the page claims it
is.

Three parts, no new action names and no rewritten rows — the chain commits to `action`,
and re-labelling history to fix a filter would be the wrong trade:

- **`GET /audit?event=…`** matches `detail.event` exactly, or a whole family when the
  value ends in a dot (`billing.`). An exact name is never treated as a prefix, so
  `agent.role` cannot quietly drag in `agent.roles_set` — a filter that silently widens
  is worse than one that finds nothing, because the extra rows look like an answer.
- **`GET /audit/events`** returns the event names present in *this org's* log with
  counts. Deliberately not a hardcoded list of every name the code can write: a menu of
  names that produced no rows here is a menu of dead ends, and one that has drifted from
  the code is worse. An empty catalogue means nothing of the kind has happened, which is
  itself an answer.
- **The column leads with the event** when a row has one, so the log reads as what
  happened rather than as which of ten buckets it fell into. Free-text search humanizes
  the event as well as the action, because the label a person copies out of the table
  has to find its own rows.

This also closed a demo divergence pointing the *other* way. The fixture hoisted a
wrapped `state_change` event up into the `action` token, so the demo's action dropdown
offered twenty specific names while the product's offers ten — the demo was showing a
vocabulary the product does not have, and the tester was partly reading that. The
fixture now carries the event exactly where the service puts it, and both paths render
the same thing.

Backend 2217 passing (8 new), web 366 (8 new), 358 E2E (1 new). `APP_DOCS` v87.

### 3.7 — landed, and one half narrowed

Three claims, checked separately.

**"A builder can send company data outward from an unpublished draft with no
approval" — true.** `app/api/gateway/route.ts` runs `trigger` and `rowtrigger` under
`mode: "draft"` with no restriction, and a row action carries a real record snapshot.
The signed body, the audit row and the delivery log were byte-for-byte what an approved,
published app produces, so a receiving system that pages an on-call engineer or opens a
ticket could not tell a builder's test from the real thing, and neither could an admin
reading the log.

Blocking drafts outright would be the wrong fix — a button a builder cannot test is a
button they publish blind. So the rule is narrower and says what it is: a draft delivery
is **marked** in the signed payload, the audit event and the delivery log, and a draft
may not carry anything above `internal` out of the company. The refusal names the actual
rule and the way forward (publish it) rather than pointing at a connection clearance
that was never the problem — and an ordinary egress refusal is *not* relabelled as a
draft one, which a test pins, because a draft-shaped message there would send someone to
publish an app that would still be refused.

**"Destination invisible" — true, and a one-line cause.** The admin console rendered
`{c.description || c.url}`. Every real and seeded connection has a description, so the
one screen where an admin governs egress showed the blurb the *builder* reads and never
said where the data actually goes. Both are shown now. (The copy above it — "Builders
never see URLs or secrets" — is correct and stays; the admin is not the builder.)

**"Failed deliveries record no actor" — true.** `by: user.name` was on the `delivered`
row only. The failed, blocked and denied rows — the set anyone investigating opens first
— were anonymous, and the component's own comment described the asymmetry as though it
were a design. Every row now carries the person, their id, and the control they pressed,
whatever the outcome.

**"…and cannot be retried" — narrowed, deliberately not fixed.** A retry needs the
payload, and the payload is deliberately never stored: the delivery log keeps a body
hash and a field-name list precisely so it is "enough to prove an archived payload is the
one this row describes, and useless for reconstructing it". Adding a replay button means
storing what left the building in a second place, which trades a real confidentiality
property for a convenience. Instead the failed row now names the person and the component
so a re-send is a deliberate human act. Recorded here rather than silently skipped.

Studio 1671 passing (8 new), registry 351, canon 127, guards 108, shell 18.

This is also the phase's unblocking: standing the backend up locally (Python 3.12 venv,
Postgres 16 + pgvector, `alembic upgrade head`) makes the whole suite runnable —
2197 passing, and the previously-skipped live tests now actually run. **3.3 is no longer
blocked.**

The 50 individual tester reports, with reproduction steps and evidence, are the backing
detail for every row above.
