# What five users found

Five people were given a running Canon — the seeded demo corpus, a browser, and
the parts of the documentation their role would actually be handed — and asked
to do their real job with it. None of them could read `server/src/`, the tests,
or the design documents. They found the product the way a design partner will.

| Who | Role | What they were given |
| --- | --- | --- |
| Priya | New contributor, non-technical | The UI, nothing else |
| Marcus | Director of Compliance, ~40 policies, an approver | The UI, nothing else |
| Ruth | External auditor, document-control review | The UI and the evidence bundles |
| Sam | Integrator building on the Knowledge API | REGISTRY-CONTRACT.md and STUDIO-CONTRACT.md |
| Ade | Administrator deploying Canon | OPERATIONS.md, CONFIGURATION.md, SECURITY.md |

This file is the synthesis. A finding is listed once, with everyone who found
it, because the same defect seen from three directions is a different kind of
evidence than one person's opinion. "Verified" means it was reproduced against
a running server or located in the source afterwards, not taken on trust.

## What all five valued, and what we must not trade away

Every one of them, unprompted, named something in the same small set. It is
worth writing down, because the list of defects below is long and none of it
touches this:

* **Attestations name their exclusions.** The collection register lists the 16
  Canonical pages *and the 34 that are not*, by name, with an explicit
  `truncated` field. Marcus: "That's the difference between a document that
  reassures me and one I can defend. I'd have paid for it on its own." Ruth
  accepted the bundles as evidence her partner would take.
* **Point-in-time refuses to guess.** "This page did not exist… Canon answers
  with nothing rather than with the nearest version, because the nearest
  version is an answer to a different question." Ruth: better reasoning about
  evidence than most audit software manages.
* **An administrator cannot approve.** `403 Only the named approver can grant
  the Canonical mark`, to a user with full admin rights. Ruth called genuine
  separation of duty rare in this class of product.
* **The chain is written by a database trigger**, append-only is enforced at
  the storage layer, and the verification recipe is published well enough that
  Ruth recomputed every hash with her own script and no Canon code. It verified.
* **We document the attack that defeats our own control**, in the artefact, in
  plain language. Ruth tested that disclosure in both directions and found it
  exactly accurate.
* **Needs Update explains itself in plain English.** Priya: the only status in
  the product that does, "and it does it beautifully".
* **Contradiction is surfaced at all.** Sam called it the best thing in the
  product. Priya called the conflict panel the best feature — and then found it
  has no ending.

Priya's closing sentence is the fairest summary of where we are: *"Not yet —
Confluence lets me write a table, ask a question on the page, and find what I
wrote five minutes ago, and Canon lets me do none of those three — but I would
fight to keep the part of Canon that tells me a page is past its review date
and that two official pages contradict each other, because our Confluence has
been quietly lying to me about both for years."*

## Findings, in the order we should fix them

### Tier 1 — Canon says something untrue

These are not polish. Each one makes the product state, in its own voice, a
thing that is not so. That is the single failure this product exists to
prevent, and everything else waits.

**T1.1 · The CANONICAL badge is structurally always wrong on an answer's
source cards.** *(Priya bug A, Marcus task 4; verified in source.)*
`app.js` renders `badge(c.status ?? 'canonical')` and the `Citation` shape
carries no `status` — so it is always undefined and always prints CANONICAL.
Priya watched a card badge "Records and Retention — CANONICAL" beside an answer
whose own prose said that page was past review, on a page that is NEEDS UPDATE.
The most trust-critical surface in the product, wrong by construction.
**Fixed.** `Citation` carries `status`, populated from the passage's real page
status wherever a citation is built, and the client draws no badge it was not
given — absent means *this response cannot say*, never *canonical*. The same
guess was found in two more places and closed: a version's badge showed the
page's status *today*, so v1 of a since-approved page read CANONICAL although
nobody ever approved that version; a superseded version now reads `superseded`
and carries no status badge, because status is a column on `pages`, not a field
on a version, and the standing a superseded version held is a range rather than
a value — point-in-time is the attestation's question and it answers it
properly. The regression test lifts the render function out of the shipped
`app.js` and asserts no `?? 'canonical'` default survives anywhere in the file.

