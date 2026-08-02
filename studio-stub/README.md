# Benefits Assistant — a Veryl Studio app

A small standalone service that stands in for the kind of app Veryl Studio exists to let anyone build: a question-answering assistant over the company's own benefits policies. It is the thing that proves [STUDIO-CONTRACT.md](../STUDIO-CONTRACT.md) works end to end — the app authenticates to Veryl Canon with an Agent Passport, asks on behalf of a named person, and renders the cited answer.

Everything that makes it approvable is in the contract rather than in this codebase, which is the point:

- **It stores no company knowledge.** There is no index here, no cache, no copy of a page. Every question is one live call to Canon's Knowledge API.
- **It has no permission model.** It never decides who may see what. It names the person and lets Canon's three gates decide.
- **It cannot show what the person could not have read themselves**, and it cannot show what it was not itself permitted to read. Those are not this app's good behaviour; they are Canon's refusals, and this app could not defeat them if it tried.
- **When the record is silent, it says so.** There is no branch in [`src/render.ts`](src/render.ts) that produces answer-shaped prose out of anything but Canon's own citations.

## The two identities on every call

```
X-Agent-Passport   the app's Agent Passport, issued by the Veryl Agent Registry
X-On-Behalf-Of     the Canon actor id of the person the app is acting for
```

Both, always. Canon evaluates the intersection of the app's Registry limits, the app's Canon permissions, and that person's Canon permissions, per call, and records both actors in the audit log. An app can never lend a person access the person does not have; a person can never lend the app access the app does not have.

The app is an agent, so [`src/client.ts`](src/client.ts) is the whole of its dependency on Canon: two headers and four endpoints. It caches nothing — deliberately, because the contract's guarantee is that a permission change or a revocation is effective on the *very next call*, and a client that remembered what it was told last time would quietly break it.

## What it implements

Its own face, in the shape [registry-stub](../registry-stub) and [source-stub](../source-stub) use:

| | |
|---|---|
| `POST /ask` | `{ "question": "…", "person": { "actorId": "…", "name": "…" }, "collectionId": "…"? }` → the answer, its citations, and a rendering. |
| `GET /find?person=…&q=…` | What this app can find for this person. |
| `GET /whoami?person=…` | The intersection as it currently stands: the app's Registry limits, and every collection with the app's role, the person's role, and the narrower of the two. |
| `GET /health` | Liveness. |

There are exactly three outcomes of `POST /ask`, and the app is honest about which one it is in:

| | `refused` | `citations` | `error` | Rendered as |
|---|---|---|---|---|
| A cited answer | `false` | one or more | absent | the answer, then its sources |
| The record is silent | `true` | empty | absent (`reason: no_canonical_match`) | "The record does not say (no_canonical_match)." |
| This app can read nothing | `true` | empty | absent (`reason: nothing_readable`) | "No answer: this app can read nothing for you." |
| Canon refused the call | `true` | empty | present | "No answer: *who* does not have access…" |

The last row is the one that matters for trust. A refusal is *information* — the person is entitled to know that something exists which they, or the app, may not read — and it is never softened into "I could not find much, but generally…".

The third row exists because of the row above it. "The record does not say" is a claim about the company's record, and an app that made it because *its own* administrator never granted it a collection would be telling somebody something false about their employer's policies (USER-TESTING.md T3.7). Canon distinguishes the two, and so does this app: `nothing_readable` names a configuration problem, points at `whoami`, and never blames the record.

Honest liberties of a test double, the same ones registry-stub and source-stub take: state is in-memory (there is none), and the app's own caller is unauthenticated — a real Studio deployment authenticates its users and derives `person` from the session. The liberty is stated rather than hidden: an app that lied about who it was acting for would be lying to Canon, and Canon's audit log would faithfully record the lie against the app's own name.

## Running it

Node 22+, zero runtime dependencies (`node:http`, `node:test`, and the platform `fetch`).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + drive Canon and the registry-stub in-process, end to end
              # (runs with CANON_DEV_AUTH=true: the people the app acts for are
              #  seeded through Canon's dev door, which is off by default)
npm start     # serve on :3300 (PORT to override)
```

Configuration is the whole of this app's state:

| | |
|---|---|
| `STUDIO_PASSPORT` | The app's Agent Passport. Required. |
| `CANON_URL` | Canon's base URL. Default `http://127.0.0.1:3000`. |
| `STUDIO_APP_NAME` | Display name. Default `Benefits Assistant`. |
| `STUDIO_TIMEOUT_MS` | Per-call timeout. Default 5000. |

The test build compiles Canon and the registry-stub so the suite can boot all three services in-process — the same pairing a demonstration runs against real deployments, with only the base URLs differing. The app itself imports nothing from either: it is an outside caller and must stay one, which is why [`src/model.ts`](src/model.ts) declares the wire shapes rather than importing Canon's types.

## A worked example

The Registry on `:3100`, Canon on `:3000`, this app on `:3300`.

**1. Register the app in the Veryl Agent Registry and certify it.** A Studio app is an agent; identity and standing are the Registry's, exactly as [REGISTRY-CONTRACT.md](../REGISTRY-CONTRACT.md) says.

