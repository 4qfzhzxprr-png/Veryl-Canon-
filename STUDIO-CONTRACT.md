# The Studio ⇄ Canon Contract

Veryl Studio lets anyone build an app on company data. Veryl Canon holds that data, and the Veryl Agent Registry's rules keep every app inside safe limits. This document is the contract between them: how a Studio app proves who it is at Canon's door, how it names the person it is acting for, what the two of them together may read and write, and what happens when any part of that fails.

[DATA-BACKBONE.md](DATA-BACKBONE.md) (section 8) states the contract's principles and section 9 puts the Knowledge API first in the Next tier, because Studio's timeline depends on it. [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) is the contract this one is built on rather than beside: **a Studio app is an agent**, and every word of the Registry contract applies to it unchanged. Nothing here replaces, extends or softens that. What this document adds is one thing the agent surface does not have — the person an app is acting for — and everything that follows from naming them.

The working example is in [studio-stub/](studio-stub/): a benefits question-answering app that authenticates with a passport, asks on behalf of a named person, and renders the cited answer. It implements exactly the endpoints below, no more, so the day a real Studio app arrives it changes one base URL and nothing else.

---

## 1. The shape of the relationship

One sentence, from the backbone document: Studio apps are only as trustworthy as the data they answer from, so they draw on Canonical pages through Canon's Knowledge API, live, with the asker's and the app's permissions carried in.

Everything below follows from four rules:

1. **A Studio app is an agent, and has no second credential model.** It is registered and certified in the Registry, it holds an Agent Passport, and it presents that passport to Canon exactly as any agent does. Canon issues no app credential, no API key, no OAuth grant, and no session token. If a claim about identity or standing is not in REGISTRY-CONTRACT.md, it is not true here either.
2. **An app acting for a person names both, always.** DATA-BACKBONE.md section 9 asked whether Canon records the person, the app, or both. The answer is both, because the audit question is *who did what, through what* — and a log that answers only half of it cannot be used to defend either half.
3. **Permission is the intersection of three things, evaluated per call.** The app's Registry limits, the app's Canon permissions, and the person's Canon permissions. Every gate narrows; none widens. This is the central guarantee of this document and section 4 is nothing but its consequences.
4. **Studio apps hold no data rights of their own.** They borrow them, per call, from the record. There is no grant to revoke separately, no cache to invalidate, and nothing an app retains when its passport is revoked or its person loses access.

## 2. Authentication: the passport, unchanged

Every Knowledge API request carries the app's Agent Passport in the `X-Agent-Passport` header. Canon presents it to the Registry's `POST /verify`, applies the answer's limits to the request in hand, and throws the answer away when it goes stale. The handshake, the certification check, the sixty-second revocation guarantee, the opacity of the passport, and the fail-closed behaviour on an unreachable Registry are all REGISTRY-CONTRACT.md sections 2, 3 and 5, and they are not restated here because restating a contract is how two copies of it start to disagree.

Three consequences worth naming out loud, because Studio makes them load-bearing:

- **The Registry is where an app is limited, and an administrator sets those limits without ever seeing the app's code.** An app answering benefits questions is given `permittedCollections: ["col-benefits"]` and `permittedActions: ["read"]`, and no amount of ambition in the app changes that.
- **Canon must also grant the app a role.** A passport gets an app through the door; Canon's own collection permissions decide what is behind it. An app that is certified, permitted every collection by the Registry, and a member of none in Canon reads nothing — as [server/test/knowledge.test.ts](server/test/knowledge.test.ts) demonstrates in both directions.
- **A request carries a person's identity or an agent's passport, never both.** `X-Actor-Id` remains the people's header and is refused alongside a passport that resolves to anyone else. `X-On-Behalf-Of` (section 3) is not an exception to that rule: it does not authenticate the person and grants nothing on its own. It names them.

## 3. Dual attribution

**`X-On-Behalf-Of` carries the Canon actor id of the person the app is acting for, and it is required on every Knowledge API call.**

Requiring it is a decision, not an oversight. "Both, always" has no force if one of the two may be left off at the caller's discretion, and an app with nobody behind it has no business on this surface: a nightly job that reconciles the record acts for itself and belongs on the agent surface, where it is one actor doing one thing. The Knowledge API is where an app acts *for someone*, so it always names them.

