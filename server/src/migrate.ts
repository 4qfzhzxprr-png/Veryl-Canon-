import type { DatabaseSync } from 'node:sqlite';

// Schema migrations, versioned and forward-only.
//
// Until this file, `openDb` execed a pile of `CREATE TABLE IF NOT EXISTS` plus
// one hand-written fixup (`ensurePageFreshnessSchema`). That converges a fresh
// database and an old one for as long as every change is *additive*. It stops
// working the first time a column has to change shape on a database with a
// partner's corpus in it: `CREATE TABLE IF NOT EXISTS` sees a table, does
// nothing, and the record is quietly one version behind the binary reading it.
//
// So: an ordered list of migrations, a `schema_version` record, each migration
// applied exactly once inside a transaction, and a refusal to start against a
// database written by a newer build than this one.
//
// Three properties are load-bearing:
//
//   1. FORWARD ONLY. There is no `down`. A migration that has to be undone is
//      undone by restoring the backup taken before the upgrade (OPERATIONS.md
//      "Upgrade"), because a down-migration that drops a column is a data-loss
//      path that exists only to be run in a hurry at the worst moment.
//
//   2. ONE TRANSACTION PER MIGRATION, and the version row is written inside it.
//      SQLite's DDL is transactional, so a migration that throws half way
//      leaves the database exactly as it was — including the version, so the
//      next start-up retries it rather than skipping it.
//
//   3. A DATABASE FROM THE FUTURE IS A REFUSAL, not a downgrade. An older
//      binary pointed at a newer record cannot know what the newer columns
//      mean; the honest failure is to stop with the two numbers in the message.
//
// See `MIGRATIONS` in db.ts for the list itself, and OPERATIONS.md
// "Adding a table" for how a new one is added.

/** One forward step. `up` may throw; the runner rolls the step back. */
export interface Migration {
  /** Strictly ascending from 1, never reused, never reordered once released. */
  version: number;
  /** Short slug for the log and the `schema_version` row. */
  name: string;
  up(db: DatabaseSync): void;
  /**
   * The runner normally opens a transaction around `up`. Set this when the
   * migration manages its own — which today is only the baseline, because it
   * folds in `ensurePageFreshnessSchema`'s twelve-step table rebuild, and that
   * turns foreign keys off and back on around a `BEGIN` of its own.
   */
  ownTransaction?: boolean;
  /**
   * Re-applied on every open rather than once. Only the baseline carries this,
   * and only because every statement in it is `CREATE … IF NOT EXISTS`: it is a
   * no-op on a database that already has the tables. It is what lets a module
   * keep declaring its DDL in a `_SCHEMA` constant beside its logic and have
   * that constant take effect on an existing database without its author
   * having to write a migration for a purely additive table. Anything that is
   * NOT idempotent — a column change, a backfill, a rebuild — must be a
   * numbered migration instead, and must not set this.
   */
  always?: boolean;
}

/** A database written by a newer build than this one. Refuse, do not guess. */
export class SchemaAheadError extends Error {
  constructor(
    readonly found: number,
    readonly known: number,
  ) {
    super(
      `The record is at schema version ${found}, but this build of Canon knows only ${known}. ` +
        'A newer Canon wrote this database; running an older binary against it would misread ' +
        'columns it does not know about. Upgrade Canon, or restore the backup taken before ' +
        'the upgrade (see OPERATIONS.md).',
    );
    this.name = 'SchemaAheadError';
  }
}

/** A migration list that could not be trusted to run in a defined order. */
export class MigrationOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationOrderError';
  }
}

/** A migration that threw. The cause carries the original failure. */
export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown,
  ) {
    super(
      `Migration ${version} (${migrationName}) failed and was rolled back: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'MigrationFailedError';
  }
}

export const SCHEMA_VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** What one migration run did. Returned so start-up can log it honestly. */
export interface MigrationResult {
  from: number;
  to: number;
  /** `"3 audit_chain"`, in the order applied. Empty when nothing was pending. */
  applied: string[];
}

/**
 * The highest version this database has recorded, or 0 for a database that has
 * never been migrated — which is both a brand new file and one written by the
 * build before this file existed. Those two converge on migration 1, which is
 * exactly the bootstrap that build ran.
 */
export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(SCHEMA_VERSION_SCHEMA);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** The newest version a list of migrations can reach. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new MigrationOrderError(`Migration "${migration.name}" has version ${migration.version}; versions start at 1`);
    }
    if (migration.version <= previous) {
      throw new MigrationOrderError(
        `Migrations are out of order: ${migration.version} (${migration.name}) follows ${previous}. ` +
          'The list is the order of application; it is never sorted at run time and never reordered after release.',
      );
    }
    previous = migration.version;
  }
}

function apply(db: DatabaseSync, migration: Migration, at: string): void {
  const record = (): void => {
    db.prepare('INSERT OR REPLACE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      at,
    );
  };
  if (migration.ownTransaction) {
    // The migration owns its atomicity. Only the baseline takes this, and only
    // because the freshness rebuild it folds in needs foreign keys off around
    // its own BEGIN — which is illegal inside a transaction we opened.
    migration.up(db);
    record();
    return;
  }
  db.exec('BEGIN');
  try {
    migration.up(db);
    record();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A migration that closed the transaction itself leaves nothing to roll
      // back; the original failure is the one worth reporting.
    }
    throw new MigrationFailedError(migration.version, migration.name, err);
  }
}

/**
 * Bring `db` up to the newest version in `migrations`. Idempotent: a database
 * already at the newest version is untouched and the result names nothing.
 *
 * Throws `SchemaAheadError` when the database is newer than this build,
 * `MigrationOrderError` when the list itself is unusable, and
 * `MigrationFailedError` — after rolling the failed step back — when one throws.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  now: () => Date = () => new Date(),
): MigrationResult {
  assertOrdered(migrations);
  const known = latestVersion(migrations);
  const from = currentSchemaVersion(db);
  if (from > known) throw new SchemaAheadError(from, known);

  const at = now().toISOString();
  const applied: string[] = [];
  for (const migration of migrations) {
    const pending = migration.version > from;
    if (!pending && !migration.always) continue;
    apply(db, migration, at);
    if (pending) applied.push(`${migration.version} ${migration.name}`);
  }
  return { from, to: Math.max(from, known), applied };
}

/**
 * Is this database at the version this build expects? The readiness probe's
 * question (`GET /ready`): a process whose binary is ahead of its record serves
 * wrong answers, and one whose record is ahead of its binary must not serve at
 * all. Never throws — readiness reports, it does not crash the process.
 */
export function schemaStatus(
  db: DatabaseSync,
  migrations: readonly Migration[],
): { current: number; expected: number; ok: boolean; detail: string } {
  const expected = latestVersion(migrations);
  let current: number;
  try {
    current = currentSchemaVersion(db);
  } catch (err) {
    return { current: -1, expected, ok: false, detail: `schema version unreadable: ${(err as Error).message}` };
  }
  if (current === expected) return { current, expected, ok: true, detail: 'current' };
  if (current > expected) return { current, expected, ok: false, detail: 'record is newer than this build' };
  return { current, expected, ok: false, detail: 'migrations are pending' };
}
