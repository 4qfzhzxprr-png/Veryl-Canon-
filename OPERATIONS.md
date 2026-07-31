# Veryl Canon — operations

How to install Canon, upgrade it, back it up, restore it, rotate its secrets,
read its logs, and know whether it is working. Written for the
**Administrator** role in [CORE-PLAN.md](CORE-PLAN.md) §2 — the person who sets
up collections and permissions, connects Canon to the Registry, and *answers to
auditors*. That last clause is why the backup section comes before the fun ones.

Companion documents: [CONFIGURATION.md](CONFIGURATION.md) is every environment
variable in one table; [SECURITY.md](SECURITY.md) §5 is the list of assumptions
a deployment must keep true; [server/README.md](server/README.md) is what the
product does.

---

## The shape of the thing

Canon is **one process and one file**.

- The process is Node 22+ with **zero runtime dependencies** — no framework, no
  driver, no ORM, no queue. `node:sqlite`, `node:http`, `node:crypto`.
- The file is a SQLite database holding the record, the version history, the
  derived indexes and **the audit log**. History is append-only, enforced by
  database triggers rather than by application code.

Everything else is somebody else's process: an identity provider, the Veryl
Agent Registry, an SMTP relay, the record systems federation reads from. Canon
fails closed against each of them and says which are configured at start-up.

What follows from that: there is no cluster to stand up, no migration service,
no cache to warm — and there is exactly one thing whose loss is unrecoverable.

---

## Install

### With Docker (the supported path)

```sh
docker build -t veryl-canon:local --target canon .
docker volume create canon-data

docker run -d --name canon -p 3000:3000 \
  -v canon-data:/data \
  -e CANON_DB=/data/canon.db \
  -e CANON_BASE_URL=https://canon.example.com \
  -e CANON_OIDC_ISSUER=https://idp.example.com \
  -e CANON_OIDC_CLIENT_ID=veryl-canon \
  -e CANON_OIDC_CLIENT_SECRET="$(cat /run/secrets/oidc)" \
  -e CANON_SESSION_SECRET="$(cat /run/secrets/session)" \
  -e CANON_REGISTRY_URL=https://registry.veryl.example \
  veryl-canon:local
```

The image runs as the non-root `node` user, contains no build toolchain and no
`node_modules` (there is nothing to install), declares `/data` as a volume, and
has a `HEALTHCHECK` that probes **readiness**. `docker stop` is graceful:
node is PID 1, receives SIGTERM directly, and drains.

Put a TLS-terminating reverse proxy in front of it. Canon speaks plain HTTP and
sets `Secure` on its session cookie based on `CANON_BASE_URL`.

### Without Docker

```sh
cd server
npm install          # dev dependencies only (TypeScript); nothing ships at runtime
npm test             # build + the invariant suite
npm start            # serves on :3000, record at ./canon.db
```

