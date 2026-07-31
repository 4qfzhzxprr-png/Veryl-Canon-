import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// A hash chain over `audit_events` (FEATURES.md §7: "The log is exportable and
// tamper-evident"; DATA-BACKBONE.md §2 principle 3: history is append-only).
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVES, AND WHAT IT DOES NOT
//
// Before the mechanism, the claim — stated plainly, because a tamper-evidence
// feature that oversells itself is worse than none: an auditor who believes a
// stronger claim than the code makes will draw a conclusion the record cannot
// support.
//
// Each audit event carries the SHA-256 of its own content together with the
// previous event's hash. Any change to an event's stored content, any deletion
// of an event, any reordering of the log, and any insertion between two
// existing events breaks the chain at a point verification names exactly.
//
// It DOES defend against:
//
//   * accidental corruption — a half-written row, a restored partial backup,
//     a bad export/import round trip;
//   * a careless UPDATE — the operator "fixing" a typo in an old event, or a
//     migration script that rewrites a column across the table;
//   * a partial deletion — rows removed to hide an action, including removal
//     with the append-only triggers dropped, which is precisely the case the
//     triggers cannot see;
//   * a well-meaning but wrong "cleanup" that nobody would otherwise notice,
//     because the log is large and nobody reads it end to end.
//
// It does NOT defend against:
//
//   * an attacker who can write to this database and knows how the chain is
//     computed. The chain lives in the same SQLite file as the data it
//     protects, so such an attacker can delete an event and RECOMPUTE every
//     later link, and verification will report a clean chain. This is not a
//     weakness of the construction, it is the nature of a self-contained
//     chain: a chain proves internal consistency, and internal consistency is
//     exactly what a wholesale recomputation restores.
//   * anything at all about events that were never written. A chain says the
//     log has not changed since it was written; it says nothing about whether
//     the application wrote a complete log in the first place.
//
// WHAT WOULD BE NEEDED FOR MORE — recommended, deliberately not built here:
// PERIODIC EXTERNAL ANCHORING of the head hash. Publish `(headEventId,
// headHash, takenAt)` on a schedule to somewhere Canon cannot write: a
// write-once log, a counter-signed email to the compliance owner, a
// transparency log, a customer-held file. Once an anchor exists, a wholesale
// recomputation stops working — the recomputed chain cannot reproduce a head
// hash that was published before the tampering, so every event up to the last
// anchor becomes genuinely immutable rather than merely consistent. Canon
// gives an anchor everything it needs (`GET /audit/verify` returns the head)
// and takes no view on where a deployment publishes it, because that choice is
// the customer's trust boundary, not ours.
//
// ---------------------------------------------------------------------------
// THE MECHANISM
//
// The link for event N is
//
//     hash(N) = SHA-256( prevHash || JSON.stringify([ id, at, actor_id,
//               actor_kind, action, collection_id, page_id, details_json ]) )
//
// hex-encoded, where `prevHash` is `hash(N-1)` — or GENESIS_HASH (sixty-four
// zeros) for the first chained event — and `details_json` is the stored JSON
// string exactly as it sits in the column. A JSON array is the serialisation
// rather than a delimiter-joined string because it is unambiguous (no field
// can forge a separator), it is trivially reimplementable in any language an
// auditor's own tooling might be written in, and `JSON.stringify` over
// primitives is fully specified.
//
// The link is written by an AFTER INSERT trigger, not by application code.
// Eleven call sites across the server append audit events; a helper every one
// of them had to remember to call would be a chain with eleven ways to have a
// gap, and a twelfth the next feature would add. The trigger cannot be
// forgotten, and it covers code that does not exist yet.
//
// The links live in their own table rather than in columns on `audit_events`,
// for two reasons. `audit_events` already carries a BEFORE UPDATE trigger that
// aborts every update, so an AFTER INSERT trigger writing back to the row it
// just inserted would be refused by the append-only rule — correctly. And a
// separate table is what makes a DELETED event detectable at all: the event
// goes, its link stays behind, and an orphaned link is a deletion with a name
// and a timestamp attached.
//
// There is deliberately NO foreign key from `audit_chain.event_id` to
// `audit_events.id`. A foreign key would make the orphan impossible, which
// sounds stronger and is weaker: it would convert "a deleted event leaves
// evidence" into "a deletion fails until someone turns foreign keys off", and
// an attacker with write access turns them off in one statement.

