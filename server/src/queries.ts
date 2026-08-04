import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { forbiddenRole } from './abilities.js';
import { Actor, CanonError, DocType, DOC_TYPES, PageStatus, Role, ROLE_RANK, TYPE_RULES } from './model.js';
import { isIsoDate, isPastReview, today } from './freshness.js';
import { isBackdated, isNotYetInForce, recordAnchorDate } from './effectivedate.js';
import { ConcentrationOfDuty, concentrationOfDuty, marksStandingIn } from './concentration.js';
import { isOrgOperator } from './orgrole.js';

// Structured queries (FEATURES.md §6): "Query the record by its fields: 'all
// Canonical policies owned by Compliance with a review date in the next 60
// days.' Save queries and pin them to dashboards." And record health
// (FEATURES.md §8), which is that same query surface pointed at the record
// itself: pages past review, pages without owners, orphaned pages, stale drafts.
// One member of that summary is not a count and lives in a file of its own —
// `approvalConcentration`, which answers "who granted the Canonical marks here,
// out of how many people could have, and where did their authority come from"
// (concentration.ts). It is in record health because it is the same kind of
// thing: a property of the record, measured rather than asserted, with every
// number in it openable.
//
// THE ONE DESIGN DECISION THIS FILE MAKES
//
// A structured filter, not a query language. Jira has JQL and JQL has a parser,
// and a parser is where "structure over prose" (DATA-BACKBONE.md §2, principle
// 2) quietly stops being true: the moment a filter is a string, somebody writes
// one by hand, somebody else builds one by concatenation, and the fields the
// rules depend on are back inside prose. So `PageQuery` is a typed object whose
// every field names a real column, validated before it touches SQL, and the
// SQL is built from a fixed vocabulary with bound parameters only. A UI builds
// one from dropdowns; an agent builds one from JSON; neither can express
// anything this file has not already agreed to.
//
// PERMISSIONS ARE IN THE SELECT, NEVER AFTER IT
//
// Every candidate query joins `collection_members` for the asking actor, the
// way search and retrieval do. A non-member's query returns nothing because
// nothing was ever selected — not because a filter ran afterwards and could one
// day be forgotten. Saved queries add nothing to this: a saved query is a stored
// filter, run under the permissions of whoever runs it.
//
// THREE MEMBERS THAT ARE NOT COLUMNS ON `pages`, AND WHY THEY LIVE HERE ANYWAY
//
// `awaitingApprovalBy`, `sentBackTo` and `draftHeldBy` are what a person means
// by "my work" (USER-TESTING.md T2.1), and none of the three is a column: the
// approver a page in review is waiting on lives in the DRAFT's `fields_json`,
// who holds a draft lives in `drafts.editor_id`, and "was this sent back" is a
// fact about the audit log. A Director of Compliance found his 25 pending
// approvals by opening 44 pages one at a time to read a field the listing did
// not show, which is what a filter surface is for.
//
// They are here rather than in a service of their own for one reason: the
// permission join. Every one of them narrows the SAME candidate SELECT that
// already joins `collection_members` for the asking actor, so a queue can no
// more show a page the asker may not see than a query can. A second query path
// that assembled somebody's work from `drafts` and `audit_events` directly is
// exactly where the leak gets in, and it would be a leak into the one screen
// people check every morning. Each is a bounded sub-clause — an EXISTS, or a
// scalar subquery over one page's workflow events — with bound parameters only,
// and each states in prose which server rule it is the read-side mirror of.
//
// WHAT IS DELIBERATELY NOT HERE
//
// `labels`. FEATURES.md §1 lists labels, but the record has no label field yet —
// no column, no table, no way to put one on a page. A filter over a field that
// does not exist would either always match nothing or quietly lie about being
// applied, and both are worse than its absence. When labels land, they land as a
// structured field and get a `labels` member here; nothing else changes.

