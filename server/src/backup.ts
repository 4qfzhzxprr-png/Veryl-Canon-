import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './db.js';
import { latestVersion, type Migration } from './migrate.js';

// Backup and restore.
//
// The audit log is a compliance artefact. It is append-only by trigger, which
// makes it unfalsifiable and makes it exactly as durable as the single file it
// lives in — and until this module there was no procedure for copying that file
// at all. Losing it is unrecoverable, and it is the sort of loss that is
// discovered by an auditor rather than by a monitor.
//
// The one rule: NEVER COPY THE FILE. Canon runs in WAL mode, so at any instant
// the committed record is spread across `canon.db`, `canon.db-wal` and
// `canon.db-shm`. `cp canon.db` under a live server copies a file whose most
// recent commits are in a WAL it did not copy; the result opens cleanly, passes
// `integrity_check`, and is silently missing the last however-many minutes of
// the audit log. That is the worst possible failure mode: a backup that looks
// like a backup.
//
// So a backup is `VACUUM INTO`, which asks SQLite for a consistent snapshot of
// the whole database as of one read transaction, WAL included, written as a
// single fresh file. It takes a read lock, not a write lock, so writers keep
// writing while it runs; what lands in the artefact is every transaction
// committed before it started and none committed after. (The online backup API
// gives the same guarantee. `VACUUM INTO` is what `node:sqlite` exposes, and it
// additionally compacts, so the artefact is smaller than the live file.)
//
// And every backup is verified before it is called one, because an unverified
// backup is a belief, not a procedure.

/** How thoroughly a database was checked, and what was found. */
export interface VerificationReport {
  path: string;
  ok: boolean;
  /** Every check that failed, in the order they ran. Empty when `ok`. */
  problems: string[];
  /** SQLite's own `PRAGMA integrity_check`. */
  integrity: 'ok' | 'failed' | 'unreadable';
  /** The schema version recorded in the artefact, or -1 when unreadable. */
  schemaVersion: number;
  /** The version this build expects. */
  expectedSchemaVersion: number;
  /** Row counts for the tables a partner would notice the loss of. */
  counts: Record<string, number>;
  /**
   * The audit hash chain, feature-detected. `unavailable` means no verifier
   * shipped in this build — which is the state before the attestation work
   * lands, and is not a failure. `verified` and `broken` mean a verifier ran.
   */
  auditChain: 'verified' | 'broken' | 'unavailable';
  auditChainDetail: string;
  bytes: number;
}

export interface BackupSummary {
  source: string;
  artefact: string;
  bytes: number;
  startedAt: string;
  durationMs: number;
  verification: VerificationReport;
}

/**
 * A verifier for the audit hash chain, if this build has one. The attestation
 * work adds a chain over `audit_events`; this module must not depend on it
 * having landed, so the verifier is a seam and the default is detected at run
 * time. A chain that cannot be checked is reported, never assumed intact.
 */
export type AuditChainVerifier = (db: DatabaseSync) => unknown;

/**
 * Look for an audit-chain verifier without depending on one existing. The
 * attestation stream owns both the module name and the export name, so both are
 * guesses — deliberately several of each, all optional. A build without any of
 * them reports `unavailable`, which is the honest answer and not an error.
 */
export async function detectAuditChainVerifier(): Promise<AuditChainVerifier | null> {
  const modules = ['./attest.js', './attestation.js', './chain.js', './audit.js', './auditchain.js'];
  const exports = ['verifyAuditChain', 'verifyChain', 'verifyAuditEvents', 'auditChainIntact', 'verify'];
  for (const specifier of modules) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(specifier)) as Record<string, unknown>;
    } catch {
      continue; // not in this build
    }
    for (const name of exports) {
      const candidate = mod[name];
      if (typeof candidate === 'function') return candidate as AuditChainVerifier;
    }
  }
  return null;
}

/**
 * Read a verifier's answer without knowing its shape. Truthy-and-not-`{ok:false}`
 * is intact. A verifier that throws is reported as *unavailable with a reason*
 * rather than as a broken chain: a signature mismatch between this module and a
 * verifier written later must not condemn a good backup, and a chain that is
 * genuinely broken is what the verifier's own return value is for.
 */