**T1.2 · Ask does not know about conflicts the record has already recorded.**
*(Marcus task 4, Priya; verified in source.)* `answers.ts` contains no
reference to `relations` or `divergence`. Contradiction awareness is
text-inference only, so the two places where a conflict is stored as *data* —
a person's asserted `conflicts_with` relation and a source divergence — are
invisible to the answer path. Marcus watched Ask cite both sides of a conflict
a human had explicitly asserted, in one answer, without mentioning it. Structure
over prose, in the one place we were doing the opposite.
**Fixed.** `detectDisagreement` now takes the asserted conflicts over the pages
being cited — still pure, still directly testable, with the record lookup in a
separate injectable seam — and reports an asserted conflict whether or not the
text gives the quantity and polarity checks anything to find. The note
attributes it: who asserted it, when, and their words verbatim.
`disagreement.asserted` carries the same machine-readably and is *absent* when
Canon inferred the conflict, because a person's assertion and a lexical match
are not equivalent evidence. `supersession` and `sourceDisagreement` are
siblings rather than more `disagreement` — a supersession has already been
settled by a person, and a source divergence is one page against two external
systems with no second page to quote. Both ends of a relation must be cited for
it to be reported: Canon quotes what it warns about, and the alternative leaks
the existence of pages the asker may not see. The generator seam is unchanged
where it matters — all three findings go in as advisories and none can come
back out.