What the header does and does not do:

- **It does not authenticate the person.** The app authenticated them — that is Studio's job, in Studio's own session — and Canon takes the app's word for who it is acting for. This is not a hole; it is where the responsibility actually sits. An app that lied about its person would be lying while holding its own passport, and Canon's log records the lie against the app's name, permanently, in the same row.
- **It grants nothing.** Naming a person can only ever *narrow* what the app may do (section 4). There is no value of this header that widens the app's reach, including its own actor id.
- **It must name a person.** An actor Canon has never heard of is `on_behalf_of_unknown`; an actor of kind `agent` is `on_behalf_of_not_a_person`. An app may not act on behalf of another app, because a chain of apps borrowing each other's reach is exactly the permission-laundering the backbone document forbids elsewhere (DATA-BACKBONE.md section 6).

Attribution then splits cleanly and permanently:

| | Who is recorded |
|---|---|
| **History** — versions, drafts, comments, page ownership | the **app**, as an agent actor. It is what acted, and the record should say so plainly rather than dressing an app's work as a person's. |
| **Audit** — every Knowledge API call | the **app** as the event's actor, and the **person** in `details.onBehalfOf`. One query answers "everything this app did"; another answers "everything done for this person"; the pair answers "who did what, through what". |

## 4. The intersection

This is the guarantee. Everything else in this document is machinery for keeping it.

> **The effective permission of a Knowledge API call is the intersection of the app's Registry limits, the app's Canon permissions, and the person's Canon permissions.**
>
> **An app can never lend a person access the person does not have. A person can never lend the app access the app does not have. Neither can widen the Registry.**

Three gates, in series, no union among them. Concretely, for a call needing role *r* on collection *c*:

1. **The Registry gate.** `c` is in the app's `permittedCollections` (or that list is `["*"]`), and the action the route needs — `read`, `comment` or `write` — is in the app's `permittedActions`. Refused: `collection_not_permitted`, `action_not_permitted`, `route_not_available_to_agents`. This is REGISTRY-CONTRACT.md section 4, applied by the same code, before the handler runs.
2. **The person's gate.** The person named in `X-On-Behalf-Of` holds at least *r* on `c` in Canon. Refused: `person_not_permitted`, with `refusedBy: "person"`.
3. **The app's gate.** The app's own agent actor holds at least *r* on `c` in Canon. Refused: `app_not_permitted`, with `refusedBy: "app"`. This gate is not a separate check at all: the store call is made with the app's actor id, so Canon's ordinary permission model decides it exactly as it does for a person.

Where a call spans collections — a listing, a search, a grounded answer — the three gates become three narrowings of the candidate set rather than three refusals, following the rule REGISTRY-CONTRACT.md section 4.2 already established: nothing outside the limits reaches the caller, and narrowing keeps that guarantee without refusing a search because the record holds a collection somebody may not see.

`refusedBy` is in the response body for a reason. "My app cannot read this" and "the person my app is acting for cannot read this" are different problems with different fixes — one is an administrator's job in Canon or the Registry, the other is the person's own access request — and an operator who cannot tell them apart will guess.

### 4.1 Where the narrowing is applied, and why it matters

For anything that reaches a page directly, the order is Registry, then person, then app, and all three must pass. For anything that ranks or composes, the narrowing is applied **to the candidate set, before ranking and before generation** — never to the result afterwards.

This is DATA-BACKBONE.md section 5's rule, and Studio is precisely the case it was written for. Filtering citations after an answer is composed cannot un-leak what the answer text already merged: if a page the person may not see contributed a sentence to the prose, removing its citation removes the evidence, not the leak. So the person's permissions and the Registry's collection limit are carried into the same SQL that already bounds candidates by the app's permissions, and a page outside the intersection is never fetched, never scored, never quoted and never cited.

An empty limit means nowhere, not anywhere. An app whose `permittedCollections` is `[]` is answered nothing at all — the same direction the Registry contract takes everywhere: where the limits are silent, less, not more.

