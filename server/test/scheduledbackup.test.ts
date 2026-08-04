import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import { backupArtefactName, pruneArtefacts, scheduledBackup } from '../src/backup.js';
import {
  runScheduledBackup,
  scheduledBackupOptionsFromEnv,
  startScheduledBackups,
} from '../src/scheduledbackup.js';

// The backup machinery was already verified end to end (backup.test.ts). What
// the production-readiness review found missing was that nothing MADE it run.
// These cover the scheduling layer: a verified artefact lands, retention keeps
// the newest N, the whole thing is off by default, and a failure is loud but
// never fatal.

const silent = { info() {}, warn() {}, error() {} };

function collector() {
  const lines: { level: string; msg: string; meta: any }[] = [];
  return {
    log: {
      info: (msg: string, meta?: any) => lines.push({ level: 'info', msg, meta }),
      warn: (msg: string, meta?: any) => lines.push({ level: 'warn', msg, meta }),
      error: (msg: string, meta?: any) => lines.push({ level: 'error', msg, meta }),
    },
    lines,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'canon-backup-'));
}

test('backupArtefactName is a sortable, second-granular canon-*.db name', () => {
  // Colons are stripped (a filename can't carry them) and the sub-second tail
  // dropped; the date keeps its hyphens, exactly as the CLI names artefacts.
  const name = backupArtefactName(new Date('2026-08-04T09:07:30.512Z'));
  assert.equal(name, 'canon-2026-08-04T090730Z.db');
  assert.match(name, /^canon-.*\.db$/);
});

test('scheduledBackup writes a verified artefact and returns its summary', async () => {
  const db = openDb(':memory:');
  new CanonStore(db); // schema + a real record to snapshot
  const dir = tmp();
  const { summary, pruned } = await scheduledBackup(db, dir, { now: new Date('2026-08-04T00:00:00Z') });
  assert.ok(existsSync(summary.artefact), summary.artefact);
  assert.equal(summary.verification.ok, true);
  assert.deepEqual(pruned, []);
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.db')).length, 1);
});

test('pruneArtefacts keeps the newest N and never touches a smaller set', async () => {
  const dir = tmp();
  const db = openDb(':memory:');
  new CanonStore(db);
  // Three artefacts at distinct timestamps.
  for (const t of ['2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z']) {
    await scheduledBackup(db, dir, { now: new Date(t) });
  }
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.db')).length, 3);
  const removed = pruneArtefacts(dir, 2);
  // One removed, two kept — which one goes is decided by mtime (write order),
  // so the count is what this asserts, not the specific survivor.
  assert.equal(removed.length, 1);
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.db')).length, 2);
  // keep >= count is a no-op, and keep 0 keeps everything.
  assert.deepEqual(pruneArtefacts(dir, 5), []);
  assert.deepEqual(pruneArtefacts(dir, 0), []);
});

test('runScheduledBackup logs the outcome and prunes to keep', async () => {
  const db = openDb(':memory:');
  new CanonStore(db);
  const dir = tmp();
  const { log, lines } = collector();
  await runScheduledBackup({ db, log, directory: dir, intervalMs: 1000, keep: 5 });
  const done = lines.find((l) => l.msg === 'scheduled backup');
  assert.ok(done, 'a success line is logged');
  assert.equal(done!.level, 'info');
  assert.ok(String(done!.meta.artefact).endsWith('.db'));
  assert.equal(done!.meta.pruned, 0);
});

test('a failed backup is logged at error and never throws', async () => {
  const db = openDb(':memory:');
  new CanonStore(db);
  const { log, lines } = collector();
  // A "directory" that is really a file makes the artefact's parent un-creatable
  // (mkdir over a file throws), so the backup fails; the run must swallow it
  // into an error log, not reject.
  const dir = tmp();
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const result = await runScheduledBackup({ db, log, directory: blocker, intervalMs: 1000, keep: 0 });
  assert.equal(result, null);
  const failed = lines.find((l) => l.msg === 'scheduled backup failed');
  assert.ok(failed, 'the failure is the alertable line');
  assert.equal(failed!.level, 'error');
});

test('the schedule is off by default and on only with both settings', () => {
  const db = openDb(':memory:');
  new CanonStore(db);
  // Off: no env.
  const off = startScheduledBackups(scheduledBackupOptionsFromEnv(db, silent, {}));
  assert.equal(off.timer, null);
  assert.equal(off.schedule.scheduled, false);
  assert.match(off.schedule.reason ?? '', /unset or 0/);

  // On: both settings present.
  const dir = tmp();
  const on = startScheduledBackups(
    scheduledBackupOptionsFromEnv(db, silent, {
      CANON_BACKUP_INTERVAL_MS: '3600000',
      CANON_BACKUP_DIR: dir,
      CANON_BACKUP_KEEP: '14',
    } as NodeJS.ProcessEnv),
  );
  try {
    assert.ok(on.timer, 'a timer runs');
    assert.equal(on.schedule.scheduled, true);
    assert.equal(on.schedule.intervalMs, 3_600_000);
    assert.equal(on.schedule.keep, 14);
    assert.equal(on.schedule.directory, dir);
  } finally {
    if (on.timer) clearInterval(on.timer);
  }
});

test('a set interval with no directory does not run to nowhere', () => {
  const db = openDb(':memory:');
  new CanonStore(db);
  const run = startScheduledBackups(
    scheduledBackupOptionsFromEnv(db, silent, { CANON_BACKUP_INTERVAL_MS: '3600000' } as NodeJS.ProcessEnv),
  );
  assert.equal(run.timer, null);
  assert.equal(run.schedule.scheduled, false);
});
