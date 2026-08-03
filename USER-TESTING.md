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

## Where this stands

All twenty-five findings have been worked. Twenty-four were fixed; one
(**T3.6**) was answered by design once the answer was documented. **T4.4** —
"every action is offered and then refused" — is now closed everywhere, including
the New page control and Delete on a source that were named as outstanding; what
a second round of testing found about it, and what was done, is at the end of
this file under *The second round: two ways of saying no*. Each entry below
carries what was done and, where something was deliberately left, what and why.

Three of them turned out to be worse than reported once someone looked:
**T1.1** was wrong by construction rather than intermittently, and the same
guess was found in two more places; **T4.9**'s privacy half was not closed at
all, despite a comment in the code saying it was; **T4.1** was hiding two other
silent drops — thematic breaks and nested lists — that had been reported
separately as unrelated mysteries.

Two were fixed by *not* doing the obvious thing. **T1.5** does not refuse
backdated effective dates, because a policy adopted in 2019 and migrated in
2026 is the ordinary case and refusing it would teach people to type today's
date; it requires the claim to say where the date comes from instead. **T3.7**
draws its distinction only for an ask that already names a collection, because
the same indistinguishability the integrator complained about is why the
auditor's nine probes found no leakage.

Each fix was exercised against a running server, not only against its tests.
That caught defects the suite did not: an ambiguous SQL column that made every
paged request a 500 while every unpaged one passed, and a `studio-stub` that
had been failing since the effective-date rule landed because only the server
suite was being run.

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
**Fixed.** Paging is a CURSOR on the event id, not an offset, for a reason
particular to this table: `audit_events` is append-only, is read newest first,
and is being written to by the very people whose acts are being sampled — so
under an OFFSET every event written mid-walk shifts the tail down by one, and
the reader silently sees a row twice while never seeing the one it displaced.
`GET /audit/summary` answers the two questions the screen cannot honestly draw
without: how many events matched, and which actions are in the population —
computed *without* the action filter applied, so choosing one does not collapse
the list to the choice already made. The ignored filters now filter, and what
cannot be honoured is refused by name rather than dropped: `?from=last Tuesday`
is a 400, because a filter accepted and ignored returns an answer that *looks*
narrowed. The export walks the same cursor and carries the whole filtered
population — once the listing gained a page size, a `limit` on the export
meant handing an auditor the most recent thousand rows of a filter with nothing
on the file to say so, which is the screen's silent truncation reproduced in
the one artefact that leaves the building. `limit` is refused there too. WHERE
names the page rather than reading the bare word "page", joined at read time
and never stored, because a page renamed next year did not retroactively carry
that name when the event happened. Verified against Ruth's own test: 1,170 of
1,170 reachable, zero duplicates, export equal to the count.

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
**Fixed, and the completeness claim is now enforced rather than asserted:** a
test scans `server/src` and `server/scripts` for `CANON_` names and fails on
any the page omits, so the gap cannot reopen — it caught two variables before
they were written up. The worked example was rebuilt and confirmed twice end to
end against freshly seeded corpora, reading every id out of a response rather
than writing it down, because they are UUIDs and differ per record. Along the
way the optional answer fields turned out to be documented *twice*, with the
two copies disagreeing about how many there were. `disagreement` and
`pastReview` are written up. `REGISTRY-CONTRACT.md` was read against
`agentauth.ts` and the stub and found accurate.
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
**Answered by design, and the answer was undocumented — which is the real
defect.** Granting one person at a time in advance is not a thing Canon does:
there is no actor for somebody who has never arrived, and minting one from an
email address typed by an administrator would put a person in the record that
nobody's identity provider has vouched for. The scaling path is
`CANON_GROUP_MAP` — a directory group your provider already maintains becomes
a role here, applied on first sign-in and re-evaluated on every session
confirmation, so a joiner has access the first time they open Canon and a
leaver loses it inside the session window. It was built, it has fifteen tests,
and Ade never found it, because it was one of the six variables
`CONFIGURATION.md` omitted while claiming completeness. It is now documented
there and, more usefully, in the first-hour checklist in `OPERATIONS.md` where
an administrator is actually standing when the question arises.
**Deliberately not built:** pre-granting to a named individual who has not
signed in — an invitation. That needs a decision about what an un-arrived
person *is* in the record, and it is better absent than approximated.

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
fails if anything reported as refused is in fact accepted. **Now closed in
full**, including the two controls that were outstanding here — **New page** in
the sidebar, and **Delete** on a source — along with the Members screen, the
relation dialog, and the second vocabulary the server itself was still speaking.
See *The second round: two ways of saying no* at the end of this file.

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
**Fixed**, in four places, because it was four defects wearing one number.
*The front page.* A collection opens on its **contents** — every page in the
record's own order, indented by depth, with its type, its standing, its owner
and the date it is next due to be looked at. Membership is administration and
moved to `#/collections/:id/members`, one click away and named on the button:
same table, same rules, same audit, on a screen somebody goes to on purpose.
*The tree.* Titles wrap and the sidebar is wider, so the badge follows the last
word of a title rather than competing with it for the row. Nothing is cut.
*Search (bug E).* The cause was the index, not the query: `page_search` was
built with an inner join to the page's current version, and a page in review
has published none, so it had no row at all while sitting in the tree with its
title on screen. The rule is now applied per field. A page's **body** still
enters the index only when a version publishes — a draft body is work in
progress and readers search the record, not each other's half-finished
sentences. A page's **title** is indexed from the moment the page exists,
because it is already drawn to every member of the collection and a search
index that disagrees with the screen is a defect. Permission filtering is
untouched; a non-member still finds nothing. *The map.* A drawing is the
default only while it can name every node on it — past about 120 the
constellation labels the hubs and leaves the rest as dots — so above that the
**list** opens, and below it nothing changes. The drawing now carries a short
key in its own corner: what a dot is, what a square is, what the lit core and
the amber ring and the dotted ring mean, and what the hues stand for, with a
link down to the full legend. Verified against a running server.

