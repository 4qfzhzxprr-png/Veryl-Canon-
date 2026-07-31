import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyBaselineSchema, MIGRATIONS, openDb } from '../src/db.js';
import {
  currentSchemaVersion,
  latestVersion,
  MigrationFailedError,
  MigrationOrderError,
  runMigrations,
  schemaStatus,
  SchemaAheadError,
  type Migration,
} from '../src/migrate.js';

// Schema migrations (migrate.ts). The property these tests hold is the one a
// partner's corpus depends on: a database and a binary either agree about the
// shape of the record, or the binary refuses to run. Everything else — order,
// atomicity, idempotence — is in service of that.

function scratch(): { dir: string; path: (name: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'canon-migrate-'));
  return { dir, path: (name: string) => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A small, ordered list that records what ran, so order is observable. */
function stubMigrations(trace: string[]): Migration[] {
  return [
    {
      version: 1,
      name: 'first',
      up(db) {
        trace.push('first');
        db.exec('CREATE TABLE IF NOT EXISTS one (id INTEGER PRIMARY KEY)');
      },
    },
    {
      version: 2,
      name: 'second',
      up(db) {
        trace.push('second');
        db.exec('CREATE TABLE IF NOT EXISTS two (id INTEGER PRIMARY KEY)');
      },
    },
    {
      version: 3,
      name: 'third',
      up(db) {
        trace.push('third');
        db.exec('ALTER TABLE two ADD COLUMN note TEXT');
      },
    },
  ];
}

test('migrations: a fresh database runs every migration, in order, and records each', () => {
  const db = new DatabaseSync(':memory:');
  const trace: string[] = [];
  const result = runMigrations(db, stubMigrations(trace));

  assert.deepEqual(trace, ['first', 'second', 'third']);
  assert.equal(result.from, 0);
  assert.equal(result.to, 3);
  assert.deepEqual(result.applied, ['1 first', '2 second', '3 third']);
  const rows = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all() as {
    version: number;
    name: string;
  }[];
  assert.deepEqual(
    rows.map((r) => `${r.version}:${r.name}`),
    ['1:first', '2:second', '3:third'],
  );
});

test('migrations: a database at an older version runs only what is pending', () => {
  const db = new DatabaseSync(':memory:');
  const first: string[] = [];
  runMigrations(db, stubMigrations(first).slice(0, 1));
  assert.equal(currentSchemaVersion(db), 1);

  const second: string[] = [];
  const result = runMigrations(db, stubMigrations(second));
  assert.deepEqual(second, ['second', 'third'], 'migration 1 must not run twice');
  assert.equal(result.from, 1);
  assert.equal(result.to, 3);
  assert.deepEqual(result.applied, ['2 second', '3 third']);
});

test('migrations: running again applies nothing', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, stubMigrations([]));
  const trace: string[] = [];
  const result = runMigrations(db, stubMigrations(trace));
  assert.deepEqual(trace, []);
  assert.deepEqual(result.applied, []);
});

test('migrations: a database from the future is refused, not downgraded', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, stubMigrations([]));
  // A newer Canon has been here.
  db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
    9,
    'written-by-a-newer-canon',
    new Date().toISOString(),
  );

  const older = stubMigrations([]);
  assert.throws(
    () => runMigrations(db, older),
    (err: unknown) => {
      assert.ok(err instanceof SchemaAheadError);
      assert.equal(err.found, 9);
      assert.equal(err.known, 3);
      assert.match(err.message, /schema version 9/);
      assert.match(err.message, /knows only 3/);
      return true;
    },
  );
});

test('migrations: a migration that throws is rolled back whole, and nothing after it runs', () => {
  const db = new DatabaseSync(':memory:');
  const trace: string[] = [];
  const migrations: Migration[] = [
    ...stubMigrations(trace).slice(0, 1),
    {
      version: 2,
      name: 'half-written',
      up(inner) {
        trace.push('half-written');
        inner.exec('CREATE TABLE partial (id INTEGER PRIMARY KEY)');
        inner.prepare('INSERT INTO partial (id) VALUES (1)').run();
        throw new Error('the backfill could not read a row');
      },
    },
    {
      version: 3,
      name: 'never',
      up() {
        trace.push('never');
      },
    },
  ];

  assert.throws(
    () => runMigrations(db, migrations),
    (err: unknown) => {
      assert.ok(err instanceof MigrationFailedError);
      assert.equal(err.version, 2);
      assert.match(err.message, /rolled back/);
      assert.match(err.message, /the backfill could not read a row/);
      return true;
    },
  );

  assert.deepEqual(trace, ['first', 'half-written'], 'a later migration must not run past a failure');
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'")
    .get() as { name: string } | undefined;
  assert.equal(table, undefined, 'the failed migration’s table survived its own rollback');
  assert.equal(currentSchemaVersion(db), 1, 'the version moved despite the failure');

  // And the retry works, because nothing was half-recorded.
  const retry: string[] = [];
  const fixed: Migration[] = [
    ...stubMigrations(retry).slice(0, 1),
    {
      version: 2,
      name: 'half-written',
      up(inner) {
        retry.push('fixed');
        inner.exec('CREATE TABLE partial (id INTEGER PRIMARY KEY)');
      },
    },
  ];
  runMigrations(db, fixed);
  assert.deepEqual(retry, ['fixed']);
  assert.equal(currentSchemaVersion(db), 2);
});