### 4.2 Cases the three gates do not decide on their own

- **The person named is the app itself, or another agent.** Refused (`on_behalf_of_not_a_person`) rather than treated as an app acting for itself. An app acting for itself uses the agent surface; conflating the two would make "an app can never lend a person access" trivially satisfiable by naming no person.
- **A route not in the Knowledge API's vocabulary.** Refused with Canon's ordinary `404`, because it is not mounted. This is fail-closed by construction: the Knowledge API is an allow-list of routes, so a route added elsewhere in Canon does not appear here until someone puts it here on purpose.
- **A page that carries federated references.** Resolution is not on this surface (section 7). A page's stored reference *descriptors* are ordinary page data; resolving them is `GET /pages/:id/references` on the agent surface, governed by `permittedSources` exactly as REGISTRY-CONTRACT.md section 4 says. When reference resolution joins the Knowledge API it will be a **fourth** gate in the same series — the source system's own access model, applied with the asker's identity — and never a union with the other three.
- **A person who can see a page the app may not.** Refused, and this is worth stating because it is the direction people find surprising. An app is not a lens the person looks through; it is a party to the call, with its own limits, and a person's breadth does not lend the app anything.

## 5. Per-call evaluation

**No session state. No cached grant. A permission change or a revocation is effective on the very next call.**

Nothing is minted at the Knowledge API's door. There is no app session, no bearer token derived from the passport, no remembered "this app may read Benefits", and no per-person grant object anywhere in Canon. Each call:

1. verifies the passport with the Registry — subject to the Registry contract's sixty-second cache ceiling and to nothing else;
2. resolves `X-On-Behalf-Of` to an actor row, freshly;
3. reads both actors' collection permissions from the record, freshly;
4. serves or refuses;
5. keeps nothing.

The arithmetic that follows is the point. A Canon permission change — adding or removing a member, raising or lowering a role, for either the app or the person — is effective **immediately**, on the next call, with no Registry round-trip involved at all. A Registry change — revocation, or narrowed limits — is effective within the same sixty seconds the Registry contract already guarantees, because the same cache and the same clamp govern it. An app that has been running happily for an hour and is revoked mid-conversation is refused on its next question, having had nothing to fall back on. `studio-stub`'s suite demonstrates each of these live.

A client that cached Canon's answers would quietly break this, so the reference client in [studio-stub/src/client.ts](studio-stub/src/client.ts) caches nothing, and says why in its own comments.

## 6. The read surface

Everything a Studio app may read, permission-filtered per call by all three gates.

- **Pages.** The page's structured fields plus its current published version. `read`.
- **Trees.** A collection's page tree, for navigation. `read`.
- **Versions.** The list of a page's immutable versions, and any one of them. `read`. This is what lets an app show *what the record said when the decision was made*, which is most of why history is append-only.
- **Search.** Full-text over the published record, with the collection, type, status and owner filters the record already supports. `read`.
- **Grounded answers.** `POST /knowledge/ask`, and it is the same `ask` Canon's own question box calls — not a parallel implementation with its own rules.

Grounded answers through this API obey DATA-BACKBONE.md section 5 **unchanged**: Canonical pages only, never a Draft and never a Note; every claim cites page and version; an answer with no citations is never returned; and when the filtered, expanded context does not answer the question, the answer is that the record does not say. Refusal is a correct answer, and an app that softened it into plausible prose would be the confident wrong answer the whole design is against.

What the read surface deliberately does **not** carry: drafts and the working layer, the audit log, notifications, import runs, the source register, and reference resolution. Some of those are governance surfaces that belong to an administrator rather than to an app; the rest are open questions (section 10), and the Knowledge API being an allow-list means none of them leaks in by accident.

## 7. The write surface

Where an app may write, **it writes as itself, with the person recorded, and everything lands under Canon's existing workflow.**

The surface is small on purpose: create a page, edit its draft, publish a version, submit it for review, and comment. Each needs `write` (or `comment`) from the Registry and the matching Canon role — `edit`, or `comment` for commenting — from **both** the app and the person.

Three things follow, and they are the whole of the guarantee:

