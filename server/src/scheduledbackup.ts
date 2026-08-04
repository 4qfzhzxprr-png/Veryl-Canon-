import type { DatabaseSync } from 'node:sqlite';
import { scheduledBackup, type ScheduledBackupResult } from './backup.js';
import type { Logger } from './log.js';

// The scheduled backup: the in-process counterpart to `npm run backup`.
//
// The backup MACHINERY (backup.ts) was already excellent — a WAL-safe
// `VACUUM INTO`, verified end to end before it is called a backup, pruned only
// after it verifies. What was missing, and what the production-readiness review
// named, was that nothing MADE it run: durability depended entirely on an
// operator wiring cron, and a backup procedure nobody has scheduled is a
// belief. This turns it on with two settings, on the same timer pattern as the
// freshness sweep, the record watch and the head anchor (index.ts).
//
// TWO THINGS THIS IS NOT, said here so no sentence elsewhere implies them:
//
//   * IT IS NOT AN OFF-BOX COPY. The artefact lands on local disk next to the
//     record. OPERATIONS.md is emphatic that a backup sharing a failure domain
//     with the record is a copy, not a backup — so getting each artefact
//     somewhere the machine's loss cannot reach is still the operator's act,
//     and `--keep`/`CANON_BACKUP_KEEP` prunes only what is here, never what has
//     been shipped away.
//   * IT IS NOT POINT-IN-TIME RECOVERY. Between two snapshots, the transactions
//     committed after the last one and before the crash are gone. The interval
//     is the recovery-point objective, stated out loud: set it to what the
//     partner has agreed to lose.
//
// A failed backup is the alertable event, and it is loud: `scheduled backup
// failed` at error level, with the reason. It never takes the server down —
// a knowledge record must not stop answering because a backup volume filled —
// but it must never pass silently either, because the moment backups start
// failing is the moment the old ones become the only copies there are.

export interface ScheduledBackupOptions {
  db: DatabaseSync;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Where each artefact is written. Required when the timer runs. */
  directory: string | null;
  /** Milliseconds between backups. 0 (or unset) turns the timer off. */
  intervalMs: number;
  /** After a verified backup, keep only the newest `keep` local artefacts. 0 keeps all. */
  keep: number;
}

export interface ScheduledBackupSchedule {
  scheduled: boolean;
  intervalMs: number;
  directory: string | null;
  keep: number;
  /** Why it is not running, when it is not. */
  reason: string | null;
}

export interface ScheduledBackupRun {
  timer: NodeJS.Timeout | null;
  schedule: ScheduledBackupSchedule;
}

/**
 * Take one backup now and log the outcome. Exported so a test can drive a
 * single run without a timer, and so the failure path is exercised directly.
 */
export async function runScheduledBackup(options: ScheduledBackupOptions): Promise<ScheduledBackupResult | null> {
  if (!options.directory) return null;
  try {
    const result = await scheduledBackup(options.db, options.directory, { keep: options.keep });
    options.log.info('scheduled backup', {
      artefact: result.summary.artefact,
      bytes: result.summary.bytes,
      durationMs: result.summary.durationMs,
      auditChain: result.summary.verification.auditChain,
      pruned: result.pruned.length,
    });
    return result;
  } catch (err) {
    // The alertable line. OPERATIONS.md tells the operator to alert on exactly
    // this message, the same way it alerts on the record-cannot-be-read watch.
    options.log.error('scheduled backup failed', {
      directory: options.directory,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * The backup timer: every `intervalMs`, take one verified snapshot into the
 * configured directory and prune. The handle is returned so shutdown can clear
 * it (index.ts).
 *
 * Unlike the head anchor, the FIRST backup is not taken at start-up: a snapshot
 * the instant the file opens duplicates the artefact the operator's first-hour
 * checklist already takes by hand, and taking it before the port binds would
 * hold the event loop on a `VACUUM INTO` while nothing is yet being served for
 * no gain. So the first scheduled artefact lands one interval in.
 *
 * A run in progress when the next tick fires is skipped rather than overlapped:
 * `VACUUM INTO` is synchronous on the record's own connection, so two cannot
 * truly run at once, but a long verify could still straddle a tick, and a
 * second-granularity artefact name would collide.
 */
export function startScheduledBackups(options: ScheduledBackupOptions): ScheduledBackupRun {
  const off = (reason: string): ScheduledBackupRun => ({
    timer: null,
    schedule: { scheduled: false, intervalMs: 0, directory: options.directory, keep: options.keep, reason },
  });
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    return off(
      'CANON_BACKUP_INTERVAL_MS is unset or 0: Canon takes no scheduled backup, and durability depends entirely ' +
        'on an operator-run `npm run backup` shipped off the box (OPERATIONS.md, "Back up").',
    );
  }
  if (!options.directory) {
    // Belt to config.ts's braces: this combination is refused at start-up, but
    // the timer must not silently run to nowhere if it is ever reached.
    return off('CANON_BACKUP_INTERVAL_MS is set but CANON_BACKUP_DIR is not; no destination to write to.');
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      options.log.warn('scheduled backup skipped: the previous one has not finished', {
        directory: options.directory,
      });
      return;
    }
    running = true;
    void runScheduledBackup(options).finally(() => {
      running = false;
    });
  }, options.intervalMs);
  timer.unref(); // never hold the process open on the timer alone
  return {
    timer,
    schedule: {
      scheduled: true,
      intervalMs: options.intervalMs,
      directory: options.directory,
      keep: options.keep,
      reason: null,
    },
  };
}

/** The backup schedule from the environment, as index.ts assembles it. */
export function scheduledBackupOptionsFromEnv(
  db: DatabaseSync,
  log: ScheduledBackupOptions['log'],
  env: NodeJS.ProcessEnv = process.env,
): ScheduledBackupOptions {
  const rawInterval = Number(env.CANON_BACKUP_INTERVAL_MS ?? '');
  const rawKeep = Number(env.CANON_BACKUP_KEEP ?? '');
  const directory = env.CANON_BACKUP_DIR?.trim() || null;
  return {
    db,
    log,
    directory,
    intervalMs: Number.isFinite(rawInterval) && env.CANON_BACKUP_INTERVAL_MS ? rawInterval : 0,
    keep: Number.isFinite(rawKeep) && rawKeep >= 0 ? Math.floor(rawKeep) : 0,
  };
}
