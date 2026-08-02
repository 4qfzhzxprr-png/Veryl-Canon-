import { appendFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_CHAIN_ALGORITHM, auditChainHead, readChainMeta } from './auditchain.js';
import type { Logger } from './log.js';

// The head anchor: a periodic, off-box-able record of where the audit chain
// had got to.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVES — WHICH IS NOTHING, UNTIL A COPY LEAVES THIS MACHINE
//
// Read this paragraph before the code, because the code is trivial and the
// claim is the only difficult part of it.
//
// USER-TESTING.md T3.2. An auditor tampered with a Canon record three ways.
// Her naive edit was refused by the append-only triggers, and when she dropped
// the triggers and forced it through, `GET /audit/verify` named the broken
// event exactly. Then she did the competent version: deleted an event,
// reattributed an approval to a different actor, and RECOMPUTED all 1,171
// chain links. `/audit/verify` answered `ok: true, firstBreak: null`, and a
// fresh attestation generated afterwards asserted the forged attribution as
// fact. That is not a bug in the chain — auditchain.ts says so at length — it
// is what a self-contained chain is: internal consistency is exactly what a
// wholesale recomputation restores.
//
// So a chain cannot be rescued from inside the process that writes it, and
// this file does not pretend otherwise:
//
//   AN ANCHOR CANON WRITES, AND CANON COULD REWRITE, PROVES NOTHING. A line in
//   this process's log, or a file on this process's disk, is inside exactly the
//   same trust boundary as the database — an attacker who recomputed the chain
//   can rewrite the log file and the anchor file in the same afternoon. Nothing
//   in this file changes that and no sentence in the documentation may claim it
//   does.
//
//   THE VALUE IS ENTIRELY IN THE COPY THAT LEAVES. Once `(headEventId,
//   headHash, takenAt)` exists somewhere Canon cannot write — a log shipper's
//   store, an email to the compliance owner, an object store with retention
//   locked on, a printed page in a file — a wholesale recomputation stops
//   working. The recomputed chain cannot reproduce a head hash that was
//   published BEFORE the tampering, so every event up to the last retained
//   anchor becomes genuinely immutable rather than merely self-consistent, and
//   the tampering is provable by two hashes that do not match rather than
//   arguable.
//
// What Canon can honestly do, therefore, is exactly this much: produce the
// value, on a schedule, in a shape that is trivial to ship, and say plainly
// that shipping it is the operator's act and not Canon's. OPERATIONS.md
// "Anchor the chain head" is the recipe; this file is the value.
//
// ---------------------------------------------------------------------------
// WHY IT IS NOT AN AUDIT EVENT
//
// The obvious-looking alternative — write the head hash into the audit log —
// is circular and worse than nothing: appending an event changes the head, so
// the record would contain a permanent statement about a state it is no longer
// in, sitting inside the very chain whose recomputation is the threat. An
// anchor has to leave the record to mean anything. This writes to the process
// log and, when asked, to a plain append-only file; neither is the record.
//
// ---------------------------------------------------------------------------
// THE SHAPE
//
// One JSON object per anchor, one line, no nesting: an operator's `cron` line
// appends it to a file and their log shipper carries it away, and a reader
// five years from now needs no tooling to compare two of them by eye. The
// fields are the minimum that make a comparison possible and unambiguous:
// which record (`chainStartedAt`, `chainFormat`), how far (`headEventId`),
// against what (`headHash`), and when (`takenAt`).

/** The serialisation of an anchor record. Bump if the fields change. */
export const HEAD_ANCHOR_FORMAT = 'canon-audit-head-anchor-v1';

export interface HeadAnchorRecord {
  format: typeof HEAD_ANCHOR_FORMAT;
  /** The chain format and algorithm the hash was computed under. */
  chainFormat: string;
  algorithm: string;
  /**
   * When this record's chain was started, which is what distinguishes one
   * Canon's anchors from another's. Two anchors with different values here are
   * about different records and must never be compared.
   */
  chainStartedAt: string | null;
  takenAt: string;
  /** The last chained event, or null on a record with no chained events yet. */
  headEventId: number | null;
  headHash: string | null;
  /** Total events in the log, chained or not — a second, cruder tripwire. */
  events: number;
  chainedFromEventId: number;
}