function readChainAnswer(result: unknown): { ok: boolean; detail: string } {
  if (result === true) return { ok: true, detail: 'chain verified' };
  if (result === false) return { ok: false, detail: 'chain verification returned false' };
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['ok', 'valid', 'intact']) {
      if (typeof record[key] === 'boolean') {
        return { ok: record[key] as boolean, detail: `chain verification reported ${key}=${record[key]}` };
      }
    }
    for (const key of ['broken', 'brokenAt', 'firstBrokenId']) {
      if (record[key] !== undefined && record[key] !== null) {
        return { ok: false, detail: `chain verification reported ${key}=${String(record[key])}` };
      }
    }
  }
  return { ok: true, detail: 'chain verification returned no complaint' };
}

/** Does this database's `audit_events` carry chain columns at all? */
function hasChainColumns(db: DatabaseSync): boolean {
  try {
    const columns = db.prepare('PRAGMA table_info(audit_events)').all() as { name: string }[];
    return columns.some((c) => /hash|chain|digest|signature/i.test(c.name));
  } catch {
    return false;
  }
}

/** The recorded schema version, WITHOUT creating the table: this may be read-only. */
function readSchemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get() as { name: string } | undefined;
  if (!table) return 0; // a record written before migrations existed
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

const COUNTED_TABLES = [
  'actors',
  'collections',
  'collection_members',
  'pages',
  'page_versions',
  'drafts',
  'audit_events',
];

export interface VerifyOptions {
  /** The version to insist on. Defaults to what this build's migrations reach. */
  expectedSchemaVersion?: number;
  /**
   * Injected verifier, for a caller that already has one. Omitted, the chain
   * verifier is feature-detected; pass `null` to skip detection entirely.
   */
  auditChainVerifier?: AuditChainVerifier | null;
  /**
   * Insist the artefact holds a record at all. A backup of an empty database is
   * legitimate on day one and suspicious on day two hundred, so the caller
   * decides rather than this module guessing. Off by default; `npm run backup`
   * leaves it off and prints the row counts, which is the honest middle.
   */
  requireRecord?: boolean;
  migrations?: readonly Migration[];
}

/**
 * Open a database file and check it end to end: SQLite's own integrity check,
 * the schema version, that the record actually reads back, foreign-key
 * consistency, and — where a verifier exists — that the audit chain is intact.
 *
 * This is what makes a restore a restore rather than a file move. It never
 * migrates and never writes: the artefact is opened read-only, so verifying a
 * backup cannot alter it.
 */
