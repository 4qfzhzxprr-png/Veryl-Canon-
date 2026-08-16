# Veryl Canon — configuration reference

Every environment variable Canon reads, in one table, gathered from the code
rather than from memory. Nothing else configures Canon: there is no
configuration file, no database-held settings, and no runtime toggles. A
deployment is its environment, which is what makes it reviewable.

**That claim is now enforced rather than asserted.** A test scans `server/src`
and `server/scripts` for every `CANON_…` name the code reads and fails if one of
them is missing from this page (`server/test/operations.test.ts`, "every
variable the code reads is named in CONFIGURATION.md"). The page had drifted
before — USER-TESTING.md T3.5 found six variables missing from a document that
said it was complete, and both testers had *trusted* it, which is what made the
gap expensive. A promise of completeness is only worth making if something
breaks when it stops being true.

Read this with [OPERATIONS.md](OPERATIONS.md) (how to run it) and
[SECURITY.md](SECURITY.md) §5 (the assumptions a deployment must keep true).
The **Safety** column names the §5 assumption where one applies.

## How to read the columns

- **Required?** — `required` means a real deployment must set it;
  `required if` means it becomes required once something else is set;
  `optional` means the default is the right answer for most deployments;
  **`dev only`** means it must not appear in a deployment at all.
- **Default** — what the code does when the variable is unset, not what a
  sensible person would choose.
- **Secret?** — a `yes` here means the value is a credential. Canon never logs
  these: `src/log.ts` replaces them by name, and any URL it prints has its
  userinfo stripped.

Canon **refuses to start** on several combinations of these; each refusal names
the variable to change. See "Start-up validation" at the end.

---

## The record and the process

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_DB` | required | `canon.db` | Path to the SQLite file that **is** Canon: the record, the version history and the audit log. In a container this must point inside the mounted volume (`/data/canon.db`), or the record dies with the container. | The audit log has no second copy. Back it up — OPERATIONS.md, "Back up". |
| `PORT` | optional | `3000` | TCP port to listen on. | Bind behind a reverse proxy that terminates TLS; Canon speaks plain HTTP. |
| `CANON_BIND` | optional | loopback while dev auth is the only door, otherwise all interfaces | The network interface to bind. Unset, Canon binds to `127.0.0.1` when `CANON_DEV_AUTH=true` is the only door open, and to `0.0.0.0` once a real door (SSO or the Registry) is configured. Set it to `0.0.0.0` or a specific address to override. | The unverified `X-Actor-Id` header must never reach a network: Canon **refuses to start** if `CANON_DEV_AUTH=true` is set alongside a non-loopback `CANON_BIND`. Turn dev auth off and configure SSO for a door you can safely expose. |
| `CANON_BASE_URL` | required | `http://localhost:3000` | Where Canon is reachable from a browser. Deep links in notification emails are built from it, and the OIDC redirect URI defaults to `<base>/auth/callback`. Also decides whether the session cookie gets `Secure` (on unless the base URL is plain `http`). | An `http://` base URL with SSO live means session cookies cross the network in clear. |
| `CANON_PRODUCT_NAME` | optional | `Veryl Canon` | The name in the footer of notification emails. | — |
| `CANON_SHUTDOWN_TIMEOUT_MS` | optional | `10000` | How long in-flight requests get to finish after SIGTERM before the process stops waiting. Keep it below your orchestrator's kill delay (`docker stop` allows 10s by default; the demo compose file raises the grace period to 20s). | — |
| `CANON_LOG_LEVEL` | optional | `info` | `debug`, `info`, `warn`, `error`. At `info` this includes one line per request; at `warn` only the `5xx` ones survive; at `debug` the readiness and liveness probes join them. | — |
| `CANON_LOG_FORMAT` | optional | `json` | `json` (one object per line, for a log collector) or `text` (for a person at a terminal). | — |
| `CANON_REQUEST_LOG` | optional | `on` | `off` drops the per-request line entirely, for a deployment whose reverse proxy already writes one. The level above is the finer dial. | The line carries the method, the **path only**, the status, the duration, the actor id and a `500`'s correlation id. Never the query string, never a header, never a body — OPERATIONS.md, "Read the logs", says why in full. |
| `CANON_RECORD_WATCH_INTERVAL_MS` | optional | `10000` | How often Canon asks itself whether it can still read its own record, and logs an error if it cannot. `0` turns the watch off and leaves the answer to whoever probes `GET /ready`. | With it off, a record that becomes unreadable is discovered by the next readiness probe and by nothing else. A process with **no** readiness probe pointed at it then fails in silence, which is exactly USER-TESTING.md T3.3. |
| `CANON_SKIP_DNS_CHECK` | optional | unset | `true` skips the start-up DNS check on `CANON_SOURCE_ALLOWED_HOSTS`. For an air-gapped or split-horizon network where the name genuinely does not resolve from here. | Skipping it means an unreachable source is discovered at read time instead. |
| `CANON_UI` | optional | `classic` | Which web client Canon serves at `/`. `classic` is the original one; `react` is its replacement, which is being built route by route (`web/MIGRATION.md`). Both ship in every image, so this is a run-time decision and switching it back is a redeploy, not a rebuild. | Asking for `react` in an image built without it serves `classic` instead and **logs an error naming this variable** — a Canon serving the old UI is a working Canon, so this degrades rather than refusing to start. Any value that is neither word warns at start-up and serves `classic`. |

### While the two clients coexist

`CANON_UI=react` does not mean every screen is the new one. The React client
has taken over the routes listed in `web/src/routes/index.ts` and hands every
other one back to the original client at `/classic.html`, which serves it
exactly as before. Crossing between them is a page load; nobody is signed out,
because both are the same origin and share the session cookie.

`/classic.html` is served whatever `CANON_UI` says, on purpose — it is the way
back, and a way back that depends on the setting is missing when it is needed.

**To roll back:** unset `CANON_UI` (or set it to `classic`) and redeploy. There
is no data involved and nothing to undo; the record never knew which client was
in front of it.

## Identity: people

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_DEV_AUTH` | **dev only** | unset | `true` accepts the `X-Actor-Id` header, **verifying nothing**: anyone who can reach the port is any actor they name, and `POST /actors` exists. This is what the test suite runs under. | **SECURITY.md §5, assumption 1: the one thing a deployment must get right is not setting this.** Canon refuses to start if it is set alongside `CANON_OIDC_ISSUER`. |
| `CANON_OIDC_ISSUER` | required | unset | The organization's OpenID Connect provider. Setting it turns single sign-on on; unset, people cannot sign in. Discovery is read from `<issuer>/.well-known/openid-configuration` and **must name the same issuer**. | §5 assumption 1: never point this at `idp-stub`, which authenticates nobody. |
| `CANON_OIDC_CLIENT_ID` | required if issuer | unset | The client Canon is registered as at the provider. | — |
| `CANON_OIDC_CLIENT_SECRET` | required if issuer | unset | **Secret.** Authenticates the token call with `client_secret_basic`. | Rotate it at the provider and here together — OPERATIONS.md, "Rotate secrets". |
| `CANON_OIDC_REDIRECT_URI` | optional | `<CANON_BASE_URL>/auth/callback` | Register it at the provider verbatim. | — |
| `CANON_OIDC_SCOPE` | optional | `openid profile email` | — | — |
| `CANON_OIDC_CLOCK_TOLERANCE_SEC` | optional | `60` | Skew allowed on `exp`/`nbf`/`iat`. | A large tolerance extends the life of a stolen token. |
| `CANON_OIDC_TIMEOUT_MS` | optional | `5000` | How long to wait for the provider. | — |
| `CANON_SESSION_SECRET` | required if issuer | invented per process | **Secret.** HMAC key the session cookie is signed with. Without one, every restart signs everybody out and a second instance cannot read the first's cookies. | §5 assumption 1 names this as the second thing to get right. Canon refuses to start with SSO configured and no secret. |
| `CANON_SESSION_TTL_MS` | optional | `28800000` (8h) | Idle lifetime, renewed on use. | — |
| `CANON_SESSION_MAX_LIFETIME_MS` | optional | `86400000` (24h) | The ceiling no renewal passes. | Bounds SECURITY.md R9: a session outlives a revocation at the provider by at most this. |
| `CANON_COOKIE_SECURE` | optional | on unless `CANON_BASE_URL` is plain `http` | Force the cookie's `Secure` flag on or off. | Only ever set to `false` locally. |
| `CANON_SESSION_CONFIRM_MS` | optional | `60000`, and **clamped to 60000** | How long a session may be served without being re-confirmed against the identity provider (SECURITY.md R9). `0` confirms on every request. | This is the **revocation guarantee for people**, not a tuning knob — the same sentence `CANON_REGISTRY_TTL_MS` is for agents. A larger number is silently clamped, because a guarantee a deployment can raise is not one. |
| `CANON_ALLOWED_ORIGINS` | optional | the redirect URI's own origin | Extra origins a cookie-authenticated write may come from (CSRF). Comma- or space-separated. | Each entry is a site you are trusting to make writes on a signed-in person's behalf. |

## The first administrator

Somebody has to be able to grant the first role, and there is nobody to ask for
permission to do it — the authority being granted *is* the thing being granted.
Canon solves it two ways, and a deployment should use the first (orgrole.ts,
"Bootstrap"). With neither set **and no administrator in the record**, the first
person to sign in becomes one, loudly and once.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_BOOTSTRAP_ADMIN_SUBJECT` | recommended | unset | Names a person **at the identity provider** — their `sub` claim, or `issuer#sub`. Comma- or space-separated. On every sign-in and every confirmation they are (re-)made an administrator. | The safe answer, and the one to use: it grants nothing to whoever arrives first, it is idempotent, and it cannot lock you out, because it is re-asserted rather than applied once. Setting it closes the first-person window permanently. |
| `CANON_BOOTSTRAP_ADMIN_ACTOR_ID` | **dev only** | unset | Names an actor **by Canon id**, and makes them an administrator at start-up. Comma- or space-separated. An id this record does not hold is a start-up failure with a sentence in it, not a silent no-op. | The dev door's bootstrap, for a record running on `X-Actor-Id` with no provider to name a subject at. A deployment with SSO uses `CANON_BOOTSTRAP_ADMIN_SUBJECT`. Naming `system:canon` is refused — Canon holds no role and cannot administer anything. |

## Mapping directory groups onto roles

Optional (SECURITY.md R10). Unset, nobody holds anything they were not granted
by hand. One rule per line (or separated by `;`), `#` starts a comment, and group
names are compared exactly — they may contain spaces and commas, which is why the
separator is a line:

```
# who edits the Compliance collection
Canon-Compliance-Editors -> collection:8f14…:edit
Canon-Compliance-Leads   -> collection:8f14…:admin
Canon-Operators          -> org:operator
```

A rule naming a collection or a role that does not exist is a **start-up
failure**, so a typo is never a person quietly holding less than you granted.
`GET /auth/mapping` reads back what is live; `GET /auth/access/:actorId` says why
somebody holds what.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_OIDC_GROUPS_CLAIM` | optional | `groups` | Which ID-token claim carries the person's groups. A claim that is absent, or is not a list of strings, reads as **no groups** rather than being guessed at. | Everything below is downstream of this claim, so it is downstream of your provider's group hygiene. |
| `CANON_GROUP_MAP` | optional | unset = no mapping | The rules, inline, in the syntax above: `<group> -> collection:<id>:<role>` for collection access, or `<group> -> org:operator` / `org:administrator` for an organisation role. | A group mapped to `org:administrator` means **anyone your provider puts in that group can administer permissions here**; Canon prints that warning by name at start-up. Group grants are stored separately from hand grants and recomputed on every confirmation, so removing a group removes exactly what it granted and leaves a hand grant underneath standing. |
| `CANON_GROUP_MAP_FILE` | optional | unset | A file of the same rules, appended to whatever `CANON_GROUP_MAP` holds. For a mapping too long to live in an environment variable. | Unreadable is a refusal, not an empty mapping: a mapping that silently became nothing is a room full of people who quietly lost their access. |

## Identity: agents

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_REGISTRY_URL` | required for agents | unset | The Veryl Agent Registry. Setting it turns Agent Passport authentication on; unset, a passport is refused `503`. | §5 assumption 4: a compromised Registry is a compromised Canon for every agent. |
| `CANON_REGISTRY_API_KEY` | recommended with `CANON_REGISTRY_URL` | unset | Credential Canon presents to the Registry's verification face, as a bearer token. Unset, the channel is an anonymous HTTP call and start-up warns about it. | A Registry that refuses the missing key reads as "no usable answer" — agents are denied, never admitted. This authenticates the caller; confidentiality on the path is still the TLS proxy's job. |
| `CANON_REGISTRY_TTL_MS` | optional | `30000` (clamped to 60s) | How long a verified answer may be reused. `0` re-verifies every request. | This is the revocation guarantee: revoking an agent cuts its access within this. |
| `CANON_REGISTRY_TIMEOUT_MS` | optional | `3000` | How long to wait for the Registry before failing closed. | An unreachable Registry is a `503`, never an allowance. |

## Email and notifications

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_SMTP_URL` | optional | unset (dev transport logs instead) | **Secret** — it carries the relay password in its userinfo. `smtp://user:pass@relay:587` upgrades with STARTTLS (required whenever credentials are present); `smtps://` is TLS from the first byte. Flags: `?starttls=required\|opportunistic\|off`, `?insecure=true`, `?name=`, `?timeout=`. | Never logged: SECURITY.md F7 removed the one place it was echoed, and `log.ts` now strips userinfo from every string it prints. |
| `CANON_MAIL_FROM` | required if SMTP | unset | Sender, e.g. `Veryl Canon <canon@example.com>`. Canon refuses to start with a relay and no sender. | CR/LF/NUL are rejected in every header value (F4). |
| `CANON_FLUSH_INTERVAL_MS` | optional | `60000` | How often the built-in outbox delivery pass runs. `0` turns it off and hands delivery to your own scheduler calling `POST /notifications/flush`. | With it off and no scheduler, **nothing is ever delivered** — see OPERATIONS.md, "The timers". |

## Federation: which hosts Canon may reach

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_SOURCE_ALLOWED_HOSTS` | required for federation | unset = **nothing is reachable** | Comma- or space-separated allowlist. Each entry is `host`, `host:port` or `*.domain`; a full URL is reduced to its host. | §5 assumption 2: everything on this list is something you are asserting is safe for Canon to fetch and follow redirects within. Canon refuses to start if a named host does not resolve. |
| `CANON_SOURCE_ALLOWED_SCHEMES` | optional | `https,http` | Set to `https` alone wherever the record systems support it. | Plain `http` leaves the network path between Canon and the source unprotected. |
| `CANON_SOURCE_ALLOW_PRIVATE` | **dev only** | unset | `true` permits loopback, link-local and private ranges — including the cloud metadata address `169.254.169.254`. | §5 assumption 2 / F1. This is what lets the test suite reach a stub on `127.0.0.1`. A deployment leaves it unset. |
| `CANON_SOURCE_SERVICE_IDENTITY` | required for `service` sources | unset | The identity a `service`-mode source is resolved with. Absent, a service source fails visibly rather than resolving anonymously. | §5 assumption 7: Canon stores no credential for a source. This is an identity, and any credential belongs in the connector's own configuration. |
| `CANON_SOURCE_TIMEOUT_MS` | optional | `3000` | Bounds the whole exchange: connect, handshake, headers and body. | — |

## Semantic retrieval: which embedding model, and where it runs

Leave all of this unset and Canon uses its built-in provider: a hashed bag of
words, computed in this process, with nothing installed and nothing sent
anywhere. It is honest about what it is not — it has no notion of synonymy, so
a question asked in words the record does not use will not reach the page that
answers it. Retrieval still works; the lexical channel and the graph carry it.

Setting these turns on a real model, and that is a decision with a cost either
way: `http` sends the record's published text to another machine, and
`transformers` adds a large optional dependency and several hundred megabytes of
weights. Neither should happen because a config file was copied.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_EMBEDDINGS` | optional | `local` | `local` (built in), `http` (an OpenAI-compatible `/v1/embeddings` endpoint — hosted, or a model server you run), or `transformers` (the model runs in this process). | `http` means every published page in the record is sent to that endpoint. `transformers` means nothing leaves the machine and needs `npm install @huggingface/transformers`. |
| `CANON_EMBEDDINGS_MODEL` | required unless `local` | unset | The model's name, as its server knows it. | It is part of the provider's identity, so changing it re-derives the whole vector index from the record rather than mixing two vector spaces. |
| `CANON_EMBEDDINGS_DIMENSIONS` | required unless `local` | unset | The width of the model's vectors. | Checked against every answer. A model returning a different width is a refusal, not a silently mixed index. |
| `CANON_EMBEDDINGS_URL` | required if `http` | unset | The full endpoint, e.g. `https://models.internal/v1/embeddings`. | Canon may reach this host and no other — private addresses included, because it comes from your environment rather than from a user calling the API. Plain `http` off this machine is warned about: the whole record crosses the network in the clear. |
| `CANON_EMBEDDINGS_API_KEY` | optional | unset | **Secret** — sent as `Authorization: Bearer`. | Never logged, and a model server's error body is never quoted back, because it can contain the request that caused it. |
| `CANON_EMBEDDINGS_QUERY_PREFIX` | optional | unset | Instruction put in front of every question before it is embedded, for asymmetric model families: BGE v1.5 wants `Represent this sentence for searching relevant passages: `, E5 wants `query: `. Not trimmed — a trailing space is usually the point. | Query-time only; never stored, so changing it never re-derives the index. Measured to be worth having: bge-small-en-v1.5 run bare understates its own quotation quality by double digits. |
| `CANON_EMBEDDINGS_TEXT_PREFIX` | optional | unset | The passage-side counterpart (E5 wants `passage: `; BGE v1.5 wants none). | Baked into every stored vector, so it is part of the provider's identity: changing it re-derives the whole index rather than leaving rows embedded one way and questions asked another. |
| `CANON_EMBEDDINGS_BATCH` | optional | `32` | Texts per request. | — |
| `CANON_EMBEDDINGS_TIMEOUT_MS` | optional | `30000` | Bounds the whole exchange. | A provider that fails leaves pages out of the vector channel and retrieval degrades to lexical plus graph. It never substitutes a vector. |
| `CANON_EMBEDDINGS_ALLOW_RESTRICTED` | optional | unset (off) | Whether a `restricted` collection's pages may be sent to an **`http`** embedder at index time. Off means they may not: they are left out of the semantic channel and found lexically (on-box FTS) plus by the explicit graph. | The safe default, and a **data-governance** control like `CANON_GENERATOR_ALLOW_RESTRICTED` — turn it on only with a data-processing agreement covering the embedding provider. Does nothing with `local`/`transformers`, which never leave the box. Retrieval on restricted collections is lexical-only when off, which is the trade for not sending them. |

## The answer generator

Unset, answers are composed by the built-in extractive generator: the record's
own sentences, quoted verbatim and attributed, with nothing written between
them. That is the default because it can never say anything a page does not
say.

Selecting the model generator changes who writes the prose, and nothing else —
every rule that matters is enforced outside the generator, structurally: the
grounding gate refuses before a model is ever called, a model cannot cite a
page it was not offered, a quote it proposes becomes the citation's snippet
only after Canon verifies it is a verbatim substring of that page, a recorded
disagreement is re-asserted over whatever it writes, and any failure — network,
timeout, a refusal, prose that does not parse — falls back to the extractive
generator rather than to an error or an invention. What a model buys is better
prose and better-chosen quotations; what it costs is that each answered
question's passages are sent to the Anthropic API — except those drawn from a
`restricted` collection, which stay on the box and are composed locally unless a
deployment with a data-processing agreement sets `CANON_GENERATOR_ALLOW_RESTRICTED`
(see below).

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_GENERATOR` | optional | unset = extractive | `anthropic` turns on the model generator. | Each answered question's gate-admitted passages (and their pages' indexed text) are sent to the Anthropic API. Refusals never are — the gate refuses before generation runs. |
| `CANON_GENERATOR_MODEL` | optional | `claude-opus-5` | The Claude model that composes answers. | Recorded in the answer engine name, so the audit log says which model wrote what. |
| `CANON_GENERATOR_EFFORT` | optional | `low` | `low`, `medium`, or `high` — how hard the model thinks. | `low` because the task is short and pre-filtered and a person is waiting; raise it if quotation quality measurably improves on your record. |
| `CANON_GENERATOR_MAX_TOKENS` | optional | `4096` | Output ceiling per answer. | — |
| `CANON_GENERATOR_URL` | optional | unset | Base URL override, for a proxy or a compatible endpoint. | Same standing as `CANON_EMBEDDINGS_URL`: it comes from your environment, not from a user. |
| `ANTHROPIC_API_KEY` | required if `anthropic` | unset | **Secret** — read by the Anthropic SDK. | Never logged. A missing or invalid key degrades every answer to the extractive generator; it never takes Ask down. |
| `CANON_GENERATOR_ALLOW_RESTRICTED` | optional | unset (off) | Whether a `restricted` collection's content may be sent to the model generator. Off means it may not: an answer drawing on a restricted collection is composed locally by the extractive generator, so nothing restricted — and not the question either — leaves the process. | The safe default, and it is a **data-governance** control, not a tuning knob. Turn it on only with a data-processing agreement (a DPA/BAA) covering the model provider for the material in those collections. When on, Canon warns at start-up that restricted content will egress; when a restricted answer IS kept local, the audit event records `restrictedEgressWithheld`, so a compliance owner can prove it stayed on the box. |

### Sending the record to a third party — the governance note

Two settings send record content out of this process to an external service,
and both are off by default: `CANON_GENERATOR=anthropic` sends each *answered*
question's gate-admitted passages (never a refusal's), and `CANON_EMBEDDINGS=http`
sends every *published* page to the embedding endpoint at index time. That is a
decision for whoever owns the data, not a default to drift into:

- **Have a data-processing agreement in place** (a DPA, and a BAA where the
  material is PHI) with the provider before turning either on. Canon states the
  egress plainly here and at start-up; it cannot sign your contracts.
- **Scope it, per collection.** `CANON_GENERATOR_ALLOW_RESTRICTED` keeps
  `restricted` collections off the answer model by default, and
  `CANON_EMBEDDINGS_ALLOW_RESTRICTED` keeps them off a hosted embedder by
  default — mark the collections whose content must not leave, and their answers
  are composed locally and their pages are indexed lexically on the box. A
  deployment that cannot send *any* collection to a hosted embedder can still
  run `CANON_EMBEDDINGS=transformers` (the model on the box) or the built-in
  default (no call at all).
- **Point it at your own endpoint if you must.** `CANON_GENERATOR_URL` and
  `CANON_EMBEDDINGS_URL` accept a self-hosted or in-VPC compatible endpoint, so
  "use a model" need not mean "use someone else's network".

## Import

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_IMPORT_ROOTS` | recommended | unset = unrestricted | Colon- or comma-separated directories an import may read from. | §5 assumption 3: `admin` on one collection otherwise buys the ability to name any server-side path. Set it wherever collection admin is not the same trust level as shell access. Does not govern `POST /imports/upload` — its spool is server-chosen, not caller-aimed. |
| `CANON_IMPORT_SPOOL` | optional | `canon-import-spool` under the OS temp dir | Where uploaded export archives land and unpack for `POST /imports/upload`. | Holds a corpus only for the life of one run: archive and unpacked tree are removed on success and on every refusal. Put it on the volume with the space if exports are large. |
| `CANON_IMPORT_UPLOAD_MAX_BYTES` | optional | `268435456` (256 MiB) | Upload cap for `POST /imports/upload`, separate from the 8 MiB JSON body cap. | Over the cap the stream is cut mid-body and the partial file removed — the refusal costs the disk nothing. The archive itself is opened by a validating reader (`server/src/zip.ts`) that refuses encryption, ZIP64, traversal names and size-lying entries by name. |

## Rate limiting

Five token buckets, in process, keyed by whoever is asking. Nothing that reads
the record is limited. Each is written `burst/perMinute`, or `off`.

Keyed by *whoever is asking* rather than by the actor, because on Veryl
Studio's surface those are not the same thing: the actor is the app, and one
app is a whole company. A Studio ask therefore spends from two buckets and
needs a token from each — `ASK`, keyed by the app **and** the person named in
`X-On-Behalf-Of`, so one person cannot exhaust everybody's share; and
`ASK_APP`, keyed by the app alone, so the total does not depend on how many
people the app claims to act for. That second bucket is what makes the first
safe to key on a header the app asserts and Canon does not verify. **Raise
`ASK_APP` for a large Studio population, not `ASK`.**

A token is spent when the call did the work the bucket bounds. The bucket is
checked before the body is read and charged after the handler returns, so a
malformed request, a missing header or a refusal at a permission gate costs
nobody a question.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_RATE_LIMIT` | optional | on | `off` turns every bucket off, for a deployment whose front door already limits. | — |
| `CANON_RATE_LIMIT_ASK` | optional | `12/12` | `POST /ask`, keyed by the person; `POST /knowledge/ask`, keyed by the (app, person) pair. | Retrieval plus a generator; with a hosted embedding provider it is also a bill. |
| `CANON_RATE_LIMIT_ASK_APP` | optional | `120/120` | The ceiling on one Studio app across every person it names. | The forgery bound: `X-On-Behalf-Of` is asserted by the app, so this is the half of the limit whose key the app cannot choose. |
| `CANON_RATE_LIMIT_REFERENCES` | optional | `60/60` | `GET /pages/:id/references` — the route that reaches an external system. | — |
| `CANON_RATE_LIMIT_IMPORT` | optional | `2/0.5` | `POST /imports`. | — |
| `CANON_RATE_LIMIT_AUTH` | optional | `20/20` | **Failed** passport authentications, keyed by connection origin. Only a failure spends a token. | — |

## Freshness and maintenance

**The freshness sweep runs by default and needs no configuration.** Every
deployment flips Canonical pages past their review date to **Needs Update**,
hourly and on start-up, attributed to Canon's own system actor. Nothing below is
required; each variable exists to turn that off or to change whose name is on it.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_FRESHNESS_INTERVAL_MS` | optional | `3600000` (hourly) | How often the sweep runs, in addition to one immediate pass at start-up. `0` turns the timer off and hands review dates to your own scheduler calling `POST /maintenance/freshness`. | With it off and no scheduler, **"stale knowledge announces itself" is not true of this deployment** — and Canon says so at start-up, on `GET /maintenance/freshness`, and in the editor beside the review-date field, so the policy author finds out as well as the operator. |
| `CANON_MAINTENANCE_ACTOR_ID` | optional, and normally left unset | unset = `system:canon` | The actor the timed sweep runs as. Unset, it is Canon itself: a `system` actor that cannot be signed in as, granted a role, or created a second time. Set it only if you deliberately want a named service account's name on this work; it must hold the org-level `operator` role. An id this record does not hold logs an error and falls back to `system:canon` rather than stopping the sweep. | **Naming a person here puts their name on work they did not do.** The audit log's whole value is that it does not say that, so an event Canon wrote says `system:canon` / `actorKind: system` and reads as *Canon* wherever an actor is rendered. Attribution stays universal (DATA-BACKBONE.md §2, principle 5) — it is now also true. |

## Anchoring the audit chain head

**Canon records where its audit chain had got to, on a schedule, so that an
operator can carry that value off the box.** Read the honesty note before
turning either of these into a control you rely on: *an anchor Canon writes, and
Canon could rewrite, proves nothing.* The line below is inside the same trust
boundary as the database it describes; the value appears only in the copy that
has left this machine. OPERATIONS.md, "Anchor the chain head", is the recipe and
the argument.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_ANCHOR_INTERVAL_MS` | optional | `3600000` (hourly) | How often Canon writes an `audit head anchor` line — `headEventId`, `headHash`, `events`, `takenAt` — in addition to one at start-up. `0` turns it off. | With it off, this deployment publishes nothing that would contradict a wholesale recomputation of the chain (USER-TESTING.md T3.2, where exactly that returned `ok: true` from `GET /audit/verify`). With it on and nobody shipping the line anywhere, the position is the same: **the schedule is not the control, the retention is.** |
| `CANON_ANCHOR_FILE` | optional | unset | A file each anchor is also appended to, one JSON object per line. For a deployment whose log shipper is easier to point at a file than at stdout, or whose cron rsyncs the file to a store Canon has no credentials for. | Appended, never rewritten, because a file holding only the latest head is a file an attacker overwrites with the head they want. A path Canon can write is a path Canon can rewrite: put the file where a shipper *takes* it from, and treat the destination as the anchor. A write failure is a `warn` and does not stop the line reaching the log. |

## Scheduled backup

**Canon can take its own verified backup on a schedule** — the same
`VACUUM INTO` snapshot `npm run backup` takes, verified end to end before it is
called a backup, on the record's own connection. Off by default: durability of
the audit log is a compliance obligation, so turning this on is a deliberate
act with a stated recovery-point objective, not a silent convenience. Two
things this is **not**, and OPERATIONS.md ("Back up") is the argument: it is not
an off-box copy — the artefact lands on local disk and getting it somewhere the
machine's loss cannot reach is still your act — and it is not point-in-time
recovery, so the interval you choose is what you have agreed to lose.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_BACKUP_INTERVAL_MS` | optional | unset (off) | How often Canon takes a verified snapshot, in milliseconds. Unset or `0` means no scheduled backup. The first artefact lands one interval in, not at start-up. | The interval **is** your recovery-point objective: whatever was committed since the last snapshot is what a crash loses. A failed backup is logged at `error` with `msg: "scheduled backup failed"` and never takes the server down — **alert on that line**, because the moment backups start failing is the moment the old ones become the only copies there are. |
| `CANON_BACKUP_DIR` | required if `CANON_BACKUP_INTERVAL_MS` is set | unset | The directory each timestamped artefact is written to. Setting an interval without this is refused at start-up. | Put it on a volume that is **not** the record's own disk. Canon warns at start-up that scheduled backups are local-only; a copy that shares a failure domain with the record is not a backup. Ship each artefact off the box, and file the audit-chain anchor beside it. |
| `CANON_BACKUP_KEEP` | optional | `0` (keep all) | After a verified backup, delete all but the newest N artefacts **in `CANON_BACKUP_DIR`**. | Local pruning only — it never touches the off-box copies, and it never prunes on a failed run. Keep artefacts at least as long as your audit-log retention obligation, which for a regulated partner is usually seven years. |

## Metrics

**Canon can expose operational metrics in the Prometheus text format at
`/metrics`.** Off by default: `/health` and `/ready` say whether Canon is up,
but nothing else said how much traffic it serves, how fast, or how big the
record has grown, and running a system of record in production without those
signals is its own kind of blind. What is exposed is aggregate operational data
only — request counts and latency by method and *route shape*, uptime, schema
version, whether the record reads, the audit-event count, and process memory.

| Variable | Required? | Default | Meaning | Safety |
| --- | --- | --- | --- | --- |
| `CANON_METRICS` | optional | unset (off) | `on` (or `true`/`1`) serves `GET /metrics` and starts recording. | No PII, no query strings, and **no page ids**: a request route is normalised to its shape (`/pages/:id`, never `/pages/<uuid>`), so a label never carries the identifier the request log works to keep out. It is served **without authentication**, like `/health` and `/ready` — so it is off by default, and a deployment that turns it on should let only its own scraper reach `/metrics` (allow it at the reverse proxy, or scrape over the internal network). It reveals traffic *shape*, which is why exposing it is the operator's deliberate choice. |

## Not Canon's: the stubs

These configure the **test doubles** in `idp-stub/`, `registry-stub/`,
`source-stub/` and `studio-stub/`. They exist for demos and tests. None of them
belongs anywhere near a deployment.

| Variable | Service | Meaning |
| --- | --- | --- |
| `PORT` | all stubs | Listen port (registry 3100, idp 3200, source 3200, studio 3300 by default). |
| `IDP_ISSUER`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URIS` | idp-stub | The provider's own identity and its one registered client. |
| `CANON_URL`, `STUDIO_PASSPORT`, `STUDIO_APP_NAME`, `STUDIO_TIMEOUT_MS` | studio-stub | Where Canon is, and the app's Agent Passport. |

---

## Start-up validation

Canon checks the environment before it binds a port (`src/config.ts`) and
**exits 78 (`EX_CONFIG`)** rather than starting, naming the variable, on any of:

| Refusal | Why it cannot mean what it says |
| --- | --- |
| `CANON_OIDC_ISSUER` set, `CANON_SESSION_SECRET` unset | Sessions signed with a key invented at start-up: every restart signs everybody out, and no second instance can read the first's cookies. |
| `CANON_DEV_AUTH=true` **and** `CANON_OIDC_ISSUER` set | An identity provider is configured and the unverified header is accepted beside it. Every authorization control is downstream of that. |
| `CANON_DEV_AUTH=true` **and** a non-loopback `CANON_BIND` | The unverified `X-Actor-Id` header would be reachable from the network, where anyone who can open the port is any actor they name. Dev auth is loopback-only. |
| `CANON_SOURCE_ALLOWED_HOSTS` names a host that does not resolve | Federation is allowlisted to somewhere Canon cannot reach; every reference through it would fail at read time. (`*.domain` entries and literal addresses are skipped — there is nothing to look up.) |
| `CANON_SMTP_URL` set, `CANON_MAIL_FROM` unset | An email needs a sender. |
| `CANON_OIDC_ISSUER` set without a client id or secret | The code exchange cannot be made. |
| `CANON_OIDC_ISSUER` set with neither `CANON_BASE_URL` nor `CANON_OIDC_REDIRECT_URI` | The redirect URI would default to `http://localhost:3000/auth/callback`, which no provider outside the machine can send a person back to. |
| Any URL variable that is not an `http(s)` URL | — |
| Any numeric variable that is not a number | A typo in an interval silently becomes `NaN`, and a `NaN` interval is a timer that never fires. |

Not in the table, because they are not `config.ts`'s job, but they stop a start
just as firmly: a `CANON_GROUP_MAP` rule naming a collection or role that does
not exist, an unreadable `CANON_GROUP_MAP_FILE`, and a
`CANON_BOOTSTRAP_ADMIN_ACTOR_ID` naming an actor this record does not hold.

Warnings — logged at start-up, never fatal — cover the merely unwise: a short
session secret, a maintenance actor named at all (it puts somebody's name on the
clock's work), the freshness timer turned off, dev auth beside a real Registry,
private addresses reachable in a deployment with SSO, an `http://` base URL with
SSO live, a relay with no base URL for its deep links, a `CANON_UI` naming a
client Canon does not have, and no door open at all.

`CANON_UI=react` on an image built without the React client is the one warning
that is logged from `src/index.ts` rather than `config.ts`, because answering it
needs to look at the disk. It is an error-level line naming the variable and the
directory it looked in, and Canon then serves the original client — see
"The record and the process" above.