- **An app cannot publish what a person could not.** If the person the app is acting for holds only `view`, the app's `edit` buys nothing: the draft is refused with `person_not_permitted`. The reverse holds identically.
- **No app grants the Canonical mark.** `approve` is not in this vocabulary at all. An app can carry work to the door of review — draft it, submit it — and a person grants the mark, in Canon, under the type's own rules. This is not distrust of apps; it is that approval is the act the whole trust layer rests on, and the record should be able to name the human who performed it.
- **Nothing bypasses the workflow.** The draft lock, the type rules (a Policy needs an owner and a named approver), the in-review gate, and the rule that a reviewed type returns to Draft after an ordinary publish are the store's, unchanged. An app meets the same refusals a person would, with the same `workflow` and `locked` codes.

Collection creation, member management, source administration and archival are not on this surface. An app composing the record is editorial work; admitting new containers and new governed objects is governance, and the split is the same one REGISTRY-CONTRACT.md section 4.2 draws for sources.

## 8. Audit

**Every Knowledge API call is an audit event naming the app, the person, and what was touched — including the calls that were refused.**

| Event | When |
|---|---|
| `knowledge.<operation>` | one per served call. `operation` is one of `whoami`, `collections`, `collection`, `tree`, `page`, `versions`, `version`, `search`, `ask`, `page_create`, `draft`, `publish`, `submit`, `comment`. |
| `knowledge.denied` | one per call refused inside the Knowledge API — the person's gate, the app's gate, or an attribution Canon would not accept — carrying `refusedBy` and the reason where Canon knows them. |
| `agent.session`, `agent.auth_failed`, `agent.denied` | the Registry gate's own events, unchanged from REGISTRY-CONTRACT.md section 5. `agent.denied` carries `onBehalfOf` when the refused call named a person, so a Registry refusal of a Studio call is still attributable to the person it was made for. |

Every one of these is attributed to the **app's** actor, with `actorKind: "agent"`, and every one carries:

```json
{
  "surface": "knowledge",
  "onBehalfOf": "<person actor id>",
  "personName": "Jo Patel",
  "app": "Benefits Assistant",
  "registryRef": "<Registry agentId>"
}
```

plus what the operation touched: `collectionId` and `pageId` where the call named one, the question and cited page ids for an ask, the query and hit count for a search. Canon's ordinary events — `page.publish`, `draft.start`, `comment.create`, `answer.ask`, `page.view` on restricted material — are written as they always are, attributed to the app, so an app's work is visible in the record's own history and not only in a Studio-shaped side channel.

Rule 1 of REGISTRY-CONTRACT.md admits no exception here either: no passport is ever written to the log, and a refusal Canon cannot attribute to a known agent is recorded against a one-way fingerprint of the presented passport.

## 9. Error semantics: fail closed

Every failure refuses the call. Canon distinguishes them because the app's operator, the person, and the compliance lead each need a different one of them.

Refusals of the whole request, decided before Canon's store sees it:

| Status | `error` | `reason` | Meaning |
|---|---|---|---|
| 401 | `unauthenticated` | `app_passport_required` | No `X-Agent-Passport`. This surface is for apps |
| 401 | `unauthenticated` | `on_behalf_of_required` | No `X-On-Behalf-Of`. Every call names its person |
| 401 | `unauthenticated` | `unknown_passport` | The Registry knows no agent by this passport |
| 403 | `forbidden` | `certification_lapsed` | Registered, not currently certified |
| 403 | `forbidden` | `revoked` | Certification was revoked. Terminal |
| 403 | `forbidden` | `identity_mismatch` | A passport and someone else's `X-Actor-Id` on one request |
| 403 | `forbidden` | `on_behalf_of_unknown` | No such actor in Canon |
| 403 | `forbidden` | `on_behalf_of_not_a_person` | The named actor is an agent |
| 403 | `forbidden` | `route_not_available_to_agents` | Not in the agent route vocabulary |
| 403 | `forbidden` | `action_not_permitted` | `permittedActions` does not carry this route's action |
| 403 | `forbidden` | `collection_not_permitted` | `permittedCollections` does not carry this collection |
| 503 | `unavailable` | `registry_unreachable` | The Registry did not answer. Fail closed, never cached |
| 503 | `unavailable` | — | No Registry is configured on this Canon at all |

