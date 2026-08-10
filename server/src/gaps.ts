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
// asker at all — no column exists — so no query, export or screen built on it
// can leak that link by accident, and nobody below operator sees the questions
// at all. It is NOT anonymity from operators, and must not be described as
// such: every refusal here is also an audit event, and an operator who needs
// to know who asked can deliberately join the two — under the audit log's own
// access rule, which already trusts exactly these people with question text.
// What the missing column buys is that the join takes that deliberate act on
// that governed surface, rather than being one SELECT on this one.
//
// WHO READS THEM, AND THE ONE WIDENING THIS RULE HAS TAKEN. "Nobody below
// operator" was the original line and it had a cost the seventh round measured:
// `#/gaps` opened for no collection role, not even `admin`, while the
// prescribed remedy — the "Also known as" alias field — lives in the STEWARD's
// editor. The person whose job the fix is could not see the finding, and a
// blocked member-services rep's query failed on exactly that.
//
// So a collection's administrator now reads the gaps RECORDED AGAINST THAT
// COLLECTION, and nothing else. What makes that safe is the missing column
// rather than a new check: the harmful disclosure was never the question, it
// was the LINK between a person and what they did not know, and this table
// cannot make that link for anybody, at any role, because it has no asker in
// it. A gap with no collection — asked across the whole record — stays
// operator-only, because nothing about it says whose material it was and
// guessing would put one team's question in front of another team's steward.
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
  /**
   * Whether the record would answer this question TODAY — a gap goes stale
   * the moment somebody teaches the record the missing word, and until this
   * flag an operator had no signal short of re-asking by hand. Derived, never
   * stored: it is the store's dry-run probe (CanonStore.listGaps), run with
   * the listing operator's own permissions, and absent where the probe was
   * not run (closed gaps, past the probing cap, or a probe that failed).
   */
  nowAnswers?: boolean;
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

  /**
   * `collectionIds` narrows the list to gaps recorded against those
   * collections — the STEWARD's view (see CanonStore.listGaps for who gets it
   * and why). A gap with no collection is one asked across the whole record;
   * it is never in a narrowed list, because nothing about it says whose
   * material it was, and guessing would put one team's question in front of
   * another team's steward.
   */
  list(filter: { status?: string; collectionIds?: readonly string[] } = {}): Gap[] {
    const status = filter.status ?? 'open';
    if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) {
      throw new CanonError('invalid', `Unknown gap status: ${status}`);
    }
    const scoped = filter.collectionIds;
    if (scoped && !scoped.length) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (scoped) {
      where.push(`collection_id IN (${scoped.map(() => '?').join(', ')})`);
      params.push(...scoped);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM gaps${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY last_asked_at DESC`,
      )
      .all(...(params as never[]));
    return (rows as Record<string, unknown>[]).map(toGap);
  }

  /** One gap by id, or null. Used by the store to decide who may close it. */
  get(gapId: string): Gap | null {
    const row = this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(gapId) as Record<string, unknown> | undefined;
    return row ? toGap(row) : null;
  }

  /**
   * Close a gap, with the sentence that says how — "how" is the record this
   * table exists to keep, so it is required either way the gap closes. A
   * dismissal's note used to be optional on the theory that "not our
   * material" forty times over is noise; the fourth round showed the cost of
   * that theory: a dismissal was the ONE closure nobody could audit later,
   * and "dismissed, and still asked monthly" — the exact case that gets a
   * dismissal revisited — arrived with no reason to revisit. Forty short
   * reasons beat one unexplained silence.
   */
  close(actorId: string, gapId: string, outcome: 'resolved' | 'dismissed', note: string | null): Gap {
    const row = this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(gapId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such gap: ${gapId}`);
    if (!note?.trim()) {
      throw new CanonError(
        'invalid',
        outcome === 'resolved'
          ? 'Resolving a gap records what was done; say it in a sentence'
          : 'Dismissing a gap records why the record owes no answer; say it in a sentence',
      );
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
