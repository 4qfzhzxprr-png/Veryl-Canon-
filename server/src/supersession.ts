import type { DatabaseSync } from 'node:sqlite';
import type { PageStatus } from './model.js';

// WHERE A READER MEETS A SUPERSEDED PAGE.
//
// The record can say that one page replaces another (relations.ts, kind
// `supersedes`). Until now the only surface that said so was the page itself:
// open a page, scroll to Related, and there it is. Every surface a reader
// arrives THROUGH — the search dropdown, the search results page, a
// collection's contents table — drew the page's `status` alone, so a
// superseded page is a plain DRAFT chip in the list somebody is choosing from,
// and the fact that the record has moved on is behind one more click that
// nobody has a reason to make (REMEDIATION-PLAN.md 1.6, and the correction
// recording that only the banner half of it landed).
//
// So supersession travels with the two reads a reader arrives through, and it
// is computed HERE rather than twice: `SearchIndex.search` and
// `CanonStore.tree` call the same function, so the chip in the dropdown and
// the chip in the table cannot come to disagree about what the record says.
//
// EXISTENCE, NEVER IDENTITY (REMEDIATION-PLAN.md, policy question 1, answered).
//
// The replacement may sit in a collection this reader holds no role in. The
// answered policy is the one relations.ts already implements: a relationship
// the record states about a page you HOLD is disclosed; nothing identifying
// about the page at the far end is. Both halves matter here.
//
//   - It is disclosed. A reader choosing between search hits is exactly the
//     person who needs to know the record has moved on, and "this page is
//     superseded" is a fact about the page in front of them.
//   - Nothing about the replacement travels: no id, no title, no type, no
//     status, no collection, and no `answerable` flag either — a replacement
//     that is "not part of the official record yet" is a statement about the
//     withheld page's status, which is exactly what the marker exists to keep
//     back. `SupersededByWithheld` is `{ withheld: true }` and nothing else,
//     and a test asserts the serialized payload carries none of the far page's
//     fields.
//
// This widens nothing: both callers are already permission-filtered on the
// page being listed, so every mark is a relation asserted against a page this
// asker may read. Nobody can enumerate the record by asking about pages they
// have no standing over — the boundary policy question 1 drew for search
// (a term anybody can type is not a relationship the record states) is
// untouched, because the query here is keyed on ids that already came out of a
// permission-filtered read.

/** The replacement, when the asker may see it. */
export interface SupersededByPage {
  pageId: string;
  title: string;
  status: PageStatus;
  collectionId: string;
  /**
   * Whether a grounded answer may draw on the replacement — retrieval's
   * ANSWERABLE_STATUSES, plus the derived case retrieval also honours: a page
   * In Review that is still serving the version that last received the
   * Canonical mark. False means "superseded by X" does NOT mean the answer
   * moved over there: nothing has been approved on the subject and this page
   * is still what the record serves. That is the sentence the page banner
   * already says (app.js, supersededByUnanswerableHTML); this carries it to
   * the surfaces a reader arrives through.
   */
  answerable: boolean;
}

/** The replacement when the asker holds no role in its collection. */
export interface SupersededByWithheld {
  withheld: true;
}

export type SupersededBy = SupersededByPage | SupersededByWithheld;

/** True when the replacement is outside what this asker may read. */
export function isSupersessionWithheld(mark: SupersededBy): mark is SupersededByWithheld {
  return (mark as SupersededByWithheld).withheld === true;
}

/**
 * For each of these pages, what the record says replaces it — or nothing at
 * all, which is the common case and costs one indexed lookup.
 *
 * WHICH ROW WINS WHEN THERE ARE SEVERAL. The most recently asserted one: the
 * record's latest word on what replaces this page. Not "the answerable one",
 * which would need the status of a page that may be withheld to decide what to
 * show for a page that is not. One rule, applied the same way whether the far
 * end is visible or not, so the choice itself discloses nothing.
 *
 * An ARCHIVED replacement is still a replacement — the record holds the
 * assertion either way — and is simply not answerable. Dropping it would tell
 * the reader nothing had happened to a page the record says was replaced.
 */
export function supersessionMarks(
  db: DatabaseSync,
  actorId: string,
  pageIds: readonly string[],
  options: {
    /**
     * A second actor who must ALSO be able to see the replacement before it is
     * named. The Knowledge API's rule (STUDIO-CONTRACT.md §4): a Studio app's
     * answer is bounded by the app's permissions AND the person's at once, so
     * an app that may read a collection cannot narrate its titles to somebody
     * who may not. Without it, this one field would have been the first read
     * in the product where the double gate did not hold — the app's membership
     * alone would have decided whether a title travelled.
     */
    alsoVisibleTo?: string;
  } = {},
): Map<string, SupersededBy> {
  const out = new Map<string, SupersededBy>();
  if (pageIds.length === 0) return out;
  const placeholders = pageIds.map(() => '?').join(', ');
  const second = options.alsoVisibleTo
    ? `AND EXISTS (SELECT 1 FROM collection_members m2
                    WHERE m2.collection_id = o.collection_id AND m2.actor_id = ?)`
    : '';
  const rows = db
    .prepare(
      // `to_page_id` is the superseded end: `supersedes` is stored exactly as
      // asserted (relations.ts, relationPair), so the row reads "from replaces
      // to" and the page being listed is `to`.
      `SELECT r.to_page_id AS page_id,
              o.id AS other_id, o.title AS other_title, o.status AS other_status,
              o.collection_id AS other_collection_id,
              o.current_version AS other_current_version, o.marked_version AS other_marked_version,
              (EXISTS (SELECT 1 FROM collection_members m
                        WHERE m.collection_id = o.collection_id AND m.actor_id = ?)
               ${second}) AS other_visible
         FROM page_relations r
         JOIN pages o ON o.id = r.from_page_id
        WHERE r.kind = 'supersedes' AND r.to_page_id IN (${placeholders})
        ORDER BY r.asserted_at DESC, r.rowid DESC`,
    )
    .all(actorId, ...(options.alsoVisibleTo ? [options.alsoVisibleTo] : []), ...pageIds) as Record<
    string,
    unknown
  >[];
  for (const row of rows) {
    const pageId = row.page_id as string;
    // Newest first, so the first row seen for a page is the record's latest
    // statement about it.
    if (out.has(pageId)) continue;
    if (!Boolean(row.other_visible)) {
      out.set(pageId, { withheld: true });
      continue;
    }
    const status = row.other_status as PageStatus;
    const serving =
      status === 'in_review' &&
      row.other_marked_version !== null &&
      row.other_current_version === row.other_marked_version;
    out.set(pageId, {
      pageId: row.other_id as string,
      title: row.other_title as string,
      status,
      collectionId: row.other_collection_id as string,
      answerable: status === 'canonical' || status === 'needs_update' || serving,
    });
  }
  return out;
}
