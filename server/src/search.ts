import type { DatabaseSync } from 'node:sqlite';
import { CanonError, DocType, DOC_TYPES, PageStatus } from './model.js';

// Full-text search over the PUBLISHED record (CORE-PLAN.md Epic A scope,
// FEATURES.md "Search"). The index is a derived structure per
// DATA-BACKBONE.md §2: rebuildable from pages and page_versions, never
// authoritative, and held apart from the record and its history — which is
// why its schema lives here and not in db.ts. Only published content is
// indexed: readers search the record, never work in progress, so drafts
// stay out entirely and archived pages leave search.
const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
  page_id UNINDEXED,
  title,
  body
);
`;

const PAGE_STATUSES: readonly PageStatus[] = ['draft', 'in_review', 'canonical', 'needs_update', 'archived'];

// Ranking by standing, before relevance. Canonical first, because official
// means something. Needs Update SECOND rather than last: a page past its review
// date is still the record's own answer — it was approved, it has an owner, and
// nothing has replaced it — so burying it under drafts would send a searcher to
// working notes instead of to the official page that needs attention. It ranks
// below Canonical because the flag is real, and above everything unreviewed
// because it earned the mark and has only grown old.
const STATUS_RANK = `CASE p.status WHEN 'canonical' THEN 0 WHEN 'needs_update' THEN 1 ELSE 2 END`;

export interface SearchResult {
  pageId: string;
  title: string;
  collectionId: string;
  type: DocType;
  status: PageStatus;
  ownerId: string | null;
  snippet: string;
}

export interface SearchFilter {
  q: string;
  collectionId?: string;
  type?: string;
  status?: string;
  /**
   * Several statuses at once, AND-ed with nothing and OR-ed among themselves.
   * The single `status` above stays the query-string surface people use; this
   * exists for callers that mean a set — retrieval asks for the material
   * answers may cite, which is Canonical *and* Needs Update (see answers.ts).
   */
  statuses?: readonly string[];
  ownerId?: string;
  limit?: number;
  // The two narrowings the Knowledge API adds (STUDIO-CONTRACT.md §4). Both
  // are optional, both only ever narrow, and both are applied in the SQL that
  // already filters by `actorId`'s permissions — so there is one permission
  // filter here, extended, rather than a second one somewhere else.
  /** A second actor who must also be able to see a result for it to be returned. */
  alsoVisibleTo?: string;
  /** An allow-list of collection ids; absent means no such bound. */
  collectionIds?: string[];
}

export class SearchIndex {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SEARCH_SCHEMA);
  }

  // Re-derives one page's index entry from the record. Called from the
  // store whenever the published state of a page changes: publish, approve,
  // restore (all through writeVersion) and archive. Idempotent: an archived
  // page or one with no published version simply leaves the index.
  indexPage(pageId: string): void {
    this.db.prepare('DELETE FROM page_search WHERE page_id = ?').run(pageId);
    const row = this.db
      .prepare(
        `SELECT v.title, v.body FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.id = ? AND p.status != 'archived'`,
      )
      .get(pageId) as { title: string; body: string } | undefined;
    if (!row) return;
    this.db
      .prepare('INSERT INTO page_search (page_id, title, body) VALUES (?, ?, ?)')
      .run(pageId, row.title, row.body);
  }

  // Drops and rebuilds the whole index from the record. The index is never
  // the source of truth; this proves it.
  rebuildIndex(): void {
    this.db.exec('DELETE FROM page_search');
    this.db
      .prepare(
        `INSERT INTO page_search (page_id, title, body)
         SELECT p.id, v.title, v.body FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.status != 'archived'`,
      )
      .run();
  }

  // Permission-filtered search: results come only from collections where
  // the searcher holds at least the view role — membership itself, since
  // view is the lowest rank and every role implies it. Ranked with
  // Canonical pages first (official means something), then FTS relevance.
  search(actorId: string, filter: SearchFilter): SearchResult[] {
    const actor = this.db.prepare('SELECT id FROM actors WHERE id = ?').get(actorId);
    if (!actor) throw new CanonError('not_found', `No such actor: ${actorId}`);

    const match = toMatchQuery(filter.q);
    if (!match) throw new CanonError('invalid', 'Search requires a query (q)');
    if (filter.type && !DOC_TYPES.includes(filter.type as DocType)) {
      throw new CanonError('invalid', `Unknown document type: ${filter.type}`);
    }
    if (filter.status && !PAGE_STATUSES.includes(filter.status as PageStatus)) {
      throw new CanonError('invalid', `Unknown page status: ${filter.status}`);
    }
    for (const status of filter.statuses ?? []) {
      if (!PAGE_STATUSES.includes(status as PageStatus)) {
        throw new CanonError('invalid', `Unknown page status: ${status}`);
      }
    }

    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.collectionId) {
      clauses.push('AND p.collection_id = ?');
      params.push(filter.collectionId);
    }
    if (filter.type) {
      clauses.push('AND p.type = ?');
      params.push(filter.type);
    }
    if (filter.status) {
      clauses.push('AND p.status = ?');
      params.push(filter.status);
    }
    if (filter.statuses?.length) {
      clauses.push(`AND p.status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    if (filter.ownerId) {
      clauses.push('AND p.owner_id = ?');
      params.push(filter.ownerId);
    }
    // An empty allow-list means exactly that — nothing is in scope — so it is
    // answered without a query rather than by an `IN ()` that SQLite would
    // read as "no constraint". Where the limits are silent, less, not more.
    if (filter.collectionIds) {
      if (filter.collectionIds.length === 0) return [];
      clauses.push(`AND p.collection_id IN (${filter.collectionIds.map(() => '?').join(', ')})`);
      params.push(...filter.collectionIds);
    }
    // The second reader, as a second membership join: a result must be visible
    // to both actors, decided in SQL before ranking rather than after it.
    const second = filter.alsoVisibleTo
      ? 'JOIN collection_members m2 ON m2.collection_id = p.collection_id AND m2.actor_id = ?'
      : '';
    // Bound, and bound as a parameter below rather than spliced into the SQL
    // as text: a caller reaching the index directly with a non-numeric limit
    // would otherwise write into the statement.
    const asked = Number(filter.limit ?? 25);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 100) : 25;

    const rows = this.db
      .prepare(
        `SELECT p.id, p.collection_id, p.type, p.status, p.owner_id, p.title,
                snippet(page_search, -1, '<mark>', '</mark>', '…', 12) AS snip
         FROM page_search
         JOIN pages p ON p.id = page_search.page_id
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
         ${second}
         WHERE page_search MATCH ? ${clauses.join(' ')}
         ORDER BY ${STATUS_RANK}, bm25(page_search)
         LIMIT ?`,
      )
      .all(actorId, ...(filter.alsoVisibleTo ? [filter.alsoVisibleTo] : []), match, ...params, limit) as Record<
        string,
        unknown
      >[];

    return rows.map((r) => ({
      pageId: r.id as string,
      title: r.title as string,
      collectionId: r.collection_id as string,
      type: r.type as DocType,
      status: r.status as PageStatus,
      ownerId: (r.owner_id as string) ?? null,
      snippet: r.snip as string,
    }));
  }
}

// Users type words, not FTS5 syntax. Each whitespace-separated term becomes
// a quoted phrase (all terms must match), so operators and punctuation in
// the input can never break or subvert the MATCH expression.
function toMatchQuery(q: string | undefined): string | null {
  const terms = (q ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(' ') : null;
}
