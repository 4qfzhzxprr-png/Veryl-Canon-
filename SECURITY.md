# Security review — Veryl Canon, M4

[CORE-PLAN.md](CORE-PLAN.md) §5 names "a security review" as the one M4 exit item the team had not done. This is it: what was looked at, what was found, what was fixed, what was not, and what the whole thing rests on.

It is written the way the rest of this repository is written. Where a control is partial, it says so and says where it stops. A finding nobody can act on because the report overstated the fix is worse than no report.

---

## 1. Scope and method

**In scope.** The whole of `server/src/` (every module), `server/public/app.js`, `registry-stub/src/`, `source-stub/src/`, and the contracts the code claims to implement: [CORE-PLAN.md](CORE-PLAN.md) §4 Epic E, §5 M4, §7; [DATA-BACKBONE.md](DATA-BACKBONE.md) §2, §5, §6; [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) in full.

**Method.** Manual reading of every source file, route by route and store method by store method, against seven questions:

1. **Authorization.** Does every read and write pass a collection permission check, and does the check happen in the SQL that generates candidates rather than after ranking?
2. **The agent path.** Can any route escape `agentauth`'s classification? Does an unclassified route fail closed? Can the response narrowing be defeated?
3. **Injection.** SQL, FTS5 query syntax, the safe-subset renderer in `app.js`, SMTP headers, CSV formulas.
4. **Path traversal** in the importer.
5. **Resource exhaustion.** Unbounded reads, request bodies, imports, questions.
6. **Secrets.** Is any credential, passport or token ever written to the audit log, an error, a notification, or the console?
7. **Oracles.** Where does a refusal leak the existence of something?

Findings were confirmed by writing the exploit as a test first. Every fix below has a regression test in [`server/test/security.test.ts`](server/test/security.test.ts) that **fails without the fix** — verified by reverting each fix in turn and watching its test go red. Two tests in that file are marked as property tests rather than regressions: they assert behaviour that was already correct and that nothing was guarding.

**Test counts after this work:** `server` 171 (was 148), `registry-stub` 10, `source-stub` 13. All pass.

**Not in scope.** Deployment and infrastructure (TLS termination, network policy, secret storage, backups), the Node runtime and its `node:sqlite` dependency, and denial of service by request volume — Canon has no rate limiting and is expected to sit behind something that does.

---

## 2. Findings

Severity is judged for the alpha as it is described in CORE-PLAN.md: one design partner, a real corpus, real Registry, network-adjacent but not public. Every "High" is something a person with an ordinary account can do today.

### F1 — Server-side request forgery through federated sources · **High · fixed**

`sources.ts` stored an operator-supplied `baseUrl` and validated nothing about it; `httpconnector.ts` fetched it server-side when a reference resolved. A collection admin — or an agent holding `"*"` over sources, which `agentauth.ts` requires for source administration but which the Registry can grant — could register a source at `http://169.254.169.254/latest/meta-data/`, at `http://localhost:PORT`, or at any host inside the deployment's network, attach a reference to a page, and read the response back out through the reference's value. Canon became a proxy into the private network with an audit trail that said "reference resolved".

**Fixed** by a new module, [`server/src/outbound.ts`](server/src/outbound.ts), and its application at both ends:

- A deployment-configured allowlist, `CANON_SOURCE_ALLOWED_HOSTS`. **Unset or empty means no outbound federation**, never "anything". Entries are `host`, `host:port`, or `*.domain`; a host with no port permits any port on it.
- `CANON_SOURCE_ALLOWED_SCHEMES`, default `https,http`. Every other scheme — `file:`, `gopher:`, `ftp:`, `data:` — is refused whatever the allowlist says.
- Credentials embedded in the URL (`https://user:pass@host`) are refused. Canon stores no secret material for a source, and a URL password would be exactly that, plus a secret in every log line that prints a baseUrl.
- Loopback, link-local (including the cloud metadata address), private, carrier-NAT, multicast, broadcast and reserved ranges are blocked in both address families — including the IPv4-mapped, NAT64 and 6to4 spellings of a blocked v4 address, so `::ffff:169.254.169.254` is not a way round `169.254.169.254`. `CANON_SOURCE_ALLOW_PRIVATE=true` is the explicit development opt-in, and it is what the `source-stub` connector suite now sets to reach its stub on `127.0.0.1`.
- Validation runs **when a source is registered or changed** (`sources.ts`) and **again when a reference resolves** (`httpconnector.ts`). Registration-time alone is bypassable; resolution-time alone would leave a source sitting in the register looking legitimate.
- At resolution time the hostname is also resolved and every address it resolves to is checked, so an allowlisted name that points at an internal address is refused before the request is made.
- Redirects are followed by hand, three hops maximum, with the full policy re-applied to every hop. A permitted host cannot bounce Canon into the private network on the second request.

