# Security review — Veryl Canon, M4

[CORE-PLAN.md](CORE-PLAN.md) §5 names "a security review" as the one M4 exit item the team had not done. This is it: what was looked at, what was found, what was fixed, what was not, and what the whole thing rests on.

It is written the way the rest of this repository is written. Where a control is partial, it says so and says where it stops. A finding nobody can act on because the report overstated the fix is worse than no report.

**Second addendum.** R9 (a person's session outlives revocation at the identity provider) and R10 (no group claims consumed) are now closed too, together with the residual F2, F11 and R5 all named: Canon had no organisation-level role, so five checks asked "does this actor hold `admin` on *any* collection?" instead. It has one now. The three pieces landed as one change because each needs the others — an operator role with no way to grant it is nothing, a revocation guarantee with no way to end a session by hand is half a guarantee, and group mapping without a way to tell mapped access from hand-granted access would have undone F2 and R5 while looking like a feature. See **R9**, **R10**, and the *organisation role* entry under F11. Tests live in [`server/test/orgrole.test.ts`](server/test/orgrole.test.ts), [`server/test/sessionconfirm.test.ts`](server/test/sessionconfirm.test.ts), [`server/test/groupmap.test.ts`](server/test/groupmap.test.ts) and [`idp-stub/test/idp.test.ts`](idp-stub/test/idp.test.ts).

**Addendum.** F10 and F11 below were added after the original review, when the two recommendations the review would not make on its own — R1, no authentication for people; R2, an open directory — were built and landed. Their regression tests live in [`server/test/auth.test.ts`](server/test/auth.test.ts) and [`idp-stub/test/idp.test.ts`](idp-stub/test/idp.test.ts) rather than in `security.test.ts`, because they test a door rather than guard a fix. Section 4's "CSRF is not applicable" paragraph and section 5's first assumption are rewritten accordingly; both predicted this change, and both are kept visible rather than quietly replaced.

---

## 1. Scope and method

**In scope.** The whole of `server/src/` (every module — including `auth.ts` and its `idp-stub/src/` counterpart, added with F10), `server/public/app.js`, `registry-stub/src/`, `source-stub/src/`, and the contracts the code claims to implement: [CORE-PLAN.md](CORE-PLAN.md) §4 Epic E, §5 M4, §7; [DATA-BACKBONE.md](DATA-BACKBONE.md) §2, §5, §6; [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) in full.

**Method.** Manual reading of every source file, route by route and store method by store method, against seven questions:

1. **Authorization.** Does every read and write pass a collection permission check, and does the check happen in the SQL that generates candidates rather than after ranking?
2. **The agent path.** Can any route escape `agentauth`'s classification? Does an unclassified route fail closed? Can the response narrowing be defeated?
3. **Injection.** SQL, FTS5 query syntax, the safe-subset renderer in `app.js`, SMTP headers, CSV formulas.
4. **Path traversal** in the importer.
5. **Resource exhaustion.** Unbounded reads, request bodies, imports, questions.
6. **Secrets.** Is any credential, passport or token ever written to the audit log, an error, a notification, or the console?
7. **Oracles.** Where does a refusal leak the existence of something?

Findings were confirmed by writing the exploit as a test first. Every fix below has a regression test in [`server/test/security.test.ts`](server/test/security.test.ts) that **fails without the fix** — verified by reverting each fix in turn and watching its test go red. Two tests in that file are marked as property tests rather than regressions: they assert behaviour that was already correct and that nothing was guarding.

**Test counts after this work:** `server` 171 (was 148), `registry-stub` 10, `source-stub` 13. All pass. (F10 and F11, added later, take `server` to 248 and add `idp-stub` at 12 — see §6.)

**Second pass, §3.** Everything in §3 below was originally left undone on purpose: each one is a behaviour change, and a security review should not land those on its own authority. The team has since decided on R3 through R8 and they are now implemented, tested the same way — each fix's test verified red by reverting the fix and watching it fail. **Test counts after that work:** `server` 220, `registry-stub` 10, `source-stub` 13, `studio-stub` 8. All pass. R1 and R2 remain open and are being taken up with SSO.

**Not in scope.** Deployment and infrastructure (TLS termination, network policy, secret storage, backups), the Node runtime and its `node:sqlite` dependency, and denial of service by request volume — Canon is expected to sit behind something that absorbs that. (R8 has since added per-actor limits on the four routes where one cheap request buys a lot of work. It is a cost control and a brute-force brake, not a DoS defence, and the sentence above still holds.)

---

## 2. Findings

Severity is judged for the alpha as it is described in CORE-PLAN.md: one design partner, a real corpus, real Registry, network-adjacent but not public. Every "High" is something a person with an ordinary account can do today.

### F1 — Server-side request forgery through federated sources · **High · fixed; the DNS-rebinding residual is now closed too, see the follow-up below**

`sources.ts` stored an operator-supplied `baseUrl` and validated nothing about it; `httpconnector.ts` fetched it server-side when a reference resolved. A collection admin — or an agent holding `"*"` over sources, which `agentauth.ts` requires for source administration but which the Registry can grant — could register a source at `http://169.254.169.254/latest/meta-data/`, at `http://localhost:PORT`, or at any host inside the deployment's network, attach a reference to a page, and read the response back out through the reference's value. Canon became a proxy into the private network with an audit trail that said "reference resolved".

**Fixed** by a new module, [`server/src/outbound.ts`](server/src/outbound.ts), and its application at both ends:

- A deployment-configured allowlist, `CANON_SOURCE_ALLOWED_HOSTS`. **Unset or empty means no outbound federation**, never "anything". Entries are `host`, `host:port`, or `*.domain`; a host with no port permits any port on it.
- `CANON_SOURCE_ALLOWED_SCHEMES`, default `https,http`. Every other scheme — `file:`, `gopher:`, `ftp:`, `data:` — is refused whatever the allowlist says.
- Credentials embedded in the URL (`https://user:pass@host`) are refused. Canon stores no secret material for a source, and a URL password would be exactly that, plus a secret in every log line that prints a baseUrl.
- Loopback, link-local (including the cloud metadata address), private, carrier-NAT, multicast, broadcast and reserved ranges are blocked in both address families — including the IPv4-mapped, NAT64 and 6to4 spellings of a blocked v4 address, so `::ffff:169.254.169.254` is not a way round `169.254.169.254`. `CANON_SOURCE_ALLOW_PRIVATE=true` is the explicit development opt-in, and it is what the `source-stub` connector suite now sets to reach its stub on `127.0.0.1`.
- Validation runs **when a source is registered or changed** (`sources.ts`) and **again when a reference resolves** (`httpconnector.ts`). Registration-time alone is bypassable; resolution-time alone would leave a source sitting in the register looking legitimate.
- At resolution time the hostname is also resolved and every address it resolves to is checked, so an allowlisted name that points at an internal address is refused before the request is made.
- Redirects are followed by hand, three hops maximum, with the full policy re-applied to every hop. A permitted host cannot bounce Canon into the private network on the second request.

**What this did not stop, stated plainly** — *as the review stood; superseded by the follow-up immediately below, which is left in place rather than deleted so the record of what was open, and for how long, survives.* The policy checks the resolved addresses but does not *pin* them: Node's global `fetch` offers no supported hook for supplying the socket address, so between the DNS check and the connection an answer can change. A deliberate DNS-rebinding attack from a host the operator has allowlisted can still land on an internal address. What makes that uninteresting in practice is the allowlist — the attacker must already control a name the operator chose to trust — but the window is real and is not closed. Closing it needs a connect-time hook (a custom dispatcher, or dropping to `node:http` with a fixed `lookup`), which is a bigger change than a security review should make on its own. **Recommendation: do it before the first live connector.**

Also unchanged: response content is not filtered. A permitted source that returns a scalar returns it, and that is the whole point of federation.

#### F1 follow-up — the connection is now pinned to the address that was checked · **done**

The recommendation above was taken before the first live connector, as it asked. Canon no longer uses global `fetch` for a source request. `outbound.ts` gained `resolveOutboundTarget`, and a new module [`server/src/pinnedhttp.ts`](server/src/pinnedhttp.ts) makes the request over `node:http`/`node:https` with a per-request `lookup`.

**What is guaranteed at connect time, precisely.**

- The hostname is resolved **once** per request hop, through an injectable resolver seam (`AddressResolver`), and the full address policy is applied to **every** address that answer contained. One blocked address among several refuses the whole host.
- The socket then connects to an address **from that same answer**, supplied by a `lookup` that ignores its hostname argument. There is no second name resolution anywhere between the check and the connection, so there is no second answer for an attacker to make differ from the first. `pinnedhttp.ts` also compares the socket's own `remoteAddress` against the pinned address and fails the request if they differ — a check that should be unreachable, asserted rather than assumed.
- The transport seam is handed an **address**, never a hostname. No substitute transport, in a test or in a future integration, can reintroduce a lookup.
- **Every redirect hop repeats the whole of it** — resolve, judge, pin — because a redirect is exactly where rebinding hides. Three hops maximum, as before.
- **TLS still binds to the name, not to the pinned address.** Only `lookup` is overridden: the request carries the real hostname, so SNI and Node's default `checkServerIdentity` see the name the operator allowlisted, and `rejectUnauthorized` stays on. A certificate for the wrong name is refused even when the address is correct. This mattered enough to test end to end, in a child process with a private CA, because closing an SSRF hole by opening a man-in-the-middle one would have been a worse trade than doing nothing.
- Everything the connector guaranteed before survives unchanged: the request timeout and its typed failures, `refused` (403/404 — a real answer, do not retry) versus `unanswered` (timeout, 5xx, unreachable, unparseable), and no value invented on any path. `CANON_SOURCE_ALLOWED_HOSTS`, `CANON_SOURCE_ALLOW_PRIVATE` and `CANON_SOURCE_TIMEOUT_MS` keep their names and their meanings. `CANON_SOURCE_ALLOW_PRIVATE` relaxes *which* addresses are permitted; it does not relax the pin, so the development path exercises the same code the deployment does.

**What is still not guaranteed, equally precisely.**

- **The allowlist is still the trust boundary.** Everything inside it is reachable and everything it returns is readable. Pinning stops a name being re-pointed; it does not make a trusted host trustworthy.
- **One lie still gets through.** The pin is only as good as the single DNS answer it was built from. Canon does not validate DNSSEC and does not authenticate its resolver, so a resolver that lies once is believed once — for HTTPS the certificate check is what catches that, and for plain HTTP nothing does. An operator allowlisting an `http://` host is trusting the network path as well as the host.
- **A multi-address host loses some availability.** All of its addresses must pass the policy or the host is refused; within one hop the addresses are tried in resolver order and only a *connection* failure earns the next one, so a host that accepts a connection and then misbehaves is not retried against a sibling address. A TLS or protocol failure stops at the address that produced it rather than shopping for a friendlier one.
- **Dual-stack ordering is the operating system's, not Canon's.** The resolver's `verbatim` order is preserved and the first address is tried first; a v6-first answer in an environment with no working v6 costs a connection attempt before the v4 fallback, inside the same request timeout. Global `fetch`'s happy-eyeballs was slightly better at this.
- **Response content is still not filtered**, exactly as above. That remains the point of federation.

Also added while here, and additive rather than a change of meaning: a source's answer is read up to 1 MiB and refused as `unparseable` beyond it. A federated value is a scalar; a source streaming megabytes at Canon is not answering the question.

**Tested** in [`server/test/pinning.test.ts`](server/test/pinning.test.ts) (13 tests), against actual rebinding rather than by assertion of intent: a scripted resolver that answers with one address the first time and a different one the second, two real servers on `127.0.0.1` and `127.0.0.2` sharing a port and returning different values — so *which value comes back is proof of which address the socket reached* — a rebinding answer the policy blocks being refused with nothing dialled, the same trick through a redirect hop, the TLS name-versus-address test above, the failure classifications, and the whole federation path end to end through `CanonStore` against the real `source-stub`. Sensitivity was checked by breaking the pin deliberately and watching the pinning and TLS tests go red.

### F2 — The audit log was readable in full by any actor · **High · fixed (behaviour change)**

`CanonStore.queryAudit` checked only that the asking actor existed — the comment said "audit access control tightens with the admin surface; presence check for now". Any actor could read every event in the record: page ids and titles from collections they hold no role in, send-back comments quoted verbatim in `details`, import file paths, source registrations, every question asked of `/ask`. `GET /audit.csv` exported the same thing. Combined with F-A1 below (`POST /actors` is open), an unauthenticated caller could mint an identity and read the lot.

**Fixed** by putting the permission filter in the SQL that generates the rows: an event naming a collection reaches a reader only where that reader holds a role in it. This is exactly the narrowing [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) §4.2 already fixes for agents, now applied to people too.

**This is a behaviour change and it is deliberate.** It is recorded here rather than done silently: an administrator's view of the log is now bounded by their collection memberships. That preserves CORE-PLAN's M4 exit ("an administrator can answer *who did what, when* from the audit log alone") for the collections they administer, and it removes the ability of a contributor in one collection to read the operational history of another. If the design partner's compliance lead needs an org-wide view, the right answer is an org-level administrator role — which `sources.ts` and `notify.ts` already work around with "admin on at least one collection" — not an unfiltered query.

*That org-level role now exists ([`server/src/orgrole.ts`](server/src/orgrole.ts)), and the paragraph above is still the rule: it grants no collection access, so it does not widen this filter. What it changes is the collection-less half below.*

Residual at the time, since closed: events that name **no** collection (`agent.session`, `agent.auth_failed`, `source.*`, `answer.ask` with no collection named) stayed visible to every actor. They now reach the actor they are about plus **an operator of this Canon** — see **R5**, which carries the argument and the cost, and the organisation role under F11, which replaced R5's "admin on at least one collection" stand-in with the real question.

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

### F10 — There was no authentication for people · **Critical · fixed** *(was R1)*

`X-Actor-Id` was an assertion, not a credential: knowing an actor's UUID *was* being that actor. `POST /actors` was open to unauthenticated callers, so anyone who could reach the port could mint an identity and then be it. Every other control in this document — collection roles, the audit narrowing in F2, the Registry intersection — sat on top of that, and §5's first assumption said so in as many words.

This was recorded as R1 rather than fixed because closing it is a product change, not a review's edit. It has now been made. **Fixed** by a new module, [`server/src/auth.ts`](server/src/auth.ts), a new stub to build it against, [`idp-stub/`](idp-stub/), and the application of both at the door in `api.ts`:

- **OpenID Connect, Authorization Code with PKCE.** `GET /auth/login` → the provider → `GET /auth/callback`. State, nonce and the PKCE verifier are held server-side and are **single-use**: a replayed callback finds nothing and is refused as an unknown state, which is the same refusal a forged one gets.
- **The ID token is actually verified.** RS256 only, checked with `node:crypto` against the provider's JWKS, fetched, cached and keyed by `kid` — with one refetch on an unknown `kid` so key rotation survives, rate-limited so a made-up `kid` cannot be used to hammer the provider. `alg: none` and every HMAC algorithm are refused by policy rather than by failing to find a key. Then issuer (exact), audience (`azp` required when there is more than one), `exp`, `nbf`, `iat` and **nonce** — a *missing* nonce is refused exactly as a wrong one is, because a token with no nonce may be a perfectly valid one replayed from elsewhere. The discovery document must itself name the issuer it was fetched from, so a provider that redirects cannot become a provider that substitutes.
- **Just-in-time provisioning on the subject, never the email.** A person authenticating for the first time gets a Canon actor from their verified claims; thereafter they are matched on the IdP subject, qualified by issuer, with a unique index in the storage layer rather than only in the lookup. An address changes and can be reassigned: matching on email would mean giving a leaver's address to a new hire hands them the leaver's history, roles and audit trail. Name and email follow the provider on each sign-in, so attribution stays true.
- **Sessions are server-side.** The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` unless the deployment is plain-`http` local, and carries a session id signed with HMAC-SHA256 — a pointer, never a bearer of claims. The signature is checked before the database is asked anything. Idle lifetime renews on use up to a hard absolute ceiling; **logout deletes the row**, so the same cookie presented afterwards authenticates nothing. `revokeSessionsFor(actorId)` cuts every session a person holds.
- **`POST /actors` is closed.** It exists only while dev authentication is on, and answers `404` otherwise — not merely refused, absent. People arrive by SSO; agents arrive by passport, where `agentauth.ts` creates the actor from the Registry's answer. Neither path needs it.
- **`X-Actor-Id` survives only as an explicit opt-in.** `CANON_DEV_AUTH=true` and nothing else. A server started without it refuses the header outright with `401 dev_auth_disabled`, and says at start-up which doors are open — alarmingly when dev mode is one of them. The test suite states the opt-in in `server/package.json`, so the suite runs against the same code path a developer does rather than a special case.
- **The three doors never mix.** A session cookie alongside an `X-Agent-Passport`, or alongside an `X-Actor-Id` naming somebody else, is `403 identity_mismatch` — the same refusal `agentauth.ts` already made for a passport plus a mismatched actor header, now complete for every pairing. REGISTRY-CONTRACT.md §2 stated the rule; all of it is now enforced.

Sign-ins, provisionings, failures and logouts are audit events (`person.session`, `person.provisioned`, `person.auth_failed`, `person.logout`). No ID token, authorization code, client secret or session id ever reaches an error message or the log; there is a test asserting it.

**What this did not do, stated plainly — and both halves are now done.** ~~Canon does not consume the provider's group or role claims, so collection membership is still granted inside Canon by an administrator; a person who signs in and holds no role sees an empty Canon, which is the correct default but is not the same as provisioning from a directory. There is no single-logout: revoking someone at the identity provider does not reach into Canon's session table, so their session survives until it expires or somebody calls `revokeSessionsFor`.~~ Group claims are consumed and mapped (**R10**), and a session is re-confirmed with the provider at least once a minute and can be ended by an operator on the spot (**R9**). The paragraph is struck through rather than deleted, because what a document said while a gap was open is part of the record of how long it was open.

### F11 — `GET /actors` disclosed the whole directory · **Medium · fixed (behaviour change)** *(was R2)*

Any actor could list every actor with their email address, and the web UI's identity picker depended on it — including for callers who were nobody at all, since the picker asked with a made-up actor id and the store never checked.

**Fixed** in `visibleActors` ([`server/src/auth.ts`](server/src/auth.ts)), with one rule per legitimate need:

- `GET /actors?collection=<id>` — that collection's member list, to anyone who may view it. This is the legitimate case: a member list is who you can name as an owner, an approver, or a mention. A non-member learns nothing, not even the size of the list, because the existing `listMembers` permission check runs first.
- `GET /actors` from an actor who is an **operator of this Canon** — the whole directory. An administrator "sets up collections, permissions and document types" (CORE-PLAN.md §2) and cannot grant a role to somebody they cannot find. *This originally read "an actor who holds `admin` on at least one collection", the same operator stand-in `sources.ts` and `notify.ts` used; see the organisation role below, which replaced it.*
- `GET /actors` from anyone else — themselves plus the people they actually share a collection with, with **email addresses omitted for everyone but themselves**.
- The dev identity picker moved to `GET /auth/dev/actors`, which exists only in dev mode. Keeping it off the record's route entirely is what lets `GET /actors` carry one rule for everybody rather than a rule with a hole in it.

**This is a behaviour change and it is deliberate**, in the same spirit as F2: a contributor's view of the organization is now bounded by who they work with. The residual is the operator case — an administrator of one collection still sees every actor and every address. Bounding *that* needs an org-level administrator role, which is the same missing thing F2 named, and inventing a second answer for it here would leave Canon with two.

#### F11 follow-up — the organisation role, and the five stand-ins it replaced · **done**

The residual above is closed, and so is the same residual in four other places. Canon now has an **organisation-level role** on the actor ([`server/src/orgrole.ts`](server/src/orgrole.ts)), stored as data, defaulting to `member`:

| Org role | What it means |
| --- | --- |
| `member` | The default, and the **absence** of a grant — no row is written for one. Everything a member can do comes from their collection roles and from nowhere else. |
| `operator` | Runs this Canon: flush the notification outbox, run the freshness sweep, register a Canon-wide source, read audit events that name no collection, list the actor directory, end a person's sessions. Grants **no** access to any collection's content, and no way to hand any out. |
| `administrator` | An operator who also administers permissions: sets other people's org roles, and may grant or remove collection membership anywhere. |

**The five checks that changed.** R5 said "when an organisation-level administrator role arrives, those three checks change together — that is the whole list", and listed the audit narrowing, `notify.ts`'s `flushFor` and `sources.ts`'s `requireSourceAdmin`; F11 and F2 added the directory. Grepping for the same shape found a fifth, `freshness.ts`'s `requireOperator`. All five now ask `requireOrgRole(db, actorId, 'operator', …)`:

| Where | What it used to ask | What it asks now |
| --- | --- | --- |
| `store.queryAudit` | admin on some collection, for events naming none | operator |
| `auth.visibleActors` | admin on some collection, for the whole directory | operator |
| `notify.flushFor` | admin on some collection | operator |
| `sources.requireSourceAdmin` (unscoped source only) | admin on some collection | operator |
| `freshness.requireOperator` | admin on some collection | operator |

The stand-in was wrong in **both** directions, which is the whole argument: a team lead who administers one collection was an operator of the entire Canon, and a genuine operator with no collection membership could not flush the outbox, run the sweep, or find anybody in the directory. Both halves are tested, from both sides, in [`server/test/orgrole.test.ts`](server/test/orgrole.test.ts). A source *scoped* to collections is unchanged: that is still admin on every collection in its scope, because it is still a collection-level act.

**`administrator` does not imply collection access, and that is the decision.** An administrator holds no `view` anywhere they were not given one: they cannot read a page, list a tree, search a body, retrieve a passage, or be answered from material they hold no collection role in — there is a test asserting each of those. Running the system is not the same job as being entitled to the corpus, and that separation is exactly what a regulated buyer asks about.

**The residual, stated rather than sold as an impossibility.** An administrator *may grant themselves* a collection role, because administering permissions is what the role is for and a Canon whose last collection admin leaves must not become unadministrable. So the honest claim is not "an administrator cannot read your collection" but "**an administrator cannot read your collection without leaving a `collection.member_set` audit event with their name on it, made before the read**". Accountable access rather than silent access. An `operator` cannot do even that.

**The first administrator** is the one grant nobody can be authorised to make. `CANON_BOOTSTRAP_ADMIN_SUBJECT` names a person at the identity provider and re-asserts the role on every sign-in — the recommended answer, because it grants nothing to whoever arrives first and cannot be locked out. With it unset **and no administrator in the record**, the first person to sign in becomes one, with a loud console line and an `org_role.bootstrap` audit event naming them. That window is exactly one person wide, closes permanently at the first sign-in, and only ever admits somebody the deployment's own identity provider authenticated; the alternative — no bootstrap at all — means `requireOrgRole` refuses everybody forever and the repair is hand-editing the database, which is the one operation an audit log cannot describe. On a dev machine (`CANON_DEV_AUTH=true`, where nobody signs in) `CANON_BOOTSTRAP_ADMIN_ACTOR_ID` names an actor id, and `store.bootstrapAdministrator()` refuses once any administrator exists, so it is not a second way in.

---

## 3. Recommendations — the behaviour changes, and what the team decided

Each of these was a behaviour change the team had to decide on rather than something a security review should land on its own. R1 and R2 are still open and belong with SSO. R3 through R8 were decided and are now implemented; each carries its decision, what changed, and — where the recommendation was not followed exactly — the argument for the version that shipped instead.

### R1 — There is no authentication · **fixed, see F10**

Closed. `X-Actor-Id` is now an explicit development opt-in (`CANON_DEV_AUTH=true`) and refused otherwise; people sign in through OpenID Connect; `POST /actors` exists only in dev mode. The deployment gate this entry described is discharged — with the caveats F10 states about group claims and single-logout, and R9 below.

### R2 — `GET /actors` discloses the whole directory · **fixed, see F11**

Closed. A member list per collection to its members, the whole directory only to an operator, colleagues without addresses to everyone else.

### R3 — A mention notified any actor, including non-members · **fixed (behaviour change)**

`comments.ts` resolved `@<actorId>` against the whole actor table and emailed whoever it found. A commenter on a page in a restricted collection therefore emailed the page's title and their own comment to someone with no role in that collection. The notification's *subject* and *body* are the leak: the subject is the page title, the body is the comment verbatim.

**Decision: withhold the notification, and tell the commenter.** A mention now reaches only an actor who holds a role in the page's collection. The comment itself lands in full, with the mention text intact; no notification is written for anyone else; and `POST /pages/:id/comments` answers with `mentions: { notified: [...], withheld: [{ actorId, reason: "no_access" }] }`, so the person who typed the `@` is told which ones did not go anywhere. The withheld ids are on the `comment.create` audit event too.

The two rejected alternatives, since the recommendation left the choice open:

- **Refusing the comment** is disproportionate — it throws away writing over an addressing mistake — and it turns a restricted collection's membership into something probeable one `@` at a time from an error message.
- **Notifying without content** still leaks: that a page exists, and that they were named on it. It also produces a notification nobody can act on — a link the recipient cannot open, with no way to tell whether it matters.

"Mention someone to bring them in" survives as a workflow; it just becomes a deliberate one, where the commenter is told to go and grant access rather than believing they have already summoned somebody. **Not done, and named here as the loose end:** `server/public/app.js` does not yet surface `mentions.withheld` in the comment box. The API reports it; the web UI still needs a line of copy for it, and that file was being changed by another stream while this landed.

### R4 — Existence was checked before permission · **fixed where it counts, and only there**

`store.getCollection`, `store.getPage`, `store.getVersion`, `sources.get` and `ImportService.getRun` all threw `not_found` for a missing id before checking whether the asker may see it, so a `403` versus a `404` told an outsider whether an id is real.

**Decision: fix the two places where the oracle is real, leave the rest 403 on purpose, and write down the rule that decides which is which.** The rule: *existence may be disclosed to somebody holding a role in the collection that governs the object; it may not be disclosed to somebody holding none, when the id space is guessable or when a listing already hides the object.*

**Fixed — the import run register.** A run id is **caller-supplied** (`ImportInput.runId`, which exists so an interrupted migration can be resumed), so it is whatever an operator typed: `migration-1`, `confluence-2026-07`. That is the one guessable id space in Canon, and a guessable id space with a distinguishable refusal is enumerable. `getRun` now answers a run in a collection the caller holds no role in with exactly the error — same code, same message — that a run id nobody ever used gets.

**Fixed — the source register.** `list` already omits a source scoped to collections the asker is not in; `get` said "yes, that exists, and you may not have it", so the two answers to the same question disagreed and the narrowing could be undone one id at a time. `get`, `update` and `remove` now answer `not_found`, word for word identical to an id that was never registered. The source register is an inventory of the external systems Canon federates with, which is worth not confirming. A member who *can* see the source and simply lacks `admin` still gets the explanatory `forbidden`.

**Deliberately left distinguishable: pages, collections, versions, comments, proposals, saved queries, drafts.** Three reasons, and they are a judgement rather than a rule:

1. Every one of those ids is a random UUID. A 403 confirms an id the asker already had; it does not let anyone find one.
2. The 403 is load-bearing product behaviour. A page link is shared out of band constantly in a wiki, and the person who follows one without access needs to be told *"you need view on this collection — ask its admin"*, not *"that page does not exist"*. The second answer makes a working record look broken and turns every access request into a support ticket.
3. Indistinguishable errors make real debugging miserable, and this is a product people operate.

**Also deliberately left as it is:** `POST /imports` with a run id already used for a different export answers `conflict`. That does confirm the id is taken — but it names nothing else (not the collection, not the path, not the actor), and the alternative is silently writing into another collection's run, which is far worse than the leak. Recorded rather than quietly kept.

### R5 — Audit events with no collection were visible to everyone · **fixed (behaviour change)**

The residual from F2. `agent.session` events carry an agent's full permitted-collections and permitted-sources lists — a map of the record's shape, drawn for somebody holding no role in any of it. `answer.ask` events carry the question text, which is often the most sensitive sentence anybody types into Canon. `source.create` / `source.update` / `source.delete` name every external system Canon federates with.

**Decision: taken as recommended.** An event naming no collection now reaches the actor it is about, plus holders of `admin` on at least one collection. Both halves are in the SQL that generates the rows, alongside F2's membership filter, so the same single query answers both rules.

Two things are stated rather than glossed:

- **This narrows for agents as well as people**, because an agent is an actor and Canon has one actor model. It does not contradict REGISTRY-CONTRACT §4.2 — that rule is about narrowing a cross-collection *response* to `permittedCollections`, and `agentauth`'s `narrow` still applies it on top of whatever survives the store. A limit that runs before another limit cannot widen it. An agent still reads its own `agent.session` events; it reads nobody else's.
- **"Admin on at least one collection" is a stand-in, and a coarse one.** An administrator of any collection can read every collection-less event, including asks by people in teams they have nothing to do with. It is used here because `notify.ts` (`flushFor`) and `sources.ts` (`requireSourceAdmin`) already define "operator" that way, and a second, different definition of operator would be worse than one coarse one. When an organisation-level administrator role arrives, **those three checks change together** — that is the whole list.

  *It arrived; they changed together, and the list turned out to be five rather than three (the directory, and `freshness.ts`'s sweep). The rule here is now "the actor the event is about, plus an **operator** of this Canon". See the organisation role under F11.*

The cost, named: an ordinary member can no longer see that an agent asked a question. The compliance question CORE-PLAN §6 actually asks — "zero agent actions outside Registry-granted permissions, verified by audit log review" — is an administrator's, and administrators still see all of it.

### R6 — An import required only `edit` · **fixed (behaviour change)**

`POST /imports` reads a server-side path chosen by the caller and lands up to `MAX_FILES_PER_RUN` (2000) pages in one call, with titles and bodies taken verbatim from files nobody in Canon has reviewed. The summary it returns names the server path back to the caller.

**Decision: taken as recommended — `admin` on the target collection.** CORE-PLAN §2 puts this on the administrator's side of the line ("Administrator. Sets up collections, permissions, and document types"), and §4 files import under Epic E, "Trust and arrival", with the audit log rather than under Epic B's daily writing loop. A contributor who needs a corpus imported asks the person who set the collection up — the same conversation they already have about permissions.

Reading a run's record (`GET /imports`, `GET /imports/:id`) deliberately stays at `view`: the bar belongs on aiming the run, not on seeing what it did to a collection you belong to. `CANON_IMPORT_ROOTS` is unchanged, still opt-in, and still recommended for every deployment — the README's wording now says `admin` rather than `edit` where it names the trust level involved.

**Surveyed while in there, and left alone.** The other bulk or destructive operations were checked against the same argument and all of them already sit in the right place: the freshness sweep (`admin`, and unclassified for agents entirely), the notification flush (`admin`), source registration and removal (`admin`, plus `"*"` for agents), collection membership changes (`admin`), and reference removal (`edit` on the page's own collection — one object, one page). `movePage` moves a branch with its children and stays at `edit`: it is reorganising a collection you already write to, which is authoring. `archivePage` and `restore` act on one page and stay at `edit` for the same reason. No second change was warranted.

### R7 — Internal error messages reached the client · **fixed**

`api.ts`'s catch-all returned `{ error: 'internal', message: err.message }` with a 500 — SQLite statement text, absolute server filesystem paths, whatever happened to be in the throw.

**Decision: taken as recommended.** An unexpected error now mints a UUID, logs `[error <id>] METHOD path` with the whole error and its stack to the server's log, and answers the caller with `{ error: "internal", message: "Canon could not complete this request. Quote the error id when reporting it.", errorId }`. Correlatable, not disclosed: an operator holding the id from a bug report finds the one line that explains it.

**`CanonError` is untouched, and that is the point of doing it this way.** Its messages are written for the person reading them — *"This page is being edited by Marc"*, *"A policy requires a named approver before it can publish"*, *"Only the named approver can grant the Canonical mark"* — and every one of them is composed here, from the record, for a caller the store has already decided may know it. Blanking those in the name of security would make Canon unusable and protect nothing.

The tangle the original note worried about turned out not to be one: an import summary's `path` is a *success* payload returned to the caller who supplied that path, not an error message, so the product feature and the leak were never the same code.

### R8 — No rate limiting · **fixed, proportionately**

Nothing bounded requests per actor.

**Decision: an in-process token bucket per actor, on the four routes that spend somebody else's resources, and on nothing that reads the record.** `server/src/ratelimit.ts` is new; `api.ts` maps routes to buckets in a table of its own, deliberately separate from the route table, the way `agentauth.ts` keeps its classification separate.

| Bucket | Route | Default | Why |
| --- | --- | --- | --- |
| `ask` | `POST /ask`, `POST /knowledge/ask` | 12 burst, 12/min | Retrieval over the whole visible corpus, then generation. With a hosted embedding provider, also a per-request bill. |
| `references` | `GET /pages/:id/references` | 60 burst, 60/min | Reaches an external system, once per reference, with Canon's own service identity on the request. |
| `import` | `POST /imports` | 2 burst, 0.5/min | Walks an operator-named directory and writes a page per document. An operator's act measured in minutes. |
| `auth` | Agent Passport authentication | 20 burst, 20/min | The brute-forceable door. |

Every limit is configurable (`CANON_RATE_LIMIT_ASK` and friends, written `burst/perMinute` or `off`; `CANON_RATE_LIMIT=off` disables the lot). See `server/README.md`.

Three decisions inside this one worth naming:

- **Nothing that reads the record is limited.** `GET /pages/:id`, `/search`, `/collections`, `/audit`, `/notifications` and the whole Knowledge read surface have no bucket, and a test asserts it. The one failure this must not have is a person unable to read a policy at the moment they need it: a limiter that can do that has cost more than the load it prevented. A new route is unlimited by default — the opposite of `agentauth`'s default, and for the opposite reason.
- **The auth bucket is keyed by the connection's origin, not by actor**, because the actor is precisely what an unverified passport is asserting; keying a brute-force limiter by the credential being guessed would limit nothing. **Only a failed authentication spends a token**, so a busy honest agent never meets this bucket at all. When SSO lands (R1), its login route belongs in this bucket, on this key. `X-Forwarded-For` is deliberately not trusted — behind a proxy that collapses origins this bucket degrades to a per-proxy limit, which is honest but weaker, and a deployment in that shape should limit logins at the proxy.
- **It is in process.** Several Canon processes limit per process. That is proportionate for the alpha and it is written down rather than implied; a distributed limiter needs a shared store Canon does not have, and building one here would have been the wrong-sized change.
Nothing bounds requests per actor. `POST /ask` is the expensive one, and `GET /auth/login` now joins it as an unauthenticated route that costs the server work (a row, and a discovery fetch on a cold cache). Assumed to be handled by whatever sits in front of Canon; recorded because that assumption is not written down anywhere else.

### R9 — A session outlives a revocation at the identity provider · **fixed (behaviour change)**

New with F10. The agent door re-asks the Registry at least once a minute, which is what makes "revoking an agent cuts its access within a minute" true. The people door did not: an ID token was verified once, at sign-in, and the session that followed was Canon's own. Disabling someone in Entra ID or Okta therefore did nothing to a session they already held until it expired — up to `CANON_SESSION_MAX_LIFETIME_MS`, a day by default.

**Decision: the commitment is made, in the same terms and to the same number as the agent one.** [REGISTRY-CONTRACT.md](REGISTRY-CONTRACT.md) §3 says of agents: "Canon may cache a verified answer … but for no more than sixty seconds. The sixty-second cap is not a tuning knob; it is the guarantee." The people-facing sentence is now:

> **Canon confirms a person's session with their identity provider at least once every sixty seconds. Disabling somebody at the provider ends their access to Canon within a minute, whatever session they are holding — and an operator can end it immediately.**

Built to the shape `agentauth.ts` already proves works ([`server/src/auth.ts`](server/src/auth.ts)):

- **A session carries the time it was last confirmed** (`auth_sessions.confirmed_at`). Past `CANON_SESSION_CONFIRM_MS` the next request re-confirms **before it is served**. The window defaults to 60 000 ms and is **clamped to 60 000 ms** in the constructor, exactly as `RegistryClient` clamps `CANON_REGISTRY_TTL_MS` to `REVOCATION_GUARANTEE_MS`; `0` confirms on every request. A deployment can tighten the guarantee and cannot loosen it.
- **The confirmation is a live call to the provider's token endpoint** with the session's refresh token. Three outcomes, and none of them is an allowance: the provider refuses (disabled, grant withdrawn) → `401 revoked_at_idp` and **every** session that person holds is deleted, because the provider has said the *person* is gone; the provider cannot be reached or answers unreadably → `503 idp_unreachable`, request refused and **nothing deleted**, so recovery is immediate when it returns (the rule REGISTRY-CONTRACT §5 already keeps by never caching "no answer"); there is nothing to confirm *with* → the session is deleted and the person signs in again.
- **The refreshed ID token is validated exactly as a fresh one is** — signature, issuer, audience, expiry — minus the nonce, which is the one check that cannot apply: nothing about that token travelled through a browser (OIDC Core 12.2). The subject must still match the session's.
- **Confirmations are single-flighted per session.** A burst past the window costs one round-trip, not one per request — which also matters because real providers rotate refresh tokens, and eight parallel refreshes would leave seven dead.
- **Real revocation has a route at last.** `PersonAuth.revokeSessionsFor` existed with no caller; `DELETE /auth/sessions/:actorId` is that caller, open to an **operator** (the org role under F11), audited as `person.sessions_revoked`, and immediate — deletion, not expiry.

**What this cost, stated plainly: Canon now stores one credential.** Confirming a session needs a refresh token, and §5's assumption 7 ("Nothing in Canon ever stores a credential") is amended there rather than quietly broken. It belongs to one session and dies with it; it is sealed at rest with AES-256-GCM under a key derived from `CANON_SESSION_SECRET`, so a stolen `canon.db` is not a set of live credentials without the deployment's environment; it never leaves Canon except to the provider's own token endpoint, and never reaches an audit event, an error, a payload or the console. `CANON_OIDC_SCOPE` now asks for `offline_access` by default, and a provider that will not grant it — or will not return an ID token on refresh — leaves sessions that end at their first window rather than sessions Canon pretends to be confirming.

Tested in [`server/test/sessionconfirm.test.ts`](server/test/sessionconfirm.test.ts) against the real `idp-stub`: served inside the window with no provider round-trip, re-confirmed past it, a person disabled mid-session cut at the window (and their second session with them), an unreachable provider failing closed without deleting anything, a provider that issues no refresh token, single-flight under a burst, the sealed token never appearing in a payload or the log, and revocation by an operator ending both of somebody's sessions on the spot.

### R10 — Nothing behind SSO is provisioned from the directory · **fixed (behaviour change)**

Also new with F10. Canon read `sub`, `name` and `email` from the ID token and no group or role claim. A person who signed in successfully and held no collection role saw an empty Canon until an administrator granted them one. That is the right default — a claim from a directory is not a Canon permission — but a partner with hundreds of staff will want group-to-collection mapping, and designing it badly (an IdP group silently granting `admin`) would undo F2 and F11 at once. The recommendation was to design it together with the org-level administrator role F2 and F11 both ask for, not before.

**Decision: taken as recommended, and landed with that role.** [`server/src/groupmap.ts`](server/src/groupmap.ts):

- **A configurable group claim** (`CANON_OIDC_GROUPS_CLAIM`, default `groups`), read as an array of opaque strings. A single bare string is accepted; anything else — an object, a number, a missing claim — reads as *no groups*, never as everything.
- **A deployment-configured mapping**, `CANON_GROUP_MAP` (or `CANON_GROUP_MAP_FILE`): one rule per line, `<group> -> collection:<collectionId>:<role>` or `<group> -> org:<operator|administrator>`. Configuration, not a UI: mapping a directory group onto a role in a regulated record is a decision made once and reviewed where the rest of a deployment's configuration is reviewed.
- **Refused at configuration time.** A rule with bad syntax, an unknown role, an unknown org role, or a collection that does not exist makes the server fail to start, naming the rule. A mapping quietly ignored surfaces weeks later as somebody holding less access than the operator believes they granted.
- **Applied on every confirmation, not only at first sign-in.** The refresh in R9 returns a current ID token, so a group added at the provider grants its role within the same sixty seconds, and a group removed there removes what it granted within the same sixty seconds.
- **Mapped access is distinguishable from hand-granted access, which is the part that would otherwise have undone F2 and R5.** `collection_members` stays the **effective** role — the stronger of the two sides — so every membership join in search, retrieval, embeddings, queries, the graph and the audit narrowing is untouched. Underneath it, `collection_hand_grants` holds what an administrator granted and `collection_group_grants` holds one row per group per collection, rewritten wholesale from the claim on each confirmation. So revoking a group removes exactly what that group granted and leaves a hand grant standing; withdrawing a hand grant leaves no phantom mapping; and `DELETE /collections/:id/members/:actorId` answers `{ removed, remaining, groups }`, so an administrator taking their grant back is *told* when a directory group is still holding the person's access up rather than discovering it later. The org role has the same two halves.
- **It never widens the record's own permission model.** A rule's target is a collection role from Canon's fixed vocabulary or an org role, and there is no third kind: a group cannot make somebody a page's approver, bypass a document type's rules, mint a collection, or reach a collection no rule named. A mapped `edit` is `edit`, through the same table and the same checks a hand grant goes through.
- **Inspectable, because "why does this person have edit here" is a real question an operator has to answer.** `GET /auth/mapping` returns the rules as configured; `GET /auth/access/:actorId` returns the org role with its hand and mapped halves separately, the groups the person's last confirmed ID token carried, and per collection the hand grant, the group grants and the effective role. Every change is a `person.access_mapped` audit event naming what was granted and what was revoked — and a confirmation that changes nothing writes no event, so the log does not fill with heartbeats.

A group granting `administrator` is legal and is shouted about at start-up, because it is the one rule that hands the identity provider control of who administers Canon.

Tested in [`server/test/groupmap.test.ts`](server/test/groupmap.test.ts) and [`idp-stub/test/idp.test.ts`](idp-stub/test/idp.test.ts): granting on first sign-in and on re-confirmation, a removed group removing exactly the mapped access with a hand grant surviving underneath, a hand grant surviving three confirmations and leaving no phantom, the withdrawal report, a mapped role that cannot approve or administer, both claim names, and a rule naming a collection or a role that does not exist refused when the door is built.

### R11 — The web UI shipped without security headers · **fixed (hardening)**

The review scoped deployment out (§1), and TLS termination and network policy stay a proxy's job. But the *response headers* that defend a browser are Canon's to send, and it sent none: the document arrived with no Content-Security-Policy, no clickjacking guard, and no content-type-sniffing guard, so a single stored-XSS foothold anywhere in the rendered record — a place the safe-subset renderer missed, a future feature that forgets it — would run with nothing standing in front of it, and the whole UI could be framed for a clickjacking overlay.

**Fixed** in [`server/src/static.ts`](server/src/static.ts), `securityHeaders`. Canon's front end is deliberately self-contained — `index.html` loads one same-origin stylesheet and one same-origin ES module, and `app.js` carries no inline `<script>`, no inline event handler, and no `eval` — so the document now ships a real CSP with `script-src 'self'`: the injection vector that matters is shut without a single code change to the app. `style-src` keeps `'unsafe-inline'`, deliberately and narrowly, because the app sets `style=""` on skeleton widths and on the SVG map's CSS custom properties; an inline style cannot execute script, and the alternative was a large refactor that bought nothing. `frame-ancestors 'none'`, `object-src 'none'` and `base-uri 'self'` shut framing, plugins and a rewritten `<base>`; `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` back them for older agents. The JSON API surface carries `nosniff` and `Referrer-Policy: no-referrer` too, so a URL that names a page never leaves in a referrer. HSTS is the one header that depends on the deployment: a browser ignores it over the plain HTTP Canon speaks behind its proxy, and its presence would imply a guarantee that transport does not make, so it is emitted only when `CANON_BASE_URL` says the edge is HTTPS — where it pins the upgrade for two years.

Tested in [`server/test/securityheaders.test.ts`](server/test/securityheaders.test.ts): the document's CSP forbids inline script and permits inline style, HSTS appears only on a secure edge and never on plain HTTP, a sub-resource carries the transport headers but not the document policy, and the JSON API is `nosniff` and referrer-free.

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

**Append-only history.** `page_versions` and `audit_events` are protected by SQLite `BEFORE UPDATE`/`BEFORE DELETE` triggers, in the storage layer rather than only in application code, so no code path — including a future one — can rewrite them. The triggers are a guard rail against the application and against a careless hand, and they are one `DROP TRIGGER` away from an attacker with write access to the file: the hash chain over `audit_events` is what makes that visible, and §5 assumption 9 is what makes it provable. Neither is claimed to be more than it is, here, in `auditchain.ts`, or in the bundles.

**Attestations state how identity was established.** They did not, and a bundle generated behind an open dev door was indistinguishable from a federated one — the chain protecting a false attribution as faithfully as a true one (USER-TESTING.md T3.1). Every bundle now carries, on its face and in its manifest, either the OIDC issuer that vouched for the people named in it or the sentence that identity here was asserted and not verified; and, per actor, whether the record holds an identity-provider subject for them at all, read from `actors.sso_subject` rather than from configuration. An actor created by hand on an SSO deployment is named as the exception it is, which is what separates a real person from a namesake somebody typed.

**Static file serving.** `static.ts` accepts only `^[A-Za-z0-9][A-Za-z0-9._-]*$` as a filename, which admits no separator, no dotfile and no traversal, and only serves extensions in a fixed content-type table.

**SMTP wire handling.** Dot-stuffing is correct, envelope addresses are validated for CR/LF and angle brackets, STARTTLS is required whenever credentials are present so a password never crosses in clear, and AUTH exchanges are never logged.

**CSRF ~~is not applicable~~ is handled.** This paragraph used to read "identity travels in a custom header, never a cookie, so there are no ambient credentials for a cross-site request to borrow — this stops being true the moment SSO introduces a session cookie". SSO has introduced a session cookie, so it is true no longer, and the prediction is worth keeping visible because it is exactly the kind of paragraph that goes stale silently.

What is there instead (`assertCsrf` in [`server/src/auth.ts`](server/src/auth.ts)): a request that is **cookie-authenticated** and **not a safe method** must satisfy *both* checks, or it is `403`.

1. **Origin.** `Origin`, or `Referer` when there is no `Origin`, must be an origin the deployment allows (the redirect URI's own, plus `CANON_ALLOWED_ORIGINS`). Browsers send `Origin` on every cross-site POST including form submissions, so this catches the classic attack outright and costs an honest caller nothing. An opaque origin (`null` — a sandboxed iframe, a `data:` document) is refused rather than treated as absent.
2. **A session-bound token** in `X-Canon-CSRF`, compared in constant time against a token minted with the session and held **server-side beside it**. This is a synchronizer token, not a double-submit cookie: a double-submit is forgeable by anyone who can write a cookie on the domain — a sibling subdomain, a network position on plain HTTP — and Canon holds a regulated corpus, so the cheaper pattern is not worth the caveat. A custom header also cannot be produced by a form post at all, and cross-origin JavaScript cannot read the token because Canon emits no CORS headers.

Both, because either alone has a gap: origin checking fails open on a request carrying neither `Origin` nor `Referer`, and a token alone is spent the moment one leaks into a URL or a log. `SameSite=Lax` on the cookie is a third layer and is not relied on as any of them.

Requests identified by `X-Actor-Id` or `X-Agent-Passport` are **exempt**, and that is correct rather than convenient: neither is ambient, so no cross-site page can cause one to be sent. The exemption is keyed on how the request was actually authenticated, not on which header happens to be present, so it cannot be claimed by attaching a header.

**The stubs.** `registry-stub`, `source-stub` and `idp-stub` leave their administrative faces unauthenticated. All three say so in their own headers, all three are test doubles, and none is deployable. `idp-stub` goes further and authenticates no *person* either — `?login_hint=<sub>` issues a code on the spot, which is what makes the flow drivable from a test with no browser, and is also what makes running it anywhere real equivalent to having no authentication at all. No finding is raised; they must never be run anywhere real, which is what "stub" is doing in their names.

---

## 5. What would break this

The assumptions the design rests on. If one of these stops being true, re-read this document rather than trusting it.

*Each of these is an assumption about a deployment's configuration, so each is cross-referenced from the safety column of [CONFIGURATION.md](CONFIGURATION.md), variable by variable, and the ones that can be checked mechanically now are — Canon refuses to start with `CANON_DEV_AUTH` set beside a real identity provider (assumption 1), with `CANON_DEV_AUTH` set beside a non-loopback `CANON_BIND` (assumption 1), with single sign-on and no `CANON_SESSION_SECRET` (assumption 1), or with an allowlisted federation host that does not resolve (assumption 2). [OPERATIONS.md](OPERATIONS.md)'s first-hour checklist walks the rest.*

1. **`CANON_DEV_AUTH` is not set in any deployment that matters.** This used to read "everyone who can reach the port is trusted to be who they say they are", and F10 has replaced the trust with a verified ID token — but the old behaviour is still one environment variable away, because tests and local work genuinely need it. With it set, `X-Actor-Id` is believed and `POST /actors` is open, and every authorization control in Canon is downstream of that again. The server shouts about it at start-up. **The one thing a deployment must get right is not setting it**, and the second is `CANON_SESSION_SECRET`: without one, sessions are signed with a per-process key, which is survivable on a single instance and silently breaks behind a load balancer.

   Set nonetheless, the header can no longer reach the network by accident: dev auth binds to loopback by default and Canon refuses to start if an explicit `CANON_BIND` would expose it. A privacy review demonstrated the header forged from another machine against a demo server that had bound to all interfaces; that server would now bind to `127.0.0.1`, and the forgery could not open the socket. This narrows the blast radius of the mistake to the one box, but does not make the mistake safe — the assumption stands.

   The second half of the old assumption still holds in a new place: an identity provider that will issue a token for anybody is a Canon anybody can enter. `idp-stub` is exactly such a provider — it authenticates nobody, by design — so it must never be what `CANON_OIDC_ISSUER` points at outside a test.

2. **A collection admin is trusted with the network the server sits on.** F1's allowlist moves that trust from a collection admin to whoever writes `CANON_SOURCE_ALLOWED_HOSTS` — and everything inside the allowlist is still reachable. Add a host to that list and you are asserting it is safe for Canon to fetch, follow redirects within, and read responses from. The connection now goes to the address that was checked and to no other (F1 follow-up), so an allowlisted name can no longer be re-pointed at an internal address between the check and the connect; what remains is the allowlist itself, one unauthenticated DNS answer per hop, and — over plain `http://` — the network path.

3. **The importer's path is chosen by someone trusted with the filesystem.** `admin` on one collection buys the ability to name any server path (R6 raised it from `edit`). The symlink fix contains a run to its root; `CANON_IMPORT_ROOTS` bounds the root, and is still off by default. The trust level is now the right one; the bound on it is still opt-in.

4. **The Registry is honest and reachable.** Canon holds no agent trust of its own. A compromised Registry is a compromised Canon for every agent, immediately and completely. The sixty-second cache means it is also a *sixty-second* Canon — revocation is bounded, but so is any window in which the Registry lies.

5. **`agentauth`'s route table and `api.ts`'s route table stay in step.** They are deliberately separate so that a new route is closed to agents by default. That safety depends on the default staying "refuse", which is now tested. A future change that adds a fallthrough or a wildcard rule removes the protection silently.

6. **Permission filtering stays in the SQL.** Retrieval's guarantee is that invisible material never influences ranking, context or the answer. That holds because the membership join is in every candidate query and in `hydrate`. A future optimisation that fetches first and filters afterwards would satisfy every existing test and break the guarantee.

7. **Canon stores exactly one credential, and it is a person's own refresh token.** This used to read "Nothing in Canon ever stores a credential", and R9 changed it: confirming a live session with the identity provider needs a refresh token, so `auth_sessions.refresh_token` holds one. The rest of the assumption stands and is what keeps this one bounded — no Agent Passport, no per-asker source credential, no `credential` column on `sources`, and the comment in `sources.ts` naming that as "the change to refuse" is still load-bearing. What is now assumed about the one exception: it belongs to a single session and is deleted with it (logout, revocation, expiry, a refused confirmation); it is sealed with AES-256-GCM under a key derived from `CANON_SESSION_SECRET`, so **a deployment that leaves that variable unset is also leaving these tokens sealed under a per-process key that dies at restart** — which is survivable, and is one more reason to set it; it is presented only to the provider's own token endpoint; and it reaches no log, error, payload or audit event. If that trade stops being acceptable, the thing to remove is the confirmation, and with it R9's guarantee — not the sealing.

8. **The renderer's contract is "escape everything, then generate our own markup".** `app.js` is safe because `esc()` runs first, unconditionally, on every value. One `innerHTML` that interpolates a record value without it undoes the whole of §4's first paragraph.

9. **Somebody keeps the audit chain's head hash where Canon cannot write it.** The chain in [`server/src/auditchain.ts`](server/src/auditchain.ts) is tamper-*evident*, not tamper-proof, and the difference is the whole of this assumption. It catches every accident and every careless edit, and it does not catch an attacker who can write to the database file: delete an event, recompute every later link, and `GET /audit/verify` answers `ok: true` — done to a Canon record during user testing (USER-TESTING.md T3.2), against a live 1,171-event log. That is not a defect in the construction; a chain proves internal consistency and a wholesale recomputation restores internal consistency.

   What converts it into a claim about authenticity is a head hash recorded outside Canon *before* the period in question. Canon now produces that value on a schedule — an `audit head anchor` log line hourly, a file where `CANON_ANCHOR_FILE` names one, and `scripts/anchor-head.js` for a scheduler — and **it cannot do the part that matters**, because the log line and the file are inside the same trust boundary as the database. The assumption is that a deployment ships the series somewhere this host has no credentials for, and keeps it. OPERATIONS.md, "Anchor the chain head", gives the recipe and the test for whether a destination counts.

   The half that does not depend on the operator: every attestation bundle carries the head hash at generation, so a bundle a *reader* retained is an anchor in their own custody. `scripts/compare-attestations.js` compares a retained bundle against a fresh one offline and names any deletion, reattribution or recomputation between them — which is precisely how the forgery above was caught. Bundles now say so on their face. That is a mitigation nobody at the customer has to be configured to perform, which is why it is stated in the artefact and not only here.

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

### 6.1 Changes made by the F1 follow-up

Recorded separately from the table above, because they were made after the review rather than by it.

| File | Change |
| --- | --- |
| `server/src/pinnedhttp.ts` | **New.** The outbound request over `node:http`/`node:https` with a per-request `lookup` that returns only the checked address; TLS still verified against the hostname; one timeout over the whole exchange; a 1 MiB response read cap; the transport seam. |
| `server/src/outbound.ts` | `assertOutboundAllowedResolved` replaced by `resolveOutboundTarget`, which returns the checked addresses rather than only a verdict; `AddressResolver` seam; `canonicalAddress`/`sameAddress`. |
| `server/src/httpconnector.ts` | Requests go through the pinned transport instead of global `fetch`; the `fetchImpl` option is replaced by `transport` and `resolver`; each redirect hop re-resolves and re-pins. Failure classification unchanged. |
| `server/test/pinning.test.ts` | **New.** 13 tests: the rebinding harness, redirect rebinding, TLS name binding, the failure classifications, and the federation path end to end against the real `source-stub`. |
| `server/test/tlspin-child.ts`, `server/test/tlspin-cert.ts` | The TLS test's separate process and its published-on-purpose test certificate. |
| `server/tsconfig.json` | Compiles `source-stub/src` too, so a server test can drive the real stub in-process — the arrangement `registry-stub` already had. |
| `source-stub/test/connector.test.ts` | The two observing seams moved from `fetchImpl` to `transport`. |
| `server/README.md` | The pin, and what it does and does not promise. |

**Test counts after the follow-up:** `server` 225 (was 212), `registry-stub` 10, `source-stub` 13. All pass.

### 6.2 The second pass: R3–R8

| File | Change |
| --- | --- |
| `server/src/ratelimit.ts` | **New.** Token buckets per actor, the four bucket definitions and their defaults, and the environment parsing (R8). |
| `server/src/model.ts` | New `rate_limited` error code, 429 (R8). |
| `server/src/comments.ts` | A mention reaches only an actor with a role in the page's collection; the outcome — notified and withheld — is returned to the commenter and recorded on the audit event (R3). |
| `server/src/sources.ts` | A source the asker cannot see answers `not_found`, identically to one that was never registered, on `get`, `update` and `remove` (R4). |
| `server/src/import.ts` | `getRun` answers `not_found` for a run in a collection the asker holds no role in — run ids are caller-supplied and therefore guessable (R4); running an import takes `admin` rather than `edit` (R6). |
| `server/src/store.ts` | `queryAudit` narrows collection-less events to the actor they name plus holders of `admin` on some collection (R5); `createComment` returns the mention outcome (R3). |
| `server/src/api.ts` | A 500 returns a correlation id and logs the detail server-side, leaving `CanonError` messages untouched (R7); the rate-limit table, the per-actor take, and the check-before/charge-on-failure of passport authentication (R8). |
| `server/test/security.test.ts` | Eight more tests, one per behaviour change, each verified red by reverting its fix. |
| `server/test/{agentauth,answers,federation,import}.test.ts` | Four existing tests updated to the new behaviour, each with the reason in a comment. |
| `server/README.md` | The rate-limit variables, and import's trust level corrected to `admin`. |
### Changes made by the authentication work (F10, F11)

| File | Change |
| --- | --- |
| `server/src/auth.ts` | **New.** The people-facing door: the OIDC client (discovery, JWKS by `kid`, code exchange, ID-token validation), server-side sessions behind a signed cookie, CSRF, just-in-time provisioning on the subject, and `visibleActors`. |
| `idp-stub/` | **New.** A standalone OpenID Connect provider with zero runtime dependencies, mirroring `registry-stub`: discovery, JWKS, authorize, token, userinfo, an administrative face, and a set of named quirks so every refusal path can be tested against a provider that really lies. |
| `server/src/api.ts` | The three-door resolution at the top of every request: `/auth/…` handled before the route table, dev-only routes absent when dev auth is off, `X-Actor-Id` refused unless opted into, the CSRF gate on cookie-authenticated writes, and every pairing of two identities refused. `POST /actors` is dev-only; `GET /actors` is narrowed. |
| `server/src/index.ts` | Assembles the door from the environment and announces at start-up which of the three are live — loudly when dev authentication is one of them. |
| `server/public/app.js` | Reads `GET /auth/session` at start-up; a real sign-in button when SSO is configured, the dev picker when dev auth is on, and the CSRF token on every cookie-authenticated write. |
| `server/package.json` | The test suite states `CANON_DEV_AUTH=true`, so it runs the same code path a developer does rather than a special case. |
| `server/test/auth.test.ts` | **New.** 36 tests, run against the real `idp-stub` in-process. |
| `idp-stub/test/idp.test.ts` | **New.** 12 tests over the provider itself. |
| `server/README.md`, `idp-stub/README.md` | The three doors and every new environment variable. |

**Test counts after the authentication work:** `server` 248 (was 212), `idp-stub` 12, `registry-stub` 10, `source-stub` 13, `studio-stub` 8. All pass.

### 6.4 The organisation role, revocation parity, and group mapping (F11 follow-up, R9, R10)

| File | Change |
| --- | --- |
| `server/src/orgrole.ts` | **New.** The org role (`member`/`operator`/`administrator`), its storage, `requireOrgRole`, the bootstrap rules, and the separation of hand-granted from group-granted collection access with the effective role derived from both. One `_SCHEMA` const: four tables and the backfill that makes every existing membership row a hand grant. |
| `server/src/groupmap.ts` | **New.** The group claim, the rule syntax, validation against the record at configuration time, and the applier that rewrites a person's group grants wholesale on every confirmation. |
| `server/src/db.ts` | One `db.exec(ORG_SCHEMA)` line. |
| `server/src/store.ts` | `setMember`/`removeMember` write hand grants and recompute the effective role (and `removeMember` reports what a group still holds); `createCollection`'s own admin row is a hand grant; `queryAudit`'s collection-less rule asks the org role; `orgRoleOf`, `isOperator`, `setOrgRole`, `listOrgRoles`, `explainAccess`, `bootstrapAdministrator`. |
| `server/src/auth.ts` | R9's `confirm`/`confirmNow` (window, single-flight, the three failure modes), the sealed refresh token, `OidcClient.refresh`, nonce-optional validation, `settleAccess` (bootstrap + mapping, at sign-in and at every confirmation), the operator surfaces `GET /auth/mapping`, `GET /auth/org-roles`, `PUT /auth/org-roles/:actorId`, `GET /auth/access/:actorId`, `DELETE /auth/sessions/:actorId`, and `visibleActors` asking the org role. |
| `server/src/api.ts` | `identify` is awaited: a session past its window is confirmed before the request is served. |
| `server/src/notify.ts`, `server/src/sources.ts`, `server/src/freshness.ts` | The three remaining "admin on some collection" stand-ins replaced with `requireOrgRole(…, 'operator', …)`. |
| `server/src/index.ts` | The confirmation window and the group mapping announced at start-up, beside the agent guarantee — loudly when a group grants `administrator`. |
| `server/scripts/seed-demo.ts` | The demo record names its administrator instead of inferring one. |
| `idp-stub/` | Groups on a user (issued under a configurable claim name, absent when empty), the refresh grant with rotation, `disabled`, and the `no_refresh_token` quirk. |
| `server/test/orgrole.test.ts`, `server/test/sessionconfirm.test.ts`, `server/test/groupmap.test.ts`, `server/test/authrig.ts` | **New.** 43 tests over the org role and its five stand-ins, R9's confirmation, and R10's mapping, run against the real `idp-stub` in-process. |
| `idp-stub/test/idp.test.ts` | Five more: the group claim, the refresh grant, rotation, a disabled person, and a provider that issues no refresh token. |
| `server/test/{agentauth,answers,federation,freshness,knowledge,proposals,queries,security,smtp,auth,seed-demo}.test.ts`, `studio-stub/test/studio.test.ts` | Updated to the new behaviour: where a test relied on "admin on some collection" meaning operator, it now says which role the actor holds, with the reason in a comment. |
| `server/README.md`, `idp-stub/README.md` | The org role, the people-facing revocation guarantee beside the agent one, group mapping, and every new environment variable. |

**Test counts after this work:** `server` 357 (was 314), `idp-stub` 17 (was 12), `registry-stub` 10, `source-stub` 13, `studio-stub` 8. All pass.
