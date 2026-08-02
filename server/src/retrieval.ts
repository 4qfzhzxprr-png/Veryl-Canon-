import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, DocType, PageStatus } from './model.js';
import { STOPWORDS, type EmbeddingStore } from './embeddings.js';
import { quotableText } from './plaintext.js';
import type { SearchIndex, SearchResult } from './search.js';

// Retrieval, the four deterministic steps of DATA-BACKBONE.md §5. No inferred
// graph, no model-written intermediate summaries: candidates come from the
// two indexes, the asker's permissions bound them before anything is ranked,
// and expansion walks the explicit graph people maintain by hand — the tree
// and the links they wrote — so every page in the context is a real page with
// a real citation.
//
// Steps 1-3 live here. Step 4, generation under the record's rules, lives in
// answers.ts and consumes what this returns.

export type RetrievalChannel = 'lexical' | 'semantic' | 'graph';

export type GraphEdge = 'parent' | 'child' | 'link';

export interface RetrievalCandidate {
  pageId: string;
  title: string;
  collectionId: string;
  type: DocType;
  status: PageStatus;
  version: number;
  passage: string; // verbatim from the published body; what a citation quotes
  score: number;
  channels: RetrievalChannel[];
  /**
   * How this page ARRIVED, when it did not arrive on its own: the neighbour it
   * was expanded from. Null for a page the two indexes found directly.
   */
  via: { fromPageId: string; edge: GraphEdge } | null;
  /**
   * What this page is CONNECTED to, among the pages this same retrieval
   * returned — its parent, its children, the pages it links to and the pages
   * that link to it, as far as expansion walked.
   *
   * `via` and this are not the same question, and conflating them was a bug.
   * A page can be found directly AND be the child of a better hit; `via` is
   * null for it, because it did not need the edge to be found, and the edge is
   * still there and still means what it always meant. Answers rely on this to
   * decide whether a page rides on an anchor: before it existed, a child
   * procedure was cited when the question's words missed it and dropped when
   * they hit it, which is exactly backwards.
   */
  neighbourOf: string[];
}

export interface RetrieveRequest {
  question: string;
  collectionId?: string;
  // Bounds the directly retrieved candidates. Graph expansion adds its
  // neighbours on top, under its own cap.
  limit?: number;
  // Answers set this: the official record only, never Drafts, never Notes
  // (a Note can never carry the Canonical mark, so the status test is the
  // load-bearing one; the type test says so out loud). "Official" means
  // ANSWERABLE_STATUSES below — Canonical, and Canonical-that-is-past-review.
  canonicalOnly?: boolean;
  // Graph expansion, step 3. On by default; depth is clamped below.
  expand?: boolean;
  depth?: number;
  // The two narrowings the Knowledge API adds (STUDIO-CONTRACT.md §4), so a
  // Studio app's answer is bounded by the app's permissions, the person's
  // permissions, and the Registry's collection limit at once. Both only ever
  // narrow, and both are applied in `hydrate` — the single gate every
  // candidate passes through, direct or expanded — which is before any
  // passage is built and long before anything is generated.
  /** A second actor who must also be able to see a page for it to be a candidate. */
  alsoVisibleTo?: string;
  /** An allow-list of collection ids; absent means no such bound. */
  collectionIds?: string[];
}

// Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, SIGIR 2009):
// score(d) = Σ 1 / (k + rank_i(d)) over the rank lists that contain d, with
// ranks 1-based. k = 60 is the constant from that paper and the de facto
// default everywhere since; it flattens the head of each list so that a
// document ranked 1st in one channel does not automatically beat a document
// ranked 2nd or 3rd in both. Fusing ranks rather than scores is what lets us
// combine BM25 (unbounded, corpus-relative) with cosine (bounded, 0..1)
// without inventing a calibration nobody could defend.
export const RRF_K = 60;

// Caps, so an expensive question stays cheap and bounded.
export const MAX_TERMS = 12;
export const LEXICAL_POOL = 25;
export const SEMANTIC_POOL = 25;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;
export const MAX_DEPTH = 2;
export const DEFAULT_DEPTH = 1;
export const MAX_EXPANDED = 10;
// An expanded neighbour is context for the candidate that pulled it in, not
// a hit in its own right, so it inherits a damped share of that score.
export const EXPANSION_DAMPING = 0.5;

export const PASSAGE_LENGTH = 320;

// A question is a question. Without a ceiling, one POST /ask can hand a
// multi-megabyte string to the embedding provider — a per-request cost paid by
// the server, and, with a hosted provider, a per-request bill. Refusing is the
// honest answer: nothing that long is a question the record can answer.
export const MAX_QUESTION_LENGTH = 4096;