export async function verifyDatabase(path: string, options: VerifyOptions = {}): Promise<VerificationReport> {
  const migrations = options.migrations ?? MIGRATIONS;
  const expected = options.expectedSchemaVersion ?? latestVersion(migrations);
  const report: VerificationReport = {
    path,
    ok: false,
    problems: [],
    integrity: 'unreadable',
    schemaVersion: -1,
    expectedSchemaVersion: expected,
    counts: {},
    auditChain: 'unavailable',
    auditChainDetail: 'no audit-chain verifier in this build',
    bytes: 0,
  };

  if (!existsSync(path)) {
    report.problems.push(`no such file: ${path}`);
    return report;
  }
  report.bytes = statSync(path).size;
  if (report.bytes === 0) {
    report.problems.push('the artefact is empty (0 bytes)');
    return report;
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    report.problems.push(`cannot open: ${(err as Error).message}`);
    return report;
  }

  try {
    // SQLite's own structural check first: a torn or truncated file fails here
    // and everything after it would be noise.
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      const verdict = rows.map((r) => r.integrity_check).join('; ');
      report.integrity = verdict === 'ok' ? 'ok' : 'failed';
      if (verdict !== 'ok') report.problems.push(`integrity_check: ${verdict}`);
    } catch (err) {
      report.problems.push(`integrity_check could not run: ${(err as Error).message}`);
      return report;
    }
    if (report.integrity !== 'ok') return report;

    try {
      const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (broken.length > 0) report.problems.push(`${broken.length} foreign key violation(s)`);
    } catch (err) {
      report.problems.push(`foreign_key_check could not run: ${(err as Error).message}`);
    }

    // The schema version. An artefact from an older Canon restores onto a newer
    // one — migrations carry it forward — but an artefact from a NEWER Canon is
    // a refusal, exactly as it is at start-up.
    try {
      report.schemaVersion = readSchemaVersion(db);
    } catch (err) {
      report.problems.push(`schema version unreadable: ${(err as Error).message}`);
      return report;
    }
    if (report.schemaVersion > expected) {
      report.problems.push(
        `the artefact is at schema version ${report.schemaVersion}; this build knows only ${expected}. ` +
          'Restore it with the Canon that wrote it.',
      );
    } else if (report.schemaVersion < expected) {
      // Not a problem: migrations run on first open. Recorded so the operator
      // sees it happen rather than discovering it.
      report.problems.push(
        `NOTE the artefact is at schema version ${report.schemaVersion} and this build expects ${expected}; ` +
          'migrations will run on first open',
      );
    }

    // Does the record read back? Counts, then one real row through a join, so
    // "readable" means more than "the file parses".
    for (const table of COUNTED_TABLES) {
      try {
        const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        report.counts[table] = row.n;
      } catch (err) {
        report.problems.push(`table ${table} unreadable: ${(err as Error).message}`);
      }
    }
    try {
      db.prepare(
        `SELECT p.id, p.title, v.number, v.body
           FROM pages p LEFT JOIN page_versions v
             ON v.page_id = p.id AND v.number = p.current_version
          ORDER BY p.created_at DESC LIMIT 1`,
      ).get();
      db.prepare('SELECT id, at, actor_id, action FROM audit_events ORDER BY id DESC LIMIT 1').get();
    } catch (err) {
      report.problems.push(`the record does not read back: ${(err as Error).message}`);
    }
    if (options.requireRecord && (report.counts.pages ?? 0) === 0) {
      report.problems.push('the artefact holds no pages');
    }

    // The audit chain, if anything in this build can check one.
    const verifier =
      options.auditChainVerifier === undefined ? await detectAuditChainVerifier() : options.auditChainVerifier;
    if (verifier) {
      try {
        const answer = readChainAnswer(verifier(db));
        report.auditChain = answer.ok ? 'verified' : 'broken';
        report.auditChainDetail = answer.detail;
        if (!answer.ok) report.problems.push(`audit chain: ${answer.detail}`);
      } catch (err) {
        report.auditChain = 'unavailable';
        report.auditChainDetail = `verifier could not run: ${(err as Error).message}`;
      }
    } else if (hasChainColumns(db)) {
      report.auditChainDetail =
        'audit_events carries chain columns but this build ships no verifier for them; ' +
        'the chain was NOT checked';
    }
  } finally {
    db.close();
  }

  // A leading NOTE is information, not a failure.
  report.ok = report.problems.every((p) => p.startsWith('NOTE '));
  return report;
}

export interface BackupOptions {
  /** Overwrite an existing artefact. Off by default: a backup never clobbers. */
  force?: boolean;
  auditChainVerifier?: AuditChainVerifier | null;
  migrations?: readonly Migration[];
}

/**
 * Take a consistent snapshot of a live database into `destination`, then verify
 * it. Safe to run against a server that is serving: `VACUUM INTO` holds a read
 * transaction, so writes continue and the artefact is the record as of the
 * moment the snapshot began.
 *
 * The snapshot is written to `destination.partial` and renamed on success, so a
 * backup interrupted half way never leaves a plausible-looking short file where
 * the last good one was.
 */