**What this does not stop, stated plainly.** The policy checks the resolved addresses but does not *pin* them: Node's global `fetch` offers no supported hook for supplying the socket address, so between the DNS check and the connection an answer can change. A deliberate DNS-rebinding attack from a host the operator has allowlisted can still land on an internal address. What makes that uninteresting in practice is the allowlist — the attacker must already control a name the operator chose to trust — but the window is real and is not closed. Closing it needs a connect-time hook (a custom dispatcher, or dropping to `node:http` with a fixed `lookup`), which is a bigger change than a security review should make on its own. **Recommendation: do it before the first live connector.**

Also unchanged: response content is not filtered. A permitted source that returns a scalar returns it, and that is the whole point of federation.

### F2 — The audit log was readable in full by any actor · **High · fixed (behaviour change)**

`CanonStore.queryAudit` checked only that the asking actor existed — the comment said "audit access control tightens with the admin surface; presence check for now". Any actor could read every event in the record: page ids and titles from collections they hold no role in, send-back comments quoted verbatim in `details`, import file paths, source registrations, every question asked of `/ask`. `GET /audit.csv` exported the same thing. Combined with F-A1 below (`POST /actors` is open), an unauthenticated caller could mint an identity and read the lot.

**Fixed** by putting the permission filter in the SQL that generates the rows: an event naming a collection reaches a reader only where that reader holds a role in it. This is exactly the narrowing [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) §4.2 already fixes for agents, now applied to people too.

**This is a behaviour change and it is deliberate.** It is recorded here rather than done silently: an administrator's view of the log is now bounded by their collection memberships. That preserves CORE-PLAN's M4 exit ("an administrator can answer *who did what, when* from the audit log alone") for the collections they administer, and it removes the ability of a contributor in one collection to read the operational history of another. If the design partner's compliance lead needs an org-wide view, the right answer is an org-level administrator role — which `sources.ts` and `notify.ts` already work around with "admin on at least one collection" — not an unfiltered query.

Residual, deliberately not changed: events that name **no** collection (`agent.session`, `agent.auth_failed`, `answer.ask` with no collection named) stay visible to every actor, because that is the rule the Registry contract states for agents and diverging for people would be a second, undocumented rule. See R5.

### F3 — An import could follow a symlink out of the export directory · **Medium · fixed**

`POST /imports` takes an operator-supplied path, requires only `edit` on the target collection, and walks it. Discovery builds paths only from directory-entry names, so no `..` can appear in one — but a symlink inside an otherwise ordinary export is a file named `Onboarding.html` whose contents are `/etc/passwd`, and the importer read it and landed it in the record as a page, title and all. Google Docs discovery walks subdirectories, so the symlink did not even have to be at the top level.

**Fixed** in `import.ts`: every file is resolved through `realpath` and refused if it lands outside the run's own root, at both the discovery reads (the Confluence index and breadcrumb passes, which happen before the import pass) and the import read itself. A refused file is reported as `skipped` with a reason, never silently dropped and never fatal to the run. Symlinked *directories* were already not descended into, because `readdirSync(…, { withFileTypes: true })` reports a symlink as a symlink rather than a directory.

**Also added, opt-in:** `CANON_IMPORT_ROOTS` bounds which directories an import may read from at all. **Unset means unrestricted**, which is the historical behaviour — an operator unpacking an export into an arbitrary directory is the normal case, and default-deny here would break every existing deployment and the whole import test suite. This is the one place in this review where the default is convenience rather than safety, and it is called out for that reason. Any deployment where `edit` on a collection is not the same trust level as shell access should set it. See also R6.

### F4 — SMTP header injection through an unvalidated actor email · **Medium · fixed**