**T4.7 · No status glossary.** *(Priya.)* No key, no tooltips, nothing that
tells a new contributor which badge means "safe to read to a customer".
**Fixed**, and fixed by copying the one status that already worked. Needs
Update explained itself because its two words say what to do about it, so every
status now answers the same question in the same voice — may a reader act on
this page, or not, and why. One sentence each, written once in
`STATUS_MEANINGS` and rendered as a **key on the collection front page**, where
the badges first appear; again in the map legend; and carried by every badge in
the product as its own description. Not four tooltips: one sentence, in the
places a reader actually meets the badge.

**T4.8 · The demo corpus undermines the demo.** *(Priya, Ruth, Marcus.)* The
page called "Records Retention Schedule" contains no retention periods, and
neither does "Retention periods: claims and appeals" — so the one question a
new contributor naturally asks cannot be answered. Answers quote page footers
and raw `/pages/<uuid>` URLs as what "the record says". Two pages share a
title; pages are called "Orphan Note" and "Messy Legacy Page"; there is a
"pLAN-7" typo. All 16 canonical clinical policies were approved by one person,
which Ruth could not distinguish from a real concentration-of-duty risk.
**Fixed.** The pages a reader will actually ask about are written out by hand
and carry their figures — the whole retention chain, both sides of each
asserted conflict, and the claims and appeals pages a question about either
reaches next — with their type and standing pinned rather than rolled, because
a demo whose central demonstration depends on a dice roll is not a demo.
**The conflict is intact and had to stay intact**: the schedule keeps claims
records for seven years, the platform spec deletes them at twenty-four months,
both pages are Canonical, each names the other in its own words, and a person
has asserted the conflict between them. Asked *"how long do we keep claims
records"*, the corpus answers with both figures and the conflict note in the
asserter's own words, and says Canon will not choose between them. The rest
went with it: the owner footer and the four stock closing lines are gone, since
a footer is what an extractive answer quotes when a page has nothing better in
it; the Related links are still links and still the graph's `link` edges, now
written as markdown so the words are the target's title rather than a UUID;
`lowerFirst` no longer lower-cases identifiers, which is where "pLAN-7" came
from; the demo ships **its own** migration material (`scripts/demo-corpus`)
rather than borrowing the test fixtures, whose pages are named after the defect
each carries and three of whose titles collided with seeded ones; and every
collection now names **two** approvers, both of whom actually approve, with the
split printed by the seeder and a test that fails if any collection's Canonical
mark is granted by one person alone. Verified against a running server.

