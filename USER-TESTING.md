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
**Fixed.** `#/queue` is a screen and `GET /queue` is the read behind it
(`server/src/queue.ts`), with the count beside the nav entry — which is what he
actually asked for, since he did not fail to find the pages, he failed to be
told there was anything to find. `#/inbox`, `#/me` and `#/mine` rewrite to it
rather than falling through in silence. Six strands, each one work the asking
actor can act on: pages waiting on **their** approval, drafts sent back to them,
pages they own that are past review, conflicts asserted against a page they own,
sources contradicting one, and their own drafts. The approver strand reads the
**draft's** approver through the same rule `approve` enforces — `awaitingApprovalBy`
in `queries.ts`, mirroring the T1.3 invariant clause for clause — so it lists
work the server will actually accept and nothing else. The queue writes no query
of its own: every strand is a read that already filters by membership in its
`SELECT`, which is why a spanning screen can be trusted. The notification outbox
is rendered for the first time since it shipped, as the last strand and outside
the count (there is no read state to count against), which also lets the
editor's freshness promise stop saying that nothing carries a notice to the
owner. Verified against the demo corpus: the approver of 25 in-review pages sees
exactly those 25 and every other person sees none of them; a page-owner sees her
two stale policies, the conflict against her Canonical plan page, and her
`review_due` notices; a colleague who can read one of those pages does not have
it in his queue; `?actor=` cannot change whose queue it is; a passport is
refused at the door. What is not in it: open agent proposals, because
`ProposalService.list` answers only per page and there is no spanning
permission-filtered read to compose — the one strand this queue is missing, and
it is named in `queue.ts` rather than left to be noticed.

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
the hash chain will faithfully protect a false attribution. **Fixed.** Every
bundle now answers the question twice, because the two answers can disagree.
**The doors**, on the face of the document directly under the title and again
in the manifest: the OIDC issuer that vouched for these people, or —
where `CANON_DEV_AUTH=true` — "identity in this deployment was asserted and not
verified… read every attribution as *the record says this actor did it*". Its
placement is the finding: a paragraph on page four would have failed the same
test, because a reader who does not suspect there is a question never goes
looking. **And each actor**, read from the record's own `actors.sso_subject`
rather than from configuration, so it describes the history rather than today:
federated, with the issuer and the provider's subject identifier printed beside
the name, or asserted, with no subject and a sentence saying that no provider
has ever vouched for them here. That column is what separates the real Nadia
Haddad from the second one carrying her email address — the impostor has no
subject — and on an SSO deployment an actor without one is named as the
exception it is. The habit of naming exclusions is extended while we are here:
nothing in a bundle is signed, Canon attests to nothing that happened outside
it, separation of duties is enforced within Canon only, and federation is not
evidence that a person was at the keyboard. Verified against a running Canon
behind a real OIDC provider and against one with the dev door open.

