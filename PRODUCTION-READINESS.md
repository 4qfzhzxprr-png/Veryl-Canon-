# Veryl Canon — production readiness

Where Canon stands against a **first design-partner deployment in a regulated
field** (CORE-PLAN.md §2), and what remains before it. This is a living
checklist, not a certificate: the two hardest gates — an independent security
review and a run against a real partner — are, by the team's own rule
(CORE-PLAN.md §5, "not a task the team can mark done for itself"), not ours to
tick.

Two bars, kept separate on purpose:

- **Pilot** — one to three design partners, a single writer box, a stated and
  signed-off recovery-point objective. Most of what follows is here or close.
- **GA** — general availability, which CORE-PLAN.md §"where the build stands"
  makes a decision taken *after* the pilot, not a milestone. Several deliberate
  single-node choices become real ceilings here; they are flagged **[GA]**.

Status key: **done** · **partial** · **open** · **[human]** needs a person or a
partner, not code · **[GA]** deferrable past the pilot with eyes open.

---

## 1. The two gates the team named

| Item | Status | Notes |
| --- | --- | --- |
| Independent security review / pentest | **open · [human]** | The internal review is thorough (SECURITY.md, F1–F11 + R1–R11) but the team cannot self-mark it. This is the single largest un-closed item. |
| Validate the stubbed seams against reality | **open · [human]** | M3 was built against a stubbed Registry and stubbed models. Needs: the partner's real corpus (import fidelity is a first-impression risk), the live Registry (grant + revocation-to-lockout under a minute), and the real model in the hot path. |

## 2. Data protection

| Item | Status | Notes |
| --- | --- | --- |
| OIDC refresh tokens sealed at rest | **done** | Already AES-256-GCM under a key derived from `CANON_SESSION_SECRET` (`auth.ts` `sealSecret`/`openSecret`). A production-readiness survey mis-flagged these as plaintext; they are not. |
| Model / embedding egress governance | **done (pilot)** | `restricted` collections are composed locally and never sent to the model unless a deployment with a DPA sets `CANON_GENERATOR_ALLOW_RESTRICTED` (answers.ts; `modelegress.test.ts`); the audit records `restrictedEgressWithheld`. CONFIGURATION.md carries the DPA/BAA note. Embeddings egress remains index-time and all-or-nothing — see §6. |
| Automated, verified, off-box-able backup | **partial** | Canon now takes the same verified `VACUUM INTO` on a timer (`scheduledbackup.ts`; `CANON_BACKUP_INTERVAL_MS`/`_DIR`/`_KEEP`). It lands on **local disk** — the off-box copy is still the operator's act (OPERATIONS.md, "Retention"). Confirm the schedule and drill a restore during onboarding. |
| At-rest encryption of `canon.db` | **open · [human]** | `node:sqlite` has no encryption; this is a volume/disk-layer decision (OPERATIONS.md, "Retention" directs it). The most sensitive credential — the refresh token — is already sealed independently of it. |
| Practised disaster-recovery drill | **open · [human]** | `npm run restore -- --verify` and a real restore into a scratch instance, on a schedule. A backup nobody has restored is a belief. |

## 3. Web / transport hardening

| Item | Status | Notes |
| --- | --- | --- |
| Security headers (CSP, framing, nosniff, HSTS) | **done** | `static.ts` `securityHeaders`; `script-src 'self'`, `frame-ancestors 'none'`, HSTS only on an HTTPS edge; JSON surface is nosniff + no-referrer (`securityheaders.test.ts`). SECURITY.md R11. |
| Request body cap, question-length cap | **done** | 8 MiB body cap (`api.ts`), 4096-char question cap (SECURITY.md F5, F6). |
| TLS termination | **partial · [human]** | Canon speaks plain HTTP by design and sets `Secure` from `CANON_BASE_URL`. The deployment must guarantee a TLS-terminating proxy; the app cannot serve HTTPS itself and does not enforce that a proxy exists. |
| CSRF, rate limiting | **done** | Synchroniser token (SECURITY.md §4); per-route token buckets (R8). Both are per-process — see §6. |

## 4. Auth & identity

