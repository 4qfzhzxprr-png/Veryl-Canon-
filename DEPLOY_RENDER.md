# Veryl Canon on Render — `canon.veryl.ai`

The click-path for [`render.yaml`](render.yaml), the DNS record, and what has
to be true before this URL is worth giving to anybody.

[OPERATIONS.md](OPERATIONS.md) remains the operations reference — install,
back up, restore, upgrade, rotate, and the first-hour checklist. This file is
only the Render-shaped wrapper around it. [CONFIGURATION.md](CONFIGURATION.md)
is the reference of record for every environment variable named below.

---

## 1 · Why Render and not a serverless platform

Canon is one process and one file. The whole record — every page, every
version, and the append-only audit log — is a single SQLite database, and
SQLite in WAL mode takes many readers and **one writer**.

That rules out any platform whose model is "N stateless instances, ephemeral
disk." It is not a matter of effort: two instances against one file is a
corrupted record, and the audit log is the one artefact Canon cannot rebuild.
[POSTGRES-ASSESSMENT.md](POSTGRES-ASSESSMENT.md) prices the port that would
change this at 8–13 engineer-weeks and is explicit that it is a porting
project, not a driver swap — and even finished, it would not make Canon
stateless.

Render fits because a service with a disk attached is **pinned to one
instance**. The constraint the platform imposes is the constraint Canon
needs.

The visible cost: deploys are a brief interruption rather than zero-downtime.
The old instance gets SIGTERM, `src/shutdown.ts` drains in-flight requests and
closes the database so SQLite checkpoints its WAL, and the new one starts.
`CANON_SHUTDOWN_TIMEOUT_MS` is set to 20s in the blueprint, under Render's 30s
SIGTERM→SIGKILL delay, so that drain finishes rather than being killed halfway.

---

## 2 · Deploy

1. **Render Dashboard → New → Blueprint**, point it at this repository, pick
   the branch. Render reads `render.yaml` and proposes one web service plus
   one disk.
2. Fill in the values marked `sync: false` — Render prompts for each. None of
   them has a safe default, which is why none of them has one:

   | Variable | What it is |
   | --- | --- |
   | `CANON_OIDC_ISSUER` | Your OpenID Connect provider. Discovery is read from `<issuer>/.well-known/openid-configuration` and must name the same issuer back. |
   | `CANON_OIDC_CLIENT_ID` | The client Canon is registered as there. |
   | `CANON_OIDC_CLIENT_SECRET` | Secret. Authenticates the token call. |
   | `CANON_BOOTSTRAP_ADMIN_SUBJECT` | The first administrator, named by their `sub` claim (or `issuer#sub`). |
   | `CANON_REGISTRY_API_KEY` | Bearer token Canon presents to the Registry's verification face. |

3. **Register the redirect URI at your provider**, verbatim:
   `https://canon.veryl.ai/auth/callback`. Canon derives it from
   `CANON_BASE_URL`; a provider that has not been told it will refuse the
   exchange.
4. Apply. First boot creates the schema on the empty disk.
5. **DNS.** Render shows the target hostname for `canon.veryl.ai` once the
   service exists. Add it at your registrar:

   ```
   canon.veryl.ai.   CNAME   <service>.onrender.com.
   ```

   Render issues and renews the certificate once the record resolves. This is
   an explicit record, so it wins over any `*.veryl.ai` wildcard pointed at
   Studio — the three services can share the apex without colliding.

---

## 3 · Two things that will bite

**`CANON_DEV_AUTH` must stay unset.** It makes Canon believe an `X-Actor-Id`
header without verifying anything: whoever can open the URL is whoever they
say they are. It is not in `render.yaml` and must not be added. SECURITY.md §5,
assumption 1 calls it the one thing a deployment must get right. Canon refuses
to start if it is set alongside SSO, and binds loopback-only when it is the
only door — so the failure mode on Render is a service that never passes its
health check, not a Canon anybody can enter. Leave it alone and that guard
never has to fire.

**Never point this at the stubs.** `registry-stub` certifies any agent from an
unauthenticated administrative face; `idp-stub` issues a valid token for
anybody and can be asked to lie on purpose. They exist for the demo stack in
`docker-compose.yml` and for the test suite.

Their old home was the **last** stage of the Dockerfile, and Render's blueprint
has no field for a build target — so a blueprint deploy would have built and
shipped `stubs` to a public URL. The stages are now ordered so `canon` is last
and a target-less build produces the deployable image. The Dockerfile header
says so; read it before reordering anything there.

---

## 4 · Before this URL is worth giving to anybody

A green service is not a finished deployment. In order:

- **Nobody can sign in until SSO is configured.** With `CANON_OIDC_ISSUER`
  unset Canon starts, serves, and has no door for people. That is the honest
  state rather than a broken one, but it is not a state to hand out.
- **Set up backups before there is anything to lose.** The audit log has no
  second copy. `npm run backup` uses SQLite's `VACUUM INTO`, which asks the
  database for a consistent single file rather than copying bytes out from
  under a live writer — OPERATIONS.md, "Back up", and "Never copy the file"
  for why the obvious alternative is wrong. Hourly is entirely reasonable.
  **A Render disk is not a backup**: it survives deploys and restarts, not a
  bad migration, a mistaken delete, or the account.
- **Turn on disk encryption at rest.** Canon cannot encrypt its own database —
  `node:sqlite` has no encryption hook — so this is the platform's job.
  OPERATIONS.md, "Encrypt the record at rest", covers what that does and does
  not buy, including the backup copy people forget.
- **Anchor the audit chain head** (OPERATIONS.md, "Anchor the chain head"), or
  the tamper-evidence is only as good as the database it lives in.
- Work the **first-hour checklist** in OPERATIONS.md. It is written for exactly
  this moment.

---

## 5 · Where the other two live

| Product | Repo | URL | Platform |
| --- | --- | --- | --- |
| **Agent Registry** | `agent-studio` | `registry.veryl.ai` | Render (its own blueprint) |
| **Canon** | this repo | `canon.veryl.ai` | Render (this blueprint) |
| **Studio** | `Veryl-Studio` | `studio.veryl.ai` | Vercel |

Names are per `agent-studio/docs/SUITE-INTEGRATION.md` §2. Studio's *internal*
services are also called "registry" and "canon" — they are different products
from these two and do not get these hostnames. That document calls the name
collision the single most dangerous fact in the integration; it is worth one
sentence of care every time these URLs are written down.
