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

1. **Canon: does a reader learn that something exists they cannot see?** Ask discloses
   contested-ness without naming the page; the relations panel deliberately discloses
   nothing (`relations.ts:89-92` and a test pinning it); search says "Nothing in the
   record matches" where a permission-scoped hit exists. Two surfaces, opposite
   policies. Testers argued the disclosing one is more honest — *"it teaches people the
   record is empty when it is actually locked"* — but that is a security decision.
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
| 3.3 | A reviewer can mark a check Pass while the engine reports FAILED, and the UI says "all checks pass" | **Open, needs the running backend.** Whether the server validates the checklist against the engine verdict was not established by reading alone. |
| 3.4 | The audit log records none of it | **Narrowed, and real.** The events are recorded — but the whole service has only ten action names (`create`, `data_access`, `export`, `invoke`, `login`, `logout`, `mail_connect`, `register`, `state_change`, `update`). A role change, a quarantine and a connector grant all land as `state_change` or `export` with the specifics in `detail`, so the filter can never offer "Connector · granted" and an examiner cannot select the events they came for. Not "unaudited" — **indistinguishable**, which is a contract-shaped fix, not a logging one. |

**That is two more of the test's biggest findings withdrawn**, both from the same
cause: the Registry personas were judging a demo. It is also the strongest argument in
this document for finishing the demo-honesty work in Phase 1 — the fixture is what a
buyer, an auditor and a new employee actually meet.

**Still real, and still to do:** 3.5 Canon's agent `write` folding in
`approve`/`publish` (verified in `agentauth.ts` against `REGISTRY-CONTRACT.md:52`),
3.6 ungoverned Text components, 3.7 unapproved egress, 3.8 unaudited denials in Canon,
3.9 body-link leaks, 3.10 slug-walking before authorization, 3.11 session management.

The 50 individual tester reports, with reproduction steps and evidence, are the backing
detail for every row above.