**T4.9 · Audit-log privacy and legibility.** *(Priya.)* Typed questions are
logged verbatim and visible to everyone; rows show raw UUID arrays,
`generator: extractive-v1`, and a WHERE column whose only value is the word
"page". Timestamps display to the minute and 1,100+ events share one.
**Both halves fixed, and the privacy half was worse than reported.** The
permission rules already restricted an ask that named no collection to the
asker and to operators — but an ask *scoped* to a collection is an event naming
that collection, so it reached every member. Measured on a running server: a
colleague holding only `view` could read "how do I raise a grievance about my
manager". The question text is now withheld from everybody but the person who
typed it and an operator who can already see the event, while the event itself
stays whole and visible, because *that* an ask happened and which pages it drew
on is exactly what Ruth needs to answer "who looked at the coverage criteria
before that denial". Redaction is on the way out, never at write time: the
stored event must stay whole for an operator, and the hash chain covers the row
as written. Writing the test turned up a rule worth recording — an operator
holding no role in a collection cannot see a collection-scoped event *at all*,
so the second reader is not "any operator" but "somebody who can already see
the event and is also one". Legibility: the detail column says its keys in
words and resolves ids to names where the client holds them, never guessing
one; WHERE names the page; timestamps carry seconds.
**The legibility half is fixed** (the WHERE column earlier, the detail column
now); the privacy half is being closed separately in `store.ts`. The detail
column printed the event's details object more or less as JSON. It now says the
key in words, and draws an id whose kind is known as the thing it names — an
actor by name, a collection by name, a page by its title where some row on the
same screen carried it — falling back to a shortened, linked id where the
client was given no name, because a wrong name in an audit log is worse than a
long one. Objects are spelled out: an import's `counts` reads "found 7,
imported 6, failed 1". Two keys that said the same thing twice are dropped when
they do — `sourceId` beside `sourceName`, and a relation's stored pair beside
its asserted pair, which differ only for a symmetric relation and are worth the
row space only then.

## The second round

The same three testers were given the fixed product and asked to do the job
again. All three verdicts moved — the contributor from "not yet" to "I would
use this", the compliance director to putting his name on a decision the
product walked him through, and the auditor from a qualified opinion to a
substantially clean one. What they found next is below.

The same compliance director and the same new contributor were given the fixed
product and asked to do the job again. Both now rate it well, and what they
found is a different KIND of finding: with two exceptions the record already
held every fact they wanted, and the defect was where it was drawn, or that
nobody said it out loud. That is worth naming, because it changes what a fix
looks like — nothing below adds a field to the record, and most of it moves a
sentence to where somebody is standing when they need it.

**R1 · A disputed number was disclosed in the basement.** *(Marcus.)* The
*Records Retention Schedule* says "seven years" in its second sentence, and a
person has written down that the platform spec contradicts it. The assertion,
its author, their reasoning and its date were in CONFLICTS AND SUPERSESSIONS,
below the body, below the federated values, below everything — while "past
review" got a banner at the top. "Somebody who reads the top of the page and
stops never learns the number is contested. 'This is out of date' and 'this
number is disputed' belong in the same place, and it isn't the basement."
**Fixed**, by his principle rather than by moving one panel: a page's STANDING —
archived, past review, contested, superseded — is one list now (`pageStandingNotes`
in `public/app.js`), computed as data and drawn in one block above the text. The
answer path had already reached this conclusion, since a citation carries
`disputed` and reads "contested" in the same red: a page's standing must not
depend on how somebody phrased a question, and it must not depend on how far
they scrolled either. The panel stays the register — both ends, the note, Assert
and Withdraw — and the banner points down to it. Relations are now fetched
before the first paint, because a banner that says "contested" cannot arrive
after the first paragraph has been read; a read that fails answers null and
draws nothing, never "no conflicts". `supersedes` is deliberately not a banner:
it is a caution about the OTHER page.

**R2 · The Publish dialog said what it is not, never what it is.** *(Priya.)*
"It publishes without review — use 'Submit for review' if this page should earn
the Canonical mark", and not one word about where the page ends up. "I nearly
pressed it, and I'd have had no idea what I'd done." **Fixed:** it names the
version it is about to write, the status the page lands in — Draft, every type
and every time, because `writeVersion` settles it there unless an approval wrote
the version — in the same badge the page will wear, carrying the sentence the
status key already gives that badge. A page holding a mark is told it is giving
it up; a page holding none is not told about one it never had; a Note is told
there is no review to send it to rather than pointed at a button it cannot use.

**R3 · Federated values sat outside what was approved, and only the editor said
so.** *(Marcus.)* He praised the provenance line — HEADCOUNT (ENGINEERING) · 41
· service-resolved · People System · resolved 30 minutes ago — and then found
that the only place saying those values "are page-level and take effect
immediately: they are not part of this draft" is the editor, which an approver
never opens. So a figure on a page he had approved could change afterwards,
without a version and without him. **Fixed:** *What is being approved* now says
what is not — the values by name and source, with the mode that decides who can
see them, and the three facts that matter: Canon stores none of it, it asks the
source again on every read, and it can read differently tomorrow with nobody to
come back to. His own sentence, near enough: *your approval covers the text.* It
sits above the diff, because an approver who has scrolled a hundred lines has
already decided, and the Approve modal restates the count from the same summary.