`CanonStore.createActor` accepts any string as an email address and validates nothing, and `POST /actors` is open (F-A1). `email.ts`'s `formatAddress` interpolated that address straight into the `To:` header. An address of `mallory@example.com\r\nBcc: everyone@example.com` therefore composed a message with attacker-chosen headers, sent through the deployment's own relay.

The blast radius was smaller than it looks — `smtp.ts`'s `assertAddress` rejects CR/LF in the envelope, so the message would have failed at `RCPT TO` — but that is one refactor away from being wrong, and it made every notification to that actor a permanent failure instead.

**Fixed** in `email.ts`: every value that reaches a header is checked for CR, LF and NUL at the last point before it is written — the address, the display name, and any caller-supplied header. A refusal is permanent (`SmtpPermanentError`), so the outbox marks the notification dead rather than retrying it forever, which is the same judgement `smtp.ts` already makes. A long non-ASCII display name still composes: `encodeWord` folds with a legitimate CRLF-plus-space continuation, and that is not injection, so the check is on the address rather than on the formatted result.

Verified clean while here: a subject carrying CRLF was **already** safe, because `encodeWord` base64-encodes anything that is not printable ASCII, and CR and LF are not. There is now a test saying so.

### F5 — No request body size limit · **Medium · fixed**

`api.ts`'s `readBody` buffered a request body of any size before anything looked at who was asking. One unauthenticated request could hold the process's memory.

**Fixed**: a cap of 8 MB, checked per chunk so an oversized body is refused as it arrives rather than after it has all been accepted. 8 MB is generous on purpose — a pasted page body and an imported document are legitimate large bodies — but it is a cap.

### F6 — Unbounded question length on `POST /ask` · **Low · fixed**

`AnswerService.ask` passed the question straight to the embedding provider. With the 8 MB body cap above, one request could hand a multi-megabyte string to a provider — a per-request cost paid by the server, and with a hosted provider, a per-request bill.

**Fixed**: `MAX_QUESTION_LENGTH = 4096`, refused in `retrieval.ts` where both `/ask` and `store.retrieve` funnel through. Nothing longer than that is a question the record can answer.

Not changed: `EmbeddingStore.similar` reads every embedding row the asker can see and computes cosine in JavaScript, so the cost of one `/ask` is linear in the visible corpus. That is the documented alpha-scale decision in [DATA-BACKBONE.md](DATA-BACKBONE.md) §5 ("exact similarity over stored vectors is fast enough"), and it is a scaling limit rather than a defect. It is worth measuring before a partner's full corpus lands.

### F7 — The relay password echoed in an error message · **Medium · fixed**

`parseSmtpUrl` threw `CANON_SMTP_URL is not a URL: ${raw}` — with the raw value, which routinely carries the relay password. That error is thrown at start-up, where it lands in the console and in whatever collects crash output.

**Fixed**: the message says what is wrong and does not echo the value.

### F8 — CSV formula injection in the audit export · **Low · fixed (hardening)**