Refusals decided inside the call, by the two Canon gates:

| Status | `error` | `reason` | `refusedBy` | Meaning |
|---|---|---|---|---|
| 403 | `forbidden` | `person_not_permitted` | `person` | The person does not hold the needed role here |
| 403 | `forbidden` | `app_not_permitted` | `app` | The app does not hold the needed role here |

Both carry `collectionId`, `needed` and `held` so the fix is obvious, and `person_not_permitted` carries `onBehalfOf`.

Canon's ordinary codes reach an app unchanged where the call got that far: `404 not_found`, `400 invalid`, `409 conflict`, `423 locked`, `422 workflow`. An app meets the workflow it would have met as a person.

Two rules sharpen all of this. First, Canon never converts "no answer" into a definitive refusal or, worse, into an allowance. Second, a refusal is *information* and never an empty result: a Studio app that renders "no results" where Canon said "you may not read this" is telling the person something false about the record, and the reference app in `studio-stub` renders the two differently on purpose.

## 10. Endpoints

Exact shapes. All requests and responses are JSON. Errors everywhere use Canon's envelope: `{ "error": "<code>", "message": "<human sentence>" }` plus the code-specific fields of section 9.

Every request below carries both headers:

```
X-Agent-Passport: vap_9f2c47a1…
X-On-Behalf-Of:   7c9e6679-7425-40de-963d-7806dca2f2f1
```

### `GET /knowledge/whoami`

The intersection as it currently stands. A derived view of the three gates, not a fourth one: it reports what they would decide, from the same data, evaluated now.

```json
{
  "app": {
    "actorId": "a1b2…", "registryRef": "7c9e…", "name": "Benefits Assistant",
    "permittedCollections": ["col-benefits"], "permittedActions": ["read"], "permittedSources": []
  },
  "person": { "actorId": "p-jo", "name": "Jo Patel" },
  "collections": [
    { "id": "col-benefits", "name": "Benefits", "appRole": "view", "personRole": "edit", "role": "view" }
  ],
  "evaluatedAt": "2026-07-31T09:14:02.113Z"
}
```

`role` is the narrower of `appRole` and `personRole`; a collection appears only when the Registry permits it and both actors hold a role in it. An empty `collections` is the honest report that this app can read nothing for this person.

### `GET /knowledge/collections`

Response `200`: an array of collections, narrowed by all three gates.

```json
[{ "id": "col-benefits", "name": "Benefits", "description": "", "restricted": false,
   "createdAt": "2026-07-30T12:00:00.000Z", "archivedAt": null }]
```

### `GET /knowledge/collections/:id`

Response `200`: one collection, in the shape above.

### `GET /knowledge/collections/:id/tree`

Response `200`: the collection's page tree — pages with a `children` array, archived pages excluded.

```json
[{ "id": "pg-1", "collectionId": "col-benefits", "parentId": null, "position": 0,
   "type": "policy", "title": "Prescription coverage policy", "status": "canonical",
   "ownerId": "p-dana", "approverId": "p-iris", "effectiveDate": null,
   "currentVersion": 1, "createdBy": "p-dana", "createdAt": "…", "children": [] }]
```

### `GET /knowledge/pages/:id`

Response `200`: the page's structured fields and its current published version (`null` when nothing is published).

```json
{
  "id": "pg-1", "collectionId": "col-benefits", "parentId": null, "position": 0,
  "type": "policy", "title": "Prescription coverage policy", "status": "canonical",
  "ownerId": "p-dana", "approverId": "p-iris", "effectiveDate": null,
  "currentVersion": 1, "createdBy": "p-dana", "createdAt": "…",
  "current": {
    "pageId": "pg-1", "number": 1, "title": "Prescription coverage policy",
    "body": "Generic prescriptions are covered at 100 percent…",
    "fields": { "ownerId": "p-dana", "approverId": "p-iris", "effectiveDate": null },
    "authorId": "p-dana", "note": "Approved as Canonical", "createdAt": "…"
  }
}
```

### `GET /knowledge/pages/:id/versions` and `GET /knowledge/pages/:id/versions/:n`

