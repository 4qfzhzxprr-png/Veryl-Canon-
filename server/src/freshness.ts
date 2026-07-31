import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, PageStatus, Role } from './model.js';
import type { Notifier } from './notify.js';
import { requireOrgRole } from './orgrole.js';

// Verification and freshness (FEATURES.md §3, the Next tier of the cut in
// "What ships first"; CORE-PLAN.md §4 Epic C names this as where `needs_update`
// lands): "Canonical pages carry a review date. When it passes, the page flips
// to Needs Update and the owner is notified. Stale knowledge announces itself
// instead of quietly rotting."
//
// What this file is, and is not:
//
//   * It is a SWEEP, not a trigger. Nothing watches the clock inside the record.
//     A deployment runs the sweep on a timer exactly as it runs the notification
//     outbox flush (index.ts wires both), and `POST /maintenance/freshness`
//     exists so an operator can also run it by hand.
//   * It is IDEMPOTENT by construction, not by bookkeeping. The sweep flips
//     `canonical` → `needs_update`; a page it has already flipped is no longer
//     `canonical`, so the second run does not see it and the owner is not
//     notified twice. There is no "already notified" column to get out of step
//     with the record, because the record's own status is the flag.
//   * It never returns a page TO Canonical. That is the review workflow the
//     product already has — edit, submit, approve — and a second path to the
//     Canonical mark would be a second definition of what the mark means.
//     store.submitForReview accepts a Needs Update page for exactly this reason.
//
// The review date itself is a structured field (`PageFields.reviewDate`, per
// DATA-BACKBONE.md §4: fields are data, typed and queryable, never parsed out of
// prose). Which types must carry one is TYPE_RULES' business, not this file's.

/**
 * Freshness added a column and a status value to `pages`. Databases created by
 * an earlier build are migrated here rather than by a migration framework Core
 * does not have — the same choice, and the same guard style, as notify.ts's
 * `ensureDeliveryColumns`.
 *
 * The column is an `ALTER TABLE ADD COLUMN`. The status is harder: SQLite bakes
 * a CHECK constraint into the stored table definition and offers no way to alter
 * one, so an older `pages` whose CHECK does not admit `needs_update` is rebuilt
 * by the documented twelve-step procedure (create the new table, copy, drop,
 * rename), with foreign keys off for the swap and `foreign_key_check` before it
 * is trusted. Without this, the first sweep on an upgraded record would fail at
 * the storage layer — which is the correct failure, and a bad way to find out.
 */