| Item | Status | Notes |
| --- | --- | --- |
| SSO/OIDC, server-side sessions, revocation ceiling | **done** | Sessions in the DB (survive restart), ≤60s re-confirmation (SECURITY.md R9). |
| Dev-auth fenced off | **done** | `CANON_DEV_AUTH` refused unless explicitly on; loopback-default bind when it is the only door; config refuses dev-auth on a public bind (`config.ts`). |
| Directory group → role mapping | **done** | `CANON_GROUP_MAP`, applied on every confirmation, hand-grants distinguished from group-grants (SECURITY.md R10). |
| Provisioning a named user before first sign-in | **open · [human]** | Invitations are deliberately absent (OPERATIONS.md, first-hour §11) — a product decision, not a bug, but a partner that needs it needs that decision made. |

## 5. Operability

| Item | Status | Notes |
| --- | --- | --- |
| Health / readiness split, graceful drain | **done** | `/health` vs `/ready`, SIGTERM drain, WAL checkpoint on close (`ready.ts`, `shutdown.ts`). |
| Hash-chained audit log + off-box anchor | **done** | Append-only by trigger; head anchor on a timer; attestation bundles (OPERATIONS.md, "Anchor the chain head"). The anchor's value is entirely in the copy the operator ships off-box. |
| CI pipeline | **done** | `.github/workflows/ci.yml` — build+test for the server and every stub on Node 22.x, plus a runtime `npm audit`. |
| Metrics / tracing | **open** | No `/metrics`, no OpenTelemetry — logs only. Not buyer-facing, but running a compliance system in prod without SRE signals is a real gap. Needs a decision on format (Prometheus?) and what to expose. |

## 6. Scale & correctness — mostly [GA], one correctness hole

| Item | Status | Notes |
| --- | --- | --- |
| `node:sqlite`, single-node, no HA/replication/PITR | **open · [GA]** | Fine for one pilot box with a documented RPO and a drilled restore. A real ceiling before multi-tenant/GA — decide **now** whether GA means Postgres, so it isn't discovered late. `node:sqlite` is also a Stability-1 experimental module. |
| Per-process rate limiter & sessions | **open · [GA]** | A second instance multiplies the effective rate limit and cannot share session/data state; single-writer by design (`config.ts`, `ratelimit.ts`). |
| **Finding 6 — the live federated field through Ask** | **done** | Closed with option (3): a live-values footer Canon composes outside the generator seam from `references.ts`'s already-resolved fields (`liveFieldNotice`, answers.ts; `livefields.test.ts`). The live value now reaches the answer's own prose — stated with source and freshness, stale-marked when stale, never invented — not only the citation metadata a reader who takes the prose never sees. Non-breaking: `AnswerResponse`'s shape is unchanged; only the `answer` string gains the footer, and only when a cited page carries a federated field. |
| Generator quotation lift, established | **open · [human]** | +18.2 points measured on 22 cases at p=0.22 — large, one-directional, not yet significant. Needs a bigger labelled set on the partner's real corpus, with partner "overclaim" labels. |
| Finding 7 (won't count / false silence), pointer quality on unanswerable | **open** | Lower severity; documented known limits (USER-TESTING.md). |
| Embeddings egress per-collection | **open** | `CANON_EMBEDDINGS=http` sends every published page at index time, all-or-nothing. Until a per-collection lever exists, a deployment that cannot send some collections runs `transformers` (on-box) or the default (no call). |

---

## The Finding 6 fix (done — how it was closed)

The live number is data the record holds — `references.ts` guarantees it is
last-known or stale-marked, never invented — but Ask used to surface it only as
**structured citation metadata** (`Citation.fields`), while the answer's quoted
sentence showed whatever figure the prose was written with. A reader who read
the quote read the stale number.

Three options were weighed: (1) UI-only, which leaves the prose showing the
stale figure; (2) a structured echo on `AnswerResponse`, which the prose still
doesn't say; and **(3)** letting Ask *state* the field with attribution.

**Built as (3)**, the way the disagreement/supersession notice is: a
`liveFieldNotice` footer Canon composes **outside the generator seam** from the
citations' already-resolved fields, appended to the answer only when a cited
page carries a federated field. A model writes the prose above; it never writes
or removes this line, so it cannot smooth the live value away any more than it
can smooth a conflict. Nothing here asserts a number of Canon's own — every
value, source and freshness mark is what the record resolved, restated in the
answer's words. Two deliberate no-invention choices: the value is shown **raw**
(the record holds `1500`, not `$1,500` — a currency symbol would be Canon
guessing units it wasn't given), and a value that could not be read is stated as
unavailable, never defaulted to zero.
