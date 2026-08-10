# Round seven — what sixteen people found

Sixteen testers were handed a running Canon, seeded with 293 pages across five
collections, and asked to do a real job with it. Each drove the product in a real
browser. None was told what to find.

They cover the roles Canon is built for: a first-time contributor, a compliance
director working her approval queue, a clinician relying on Ask, an external auditor,
a member-services rep under time pressure, a knowledge steward, a migration engineer,
a curious employee probing a restricted collection, a policy owner reading version
history, a subject-matter reviewer, the engineer responsible for agent contribution, a
field nurse on a phone, a collection administrator, a blind compliance analyst, a
browse-only claims processor, and a skeptical evaluator deciding whether to adopt.

**Verdicts: 2 BLOCKED, 14 WORKS WITH FRICTION, 0 clean.**

Unlike the Registry round, **Canon ran for real** — its own server against SQLite, with
the seeded corpus. What testers observed is the product, not a demo. Two testers read
server source to establish root causes; one stood up `registry-stub` and a second Canon
process to exercise the Agent Passport path end to end.

---

## The headline: Canon tells a reader a contested page is uncontested

Tester 49, a claims processor, opened the canonical page **Data Retention in the
Platform** and read:

> "The record does not hold a conflict or a supersession for this page."

The identical URL, opened by a collection administrator, reads:

> **CONFLICTS WITH — Records Retention Schedule** · CANONICAL · Asserted by Dana Whitfield

Verified directly against the API: `GET /pages/<id>/relations` returns the
`conflicts_with` edge — carrying the note *"The schedule keeps claims records for
seven years; the platform spec describes a deletion job that runs at twenty-four
months. One of the two is wrong, and Compliance owns which."* — for the administrator,
and `[]` for the claims processor.

**An empty relations array is rendered as a positive assertion.** A permission-scoped
absence becomes a factual claim of absence. By Canon's own severity taxonomy this is
Tier 1: the record says something untrue, on the exact question the reader came to
answer, about a page whose two candidate answers are seven years and twenty-four
months.

The fix already exists elsewhere in the product. The same reader's `#/ask` session gets
it right:

> "One of the pages below is contested in the record, and this answer quotes only its
> side of it"

— with a `contested` chip, and **without naming the page he cannot see.** The
permission-aware sentence is written and shipping. The page view prints its opposite.

It compounds twice: `#/queue` tells the **owner of the conflicted page** "No conflict
has been asserted against a page you own", and `#/map` reports `Conflicts with 0`.

Only the author's hand-written paragraph — *"Where this disagrees with the schedule…
One of the two is wrong"* — stopped the tester acting on 24 months as settled fact. A
human's prose saved the record where the machinery misreported it.

## Absent, forbidden, and empty are all rendered as "nothing"

This is the same defect in four places, and it is Canon's most consequential pattern.

**Search (23).** A rep with a member on the phone searched for the appeals deadline.
The answer exists — `Appeals turnaround standards`, CANONICAL, "first level… 30
calendar days", whose alias field literally reads *"appeal clocks, appeal deadlines,
turnaround times for appeals"*. It lives in a collection she has no role in. Search
said **"Nothing in the record matches."** Ask said **"The record does not answer this
yet."** She would have told a member the company has no appeals policy.

Canon *has* the right sentence — deep-linking by hand produces *"This needs the view
role on Member Benefits; you hold none there."* It never appears where she was looking.

**Ask (12, 50).** Two testers independently found Ask asserting answers it does not
have. Reproduced directly:

> **Q:** "How quickly must an expedited claim be decided?"
> **Cited excerpt:** "An expedited claim, where delay would jeopardise the member's
> health,…"
> **The page's actual sentence:** "An **expedited** claim, where delay would jeopardise
> the member's health, **is decided within seventy-two hours.**"