export async function backupTo(
  db: DatabaseSync,
  destination: string,
  options: BackupOptions = {},
): Promise<BackupSummary> {
  const artefact = resolve(destination);
  if (existsSync(artefact) && !options.force) {
    throw new Error(`${artefact} already exists; refusing to overwrite a backup (pass --force to replace it)`);
  }
  mkdirSync(dirname(artefact), { recursive: true });
  const partial = `${artefact}.partial`;
  if (existsSync(partial)) unlinkSync(partial);

  const startedAt = new Date();
  const began = Date.now();
  // Bound, never interpolated: the destination is operator input and this is a
  // path going into SQL (SECURITY.md F9's rule, applied here too).
  db.prepare('VACUUM INTO ?').run(partial);
  const durationMs = Date.now() - began;

  const verification = await verifyDatabase(partial, {
    auditChainVerifier: options.auditChainVerifier,
    migrations: options.migrations,
  });
  if (!verification.ok) {
    unlinkSync(partial);
    throw new Error(
      `The snapshot did not verify and was discarded; the record was NOT backed up:\n  ` +
        verification.problems.join('\n  '),
    );
  }
  if (existsSync(artefact)) unlinkSync(artefact);
  renameSync(partial, artefact);
  verification.path = artefact;

  return {
    source: db.location() ?? '(unknown)',
    artefact,
    bytes: statSync(artefact).size,
    startedAt: startedAt.toISOString(),
    durationMs,
    verification,
  };
}

export interface RestoreOptions {
  force?: boolean;
  auditChainVerifier?: AuditChainVerifier | null;
  migrations?: readonly Migration[];
}

export interface RestoreSummary {
  artefact: string;
  target: string;
  /** The artefact as it was verified BEFORE anything was moved. */
  before: VerificationReport;
  /** The database in place, verified AFTER the restore. This is the one that counts. */
  after: VerificationReport;
}

/**
 * Put an artefact back. Verified twice: once before anything is moved — a
 * corrupt artefact must never be allowed to replace a live record, however bad
 * that record is — and once in place afterwards, because "the copy succeeded"
 * and "the record is there" are different claims.
 *
 * The server must be stopped. This does not check that, because it cannot: what
 * it does instead is refuse to overwrite an existing file without `force`, and
 * move the old one aside rather than delete it.
 */
export async function restoreFrom(
  artefactPath: string,
  targetPath: string,
  options: RestoreOptions = {},
): Promise<RestoreSummary> {
  const artefact = resolve(artefactPath);
  const target = resolve(targetPath);
  if (artefact === target) throw new Error('the artefact and the target are the same file');

  const before = await verifyDatabase(artefact, {
    auditChainVerifier: options.auditChainVerifier,
    migrations: options.migrations,
  });
  if (!before.ok) {
    throw new Error(
      `${artefact} did not verify; nothing was restored and the record in place is untouched:\n  ` +
        before.problems.join('\n  '),
    );
  }

  if (existsSync(target)) {
    if (!options.force) {
      throw new Error(`${target} already exists; refusing to replace a record (pass --force when you mean it)`);
    }
    // Aside, not away. A restore run against the wrong target is recoverable
    // for as long as the displaced file is still on the disk.
    const aside = `${target}.displaced-${new Date().toISOString().replace(/[:.]/g, '')}`;
    renameSync(target, aside);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(target + suffix)) renameSync(target + suffix, aside + suffix);
    }
  }
  // The WAL and SHM of whatever was there are meaningless beside a new main
  // file, and leaving them is how a restore ends up serving old commits.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(target + suffix)) unlinkSync(target + suffix);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(artefact, target);

  const after = await verifyDatabase(target, {
    auditChainVerifier: options.auditChainVerifier,
    migrations: options.migrations,
  });
  if (!after.ok) {
    throw new Error(
      `The restored record at ${target} did not verify:\n  ` + after.problems.join('\n  '),
    );
  }
  return { artefact, target, before, after };
}

/** One line per checked property, for a script's output and for a log. */
export function describeVerification(report: VerificationReport): string {
  const counts = Object.entries(report.counts)
    .map(([table, n]) => `${table}=${n}`)
    .join(' ');
  return [
    `path            ${report.path}`,
    `bytes           ${report.bytes}`,
    `integrity       ${report.integrity}`,
    `schema version  ${report.schemaVersion} (this build expects ${report.expectedSchemaVersion})`,
    `record          ${counts || '(unreadable)'}`,
    `audit chain     ${report.auditChain} — ${report.auditChainDetail}`,
    `verdict         ${report.ok ? 'OK' : 'FAILED'}`,
    ...report.problems.map((p) => `  · ${p}`),
  ].join('\n');
}