export const QUERIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES actors(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_creator ON saved_queries(created_by);
`;

export type QuerySort = 'reviewDate' | 'updatedAt' | 'createdAt' | 'title' | 'status';
const SORTS: readonly QuerySort[] = ['reviewDate', 'updatedAt', 'createdAt', 'title', 'status'];

export type QueryDirection = 'asc' | 'desc';

const PAGE_STATUSES: readonly PageStatus[] = ['draft', 'in_review', 'canonical', 'needs_update', 'archived'];

/**
 * The types whose review names ONE approver, read off TYPE_RULES rather than
 * listed. On any other reviewed type (a Plan) the draft names nobody and every
 * holder of `approve` on the collection may accept it, which is the branch
 * `awaitingApprovalBy` takes below.
 */
const APPROVER_TYPES: readonly DocType[] = DOC_TYPES.filter((t) => TYPE_RULES[t].requiresApprover);

/**
 * The collection roles that satisfy `approve`, derived from ROLE_RANK exactly
 * as `requireRole` derives it — the same question, asked in SQL because the
 * queue asks it about thousands of pages at once rather than about one.
 */
const APPROVING_ROLES: readonly Role[] = (Object.keys(ROLE_RANK) as Role[]).filter(
  (r) => ROLE_RANK[r] >= ROLE_RANK.approve,
);

/**
 * The events that are acts in the review workflow, newest-first over one page.
 * `sentBackTo` reads the last of them: a send-back is the current state of a
 * page only until its author does something about it.
 *
 * Exported because `CanonStore.sentBack` asks the identical question about one
 * page — "is the send-back still the last word?" — and a second list that
 * forgot `page.withdraw` would leave a banner standing on a page whose author
 * had already dealt with it, on a screen where the queue said otherwise.
 */
export const WORKFLOW_ACTIONS = [
  'page.send_back',
  'page.submit',
  'page.approve',
  'page.publish',
  'page.withdraw',
] as const;

/**
 * The filter. Every member is optional; an empty query means "every page I may
 * see". Within a member the values are OR-ed (types: ['policy','spec'] is
 * either); across members they are AND-ed, which is what a person means by
 * "Canonical policies owned by Compliance".
 */
export interface PageQuery {
  collectionIds?: string[];
  types?: DocType[];
  statuses?: PageStatus[];
  ownerIds?: string[];
  /**
   * The approver of the PUBLISHED version — `pages.approver_id`, which is
   * history: who granted the mark to what is on screen. It is NOT who a page in
   * review is waiting on; that is `awaitingApprovalBy` below, and the two
   * legitimately differ (store.ts, "the review workflow" invariant).
   */
  approverIds?: string[];
  /**
   * Pages In Review that this actor can currently approve.
   *
   * The read-side mirror of `CanonStore.approve`, matched to it clause for
   * clause, because a queue that lists work the server would refuse is worse
   * than no queue:
   *
   *   * the DRAFT's approver, not the page row's. `approve` publishes the draft,
   *     so the approver it enforces is the one named in the draft's
   *     `fields_json` — the same answer `reviewState` publishes to every screen.
   *   * on a type that names no approver (a Plan), any holder of `approve` on
   *     the collection accepts it, so every one of them has it in their queue.
   *   * `approve` also requires the `approve` role, on every type. A person
   *     named as approver who does not hold it would be shown a page they
   *     cannot act on, so they are not shown it here either.
   */
  awaitingApprovalBy?: string;
  /**
   * Pages whose most recent act in the review workflow was a send-back, with the
   * draft still in this actor's hands: work returned to a named person with a
   * comment saying why. It stops being sent-back the moment they resubmit,
   * because the resubmission is then the most recent act.
   */
  sentBackTo?: string;
  /** Pages carrying an open draft this actor holds — their work in progress. */
  draftHeldBy?: string;
  /** True: only pages with an owner. False: only pages without one (health's question). */
  hasOwner?: boolean;
  /** Only pages with a review date at all — the ones freshness can act on. */
  hasReviewDate?: boolean;
  /** True: only pages that state an effective date. False: only pages that do not. */
  hasEffectiveDate?: boolean;
  /**
   * Pages whose effective date precedes their own first publication
   * (USER-TESTING.md T1.5). A count is a finding; this is what turns it into a
   * sample an auditor can actually open. Combined with
   * `hasEffectiveDateBasis: false` it is exactly her question: "which Canonical
   * policies claim to pre-date this record and say nothing about why".
   */
  backdated?: boolean;
  /** Only backdated dates whose author stated a basis, or only those who did not. */
  hasEffectiveDateBasis?: boolean;
  reviewDateBefore?: string; // exclusive, ISO date
  reviewDateAfter?: string; // exclusive, ISO date
  updatedBefore?: string; // exclusive, ISO date or timestamp
  updatedAfter?: string; // exclusive
  createdBefore?: string;
  createdAfter?: string;
  sort?: QuerySort;
  direction?: QueryDirection;
  limit?: number;
}

/**
 * One row. The page's structured fields, flat, plus `updatedAt` — the time the
 * current published version was written, falling back to the page's creation
 * when nothing is published yet, because "when did this last change" is a
 * question about the record, not about whether a draft happens to exist.
 */
export interface QueryResultPage {
  pageId: string;
  collectionId: string;
  parentId: string | null;
  type: DocType;
  title: string;
  status: PageStatus;
  ownerId: string | null;
  approverId: string | null;
  effectiveDate: string | null;
  /** What the author said a backdated effective date rests on; null if none was needed or given. */
  effectiveDateBasis: string | null;
  reviewDate: string | null;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
  /** When version 1 was published, or null if nothing ever was. */
  firstPublishedAt: string | null;
  /** Convenience the caller would otherwise recompute: is the review date behind us? */
  pastReview: boolean;
  /**
   * The effective date precedes this page's own first publication (falling back
   * to its creation, before anything is published). Derived on every read from
   * two dates the record already holds — never stored, so it cannot drift away
   * from the history it describes.
   */
  backdated: boolean;
  /** Backdated, and nobody recorded where the date came from. */
  backdatedWithoutBasis: boolean;
  /** Dated to take effect on a day that has not arrived yet. */
  notYetInForce: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: PageQuery;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;

/**
 * How many pages one health summary reads. A cap rather than an unbounded scan,
 * for the same reason the audit CSV has one; when it bites, the summary says so
 * in `truncated` instead of quietly under-counting.
 */
export const HEALTH_SCAN_LIMIT = 2000;

/** Drafts older than this many days are stale, unless the caller says otherwise. */
export const DEFAULT_STALE_DRAFT_DAYS = 30;

/** FEATURES.md §8's list, in its smallest honest form. */
export interface CollectionHealth {
  collectionId: string;
  at: string; // the day the counts were judged against
  pages: number; // non-archived pages scanned
  pastReview: number;
  needsUpdate: number;
  withoutOwner: number;
  orphaned: number;
  staleDrafts: number;
  staleDraftDays: number;
  // ---- the effective date (USER-TESTING.md T1.5) -------------------------
  //
  // Three counts rather than one, because they are three different findings and
  // an auditor acts differently on each. All three are SAMPLEABLE: the query
  // filters `hasEffectiveDate`, `backdated` and `hasEffectiveDateBasis` are
  // exactly the predicates counted here, so a number on this summary is a list
  // one call away. A count nobody can open is a rumour.
  /**
   * Pages holding the Canonical mark (or flipped to Needs Update from it) whose
   * type requires an effective date and which state none. Her "six have no
   * effective date at all". These are not invalid — they were published under a
   * record that did not ask — and they are not hidden either.
   */
  canonicalWithoutEffectiveDate: number;
  /**
   * Pages whose effective date precedes their own first publication. This is
   * NOT a count of suspected forgeries. It is the ordinary shape of migrated
   * material, and on a record that grew out of another system it may be most of
   * the corpus. It is here because an auditor asked to be able to see the
   * population before sampling it.
   */
  backdatedEffectiveDate: number;
  /**
   * Of those, the ones where nobody recorded where the date came from. THIS is
   * the exception worth sampling: a date asserted about a time the record
   * cannot see, with nothing offered to corroborate it. On a record written
   * entirely under the current rules this is zero, because the declaration is
   * required at the point the date is set; a number above zero means pages that
   * predate the rule, and each one is a question for a person who may still
   * remember the answer.
   */
  backdatedWithoutBasis: number;
  /** Pages dated to take effect on a day that has not arrived. Informational. */
  notYetInForce: number;
  // ---- concentration of duty (USER-TESTING.md T4.8, on re-review) ---------
  /**
   * Who granted the Canonical marks standing in this collection, out of how
   * many people could have, where their authority came from, and whether any
   * of them also put the work forward.
   *
   * It sits inside record health rather than beside it because that is what it
   * is: a measured property of the record, exactly like `withoutOwner` and
   * `backdatedWithoutBasis`. And like those, every number in it is a number
   * somebody can open — `granters` and `dormant` name the people, `selfApproved`
   * names the pages, and the register attestation carries the same report as
   * evidence. It is deliberately NOT a score; concentration.ts argues that at
   * length.
   */
  approvalConcentration: ConcentrationOfDuty;
  /** The scan hit HEALTH_SCAN_LIMIT: these counts are a floor, not a total. */
  truncated: boolean;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface QueryHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class QueryService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: QueryHost,
  ) {}

  // ---- running a query -------------------------------------------------

  /**
   * Run a filter for one actor. The permission join is part of the candidate
   * SELECT, so a page in a collection the actor does not belong to is never
   * selected, never counted, and never returned.
   */
  run(actorId: string, query: PageQuery = {}): QueryResultPage[] {
    this.host.getActor(actorId);
    const filter = validateQuery(query);

    const clauses: string[] = [];
    const params: (string | number)[] = [actorId];

    if (filter.collectionIds?.length) {
      clauses.push(`p.collection_id IN (${placeholders(filter.collectionIds.length)})`);
      params.push(...filter.collectionIds);
    }
    if (filter.types?.length) {
      clauses.push(`p.type IN (${placeholders(filter.types.length)})`);
      params.push(...filter.types);
    }
    if (filter.statuses?.length) {
      clauses.push(`p.status IN (${placeholders(filter.statuses.length)})`);
      params.push(...filter.statuses);
    } else {
      // Archived pages leave search and answers (FEATURES.md §7); a query that
      // does not ask for them by name does not get them either. Naming
      // 'archived' in `statuses` is how you ask.
      clauses.push("p.status != 'archived'");
    }
    if (filter.ownerIds?.length) {
      clauses.push(`p.owner_id IN (${placeholders(filter.ownerIds.length)})`);
      params.push(...filter.ownerIds);
    }
    if (filter.approverIds?.length) {
      clauses.push(`p.approver_id IN (${placeholders(filter.approverIds.length)})`);
      params.push(...filter.approverIds);
    }
    // "Waiting on me", in SQL, against the same three conditions `approve`
    // enforces in TypeScript. `APPROVER_TYPES` and `APPROVING_ROLES` are derived
    // from TYPE_RULES and ROLE_RANK rather than written out, so a fifth document
    // type or a sixth role changes this clause by changing those tables.
    if (filter.awaitingApprovalBy) {
      clauses.push(
        `(p.status = 'in_review'
          AND EXISTS (SELECT 1 FROM collection_members am
                       WHERE am.collection_id = p.collection_id AND am.actor_id = ?
                         AND am.role IN (${placeholders(APPROVING_ROLES.length)}))
          AND EXISTS (SELECT 1 FROM drafts d
                       WHERE d.page_id = p.id
                         AND (CASE WHEN p.type IN (${placeholders(APPROVER_TYPES.length)})
                                   THEN json_extract(d.fields_json, '$.approverId') = ?
                                   ELSE 1 END)))`,
      );
      params.push(filter.awaitingApprovalBy, ...APPROVING_ROLES, ...APPROVER_TYPES, filter.awaitingApprovalBy);
    }
    // Sent back, and not yet resubmitted. The audit log is the record of who did
    // what, so it is also where "what happened to this page last" is asked —
    // `store.lastSubmission` reads it for the same reason. The scalar subquery
    // takes the most recent event from the workflow's own vocabulary and asks
    // whether it was the send-back; anything the author has done since (a
    // resubmission, a withdrawal, a direct publish) displaces it, and the page
    // leaves this list without anybody having to remember to clear a flag.
    if (filter.sentBackTo) {
      // Not only Draft: a Canonical page whose draft was refused keeps its
      // standing on the way out of review (store.ts, statusAfterReview), and
      // the work returned to its author is no less returned for that. The
      // last-act subquery still decides — an approval or a publish displaces
      // the send-back on any status.
      clauses.push(
        `(p.status IN ('draft', 'canonical', 'needs_update')
          AND EXISTS (SELECT 1 FROM drafts d WHERE d.page_id = p.id AND d.editor_id = ?)
          AND (SELECT a.action FROM audit_events a
                WHERE a.page_id = p.id
                  AND a.action IN (${placeholders(WORKFLOW_ACTIONS.length)})
                ORDER BY a.id DESC LIMIT 1) = 'page.send_back')`,
      );
      params.push(filter.sentBackTo, ...WORKFLOW_ACTIONS);
    }
    // The page lock, read as a filter. `editDraft` refuses a draft somebody else
    // holds, so "the draft on this page is mine" and "this page is mine to
    // finish" are the same sentence.
    if (filter.draftHeldBy) {
      clauses.push('EXISTS (SELECT 1 FROM drafts d WHERE d.page_id = p.id AND d.editor_id = ?)');
      params.push(filter.draftHeldBy);
    }
    if (filter.hasOwner === true) clauses.push('p.owner_id IS NOT NULL');
    if (filter.hasOwner === false) clauses.push('p.owner_id IS NULL');
    if (filter.hasReviewDate === true) clauses.push('p.review_date IS NOT NULL');
    if (filter.hasReviewDate === false) clauses.push('p.review_date IS NULL');
    if (filter.hasEffectiveDate === true) clauses.push('p.effective_date IS NOT NULL');
    if (filter.hasEffectiveDate === false) clauses.push('p.effective_date IS NULL');
    if (filter.hasEffectiveDateBasis === true) clauses.push('p.effective_date_basis IS NOT NULL');
    if (filter.hasEffectiveDateBasis === false) clauses.push('p.effective_date_basis IS NULL');
    // Backdating, in SQL, against the same anchor `recordAnchorDate` uses in
    // TypeScript: the day version 1 was published, or the day the page was
    // created when nothing has been. Both are already in the join.
    if (filter.backdated === true) {
      clauses.push('(p.effective_date IS NOT NULL AND p.effective_date < substr(COALESCE(v1.created_at, p.created_at), 1, 10))');
    }
    if (filter.backdated === false) {
      clauses.push('(p.effective_date IS NULL OR p.effective_date >= substr(COALESCE(v1.created_at, p.created_at), 1, 10))');
    }
    if (filter.reviewDateBefore) {
      clauses.push('p.review_date IS NOT NULL AND p.review_date < ?');
      params.push(filter.reviewDateBefore);
    }
    if (filter.reviewDateAfter) {
      clauses.push('p.review_date IS NOT NULL AND p.review_date > ?');
      params.push(filter.reviewDateAfter);
    }
    if (filter.updatedBefore) {
      clauses.push('COALESCE(v.created_at, p.created_at) < ?');
      params.push(filter.updatedBefore);
    }
    if (filter.updatedAfter) {
      clauses.push('COALESCE(v.created_at, p.created_at) > ?');
      params.push(filter.updatedAfter);
    }
    if (filter.createdBefore) {
      clauses.push('p.created_at < ?');
      params.push(filter.createdBefore);
    }
    if (filter.createdAfter) {
      clauses.push('p.created_at > ?');
      params.push(filter.createdAfter);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
    const order = orderBy(filter.sort ?? 'updatedAt', filter.direction ?? 'desc');

    const rows = this.db
      .prepare(
        `SELECT p.id, p.collection_id, p.parent_id, p.type, p.title, p.status, p.owner_id, p.approver_id,
                p.effective_date, p.effective_date_basis, p.review_date, p.current_version, p.created_at,
                COALESCE(v.created_at, p.created_at) AS updated_at,
                v1.created_at AS first_published_at
           FROM pages p
           JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
           LEFT JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
           LEFT JOIN page_versions v1 ON v1.page_id = p.id AND v1.number = 1
           ${where}
           ${order}
           LIMIT ${limit}`,
      )
      .all(...params) as Record<string, unknown>[];

    const on = today();
    return rows.map((r) => {
      const effectiveDate = (r.effective_date as string) ?? null;
      const basis = (r.effective_date_basis as string) ?? null;
      const firstPublishedAt = (r.first_published_at as string) ?? null;
      const backdated = isBackdated(effectiveDate, recordAnchorDate(r.created_at as string, firstPublishedAt));
      return {
        pageId: r.id as string,
        collectionId: r.collection_id as string,
        parentId: (r.parent_id as string) ?? null,
        type: r.type as DocType,
        title: r.title as string,
        status: r.status as PageStatus,
        ownerId: (r.owner_id as string) ?? null,
        approverId: (r.approver_id as string) ?? null,
        effectiveDate,
        effectiveDateBasis: basis,
        reviewDate: (r.review_date as string) ?? null,
        currentVersion: (r.current_version as number) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
        firstPublishedAt,
        pastReview: isPastReview((r.review_date as string) ?? null, on),
        backdated,
        backdatedWithoutBasis: backdated && !basis,
        notYetInForce: isNotYetInForce(effectiveDate, on),
      };
    });
  }

  // ---- saved queries ---------------------------------------------------

  /**
   * Save a filter under a name. Owned by its creator: only they list it, read
   * it, or delete it. A named collection the creator cannot see is refused here
   * rather than silently dropped at run time, so a saved query means what its
   * author thinks it means.
   */
  save(actorId: string, input: { name: string; query?: PageQuery }): SavedQuery {
    const actor = this.host.getActor(actorId);
    const name = input?.name?.trim();
    if (!name) throw new CanonError('invalid', 'A saved query requires a name');
    const query = validateQuery(input.query ?? {});
    for (const collectionId of query.collectionIds ?? []) this.requireRole(actorId, collectionId, 'view');

    const id = randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO saved_queries (id, name, filter_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, JSON.stringify(query), actorId, at, at);
    this.audit(actor, 'query.save', { details: { queryId: id, name } });
    return this.get(actorId, id);
  }

  list(actorId: string): SavedQuery[] {
    this.host.getActor(actorId);
    const rows = this.db
      .prepare('SELECT * FROM saved_queries WHERE created_by = ? ORDER BY created_at, id')
      .all(actorId) as Record<string, unknown>[];
    return rows.map((r) => toSavedQuery(r));
  }

  get(actorId: string, id: string): SavedQuery {
    this.host.getActor(actorId);
    const row = this.db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such saved query: ${id}`);
    if ((row.created_by as string) !== actorId) {
      throw new CanonError('forbidden', 'A saved query belongs to the actor who saved it');
    }
    return toSavedQuery(row);
  }

  remove(actorId: string, id: string): void {
    const actor = this.host.getActor(actorId);
    const saved = this.get(actorId, id); // ownership, and not_found, in one place
    this.db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
    this.audit(actor, 'query.delete', { details: { queryId: id, name: saved.name } });
  }

  /** Run a stored filter. Ownership is checked exactly as `get` checks it. */
  runSaved(actorId: string, id: string, overrides: Partial<PageQuery> = {}): QueryResultPage[] {
    const saved = this.get(actorId, id);
    return this.run(actorId, { ...saved.query, ...overrides });
  }

  // ---- record health ---------------------------------------------------

  /**
   * The health of one collection, measured rather than guessed (FEATURES.md §8),
   * and built on the query surface above rather than beside it — one scan of the
   * collection's non-archived pages, with every count derived from it. Reading
   * health needs `view`: it is a read of the record, so it is classified `read`
   * for agents too.
   */
  health(
    actorId: string,
    collectionId: string,
    options: { staleDraftDays?: number; on?: string } = {},
  ): CollectionHealth {
    this.host.getActor(actorId);
    this.requireRole(actorId, collectionId, 'view');
    const on = options.on ?? today();
    if (!isIsoDate(on)) throw new CanonError('invalid', `A health date is an ISO date (YYYY-MM-DD), not '${on}'`);
    const staleDraftDays = Math.min(Math.max(Math.trunc(options.staleDraftDays ?? DEFAULT_STALE_DRAFT_DAYS), 0), 3650);

    const pages = this.run(actorId, { collectionIds: [collectionId], limit: HEALTH_SCAN_LIMIT, sort: 'createdAt', direction: 'asc' });

    // The collection home. The record has no `homePageId` field yet, so the home
    // is read off the tree the way a reader would: the first root page created
    // in the collection. Every OTHER parentless page is the orphan FEATURES.md
    // §8 means — knowledge sitting outside the tree, reachable only by search.
    const home = pages.find((p) => p.parentId === null)?.pageId ?? null;

    // Which types owe the record an owner is TYPE_RULES' business, not a list
    // hard-coded here: an unowned Note is not a health problem, because a Note
    // was never asked for an owner.
    const owed = new Set(DOC_TYPES.filter((t) => TYPE_RULES[t].requiresOwner));
    // The same reading for the effective date: which types owe the record one is
    // TYPE_RULES' answer, not a list written here. A Spec with no effective date
    // is not a finding, because a Spec was never asked for one.
    const owedEffective = new Set(DOC_TYPES.filter((t) => TYPE_RULES[t].requiresEffectiveDate));
    const staleBefore = new Date(Date.parse(`${on}T00:00:00.000Z`) - staleDraftDays * 86_400_000).toISOString();

    let pastReview = 0;
    let needsUpdate = 0;
    let withoutOwner = 0;
    let orphaned = 0;
    let staleDrafts = 0;
    let canonicalWithoutEffectiveDate = 0;
    let backdatedEffectiveDate = 0;
    let backdatedWithoutBasis = 0;
    let notYetInForce = 0;
    for (const page of pages) {
      if (isPastReview(page.reviewDate, on)) pastReview += 1;
      if (page.status === 'needs_update') needsUpdate += 1;
      if (owed.has(page.type) && !page.ownerId) withoutOwner += 1;
      if (page.parentId === null && page.pageId !== home) orphaned += 1;
      if (page.status === 'draft' && page.updatedAt < staleBefore) staleDrafts += 1;
      // `needs_update` counts alongside `canonical`: a page the freshness sweep
      // flipped held the mark and can still be cited (freshness.ts says so in
      // the notification it sends), so it is still a page a regulator may be
      // handed. A draft that has never been published is not.
      const heldTheMark = page.status === 'canonical' || page.status === 'needs_update';
      if (heldTheMark && owedEffective.has(page.type) && !page.effectiveDate) canonicalWithoutEffectiveDate += 1;
      if (page.backdated) backdatedEffectiveDate += 1;
      if (page.backdatedWithoutBasis) backdatedWithoutBasis += 1;
      // Recomputed against `on` rather than read off the row, exactly as
      // `pastReview` is: the row judged "in force" against today, and a health
      // summary asked about another day must answer about that day.
      if (isNotYetInForce(page.effectiveDate, on)) notYetInForce += 1;
    }

    // Concentration of duty, over its own population and its own SELECT.
    //
    // It is not derived from the `pages` scan above, and the reason is the
    // whole point of the view: that scan carries `approverId`, which is
    // `pages.approver_id` — the person NAMED to approve — and the question here
    // is who actually GRANTED the mark. The two are the same person on a Policy
    // or a Spec, because `approve` enforces it; on a Plan the column is null
    // while somebody plainly did grant it. Reading the column would have
    // reported a collection's Plans as approved by nobody.
    //
    // Group NAMES follow the reader: an operator can already ask
    // `explainAccess` for anybody's, and nobody else can, so this surface does
    // not widen that. The withholding is declared in the report itself.
    const marked = marksStandingIn(this.db, actorId, collectionId, HEALTH_SCAN_LIMIT);
    const approvalConcentration = concentrationOfDuty({
      db: this.db,
      actorId,
      collectionId,
      at: on,
      pages: marked,
      population:
        `The ${marked.length} page(s) in this collection holding the Canonical mark today — Canonical, plus the ` +
        'pages the freshness sweep has flipped to Needs Update, which held the mark and can still be cited. ' +
        'Archived pages and pages that have never published are not in it.',
      namesGroups: isOrgOperator(this.db, actorId),
      truncated: marked.length >= HEALTH_SCAN_LIMIT,
    });

    return {
      collectionId,
      at: on,
      pages: pages.length,
      pastReview,
      needsUpdate,
      withoutOwner,
      orphaned,
      staleDrafts,
      staleDraftDays,
      canonicalWithoutEffectiveDate,
      backdatedEffectiveDate,
      backdatedWithoutBasis,
      notYetInForce,
      approvalConcentration,
      truncated: pages.length >= HEALTH_SCAN_LIMIT,
    };
  }

  // ---- internals -------------------------------------------------------

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      // One sentence, built in abilities.ts, and the same one the screen shows
      // before the click (USER-TESTING.md T4.4, second round).
      throw forbiddenRole(this.db, collectionId, role, needed);
    }
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
        nowIso(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}