The snippet window closes one clause before the number, and the result is labelled
`ANSWER`. Tester 50 confirmed the mechanism: **the refusal threshold is topical
overlap, not a responsive span.** *"What is the standard timeframe for a prior
authorisation decision?"* returns `ANSWER — drawn from 3 Canonical pages` over three
excerpts containing no timeframe.

For a clinician this is worse than a refusal, because confident framing discourages
looking further.

**Restricted content (26).** Asked an HR question every employee has, an ordinary
employee got "The record does not answer this yet." That is false for the record and
true only for his permissions — "it teaches people the record is empty when it is
actually locked."

**Loading and empty states.** `Admin`-style "nothing here" strings render while data is
still arriving, across several surfaces.

**One recommendation covers all four**, and it is the change tester 50 named as the
single thing that would most increase confidence:

> Require an answer to rest on a responsive extracted span, highlight it, and otherwise
> refuse with "these Canonical pages are about this subject; none of them states one" —
> the distinction between a missing page and a silent canonical page.

Extend the same discipline to search and to permission-scoped absence: *"2 results are
in collections you cannot see — request access."*

## Provenance: the artifacts built to prove separation of duties report it backwards

Four testers, four roles, one root cause. Tester 43 reproduced it from scratch:

> I approved `Eligibility and Enrolment` and never opened the editor. Version History,
> the page header, the compare column header and the downloaded attestation JSON all
> name **me** as author of v2. The audit log correctly shows Priya Raman did
> `draft.start`/`page.submit` and I did only `page.approve`/`page.publish`.

Their framing is the one to act on:

> **Canon *enforces* author ≠ approver in workflow — it blocked me with "an approver
> cannot submit their own draft for review" — then *reports* author = approver in the
> artifact meant to prove separation of duties.**

It has already corrupted the record: a page now permanently carries the version note
*"no baseline diff was available; body is identical to published v1"* on a version that
added four lines — written by the approve pane's false "no baseline" claim while
`#/compare/1/2` renders **"4 changed lines"** for the same pair. The confirm dialog's
**"Show me the changes"** button is dead; it closes the dialog and destroys the Note
field.

The auditor (13) hit the same bug as a separation-of-duties failure: she is the named
approver on 5 of the 10 canonical marks she was auditing, and has Edit/Archive controls
on canonical pages. (Correction: those controls are correctly disabled for view-only
users — `aria-disabled="true" class="btn is-refused"` with a reason naming who holds
the role. An earlier text-only scrape reported them as available; that finding is
withdrawn.)

## Agent co-authorship: undemonstrable as shipped, and unbounded when enabled

Canon's headline claim is that people and approved agents keep one record together.

**As deployed, the door does not exist.** `CANON_REGISTRY_URL` is unset, so every
passport gets a 503 naming an environment variable, and all 16 seeded actors are
`kind: person`. Tester 45 stood up `registry-stub` and a second Canon process against
the same database to exercise the real contract.

**The passport door itself is good.** Uncertified → 403 `certification_lapsed`. Registry
permits a collection but Canon membership is empty → correct empty intersection.
Registry killed → 503 `registry_unreachable`, **fails closed**. Nine boundary probes,
nine correct refusals with the contract's exact reason codes. **Revocation cut access in
3 seconds.**

**The blocker is a permission-vocabulary gap.** `agentauth.ts` maps this route:

```
pattern: /^\/pages\/([^/]+)\/(?:move|archive|publish|submit|approve|send-back|withdraw|restore)$/,
action: 'write',
```

`approve` and `publish` sit in the same bucket as `move` and `submit`. And
`REGISTRY-CONTRACT.md:52` fixes the vocabulary at **three** actions — `read`, `comment`,
`write` — with no `approve`. **There is no grant an administrator can issue that lets an
agent draft but not make something canonical.** A certified agent with ordinary `write`
granted the Canonical mark to a policy a person wrote; the badge then reads "This is the
official record: you may rely on it and quote it."

Canon guards actor kind elsewhere — agents cannot assert relations or accept proposals,
reasoning that *"publishing what it proposed is a person's act."* The one act it does not
guard is the one that stamps the record. **This is a contract-level fix, not a patch.**