A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`, tab or CR as a formula and evaluates it on open. The audit CSV is opened by a compliance lead, which is exactly the wrong person for that to happen to.

**Honest assessment: this was not exploitable as the export stands.** Every column is either a UUID, an ISO timestamp, an integer, or a fixed vocabulary — and the one column carrying attacker-controlled text, `details`, is `JSON.stringify`d and therefore always begins with `{`. The protection was incidental, not designed: one new column carrying a page title or an actor name would have made it real.

**Fixed** in `csv.ts` anyway, because the incidental version is not worth relying on: a cell that would otherwise be executed is prefixed with a single apostrophe, which every spreadsheet reads as "this is text". It is applied only to cells that would execute, and a field that is simply a number — including a negative one — is left exactly as it was.

### F9 — Row limits spliced into SQL as text · **Low · fixed**

`store.queryAudit` and `SearchIndex.search` interpolated their `LIMIT` into the statement text. Both clamped the value first, so neither was exploitable through the HTTP API (`api.ts` coerces with `Number()`), but a caller reaching the store directly — which the Knowledge API in the Next tier will be — could write into the statement, and a non-numeric limit produced `LIMIT NaN` and a raw SQLite error rather than a clean refusal.

**Fixed**: both are bound parameters, with the clamp kept.

---

## 3. Recommendations — real issues, deliberately not fixed here

Each of these is a behaviour change the team should decide on rather than something a security review should land on its own.

### R1 — There is no authentication · **Critical in production, accepted for the alpha**

`X-Actor-Id` is an assertion, not a credential: knowing an actor's UUID *is* being that actor. `POST /actors` is open to unauthenticated callers, so anyone who can reach the port can mint an identity. Every other control in this document — collection roles, the audit narrowing in F2, the Registry intersection — sits on top of that.

This is the documented alpha design (`api.ts`: "people get SSO later"; [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) §2 says the same), and the agent door is genuinely authenticated because the Registry is. It is recorded here as **the assumption the whole model rests on**: Canon must not hold a design partner's real corpus on a network anyone untrusted can reach until SSO lands. That is a deployment gate, not a code change.

### R2 — `GET /actors` discloses the whole directory, including email addresses

Any actor can list every actor with their email. The web UI's identity picker depends on it. The fix belongs with SSO (R1), where "who may see the directory" becomes answerable.

### R3 — A mention notifies any actor, including non-members

`comments.ts` resolves `@<actorId>` against the whole actor table and emails whoever it finds. A commenter on a page in a restricted collection can therefore email the page's title and their own comment to someone with no role in that collection. **Recommendation: filter mentions to actors who hold at least `view` on the page's collection, and report the dropped mentions to the commenter rather than silently.** Not done here because it changes what a commenter sees happen, and because "mention someone to bring them in" may be a deliberate workflow the design partner wants.

### R4 — Existence is checked before permission

`store.getCollection`, `store.getPage`, `store.getVersion` and `sources.get` all throw `not_found` for a missing id before checking whether the asker may see it, so a `403` versus a `404` tells an outsider whether an id is real. The source-stub deliberately checks entitlement before existence; Canon does the opposite.

**Deferred, with reason:** the identifiers are random UUIDs, so this confirms a guessed or leaked id rather than enabling enumeration, and the fix — returning `not_found` for both cases — inverts error semantics that the API sketch, the web UI and roughly a dozen existing tests depend on. It should be decided deliberately, in one pass, rather than as a side effect of this review.

### R5 — Audit events with no collection are visible to everyone

The residual from F2. `agent.session` events carry an agent's full permitted-collections and permitted-sources lists; `answer.ask` events carry the question text. **Recommendation: narrow these to the acting actor plus holders of `admin` on some collection**, which is the "operator" stand-in `notify.ts` and `sources.ts` already use. Not done here because it would diverge from the rule REGISTRY-CONTRACT §4.2 states for agents, and the two should change together.

### R6 — An import requires only `edit`

`POST /imports` reads a server-side path chosen by the caller. `edit` on one collection is a low bar for that. **Recommendation: raise it to `admin`, and set `CANON_IMPORT_ROOTS` in every deployment.** Not done here because it would lock out the workflow the importer was built for and the decision belongs to whoever runs the partner migration.

### R7 — Internal error messages reach the client

`api.ts`'s catch-all returns `{ error: 'internal', message: err.message }` with a 500. That message can carry SQLite text and absolute server paths (an import summary's `path`, for instance, is a server filesystem path returned to the caller and written to the audit log by design). **Recommendation: log the detail, return a correlation id.** Not done here because the import path in the summary is a deliberate product feature and untangling the two is a design question.

### R8 — No rate limiting

Nothing bounds requests per actor. `POST /ask` is the expensive one. Assumed to be handled by whatever sits in front of Canon; recorded because that assumption is not written down anywhere else.

---

## 4. Examined and found clean

A review that reports only hits is not a review. These were attacked specifically and held.

**The safe-subset renderer (`server/public/app.js`).** I tried to defeat it and could not. Every value is passed through `esc()` — which escapes `&`, `<`, `>`, `"` and `'` — before any markup is generated, and the only unescaped strings inserted are literals this file writes. The link rule admits only `https:`, `http:`, `mailto:` and `#` targets, and because the href is post-escape it cannot carry a quote to break out of the attribute. The bold and italic passes run *after* link insertion and can therefore inject `<strong>` into an href's value — but inside a quoted attribute that is inert text, and neither pass can produce a quote character. FTS5 snippets, federated reference values, source names, error strings, audit `details`, citations and diffs are all escaped at the point of insertion. The one cosmetic consequence is that search snippets show `<mark>` literally.

**`html.ts` (the import converter).** It never emits HTML: the writer only ever emits text taken from text nodes, so no markup in a Confluence or Google Docs export can reach a page body — including markup inside `<script>`, `<style>` or an attribute. `safeHref` blocks `javascript:`, `vbscript:`, `file:` and `data:`, and entity decoding happens at parse time so `&#106;avascript:` is decoded before the check rather than after it. Recursion is depth-capped.

**SQL parameterisation.** Every statement in `server/src/` binds its values. After F9 the only interpolations left in any SQL string are a `WHERE` clause assembled from a fixed list of literal fragments, and `notify.ts`'s `ALTER TABLE … ADD COLUMN` built from a hardcoded constant array. No user-supplied value reaches statement text.

**FTS5 query construction.** `toMatchQuery` strips quotes and wraps every whitespace-separated term as a phrase. I ran `"`, `*`, `^term`, `NEAR(`, `(`, `a OR b`, `a:b`, `NOT` and empty-phrase cases against it: none produced a syntax error, an unhandled exception, or an operator that escaped its quotes. Column filters, prefix operators and boolean operators are all inert.

**Agent classification fails closed.** `agentauth.ts` keeps a route table deliberately separate from `api.ts`'s, and an unclassified route is refused rather than guessed at. `POST /imports`, `GET /imports`, `GET /audit.csv`, `POST /notifications/flush` and `POST /actors` all exist in `api.ts` and are absent from the classification table, and all five refuse an agent holding `read`, `comment`, `write`, `"*"` collections and `"*"` sources. Nothing was asserting that; there is now a test that will fail if either table drifts.

**The narrowing cannot be defeated by path encoding.** `api.ts` and `agentauth.ts` match against the same `URL`-normalised pathname and both `decodeURIComponent` their captured groups, so a percent-encoded id resolves identically on both sides. A path that encodes a separator (`/pages/abc%2Freferences`) resolves to a page id that does not exist, and the store answers `not_found` — the classification layer resolves it to "no collection" rather than inventing one, which is the documented behaviour.

**The Registry client.** Fails closed on unreachable, timeout, malformed and unparseable answers; never converts "no answer" into a refusal code or an allowance; never caches "no answer"; clamps every cached answer to the sixty-second revocation guarantee, and clamps again on write. `permittedSources` absent reads as none; present-but-malformed refuses the whole answer. This matches REGISTRY-CONTRACT §3, §5 and §6 exactly.

**Passports are never stored.** `agentauth.ts` records a refusal it cannot attribute against a SHA-256 fingerprint of the passport, never the passport, exactly as REGISTRY-CONTRACT §5 requires. No audit event, notification, error message or console line in the codebase carries a passport, and there is no `credential` column on `sources`. The one place a passport lives is `RegistryClient`'s in-memory cache, keyed by the passport string, expiring inside sixty seconds — transient by construction and never written to disk.

**Retrieval and answers filter before ranking.** Both channels bind candidates to the asker's collections in their own SQL (`search.ts`'s membership join, `embeddings.ts`'s membership join), and `retrieval.ts`'s `hydrate` — used for both direct candidates and every graph-expanded neighbour — repeats the join. Nothing the asker cannot see is fetched, scored, expanded into, or passed to the generator. `answers.ts` re-checks Canonical-and-not-a-Note after retrieval as well as in the SQL.

**Federated reference resolution.** Canon's own `view` on the page's collection is checked before anything is asked of a source; the per-asker cache is keyed by actor so one actor's entitled value cannot be served to another; a source removed from a collection's scope stops resolving there even for references written while it was in scope; and the Registry's `permittedSources` is applied per reference, refused in place rather than omitted, as REGISTRY-CONTRACT §4.2 requires.

**Append-only history.** `page_versions` and `audit_events` are protected by SQLite `BEFORE UPDATE`/`BEFORE DELETE` triggers, in the storage layer rather than only in application code, so no code path — including a future one — can rewrite them.

**Static file serving.** `static.ts` accepts only `^[A-Za-z0-9][A-Za-z0-9._-]*$` as a filename, which admits no separator, no dotfile and no traversal, and only serves extensions in a fixed content-type table.

**SMTP wire handling.** Dot-stuffing is correct, envelope addresses are validated for CR/LF and angle brackets, STARTTLS is required whenever credentials are present so a password never crosses in clear, and AUTH exchanges are never logged.

**CSRF is not applicable.** Identity travels in a custom header (`X-Actor-Id` / `X-Agent-Passport`), never a cookie, so there are no ambient credentials for a cross-site request to borrow. This stops being true the moment SSO introduces a session cookie — see §5.

**The stubs.** `registry-stub` and `source-stub` leave their administrative faces unauthenticated. Both say so in their own headers, both are test doubles, and neither is deployable. No finding is raised; they must never be run anywhere real, which is what "stub" is doing in their names.

---

## 5. What would break this

The assumptions the design rests on. If one of these stops being true, re-read this document rather than trusting it.

1. **Everyone who can reach the port is trusted to be who they say they are.** `X-Actor-Id` is an assertion and `POST /actors` is open. Every authorization control in Canon is downstream of that. The alpha survives because the deployment is closed; a partner corpus on a reachable network without SSO is the single fastest way to make this review worthless.

2. **A collection admin is trusted with the network the server sits on.** F1's allowlist moves that trust from a collection admin to whoever writes `CANON_SOURCE_ALLOWED_HOSTS` — but everything inside the allowlist is still reachable, and DNS is still resolved rather than pinned. Add a host to that list and you are asserting it is safe for Canon to fetch, follow redirects within, and read responses from.

3. **The importer's path is chosen by someone trusted with the filesystem.** `edit` on one collection currently buys the ability to name any server path. The symlink fix contains a run to its root; `CANON_IMPORT_ROOTS` bounds the root; neither is on by default in the way that matters (R6).

4. **The Registry is honest and reachable.** Canon holds no agent trust of its own. A compromised Registry is a compromised Canon for every agent, immediately and completely. The sixty-second cache means it is also a *sixty-second* Canon — revocation is bounded, but so is any window in which the Registry lies.

5. **`agentauth`'s route table and `api.ts`'s route table stay in step.** They are deliberately separate so that a new route is closed to agents by default. That safety depends on the default staying "refuse", which is now tested. A future change that adds a fallthrough or a wildcard rule removes the protection silently.

6. **Permission filtering stays in the SQL.** Retrieval's guarantee is that invisible material never influences ranking, context or the answer. That holds because the membership join is in every candidate query and in `hydrate`. A future optimisation that fetches first and filters afterwards would satisfy every existing test and break the guarantee.

7. **Nothing in Canon ever stores a credential.** No passport, no per-asker source credential, no `credential` column on `sources`. The comment in `sources.ts` naming that as "the change to refuse" is load-bearing. If a future integration needs one, it belongs in the deployment's configuration, read by the connector — not in the record.

8. **The renderer's contract is "escape everything, then generate our own markup".** `app.js` is safe because `esc()` runs first, unconditionally, on every value. One `innerHTML` that interpolates a record value without it undoes the whole of §4's first paragraph.

---

## 6. Changes made by this review

| File | Change |
| --- | --- |
| `server/src/outbound.ts` | **New.** The outbound reach policy: allowlist, schemes, credentials, blocked address ranges, DNS-resolved check. |
| `server/src/httpconnector.ts` | Policy applied at resolution time; redirects followed by hand with the policy re-applied per hop; new `not_permitted` failure code. |
| `server/src/sources.ts` | `baseUrl` validated at registration and on update. |
| `server/src/store.ts` | `queryAudit` filters by collection membership in SQL; `LIMIT` bound rather than interpolated. |
| `server/src/search.ts` | `LIMIT` bound rather than interpolated. |
| `server/src/import.ts` | Symlink containment on every read; `CANON_IMPORT_ROOTS`. |
| `server/src/email.ts` | CR/LF/NUL rejected in every header value. |
| `server/src/smtp.ts` | `CANON_SMTP_URL` no longer echoed in its parse error. |
| `server/src/csv.ts` | Spreadsheet formulas defused. |
| `server/src/api.ts` | 8 MB request body cap. |
| `server/src/retrieval.ts` | 4096-character question cap. |
| `server/test/security.test.ts` | **New.** 23 tests: one per finding, plus two property tests. |
| `server/README.md` | The new environment variables, documented. |
| `source-stub/test/connector.test.ts` | Sets the development outbound policy explicitly, so the real policy is exercised rather than bypassed. |