**T1.3 · The approver named on a page in review is the wrong person, or
nobody.** *(Ruth #14, Priya bug C, Marcus.)* The page header reads the
page-level approver while the Approve control reads the draft's. Ruth saw a
screen naming Grace Abara as approver, with a banner "Waiting on the named
approver, Grace Abara" and a green Approve button — Grace got a 403, and Nadia
Haddad, named nowhere on that screen, approved it. On brand-new pages Priya got
"Waiting on the named approver, —" with owner, approver and both dates all
blank. Ruth: an auditor sampling approvals from the page header would record
the wrong approver. **Fixed.** The server was already right and stayed right:
`approve` enforces the DRAFT's approver, because approving is what publishes
that draft, and enforcing the page row would publish a version naming one
person and approved by another. The defect was in the naming, so there is now
one answer for every surface to ask — `CanonStore.reviewState`, carried inside
`GET /pages/:id` as `review` and readable with `view`, so a reader without the
page lock still sees the right name. The invariant is written above the review
workflow in `store.ts`: *the approver named on any surface is the approver
`approve` will accept, and nobody else.* The header keeps showing what the page
published — history stays historical — with the pending approver named beside
it rather than in place of it, and Approve is offered only to the person the
server will accept. A page that has never published has no history to protect,
so it shows the draft's four fields marked `· proposed` instead of four dashes.
Verified against a running server.

**T1.4 · "Stale knowledge announces itself" is not true of a default
deployment.** *(Ruth #13, Marcus task 3.)* The freshness sweep runs only when
something calls `POST /maintenance/freshness`. Ruth pushed a policy to
Canonical with a review date of 2020-01-01 and it sits at CANONICAL with no
warning, cited by Ask as current. Marcus found all 19 sweep events in the demo
corpus share one timestamp — the instant the corpus was built — and are
attributed to Dana Whitfield, a real person who did not do it. The server warns
about this at start-up, in a log line the policy author never sees.
**Fixed.** The sweep now runs on every deployment — hourly, plus one pass at
start-up before the port is bound — as `system:canon`, a third `ActorKind` that
cannot be signed in as, granted a role, or created a second time (`system.ts`).
`CANON_MAINTENANCE_ACTOR_ID` still works if a deployment deliberately sets it,
and now warns that it puts a name on the clock's work. `GET
/maintenance/freshness` reports what this deployment actually does, and the
editor says that instead of a general promise; a Canonical page past its review
date warns on its own face whether or not the sweep has reached it. The demo
seeder sweeps as Canon and states that its whole history is one build pass.
Notifications were narrowed rather than made true — see server/README.md.
Verified against a running server: a Canonical policy dated 2020-01-01, on a
deployment with only `CANON_DEV_AUTH=true` set, is Needs Update after a restart,
and its audit event reads `Canon SYSTEM`.

**T1.5 · `effectiveDate` is unvalidated free text.** *(Ruth #2.)* She set a
canonical clinical policy to take effect seven years before the record existed;
accepted silently, displayed as EFFECTIVE DATE January 1, 2019, and printed in
the attestation beside a creation date that contradicts it, unreconciled.
Across the corpus's 16 canonical clinical policies, 10 have effective dates
preceding first publication and 6 have none at all — so her forgery is
indistinguishable from the legitimate ones. This is the field a regulator asks
about first. **Fixed** in `effectivedate.ts`, and deliberately NOT by refusing
backdating: a policy that took effect in 2019 and was migrated in 2026 is the
ordinary case, and refusing it would teach people to type today's date. The
shape is checked (a real ISO date, no slipped century in either direction, and
"effective from 2099" refused as a commitment nobody can keep); a Policy must
now state an effective date before it publishes, which is a rule about the act
of publishing and leaves every page already in the record valid; and a date
earlier than the page's own first publication must carry an
`effectiveDateBasis` — a versioned, attributed structured field naming the
committee minute, prior system or import run it rests on. Backdating is then
*surfaced*, not silenced: the attestation reconciles it against the creation
date it contradicts and says whether a basis was recorded, and
`collectionHealth` counts `canonicalWithoutEffectiveDate`,
`backdatedEffectiveDate` and `backdatedWithoutBasis`, each openable as a query.
Canon records a basis and cannot verify one, and every bundle says so. Verified
against a running server.

**T1.6 · Malformed input crashed the API, and one case answered falsely.**
*(Sam; reproduced independently.)* `{"question": 42}`, `{"question":{"$ne":
null}}` and an array `collectionId` each returned 500 with a correlation id;
`{"collectionId": 12}` returned 200 and "the record is silent on this" — a
confident false statement produced by a typo. **Fixed** in `input.ts`: bodies
and fields are type-checked, nothing is coerced, and the message names the
field. Verified against a running server.

### Tier 2 — the two surfaces that are missing entirely

**T2.1 · There is no queue, no inbox, no "mine".** *(Marcus task 1, Priya.)*
Marcus found his 25 pending approvals by walking five collection sidebars,
eyeballing 44 badges, and opening every one of those 44 pages to read the
Approver field, which the sidebar does not show. Asked whether he believed he
had found all of it: "No, and I still don't." Priya discovered *by accident*,
in the knowledge map's list view, that she owns a Canonical policy with an open
conflict against it. Nothing told her. `#/queue`, `#/inbox`, `#/me` and
`#/mine` all silently redirect home. Every fact this needs already exists in
the record and none of it is rendered.

**T2.2 · The audit log is not a population an auditor can rely on.**
*(Ruth #5, #6, #7 — "the finding I would lead with"; Marcus, Priya.)* The
screen renders 200 rows of 1,187 and says nothing about the rest. The API caps
at 1,000 and has no offset, cursor or page parameter, so older events are
unreachable by any documented route. There is no date filter. `collectionId`
and `pageId` are accepted and *silently ignored* — worse than rejected. The
action dropdown is a hard-coded 16 that omits ten recorded action types. There
is no export. Ruth reconstructed the full history only by iterating all eleven
actors and merging. Until this is fixed no sample drawn from the log is
defensible, and that caps her reliance however good everything else is.

### Tier 3 — trust, evidence, and the deployment

**T3.1 · Attestations do not record how identity was established.** *(Ruth
#12.)* She searched every bundle for any mention of authentication mode and
found none, so a dev-auth bundle is indistinguishable from a federated one and
the hash chain will faithfully protect a false attribution. Fix: every
attestation states on its face "identity established by SSO, issuer X" or
"identity asserted and unverified".

**T3.2 · Nothing anchors the chain head outside Canon.** *(Ruth #8.)* Her
naive tamper was refused by the triggers and then caught precisely by
`/audit/verify` (`content_mismatch, eventId: 726`). Her competent forgery —
delete an event, reattribute the approval, recompute all 1,171 links — returned
`ok: true`. Her counter-test is the answer: a *retained* attestation named the
forgery exactly. So the mitigation is real and cheap: publish the head hash on
a schedule somewhere Canon cannot write, and tell users to keep bundles. We
already recommend this in the artefact; we should do it.

**T3.3 · Three green lights on a broken database.** *(Ade B1.)* A corrupted
database left `/health` 200, `/ready` 200 with `database ok=true`, the log
silent, and every request 401. Readiness must actually exercise the record.

**T3.4 · No request logging at any level.** *(Ade B2.)* Nothing between "the
server started" and "an unhandled error occurred". An operator cannot answer
"is it serving traffic?" from the logs.

**T3.5 · `CONFIGURATION.md` claims completeness and omits six variables**,
including `CANON_GROUP_MAP` and `CANON_BOOTSTRAP_ADMIN_SUBJECT`. *(Ade.)* Sam
adds: the contracts' worked example does not work against the seeded corpus,
and `disagreement` and `pastReview` are returned but undocumented. These matter
disproportionately because both of them otherwise *trusted* the docs.

**T3.6 · Hand-granting cannot scale under SSO.** *(Ade.)* Actors are
JIT-provisioned on first sign-in and `POST /actors` is 404 under SSO, so an
administrator cannot grant a role to somebody who has not yet logged in.

**T3.7 · `/ask` cannot distinguish "not permitted" from "record silent".**
*(Sam.)* Four different situations return byte-identical responses, and
STUDIO-CONTRACT.md tells apps not to conflate them. This is in genuine tension
with Ruth #10, where that same indistinguishability is exactly why she found no
leakage. It needs a designed answer, not a quick one: probably a distinction
drawn only where the asker already knows the collection exists.

**T3.8 · The rate limit is mis-keyed for Studio and is spent by mistakes.**
*(Sam; confirmed.)* The `ask` bucket keys on the app, so a Studio app gets ~12
questions a minute company-wide. Separately, the limiter runs before the body
is validated, so a malformed request spends a token.

### Tier 4 — the writer's floor

**T4.1 · No tables in the editor.** *(Priya, hard stop.)* A pasted table
renders as `| Region | Owner | | --- | --- |`. Retention schedules and plan
comparisons *are* tables. There is also no toolbar and no preview.

**T4.2 · The approver approves blind.** *(Marcus task 2.)* The page shows the
*published* version; there is no preview or diff of the pending draft. The
excellent side-by-side diff is reachable only *after* approval, via History.
The change he approved added a whole section about a missing escalation path.

**T4.3 · A send-back reason vanishes.** *(Marcus task 2.)* The modal promises
"Your comment goes to the author", the toast says "Sent back with your
comment", the comments panel says "No comments yet", and the author sees a
Draft with no banner, no reason and no rejector. The text exists only in the
global audit log. Related: send-back *requires* a reason and approve does not,
which is backwards.

**T4.4 · Every action is offered and then refused.** *(Priya, Ruth #14.)* New
page, Comment, Approve, Send back, and a red **Delete** on a live data source —
all shown, all 403 at the last click. Grey out what the caller cannot do and
say who can.

**T4.5 · An author cannot retract their own submission.** *(Priya bug D.)*
Send back is offered and refused, the editor is locked, approve is refused. The
page is stuck with nobody's name on it. **Fixed:** `POST /pages/:id/withdraw`,
offered on the page only where the server will accept it. It loosens neither
half of separation of duties — the approver still cannot submit their own
draft, an author still cannot approve their own work — because withdrawal is
neither of those acts: the page returns to Draft, exactly where a send-back
leaves it. Only the actor who submitted it may withdraw it (read from the
`page.submit` event), and only while it is still In Review, which is the same
sentence as "before anybody has acted on it". An approver who wants a page out
of review still uses Send back, which costs them a comment to the author. The
withdrawal is audited as `page.withdraw` and whoever was asked to review is
told. Verified against a running server.

**T4.6 · Navigation.** *(Priya.)* Clicking a folder shows a staff permissions
table with Remove buttons, not documents. Tree titles truncate at ~18
characters ("Regulatory Co…", five rows of "PLAN-7 …") and the tree is the only
navigation. A page in review is invisible to search by its own title (bug E).
The knowledge map opens on 244 unlabelled dots with no colour key, while the
genuinely excellent List view is two clicks away.

**T4.7 · No status glossary.** *(Priya.)* No key, no tooltips, nothing that
tells a new contributor which badge means "safe to read to a customer".

**T4.8 · The demo corpus undermines the demo.** *(Priya, Ruth, Marcus.)* The
page called "Records Retention Schedule" contains no retention periods, and
neither does "Retention periods: claims and appeals" — so the one question a
new contributor naturally asks cannot be answered. Answers quote page footers
and raw `/pages/<uuid>` URLs as what "the record says". Two pages share a
title; pages are called "Orphan Note" and "Messy Legacy Page"; there is a
"pLAN-7" typo. All 16 canonical clinical policies were approved by one person,
which Ruth could not distinguish from a real concentration-of-duty risk.

**T4.9 · Audit-log privacy and legibility.** *(Priya.)* Typed questions are
logged verbatim and visible to everyone; rows show raw UUID arrays,
`generator: extractive-v1`, and a WHERE column whose only value is the word
"page". Timestamps display to the minute and 1,100+ events share one.

## What we are deliberately not doing

The subject / entity-join work — a primary key that links facts about the same
thing across documents — remains out of scope by an explicit decision, and
nothing above depends on it.