Two more: **the proposals feature — the entire designed-safe path for agent
co-authorship — has no UI** (`"proposal"` appears in `app.js` four times, all
notification labels). And the `[agent]` tag is present on Owner/Approver/comments/audit
but **missing from the Version byline, "Submitted by…", notification bodies and `/ask`
citations** — present where an auditor looks, absent from every line a busy reader
reads.

Finally, the claim measured against its own corpus (50): **87 Canonical + 27 Needs
Update out of 291 pages — 61% of the record is readable by people and structurally
invisible to agents.** Canon's pitch is "no gap between what people know and what agents
can use." On the seed corpus, the gap is most of the record.

## Access control: the strongest enforcement result, with one leak and one mislabel

Tester 26 probed the restricted collection hard, and **every direct route refused
server-side**: the collection, its `/tree`, `/members`, `/attestation`, `/map`,
`#/ask/<id>`, and four page deep-links harvested from an administrator's session.
Search returns nothing for `parental leave`, `overtime`, `handbook`. Ask refuses where
the administrator gets grounded answers citing three restricted pages. The map shows 54
nodes with zero restricted titles. The audit log and its CSV export are both scoped (226
events vs 1,355). Forcing the "Answer from" select to the restricted UUID lands on the
no-access screen.

**The one leak: page bodies render unfiltered.** A hand-written "Related" list on an
Engineering page exposes a live link to a canonical page in the restricted collection,
and the title comes back in a search snippet and inside an Ask answer's quoted
paragraph. The *structured* relations panel and the map both filter correctly. Walking
all 54 Engineering pages: 5 cross-collection links, 1 into the restricted collection.
Tester 47 reproduced it on a newly created restricted collection — nothing warns at
publish time that you are exposing a title.

**"Restricted" does not restrict (47).** A restricted and an unrestricted collection are
*identically* invisible to non-members — **membership is the entire access control.** The
checkbox does two things, neither stated in the UI: it adds `page.view` audit rows
(verified) and it blocks external-model egress. The only helper text a department head
sees is "page views are recorded in the audit log."

**Refused access is never audited (26).** Five 403s produced zero rows in a log that
advertises recording "every … view of restricted material." Denials are what an examiner
asks for.

## One click destroys a collection permanently (47)

Removing your own membership as sole admin — **one unconfirmed click, no dialog, no
undo** — orphans the collection. **Dana Whitfield, who administers every collection, also
gets "No access."** There is no archive and no delete, so it is stranded with a live
policy page inside it. Recovery required hand-crafting `PUT /collections/…/members/…`
with an admin header, a route no UI offers. Two collections and two published pages are
now permanently stuck on the test server.

Registry guards exactly this case ("You can't remove your own Admin role."). Canon does
not. Restriction also cannot be changed after creation — no settings screen, no
`PATCH`/`PUT` route — so a mis-set flag is permanent.

## The back-channel between author, reviewer and approver does not work

**A plain comment notifies nobody (11, 44).** Verified by signing in as the author and
the named approver: no queue row, no count, no notice.

**@mention only accepts a raw UUID (44).** `@Nadia Haddad` notified nobody; the UUID
did. The regex matches actor ids. No picker, no hint, no confirmation of who was
notified.

**Canon promises a feature it does not ship (44).** The send-back banner states verbatim:
*"It is on the page as a comment too, where it can be replied to and resolved."* There is
no reply control and no resolve control — yet `POST /comments/:id/resolve` and `/reopen`
exist in `api.ts:288-289`, the table has `resolved_at`/`resolved_by`, and the client
computes a `resolved` CSS class it can never set.

**Consequence, driven end to end (44):** a reviewer's objection — *"please do not approve
this until the backup-tape exception is written in"* — stayed open while the approver
published as Canonical, body byte-identical to what was objected to. The Approve dialog
never mentions comments.