/** The serialisation and algorithm this chain uses. Bump if either changes. */
export const AUDIT_CHAIN_FORMAT = 'canon-audit-chain-v1';
export const AUDIT_CHAIN_ALGORITHM = 'sha256';

/** The previous hash of the first chained event: sixty-four zeros. */
export const GENESIS_HASH = '0'.repeat(64);

/** The name the SQL trigger calls; registered on every connection by `openDb`. */
export const CHAIN_HASH_FUNCTION = 'canon_chain_hash';

/** The columns of an audit event that the chain covers. */
export interface ChainableEvent {
  id: number;
  at: string;
  actorId: string;
  actorKind: string;
  action: string;
  collectionId: string | null;
  pageId: string | null;
  detailsJson: string;
}

/**
 * The one definition of an event's link hash. The trigger calls it through
 * SQLite, verification calls it directly, and the attestation manifest
 * describes it in words — three readers, one implementation, so the
 * description in a bundle can never drift from what the database did.
 */
export function chainHash(prevHash: string, event: ChainableEvent): string {
  const canonical = JSON.stringify([
    event.id,
    event.at,
    event.actorId,
    event.actorKind,
    event.action,
    event.collectionId,
    event.pageId,
    event.detailsJson,
  ]);
  return createHash(AUDIT_CHAIN_ALGORITHM).update(prevHash + canonical).digest('hex');
}

/** A human-readable statement of the serialisation, carried in every bundle. */
export const CHAIN_HASH_RECIPE =
  `hash(event) = ${AUDIT_CHAIN_ALGORITHM}( previousHash + ` +
  'JSON.stringify([id, at, actorId, actorKind, action, collectionId, pageId, detailsJson]) ), hex-encoded. ' +
  `The first chained event uses previousHash = "${GENESIS_HASH}" (sixty-four zeros). ` +
  '`detailsJson` is the event details as the stored JSON string, byte for byte.';

/**
 * Registers the hash function the trigger calls. MUST run on a connection
 * before any audit event is inserted on it — `openDb` does this first, before
 * any schema is executed, so no connection can exist that can write an event
 * but not its link.
 */
export function registerAuditChainFunction(db: DatabaseSync): void {
  db.function(
    CHAIN_HASH_FUNCTION,
    // varargs: the arity is fixed at nine but node:sqlite matches arity
    // strictly against the JS function's declared parameter count, and a
    // mismatch surfaces as "wrong number of arguments" at INSERT time — the
    // worst possible moment to find out.
    { deterministic: true, varargs: true },
    (
      prevHash: unknown,
      id: unknown,
      at: unknown,
      actorId: unknown,
      actorKind: unknown,
      action: unknown,
      collectionId: unknown,
      pageId: unknown,
      detailsJson: unknown,
    ) =>
      chainHash(String(prevHash), {
        id: Number(id),
        at: String(at),
        actorId: String(actorId),
        actorKind: String(actorKind),
        action: String(action),
        collectionId: collectionId === null || collectionId === undefined ? null : String(collectionId),
        pageId: pageId === null || pageId === undefined ? null : String(pageId),
        detailsJson: String(detailsJson),
      }),
  );
}

