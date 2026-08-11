import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, DocType, PageStatus, Role, ROLE_RANK } from './model.js';
import { parsePageLinks } from './retrieval.js';
import type { ImportSource } from './import.js';
import { RELATION_KINDS, type RelationKind } from './relations.js';
import type { SourceAuthMode } from './sources.js';

// The knowledge map: one collection's record drawn as nodes and edges, so the
// two questions a regulated buyer asks of a knowledge record can be answered by
// looking rather than by clicking through it.
//
//   1. How is this knowledge related?
//   2. Where does its material come from?
//
// THE EDGES ARE THE EXPLICIT GRAPH, AND ONLY THE EXPLICIT GRAPH
//
// DATA-BACKBONE.md §5 is emphatic: "Canon does not need an inferred graph,
// because it already has an explicit one. Trees, page links, owners, types,
// labels, and status are structured data that people maintain deliberately."
// So this file draws exactly five kinds of edge, every one of them something a
// person or an agent wrote down:
//
//   child          parent → child, the page tree of §4
//   link           page → page, a link written in a PUBLISHED body
//   reference      page → source, a reference field of §6
//   conflicts_with page ↔ page, a contradiction a person asserted (§7)
//   supersedes     page → page, a replacement a person asserted (§7)
//
// The last two are why §7 says contradiction "becomes something visible on the
// knowledge map rather than something discovered during an audit": they may be
// drawn for exactly the reason the first three may — a person wrote them down.
// Canon draws no relation it worked out for itself, here or anywhere.
// `conflicts_with` is symmetric and stored once, with its pair canonically
// ordered (relations.ts), so it is drawn once; `supersedes` is directed and is
// drawn in the direction it was asserted.
//
// There is deliberately no similarity edge, no co-occurrence edge, and no
// clustering. A map that invented edges would be exactly the model-written
// intermediate layer §5 refuses, drawn instead of written — and it would be
// believed, because it is a picture.
//
// Link parsing is `parsePageLinks` from retrieval.ts, imported rather than
// reimplemented. The map must agree with what the answer engine expands along;
// two parsers would eventually disagree, and the map would then be drawing a
// graph the record does not actually have.
//
// PROVENANCE IS THE HALF THAT MAKES IT WORTH DRAWING
//
// Every page node says where its material comes from, in §6's own three
// patterns:
//
//   authored   written in Canon, by a person or an agent.
//   imported   migrated in from Confluence or Google Docs. §6: "a migrated space
//              is retired or made read-only … An import that does not end with a
//              retired source has not finished." Canon cannot see whether the
//              far side was retired, so it does not claim to: it names the
//              system, the file, and the run, and the map makes the whole set of
//              still-traceable pages visible in one filter. That list is the
//              migration's unfinished business, and it should be short.
//   federated  carries reference fields resolving to a live external Source.
//
// PRECEDENCE, stated because a page can be both. A page that was imported AND
// carries a live reference is labelled `federated`: the strongest true statement
// about where its material comes from *now* is that part of it is not in Canon
// at all. Nothing is lost by the choice — `origin` still names the import — and
// the client's "imported" filter matches on `origin` as well as on the label, so
// "what still traces to another system" stays a complete answer.
//
// PERMISSIONS ARE IN THE SELECT, NEVER AFTER IT
//
// Every query that selects a node joins `collection_members` for the asking
// actor, the way search, retrieval, and queries.ts do. A page the viewer cannot
// see is never selected, so it cannot appear as a node — and, because edges are
// built only between nodes that were selected, it cannot appear as the endpoint
// of an edge either. An edge whose other end is invisible is DROPPED, never
// drawn to a placeholder: a box saying "something you may not see, here" is a
// disclosure, and on a map of a restricted collection it is the disclosure that
// matters.
//
// This is why the map deliberately follows links OUT of the collection. Within
// one collection every member sees every page, so a permission rule that only
// ever looked at one collection would never do anything. Links cross
// collections, the neighbour on the other side may be one this viewer is not a
// member of, and that is precisely the case the filter exists for.
//
// TWO VIEWS OF THE SAME GRAPH
//
// `graph()` is the drill-down: ONE collection, its tree in full, and the
// neighbours its links reach. `recordGraph()` is the whole record: EVERY
// collection the asker may view (or a named subset), drawn together. They are
// the same graph read at two altitudes and they share everything that decides
// what a node means — the same three edge kinds, the same `origins` and
// `references` queries, and the same `classifyProvenance` call, so a page
// labelled `imported` on one is labelled `imported` on the other by
// construction rather than by two functions agreeing.
//
// What only the whole-record view can show is the cross-collection link: a
// page in Compliance linking a page in Product. A single-collection map draws
// that neighbour as an outsider hanging off the edge; the record view draws
// both collections and the edge between them as an ordinary part of the
// picture, which is the shape of a company's knowledge rather than of one
// team's folder. The permission rule is unchanged and does more work here, not
// less: an edge is drawn only when the asker may see BOTH of its ends.