**The author loses sight of her own work (10).** After submitting: *"You have no drafts
in progress."* There is an inbox for approvers and nothing for "submitted by you, waiting
on someone else." Hers landed 15th of 15 with no note, no nudge, and no mail relay
configured.

**Rejection, by contrast, works beautifully (11)** — it requires a reason, states its
consequences precisely, and lands in the author's queue, notices and page thread.

## Stewardship is split across roles that cannot reach each other (24)

`#/gaps` is **operator-only** — no collection role opens it, not even `admin` on the
collection. The refusal is well written (*"Administering one collection is not the same
thing"*), but the person whose job is record health cannot see the record's holes.

Worse, **the gaps list and the fix live with different people.** The operator sees
questions Ask refused, with no assign, no "write the missing page", and no collection
filter — while the prescribed remedy is the "Also known as" alias field, which lives in
the *steward's* editor. That directly explains tester 23's blocked rep: her query failed
on aliases, and the person who could add them cannot see that it failed.

**The map earns its place** — it surfaced all three seeded contradictions in about a
minute. But conflicts reach readers on **two of four surfaces**: the page banner and the
Ask answer are excellent; search results and the collection contents table show a
contested page as a plain `CANONICAL` row (the collection page contains zero occurrences
of "contest", "conflict" or "supersed").

**Supersession misleads at the moment of arrival (43).** The retired page's banner is
excellent, but every surface a reader arrives *from* shows it as a plain `DRAFT` chip
with no supersession marker and never names the replacement — and the replacement is
`IN REVIEW`, which Ask never uses. **The subject has no canonical answer, and the banner
makes it look filled.**

## Migration (25)

**There is no import UI at all** — verified as both member and administrator.
`GET /imports`, `GET /imports/:id` and `POST /imports` exist server-side (reading runs
works at `view` level), and nothing renders them.

The one failed import is discoverable only via `#/audit` filtered to `import.page`:
*"File: Vendor+Contacts_41007.html · Outcome: failed · Because: no readable content: the
file parsed to an empty document."* No badge, no count, no link to the run, **no retry
for anyone**. The message is also misleading — the file is a *truncated* export ending
inside an unclosed HTML comment.

The quiet finding that matters most: **all 9 imported pages landed with `Owner —,
Approver —, Review due —`** — in nobody's queue. A migration silently produces unowned
canonical content, which is how a source of record decays.

**Staleness, by contrast, is the best honesty in the suite** — rendered where the number
would be, to an ordinary reader:

> "Not an empty value — Canon has no cached answer and will not invent one"
> "LAST KNOWN GOOD — …it may have changed since"

But a canonical page **publishes different numbers to different readers with no marker**
(50): `turnaroundDays` reads `12` for one person and `Not resolved` for three others,
same page, same version.

## Phone and keyboard

Tester 46 confirmed Canon's stylesheet contains **zero `@media (pointer: coarse)` rules**
in 2,337 lines — there is no touch layer, so the numbers are method-independent.

- **The header search box computes to 15px** — iOS zooms on focus while searching
  one-handed. Root cause `body{font-size:15px}` + `label{font-size:0.9rem}` with
  `font: inherit`. Only the `#/ask` textarea (17.92px) clears 16px.
- **No prefix matching** — `eligib` → nothing, `eligibility` → 10; `appea` → nothing,
  `appeal` → 12. Confirmed in `server/src/search.ts::toMatchQuery`, which quotes each
  term with no `*`. With tester 23's findings (no typo tolerance, no acronyms, Enter does
  nothing, no results page, 12-item dropdown cap) Canon's findability has three
  independent confirmations and a clear root cause.
- **The sticky header takes 249px of a 664px viewport (37.5%)**, still pinned after
  scrolling 1238px, slicing the table header off the content beneath.
- Wide tables are correctly wrapped — `document.scrollWidth` stays exactly 390 on every
  route but `#/map` List view.

Tester 48, keyboard-only — Canon is worse than Registry on all three shared defects:

