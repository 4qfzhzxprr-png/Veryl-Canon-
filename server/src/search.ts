import type { DatabaseSync } from 'node:sqlite';
import { CanonError, DocType, DOC_TYPES, PageStatus, revisionUnderReviewStanding } from './model.js';
import { indexableText } from './plaintext.js';
import { SupersededBy, supersessionMarks } from './supersession.js';

/** The stored JSON list of aliases, as the text the index holds for them. */
function aliasText(aliasesJson: string): string {
  try {
    const parsed = JSON.parse(aliasesJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === 'string').join('. ') : '';
  } catch {
    return '';
  }
}

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
  aliases,
  tokenize = '${TOKENIZER}'
);
-- The index's own vocabulary: every distinct token it holds, with how many
-- rows carry it. FTS5 maintains it; it stores nothing of its own. It is what
-- suggest() below reads to answer "did you mean", and it is a view of the
-- terms, never of the pages -- see suggest() for what stops it becoming an
-- oracle for material the asker may not read.
CREATE VIRTUAL TABLE IF NOT EXISTS page_search_vocab USING fts5vocab(page_search, 'row');
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
// Aliases weigh what the title weighs, for the same reason the title weighs
// what it does: both are names somebody chose for what the page IS. An alias
// exists precisely so a question asked in that word lands on this page.
const RELEVANCE = 'bm25(page_search, 0.0, 3.0, 1.0, 3.0)';

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
  /**
   * The page's own standing when a revision is in review over a still-marked
   * version, so a result shows CANONICAL with the revision noted rather than the
   * draft's IN REVIEW. Null when `status` tells the whole story. See
   * `revisionUnderReviewStanding`.
   */
  pageStanding: PageStatus | null;
  ownerId: string | null;
  snippet: string;
  /**
   * What the record says replaces this page, or null. A status chip alone said
   * DRAFT over a page the record had already moved on from, to the reader who
   * had not opened it yet — which is the surface a reader most often arrives
   * through (REMEDIATION-PLAN.md 1.6). Withheld rather than absent when the
   * replacement sits in a collection this asker holds no role in: see
   * supersession.ts for why existence is disclosed and identity is not.
   */
  supersededBy: SupersededBy | null;
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
  /**
   * Widens `statuses` by one derived case: a page In Review that is still
   * serving the version that last received the Canonical mark. It cannot be a
   * status in the list because it is not a status — it is a comparison of two
   * columns on the row — and retrieval's answerability rule needs it in the
   * SQL that builds the pool, not after. The argument for the rule lives with
   * ANSWERABLE_STATUSES in retrieval.ts, which is this flag's one caller.
   */
  markServingInReview?: boolean;
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
  /**
   * Match the LAST term as a prefix, for a box somebody is still typing in.
   * Off by default and on only for the interactive search surface — see
   * toMatchQuery for why the last term and no other, and see below for why
   * retrieval does not get it.
   *
   * Retrieval (answers.ts, retrieval.ts) deliberately does NOT set this. It is
   * handed a finished question, not a half-typed word, and its pool selection
   * is measured against a labelled set (scripts/eval-retrieval.ts). Widening
   * what an answer may be grounded in is a change to what Canon will state as
   * fact, and it does not get made as a side effect of fixing a search box.
   */
  prefix?: boolean;
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
    const sql = row?.sql ?? '';
    // The tokenizer AND the column set: an index built before aliases existed
    // parses fine and quietly cannot hold them, which is the same wrongness as
    // an old tokenizer and gets the same repair — drop and re-derive.
    return sql.includes(TOKENIZER) && sql.includes('aliases');
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
        `SELECT p.title AS title, COALESCE(v.body, '') AS body,
                COALESCE(json_extract(v.fields_json, '$.aliases'), '[]') AS aliases
         FROM pages p
         LEFT JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.id = ? AND p.status != 'archived'`,
      )
      .get(pageId) as { title: string; body: string; aliases: string } | undefined;
    if (!row) return;
    this.insert.run(pageId, row.title, indexableText(row.body), aliasText(row.aliases));
  }

  // Drops and rebuilds the whole index from the record. The index is never
  // the source of truth; this proves it.
  rebuildIndex(): void {
    this.db.exec('DELETE FROM page_search');
    const rows = this.db
      .prepare(
        `SELECT p.id AS id, p.title AS title, COALESCE(v.body, '') AS body,
                COALESCE(json_extract(v.fields_json, '$.aliases'), '[]') AS aliases
         FROM pages p
         LEFT JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.status != 'archived'`,
      )
      .all() as { id: string; title: string; body: string; aliases: string }[];
    for (const row of rows) this.insert.run(row.id, row.title, indexableText(row.body), aliasText(row.aliases));
  }

  /**
   * The indexed words of these pages — the page's prose, with its Markdown and
   * its link targets already gone (plaintext.ts). The same text `search`
   * matches against, which is the point: a judgement about whether a page is
   * about a question should be made on the same words that decided it was a
   * candidate.
   *
   * NO PERMISSION FILTER, deliberately, and it takes page ids the caller has
   * ALREADY had through a permission-filtered query. There is one permission
   * gate in this file, in `search`, and a second one here would be a second
   * thing to keep right. The one caller (answers.ts) passes ids that came out
   * of retrieval, which filters in SQL before anything is ranked.
   */
  indexedText(pageIds: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (pageIds.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT page_id, body, aliases FROM page_search WHERE page_id IN (${pageIds.map(() => '?').join(', ')})`,
      )
      .all(...pageIds) as Record<string, unknown>[];
    // Aliases ride with the body so the topical gate reads them: a page
    // aliased "urgent claims" COVERS "urgent", which is the entire point —
    // teaching the record a word is what turns a refusal into an answer.
    for (const row of rows) {
      const aliases = (row.aliases as string) ?? '';
      out.set(row.page_id as string, aliases ? `${aliases} ${row.body as string}` : (row.body as string));
    }
    return out;
  }

  /**
   * "Did you mean …" — the one alternative query that would actually have
   * found something, or null.
   *
   * Canon had no typo tolerance of any kind: one letter wrong and the answer
   * was "Nothing you can see matches", which reads as a statement about the
   * record rather than about the spelling (round seven). It is also how a
   * stemmed prefix fails — see toMatchQuery — so both are answered here.
   *
   * THREE RULES, and the second and third are the load-bearing ones.
   *
   * 1. IT SUGGESTS, IT NEVER SUBSTITUTES. The results shown are always the
   *    results for what was typed. A search box that quietly answers a
   *    different question than the one asked is the same failure as a record
   *    that quietly corrects what somebody wrote: it is convenient, and it
   *    means the reader can no longer trust that what they see is what they
   *    asked for. The caller renders this as an offer with the original still
   *    on screen.
   *
   * 2. A SUGGESTION IS ONLY EVER MADE WHEN IT WOULD FIND SOMETHING THIS ASKER
   *    CAN SEE. The vocabulary table is corpus-wide and unfiltered — it has to
   *    be, it is a property of the index — so offering a word straight out of
   *    it would leak the existence of terms that appear only in collections the
   *    asker holds no role in. Type "zeph", get back "did you mean zephyrus",
   *    and you have learned a codename by guessing at it, one letter at a time.
   *    That is precisely the oracle the record's disclosure rule refuses
   *    (REMEDIATION-PLAN.md, policy question 1: existence is disclosed where
   *    the record states a relationship to a page you HOLD, never in answer to
   *    an arbitrary term anybody can type). So every candidate is run through
   *    the ordinary permission-filtered `search` before it is offered, and only
   *    a candidate that returns a page the asker could have found by typing it
   *    themselves survives. The suggestion discloses nothing new by
   *    construction.
   *
   * 3. IT COSTS AT MOST A HANDFUL OF QUERIES. Candidates are drawn from the
   *    vocabulary by document frequency and capped; each verification is a
   *    LIMIT 1 search. A query that already finds something is answered `null`
   *    before any of that happens — nothing second-guesses a search that
   *    worked.
   *
   * WHAT IT OFFERS IS A STEM, and that is a wart worth naming rather than
   * hiding. The vocabulary of an FTS5 index tokenized with Porter holds
   * `retent`, not `retention`, so a suggestion for a mistyped "retention"
   * reads "did you mean retent". It is the word the index actually holds, it
   * finds the right pages when it is taken, and the alternative is a second
   * unstemmed vocabulary carried for the sake of the spelling of a hint.
   */
  suggest(actorId: string, filter: SearchFilter): string | null {
    // Mirrors what the caller did before asking: the interactive surface
    // searches with prefix matching on, so "already found something" has to
    // mean the same thing here or a working query gets a pointless hint.
    if (this.search(actorId, { ...filter, prefix: true, limit: 1 }).length > 0) return null;
    const terms = (filter.q ?? '')
      .split(/\s+/)
      .map((t) => t.replace(/"/g, '').toLowerCase())
      .filter((t) => t.length > 0);
    if (!terms.length || terms.length > 6) return null;

    // Longest term first: it carries the most meaning, and it is the one a
    // misspelling does the most damage to.
    const order = terms.map((t, i) => ({ t, i })).sort((a, b) => b.t.length - a.t.length);
    for (const { t, i } of order) {
      if (t.length < 3) continue;
      for (const candidate of this.nearTerms(t)) {
        const alt = terms.slice();
        alt[i] = candidate;
        const q = alt.join(' ');
        if (q === filter.q) continue;
        // The real search, with the real permission filter. A candidate that
        // shows this asker nothing is not offered — see rule 2.
        if (this.search(actorId, { ...filter, q, prefix: false, limit: 1 }).length > 0) return q;
      }
    }
    return null;
  }

  /**
   * Vocabulary terms that are plausibly the word somebody meant. Three shapes,
   * because three different things go wrong:
   *
   *   * the vocabulary term starts with what was typed — an unfinished word
   *     that the stemmer put out of reach of a prefix query;
   *   * what was typed starts with the vocabulary term — typing PAST the stem,
   *     the failure toMatchQuery documents;
   *   * a small edit distance — an ordinary typo. Measured against the typed
   *     word cut to the vocabulary term's length, because the vocabulary holds
   *     STEMS: "retentoin" is three edits from `retent` as whole words and one
   *     edit from it as far as `retent` goes, and the second number is the one
   *     that describes what went wrong.
   *
   * Ordered by how many pages hold the term, because the commonest word in the
   * record is the likeliest thing a reader was reaching for, and capped.
   */
  private nearTerms(term: string): string[] {
    const max = slack(term);
    // A cheap SQL narrowing before any distance is computed: nothing more than
    // two characters different in length can be within two edits, and the
    // vocabulary of a real record is large.
    const rows = this.db
      .prepare(
        `SELECT term, doc FROM page_search_vocab
         WHERE length(term) BETWEEN ? AND ?
         ORDER BY doc DESC LIMIT 4000`,
      )
      .all(Math.max(2, term.length - 4), term.length + max) as { term: string; doc: number }[];
    const near: string[] = [];
    for (const row of rows) {
      if (row.term === term) continue;
      const head = term.slice(0, Math.min(term.length, row.term.length + max));
      if (
        row.term.startsWith(term) ||
        term.startsWith(row.term) ||
        (max > 0 && editDistance(head, row.term, max) <= max)
      ) {
        near.push(row.term);
        if (near.length >= 6) break;
      }
    }
    return near;
  }

  private get insert() {
    return this.db.prepare('INSERT INTO page_search (page_id, title, body, aliases) VALUES (?, ?, ?, ?)');
  }

  // Permission-filtered search: results come only from collections where
  // the searcher holds at least the view role — membership itself, since
  // view is the lowest rank and every role implies it. Ranked with
  // Canonical pages first (official means something), then FTS relevance.
  search(actorId: string, filter: SearchFilter): SearchResult[] {
    const actor = this.db.prepare('SELECT id FROM actors WHERE id = ?').get(actorId);
    if (!actor) throw new CanonError('not_found', `No such actor: ${actorId}`);

    const match = toMatchQuery(filter.q, { prefix: filter.prefix === true });
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
      const inList = `p.status IN (${filter.statuses.map(() => '?').join(', ')})`;
      clauses.push(
        filter.markServingInReview
          ? `AND (${inList} OR (p.status = 'in_review' AND p.current_version = p.marked_version))`
          : `AND ${inList}`,
      );
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
                p.current_version, p.marked_version, p.review_date,
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

    // One lookup for the whole page of results, keyed on ids that have already
    // been through the membership join above — so the disclosure is bounded to
    // relations asserted against pages this asker may read (supersession.ts).
    // Unconditional rather than a flag a caller can forget: every surface that
    // lists pages is a surface a reader arrives through.
    const superseded = supersessionMarks(
      this.db,
      actorId,
      rows.map((r) => r.id as string),
      // The Knowledge API's second reader travels here too: a result is
      // visible to both actors, and so is the page named as its replacement.
      { alsoVisibleTo: filter.alsoVisibleTo },
    );

    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r) => ({
      pageId: r.id as string,
      title: r.title as string,
      collectionId: r.collection_id as string,
      type: r.type as DocType,
      status: r.status as PageStatus,
      // A search hit on a marked page whose revision is in review shows the
      // page's own standing (CANONICAL) with the revision noted, not the
      // draft's IN REVIEW in place of it (see revisionUnderReviewStanding).
      pageStanding: revisionUnderReviewStanding(r, today),
      ownerId: (r.owner_id as string) ?? null,
      snippet: r.snip as string,
      supersededBy: superseded.get(r.id as string) ?? null,
    }));
  }
}

// Users type words, not FTS5 syntax. Each whitespace-separated term becomes
// a quoted phrase (all terms must match), so operators and punctuation in
// the input can never break or subvert the MATCH expression.
//
// PREFIX MATCHING, AND ONLY ON THE LAST TERM.
//
// Every term was quoted whole and nothing carried a `*`, so a search box that
// answers as you type answered nothing until the last letter of the last word
// was in place: "reten" found nothing, "retention" found the policy (round
// seven). Somebody who does not already know the exact word the record uses
// never gets to the end of it.
//
// The last term, and no other, because the last term is the one under the
// cursor. The earlier ones were finished by the person typing a space after
// them, and treating a finished word as a prefix widens a query for no reason
// — "cost" would drag in "costume".
//
// WHAT THIS STILL CANNOT DO, stated rather than glossed. The index is stemmed
// (Porter, see TOKENIZER) and a prefix query is matched against the STEM, so
// the typed prefix has to be a prefix of the stem and not of the word:
// "reten*" reaches `retent` and finds the page, and "retenti*" does not,
// because `retenti` is longer than the stem it is trying to be a prefix of.
// Typing further into a word can therefore lose the match it had two letters
// ago. That is a real edge and it is why `suggest` exists: over-typing a stem
// looks exactly like a typo to the vocabulary, and it is answered the same
// way. The alternative — a second, unstemmed index to run prefixes against —
// doubles the index to fix a case one suggestion already covers.
export function toMatchQuery(q: string | undefined, { prefix = false } = {}): string | null {
  const terms = (q ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0);
  if (!terms.length) return null;
  return terms
    .map((t, i) => (prefix && i === terms.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}

/**
 * Levenshtein distance, bounded: it stops as soon as every cell in a row is
 * over `max`, because the only question ever asked of it here is "within two?"
 * and a long pair of unrelated words should not be walked to the end to say no.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** How far off a word of this length is still recognisably the same word. One
 *  edit on a short word is most of it; two on a long one is a slip. */
function slack(term: string): number {
  if (term.length <= 3) return 0;
  if (term.length <= 5) return 1;
  return 2;
}