const AUDIT_CHAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_chain (
  event_id  INTEGER PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_chain_meta (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  format                TEXT NOT NULL,
  algorithm             TEXT NOT NULL,
  chained_from_event_id INTEGER NOT NULL,
  pre_chain_events      INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  note                  TEXT NOT NULL
);
`;

// The links are history too, so they get the same storage-layer protection
// history already has. Created after the meta row so a fresh database never
// has a window in which events can be written unchained.
const AUDIT_CHAIN_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS audit_chain_link
AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_chain (event_id, prev_hash, hash)
  SELECT
    NEW.id,
    COALESCE((SELECT hash FROM audit_chain ORDER BY event_id DESC LIMIT 1), '${GENESIS_HASH}'),
    ${CHAIN_HASH_FUNCTION}(
      COALESCE((SELECT hash FROM audit_chain ORDER BY event_id DESC LIMIT 1), '${GENESIS_HASH}'),
      NEW.id, NEW.at, NEW.actor_id, NEW.actor_kind, NEW.action, NEW.collection_id, NEW.page_id, NEW.details_json
    );
END;

CREATE TRIGGER IF NOT EXISTS audit_chain_append_only_update
BEFORE UPDATE ON audit_chain
BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_chain_append_only_delete
BEFORE DELETE ON audit_chain
BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;
`;

export interface AuditChainMeta {
  format: string;
  algorithm: string;
  /** The first event id the chain covers. Events below it predate the chain. */
  chainedFromEventId: number;
  /** How many events were already in the log when chaining began. */
  preChainEvents: number;
  startedAt: string;
  note: string;
}

/**
 * Creates the chain tables and the trigger, and — on a database that already
 * holds audit events — records where the chain starts.
 *
 * MIGRATION, stated plainly: an existing log is chained FROM ITS CURRENT HEAD
 * FORWARD. Events written before the chain existed are left exactly as they
 * are and are reported as `unchained` by verification, for ever. The
 * alternative — walking the existing log and computing links for it — would
 * produce a chain that verifies perfectly and proves nothing at all, because
 * the links would be computed from whatever the rows say TODAY, including any
 * tampering that already happened. A chain that certifies its own starting
 * point is a chain that certifies nothing, so Canon declines to draw one and
 * says how many events it does not cover instead.
 */
export function ensureAuditChain(db: DatabaseSync): AuditChainMeta {
  db.exec(AUDIT_CHAIN_SCHEMA);
  let meta = readChainMeta(db);
  if (!meta) {
    const existing = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top FROM audit_events').get() as {
      n: number;
      top: number;
    };
    const note =
      existing.n === 0
        ? 'Chained from the first event: this record has been hash-chained since it was created.'
        : `Chained from the head forward on migration. The ${existing.n} event(s) written before this point are ` +
          'not covered by the chain and never will be — links computed for them now would be computed from ' +
          'their present contents, which is exactly what a chain is supposed to be independent of.';
    db.prepare(
      `INSERT INTO audit_chain_meta (id, format, algorithm, chained_from_event_id, pre_chain_events, started_at, note)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    ).run(AUDIT_CHAIN_FORMAT, AUDIT_CHAIN_ALGORITHM, existing.top + 1, existing.n, new Date().toISOString(), note);
    meta = readChainMeta(db)!;
  }
  db.exec(AUDIT_CHAIN_TRIGGERS);
  return meta;
}

function readChainMeta(db: DatabaseSync): AuditChainMeta | null {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_chain_meta'")
    .get() as { name: string } | undefined;
  if (!tables) return null;
  const row = db.prepare('SELECT * FROM audit_chain_meta WHERE id = 1').get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    format: row.format as string,
    algorithm: row.algorithm as string,
    chainedFromEventId: Number(row.chained_from_event_id),
    preChainEvents: Number(row.pre_chain_events),
    startedAt: row.started_at as string,
    note: row.note as string,
  };
}

export type AuditChainBreakKind = 'missing_link' | 'orphan_link' | 'content_mismatch' | 'link_mismatch';

export interface AuditChainBreak {
  kind: AuditChainBreakKind;
  eventId: number;
  at: string | null;
  action: string | null;
  expected: string | null;
  found: string | null;
  /** Written for the person reading the verification output, not for a log. */
  explanation: string;
}

export interface AuditChainHead {
  eventId: number;
  hash: string;
}

export interface AuditChainVerification {
  ok: boolean;
  format: string;
  algorithm: string;
  recipe: string;
  checkedAt: string;
  /** Every event in the log, chained or not. */
  events: number;
  /** The first event id the chain covers. */
  chainedFromEventId: number;
  /** Events written before the chain existed. Never covered; reported for ever. */
  unchained: number;
  /** Chained events walked and found intact, up to the first break. */
  verified: number;
  /**
   * True when `limit` stopped the walk before the end of the log. `ok: true`
   * then means "no break in what was walked", which is a weaker statement than
   * "no break", and a reader must be able to tell the two apart.
   */
  partial: boolean;
  head: AuditChainHead | null;
  firstBreak: AuditChainBreak | null;
  /** What a clean result does and does not entitle a reader to conclude. */
  proves: string;
  limits: string;
}

export const CHAIN_PROVES =
  'Every audit event from the point the chain began is present, in its original order, with its original ' +
  'content: no event has been altered, deleted, reordered, or inserted between two existing events since it ' +
  'was written.';

export const CHAIN_LIMITS =
  'The chain lives in the same database as the events it protects, so somebody who can write to that database ' +
  'and knows how the links are computed can delete an event and recompute every later link, and this check ' +
  'would then report a clean chain. It also says nothing about events that were never written. To close the ' +
  'first gap, publish the head hash periodically somewhere Canon cannot write (an external anchor); tampering ' +
  'before an anchor then cannot reproduce the anchored head.';

export interface VerifyOptions {
  /** Stop after this many events. Verification is a full walk by default. */
  limit?: number;
}

/**
 * Walks the chain and reports the FIRST break, in event order. First rather
 * than all, deliberately: after a break, every later link is computed against
 * a hash that is already wrong, so a list of "all breaks" would be one real
 * finding followed by thousands of consequences of it. The first break is the
 * fact; the rest is noise that would bury it.
 */
export function verifyAuditChain(db: DatabaseSync, options: VerifyOptions = {}): AuditChainVerification {
  // Read the meta rather than re-running the DDL on every check: verification
  // is a read, and a read that quietly executes CREATE statements is a read
  // with a surprise in it. `ensureAuditChain` runs only where the chain has
  // genuinely never been set up on this database.
  const meta = readChainMeta(db) ?? ensureAuditChain(db);
  const totals = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number };
  const unchained = (
    db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE id < ?').get(meta.chainedFromEventId) as { n: number }
  ).n;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : null;

  // One merged walk over events and links, so a link with no event (a deleted
  // event) and an event with no link (an unlinked insert) are both found in
  // event order, alongside content and ordering failures.
  const rows = db
    .prepare(
      `SELECT ids.id AS id,
              e.at AS at, e.actor_id AS actor_id, e.actor_kind AS actor_kind, e.action AS action,
              e.collection_id AS collection_id, e.page_id AS page_id, e.details_json AS details_json,
              c.prev_hash AS prev_hash, c.hash AS hash,
              e.id IS NOT NULL AS has_event, c.event_id IS NOT NULL AS has_link
         FROM (SELECT id FROM audit_events WHERE id >= ?
               UNION
               SELECT event_id AS id FROM audit_chain WHERE event_id >= ?) AS ids
         LEFT JOIN audit_events e ON e.id = ids.id
         LEFT JOIN audit_chain  c ON c.event_id = ids.id
        ORDER BY ids.id`,
    )
    .all(meta.chainedFromEventId, meta.chainedFromEventId) as Record<string, unknown>[];

  let expectedPrev = GENESIS_HASH;
  let verified = 0;
  let head: AuditChainHead | null = null;
  let firstBreak: AuditChainBreak | null = null;
  let partial = false;

  for (const row of rows) {
    if (limit !== null && verified >= limit) {
      partial = true;
      break;
    }
    const id = Number(row.id);
    const hasEvent = Number(row.has_event) === 1;
    const hasLink = Number(row.has_link) === 1;

    if (!hasEvent) {
      firstBreak = {
        kind: 'orphan_link',
        eventId: id,
        at: null,
        action: null,
        expected: null,
        found: (row.hash as string) ?? null,
        explanation:
          `Event ${id} is gone from the log but its chain link is still there. An audit event was deleted; ` +
          'the link it left behind is the evidence.',
      };
      break;
    }
    if (!hasLink) {
      firstBreak = {
        kind: 'missing_link',
        eventId: id,
        at: (row.at as string) ?? null,
        action: (row.action as string) ?? null,
        expected: expectedPrev,
        found: null,
        explanation:
          `Event ${id} carries no chain link. Either it was inserted by something that bypassed the trigger, ` +
          'or its link was removed.',
      };
      break;
    }

    const event: ChainableEvent = {
      id,
      at: row.at as string,
      actorId: row.actor_id as string,
      actorKind: row.actor_kind as string,
      action: row.action as string,
      collectionId: (row.collection_id as string) ?? null,
      pageId: (row.page_id as string) ?? null,
      detailsJson: row.details_json as string,
    };
    const storedPrev = row.prev_hash as string;
    const storedHash = row.hash as string;

    if (storedPrev !== expectedPrev) {
      firstBreak = {
        kind: 'link_mismatch',
        eventId: id,
        at: event.at,
        action: event.action,
        expected: expectedPrev,
        found: storedPrev,
        explanation:
          `Event ${id} links back to a hash that is not the previous event's. The log has been reordered, or ` +
          'an event was removed from in front of this one, or one was inserted.',
      };
      break;
    }
    const recomputed = chainHash(storedPrev, event);
    if (recomputed !== storedHash) {
      firstBreak = {
        kind: 'content_mismatch',
        eventId: id,
        at: event.at,
        action: event.action,
        expected: recomputed,
        found: storedHash,
        explanation:
          `Event ${id} does not hash to its recorded link. Its stored content has changed since it was written.`,
      };
      break;
    }

    verified += 1;
    head = { eventId: id, hash: storedHash };
    expectedPrev = storedHash;
  }

  return {
    ok: firstBreak === null,
    format: meta.format,
    algorithm: meta.algorithm,
    recipe: CHAIN_HASH_RECIPE,
    checkedAt: new Date().toISOString(),
    events: totals.n,
    chainedFromEventId: meta.chainedFromEventId,
    unchained,
    verified,
    partial,
    head,
    firstBreak,
    proves: CHAIN_PROVES,
    limits: CHAIN_LIMITS,
  };
}

/**
 * The chain's current head — the last event's id and hash — read without
 * walking. This is the value a deployment publishes to an external anchor,
 * and the value an attestation bundle carries so a reader can compare the
 * bundle against a live Canon or against an anchor.
 */
export function auditChainHead(db: DatabaseSync): AuditChainHead | null {
  const row = db.prepare('SELECT event_id, hash FROM audit_chain ORDER BY event_id DESC LIMIT 1').get() as
    | { event_id: number; hash: string }
    | undefined;
  return row ? { eventId: Number(row.event_id), hash: row.hash } : null;
}

/** The link for one event, or null where the event predates the chain. */
export function linkFor(db: DatabaseSync, eventId: number): { prevHash: string; hash: string } | null {
  const row = db.prepare('SELECT prev_hash, hash FROM audit_chain WHERE event_id = ?').get(eventId) as
    | { prev_hash: string; hash: string }
    | undefined;
  return row ? { prevHash: row.prev_hash, hash: row.hash } : null;
}