/**
 * The head, right now, as a record that can be shipped. A read of two indexed
 * rows: cheap enough to take on a timer, cheap enough to take by hand as often
 * as an operator likes.
 */
export function headAnchor(db: DatabaseSync, now: () => number = Date.now): HeadAnchorRecord {
  const meta = readChainMeta(db);
  const head = auditChainHead(db);
  const events = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
  return {
    format: HEAD_ANCHOR_FORMAT,
    chainFormat: meta?.format ?? 'none',
    algorithm: meta?.algorithm ?? AUDIT_CHAIN_ALGORITHM,
    chainStartedAt: meta?.startedAt ?? null,
    takenAt: new Date(now()).toISOString(),
    headEventId: head?.eventId ?? null,
    headHash: head?.hash ?? null,
    events,
    chainedFromEventId: meta?.chainedFromEventId ?? 1,
  };
}

/** One anchor as the single line an operator ships. Newline included. */
export function anchorLine(record: HeadAnchorRecord): string {
  return JSON.stringify(record) + '\n';
}

/**
 * Append an anchor to a file. Append and never rewrite, because the file's
 * whole use is that it is a series: a file holding only the latest head is a
 * file an attacker overwrites with the head they want.
 *
 * The file is inside Canon's trust boundary and is therefore NOT the anchor —
 * it is the thing a log shipper or an rsync tails. Callers must not describe it
 * as tamper-proof, and Canon does not.
 */
export function appendAnchor(file: string, record: HeadAnchorRecord): void {
  appendFileSync(file, anchorLine(record), 'utf8');
}

/** What a clean anchor record does and does not entitle a reader to conclude. */
export const ANCHOR_PROVES =
  'A retained anchor proves that the audit chain reached this head hash at this event id no later than the moment ' +
  'the anchor left Canon. A log that no longer reproduces that head hash at that event id has been rewritten, ' +
  'whatever GET /audit/verify says about its internal consistency.';

export const ANCHOR_LIMITS =
  'It proves that only for a copy held where Canon cannot write. The line Canon logs and the file Canon appends ' +
  'to are inside the same trust boundary as the database: somebody who can rewrite the log can rewrite both. ' +
  'Anchoring also says nothing about events after the last retained anchor, and nothing about events that were ' +
  'never written.';

export interface HeadAnchorOptions {
  db: DatabaseSync;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Milliseconds between anchors. 0 turns the timer off. */
  intervalMs?: number;
  /** A file to append each anchor to, as well as logging it. */
  file?: string | undefined;
  now?: () => number;
}

export interface HeadAnchorSchedule {
  scheduled: boolean;
  intervalMs: number;
  /** Where anchors go from here: the log always, plus a file when configured. */
  sink: 'log' | 'log+file';
  file: string | null;
  /** Why it is not running, when it is not. */
  reason: string | null;
}

export interface HeadAnchorRun {
  timer: NodeJS.Timeout | null;
  schedule: HeadAnchorSchedule;
  /** The anchor taken at start-up, before the port is bound. */
  first: HeadAnchorRecord | null;
}

export const DEFAULT_ANCHOR_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Take one anchor now and write it wherever this deployment sends them.
 *
 * A file that cannot be written is a `warn` and not a throw: the anchor still
 * reached the log, which is the sink that always exists, and a full disk on the
 * anchor volume must not be a reason for a knowledge record to stop serving.
 */
export function takeAnchor(options: HeadAnchorOptions): HeadAnchorRecord {
  const record = headAnchor(options.db, options.now);
  options.log.info('audit head anchor', {
    headEventId: record.headEventId,
    headHash: record.headHash,
    events: record.events,
    chainedFromEventId: record.chainedFromEventId,
    takenAt: record.takenAt,
    format: record.format,
    // Said on every line, not in a README somewhere: this line is inside
    // Canon's trust boundary and is worth something only once it has been
    // shipped off this machine.
    proves: 'nothing until a copy of this line is held where Canon cannot write it',
  });
  if (options.file) {
    try {
      appendAnchor(options.file, record);
    } catch (err) {
      options.log.warn('audit head anchor not written to file', {
        file: options.file,
        error: (err as Error).message,
      });
    }
  }
  return record;
}