export function ensurePageFreshnessSchema(db: DatabaseSync): void {
  const definition = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (!definition) return; // no pages table yet; the base schema will create it current

  const admitsNeedsUpdate = definition.includes('needs_update');
  const hasReviewDate = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).some(
    (c) => c.name === 'review_date',
  );
  if (admitsNeedsUpdate && hasReviewDate) return;

  if (admitsNeedsUpdate) {
    db.exec('ALTER TABLE pages ADD COLUMN review_date TEXT');
    return;
  }

  // The CHECK constraint has to be replaced, so the table is rebuilt.
  const columns = (db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map((c) => c.name);
  const carried = columns.filter((c) => c !== 'review_date');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE pages_freshness_rebuild (
        id              TEXT PRIMARY KEY,
        collection_id   TEXT NOT NULL REFERENCES collections(id),
        parent_id       TEXT REFERENCES pages(id),
        position        INTEGER NOT NULL DEFAULT 0,
        type            TEXT NOT NULL CHECK (type IN ('policy', 'spec', 'plan', 'note')),
        title           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'in_review', 'canonical', 'needs_update', 'archived')),
        owner_id        TEXT REFERENCES actors(id),
        approver_id     TEXT REFERENCES actors(id),
        effective_date  TEXT,
        review_date     TEXT,
        current_version INTEGER,
        created_by      TEXT NOT NULL REFERENCES actors(id),
        created_at      TEXT NOT NULL
      )
    `);
    db.exec(
      `INSERT INTO pages_freshness_rebuild (${carried.join(', ')}) SELECT ${carried.join(', ')} FROM pages`,
    );
    db.exec('DROP TABLE pages');
    db.exec('ALTER TABLE pages_freshness_rebuild RENAME TO pages');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_collection ON pages(collection_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id)');
    const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (broken.length > 0) throw new Error('rebuilding pages for freshness broke a foreign key');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** An ISO calendar date, `YYYY-MM-DD`. Review dates are days, not instants. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Today, as the record counts days: UTC, so a sweep means the same thing everywhere. */
export function today(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Has this review date passed? Strictly before today: a page whose review is due
 * *today* has not yet gone stale, and flipping it at 00:00 on the day it is due
 * would tell an owner they are late on the morning they are on time.
 */
export function isPastReview(reviewDate: string | null | undefined, on: string = today()): boolean {
  return Boolean(reviewDate) && reviewDate! < on;
}

/** One page the sweep moved, in the order the sweep found them. */
export interface FreshnessFlip {
  pageId: string;
  collectionId: string;
  title: string;
  type: string;
  reviewDate: string;
  ownerId: string | null;
  notified: boolean; // false when the page names no owner: nobody to tell
}

export interface FreshnessSweepResult {
  at: string; // the day the sweep judged against
  scanned: number; // Canonical pages carrying a review date
  flipped: number;
  notified: number;
  unowned: number; // flipped, but with no owner to notify — a health finding
  pages: FreshnessFlip[];
}

export interface FreshnessSweepOptions {
  /** The day to judge against. Defaults to today; tests and backfills set it. */
  on?: string;
  /** Bound the work of one pass, as the outbox flush bounds its batch. */
  limit?: number;
}

export const DEFAULT_SWEEP_LIMIT = 500;

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface FreshnessHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function now(): string {
  return new Date().toISOString();
}

export class FreshnessService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: FreshnessHost,
    private readonly notifier: Notifier,
  ) {}

  /**
   * The sweep. Flips every Canonical page whose review date has passed to Needs
   * Update, notifies its owner through the existing outbox, and audits each flip
   * as `page.needs_update`.
   *
   * Permission: admin on some collection, the same question `Notifier.flushFor`
   * asks and for the same reason — maintenance is an operator's job and Core has
   * no global administrator to ask for instead. Deliberately NOT narrowed to the
   * collections the actor administers: a sweep that silently skipped half the
   * record would be worse than one that refuses, and a review date passing is an
   * objective fact about the record rather than a judgement about a collection.
   *
   * actorId-first, like every other surface here: the flip is attributed, and a
   * deployment's timer names the actor it runs as (CANON_MAINTENANCE_ACTOR_ID).
   * Attribution is universal (DATA-BACKBONE.md §2, principle 5), so there is no
   * anonymous system actor slipping writes into the log.
   */
  sweep(actorId: string, options: FreshnessSweepOptions = {}): FreshnessSweepResult {
    const actor = this.host.getActor(actorId);
    this.requireOperator(actorId);
    const on = options.on ?? today();
    if (!isIsoDate(on)) throw new CanonError('invalid', `A sweep date is an ISO date (YYYY-MM-DD), not '${on}'`);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SWEEP_LIMIT, 1), 5000);

    // Only Canonical pages, only ones carrying a review date, only ones whose
    // date has passed. Ordered by the date so the longest-stale go first when a
    // pass is bounded.
    const due = this.db
      .prepare(
        `SELECT id, collection_id, title, type, review_date, owner_id
           FROM pages
          WHERE status = 'canonical' AND review_date IS NOT NULL AND review_date < ?
          ORDER BY review_date, id
          LIMIT ?`,
      )
      .all(on, limit) as Record<string, unknown>[];

    const result: FreshnessSweepResult = { at: on, scanned: due.length, flipped: 0, notified: 0, unowned: 0, pages: [] };
    for (const row of due) {
      const pageId = row.id as string;
      // Conditional on the page still being Canonical: two overlapping sweeps,
      // or a page approved between the select and here, must not double-flip.
      // This is the same guard the outbox puts on marking a row sent.
      const moved = this.db
        .prepare("UPDATE pages SET status = 'needs_update' WHERE id = ? AND status = 'canonical'")
        .run(pageId);
      if (Number(moved.changes) !== 1) continue;

      const flip: FreshnessFlip = {
        pageId,
        collectionId: row.collection_id as string,
        title: row.title as string,
        type: row.type as string,
        reviewDate: row.review_date as string,
        ownerId: (row.owner_id as string) ?? null,
        notified: false,
      };
      result.flipped += 1;

      this.audit(actor, 'page.needs_update', {
        collectionId: flip.collectionId,
        pageId,
        details: {
          from: 'canonical' satisfies PageStatus,
          to: 'needs_update' satisfies PageStatus,
          reviewDate: flip.reviewDate,
          ownerId: flip.ownerId,
          sweptOn: on,
        },
      });

      if (flip.ownerId) {
        // Straight to `send`, not through the notifier's review fan-out: the
        // owner is told even when the owner is the actor who ran the sweep.
        // Suppressing self-notification is right for "Marc approved your draft"
        // and wrong here — the sweep is the clock speaking, not a colleague, and
        // an owner who runs maintenance still needs their own page in the list.
        this.notifier.send(flip.ownerId, {
          kind: 'review_due',
          subject: `Past review: ${flip.title}`,
          body:
            `"${flip.title}" was due for review on ${flip.reviewDate} and is now marked Needs Update. ` +
            `It stays in the record and can still be cited, marked as past review, until you re-approve it.`,
          link: `/pages/${pageId}`,
        });
        flip.notified = true;
        result.notified += 1;
      } else {
        result.unowned += 1;
      }
      result.pages.push(flip);
    }
    return result;
  }

  // ---- internals -------------------------------------------------------

  // The fifth of the "admin on at least one collection" operator stand-ins —
  // the four SECURITY.md R5 listed, plus this one, found by grepping for the
  // same shape. The sweep restatuses pages across EVERY collection at once and
  // mails their owners, which is exactly the blast radius that makes it an
  // operator's act rather than a collection administrator's (orgrole.ts).
  private requireOperator(actorId: string): void {
    requireOrgRole(this.db, actorId, 'operator', 'Running the freshness sweep');
  }

  private audit(
    actor: Actor,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}