**R4 · Below about 500px the sidebar buried the work.** *(Marcus, on a phone.)*
One column, sidebar first in the source, 82 pages of tree: at 420px the page
under review, the diff and the Approve button began 4,830 pixels down. "On a
phone I'd approve without scrolling back up to read anything." **Fixed** by
deciding what a narrow viewport shows first — the thing somebody navigated to.
The tree is neither dropped nor moved below the page: it collapses to the
collection's name and one button saying how many pages are behind it, and opens
in place. The control ships hidden and is revealed only where the media query
matches, so a browser running no JavaScript gets what it always got. Measured:
the content now starts 4,400px higher, with the title, the badge, Approve, the
review banner and the top of the approval panel all in the first screen.

**R5 · Search covered unpublished drafts by title only, and did not say so.**
*(Priya.)* "Portal claim intake" found her draft; "unreadable member id", a
phrase inside it, returned "Nothing in the record matches" — the same sentence
Canon uses when the record genuinely holds nothing. The rule is deliberate and
stays (a draft body is work in progress; see `src/search.ts`). What was missing
is anybody saying it. **Fixed:** the dropdown states the boundary under the hits,
where it explains why a page she can see did not match, and under the empty
line, where it is the likeliest reason there is nothing there, with the one
thing to try instead. The statuses in that sentence are drawn as badges rather
than written as words, so the dropdown names a status in the product's own
vocabulary and casing.

**R6 · Two small ones, taken while we were there.** The collection tree was a
fixed-height scroll box — a sticky column has to be told a height — which
clipped an entry mid-word and hid a newly created page below the fold of a box
inside a page, where nobody looks. It is only a box while everything fits in it
now; a taller tree scrolls with the page, whole. And the version-history table,
found while measuring, pushed a 420px page 121 pixels sideways: it is in its own
scroll container, like the collection's contents table, because nothing in this
product may scroll horizontally.

A second round of testing found the product had grown **two vocabularies for
refusal**, and that the good one was not the one that turned up when it
mattered. The good one, from the `abilities` work above, names the caller and
names who can act:

> *"Editing needs the edit role on this collection; you hold view. Bo Ferrante,
> Dana Whitfield, Joel Brennan and 2 others hold it."*

The old one was a small red toast in the bottom-right corner, behind a dimmed
modal backdrop, gone in about three seconds:

> *"Requires edit access to this collection."*

The contributor's words: *"They read like two different products, and the second
one turns up at exactly the moments that matter most."* **All of it is fixed.**

**One vocabulary, and one place it is written.** `src/abilities.ts` holds the
sentence and nothing else: who holds a role here, who holds an org role, and the
whole refusal for an act that needs one. The rules did not move — they are still
beside the check each one mirrors — but the words are now built once. The
sentence **names its collection** rather than saying "this collection", because
a refusal that has to travel has to name the thing it is about. And the second
vocabulary is gone from the server too: `requireRole` was written out eight
times across `store`, `sources`, `references`, `relations`, `comments`,
`proposals`, `queries` and `import`, and every one of them threw the same seven
words. All eight now throw the sentence `abilities.ts` builds, so the refusal a
screen SHOWS and the refusal a request GETS are one sentence. Who-can is said
only to somebody holding a role in that collection — a member can already read
the membership, while to a non-member the same sentence would be a restricted
collection's staff list handed out by a 403; they are told where to go instead.

**Members.** The last screen in the product offering a control it would refuse,
and the one where a wrong click would be most alarming: holding only `edit`,
every **Remove** beside every colleague was fully enabled and the Add member
form was live. Both are now drawn from `collection.abilities` — a mirror of
`requirePermissionAdmin`, including the org-administrator break-glass path,
because a mirror that missed it would tell an administrator they cannot do a
thing the server accepts from them.

**Sources.** Each row carries what the asking actor may do to it, and `GET
/sources/new` answers for the one control that exists before a source does. The
red **Delete** is refused with the reference count as well as the role, because
a source with pages pointing at it is refused whoever asks. The scope picker
marks collections the caller does not administer, where the choice is made
rather than after the Save.

