import type { DatabaseSync } from 'node:sqlite';
import { CanonError, DocType, DOC_TYPES, PageStatus } from './model.js';
import { indexableText } from './plaintext.js';

// Full-text search over the record (CORE-PLAN.md Epic A scope, FEATURES.md
// "Search"). The index is a derived structure per DATA-BACKBONE.md §2:
// rebuildable from pages and page_versions, never authoritative, and held
// apart from the record and its history — which is why its schema lives here
// and not in db.ts.
//
// WHAT IS INDEXED, AND WHY IT IS TWO DIFFERENT THINGS.
//
// A page's TITLE comes from `pages.title` — the row, not the version. A page's
// BODY comes from the published version and from nowhere else. That is not an
// inconsistency; it is the same rule applied to two fields that are visible in
// two different ways.
//
// The body of a draft is work in progress. Nobody but its editor has agreed to
// it, it can say anything, and readers must search the record rather than each
// other's half-finished sentences. It stays out.
//
// The title is not private in that sense and never was: it is drawn in the
// sidebar tree to every member of the collection, it is in the audit log, it
// is on the page's own header. A page whose title is on screen and unfindable
// by that title is a search index disagreeing with the product around it — and
// that is exactly what a new contributor hit (USER-TESTING.md T4.6, bug E):
// she wrote a page, submitted it for review, and could not find by name the
// thing she had written five minutes earlier, because a page in review has
// published no version and the index was built from published versions alone.
//
// So the index carries every non-archived page's title, and the body of those
// that have published one. Archived pages leave search entirely, because they
// have left the record. Permission filtering is unchanged and is where it has
// always been: the membership join in `search` below.
//
// HOW WORDS ARE CUT UP, AND WHY IT IS NOT THE DEFAULT.
//
// FTS5's default tokenizer matches whole words and nothing else, so a policy
// that says "records are RETAINED for seven years" is invisible to a question
// about "RETENTION", and one that says a claim "is DECIDED within thirty days"
// is invisible to "who DECIDES". That is not a subtle relevance problem; it is
// the page not existing. The Porter stemmer folds both ends of each of those
// pairs to a common stem, at both index and query time, so the question and
// the page meet.
//
// It is applied over unicode61 rather than instead of it, because Porter alone
// does not fold case or strip diacritics — it is a suffix stemmer, not a
// tokenizer. `remove_diacritics 2` is the modern form of that folding and the
// one a corpus with European names needs.
//
// The cost is honest and worth stating: stemming conflates words that are not
// the same. "Universal" and "universe" share a stem. In a policy corpus that
// trade is plainly worth making — the words people write about the same rule
// differ far more often by inflection than by anything else — but it does mean
// the index can no longer be used to prove a page contains a literal word.
// Nothing here does that; the record is the source of truth for what a page
// says, and this index is a derived structure that only ever suggests pages.
const TOKENIZER = 'porter unicode61 remove_diacritics 2';

const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
  page_id UNINDEXED,
  title,
  body,
  tokenize = '${TOKENIZER}'
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

// Relevance, once standing has spoken. bm25() takes one weight per column in
// declaration order — page_id, title, body — and returns a negative number, so
// ascending order is best-first and a larger weight pulls harder.
//
// A TITLE MATCH IS WORTH MORE THAN A BODY MATCH, and the default weighting says
// they are worth the same. That default is wrong here for a reason particular
// to this corpus rather than to search in general: the titles in a record are
// not headlines somebody wrote to attract a reader. They are the names of
// obligations — "Retention periods: vendor contracts", "Retention jobs and
// their schedule" — chosen by the person who owns the page to say what the page
// IS. A page whose title matches the question is usually the page about the
// question; a page whose body matches it is often merely a page that mentions
// it in passing, and in a policy corpus almost everything mentions almost
// everything in passing.
//
// The number is measured, not guessed. Swept against the labelled set in
// scripts/eval-retrieval.ts, primary@1 — how often the top page is the single
// best one — climbs from 70.7% at flat weights to 78.0% at 3, and then does not
// move again anywhere out to 20. Nothing gets worse at the top end either, and
// the reason is worth knowing rather than reading as a licence to turn it up:
// standing is sorted BEFORE relevance, and the pool is capped, so this weight
// only ever reorders pages that already share a status and already made the
// cut. It cannot pull a Draft above a Canonical page however large it is.
//
// 3 is taken as the low end of the plateau rather than a point inside it. The
// plateau is flat on THIS corpus; the smallest weight that reaches it is the
// least fitted to it.
//
// The page_id column is UNINDEXED and can never match, so its weight is zero to
// say so rather than to do anything.
const RELEVANCE = 'bm25(page_search, 0.0, 3.0, 1.0)';