Response `200`: the array of versions, or one version, in the `current` shape above.

### `GET /knowledge/search?q=…`

Optional `collection`, `type`, `status`, `owner`, `limit`.

```json
[{ "pageId": "pg-1", "title": "Prescription coverage policy", "collectionId": "col-benefits",
   "type": "policy", "status": "canonical", "ownerId": "p-dana",
   "snippet": "Generic <mark>prescriptions</mark> are covered…" }]
```

### `POST /knowledge/ask`

Request:

```json
{ "question": "How are generic prescriptions covered?", "collectionId": "col-benefits", "limit": 8 }
```

`collectionId` and `limit` are optional. Response `200` — the answer contract of DATA-BACKBONE.md section 5, one shape, shared with Canon's own question box:

```json
{
  "answer": "The record says:\n\n“Generic prescriptions are covered at 100 percent…” — Prescription coverage policy (version 1)",
  "citations": [
    { "pageId": "pg-1", "title": "Prescription coverage policy", "version": 1,
      "snippet": "Generic prescriptions are covered at 100 percent after the annual deductible is met.",
      "status": "canonical" }
  ],
  "refused": false
}
```

Three fields on that response are optional, present only when they have something to say, and were being returned before they were written down here. They are documented now because an integrator who cannot see them in the contract will either ignore them or, worse, invent a default for them:

**`citations[].status`** — the standing of the page the snippet was quoted from: `canonical`, or `needs_update` when that page is past its review date. Those are the only two values an answer can cite (a Draft, a Note and an archived page are never cited at all), and both are official record. Show it. **Absent means this response cannot say, never `canonical`.** An app that fills a missing status in with the mark that means "approved and current" is making the single most trust-bearing claim in the product on no evidence; render nothing and let the reader click through instead. Canon's own Ask view shipped that default for a while and printed CANONICAL over pages its own answer text was calling past review.

**`pastReview`** — `[{ "pageId": "pg-1", "title": "…" }]`, the cited pages that are past their review date, omitted entirely when there are none. It is the same fact as a `needs_update` status, pre-filtered so an app can flag the answer as a whole without walking the citations. The answer prose says it too, in words; this is the machine-readable half, and an app that renders only the prose is still correct.

**`disagreement`** — `{ "pageIds": ["pg-1", "pg-4"], "note": "…" }`, present when the cited passages contradict each other (DATA-BACKBONE.md section 7). `pageIds` names every page whose passage took part, always at least two and always a subset of this answer's citations. `note` is one reader-facing paragraph naming the pages and quoting the parts that differ, and it is **also embedded verbatim in `answer`** — so an app that renders only the prose still shows the warning and an app that renders only this field still shows it too. Canon has not chosen between the pages and an app must not either: showing one side and dropping the other is the smoothing that section forbids, and it does not become acceptable because it reads better.

Response `200`, refused — the honest response to a silent record, and the one we would rather ship than a plausible guess:

```json
{ "answer": null, "citations": [], "refused": true, "reason": "no_canonical_match" }
```

A refusal is `200`: the call succeeded and the record had nothing to say. A `403` here means something else entirely — one of the three gates closed — and an app must not render the two the same way.

**Four optional fields may accompany an answer.** Each is present only when it applies, so the shape above is what an ordinary answer looks like and an app that has never heard of these reads exactly what it always read. Each is also stated in the `answer` prose verbatim, so an app that renders only the text still shows the warning — these fields are the machine-readable half, for an app that wants to render it as something other than a paragraph. **None of them may be dropped in rendering.** DATA-BACKBONE.md section 7 is explicit that an answer must never smooth a contradiction, and an app that showed the citations while discarding the warning attached to them would be doing exactly that, with Canon's name on it.