- **Silent route changes.** `document.title` never reassigned (`grep "document.title"
  app.js` → no matches); all 9 routes announce "Veryl Canon"; instrumented
  MutationObservers recorded **zero** live-region announcements across navigations.
- **No `aria-current` at all** (Registry had a wrong one). Current page is `class="active"`
  and a background colour.
- **Focus ring contrast 1.08:1** (`outline: 2px solid var(--accent-soft)`), and
  `.ask-question:focus { outline: none }` removes it entirely on the Ask textarea.
- **The modal has no focus trap, no Escape, no focus restore** (`app.js:588 openModal`) —
  Tab escapes on the 5th stop into a page `aria-modal="true"` has hidden from AT.
- **85 tab stops** from header to main column on a collection page, no skip link, worsened
  by `<a>` nested inside `<summary>` (`app.js:1838`) doubling every branch node.

Credit: **page standing is real text everywhere, never colour-only** —
`<dl><dt>Status</dt><dd>Canonical</dd></dl>`, `aria-label="My queue, 2 waiting"`, a working
polite live region on `#ask-result`, all 58 map nodes carrying `aria-label` and `<title>`.
Canon's *content* is accessible; its *shell* is not.

---

## What holds up, stated plainly

Testers were told to credit what works, and this list is theirs, not marketing's.

- **The store really is one store (50).** Publish, approve and archive hit search and Ask
  in the same second. No stale index anywhere.
- **The hash chain is real.** Two testers independently recomputed attested hashes by hand
  from the CSV plus the published recipe — exact matches, 10/10 and 4/4.
- **Conflict handling at question time is the best thing in the product.** Four testers
  said so independently: *"TWO ANSWERS — The record gives two answers here, and they
  differ"*, quoting the human who filed the conflict and refusing to choose.
- **Draft vs canonical is genuinely enforced, not just labelled (10).** Ask refuses
  in-review pages; search explains why unpublished bodies are not indexed. The Publish
  dialog: *"Publishing is not review, and it grants no standing… Submit for review is the
  other road."*