**The cross-collection conflict**, which mattered most, because the one real
contradiction in the seeded record is cross-collection and cross-boundary is
where contradictions come from. She picked a page in another collection, wrote
the note, pressed the solid green **Assert it** — and nothing happened. *"Which
collection? The one I'm on, where I hold edit? Or the one I'm pointing at? It
doesn't say, and it names nobody to ask."* Asserting needs `edit` on BOTH pages'
collections, so the dialog now asks the server about both: the picker marks
pages the caller cannot assert against, the way the approver picker lists only
real approvers, and the mark carries the collection that refused, what they hold
there, and who does hold it. Reproduced against a running server: *"Asserting a
relation needs the edit role on Compliance; you hold view there. Dana Whitfield,
Helena Vardy, Marc Oyelaran and 2 others hold it."*

**A refusal after the click is readable.** An error toast waits to be dismissed
instead of leaving after three seconds, and one raised inside a dialog is drawn
**in the dialog** — *"if I had blinked, I would have gone home believing I had
raised mine."*

**The explanations stopped stacking.** *"Three or four of these and there's a
paragraph of apology above the thing I opened the page to read."* One refusal is
one line, as before. Two or more collapse to a single line and a **Why?** that
opens them, and focusing, tapping or clicking any greyed control opens the list
with that control's own reason lit. The reason is never only a `title`: a
refused control is `aria-disabled` rather than `disabled` so it stays in the tab
order and can be tapped, and its sentence is always in the document.

**A new page is owned from the moment it exists.** It used to be created with no
owner and nothing ever asked for one — nine pages in one seeded collection
showed "—" under Owner, and the first anybody heard about it was Submit for
review refusing the page days later on another screen. Decided **both** ways
round, because they are not alternatives: the server defaults the owner to the
creator, and the New page dialog asks, filled in with the creator. The default,
because at that moment the creator is the only person Canon can honestly name as
accountable, and an unowned page is never a fact about the record — only a gap
the product left. The prompt, because a default nobody is shown is a default
nobody corrects, and whoever creates a page very often knows it belongs to
somebody else. Nothing is locked: the draft inherits it, the editor edits it, an
approver sees a change to it in the diff, and `ownerId: null` still creates an
unowned page for an importer whose corpus genuinely does not know — which is
what `hasOwner: false` and the record-health count are for. A Note is given
none, because it has no owner field and would silently lose one at its first
publish.

Verified against a running server, as her sequence: signed in as somebody
holding only `edit`, the Members screen greys every Remove and says who can; the
source register greys Register, Edit and Delete; and asserting a conflict
against a page in another collection is marked in the picker before the note is
written and, if forced past that, refused **in the dialog** in the same words.

## The third round

Seven personas, in a real browser, against a freshly seeded record — larger
than the previous rounds and structured in two waves so the new machinery
could be tested the way it will actually be used: five personas worked all
day (asking, being refused, editing), and then an operator opened the Gaps
view cold to triage the real questions they left behind, while an approver
opened a queue holding a real alias submission. Three personas returned to
re-judge standing verdicts; four were new, aimed at the surfaces built since
round two: aliases, the gap loop, refusal pointers, and the question-privacy
model.

### The verdicts

| Persona | Prior verdict | This round |
| --- | --- | --- |
| Marcus, compliance director | "I'd disable it before I let forty policies near it" | **Moved.** "Leave it on as a citation-finder, but no answer or refusal from it may be cited in a decision file. Promoted from hazard to junior clerk: allowed in the building, not allowed to sign anything." |
| Priya, policy owner | "Yes. It's changed. I would use this." | **Stands.** On aliases: "right model — not yet at forty pages. Fix silent save-loss, one-click submit, collisions, and field compare, and I'd name all forty tomorrow." |
| Ruth, external auditor | "Substantially clean" | **Stands.** Management letter: the new machinery does not leak pages a limited user cannot open, but "Also known as" must be added to the attestation, because vocabulary that steers answers should be provable in the record. |
| Tomas, DPO (new) | — | **Sign-off with conditions.** The question-privacy model held under his probing; conditions are real auth in any wide deployment, an operator-seat verification (Dana supplied it, with one correction below), and a guard on the alias-laundering path. |
| Ada, new joiner (new) | — | "Canon made my first week **harder but failed honestly**. 'It's all in Canon' is unfair to say to a new joiner today." |
| Dana, operator (new) | — | On the Gaps loop: "**Keep it** — real work-reduction, seconds per gap, a self-writing audit trail." |
| Lena, approver (new) | — | "I approved once — rescued by the submitter's version note. I would **not certify alias changes forty times a quarter** until the review screen shows me what I am signing." |

### What the round proved