// What a grounded answer is allowed to draw on. Canonical, plus Needs Update —
// a page the freshness sweep flipped because its review date passed. The
// argument for including it, since this is the load-bearing line of the whole
// freshness feature, is set out in full in answers.ts above `eligible`.
export const ANSWERABLE_STATUSES: readonly PageStatus[] = ['canonical', 'needs_update'];

// The content terms of a question, deduplicated and capped. Stopwords come
// from embeddings.ts so both channels agree on what a content word is.
export function contentTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const raw of question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
    const term = raw.replace(/['-]+$/, '');
    if (term.length < 2 || STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= MAX_TERMS) break;
  }
  return [...terms];
}

// Link parsing, deliberately simple and deliberately narrow: a link is a
// page id that appears either as the stable link the product hands out
// (`/pages/<id>`) or as a wiki-style reference (`[[<id>]]`). Nothing is
// inferred from prose, nothing is resolved by title, and an id that names no
// visible page is just text. Ids are UUIDs, hence the length floor.
const PAGE_LINK = /(?:\/pages\/|\[\[)\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/g;

export function parsePageLinks(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(PAGE_LINK)) ids.add(match[1]!);
  return [...ids];
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface RetrievalHost {
  getActor(id: string): Actor;
}

/** The Knowledge API's extra narrowing, carried into the candidate SQL. */
interface Narrowing {
  alsoVisibleTo?: string;
  collectionIds?: string[];
}

interface HydratedPage {
  pageId: string;
  title: string;
  collectionId: string;
  type: DocType;
  status: PageStatus;
  version: number;
  parentId: string | null;
  body: string;
}

export class RetrievalService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: RetrievalHost,
    private readonly searchIndex: SearchIndex,
    private readonly embeddings: EmbeddingStore,
  ) {}

  async retrieve(actorId: string, request: RetrieveRequest): Promise<RetrievalCandidate[]> {
    this.host.getActor(actorId); // not_found for an unknown asker
    const question = request.question?.trim();
    if (!question) throw new CanonError('invalid', 'Retrieval requires a question');
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new CanonError('invalid', `A question may be at most ${MAX_QUESTION_LENGTH} characters`, {
        limit: MAX_QUESTION_LENGTH,
        length: question.length,
      });
    }
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const canonicalOnly = request.canonicalOnly ?? false;
    const terms = contentTerms(question);

    // ---- step 1: hybrid candidate search -------------------------------
    // Two channels, each permission-filtered in its own SQL (step 2), fused
    // by rank. Lexical catches exact policy language and proper nouns;
    // semantic catches the question asked in words the record does not use.
    const lexical = this.lexicalRanking(actorId, terms, request, canonicalOnly);
    const semantic = await this.semanticRanking(actorId, question, request);

    // Both channels already know each candidate's title, so a tie can be
    // broken on content rather than on a UUID without asking the record again.
    const titles = new Map<string, string>();
    for (const hit of lexical) titles.set(hit.pageId, hit.title);
    for (const [pageId, hit] of semantic) titles.set(pageId, hit.title);

    const fused = new Map<string, { score: number; channels: Set<RetrievalChannel> }>();
    const contribute = (pageIds: string[], channel: RetrievalChannel): void => {
      pageIds.forEach((pageId, index) => {
        const entry = fused.get(pageId) ?? { score: 0, channels: new Set<RetrievalChannel>() };
        entry.score += 1 / (RRF_K + index + 1);
        entry.channels.add(channel);
        fused.set(pageId, entry);
      });
    };
    contribute(
      lexical.map((hit) => hit.pageId),
      'lexical',
    );
    contribute([...semantic.keys()], 'semantic');

    // Fused score first; then how many channels found the page, because a page
    // both channels reached is better evidenced than one only a single channel
    // reached at the same rank; then the title, then the id, so that the
    // remaining ties resolve the same way every time. See search.ts over its
    // ORDER BY for why "the same way every time" is worth spending a sort key
    // on: this list decides which pages survive the limit, and it used to be
    // settled by whichever UUID sorted first.
    const ordered = [...fused.entries()].sort(
      (a, b) =>
        b[1].score - a[1].score ||
        b[1].channels.size - a[1].channels.size ||
        (titles.get(a[0]) ?? '').localeCompare(titles.get(b[0]) ?? '') ||
        a[0].localeCompare(b[0]),
    );

    // ---- step 2: permission filtering before ranking -------------------
    // Both channels already bound their candidates to the asker's
    // collections in SQL; hydration is the same join once more, and it is
    // also where Canonical-only is enforced. A page the asker cannot see is
    // never fetched, never scored, and never reaches the context.
    const candidates: RetrievalCandidate[] = [];
    const seen = new Set<string>();
    for (const [pageId, entry] of ordered) {
      if (candidates.length >= limit) break;
      const page = this.hydrate(actorId, pageId, canonicalOnly, request);
      if (!page) continue;
      seen.add(pageId);
      candidates.push({
        pageId: page.pageId,
        title: page.title,
        collectionId: page.collectionId,
        type: page.type,
        status: page.status,
        version: page.version,
        passage: passageFor(page.body, terms, semantic.get(pageId)?.text),
        score: entry.score,
        channels: [...entry.channels],
        via: null,
        neighbourOf: [],
      });
    }

    // ---- step 3: graph expansion along real edges ----------------------
    if (request.expand ?? true) {
      const depth = Math.min(Math.max(request.depth ?? DEFAULT_DEPTH, 0), MAX_DEPTH);
      candidates.push(...this.expand(actorId, candidates, seen, depth, terms, canonicalOnly, request));
    }

    candidates.sort(
      (a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.pageId.localeCompare(b.pageId),
    );
    return candidates;
  }

  // The neighbours of one page: its parent, its children, and the pages it
  // explicitly links to. Permission-checked and, for answers, Canonical-only.
  related(
    actorId: string,
    pageId: string,
    opts: { canonicalOnly?: boolean; limit?: number } = {},
  ): RetrievalCandidate[] {
    this.host.getActor(actorId);
    const source = this.hydrate(actorId, pageId, false);
    if (!source) throw new CanonError('not_found', `No such page: ${pageId}`);
    const limit = Math.min(Math.max(opts.limit ?? MAX_EXPANDED, 1), MAX_LIMIT);
    const out: RetrievalCandidate[] = [];
    const seen = new Set<string>([pageId]);
    for (const edge of this.neighbours(source)) {
      if (out.length >= limit) break;
      if (seen.has(edge.pageId)) continue;
      seen.add(edge.pageId);
      const page = this.hydrate(actorId, edge.pageId, opts.canonicalOnly ?? false);
      if (!page) continue;
      out.push(this.toCandidate(page, EXPANSION_DAMPING, [], [], { fromPageId: pageId, edge: edge.edge }));
    }
    return out;
  }

  // ---- internals -------------------------------------------------------

  // The lexical channel reuses the existing FTS5/BM25 index rather than
  // reimplementing scoring. That index conjoins terms — every term of the
  // query must appear — which is right for search but wrong for a sentence
  // someone typed at a question box, where matching every word is rare. So
  // the channel issues the whole-question query and one query per content
  // term, then fuses those rank lists with RRF into a single lexical
  // ranking. Pages matching many terms, and matching them strongly, rise;
  // pages matching one rare term still appear.
  //
  // A SECOND PASS OVER THE RECORD'S OWN VOCABULARY WAS TRIED HERE AND DOES NOT
  // PAY. Written down so it is not rebuilt: pseudo-relevance feedback — run the
  // query, take the words that distinguish the best few results from the rest
  // of the corpus, ask again with them, damped. Measured against the labelled
  // set in scripts/eval-retrieval.ts it moved MRR by 0.005 and moved nothing
  // else, at seven extra queries per ask, and it made the one question it was
  // built for WORSE.
  //
  // The reason is worth keeping. It was aimed at the vocabulary gap: "How long
  // do we keep files about people who have left the company?" is answered
  // completely by "Retention periods: employment records" and shares not one
  // word with it. But feedback can only borrow words from pages the first pass
  // already reached, and the first pass is precisely what fails in that case —
  // it reaches the retention pages it can see and borrows "seven", "twenty",
  // "four", "months", "schedule". Figures, because a figure is rare and
  // repeated and that is exactly what the scoring rewards. Nothing in that set
  // is a step towards "employment".
  //
  // Feedback sharpens a query that is already roughly right. The vocabulary gap
  // is where it is not. That gap needs an embedding that knows the two phrases
  // mean the same thing, which is embeddings.ts's job and not this one's.
  private lexicalRanking(
    actorId: string,
    terms: string[],
    request: RetrieveRequest,
    canonicalOnly: boolean,
  ): { pageId: string; title: string }[] {
    if (terms.length === 0) return [];
    const base = {
      collectionId: request.collectionId,
      statuses: canonicalOnly ? ANSWERABLE_STATUSES : undefined,
      limit: LEXICAL_POOL,
      // The Knowledge API's narrowing reaches the pool as well as the
      // hydration gate, so a page outside the intersection never occupies a
      // slot in the lexical ranking either.
      alsoVisibleTo: request.alsoVisibleTo,
      collectionIds: request.collectionIds,
    };
    const queries = terms.length > 1 ? [terms.join(' '), ...terms] : [...terms];
    const scores = new Map<string, number>();
    const titles = new Map<string, string>();
    for (const q of queries) {
      let hits: SearchResult[];
      try {
        hits = this.searchIndex.search(actorId, { ...base, q });
      } catch (err) {
        if (err instanceof CanonError && err.code === 'invalid') continue;
        throw err;
      }
      hits.forEach((hit, index) => {
        scores.set(hit.pageId, (scores.get(hit.pageId) ?? 0) + 1 / (RRF_K + index + 1));
        titles.set(hit.pageId, hit.title);
      });
    }
    return [...scores.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          (titles.get(a[0]) ?? '').localeCompare(titles.get(b[0]) ?? '') ||
          a[0].localeCompare(b[0]),
      )
      .map(([pageId]) => ({ pageId, title: titles.get(pageId) ?? '' }))
      .slice(0, LEXICAL_POOL);
  }

  // The semantic channel: best-scoring chunk per page, in score order. Empty
  // when no embeddings exist for the configured provider, which is exactly
  // the documented degradation to lexical-plus-graph.
  private async semanticRanking(
    actorId: string,
    question: string,
    request: RetrieveRequest,
  ): Promise<Map<string, { text: string; title: string }>> {
    const hits = await this.embeddings.similar(actorId, {
      question,
      collectionId: request.collectionId,
      limit: SEMANTIC_POOL * 4,
    });
    // pageId -> its best chunk, insertion-ordered by score.
    const best = new Map<string, { text: string; title: string }>();
    for (const hit of hits) {
      if (best.has(hit.pageId)) continue;
      best.set(hit.pageId, { text: hit.text, title: hit.title });
      if (best.size >= SEMANTIC_POOL) break;
    }
    return best;
  }

  // One page, as the asker may see it: the permission join is in the SQL, so
  // an invisible page returns nothing rather than being filtered out later.
  // Unpublished and archived pages return nothing too, and with
  // canonicalOnly so does anything that is not a Canonical non-Note.
  //
  // `narrowing` is the Knowledge API's other two gates (STUDIO-CONTRACT.md
  // §4), in this same SQL: a second actor who must also be able to see the
  // page, and an allow-list of collections. Absent, nothing changes for
  // anyone. Present, they can only take pages away.
  private hydrate(
    actorId: string,
    pageId: string,
    canonicalOnly: boolean,
    narrowing: Narrowing = {},
  ): HydratedPage | null {
    const clause = canonicalOnly
      ? `AND p.status IN (${ANSWERABLE_STATUSES.map((x) => `'${x}'`).join(', ')}) AND p.type != 'note'`
      : "AND p.status != 'archived'";
    // An empty allow-list is "nowhere", not "no constraint".
    if (narrowing.collectionIds && narrowing.collectionIds.length === 0) return null;
    const scope = narrowing.collectionIds
      ? `AND p.collection_id IN (${narrowing.collectionIds.map(() => '?').join(', ')})`
      : '';
    const second = narrowing.alsoVisibleTo
      ? 'JOIN collection_members m2 ON m2.collection_id = p.collection_id AND m2.actor_id = ?'
      : '';
    const row = this.db
      .prepare(
        `SELECT p.id, p.collection_id, p.type, p.status, p.parent_id, p.current_version, v.title, v.body
         FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
         ${second}
         WHERE p.id = ? ${clause} ${scope}`,
      )
      .get(
        actorId,
        ...(narrowing.alsoVisibleTo ? [narrowing.alsoVisibleTo] : []),
        pageId,
        ...(narrowing.collectionIds ?? []),
      ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      pageId: row.id as string,
      title: row.title as string,
      collectionId: row.collection_id as string,
      type: row.type as DocType,
      status: row.status as PageStatus,
      version: row.current_version as number,
      parentId: (row.parent_id as string) ?? null,
      body: row.body as string,
    };
  }

  private neighbours(page: HydratedPage): { pageId: string; edge: GraphEdge }[] {
    const out: { pageId: string; edge: GraphEdge }[] = [];
    if (page.parentId) out.push({ pageId: page.parentId, edge: 'parent' });
    const children = this.db
      // By position, then title: siblings share a position far more often than
      // the tree suggests, and falling back to the id made which child joined
      // the context under MAX_EXPANDED a matter of which UUID sorted first.
      .prepare(
        "SELECT id FROM pages WHERE parent_id = ? AND status != 'archived' ORDER BY position, title, id",
      )
      .all(page.pageId) as { id: string }[];
    for (const child of children) out.push({ pageId: child.id, edge: 'child' });
    for (const linked of parsePageLinks(page.body)) {
      if (linked === page.pageId) continue;
      out.push({ pageId: linked, edge: 'link' });
    }
    return out;
  }

  // Breadth-first over the explicit graph, to a small fixed depth and a hard
  // cap on how many neighbours may join the context. Every expanded page is
  // hydrated through the same permission (and, for answers, Canonical) SQL as
  // the candidates it hangs off.
  private expand(
    actorId: string,
    candidates: RetrievalCandidate[],
    seen: Set<string>,
    depth: number,
    terms: string[],
    canonicalOnly: boolean,
    narrowing: Narrowing = {},
  ): RetrievalCandidate[] {
    const added: RetrievalCandidate[] = [];
    // Every candidate this walk can reach, by id, so an edge that lands on a
    // page already in the list is recorded on it rather than thrown away.
    const byId = new Map(candidates.map((c) => [c.pageId, c]));
    let frontier = candidates.map((c) => ({ pageId: c.pageId, score: c.score }));
    for (let level = 0; level < depth && added.length < MAX_EXPANDED; level += 1) {
      const next: { pageId: string; score: number }[] = [];
      for (const node of frontier) {
        if (added.length >= MAX_EXPANDED) break;
        const source = this.hydrate(actorId, node.pageId, false, narrowing);
        if (!source) continue;
        for (const edge of this.neighbours(source)) {
          // The edge is real whether or not it brings a new page with it, and
          // recording it costs nothing. This happens BEFORE the cap and before
          // the seen check, because both of those are about whether to FETCH a
          // page, and this is about a page already fetched.
          const already = byId.get(edge.pageId);
          if (already && edge.pageId !== node.pageId && !already.neighbourOf.includes(node.pageId)) {
            already.neighbourOf.push(node.pageId);
          }
          if (added.length >= MAX_EXPANDED) break;
          if (seen.has(edge.pageId)) continue;
          seen.add(edge.pageId);
          const page = this.hydrate(actorId, edge.pageId, canonicalOnly, narrowing);
          if (!page) continue;
          const score = node.score * EXPANSION_DAMPING;
          const candidate = this.toCandidate(page, score, ['graph'], terms, {
            fromPageId: node.pageId,
            edge: edge.edge,
          });
          added.push(candidate);
          byId.set(candidate.pageId, candidate);
          next.push({ pageId: page.pageId, score });
        }
      }
      frontier = next;
    }
    return added;
  }

  private toCandidate(
    page: HydratedPage,
    score: number,
    channels: RetrievalChannel[],
    terms: string[],
    via: { fromPageId: string; edge: GraphEdge } | null,
  ): RetrievalCandidate {
    return {
      pageId: page.pageId,
      title: page.title,
      collectionId: page.collectionId,
      type: page.type,
      status: page.status,
      version: page.version,
      passage: passageFor(page.body, terms),
      score,
      channels: channels.length ? channels : ['graph'],
      via,
      neighbourOf: [],
    };
  }
}

// A verbatim window of the published body, for citation. Nothing is
// paraphrased or generated: the window is the record's own words, with the
// marks that tell a renderer what to draw removed and the words kept exactly
// (see `quotableText` in plaintext.ts, which owns that decision). The chunk
// the semantic channel matched wins when there is one; otherwise the window is
// centred on the first content term that appears, and failing that on the
// opening of the page.
export function passageFor(body: string, terms: string[], preferred?: string): string {
  const text = quotableText(preferred ?? body);
  if (!text) return '';
  if (preferred) return clip(text, PASSAGE_LENGTH);

  let at = -1;
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return clip(text, PASSAGE_LENGTH);

  let start = Math.max(0, at - Math.floor(PASSAGE_LENGTH / 3));
  if (start > 0) {
    const boundary = text.lastIndexOf('. ', at);
    start = boundary > start - PASSAGE_LENGTH && boundary !== -1 ? boundary + 2 : start;
    const space = text.indexOf(' ', start);
    if (start > 0 && space !== -1 && space < at) start = space + 1;
  }
  return clip(text.slice(start), PASSAGE_LENGTH);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
