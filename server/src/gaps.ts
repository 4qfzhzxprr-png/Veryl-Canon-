// The refused-questions loop: what the record was asked and could not answer,
// kept until somebody closes the gap.
//
// WHY THIS IS A PRODUCT SURFACE AND NOT A LOG QUERY. Every refusal is already
// an audit event, and nobody reads them — the audit log answers "what
// happened", not "what should somebody do". A refusal is a gap report: either
// the record is missing a page, or it is missing a WORD (the aliases field
// exists precisely to add one), or the question is not this record's business.
// Each of those is a decision a person can make in seconds once the question
// is in front of them, and none of them happens while refusals live only in an
// append-only log. This is also the loop that makes the product improve with
// use, which no amount of retrieval tuning does: the labelled evaluation got
// ranking to 90% and the same four paraphrase questions stayed refused until
// the record could be taught the asker's word — by a person, seeing the
// refusal, here.
//
// THE PRIVACY RULE, INHERITED AND MADE STRUCTURAL. The audit log redacts an
// ask's question text from everyone but the asker and operators, because the
// harmful thing is the LINK between a person and what they did not know
// ("how do I raise a grievance about my manager"). This table never stores the
// asker at all — no column exists — so the surface cannot leak what the audit
// log redacts, no matter what later code does with it. The question text is
// deliberately shared with the people who triage gaps, and those people are
// operators: exactly the audience the audit log already trusts with it. The
// count says "asked four times" without saying by whom, or by how many.
//
// WHAT A GAP IS NOT. It is not a queue item with an SLA and not a support
// ticket. Resolving one records a sentence about what was done ("added
// 'urgent' as an alias on Claims Processing Standard"); dismissing one records
// that the record owes no answer ("canteen hours are not compliance
// material"). Both stay queryable, because "what did people ask that we
// decided not to cover" is itself something a knowledge team reviews.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CanonError } from './model.js';

export const GAPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS gaps (
  id             TEXT PRIMARY KEY,
  -- The question as last asked, verbatim, and the normalised form it is
  -- deduplicated by. No asker column, by design; see the header.
  question       TEXT NOT NULL,
  normalized     TEXT NOT NULL UNIQUE,
  collection_id  TEXT,
  times_asked    INTEGER NOT NULL DEFAULT 1,
  first_asked_at TEXT NOT NULL,
  last_asked_at  TEXT NOT NULL,
  -- The refusal's own pointers (answers.ts 'nearest') at the last asking:
  -- where the triaging owner starts, typically the page wanting an alias.
  nearest_json   TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution     TEXT,
  resolved_by    TEXT,
  resolved_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status, last_asked_at);
`;

export interface Gap {
  id: string;
  question: string;
  collectionId: string | null;
  timesAsked: number;
  firstAskedAt: string;
  lastAskedAt: string;
  nearest: { pageId: string; title: string }[];
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/**
 * The normalised form a question is deduplicated by: case, whitespace and
 * trailing punctuation folded, because "How long do we keep claims?" and
 * "how long do we keep claims" are one gap, not two. Deliberately nothing
 * cleverer — stemming or stopword-stripping here would merge questions a
 * person would call different, and a false merge hides a gap.
 */
export function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.\s]+$/, '');
}

function now(): string {
  return new Date().toISOString();
}

export class GapService {
  constructor(private readonly db: DatabaseSync) {
    db.exec(GAPS_SCHEMA);
  }

  /**
   * Record one refusal. Called from the answer path, so it must never throw
   * the ask away: any failure here is swallowed by the caller rather than
   * turning a correct refusal into a 500.
   *
   * A recurrence reopens a RESOLVED gap — the fix evidently did not take —
   * and does not reopen a DISMISSED one: "we owe no answer" was a decision
   * about the question, not about the attempt, and it stands until somebody
   * changes it. Both keep counting, because "dismissed, and still asked
   * monthly" is exactly the fact that gets a dismissal revisited.
   */
  recordRefusal(
    question: string,
    collectionId: string | null,
    nearest: readonly { pageId: string; title: string }[],
  ): void {
    const normalized = normalizeQuestion(question);
    if (!normalized) return;
    const at = now();
    const nearestJson = JSON.stringify(nearest.map((n) => ({ pageId: n.pageId, title: n.title })));
    const updated = this.db
      .prepare(
        `UPDATE gaps SET
           question = ?, times_asked = times_asked + 1, last_asked_at = ?, nearest_json = ?,
           collection_id = COALESCE(?, collection_id),
           status = CASE status WHEN 'resolved' THEN 'open' ELSE status END,
           resolution = CASE status WHEN 'resolved' THEN NULL ELSE resolution END,
           resolved_by = CASE status WHEN 'resolved' THEN NULL ELSE resolved_by END,
           resolved_at = CASE status WHEN 'resolved' THEN NULL ELSE resolved_at END
         WHERE normalized = ?`,
      )
      .run(question, at, nearestJson, collectionId, normalized);
    if (Number(updated.changes) > 0) return;
    this.db
      .prepare(
        `INSERT INTO gaps (id, question, normalized, collection_id, first_asked_at, last_asked_at, nearest_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), question, normalized, collectionId, at, at, nearestJson);
  }

  list(filter: { status?: string } = {}): Gap[] {
    const status = filter.status ?? 'open';
    if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) {
      throw new CanonError('invalid', `Unknown gap status: ${status}`);
    }
    const rows =
      status === 'all'
        ? this.db.prepare('SELECT * FROM gaps ORDER BY last_asked_at DESC').all()
        : this.db.prepare('SELECT * FROM gaps WHERE status = ? ORDER BY last_asked_at DESC').all(status);
    return (rows as Record<string, unknown>[]).map(toGap);
  }

  /**
   * Close a gap, with the sentence that says how — "how" is the record this
   * table exists to keep, so it is required for resolution. A dismissal's
   * note is optional: "not our material" repeated forty times is noise.
   */
  close(actorId: string, gapId: string, outcome: 'resolved' | 'dismissed', note: string | null): Gap {
    const row = this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(gapId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such gap: ${gapId}`);
    if (outcome === 'resolved' && !note?.trim()) {
      throw new CanonError('invalid', 'Resolving a gap records what was done; say it in a sentence');
    }
    this.db
      .prepare('UPDATE gaps SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(outcome, note?.trim() || null, actorId, now(), gapId);
    return toGap(this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(gapId) as Record<string, unknown>);
  }
}

function toGap(row: Record<string, unknown>): Gap {
  let nearest: { pageId: string; title: string }[] = [];
  try {
    const parsed = JSON.parse((row.nearest_json as string) ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      nearest = parsed.filter(
        (n): n is { pageId: string; title: string } =>
          typeof (n as { pageId?: unknown }).pageId === 'string' &&
          typeof (n as { title?: unknown }).title === 'string',
      );
    }
  } catch {
    nearest = [];
  }
  return {
    id: row.id as string,
    question: row.question as string,
    collectionId: (row.collection_id as string) ?? null,
    timesAsked: row.times_asked as number,
    firstAskedAt: row.first_asked_at as string,
    lastAskedAt: row.last_asked_at as string,
    nearest,
    status: row.status as Gap['status'],
    resolution: (row.resolution as string) ?? null,
    resolvedBy: (row.resolved_by as string) ?? null,
    resolvedAt: (row.resolved_at as string) ?? null,
  };
}