The vocabulary loop worked end to end, live, across three people who could
not see each other: Marcus was refused in his staff's words; his questions
appeared in Dana's Gaps view with pointers at the right page; Dana taught the
page the words and submitted; Lena approved (a parallel case) and watched the
same question flip from refusal to cited answer the moment the mark was
granted. Nothing else in the product improves with use; this does.

The privacy walls held under two independent adversarial probes. Ruth and
Tomas — different permissions, different phrasings — both failed to make a
refusal, a pointer list, an alias, or the audit log name a page or a question
they were not entitled to. The traps held too: nothing was fabricated for
canteen hours, submarine procurement, or a Wi-Fi password.

Adjudications made against the code afterwards: the "every ask is logged
twice" seen by three personas is the test driver double-firing its Enter key,
not a product bug; the missing-alias attestation and the broken CSV export
under header auth are both real and confirmed at the source.

### Findings, consolidated and ranked

*(All fourteen findings below were fixed after this round, and the fourth
round — the rerun, below — sent the same seven personas back to verify the
fixes against the running product.)*

**Integrity class — fix before anything else:**

1. **An approver can be asked to sign blind.** The review diff runs against
   the last *published* version, not the last *Canonical* one, so any change
   published before submission vanishes into the baseline — Lena certified
   vocabulary the "what is being approved" panel never showed her, and
   version compare says "identical bodies" when only fields differ. One
   root fix: field-aware diff against the last Canonical version. (Lena,
   Priya)
2. **A confident answer can cite the wrong pages.** "Can I work from home 3
   days a week?" answered from offer-approval and interview pages while two
   relevant Canonical flexibility pages sat unused; "what do the COB rules
   require when a member has two plans?" cited three unrelated pages —
   honest, cited, useless. (Ada, Marcus's hedge case is the same class from
   the other side.)