// WHY THE ORDER BY DOES NOT STOP AT RELEVANCE.
//
// Two pages can score identically — in a policy corpus they routinely do, since
// half of it is written from the same handful of sentences — and SQL with no
// further key returns them in whatever order the query plan happens to produce.
// Here that order followed the join against `pages`, whose primary key is a
// UUID, so which of two equally-relevant pages came first depended on a random
// identifier. Two copies of the same record answered the same question with
// different top results, and neither was wrong.
//
// That is a defect in a product whose answers get cited in an audit file. So
// ties fall to the title, then to the id: the title because it is content —
// somebody wrote it, a reader can see it, and the resulting order is the one
// they could predict — and the id last, only to guarantee a total order. This
// is not a claim that alphabetical is more relevant. Among genuine ties there
// is no relevance judgement left to make; what remains to decide is whether the
// same record answers the same question the same way twice, and it should.

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
    // An index built by an earlier version of this file was cut up by a
    // different tokenizer, and `CREATE VIRTUAL TABLE IF NOT EXISTS` leaves it
    // exactly as it was — so a record that already exists would keep answering
    // with the old rules for ever, and nothing would say so.
    //
    // This is not a migration and deliberately does not go in db.ts. The
    // migrations there are append-only changes to the RECORD, which is
    // authoritative and must never be rebuilt. This table is a derived
    // structure: the honest repair for "it was built wrong" is to throw it away
    // and derive it again from the pages, which costs a query per page once, at
    // open, and cannot lose anything that was not already recoverable.
    if (!this.tokenizerMatches()) {
      this.db.exec('DROP TABLE page_search');
      this.db.exec(SEARCH_SCHEMA);
      this.rebuildIndex();
    }
  }

  private tokenizerMatches(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_search'")
      .get() as { sql: string | null } | undefined;
    return (row?.sql ?? '').includes(TOKENIZER);
  }

  /**
   * How many indexed pages contain each term, and how many there are in total.
   *
   * This is the corpus statistic a relevance judgement needs and did not have.
   * `isOnTopic` counted how many of a question's words a passage covered and
   * treated them all alike, so "Who approves a change to a Policy?" was
   * satisfied by any page carrying "change" and "policy" — two of the commonest
   * words in a policy corpus — and three unrelated pages were presented under
   * "The record says:". A word that appears on most pages cannot tell one page
   * from another, and the record already knows which words those are.
   *
   * Counted over the whole index rather than per asker, and deliberately so:
   * this is a property of the language in the corpus, not of anybody's
   * permissions, and it is used only to WEIGH terms the asker already typed.
   * It reveals nothing about which pages exist — no title, no id, no count of
   * anything a reader could not already learn from a dictionary.
   */
  documentFrequency(terms: readonly string[]): { total: number; df: Map<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM page_search').get() as { n: number }).n;
    const df = new Map<string, number>();
    for (const term of new Set(terms)) {
      // A bare term against FTS5, quoted so a stray operator in somebody's
      // question cannot become syntax.
      const quoted = `"${term.replace(/"/g, '""')}"`;
      try {
        const row = this.db
          .prepare('SELECT COUNT(*) AS n FROM page_search WHERE page_search MATCH ?')
          .get(quoted) as { n: number };
        df.set(term, row.n);
      } catch {
        // An unindexable term (punctuation, a stopword FTS5 drops) tells us
        // nothing; treating it as present everywhere gives it no weight, which
        // is the safe direction.
        df.set(term, total);
      }
    }
    return { total, df };
  }

  // Re-derives one page's index entry from the record. Called from the store
  // whenever a page appears (create) or its published state changes: publish,
  // approve, restore (all through writeVersion) and archive. Idempotent: an
  // archived page simply leaves the index, and one with no published version
  // is carried by its title with an empty body.
  indexPage(pageId: string): void {
    this.db.prepare('DELETE FROM page_search WHERE page_id = ?').run(pageId);
    const row = this.db
      .prepare(
        // LEFT JOIN, and the title off `pages`: a page in review has published
        // nothing, and is still a page somebody can see in the tree and must
        // be able to find by name.
        `SELECT p.title AS title, COALESCE(v.body, '') AS body FROM pages p
         LEFT JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.id = ? AND p.status != 'archived'`,
      )
      .get(pageId) as { title: string; body: string } | undefined;
    if (!row) return;
    this.insert.run(pageId, row.title, indexableText(row.body));
  }

  // Drops and rebuilds the whole index from the record. The index is never
  // the source of truth; this proves it.
  rebuildIndex(): void {
    this.db.exec('DELETE FROM page_search');
    const rows = this.db
      .prepare(
        `SELECT p.id AS id, p.title AS title, COALESCE(v.body, '') AS body FROM pages p
         LEFT JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.status != 'archived'`,
      )
      .all() as { id: string; title: string; body: string }[];
    for (const row of rows) this.insert.run(row.id, row.title, indexableText(row.body));
  }

  private get insert() {
    return this.db.prepare('INSERT INTO page_search (page_id, title, body) VALUES (?, ?, ?)');
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
         ORDER BY ${STATUS_RANK}, ${RELEVANCE}, p.title, p.id
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