Run it under a supervisor that sends SIGTERM to stop (systemd's default) so the
graceful path is used. `Restart=on-failure` is right; `Restart=always` will
paper over the configuration refusals below, which is the opposite of useful.

### The demo stack

`docker compose up --build` brings up Canon plus the four stubs.
**Read the banner at the top of `docker-compose.yml` first.** The stubs
authenticate nobody, by design; the identity provider stub will issue a valid
token for anyone it is asked about. It is a demonstration environment and
nothing else.

---

## First hour of a new deployment

Work down this list. Each line is checkable, and each has a way of being wrong
that is invisible later.

1. **Start it, and read the start-up log.** Canon says out loud which doors are
   open. Confirm: single sign-on live against *your* provider, dev
   authentication **off**, the Registry reachable. If Canon refused to start,
   the message names the variable — see CONFIGURATION.md, "Start-up validation".
2. **`GET /health` → 200 and `GET /ready` → 200.** Readiness proves the record
   is reachable, the schema matches the binary, and every configured door
   answers. Point your load balancer at `/ready`, not `/health`.
3. **Sign in as yourself through the real provider.** Then check `GET
   /auth/session` shows the actor Canon provisioned from your claims.
4. **Confirm `CANON_DEV_AUTH` is unset**, from outside: `curl -H 'x-actor-id:
   anyone' <base>/collections` must answer `401 dev_auth_disabled`. This is
   SECURITY.md §5, assumption 1, and it is the single most consequential setting
   in the product.
5. **Create the maintenance actor**, grant it `admin` on a collection, and set
   `CANON_MAINTENANCE_ACTOR_ID` to its id. Until you do, review dates do
   nothing on a timer.
6. **Take a backup, and restore it somewhere else.** Not later — now, while the
   record is empty and a mistake costs nothing. A backup procedure nobody has
   run is a belief. See below.
7. **Put the backup on a schedule, off this machine.** See "Retention".
8. **Set `CANON_IMPORT_ROOTS`** before anybody runs an import, unless collection
   admin and shell access are the same trust level in your organization
   (SECURITY.md §5, assumption 3).
9. **Set `CANON_SOURCE_ALLOWED_HOSTS`** to exactly the record systems you mean
   to federate with, and leave `CANON_SOURCE_ALLOW_PRIVATE` unset. Unset means
   Canon reaches nothing, which is the right default and a surprise the first
   time a source will not resolve.
10. **Ship the logs somewhere.** They are JSON on stdout. Nothing in them is a
    secret; see "Read the logs".

---

## Back up

**This is the section that matters.** The audit log is a compliance artefact.
It is append-only, it has no second copy anywhere, and losing it is discovered
by an auditor rather than by a monitor.

### Take one

```sh
# on the host
cd server && npm run backup -- --db /var/lib/canon/canon.db --out /var/backups/canon --keep 30

# in the container
docker compose exec canon node dist/server/scripts/backup.js --out /data/backups --keep 30
```

Safe to run against a server that is serving. Writers keep writing; the artefact
holds every transaction committed before the snapshot began and none committed
after.

### Never copy the file

Canon runs in **WAL mode**. At any instant the committed record is spread across
`canon.db`, `canon.db-wal` and `canon.db-shm`. `cp canon.db` under a live server
copies a file whose most recent commits are in a WAL it did not copy. The result
opens cleanly, passes an integrity check, and is silently missing the end of the
audit log. That is the worst failure a backup can have: one that looks like a
backup. The same applies to a filesystem snapshot that is not atomic across all
three files, and to `rsync`.

`npm run backup` uses SQLite's `VACUUM INTO`, which asks the database for a
consistent snapshot of everything as of one read transaction — WAL included —
written as a single compacted file. (SQLite's online backup API gives the same
guarantee; `VACUUM INTO` is what `node:sqlite` exposes.)

### Every backup is verified before it is called one

The script checks, and refuses to keep an artefact that fails:

- `PRAGMA integrity_check` — the file is structurally whole;
- `PRAGMA foreign_key_check` — the record refers only to things that are there;
- the **schema version** against the version this build expects;
- every core table reads back, with its row count printed — `actors`,
  `collections`, `collection_members`, `pages`, `page_versions`, `drafts`,
  `audit_events`;
- one real page read through its current version, and the newest audit event;
- **the audit hash chain**, when this build ships a verifier for it. This is
  feature-detected: a build without one reports `audit chain unavailable`
  rather than claiming the chain is intact. Do not read `unavailable` as `ok`.

A snapshot that fails verification is deleted rather than left on disk looking
like a backup, and the run exits non-zero. **Alert on that exit code.**

### Retention

What a partner is expected to do with the artefact:

| | |
| --- | --- |
| **How often** | Nightly at minimum. Canon's write volume is small; the cost of an extra backup is a few hundred kilobytes and a second of read lock. Hourly is entirely reasonable and is what we would run. |
| **Where** | **Not on the same disk, and not only on the same machine.** A backup that shares a failure domain with the record is a copy, not a backup. Copy the artefact to object storage or a separate host as soon as it verifies. |
| **How long** | Keep daily artefacts for at least as long as your audit-log retention obligation, which in a regulated partner is usually seven years for the audit log specifically. `--keep n` prunes locally; it does not manage your remote copies, and it never prunes on a failed run — the moment backups start failing is the moment the old ones become the only copies there are. |
| **Encryption** | The artefact contains the entire record: policies, drafts, comments, and every actor's name and email address. Encrypt it at rest wherever it lands. Canon does not encrypt it for you. |
| **Proof** | Restore one, on a schedule, into a scratch instance and read a page from it. `npm run restore -- --verify <artefact>` checks an artefact without restoring anything, and is cheap enough to run against every artefact you keep. |

---

## Restore

**Stop the server first.** The script cannot tell whether one is running; what
it does instead is refuse to overwrite an existing record without `--force`, and
move the displaced record aside rather than deleting it.

```sh
docker compose stop canon

# verify before you commit to it
docker compose run --rm --entrypoint node canon \
  dist/server/scripts/restore.js --verify /data/backups/canon-20260731T0300Z.db

# put it back
docker compose run --rm --entrypoint node canon \
  dist/server/scripts/restore.js \
  --from /data/backups/canon-20260731T0300Z.db --to /data/canon.db --force

docker compose start canon
curl -fsS localhost:3000/ready
```

The restore verifies **twice**: the artefact before anything is moved — a
corrupt backup must never be allowed to replace a live record, however bad that
record is — and the restored file in place afterwards, because "the copy
succeeded" and "the record is there" are different claims. It also removes any
stale `-wal`/`-shm` left beside the target, which is how a restore otherwise
ends up serving the old record's last commits.

An artefact from an **older** Canon restores onto a newer one: migrations run on
first open and carry it forward. An artefact from a **newer** Canon is refused,
by the restore and again at start-up, because an older binary cannot know what
the newer columns mean.

After a restore, tell people what happened. The record has moved backwards in
time; anything published between the snapshot and the incident is gone, and the
audit log — being append-only — has no entry saying so.

---

## Upgrade

```sh
# 1. back up, and check the artefact verified
npm run backup -- --out /var/backups/canon --keep 30

# 2. stop, replace, start
docker compose pull && docker compose up -d canon

# 3. confirm
curl -fsS localhost:3000/ready | jq .
```

Migrations run automatically on first open, in order, each in its own
transaction. The start-up log states the schema version it reached and names
every migration it applied. Readiness fails while the schema is not the one the
binary expects, so a half-upgraded instance takes itself out of the pool rather
than serving.

**Downgrade is a restore, not a migration.** There are no `down` migrations, on
purpose: a down-migration that drops a column is a data-loss path that exists
only to be run in a hurry at the worst possible moment. To go back: stop, restore
the artefact you took in step 1, start the old binary.

### Adding a table (for the people writing Canon, not running it)

The rule from now on:

1. **The DDL still lives beside its logic**, in an exported `_SCHEMA` constant
   in the module that owns the table (`COMMENTS_SCHEMA` in `comments.ts`,
   `SOURCES_SCHEMA` in `sources.ts`, …). That has not changed.
2. **A purely additive table** — `CREATE TABLE IF NOT EXISTS`, and nothing that
   touches an existing table — is added to `applyBaselineSchema()` in
   `server/src/db.ts`, exactly as before. The baseline is migration 1 and it is
   re-applied on every open precisely because it is idempotent, so the new table
   arrives on an existing partner's database without a version bump.
3. **Anything else is a numbered migration**: a column change, a `CHECK`
   constraint change, a table rebuild, a backfill, a new index over existing
   rows, a data fix. Append an entry to `MIGRATIONS` in `server/src/db.ts` with
   the next version number and a short name, and put the work in its `up`. The
   runner wraps it in a transaction and records the version inside that same
   transaction, so a migration that throws leaves the database exactly as it was.
4. **Never renumber, reorder or edit a released migration.** A partner's
   database has already run it, and the version number is the only record that
   it did.
5. **`ownTransaction: true`** only if the migration must manage foreign keys or
   its own `BEGIN` (the twelve-step table rebuild does). Migration 1 is the only
   one that carries it today.

The two properties this buys, and the tests that hold them
(`server/test/migrations.test.ts`): a fresh database and a database written by
any previous build converge on the same version; and a database written by a
*newer* build makes this binary refuse to start rather than misread it.

---

## Rotate secrets

Nothing in Canon stores a credential — not a passport, not a per-asker source
credential, not a source's password (SECURITY.md §5, assumption 7). The secrets
are all in the environment.

| Secret | How | What it costs |
| --- | --- | --- |
| `CANON_SESSION_SECRET` | Change it and restart. | Everyone signed in is signed out and signs in again. Rotate on a schedule and after any suspected exposure. Behind a load balancer, roll all instances together — mid-roll, half the fleet cannot read the other half's cookies. |
| `CANON_OIDC_CLIENT_SECRET` | Add the new secret at the provider first (most support two), then change it here and restart, then retire the old one. | Nothing, if done in that order. Sign-ins fail during the window if done in the other order. |
| `CANON_SMTP_URL` (the relay password in its userinfo) | Change it and restart. | Undelivered notifications stay in the outbox and go out on the next flush; nothing is lost. |
| Agent Passports | Revoked and re-issued **in the Registry**, not here. Canon holds none. | Access is cut within `CANON_REGISTRY_TTL_MS` (≤60s). |
| The record itself | There is no encryption key. The record is protected by the filesystem and by your backups' encryption. | — |

After any rotation: `GET /ready` must be 200, and one real sign-in must work.

---

## Read the logs

One JSON object per line on stdout; errors on stderr. `CANON_LOG_FORMAT=text`
for a terminal, `CANON_LOG_LEVEL` for volume.

```json
{"at":"2026-07-31T09:00:00.000Z","level":"info","msg":"Veryl Canon listening","port":3000,"db":"/data/canon.db","schemaVersion":1,"schemaExpected":1}
```

**No secrets, and not by convention.** `src/log.ts` strips userinfo out of every
URL it prints, redacts `Bearer`/`Basic` tokens and anything spelled like a
secret in a `key=value` pair, and blanks the value of every variable named in
`SECRET_ENV_VARS` by name. There is a test that puts a relay password, an OIDC
client secret and a passport through the logger and asserts none of them comes
out the other side.

Lines worth alerting on:

| Line | What it means |
| --- | --- |
| `*** CANON_DEV_AUTH=true …` | **The door is open and nothing is verified.** Never in a deployment. |
| `configuration` at `warn` | A setting that works and is probably not what was wanted. Read the `detail`. |
| `outbox flush failed` | The relay is refusing or unreachable. Notifications queue and retry; nothing is lost until a message hits five attempts and is marked dead. |
| `freshness sweep failed` | Review dates have stopped being enforced. Check the maintenance actor still holds `admin`. |
| `shutdown: in-flight requests did not finish in time` | A request outlived the drain deadline and was cut. Raise `CANON_SHUTDOWN_TIMEOUT_MS`, or find the slow request. |
| `record closed` | The clean end of a shutdown. Its *absence* after a stop means the WAL was not checkpointed. |
| An `error` with a correlation id | The client got a `500` with that id and nothing else; the detail is here (SECURITY.md R7). |

The audit log is not the application log and is not on stdout: it is in the
record, queryable at `GET /audit` and exportable at `GET /audit.csv`.

---

## The timers, and what breaks if one stops

Canon has exactly two timers. Both do work that is also reachable over HTTP, so
either can be driven by your own scheduler instead — and if you turn one off
without doing that, the feature it serves quietly stops being true.

| Timer | Variable | Default | What it does | What breaks if it stops |
| --- | --- | --- | --- | --- |
| **Outbox flush** | `CANON_FLUSH_INTERVAL_MS` | 60s | Takes a bounded batch of queued notifications and hands them to the relay. Retries with backoff (1, 5, 15, 60 minutes) and marks a message dead after five attempts. | **Nothing is delivered.** Review requests, approvals, send-backs and mentions all sit in the outbox. Nothing is lost — the outbox is the record of what is owed — but every review stalls, silently, because the person who was supposed to act was never told. Equivalent: `POST /notifications/flush` from cron, about once a minute. Only runs at all when `CANON_SMTP_URL` is set. |
| **Freshness sweep** | `CANON_FRESHNESS_INTERVAL_MS` | 1h | Flips Canonical pages past their review date to **Needs Update**, notifies their owners, writes a `page.needs_update` audit event. | **Stale knowledge stops announcing itself.** Pages sail past their review dates still wearing the Canonical mark, and `/ask` keeps citing them as current with no "past review" marker, because the marker comes from the status the sweep sets. Nothing is corrupted and the next run catches everything up: the sweep is idempotent by construction, not by bookkeeping — a page it has flipped is no longer Canonical, so it is not seen twice. Equivalent: `POST /maintenance/freshness`. Only runs when `CANON_MAINTENANCE_ACTOR_ID` names an actor holding `admin`. |

Both are cleared on shutdown before the database closes, so neither can fire
against a closed record.

Neither timer is a queue and neither is durable across a stopped process — they
do not need to be. The outbox is a table, and the sweep re-derives its work from
the record's own state on every run.

---

## Health, readiness, and what to point at what

| Probe | Answers | Use it for |
| --- | --- | --- |
| `GET /health` | 200 whenever the process is up | **Liveness.** A failure means "restart me". It stays 200 while the Registry is down, because restarting Canon does not fix somebody else's outage. |
| `GET /ready` | 200 when this process can serve; 503 with the failing check named | **Readiness.** Load-balancer membership, deployment gates, the container `HEALTHCHECK`. Checks: the record is reachable; the schema is the version this binary expects; every configured door (identity provider discovery, Agent Registry) answers. |

Both are unauthenticated, as a probe must be. Readiness discloses booleans,
schema version numbers, and host names already in your own configuration —
never a record value, and URLs go through the log redactor first.

```sh
$ curl -s localhost:3000/ready | jq .
{
  "ready": true,
  "at": "2026-07-31T09:00:00.000Z",
  "checks": [
    { "name": "database", "ok": true, "detail": "reachable, 5 collection(s)" },
    { "name": "schema", "ok": true, "detail": "version 1, expected 1: current" },
    { "name": "identity_provider", "ok": true, "detail": "https://idp.example.com/… answered 200" }
  ]
}
```

Readiness answers are cached for a few seconds, so a probe every second is not a
request to your identity provider every second.

---

## Shutdown

`docker stop`, systemd, or a plain SIGTERM, in order:

1. stop accepting — new requests get `503 shutting_down` with `Connection: close`;
2. finish what is in flight, up to `CANON_SHUTDOWN_TIMEOUT_MS` (default 10s);
3. clear both timers;
4. close the database, which checkpoints the WAL.

Exit 0 when everything drained, 1 when the deadline was hit. Keep the timeout
below your orchestrator's kill delay, or the orchestrator wins and you get the
ungraceful path anyway.

---

## Scaling, and the honest limits

Say the parts out loud rather than discovering them:

- **One writer.** SQLite in WAL mode takes many readers and one writer. Canon is
  a knowledge record for an organization, not a transaction system; this is the
  right trade for a very long time. It is not a cluster.
- **Two instances of Canon against one file will not work** unless they share a
  filesystem that gives SQLite correct locking, and even then the rate limiter is
  per process and the session store is in the database. Run one instance.
- **The rate limiter is per process** (SECURITY.md R8 says so too).
- **The embedding index and the search index are derived** and rebuildable from
  the record. If either is ever suspect, it can be rebuilt; the record is the
  source of truth and neither index is.
- **The audit log only grows.** It is append-only by trigger, so there is no
  retention control to run against it, by design. Watch the file size; a
  regulated partner should expect to keep all of it anyway.