**T3.2 · Nothing anchors the chain head outside Canon.** *(Ruth #8.)* Her
naive tamper was refused by the triggers and then caught precisely by
`/audit/verify` (`content_mismatch, eventId: 726`). Her competent forgery —
delete an event, reattribute the approval, recompute all 1,171 links — returned
`ok: true`. Her counter-test is the answer: a *retained* attestation named the
forgery exactly. **Fixed, in the order the finding puts them.**

*The anchor.* Canon writes an `audit head anchor` line — head event id, head
hash, event count, time — hourly and at start-up, to a file as well where
`CANON_ANCHOR_FILE` names one, with `scripts/anchor-head.js` for a scheduler
that would rather take one beside the nightly backup. It is deliberately not
sold as more than it is, in the code, in the log line, in the bundle and in
OPERATIONS.md: **an anchor Canon writes and Canon could rewrite proves
nothing.** The line is inside the same trust boundary as the database it
describes; the value is entirely in the copy an operator ships somewhere Canon
has no credentials for, and OPERATIONS.md gives the test for whether a
destination counts, along with the instruction to keep the series rather than
the latest.

*The half that does not need an operator.* Every bundle now says **keep this
file** and says what keeping it buys, since a retained attestation is an anchor
already in the reader's own custody. `scripts/compare-attestations.js
<retained.json> <fresh.json>` performs her counter-test in one command against
two files — no database, no network, no running Canon — checking each file
against its own digest and chain links and then naming every difference an
append-only record cannot make: a deleted event, a changed actor with both
values, a hash recomputed over unchanged content, an event moved into the past,
a rewritten version, an approval a register lost. It reports and does not
adjudicate: it cannot know which copy is honest, and the person holding one from
their own custody does.

*And `/audit/verify` stops being reassuring about the wrong thing.* Its response
now carries `okMeans` beside `ok` — "internally consistent… NOT a statement that
the log is authentic; somebody who deletes an event and recomputes every later
link produces a log that answers ok: true" — with `externalAnchor` saying what
would change that. The whole forgery is reproduced in the test suite, including
the `ok: true` it must still return, so the day it stops being true of us we
find out from a test rather than from an auditor.

**T3.3 · Three green lights on a broken database.** *(Ade B1.)* A corrupted
database left `/health` 200, `/ready` 200 with `database ok=true`, the log
silent, and every request 401. Readiness must actually exercise the record.
**Fixed.** The cause was worth naming: an open SQLite connection answers out of
its own page cache, so `SELECT count(*) FROM collections` was reading this
process's memory rather than the record, and the file could be overwritten byte
for byte without that number changing. Readiness now asks twice — real rows
through the live connection, and a short-lived read-only connection opened on
the path itself, which has no cache to be fooled by — and the schema check is
joined by one on the audit chain, because a Canon that would append unchained
events must not be in a pool either. Reproduced end to end: `/ready` goes 503
naming `record_file`, `/health` stays 200 (the process *is* alive, which is all
liveness ever claimed), and an `error` line lands within seconds.

**T3.4 · No request logging at any level.** *(Ade B2.)* Nothing between "the
server started" and "an unhandled error occurred". An operator cannot answer
"is it serving traffic?" from the logs. **Fixed.** One JSON line per request —
method, path, status, duration, the actor if one resolved, and the correlation
id a `500` handed the caller, so a bug report joins to its request as well as to
its failure. `info` for traffic, `warn` for `5xx`, `debug` for the probes;
`CANON_REQUEST_LOG=off` for a deployment whose proxy already writes one. The
query string is dropped whole and deliberately: `/search?q=…` is a sentence
somebody typed — SECURITY.md F2's own words — and `/auth/callback?code=…` is a
live authorization code. No headers, no bodies, no names, no addresses.
Separately, and because it was the silent half of T3.3, Canon now asks itself
whether it can read its own record every ten seconds and says so, rate limited,
when it cannot.

**T3.5 · `CONFIGURATION.md` claims completeness and omits six variables**,
including `CANON_GROUP_MAP` and `CANON_BOOTSTRAP_ADMIN_SUBJECT`. *(Ade.)* Sam
adds: the contracts' worked example does not work against the seeded corpus,
and `disagreement` and `pastReview` are returned but undocumented. These matter
disproportionately because both of them otherwise *trusted* the docs.
**The configuration half is closed, and closed in a way that stays closed:**
every `CANON_…` name is present, and a test scans `server/src` and
`server/scripts` and fails when one is missing, so the page's claim of
completeness is now checked rather than remembered. `disagreement` and
`pastReview` are written up. **The worked example is now closed too**, and by
being run rather than by being reread: STUDIO-CONTRACT.md section 11 is the
whole sequence against a freshly seeded corpus — seed, register, certify, ask
before any Canon grant, grant, ask again, then meet each of the three gates —
verified end to end against a running Canon and a running registry-stub, with
every id read out of a response because they are UUIDs and differ per record.
Two things surfaced while checking it and are fixed here: the optional answer
fields were documented twice and the two copies disagreed about how many there
are (three in prose, four in a table), and `studio-stub`'s own fixture had gone
stale against the effective-date rule of T1.5 — its two seeded policies never
became Canonical, so five of its eight tests were failing for a reason that
looked like the Knowledge API. The fixture now asserts itself.

**T3.6 · Hand-granting cannot scale under SSO.** *(Ade.)* Actors are
JIT-provisioned on first sign-in and `POST /actors` is 404 under SSO, so an
administrator cannot grant a role to somebody who has not yet logged in.

**T3.7 · `/ask` cannot distinguish "not permitted" from "record silent".**
*(Sam.)* Four different situations return byte-identical responses, and
STUDIO-CONTRACT.md tells apps not to conflate them. This is in genuine tension
with Ruth #10, where that same indistinguishability is exactly why she found no
leakage. It needs a designed answer, not a quick one: probably a distinction
drawn only where the asker already knows the collection exists.
**Fixed, narrowly, and the narrowness is the point.** A distinction is offered
only to an asker who already knows the collection exists — which an ask naming
a `collectionId` does, because the Registry limit that let the name through was
written by an administrator, outside Canon, on purpose. A scoped ask now refuses
out loud at all three gates: the Registry's and the person's already did, and
the app's own Canon role was the silent one, so it is asked as a question of its
own rather than left to empty out the candidate SQL. A scoped
`no_canonical_match` now means exactly one thing. **Deliberately unchanged:** an
ask that names no collection is never told that material it may not read exists
— that sentence discloses a container the asker was never told about, on a
subject they chose, and it is precisely what Ruth's nine probes were looking
for. The contract now states that as a decision. The one thing an open question
*may* be told is `nothing_readable`: the pair asking it holds no readable
collection at all, which is the caller's own standing rather than the record's
contents, is the same fact `whoami` already hands them in full, and is the
commonest way a Studio integration fails on its first afternoon — an app
certified, permitted everything by the Registry, and granted nothing in Canon,
which used to be answered "the record does not say".

**T3.8 · The rate limit is mis-keyed for Studio and is spent by mistakes.**
*(Sam; confirmed.)* The `ask` bucket keys on the app, so a Studio app gets ~12
questions a minute company-wide. Separately, the limiter runs before the body
is validated, so a malformed request spends a token. **Both fixed.** The bucket
is keyed on the (app, person) pair from `X-On-Behalf-Of`, so one person's
questions are not the company's. Because that header is asserted by the app and
Canon does not verify it, it cannot be the whole key — an app would mint budget
by inventing people — so a second bucket, `askApp`, is keyed on the app's actor,
which is resolved from its passport by the Registry and cannot be chosen. Both
are charged. The conclusion, stated in ratelimit.ts: a self-asserted identifier
is safe as a key where it *subdivides* a budget the caller already holds, and
never where it sets the total — the same rule the auth bucket follows in the
other direction. Mistakes: the bucket is now *checked* before the body is read
(an empty one must refuse without buffering eight megabytes) and *charged* after
the handler returns, so a malformed body, a missing header, or a refusal at a
gate costs nobody a question.

### Tier 4 — the writer's floor

**T4.1 · No tables in the editor.** *(Priya, hard stop.)* A pasted table
renders as `| Region | Owner | | --- | --- |`. Retention schedules and plan
comparisons *are* tables. There is also no toolbar and no preview. **Fixed:**
GFM pipe tables, alignment row included, in both renderers — `renderMarkdown`
in `public/app.js` (page, version, editor preview, Ask answer) and a new
`renderMarkdownHtml` in `src/html.ts` (the attestation, which used to print the
body as its source in a `<pre>`: an attestation that shows a retention schedule
as pipes has hidden the clause it is attesting to). One grammar, two
implementations, checked against each other case for case in
`test/markdown.test.ts`, including a cell containing a pipe and a ragged row.
Both deviate from GFM only in the direction of never dropping what somebody
wrote: a ragged row widens the table instead of being truncated. The editor has
a toolbar that offers exactly what the renderer draws — a button for anything
else would be a promise broken in front of twelve people — with a Table button
that inserts a filled-in skeleton, and a Preview that renders through the same
`renderMarkdown` into the same `.doc-body` the page uses. Two silent drops
found on the way and closed: a thematic break printed as literal `---`, which
is how an imported page footer came to read as another clause of the policy,
and nested lists flattened, which turned three sub-clauses under clause 2 into
six equal clauses. Verified against a running server: a real retention schedule
written, published and read back as a table on the page, in the version view
and in the attestation. **Still open:** the raw `## Scope` marks in Ask answers
are not a renderer defect — `passageFor()` in `src/retrieval.ts` collapses a
whole body onto one line to quote it, so the block marks land mid-line where no
renderer can reach them. The same collapse is why a table inside a cited
passage is quoted as pipes. Both want a fix where the passage is built.

**T4.2 · The approver approves blind.** *(Marcus task 2.)* The page shows the
*published* version; there is no preview or diff of the pending draft. The
excellent side-by-side diff is reachable only *after* approval, via History.
The change he approved added a whole section about a missing escalation path.
**Fixed:** a *What is being approved* panel sits above the published body while
a page is In Review — the same `diffLines` and the same side-by-side table
History uses, now shared between the two, against the version the draft would
replace, with the title and field changes beside it. The Approve modal restates
the extent from the same summary and offers a way back down to the diff, since
the button sits above it. Nothing is a summary of the change: what is on screen
is the text that will publish.

**T4.3 · A send-back reason vanishes.** *(Marcus task 2.)* The modal promises
"Your comment goes to the author", the toast says "Sent back with your
comment", the comments panel says "No comments yet", and the author sees a
Draft with no banner, no reason and no rejector. The text exists only in the
global audit log. Related: send-back *requires* a reason and approve does not,
which is backwards. **Fixed:** `sendBack` now files the reason as a comment on
the page, through the ordinary comment path, and records that comment's id on
the `page.send_back` event; the comment is marked as the refusal it is, and
stays marked after the page moves on. The author meets it as a banner at the
top of the page — who sent it back, when, and what they said in full — read
from the log by `sentBack`, which stops answering the moment a resubmission, a
withdrawal or a publish is written after it. No flag, no column, nothing to
clear. The asymmetry with approve is **deliberate and stays**: a refusal
without its reason is unperformable by the person who receives it, while an
approval writes its own record — the version, the approver's name, the instant,
and the diff. A required note would fill forty rows a quarter with "ok", which
is not missing evidence but a convincing imitation of evidence.

**T4.4 · Every action is offered and then refused.** *(Priya, Ruth #14.)* New
page, Comment, Approve, Send back, and a red **Delete** on a live data source —
all shown, all 403 at the last click. Grey out what the caller cannot do and
say who can. **Partly fixed:** `GET /pages/:id` carries `abilities` — what the
asking actor may do to this page and, where they may not, the sentence that
says who can ("Only Nadia Haddad, the named approver on this draft, can approve
it"). Every action on the page view and the comment box is drawn from it:
greyed, with the reason on the button and repeated as text, because a `title`
is invisible to a keyboard and to a phone. It is a MIRROR of the checks and
never one of them — a test walks every actor over pages in three states and
fails if anything reported as refused is in fact accepted. Still outstanding:
**New page** in the sidebar, and **Delete** on a source.

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