/**
 * The anchor timer, on the same pattern as the freshness sweep and the record
 * watch (index.ts): one pass immediately, then every `intervalMs`, and the
 * handle returned so shutdown can clear it.
 *
 * Immediately, deliberately: the most valuable anchor is the one taken before
 * the deployment does anything, because it is the one that bounds the whole
 * of this run.
 */
export function startHeadAnchors(options: HeadAnchorOptions): HeadAnchorRun {
  const intervalMs = options.intervalMs ?? DEFAULT_ANCHOR_INTERVAL_MS;
  const sink: HeadAnchorSchedule['sink'] = options.file ? 'log+file' : 'log';
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return {
      timer: null,
      schedule: {
        scheduled: false,
        intervalMs: 0,
        sink,
        file: options.file ?? null,
        reason:
          'CANON_ANCHOR_INTERVAL_MS=0: this deployment publishes no head anchor, so a wholesale recomputation of ' +
          'the audit chain would leave nothing to contradict it. GET /audit/verify still names any break that has ' +
          'not been recomputed away.',
      },
      first: null,
    };
  }
  const first = takeAnchor(options);
  const timer = setInterval(() => {
    try {
      takeAnchor(options);
    } catch (err) {
      options.log.error('audit head anchor failed', { error: (err as Error).message });
    }
  }, intervalMs);
  timer.unref(); // never hold the process open on the timer alone
  return {
    timer,
    schedule: { scheduled: true, intervalMs, sink, file: options.file ?? null, reason: null },
    first,
  };
}

/** The anchor schedule from the environment, as index.ts assembles it. */
export function headAnchorOptionsFromEnv(
  db: DatabaseSync,
  log: HeadAnchorOptions['log'],
  env: NodeJS.ProcessEnv = process.env,
): HeadAnchorOptions {
  const raw = Number(env.CANON_ANCHOR_INTERVAL_MS ?? '');
  const file = env.CANON_ANCHOR_FILE?.trim();
  return {
    db,
    log,
    intervalMs: Number.isFinite(raw) && env.CANON_ANCHOR_INTERVAL_MS ? raw : DEFAULT_ANCHOR_INTERVAL_MS,
    ...(file ? { file } : {}),
  };
}

/**
 * What a bundle says about this deployment's anchoring, without claiming any
 * of it as proof. Read from configuration: whether anchors are being produced
 * at all, how often, and where they go from here — followed by the sentence
 * that matters, which is that Canon cannot know whether anybody kept one.
 */
export interface AnchorDisclosure {
  emitted: boolean;
  everyMs: number;
  sink: 'log' | 'log+file' | 'none';
  statement: string;
  proves: string;
  limits: string;
}

export function anchorDisclosure(env: NodeJS.ProcessEnv = process.env): AnchorDisclosure {
  const raw = Number(env.CANON_ANCHOR_INTERVAL_MS ?? '');
  const everyMs = Number.isFinite(raw) && env.CANON_ANCHOR_INTERVAL_MS ? raw : DEFAULT_ANCHOR_INTERVAL_MS;
  const file = Boolean(env.CANON_ANCHOR_FILE?.trim());
  const emitted = everyMs > 0;
  return {
    emitted,
    everyMs: emitted ? everyMs : 0,
    sink: emitted ? (file ? 'log+file' : 'log') : 'none',
    statement: emitted
      ? `This deployment records its audit-chain head every ${everyMs}ms to its process log` +
        (file ? ' and to a file on the server' : '') +
        `. ${file ? 'Both of those are' : 'That is'} inside Canon’s own trust boundary and ` +
        `${file ? 'neither is' : 'is not'} evidence on its own: an anchor is worth something only where a copy ` +
        'has been carried somewhere Canon cannot write it. Whether anybody did that is not something Canon can ' +
        'know or assert, so ask your operator, and compare the head hash printed in this document against what ' +
        'they hold.'
      : 'This deployment records no head anchor (CANON_ANCHOR_INTERVAL_MS=0). Nothing outside Canon fixes where ' +
        'this log had got to, so a wholesale recomputation of the chain by somebody with write access to the ' +
        'database would leave no external evidence to contradict it. Retaining THIS DOCUMENT is the mitigation ' +
        'available to you, and it is a real one: see the section on keeping it.',
    proves: ANCHOR_PROVES,
    limits: ANCHOR_LIMITS,
  };
}