export type GraphNodeKind = 'page' | 'source';

/** DATA-BACKBONE.md §6's three patterns, as a label on a node. */
export type Provenance = 'authored' | 'imported' | 'federated';
export const PROVENANCES: readonly Provenance[] = ['authored', 'imported', 'federated'];

/** The explicit graph's five edges. Nothing else is ever emitted. */
export type GraphEdgeKind = 'child' | 'link' | 'reference' | RelationKind;
export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = ['child', 'link', 'reference', ...RELATION_KINDS];

/** Where an imported page came from: the run, the system, and the file. */
export interface ImportOrigin {
  system: ImportSource;
  file: string;
  runId: string;
  at: string;
}

export interface GraphPageNode {
  id: string;
  kind: 'page';
  title: string;
  type: DocType;
  status: PageStatus;
  collectionId: string;
  parentId: string | null;
  /** True for a page reached by a link out of the collection being mapped. */
  external: boolean;
  provenance: Provenance;
  /** Set whenever an import run created this page, whatever the label above says. */
  origin: ImportOrigin | null;
  /** How many reference fields the page carries. */
  references: number;
  version: number | null;
}

export interface GraphSourceNode {
  id: string;
  kind: 'source';
  name: string;
  /** Which connector resolves it — a source's equivalent of a page's type. */
  type: string;
  /** A source has no standing in the record; only pages carry status. */
  status: null;
  authMode: SourceAuthMode;
  freshnessWindowMs: number;
  provenance: 'federated';
  /** How many mapped pages reference it. */
  references: number;
}