test('migrations: an out-of-order or renumbered list is refused before anything runs', () => {
  const db = new DatabaseSync(':memory:');
  const trace: string[] = [];
  const jumbled = [stubMigrations(trace)[1]!, stubMigrations(trace)[0]!];
  assert.throws(() => runMigrations(db, jumbled), MigrationOrderError);
  assert.deepEqual(trace, []);
  assert.throws(
    () => runMigrations(db, [{ version: 0, name: 'zero', up: () => {} }]),
    MigrationOrderError,
    'versions start at 1',
  );
});

test('migrations: a record written by the build before migrations existed converges on version 1', () => {
  const scratchDir = scratch();
  try {
    const path = scratchDir.path('legacy.db');
    // Exactly what the previous build did: the bootstrap, and no version record.
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    applyBaselineSchema(legacy);
    legacy
      .prepare('INSERT INTO actors (id, kind, name, email, registry_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('dana', 'person', 'Dana', 'dana@example.com', null, new Date().toISOString());
    assert.equal(
      (legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_version'").get() as unknown) ?? null,
      null,
      'the legacy database should have no version record at all',
    );
    legacy.close();

    // The new build opens it: the baseline is a no-op, the version is recorded,
    // and the record is untouched.
    const db = openDb(path);
    assert.equal(currentSchemaVersion(db), 1);
    const actor = db.prepare('SELECT name FROM actors WHERE id = ?').get('dana') as { name: string };
    assert.equal(actor.name, 'Dana');
    db.close();
  } finally {
    scratchDir.cleanup();
  }
});

test('migrations: openDb reaches the version this build expects, and says so to readiness', () => {
  const db = openDb(':memory:');
  const expected = latestVersion(MIGRATIONS);
  assert.equal(currentSchemaVersion(db), expected);
  const status = schemaStatus(db, MIGRATIONS);
  assert.equal(status.ok, true);
  assert.equal(status.current, expected);
  assert.equal(status.detail, 'current');
});

test('migrations: schemaStatus reports a pending migration rather than throwing', () => {
  const db = openDb(':memory:');
  const ahead: Migration[] = [
    ...MIGRATIONS,
    { version: latestVersion(MIGRATIONS) + 1, name: 'not-yet-run', up: () => {} },
  ];
  const status = schemaStatus(db, ahead);
  assert.equal(status.ok, false);
  assert.equal(status.detail, 'migrations are pending');
  assert.equal(status.expected, latestVersion(MIGRATIONS) + 1);
});

test('migrations: the baseline is idempotent, so a module’s _SCHEMA constant still lands on an old record', () => {
  // The rule this holds: a new table declared as a `_SCHEMA` constant and
  // added to applyBaselineSchema takes effect on a database that has already
  // recorded version 1, because the baseline is re-applied on every open.
  // Anything that is NOT a create-if-not-exists needs its own numbered
  // migration; see OPERATIONS.md, "Adding a table".
  const scratchDir = scratch();
  try {
    const path = scratchDir.path('additive.db');
    const first = openDb(path);
    assert.equal(currentSchemaVersion(first), latestVersion(MIGRATIONS));
    first.close();

    const later = new DatabaseSync(path);
    const trace: string[] = [];
    const withNewTable: Migration[] = MIGRATIONS.map((m) =>
      m.version === 1
        ? {
            ...m,
            up(db) {
              trace.push('baseline');
              m.up(db);
              db.exec('CREATE TABLE IF NOT EXISTS org_roles_example (actor_id TEXT PRIMARY KEY, role TEXT NOT NULL)');
            },
          }
        : m,
    );
    const result = runMigrations(later, withNewTable);
    assert.deepEqual(result.applied, [], 'no version moved: the table arrived additively');
    assert.deepEqual(trace, ['baseline'], 'the baseline re-ran on an already-migrated database');
    const table = later.prepare("SELECT name FROM sqlite_master WHERE name = 'org_roles_example'").get();
    assert.ok(table, 'a new create-if-not-exists table did not reach an existing record');
    later.close();
  } finally {
    scratchDir.cleanup();
  }
});
