# Veryl Canon — the Postgres / GA storage question

Canon runs on one SQLite file through `node:sqlite` (OPERATIONS.md, "The shape
of the thing"). That is the right choice for a pilot: one process, one file, no
cluster, verified backups, and an append-only audit log enforced by the database
itself. It is also a **ceiling**: a single writer, a single node, no
replication, no horizontal scale, and an experimental core module. Before
general availability someone has to decide whether GA needs a networked database
— almost certainly Postgres — and that decision should be made with the cost in
front of it, not discovered late.

This document is that cost, assessed against the code as it stands. It is an
**estimate to inform a decision, not a plan of record and not a commitment.**
The headline: this is a genuine porting project, not a driver swap.

## Bottom line

**Coupling is TIGHT. Roughly 8–13 engineer-weeks** for one strong engineer,
dominated by breadth rather than by any single hard algorithm. There is **no
database abstraction layer today**: a raw `DatabaseSync` handle is created in
`openDb` (`server/src/db.ts`) and threaded into ~30 modules, with **~286
`.prepare(` sites and ~415 `.get()/.all()/.run()` sites across 38 files**, every
one written against SQLite's dialect and its **synchronous** API.

The three things that make it a project and not a translation:

1. **Sync → async is the dominant cost.** `node:sqlite` is synchronous; the
   whole store/service layer assumes it — methods run a query and `return` the
   row with no `await`. The public store API is sync (only `ask`, `listGaps`,
   `liveFields` are async, and those for *network* reasons, not the DB). Every
   Postgres driver is async. Making the DB async forces `async` to propagate
   through ~20 service classes, `store.ts`'s public methods, and every call site
   up to the HTTP layer. Mechanical, but it touches nearly every server file.
2. **FTS5 full-text search has no drop-in Postgres equivalent** (`search.ts`).
   It is a reimplementation on `tsvector`/`tsquery` + GIN, and the ranking change
   (BM25 → `ts_rank_cd`) will move retrieval quality — the eval harness must be
   re-run and weights re-tuned. Treat quality regression as a release gate.
3. **New transaction boundaries become necessary.** Today there is **no
   application-level transaction wrapper**: compound multi-table writes (write a
   version + update the page + reindex + write an audit event) rely on one
   synchronous connection executing in order. Under an async pool, concurrent
   requests interleave across connections and that implicit guarantee is gone.
   This is *new correctness work* the SQLite build never needed, and it is easy
   to under-scope.

Coupling is **not** hidden behind clever tricks in the hot path — most queries
are ordinary SQL, and the code is clean and well-commented, which helps. The
damage is in breadth (raw handle everywhere), the sync contract, and a handful
of deep SQLite-only features below.

## SQLite-specific features that need a Postgres equivalent

| Feature | Where | Postgres approach | Risk |
| --- | --- | --- | --- |
| **FTS5 virtual table**, porter tokenizer, `MATCH`, `bm25()` weights, `snippet()` | `search.ts` (index, query, rank, highlight) | `tsvector`/`tsquery` + GIN, `to_tsvector('english', …)`, `ts_rank_cd`, `ts_headline`. Only 4 weight classes (A–D), so the per-column `0/3/1/3` weights must be remapped. Port `documentFrequency`, `indexedText`, `rebuildIndex`. | **HIGH** — behavioural; re-run `scripts/eval-retrieval.ts` and re-tune. |
| **Audit hash chain via `db.function`** (a JS function on the connection) called from an `AFTER INSERT` trigger | `auditchain.ts` | Postgres has no `db.function`. Either a PL/pgSQL trigger using `pgcrypto` `digest()` (must reproduce `chainHash` byte-for-byte), or move hashing into app code and write the link in the same transaction. | **HIGH** — this is the tamper-evidence guarantee; hash parity is security-critical. |
| **Append-only enforcement triggers** with `RAISE(ABORT, …)` | `db.ts` (`page_versions`, `audit_events`), `auditchain.ts` | `CREATE TRIGGER … BEFORE UPDATE OR DELETE … EXECUTE FUNCTION`, PL/pgSQL body with `RAISE EXCEPTION`. Postgres has no inline trigger bodies — a named function each. | Medium — mechanical but wholesale syntax change. |
| **`VACUUM INTO`** hot consistent snapshot | `backup.ts`, `scheduledbackup.ts` | No equivalent. Redesign backup around `pg_dump`/`pg_basebackup`/filesystem snapshot; replace `integrity_check`/`foreign_key_check` verification. | Medium-High — ops-critical; a real chunk of work. |
| **Table-rebuild migrations** (SQLite can't `ALTER` a CHECK/column) | `system.ts` (actors), `freshness.ts` (pages) | `ALTER TABLE … ADD CONSTRAINT` / `ALTER COLUMN` — Postgres makes these *trivial*, so they get simpler, but must be rewritten. | Low-Medium. |
| **Runtime `PRAGMA table_info` column checks**, `PRAGMA foreign_keys`, `foreign_key_check`, `integrity_check` | `db.ts`, `auth.ts`, `notify.ts`, `freshness.ts`, `backup.ts`, … | `information_schema`/`pg_catalog`; FK + WAL are always-on in Postgres, so most of these delete outright. | Low. |
| **`?` positional placeholders** everywhere, incl. dynamic `IN (?, ?, …)` lists | pervasive (`store.ts`, `search.ts`, …) | `$1,$2,…`; numbered generation for dynamic lists. Best handled once, in the abstraction shim. | Low but pervasive/error-prone. |
| **`INSERT OR IGNORE` / `INSERT OR REPLACE`** | `system.ts`, `orgrole.ts`, `migrate.ts` | `ON CONFLICT DO NOTHING` / `DO UPDATE`. (Existing `ON CONFLICT … excluded.…` sites already port cleanly.) | Low. |
| **`AUTOINCREMENT` / `rowid` ordering** | `db.ts` (`audit_events`); `comments.ts`, `proposals.ts`, `notify.ts` order by `rowid` | `BIGINT GENERATED ALWAYS AS IDENTITY`; add an explicit `seq` column where `rowid` gave insertion order. | Medium — ordering is correctness-sensitive (comments, notifications). |
| **Booleans as INTEGER 0/1**, **JSON as TEXT** with `json_extract` | schema throughout; `search.ts`, `queries.ts` | `boolean` (returns JS true/false — audit truthiness reads) or keep `smallint`; keep JSON as `text` + rewrite the few `json_extract($.x)` as `->>'x'`, or move to `jsonb`. | Low-Medium — audit every such read. |
| **ISO-8601 timestamps as TEXT** | schema throughout | **Portable as-is** — keep `text`, or opt into `timestamptz` later. | Low — the one loosely-coupled area. |

## A phased plan (if the decision is "yes")

**Phase 0 — Build the seam, still on SQLite.** Wrap `DatabaseSync` behind a thin
client interface (`query`/`get`/`all`/`run`/`withTransaction`) with `?`→`$n`
handling, returning promises even while backed by sync SQLite. This lets every
call site flip to `await` against the trusted SQLite backend with green tests —
de-risking the async conversion *separately* from the dialect change. Highest-
leverage item; do it first.

**Phase 1 — Async propagation.** Convert the ~415 call sites and ~20 services +
`store.ts` to async through the shim, still on SQLite. Ship and stabilise.

**Phase 2 — Schema/DDL port.** Types, IDENTITY, `rowid`→`seq`, boolean/JSON
strategy, append-only triggers as PL/pgSQL, simplify the rebuild migrations,
rewrite the runner's PRAGMA bits.

**Phase 3 — Full-text search.** Reimplement `search.ts` on `tsvector`/GIN,
remap weights, port `documentFrequency`, **re-run and re-tune the retrieval
eval** as a release gate.

**Phase 4 — Audit chain.** Port `db.function`+trigger; verify hash parity
against the existing `chainHash`; port `verifyAuditChain`.

**Phase 5 — Backup/ops.** Redesign backup/readiness around `pg_dump`/
`pg_basebackup`; replace the SQLite-only verifiers.

**Phase 6 — Transactions & concurrency.** Add real `withTransaction`
boundaries around compound writes; audit for interleaving now a pool replaces
the single connection. SQLite→Postgres data ETL + dual-run validation.

## Effort & risk

| Phase | Estimate | Risk |
| --- | --- | --- |
| 0 — abstraction + `?`→`$n` shim | 1–1.5 wk | Medium (designed once, used everywhere) |
| 1 — async propagation | 2–3 wk | Medium — mechanical, huge surface, test-coverage dependent |
| 2 — schema/DDL/migrations | 1.5–2 wk | Medium |
| 3 — FTS5 → tsvector + eval re-tune | 1.5–2.5 wk | **HIGH** — quality regression |
| 4 — audit hash chain | 1–1.5 wk | **HIGH** — tamper-evidence correctness |
| 5 — backup/readiness rework | 1–1.5 wk | Medium-High — ops-critical |
| 6 — transactions/concurrency + ETL | 1–1.5 wk | **HIGH** — new correctness surface |

**Total: ~8–13 engineer-weeks**, a multi-month effort with dedicated
retrieval-quality and audit-integrity validation gates. The riskiest three,
called out: (1) FTS quality regression, (2) audit-chain hash parity, (3) the
transaction boundaries a connection pool newly requires.

## What this means for the GA decision

- **The pilot does not need this.** One design-partner box with a documented RPO
  and a drilled restore is well-served by SQLite, and this document is not an
  argument to start the port now.
- **GA probably does.** Multi-tenant, HA, or a load beyond one writer needs a
  networked database, and the honest lead time is months, not a sprint.
- **The single highest-leverage preparation, if GA is likely, is Phase 0** — the
  abstraction seam. It is useful on its own (it makes the code testable against
  a fake, and isolates SQL), it can be done incrementally without a big-bang, and
  it is the thing whose absence makes everything after it expensive. If the team
  wants to *reduce future risk without committing to Postgres*, building that
  seam is where to start.
