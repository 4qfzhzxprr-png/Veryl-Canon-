import type { DatabaseSync } from 'node:sqlite';
import { indexableText } from './plaintext.js';

// Semantic retrieval over the PUBLISHED record (DATA-BACKBONE.md §5, step 1).
// Like the FTS index, this table is a derived structure per principle 1:
// rebuildable from pages and page_versions, never authoritative, and holding
// nothing that is not already in the record — which is why its schema lives
// here, next to the logic that maintains it, and not in db.ts.
//
// Only published content is embedded. Drafts are never embedded (readers and
// answers draw on the record, not on work in progress) and archived pages
// leave the index, exactly as they leave search.
//
// Embeddings are keyed by page and version. A row whose version no longer
// matches the page's current version can never surface, because every query
// joins on `p.current_version = e.version`; a row written by a different
// provider can never surface either, because provider and dimensions are part
// of every match. That second rule matters: two providers produce two
// unrelated vector spaces, and silently mixing them would rank nonsense
// above the record. A provider change is therefore detected when the store
// opens and repaired by re-deriving everything from the record.

export const EMBEDDINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS embeddings (
  page_id     TEXT NOT NULL REFERENCES pages(id),
  version     INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  vector      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  dimensions  INTEGER NOT NULL,
  PRIMARY KEY (page_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_provider ON embeddings(provider);
`;

// The one pluggable piece. A hosted model, a self-hosted model, or the local
// default below all satisfy this; retrieval never learns which it got.
// DATA-BACKBONE.md §5: semantic retrieval is optional and configurable, and
// without a provider the system degrades to lexical plus graph expansion.
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;
export const LOCAL_DIMENSIONS = 1024;

// Question words and connectives carry no retrieval signal in either
// channel: they pollute a bag-of-words vector (every page shares "the") and,
// because the FTS channel conjoins terms, they suppress lexical recall. A
// short, boring list beats a clever one; anything not here counts as content.
// Shared with retrieval.ts so both channels agree on what a content word is.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'did', 'do', 'does', 'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its',
  'may', 'me', 'must', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'should', 'so', 'some', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

// Tokenisation shared by the local provider and by anything that wants to
// reason about its vectors: lowercase alphanumeric runs, nothing clever.
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// FNV-1a, 32-bit. Deterministic across platforms and Node versions, which is
// what the hashing trick below needs; not a security primitive.
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The default provider: hashed bag of words, L2-normalised, dependency-free
// and deterministic.
//
// BE CLEAR ABOUT WHAT THIS IS NOT. It is not a semantically strong embedding.
// It has no notion of synonymy, paraphrase, or word order: two passages that
// say the same thing in different words get orthogonal vectors, which is
// precisely the case real semantic retrieval exists to catch. What it buys is
// that the whole system runs — and the whole test suite runs hermetically —
// with no external calls, no API key, and no record text leaving the machine,
// which DATA-BACKBONE.md §8 names as an open question for regulated partners.
// It also makes the vector channel behave differently from the lexical one in
// one honest way: it scores partial term overlap, where the FTS channel
// requires every term of a phrase to match. And because it hashes tokens into
// a fixed number of buckets, two unrelated words occasionally share a
// dimension and produce a small spurious similarity — the standard cost of the
// hashing trick, reduced but not removed by the dimension count. Swap in a
// real provider and the rest of retrieval is unchanged.
// The version in the name is not decoration. Every stored vector carries the
// name of the provider that made it, and a query only ever matches vectors made
// by the provider it is running — which is how a provider swap is caught and
// repaired instead of silently mixing two vector spaces. That machinery covers
// a change of MODEL; it also has to cover a change in what the model is fed.
// v2 is v1 fed the page's words instead of its raw Markdown (see `derive`), so
// every v1 row was made from different input and is not comparable with a v2
// query. Bumping the name is what tells an existing record to re-derive.
export const localEmbeddingProvider: EmbeddingProvider = {
  name: 'local-hashed-bow-v2',
  dimensions: LOCAL_DIMENSIONS,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedLocal(text, LOCAL_DIMENSIONS));
  },
};

function embedLocal(text: string, dimensions: number): number[] {
  const counts = new Float64Array(dimensions);
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    const bucket = hashToken(token) % dimensions;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  // Sublinear term frequency, then L2 normalise so cosine is a dot product
  // and long pages do not simply outscore short ones.
  const vector = new Array<number>(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const count = counts[i]!;
    const weight = count > 0 ? 1 + Math.log(count) : 0;
    vector[i] = weight;
    norm += weight * weight;
  }
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dimensions; i += 1) vector[i] = vector[i]! * inv;
  }
  return vector;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Chunking: paragraph boundaries where possible, a hard sliding window where
// a single paragraph is longer than a chunk. Consecutive chunks overlap by
// about `overlap` characters so a passage that straddles a boundary is still
// wholly present in one chunk.
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const step = Math.max(size - overlap, 1);
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush();
      for (let start = 0; start < paragraph.length; start += step) {
        chunks.push(paragraph.slice(start, start + size).trim());
        if (start + size >= paragraph.length) break;
      }
      continue;
    }
    if (current && current.length + 2 + paragraph.length > size) {
      const carry = tail(current, overlap);
      flush();
      current = carry ? `${carry}\n\n${paragraph}` : paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  flush();
  return chunks;
}

// The last ~n characters, cut back to a word boundary so the overlap reads
// as text rather than as a fragment.
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return text.trim();
  const slice = text.slice(text.length - n);
  const space = slice.search(/\s/);
  return (space === -1 ? slice : slice.slice(space + 1)).trim();
}

export interface StoredChunk {
  pageId: string;
  version: number;
  chunkIndex: number;
  text: string;
  provider: string;
  dimensions: number;
}

export interface SemanticHit {
  pageId: string;
  chunkIndex: number;
  text: string;
  score: number;
  /** The page's title, carried so ties can be broken on content, not on id. */
  title: string;
}

export interface SemanticQuery {
  question: string;
  collectionId?: string;
  limit?: number;
}

export class EmbeddingStore {
  // Indexing is triggered from synchronous write paths (publish, approve,
  // restore, archive) but embedding is asynchronous, so work is appended to a
  // FIFO chain instead of blocking the write. Every read path awaits ready()
  // first, so a query never races the indexing of a page that has already
  // published.
  private queue: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;

  constructor(
    private readonly db: DatabaseSync,
    readonly provider: EmbeddingProvider = localEmbeddingProvider,
  ) {
    // A provider change must not silently mix vector spaces. Rows from any
    // other provider are already ignored by every query; here they are also
    // re-derived from the record, on the queue, so the first read after the
    // swap sees a consistent index.
    if (this.hasForeignRows()) {
      this.enqueue(() => this.rebuildAll());
    }
  }

  // Re-derives one page's chunks from its current published version. Called
  // from the store alongside the search hook. Idempotent: a draft, an
  // archived page, or a page with no published version simply leaves the
  // index.
  indexPage(pageId: string): void {
    this.enqueue(() => this.derive(pageId));
  }

  // Rebuilds the whole index from pages and page_versions. The index is never
  // the source of truth; this is what proves it.
  async rebuildAll(): Promise<void> {
    this.db.exec('DELETE FROM embeddings');
    const rows = this.db
      .prepare(
        `SELECT p.id FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.status != 'archived'
         ORDER BY p.id`,
      )
      .all() as { id: string }[];
    for (const row of rows) await this.derive(row.id);
  }

  // Awaited by every read path; also lets tests and callers settle the queue.
  async ready(): Promise<void> {
    await this.queue;
  }

  // The last indexing failure, if any. A failed derive leaves the page out of
  // the vector channel — retrieval degrades, it does not lie — and
  // rebuildAll() repairs it from the record.
  get error(): Error | null {
    return this.lastError;
  }

  chunksFor(pageId: string): StoredChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM embeddings WHERE page_id = ? ORDER BY chunk_index')
      .all(pageId) as Record<string, unknown>[];
    return rows.map((r) => ({
      pageId: r.page_id as string,
      version: r.version as number,
      chunkIndex: r.chunk_index as number,
      text: r.text as string,
      provider: r.provider as string,
      dimensions: r.dimensions as number,
    }));
  }

  // Cosine similarity over stored vectors, permission-filtered in SQL: the
  // candidate set is bound to collections where the asker holds membership
  // (view is the lowest role, so membership is exactly "at least view")
  // before any ranking happens. At alpha scale — thousands of pages — exact
  // similarity is fast enough and no vector database is needed
  // (DATA-BACKBONE.md §5).
  async similar(actorId: string, query: SemanticQuery): Promise<SemanticHit[]> {
    await this.ready();
    const question = query.question.trim();
    if (!question) return [];
    const embedded = await this.provider.embed([question]);
    const target = embedded[0];
    if (!target) return [];

    const params: (string | number)[] = [actorId, this.provider.name, this.provider.dimensions];
    let clause = '';
    if (query.collectionId) {
      clause = 'AND p.collection_id = ?';
      params.push(query.collectionId);
    }
    const rows = this.db
      .prepare(
        `SELECT e.page_id, e.chunk_index, e.text, e.vector, p.title FROM embeddings e
         JOIN pages p ON p.id = e.page_id AND p.current_version = e.version
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
         WHERE e.provider = ? AND e.dimensions = ? AND p.status != 'archived' ${clause}`,
      )
      .all(...params) as Record<string, unknown>[];

    const hits: SemanticHit[] = [];
    for (const row of rows) {
      const vector = JSON.parse(row.vector as string) as number[];
      const score = cosine(target, vector);
      if (score <= MIN_SIMILARITY) continue;
      hits.push({
        pageId: row.page_id as string,
        chunkIndex: row.chunk_index as number,
        text: row.text as string,
        score,
        title: row.title as string,
      });
    }
    // Ties fall to the title before the id, for the reason set out over the
    // ORDER BY in search.ts: cosine ties are common, the id is a UUID, and a
    // record should answer the same question the same way twice.
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.title.localeCompare(b.title) ||
        a.chunkIndex - b.chunkIndex ||
        a.pageId.localeCompare(b.pageId),
    );
    return hits.slice(0, Math.min(Math.max(query.limit ?? 25, 1), 200));
  }

  // ---- internals -------------------------------------------------------

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.lastError = err instanceof Error ? err : new Error(String(err));
    });
  }

  private hasForeignRows(): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM embeddings WHERE provider != ? OR dimensions != ? LIMIT 1')
      .get(this.provider.name, this.provider.dimensions) as { hit: number } | undefined;
    return row !== undefined;
  }

  private async derive(pageId: string): Promise<void> {
    this.db.prepare('DELETE FROM embeddings WHERE page_id = ?').run(pageId);
    const row = this.db
      .prepare(
        `SELECT p.current_version AS version, v.title, v.body FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
         WHERE p.id = ? AND p.status != 'archived'`,
      )
      .get(pageId) as { version: number; title: string; body: string } | undefined;
    if (!row) return;

    // A page with a title but no body is still worth finding, so the title
    // stands in as its single chunk.
    //
    // Chunked from the page's WORDS, not from its Markdown — the same text the
    // search index is built from and a citation quotes (plaintext.ts). It
    // matters more here than anywhere: this provider hashes tokens into
    // buckets, so `#/pages/8f14e45f-…` contributed a handful of hex tokens to
    // the vector of every page that linked anywhere, and two pages that linked
    // to nothing in common still shared whatever those tokens collided with.
    // That is similarity manufactured out of punctuation.
    const chunks = chunkText(indexableText(row.body));
    const texts = chunks.length ? chunks : [row.title];
    // The stored text is the chunk itself — that is what a citation quotes —
    // while the vector is derived from the title plus the chunk, because a
    // page's title is part of what it is about.
    const vectors = await this.provider.embed(texts.map((text) => `${row.title}\n\n${text}`));

    const insert = this.db.prepare(
      `INSERT INTO embeddings (page_id, version, chunk_index, text, vector, provider, dimensions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    texts.forEach((text, index) => {
      const vector = vectors[index];
      if (!vector) return;
      insert.run(
        pageId,
        row.version,
        index,
        text,
        JSON.stringify(vector),
        this.provider.name,
        this.provider.dimensions,
      );
    });
  }
}

// Below this, a chunk shares no vocabulary with the question worth ranking.
const MIN_SIMILARITY = 1e-9;