export type GraphNode = GraphPageNode | GraphSourceNode;

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface KnowledgeGraph {
  collectionId: string;
  generatedAt: string;
  counts: { pages: number; external: number; sources: number; edges: number };
  /** True when a cap below was reached, so the map states that it is partial. */
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---- the whole record ------------------------------------------------------
//
// A second payload rather than a wider first one. `KnowledgeGraph` is a map OF
// a collection and says so in `collectionId`; this one is a map of the record,
// carries the collections it drew as data, and gives every node the two
// numbers a whole-record picture needs and a single-collection one does not:
// `degree`, which sizes it, and `rootId`, which clusters it.

/** A collection the record view drew, named so a client can label its cluster. */
export interface RecordGraphCollection {
  id: string;
  name: string;
}

/**
 * One node of the record view. Page and source are kept in ONE flat shape here
 * rather than the discriminated union `graph()` returns, because this payload
 * is laid out and sized by fields every node has to carry. A source's
 * `collectionId` is null — it belongs to no one collection, which is the whole
 * reason it is a governed object — and its `rootId` is its own id, so a client
 * clustering by `rootId` puts each source in a cluster of its own instead of
 * dropping it.
 */
export interface RecordGraphNode {
  id: string;
  kind: GraphNodeKind;
  /** The page's title, or the source's name. */
  title: string;
  /** The page's collection; null for a source. */
  collectionId: string | null;
  /** The page's document type, or the connector kind that resolves the source. */
  type: string;
  /** A source has no standing in the record; only pages carry status. */
  status: PageStatus | null;
  provenance: Provenance;
  /** Present whenever an import run created this page, whatever the label says. */
  importSource?: ImportSource;
  importFile?: string;
  /** Edges incident to this node IN THIS PAYLOAD. See recordGraph(). */
  degree: number;
  /** The top-most visible ancestor within the collection; itself, for a root. */
  rootId: string;
}

export interface RecordGraph {
  collections: RecordGraphCollection[];
  nodes: RecordGraphNode[];
  edges: GraphEdge[];
  /** Present only when the node cap was reached, and then it is exact. */
  truncated?: { limit: number; total: number };
}

export interface RecordGraphOptions {
  /** Which collections to draw. Empty or absent means every visible one. */
  collectionIds?: string[];
  /** Lower the page cap, for tests and for a client that wants a smaller read. */
  limit?: number;
}

// Caps. A map is a read of a whole collection, so it is the one Canon surface
// whose cost grows with the size of the record: without a ceiling, one request
// for a large collection builds every body into memory to parse its links.
// Both caps are far above what any map is readable at — the client stops
// drawing and switches to its list long before either — so they are here to
// bound the server, not to shape the picture.
export const MAX_GRAPH_PAGES = 1000;
/** Linked pages from OTHER collections, which the viewer may also see. */
export const MAX_LINKED_PAGES = 250;
/**
 * The record view's page cap, for the same reason and with one addition: when
 * it bites, the payload SAYS SO, with the cap and the true total. A quietly
 * short map is worse than no map — it is a picture of a record with pages
 * missing and no sign that any are.
 */
export const MAX_RECORD_GRAPH_NODES = 1500;

/**
 * DATA-BACKBONE.md §6's three patterns, decided in ONE place for both views.
 * See PRECEDENCE in the header: a page that was imported AND carries live
 * references reads as `federated`, with its origin still named.
 */
export function classifyProvenance(origin: ImportOrigin | null, references: number): Provenance {
  return references > 0 ? 'federated' : origin ? 'imported' : 'authored';
}

/**
 * The record view narrowed to a set of permitted collections, for a caller
 * that has to apply a SECOND permission rule after Canon's own — which today
 * means an agent, whose Registry limits narrow a spanning read rather than
 * refusing it (REGISTRY-CONTRACT.md §4.2). It lives here, beside the payload
 * it understands, so agentauth.ts holds the classification and not a second
 * copy of what a graph is.
 *
 * Dropping a collection drops its pages, every edge with an end among them,
 * and any source left with nothing referencing it — and then `degree` is
 * recomputed, because a degree over edges that are no longer in the payload is
 * a number about a graph nobody can see. `truncated` is left exactly as the
 * store reported it: it describes the read Canon performed, not the narrowing
 * applied to the answer afterwards.
 */
export function narrowRecordGraph(graph: RecordGraph, permitted: readonly string[]): RecordGraph {
  if (permitted.includes('*')) return graph;
  const allowed = new Set(permitted);
  const pages = new Set(
    graph.nodes.filter((n) => n.kind === 'page' && n.collectionId && allowed.has(n.collectionId)).map((n) => n.id),
  );
  const sources = new Set(graph.nodes.filter((n) => n.kind === 'source').map((n) => n.id));
  const edges = graph.edges.filter((e) => pages.has(e.from) && (pages.has(e.to) || sources.has(e.to)));
  const kept = new Set([...pages, ...edges.filter((e) => sources.has(e.to)).map((e) => e.to)]);
  const degrees = degreesOf(edges);
  return {
    collections: graph.collections.filter((c) => allowed.has(c.id)),
    nodes: graph.nodes.filter((n) => kept.has(n.id)).map((n) => ({ ...n, degree: degrees.get(n.id) ?? 0 })),
    edges,
    ...(graph.truncated ? { truncated: graph.truncated } : {}),
  };
}

/** Edge count per node, over exactly the edges given. */
function degreesOf(edges: readonly GraphEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string): void => {
    out.set(id, (out.get(id) ?? 0) + 1);
  };
  for (const edge of edges) {
    bump(edge.from);
    bump(edge.to);
  }
  return out;
}

// SQLite's default host-parameter limit is 999; ids go in well under it.
const ID_CHUNK = 400;

/** The minimal slice of CanonStore this service needs; CanonStore satisfies it. */
export interface GraphHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

interface PageRow {
  id: string;
  collection_id: string;
  parent_id: string | null;
  type: DocType;
  title: string;
  status: PageStatus;
  current_version: number | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/**
 * The collection's pages in reading order: depth-first, a parent before its
 * children, siblings in tree order. A page whose parent is not in the set —
 * archived, or in another collection — is a root of the map, exactly as it is a
 * root of the tree. Rows arrive already ordered by (position, id), so this only
 * regroups them; nothing here can drop a page, and the cycle guard is belt and
 * braces over `movePage`'s own.
 */
function treeOrder(rows: PageRow[]): string[] {
  const children = new Map<string | null, PageRow[]>();
  const known = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const parent = row.parent_id && known.has(row.parent_id) ? row.parent_id : null;
    const bucket = children.get(parent);
    if (bucket) bucket.push(row);
    else children.set(parent, [row]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null): void => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row.id);
      walk(row.id);
    }
  };
  walk(null);
  for (const row of rows) if (!seen.has(row.id)) out.push(row.id); // unreachable, kept honest
  return out;
}