- **Access enforcement is server-side and comprehensive (26).**
- **Canon cannot hallucinate (12)** — it emits only quoted excerpts, and resisted every
  jailbreak attempt (draft-bypass, "give me a yes/no on my patient", "write me a denial
  letter").
- **Vocabulary is taught by consequence, not definition (49).** Draft: *"should not be
  cited as policy"*. Needs Update: *"still the official record and can still be cited"*.
- **Refused controls are exemplary (47).** Greyed with *"11 of these controls are greyed
  out. Why?"* and tooltips naming who holds the role.
- **Canon volunteers the attack that defeats its own chain (13),** and ships 12 numbered
  self-disclosed limits. The single place it asserts without evidence is the word
  **"Append-only."** at the top of the audit page.

## What would make it better

1. **Never render a permission-scoped absence as a factual absence.** The conflict banner,
   search, Ask and the queue all do it; the correct sentence already exists in Ask.
2. **Require a responsive span before labelling something an ANSWER**, and highlight it.
3. **Fix the AUTHOR field in Version History, the page header, compare and attestation** —
   one display bug sitting in every provenance artifact Canon produces.
4. **Make the approve pane show the diff it can already compute**, and fix "Show me the
   changes".
5. **Split `approve`/`publish` out of the agent `write` action** in `REGISTRY-CONTRACT.md`
   and `agentauth.ts`.
6. **Guard sole-admin self-removal, and add archive/delete plus editable restriction.**
7. **Ship reply and resolve on comments** — the server already has them — and make
   @mention accept a person, not a UUID.
8. **Give the author a "waiting on someone else" view, and notify on comment.**
9. **Show contested and superseded state in search results and collection tables.**
10. **Search: prefix matching, typo tolerance, acronyms, a results page, Enter.**
11. **Filter body-rendered links by permission at render time**, and warn at publish time.
12. **Build an import UI** — dry-run, failure list, retry — and give imported pages an owner.
13. **Audit refused access.**
14. **Raise the search box to 16px; add focus trap, route announcements, `aria-current`,
    and a legible focus ring.**

## What they wish it could do

- **Effective-dated retrieval (50, 43).** *"What did the policy say on 14 March, when we
  denied this claim?"* — the only question litigation and CMS audits care about. Version
  history exists; Ask has no as-at.
- **Jurisdiction and plan scoping (50).** "The appeals deadline" has one answer in a flat
  namespace — so with real content, TWO ANSWERS will fire on every question forever,
  because two numbers are both correct for different plans.
- **Warn me at publish time that I am about to create a second answer (10).** *"For a
  policy record, 'you may be about to publish a second answer to the same question' is the
  single most valuable thing it could say."*
- **A conflict inbox that belongs to somebody (50).** Ask detects disagreements on the
  reader's screen, addressed to nobody. Nobody is ever handed the sentence "these two
  canonical pages disagree; decide."
- **Coverage against an obligations list (50, 24).** Gaps only learns from questions people
  happen to ask, so the least-asked-about obligations stay invisible. Structural gaps — a
  Canonical policy whose child specs are all Draft — are not computed, though the map has
  the graph to do it.
- **A quotable one-liner for the phone (23).** *"You have 30 calendar days from the date of
  the denial letter"* — the sentence, the page, the status badge, a copy button. "That
  would be the whole product for her role."
- **Tell me which pages bind *my* job (49).** A "who this applies to" field, filterable —
  six pages instead of 54. And a desk view of the ten rules she uses, with the numbers on
  the front.
- **Per-page visibility (26, 47).** Canon's only granularity is the whole collection, so the
  safe choice is to lock all 32 HR pages and leave employees with no route to their own
  handbook — and the incentive to shard collections is exactly what produced the title leak.
- **A request-access button on the refusal (26, 47).** The wall already names who holds the
  role; it should be able to ask for them. Administrators have no inbox of requests either.
- **"View as this person" (47).** Canon computes it on every request; there is no way to
  look at it. "It would have caught my body-link leak in one click."
- **Tell people when their access changes (47).** Both events are already in the audit log.
  "The difference between administration and things silently happening to people."
- **Watch/subscribe (43, 46, 49).** Nothing tells you a policy you quote daily went NEEDS
  UPDATE or picked up a conflict.
- **Bulk anything (50, 11, 48).** 155 drafts across five collections; no filter, no sort, no
  bulk assignment, no "everything canonical with no review date", no "everything owned by
  someone who left". Four Needs-Update renewals are one decision, not four round-trips.
- **Migration tooling (25).** Dry run, reconciliation against an export manifest, attachment
  and image accounting (`<img>` becomes a link to the export path — a page can silently lose
  every diagram), rollback, scheduled re-import, and an alert when a source stops answering.
- **Anchor the chain outside Canon (13).** The manifest is honest that self-anchoring "is
  inside Canon's own trust boundary and is not evidence on its own". Ship a sink an auditor
  can subscribe to.
- **A read-only role (50, 13).** External auditors are the main audience for attestation
  bundles, and every available role puts Edit and Archive on a canonical policy.
- **Bound agents by time and volume, not just collection (45).** "At most N proposals a
  day", "only pages it owns", "expires in 30 days" — the shapes an agent-safety review asks
  for. Plus a per-agent activity view: "what did ClauseBot try and get refused?"
- **Offline and pinned pages (46).** "Hospital corridors and lift lobbies have no signal."

---

## Shared-state changes and housekeeping

Testers disclosed what they altered on the shared record: one page left at DRAFT after a
restore, one throwaway page archived, one probe page created and archived, two Gaps
entries left open deliberately, and — per the sole-admin lockout above — two collections
and two pages that **cannot be removed through the product**.

## What this round did not test

Real OIDC sign-in (the server ran with `CANON_DEV_AUTH=true`, which it discloses in the
UI), a live Registry, embeddings with a real model, backup/restore, or performance under
load. Where testers read server source they said so.