```sh
curl -s :3100/agents -d '{
  "name": "Benefits Assistant",
  "permittedCollections": ["col-benefits"],
  "permittedActions": ["read"]
}'
# -> { "agentId": "7c9e…", "passport": "vap_9f2c47a1…", "certification": { "state": "pending", … } }

curl -s :3100/agents/7c9e…/certify -X POST -d '{}'
```

The passport appears once, there, and never again. Note the app is limited to one collection in the Registry — an app answering benefits questions has no business reading Legal, and that limit is set by an administrator who has never seen this app's code.

**2. Give the app a role in Canon.** The Registry's grant is only one of three gates; Canon's own permissions are the second. First contact provisions the app's actor:

```sh
curl -s :3000/collections -H 'X-Agent-Passport: vap_9f2c47a1…'
# [] — authenticated, and permitted nothing yet

curl -s :3000/actors -H 'X-Actor-Id: person-admin' | grep -A2 'Benefits Assistant'
# -> { "id": "actor-app", "kind": "agent", "registryRef": "7c9e…", … }

curl -s :3000/collections/col-benefits/members/actor-app -X PUT \
  -H 'X-Actor-Id: person-admin' -d '{"role":"view"}'
```

`view`, not `edit`. This app answers questions; it does not write.

**3. Start the app.**

```sh
STUDIO_PASSPORT=vap_9f2c47a1… CANON_URL=http://127.0.0.1:3000 npm start
```

**4. Ask it something, for someone.**

```sh
curl -s :3300/ask -d '{
  "question": "How are generic prescriptions covered?",
  "person": { "actorId": "person-jo", "name": "Jo Patel" }
}'
```

```
Benefits Assistant — answering for Jo Patel
Q: How are generic prescriptions covered?

The record says:

"Generic prescriptions are covered at 100 percent after the annual deductible is met."
  — Prescription coverage policy (version 1)

Sources
  1. Prescription coverage policy — version 1 (page 4f0e…)

Answered by Benefits Assistant on behalf of Jo Patel. Every page cited above was
read with both identities in force; nothing outside their permissions reached
this answer.
```

**5. Ask the same question for someone else, and watch the intersection do the work.** Ada is not a member of the Benefits collection in Canon.

```sh
curl -s :3300/ask -d '{
  "question": "How are generic prescriptions covered?",
  "person": { "actorId": "person-ada", "name": "Ada" }
}'
```

```
Benefits Assistant — answering for Ada
Q: How are generic prescriptions covered?

No answer: this app can read nothing for you.

That is not the record being silent — Benefits Assistant and Ada between them hold no
readable collection, so there was nowhere to look. Someone with administrator access
needs to grant one, in Canon or in the Veryl Agent Registry. "Who am I" reports exactly
which of the two is missing.
```

Same app, same passport, same question, same second. The app did not choose to withhold anything, and could not have chosen otherwise: Canon filtered the candidates by Ada's permissions before anything was ranked, so the policy never entered the context the answer was composed from.

Note what is *not* said. Canon did not tell this app that a Benefits collection exists, that it holds a prescription policy, or that Ada is one grant away from reading it — an app that named none of the record's containers is told nothing about them. What it is told is a fact about **Ada and this app**: between them they hold nothing readable, which is the same fact `whoami` hands the same caller in full, and which is the difference between a misconfigured app and a thin corpus.

Ask the same question for a person who *does* hold Benefits but about something nobody has written down, and the answer is the other sentence — "The record does not say (no_canonical_match)."

**6. Ask why.**

```sh
curl -s ':3300/whoami?person=person-ada'
```

```
App:    Benefits Assistant (Registry 7c9e…, Canon actor actor-app)
Person: Ada (person-ada)
Registry limits: collections col-benefits; actions read

Effective collections (app role ∩ person role, inside the Registry's limits):
  (none — the intersection is empty, so this app can read nothing for this person)

Evaluated at 2026-07-31T09:14:02.113Z. Nothing above is cached; the next call re-evaluates all three.
```

**7. Revoke the app, and ask again.**

```sh
curl -s :3100/agents/7c9e…/revoke -X POST -d '{"reason":"withdrawn from Studio"}'

curl -s :3300/ask -d '{"question":"How are generic prescriptions covered?",
                       "person":{"actorId":"person-jo","name":"Jo Patel"}}'
```

```
Benefits Assistant — answering for Jo Patel
Q: How are generic prescriptions covered?

No answer: The Veryl Agent Registry does not permit Benefits Assistant here.
Canon said: forbidden — Certification has been revoked
```

Nothing was restarted, no credential was rotated, and no cache was cleared. The app had no data rights of its own to lose — it borrows them, per call, from the record.

**8. Read the audit log.** One call in, one event, two actors.

```sh
curl -s ':3000/audit?action=knowledge.ask' -H 'X-Actor-Id: person-admin'
# [ { "actorId": "actor-app", "actorKind": "agent", "action": "knowledge.ask",
#     "collectionId": null, "details": { "surface": "knowledge",
#       "onBehalfOf": "person-jo", "personName": "Jo Patel",
#       "app": "Benefits Assistant", "registryRef": "7c9e…",
#       "question": "How are generic prescriptions covered?",
#       "refused": false, "citedPageIds": ["4f0e…"] } } ]
```

"Who did what, through what", in one row.