export class GraphService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: GraphHost,
  ) {}

  /**
   * One collection's explicit graph, as the asking actor may see it.
   *
   * The `view` check below is not the permission rule — the SQL is. It is here
   * so a non-member is told "no access" rather than handed a plausible empty
   * map, which is the same distinction `tree()` makes.
   */
  graph(actorId: string, collectionId: string): KnowledgeGraph {
    this.host.getActor(actorId); // not_found for an unknown asker
    const exists = this.db.prepare('SELECT 1 AS hit FROM collections WHERE id = ?').get(collectionId) as
      | { hit: number }
      | undefined;
    if (!exists) throw new CanonError('not_found', `No such collection: ${collectionId}`);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to this collection —
    // one holding NO role in it — is told it does not exist, byte-for-byte as
    // its genuine absence reads, rather than being handed a 403 that names it.
    // A member refused a stronger act keeps the informative refusal below.
    if (!this.host.roleOf(actorId, collectionId)) {
      throw new CanonError('not_found', `No such collection: ${collectionId}`);
    }
    this.requireRole(actorId, collectionId, 'view');

    // ---- the collection's own pages -------------------------------------
    // Permission-filtered in the SELECT. Archived pages leave the map exactly
    // as they leave the tree: they are preserved with their history, but they
    // are no longer part of how the record hangs together.
    const rows = this.db
      .prepare(
        `SELECT p.id, p.collection_id, p.parent_id, p.type, p.title, p.status, p.current_version
         FROM pages p
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
         WHERE p.collection_id = ? AND p.status != 'archived'
         ORDER BY p.position, p.id
         LIMIT ?`,
      )
      .all(actorId, collectionId, MAX_GRAPH_PAGES + 1) as unknown as PageRow[];
    let truncated = rows.length > MAX_GRAPH_PAGES;
    const pages = rows.slice(0, MAX_GRAPH_PAGES);

    const nodes = new Map<string, GraphNode>();
    // Depth-first, parents before their children, siblings in the order the
    // tree shows them. `position` is per-parent, so the SQL order alone is not
    // a reading order — and the client's layout is seeded by this sequence, so
    // "the same record maps the same way twice" starts here.
    const order = treeOrder(pages);
    for (const row of pages) nodes.set(row.id, this.pageNode(row, false));

    // ---- links written in published bodies ------------------------------
    // Only published bodies: a link that exists solely in somebody's unsaved
    // draft is not yet part of the record, and the map draws the record.
    const links = new Map<string, string[]>();
    const wanted = new Set<string>();
    for (const group of chunk(order, ID_CHUNK)) {
      const bodies = this.db
        .prepare(
          `SELECT v.page_id, v.body
           FROM page_versions v
           JOIN pages p ON p.id = v.page_id AND v.number = p.current_version
           JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
           WHERE v.page_id IN (${placeholders(group.length)})`,
        )
        .all(actorId, ...group) as unknown as { page_id: string; body: string }[];
      for (const body of bodies) {
        const targets = parsePageLinks(body.body).filter((id) => id !== body.page_id);
        links.set(body.page_id, targets);
        for (const id of targets) if (!nodes.has(id)) wanted.add(id);
      }
    }

    // ---- asserted relations (DATA-BACKBONE.md §7) ------------------------
    // Read here, alongside the links, and for the same reason: a page this
    // collection conflicts with may live in another collection, and a
    // contradiction that crosses a boundary is precisely the one worth
    // drawing. So the far end joins `wanted` exactly as a link target does and
    // meets exactly the same permission filter below.
    const relations = this.relations(order);
    for (const relation of relations) {
      for (const end of [relation.fromPageId, relation.toPageId]) {
        if (!nodes.has(end)) wanted.add(end);
      }
    }

    // ---- linked pages in other collections ------------------------------
    // The permission filter's real work. An id that names no page, an archived
    // page, or a page in a collection this actor is not a member of resolves to
    // nothing here — and having produced no node, it can produce no edge.
    const external: string[] = [];
    for (const group of chunk([...wanted], ID_CHUNK)) {
      if (external.length >= MAX_LINKED_PAGES) {
        truncated = true;
        break;
      }
      const found = this.db
        .prepare(
          `SELECT p.id, p.collection_id, p.parent_id, p.type, p.title, p.status, p.current_version
           FROM pages p
           JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
           WHERE p.id IN (${placeholders(group.length)}) AND p.status != 'archived'
           ORDER BY p.title, p.id`,
        )
        .all(actorId, ...group) as unknown as PageRow[];
      for (const row of found) {
        if (external.length >= MAX_LINKED_PAGES) {
          truncated = true;
          break;
        }
        if (nodes.has(row.id)) continue;
        nodes.set(row.id, this.pageNode(row, true));
        external.push(row.id);
      }
    }

    const pageIds = [...order, ...external];

    // ---- provenance: imports and references ------------------------------
    const origins = this.origins(pageIds);
    const references = this.references(pageIds);

    for (const [pageId, origin] of origins) {
      const node = nodes.get(pageId);
      if (node?.kind === 'page') node.origin = origin;
    }

    const sourceNodes = new Map<string, GraphSourceNode>();
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const edge = (from: string, to: string, kind: GraphEdgeKind): void => {
      const key = `${kind} ${from} ${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, kind });
    };

    for (const reference of references) {
      const node = nodes.get(reference.pageId);
      if (node?.kind !== 'page') continue;
      node.references += 1;
      const source = sourceNodes.get(reference.sourceId) ?? {
        id: reference.sourceId,
        kind: 'source' as const,
        name: reference.sourceName,
        type: reference.sourceType,
        status: null,
        authMode: reference.authMode,
        freshnessWindowMs: reference.freshnessWindowMs,
        provenance: 'federated' as const,
        references: 0,
      };
      if (!sourceNodes.has(reference.sourceId)) sourceNodes.set(reference.sourceId, source);
      const before = edges.length;
      edge(reference.pageId, reference.sourceId, 'reference');
      if (edges.length > before) source.references += 1;
    }

    // The label, now that both facts are known. See PRECEDENCE in the header —
    // and note that the rule itself lives in `classifyProvenance`, which the
    // record view below calls too, so there is one answer rather than two.
    for (const id of pageIds) {
      const node = nodes.get(id);
      if (node?.kind !== 'page') continue;
      node.provenance = classifyProvenance(node.origin, node.references);
    }

    // ---- the tree, and the links people wrote ---------------------------
    for (const id of pageIds) {
      const node = nodes.get(id);
      if (node?.kind !== 'page') continue;
      // A child whose parent was archived (or lies outside what this viewer
      // may see) hangs at the root of the map, exactly as it hangs at the root
      // of the tree. The edge is dropped; the page is not.
      if (node.parentId && nodes.has(node.parentId)) edge(node.parentId, node.id, 'child');
      for (const target of links.get(id) ?? []) {
        if (nodes.has(target)) edge(id, target, 'link');
      }
    }

    // A relation is drawn only when BOTH of its ends are on the map. An
    // assertion reaching a page this viewer may not see is dropped whole,
    // never drawn to a placeholder: "this page contradicts something over
    // there you may not read" is a disclosure about a restricted collection,
    // and on a map of one it is the disclosure that matters.
    for (const relation of relations) {
      if (!nodes.has(relation.fromPageId) || !nodes.has(relation.toPageId)) continue;
      edge(relation.fromPageId, relation.toPageId, relation.kind);
    }

    const ordered: GraphNode[] = [
      ...order.map((id) => nodes.get(id)!),
      ...external.map((id) => nodes.get(id)!),
      ...[...sourceNodes.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    ];

    return {
      collectionId,
      generatedAt: new Date().toISOString(),
      counts: {
        pages: order.length,
        external: external.length,
        sources: sourceNodes.size,
        edges: edges.length,
      },
      truncated,
      nodes: ordered,
      edges,
    };
  }

  /**
   * The whole record as one graph: every collection the asking actor may view,
   * or the named subset of them, with the cross-collection links between them.
   *
   * There is no `requireRole` here and that is deliberate. This is a spanning
   * read, not a read OF something: a collection the asker cannot see is simply
   * not selected, exactly as it is not selected by search or by a structured
   * query, and naming one in `collectionIds` narrows the answer rather than
   * refusing it. The same rule then covers the agent case the Registry
   * contract states in those words (§4.2), applied to the same payload by
   * `narrowRecordGraph` above.
   *
   * Everything the map states about a node is computed over the FILTERED
   * graph — the nodes that survived permission and the cap, and the edges
   * between them. `degree` counts only edges in this payload, so hiding a
   * collection makes the degree of a page that linked into it fall; `rootId`
   * is the top-most ancestor still visible, so a page whose parent was
   * archived clusters as a root exactly as it hangs at the root of the tree.
   * A number computed over a graph the asker cannot see would be a fact about
   * the record leaking through arithmetic.
   */
  recordGraph(actorId: string, options: RecordGraphOptions = {}): RecordGraph {
    this.host.getActor(actorId); // not_found for an unknown asker
    const limit = Math.max(1, Math.min(options.limit ?? MAX_RECORD_GRAPH_NODES, MAX_RECORD_GRAPH_NODES));
    const asked = [...new Set((options.collectionIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const collections = this.visibleCollections(actorId, asked);

    // ---- the pages, per collection, in reading order ---------------------
    // One pair of queries per collection rather than one big `IN`: it keeps
    // the cap honest (the count is the true total even when the rows are cut
    // short) and it keeps the reading order per collection, which is what the
    // client lays out. Permission is in the SELECT, as everywhere else.
    let total = 0;
    const pages: PageRow[] = [];
    for (const collection of collections) {
      const counted = this.db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM pages p
             JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
            WHERE p.collection_id = ? AND p.status != 'archived'`,
        )
        .get(actorId, collection.id) as { n: number } | undefined;
      total += Number(counted?.n ?? 0);
      const remaining = limit - pages.length;
      if (remaining <= 0) continue;
      const rows = this.db
        .prepare(
          `SELECT p.id, p.collection_id, p.parent_id, p.type, p.title, p.status, p.current_version
             FROM pages p
             JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
            WHERE p.collection_id = ? AND p.status != 'archived'
            ORDER BY p.position, p.id
            LIMIT ?`,
        )
        .all(actorId, collection.id, remaining) as unknown as PageRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of treeOrder(rows)) pages.push(byId.get(id)!);
    }
    const truncated = total > pages.length;

    const rows = new Map(pages.map((row) => [row.id, row]));
    const order = pages.map((row) => row.id);

    // ---- links written in published bodies -------------------------------
    // Only links whose target is also a node here. A target outside the
    // selection — another collection, an archived page, a page this asker may
    // not see, or a page past the cap — produces no edge at all, because the
    // record view never draws an edge to something it is not also drawing.
    const links = new Map<string, string[]>();
    for (const group of chunk(order, ID_CHUNK)) {
      const bodies = this.db
        .prepare(
          `SELECT v.page_id, v.body
             FROM page_versions v
             JOIN pages p ON p.id = v.page_id AND v.number = p.current_version
             JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
            WHERE v.page_id IN (${placeholders(group.length)})`,
        )
        .all(actorId, ...group) as unknown as { page_id: string; body: string }[];
      for (const body of bodies) {
        links.set(
          body.page_id,
          parsePageLinks(body.body).filter((id) => id !== body.page_id && rows.has(id)),
        );
      }
    }

    // ---- provenance ------------------------------------------------------
    const origins = this.origins(order);
    const references = this.references(order);

    // Reference FIELDS per page, not reference edges: provenance asks whether
    // a page reads from a live system at all, and two fields against one
    // source are one edge but two dependencies.
    const fieldCounts = new Map<string, number>();
    const sources = new Map<string, { name: string; type: string }>();
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const edge = (from: string, to: string, kind: GraphEdgeKind): void => {
      const key = `${kind} ${from} ${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, kind });
    };

    // ---- the tree, and the links people wrote ----------------------------
    for (const row of pages) {
      if (row.parent_id && rows.has(row.parent_id)) edge(row.parent_id, row.id, 'child');
      for (const target of links.get(row.id) ?? []) edge(row.id, target, 'link');
    }
    for (const reference of references) {
      if (!rows.has(reference.pageId)) continue;
      sources.set(reference.sourceId, { name: reference.sourceName, type: reference.sourceType });
      fieldCounts.set(reference.pageId, (fieldCounts.get(reference.pageId) ?? 0) + 1);
      edge(reference.pageId, reference.sourceId, 'reference');
    }
    // Asserted relations (§7), on the record view's own terms: both ends must
    // already be nodes here. The record view never expands to reach something
    // it is not drawing — a relation to a page past the cap, in a collection
    // this asker cannot see, or archived, produces no edge at all.
    for (const relation of this.relations(order)) {
      if (!rows.has(relation.fromPageId) || !rows.has(relation.toPageId)) continue;
      edge(relation.fromPageId, relation.toPageId, relation.kind);
    }

    const degrees = degreesOf(edges);
    const roots = this.rootIds(rows);

    const nodes: RecordGraphNode[] = pages.map((row) => {
      const origin = origins.get(row.id) ?? null;
      return {
        id: row.id,
        kind: 'page',
        title: row.title,
        collectionId: row.collection_id,
        type: row.type,
        status: row.status,
        provenance: classifyProvenance(origin, fieldCounts.get(row.id) ?? 0),
        ...(origin ? { importSource: origin.system, importFile: origin.file } : {}),
        degree: degrees.get(row.id) ?? 0,
        rootId: roots.get(row.id) ?? row.id,
      };
    });
    for (const [id, source] of [...sources].sort(
      (a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]),
    )) {
      nodes.push({
        id,
        kind: 'source',
        title: source.name,
        collectionId: null,
        type: source.type,
        status: null,
        provenance: 'federated',
        degree: degrees.get(id) ?? 0,
        rootId: id,
      });
    }

    return {
      collections,
      nodes,
      edges,
      ...(truncated ? { truncated: { limit, total } } : {}),
    };
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The collections this actor may view, narrowed to those asked for. An id
   * naming a collection they are not a member of — or no collection at all —
   * contributes nothing and is not reported back: the answer says which
   * collections it drew, and that is the honest thing for it to say.
   */
  private visibleCollections(actorId: string, asked: string[]): RecordGraphCollection[] {
    const out: RecordGraphCollection[] = [];
    const push = (rows: { id: string; name: string }[]): void => {
      for (const row of rows) out.push({ id: row.id, name: row.name });
    };
    if (!asked.length) {
      push(
        this.db
          .prepare(
            `SELECT c.id, c.name
               FROM collections c
               JOIN collection_members m ON m.collection_id = c.id AND m.actor_id = ?
              WHERE c.archived_at IS NULL
              ORDER BY c.name, c.id`,
          )
          .all(actorId) as unknown as { id: string; name: string }[],
      );
    } else {
      for (const group of chunk(asked, ID_CHUNK)) {
        push(
          this.db
            .prepare(
              `SELECT c.id, c.name
                 FROM collections c
                 JOIN collection_members m ON m.collection_id = c.id AND m.actor_id = ?
                WHERE c.archived_at IS NULL AND c.id IN (${placeholders(group.length)})
                ORDER BY c.name, c.id`,
            )
            .all(actorId, ...group) as unknown as { id: string; name: string }[],
        );
      }
      out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }
    return out;
  }

  /**
   * Each page's top-most VISIBLE ancestor, which is what a client clusters by.
   * The walk stops at a parent that is not among the selected rows — archived,
   * in a collection this asker cannot see, or past the cap — because that page
   * hangs at the root of the map exactly as it hangs at the root of the tree.
   * Memoized, and guarded against a cycle that `movePage` already forbids.
   */
  private rootIds(rows: Map<string, PageRow>): Map<string, string> {
    const roots = new Map<string, string>();
    for (const id of rows.keys()) {
      const path: string[] = [];
      const walked = new Set<string>();
      let cursor: string | undefined = id;
      let root = id;
      while (cursor && !walked.has(cursor)) {
        const cached = roots.get(cursor);
        if (cached) {
          root = cached;
          break;
        }
        walked.add(cursor);
        path.push(cursor);
        root = cursor;
        const parent: string | null = rows.get(cursor)?.parent_id ?? null;
        cursor = parent && rows.has(parent) ? parent : undefined;
      }
      for (const step of path) roots.set(step, root);
    }
    return roots;
  }

  private pageNode(row: PageRow, external: boolean): GraphPageNode {
    return {
      id: row.id,
      kind: 'page',
      title: row.title,
      type: row.type,
      status: row.status,
      collectionId: row.collection_id,
      parentId: row.parent_id ?? null,
      external,
      provenance: 'authored', // settled below, once imports and references are known
      origin: null,
      references: 0,
      version: row.current_version ?? null,
    };
  }

  /**
   * The import run that put each page in the record. A page can be touched by
   * several runs — a re-run writes a new version of the same page — so the run
   * that CREATED it is the origin: the row whose outcome is `imported`, and
   * failing that the earliest row there is.
   */
  private origins(pageIds: string[]): Map<string, ImportOrigin> {
    const out = new Map<string, ImportOrigin>();
    const created = new Set<string>();
    for (const group of chunk(pageIds, ID_CHUNK)) {
      if (!group.length) continue;
      const rows = this.db
        .prepare(
          `SELECT i.page_id, i.run_id, i.source_path, i.outcome, i.at, r.source AS system
           FROM import_items i
           JOIN import_runs r ON r.id = i.run_id
           WHERE i.page_id IN (${placeholders(group.length)})
           ORDER BY i.at, i.run_id, i.source_path`,
        )
        .all(...group) as unknown as {
        page_id: string;
        run_id: string;
        source_path: string;
        outcome: string;
        at: string;
        system: ImportSource;
      }[];
      for (const row of rows) {
        if (created.has(row.page_id)) continue;
        if (out.has(row.page_id) && row.outcome !== 'imported') continue;
        out.set(row.page_id, {
          system: row.system,
          file: row.source_path,
          runId: row.run_id,
          at: row.at,
        });
        if (row.outcome === 'imported') created.add(row.page_id);
      }
    }
    return out;
  }

  /**
   * The relations asserted on those pages (DATA-BACKBONE.md §7), from either
   * end. No permission filter here and none needed: the caller only ever draws
   * an edge between two nodes it has already selected, and every node was
   * selected through the asker's own membership join. A relation whose far end
   * did not survive that join therefore cannot become an edge — which is the
   * same rule links live under, applied in the same place.
   *
   * `conflicts_with` is stored once with its pair canonically ordered, so a
   * symmetric relation comes back once however it is reached; the DISTINCT
   * guards only against a pair where both ends are in the same chunk.
   */
  private relations(pageIds: string[]): { fromPageId: string; toPageId: string; kind: RelationKind }[] {
    const out: { fromPageId: string; toPageId: string; kind: RelationKind }[] = [];
    const seen = new Set<string>();
    for (const group of chunk(pageIds, ID_CHUNK)) {
      if (!group.length) continue;
      const marks = placeholders(group.length);
      const rows = this.db
        .prepare(
          `SELECT id, from_page_id, to_page_id, kind
             FROM page_relations
            WHERE from_page_id IN (${marks}) OR to_page_id IN (${marks})
            ORDER BY asserted_at, rowid`,
        )
        .all(...group, ...group) as unknown as {
        id: string;
        from_page_id: string;
        to_page_id: string;
        kind: RelationKind;
      }[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push({ fromPageId: row.from_page_id, toPageId: row.to_page_id, kind: row.kind });
      }
    }
    return out;
  }

  /**
   * The reference fields those pages carry, with the source each resolves
   * against. Nothing is resolved here: a map states that a page depends on a
   * system, which is a fact of the record, and reaching the system is a
   * separate, audited act (references.ts).
   */
  private references(pageIds: string[]): {
    pageId: string;
    sourceId: string;
    sourceName: string;
    sourceType: string;
    authMode: SourceAuthMode;
    freshnessWindowMs: number;
  }[] {
    const out: {
      pageId: string;
      sourceId: string;
      sourceName: string;
      sourceType: string;
      authMode: SourceAuthMode;
      freshnessWindowMs: number;
    }[] = [];
    for (const group of chunk(pageIds, ID_CHUNK)) {
      if (!group.length) continue;
      const rows = this.db
        .prepare(
          `SELECT r.page_id, r.source_id, s.name, s.kind, s.auth_mode, s.freshness_window_ms
           FROM page_references r
           JOIN sources s ON s.id = r.source_id
           WHERE r.page_id IN (${placeholders(group.length)})
           ORDER BY r.created_at, r.id`,
        )
        .all(...group) as unknown as {
        page_id: string;
        source_id: string;
        name: string;
        kind: string;
        auth_mode: SourceAuthMode;
        freshness_window_ms: number;
      }[];
      for (const row of rows) {
        out.push({
          pageId: row.page_id,
          sourceId: row.source_id,
          sourceName: row.name,
          sourceType: row.kind,
          authMode: row.auth_mode,
          freshnessWindowMs: row.freshness_window_ms,
        });
      }
    }
    return out;
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw new CanonError('forbidden', `Requires ${needed} access to this collection`, {
        collectionId,
        needed,
        held: role,
      });
    }
  }
}