3. **The Gaps view's privacy sentence overclaims.** "Who asked is not shown
   because it is not stored" is true of the gaps table and false of the
   product: an operator can join a gap to its asker through the audit log,
   which is the audit log's own (deliberate, pre-existing) rule. The linkage
   is defensible; the sentence is not. Reword it, and say the true thing.
   (Dana, answering Tomas's C2)

**Major:**

4. The thin-answer hedge fires on square answers and is phrasing-brittle:
   "how many days to file a first-level appeal" quoted the 180-days sentence
   under "nothing in the record answers this directly", and the audit log
   recorded refused:false while the screen disowned the answer. (Marcus)
5. Refusal pointers miss the answering page in about half the hard cases,
   and never name a page that is in review even when it visibly holds the
   answer — Ada's sick-leave refusals showed nothing while "Sick leave and
   certification" sat in her sidebar. Pointers should be able to name
   non-official pages, labelled as such. (Marcus, Ada, Dana)
6. Ask never surfaces a federated field's live value: on PLAN-7 the only
   figure an asker sees is the stale prose one, correctly conflict-framed
   but still the wrong number, while the service-resolved $1,500 never
   appears. (Marcus)
7. A failed alias validation loses work silently: no error, no save, and
   the other pending field changes in that save are discarded. (Priya)
8. The alias review road is needlessly expensive and self-contradictory:
   the publish dialog says "use Submit for review instead", submit rejects
   Canonical pages, and the page stops answering Ask entirely while in
   review — days of Ask downtime for a two-word vocabulary change. (Dana,
   Priya)
9. Submit is one unconfirmed click with no approver choice at submit time
   (Priya submitted to the wrong approver); the self-approve button is
   enabled for the submitter and silently no-ops instead of explaining
   the separation-of-duties refusal. (Priya, Dana)

**Worth fixing, not urgent:** alias collisions across pages are unwarned
(Priya); aliases are absent from the attestation rendering (Ruth, confirmed);
audit CSV export fails under header auth because it is a bare anchor (Ruth,
confirmed); gaps that have since become answerable stay open with no re-test
affordance (Dana); the alias placeholder shows claims examples in every
collection and carries no help text (Ada); an operator resolving a gap gets
no warning against pasting a sensitive question verbatim into public
vocabulary (Tomas).

## The fourth round — the rerun

All fourteen third-round findings were fixed, and then the same seven
personas ran the same sessions again: same briefs, same two-wave structure,
a freshly seeded record, and the test driver's own double-fire bug repaired
so that artefact could not recur. Each persona carried their third-round
verdict into the session with instructions to re-judge it — an unearned pass
helps nobody, and none was given.

### The verdicts, third round → fourth

| Persona | Third round | This round |
| --- | --- | --- |
| Marcus, compliance director | "Junior clerk: allowed in the building, not allowed to sign anything" | **Promoted again.** "Research clerk: its citations may now enter a decision file once the source page is read; its silences may not — no decision file may record 'the record is silent' on Ask's say-so." The PLAN-7 live-value chip and the conflict handling he called exemplary; the traps held. |
| Priya, policy owner | "Right model — not yet at forty pages" | **Moved decisively.** "'I'd name all forty tomorrow' is now true." Save-loss, one-click submit, and field compare verified fixed; collisions warn at save rather than as-you-type, which she accepts with a note. |
| Ruth, external auditor | "Substantially clean", one letter item | **Stands and improves.** Both letter items verified at the source: "Also known as" is in the page-today attestation and every per-version table, and the CSV export reconciled exactly, redactions intact byte-for-byte. |
| Tomas, DPO | Sign-off with conditions | **Hardened to refuse — deliberately.** Every wording condition verified met, and pointers never leaked; but he then *proved* his standing auth condition by reading colleagues' questions with a forged `X-Actor-Id` header. That is the dev-auth mode doing what dev-auth mode does; his point is that the condition is now demonstrated, not presumed, and wide deployment without real auth is off the table. |
| Ada, new joiner | "Harder but failed honestly" | **Moved a step.** "Failed honestly and occasionally caught me" — one refusal pointer walked her straight to the right canonical page. Still unfair to say "it's all in Canon": carryover rules are genuinely not in the record, and search still does not speak new-joiner English until someone teaches it. |
| Dana, operator | "Keep it" | **Holds.** Triaged all 28 live gaps — eight closures in under a minute — confirmed both privacy claims from the operator seat, and closed the vocabulary loop end to end again. One major: the new amber "record now answers this" note was wrong on three of its four gaps. |
| Lena, approver | "Not forty times a quarter until the review screen shows me what I am signing" | **Moved.** "Yes — the review screen finally shows me what I sign." The banner named the alias change field by field against the last-Canonical baseline; this round the submitter's note was corroboration, not her rescue. She approved, and watched "TAT" flip from refusal to cited answer. |

### What the rerun proved

The fixes were real. Fifteen of the sixteen specific claims the personas
were sent to verify held against the running product: the approver's blind
signature is gone (Lena), the attestation carries vocabulary (Ruth), the
save that fails says so (Priya), the live field rides the citation (Marcus),
the Gaps view tells the truth about what it stores (Tomas, Dana), and the
loop — refusal to gap to alias to approval to answer — closed live a second
time, across two people, in both directions of the wait.

The one claim that did not hold: refusals never named an in-review page in
Ada's session, though the machinery exists and worked elsewhere — pointer
coverage is real but uneven.

The verdict pattern is worth recording: every persona who re-judged a
*surface* moved forward; the one who re-judged a *deployment precondition*
(Tomas) moved backward on purpose, by demonstrating it. Both movements are
the product working as a record: claims verified, not presumed.

### Findings, consolidated and ranked

**Major — the honesty class:**

1. **`refused: false` does not mean a person was answered.** The
   closest-passages hedge counts as an answer in the API and reads as a
   refusal on the screen, and this one dishonesty now surfaces in three
   places: Ada's work-from-home question "answered" with three irrelevant
   hiring pages; Marcus's canteen trap "answered" with claims-clock text;
   and Dana's amber "record now answers this" note — which trusts
   `!refused` — wrong on three of four gaps. One root fix: a hedge is not
   an answer, in the API, in the audit log, and in the probe. (Ada, Marcus,
   Dana; adjudicated against the code — `wouldAnswer` returns `!refused`.)
   *Fixed: thin grounding now refuses, with the pages the hedge would have
   quoted as the refusal's pointers — verified live on all three cases, and
   the former hedges now land in the Gaps queue, which they never did.*
2. **Staff phrasing still refuses where the record answers.** "How fast do
   we have to turn around an urgent claim?" refused while the pointer's own
   page says "an expedited claim… is decided within seventy-two hours".
   This is the vocabulary loop's job, and the loop closed on exactly this
   gap during the round — Dana's alias submission is in review — but the
   default experience before an operator intervenes is still a wrongful
   refusal. (Marcus, Dana)
3. **Right page, wrong sentence.** The appeal-deadline answer cited the
   right page and never quoted "the member has 180 days"; the
   clinical-denial quote starts one sentence past the answering sentence.
   (Marcus)

**Worth fixing, not urgent:**

4. Opening an editor takes a silent draft lock: a "draft" with no
   keystrokes behind it appears in the queue and the audit log, and blocks
   other editors. (Priya, Ruth, Ada)
5. Unapproved aliases already steer search — badged in-review, so nothing
   leaks — but the editor caption says "once approved", and the caption is
   wrong. Say what is true. (Ruth, Priya)
6. Dismissing a gap accepts an empty note while resolving demands one; a
   reasonless dismissal is the one closure nobody can audit later. (Dana)
7. "Show me the changes" inside the approve dialog closes the dialog and
   discards the typed note. (Lena)
8. The audit CSV export is itself the one act the audit log does not
   record. (Ruth)
9. An asker is never told their question is recorded and operator-readable;
   the rule is honest everywhere except to the person it most concerns.
   (Ada, Tomas)
10. Polish: the review banner counts the approver handoff as a changed
    field while compare does not (both defensible, momentarily confusing —
    Lena); the editor shows stale values after publish until reload and
    toasts linger (Priya); a stale Gaps nav link flashes for non-operators
    (Dana); audit DETAILS over-disclose operational internals (Tomas);
    global event ids reveal withheld activity volume to limited users
    (Ruth).

**Standing precondition, not a finding:** dev-auth header identity is for
this test harness only; Tomas's demonstration stands as the reason real
authentication gates any wide deployment.

## The fifth round — a targeted retest

Two personas, not seven: Marcus and Ada, the two whose verdicts hinged on
the work done since the fourth round — the hedge removal, the tended
vocabulary, and the seven smaller fixes. Both ran their full sessions
against a fresh record within hours of the fixes landing.

### What held

Every honesty claim survived both personas. The hedge is gone everywhere
Marcus looked: refusals say so on screen and in the audit log in the same
breath, the canteen trap refuses cleanly, and his verdict names the change
— refusals are now trustworthy enough that "the record is silent" may be
cited as evidence of silence. The PLAN-7 live-value chip held. Ada's worst
behaviour from round four — the work-from-home question "answered" with
hiring pages and logged as not refused — is dead in all three parts she
was sent to verify. The Ask screen now tells her what is kept and who can
read it, verbatim as shipped. The phantom draft is gone with audit proof:
opening an editor logs a page view, and the lock starts at the first
keystroke. The seeded vocabulary shows on the pages as theirs to see.

### What the retest caught, and what happened to it

The round earned its keep by catching three things the harness had not:

1. **"Turn around" is not "turnaround" to a tokenizer.** Marcus's exact
   staff phrasing refused while the one-word form answered. Fixed the same
   day, the product's own way: the vocabulary now carries both spellings,
   verified against his sentence. (Same class as destroying/destruction,
   which the seeding had already hit.)
2. **The pointer lottery.** Ada: "do I need a sick note?" refused with no
   pointers while "how do I call in sick?" named the right page. Adjudicated
   to two mechanisms in the wider pointer pass — status ranking buries an
   unapproved page below Canonical pages that merely mention the word, and
   the evidence floor was judged on a twelve-token snippet that cannot see
   the aliases that made the page findable. Fixed: the floor now reads the
   page's indexed text, body and aliases both, guarded by a fixture that
   reproduces the lottery.
3. **Marcus's challenge to the quotation position.** The team's stance is
   that better quotation needs a better model; his expedited-claim quote
   truncated one clause before "seventy-two hours", and he called that
   arithmetic, not modelling. He is partly right — and two more arithmetic
   variants were tried against exactly his cases in this round (a shape
   tie-break, and letting the whole page compete with the semantic chunk),
   both measured flat, both recorded over `bestWindow` with their
   mechanisms. The position stands, but it now stands on five recorded
   attempts rather than three.

### The verdicts

Marcus: **research clerk stands** — promoted only in that silences may now
be cited; answers still may not be quoted in a decision file until the
quotation engine can finish a sentence. Ada: **moved but not landed** —
"it's all in Canon" is still unfair, because it genuinely is not all there:
no page states a carryover rule or a work-from-home day count, and that is
now a content gap wearing a refusal, exactly where the record wants it.

### Still open, honestly

The quotation class (three specimens, five recorded negative attempts —
the standing bet is a real generation model). Pointer quality on questions
the record cannot answer: the pool is the top eight candidates, and the
page a refused asker should see can rank twelfth — a deeper or semantic
pointer pass is the noted shape of the fix, with two orderings already
recorded as negative results at the site. The refusal's "Search the record
instead" button pre-fills the entire question into exact-match search, a
guaranteed second dead end (Ada). And the two content gaps her manager's
errands exposed are an editorial decision, not an engineering one.

## What we are deliberately not doing

The subject / entity-join work — a primary key that links facts about the same
thing across documents — remains out of scope by an explicit decision, and
nothing above depends on it.