| Field | Shape | Present when |
|---|---|---|
| `pastReview` | `[{ pageId, title }]` | a cited page is past the review date its owner set. It is still the official record; it has not been re-approved recently. |
| `disagreement` | `{ pageIds, note, asserted? }` | two cited pages give different answers — because their text does, or because a **person asserted** a `conflicts_with` relation between them. `pageIds` is always at least two and always cited. `asserted` is present only when a person is behind it, and carries who said so, when, and in what words. Canon does not choose between the pages, and neither should an app. |
| `supersession` | `{ pageIds, asserted, note }` | the answer quotes a page the record says was **replaced**, beside the page that replaced it. The superseded page stays cited: a supersession does not archive it or change its status, so dropping the quotation would hide the change rather than show it. |
| `sourceDisagreement` | `{ pageIds, open, note }` | a cited page carries an **open divergence** between its authoritative source and a corroborating one. This is two systems disagreeing about one page's federated values, which is not the same thing as two pages contradicting each other — it is a separate field so that an app never has to guess which of the two it is showing. |

### `POST /knowledge/pages`

Request: `{ "collectionId": "col-benefits", "parentId": null, "type": "note", "title": "Open enrolment FAQ" }`. Response `200`: the page, in the shape above, with `createdBy` set to the **app's** actor id.

### `PUT /knowledge/pages/:id/draft`

Request: `{ "title": "…", "body": "…", "fields": { "ownerId": "…", "approverId": "…", "effectiveDate": "…" } }` — all optional; present fields replace. Response `200`:

```json
{ "pageId": "pg-1", "title": "…", "body": "…", "fields": { … },
  "editorId": "<the app's actor id>", "baseVersion": 1, "updatedAt": "…" }
```

`editorId` is the page lock, and it holds the app: one editor at a time, app or person, with no special case for either.

### `POST /knowledge/pages/:id/publish`

Request: `{ "note": "Drafted by the assistant" }` — optional. Response `200`: the page. A reviewed type returns to `draft` status; publishing never grants the Canonical mark.

### `POST /knowledge/pages/:id/submit`

Response `200`: the page, `status` now `in_review`. Approval happens in Canon, by a person.

### `POST /knowledge/pages/:id/comments`

Request: `{ "body": "Checked against the handbook.", "anchor": { "quote": "…", "context": "…" } }` — `anchor` optional. Response `200`:

```json
{ "id": "cm-1", "pageId": "pg-1", "authorId": "<the app's actor id>", "authorKind": "agent",
  "body": "Checked against the handbook.", "anchor": null,
  "resolvedAt": null, "resolvedBy": null, "createdAt": "…" }
```

`authorKind: "agent"` is not decoration. An app's comment should read as an app's comment wherever it appears.

## 11. Open questions

- **Non-Canonical material for working tools.** DATA-BACKBONE.md section 9 leans absolute for answers and permitted-with-attribution for working tools, and this contract implements the first half only: the read surface carries no drafts, so an app that helps a team work on drafts cannot yet be built. Resolve with the first Studio design partner who wants one; the shape it would take is a `draft` action in the Registry's vocabulary rather than a widening of `read`, so nothing here forecloses it.
- **Reference resolution through the Knowledge API.** Federated values are how a benefits app answers "what is my deductible" rather than "what does the policy say about deductibles", so this is the most likely next addition. It arrives as a fourth gate in the same series — `permittedSources` from the Registry, the page's own readability, and the source system's access model resolved with an identity — and the open question is *whose* identity a source sees when an app asks for a person: the person's, the app's, or the deployment's service identity. It is DATA-BACKBONE.md section 9's first open question, one layer further out, and it should be answered the same way.
- **Whether an app may act for a group rather than a person.** A dashboard shown to a whole team has no single person behind it. The honest answers are "then it is not acting for anyone, and belongs on the agent surface" or "the group is an actor, and Canon's permission model already handles it". Leaning strongly on the first, because the second re-introduces a shared identity, which is the thing attribution exists to prevent.
- **Rate and volume limits.** Nothing here bounds how much of the record an app may read per person per day. Permission is not the same question as volume, and an app that is entitled to every page is still capable of exfiltrating every page one permitted call at a time. This wants a limit in the Registry alongside `permittedCollections`, not a check in Canon's handlers, and it should be resolved when a design partner asks the question a compliance lead will certainly ask.

---

*Naming per the brief: Veryl Canon, Veryl Studio and Veryl Agent Registry in full on first mention and in headings; Canon, Studio and the Registry once inside context.*