// ---- validation ---------------------------------------------------------
//
// Everything a query can say is checked here, before any SQL exists. A member
// naming an unknown type, status, or sort is an `invalid` refusal rather than a
// silently empty result: a dashboard showing nothing because of a typo is a
// worse lie than an error message.

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

const ORDER_COLUMN: Record<QuerySort, string> = {
  reviewDate: 'p.review_date',
  updatedAt: 'updated_at',
  createdAt: 'p.created_at',
  title: 'p.title',
  status: 'p.status',
};

function orderBy(sort: QuerySort, direction: QueryDirection): string {
  const column = ORDER_COLUMN[sort];
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  // NULLs last whichever way the sort runs: a page with no review date is not
  // the most urgent thing in a review-date list, in either direction.
  return `ORDER BY (${column} IS NULL), ${column} ${dir}, p.id ASC`;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new CanonError('invalid', `${field} takes ids as strings`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : undefined;
}

/** One actor id, for the members that name a person rather than a set of them. */
function actorish(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new CanonError('invalid', `${field} takes one actor id`);
  return value;
}

function dateish(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new CanonError('invalid', `${field} takes an ISO date`);
  if (isIsoDate(value)) return value;
  // A full timestamp is accepted for the updated/created windows, where the
  // record stores instants; anything else is refused rather than guessed at.
  if (!Number.isNaN(Date.parse(value))) return value;
  throw new CanonError('invalid', `${field} takes an ISO date (YYYY-MM-DD), not '${value}'`);
}

function boolish(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new CanonError('invalid', `${field} takes true or false`);
  return value;
}

/** Validate and normalise a filter. Exported so a saved query is stored clean. */
export function validateQuery(raw: PageQuery): PageQuery {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CanonError('invalid', 'A query is an object of filters');
  }
  const query: PageQuery = {};

  const collectionIds = stringList(raw.collectionIds, 'collectionIds');
  if (collectionIds) query.collectionIds = collectionIds;

  const types = stringList(raw.types, 'types');
  if (types) {
    for (const type of types) {
      if (!DOC_TYPES.includes(type as DocType)) throw new CanonError('invalid', `Unknown document type: ${type}`);
    }
    query.types = types as DocType[];
  }

  const statuses = stringList(raw.statuses, 'statuses');
  if (statuses) {
    for (const status of statuses) {
      if (!PAGE_STATUSES.includes(status as PageStatus)) {
        throw new CanonError('invalid', `Unknown page status: ${status}`);
      }
    }
    query.statuses = statuses as PageStatus[];
  }

  const ownerIds = stringList(raw.ownerIds, 'ownerIds');
  if (ownerIds) query.ownerIds = ownerIds;
  const approverIds = stringList(raw.approverIds, 'approverIds');
  if (approverIds) query.approverIds = approverIds;

  const awaitingApprovalBy = actorish(raw.awaitingApprovalBy, 'awaitingApprovalBy');
  if (awaitingApprovalBy) query.awaitingApprovalBy = awaitingApprovalBy;
  const sentBackTo = actorish(raw.sentBackTo, 'sentBackTo');
  if (sentBackTo) query.sentBackTo = sentBackTo;
  const draftHeldBy = actorish(raw.draftHeldBy, 'draftHeldBy');
  if (draftHeldBy) query.draftHeldBy = draftHeldBy;

  const hasOwner = boolish(raw.hasOwner, 'hasOwner');
  if (hasOwner !== undefined) query.hasOwner = hasOwner;
  const hasReviewDate = boolish(raw.hasReviewDate, 'hasReviewDate');
  if (hasReviewDate !== undefined) query.hasReviewDate = hasReviewDate;
  const hasEffectiveDate = boolish(raw.hasEffectiveDate, 'hasEffectiveDate');
  if (hasEffectiveDate !== undefined) query.hasEffectiveDate = hasEffectiveDate;
  const hasEffectiveDateBasis = boolish(raw.hasEffectiveDateBasis, 'hasEffectiveDateBasis');
  if (hasEffectiveDateBasis !== undefined) query.hasEffectiveDateBasis = hasEffectiveDateBasis;
  const backdated = boolish(raw.backdated, 'backdated');
  if (backdated !== undefined) query.backdated = backdated;

  for (const field of ['reviewDateBefore', 'reviewDateAfter', 'updatedBefore', 'updatedAfter', 'createdBefore', 'createdAfter'] as const) {
    const value = dateish(raw[field], field);
    if (value !== undefined) query[field] = value;
  }

  if (raw.sort !== undefined && raw.sort !== null) {
    if (!SORTS.includes(raw.sort)) throw new CanonError('invalid', `Unknown sort: ${String(raw.sort)}`);
    query.sort = raw.sort;
  }
  if (raw.direction !== undefined && raw.direction !== null) {
    if (raw.direction !== 'asc' && raw.direction !== 'desc') {
      throw new CanonError('invalid', `Unknown sort direction: ${String(raw.direction)}`);
    }
    query.direction = raw.direction;
  }
  if (raw.limit !== undefined && raw.limit !== null) {
    const limit = Number(raw.limit);
    if (!Number.isFinite(limit) || limit < 1) throw new CanonError('invalid', 'limit is a positive number');
    query.limit = Math.min(Math.trunc(limit), MAX_QUERY_LIMIT);
  }
  return query;
}

function toSavedQuery(row: Record<string, unknown>): SavedQuery {
  return {
    id: row.id as string,
    name: row.name as string,
    query: JSON.parse(row.filter_json as string) as PageQuery,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
