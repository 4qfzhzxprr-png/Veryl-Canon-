import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, DocType, PageStatus, Role, ROLE_RANK } from './model.js';
import { parsePageLinks } from './retrieval.js';
import type { ImportSource } from './import.js';
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
// So this file draws exactly three kinds of edge, every one of them something a
// person or an agent wrote down:
//
//   child      parent → child, the page tree of §4
//   link       page → page, a link written in a PUBLISHED body
//   reference  page → source, a reference field of §6
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

export type GraphNodeKind = 'page' | 'source';

/** DATA-BACKBONE.md §6's three patterns, as a label on a node. */
export type Provenance = 'authored' | 'imported' | 'federated';
export const PROVENANCES: readonly Provenance[] = ['authored', 'imported', 'federated'];

/** The explicit graph's three edges. Nothing else is ever emitted. */
export type GraphEdgeKind = 'child' | 'link' | 'reference';
export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = ['child', 'link', 'reference'];

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

// Caps. A map is a read of a whole collection, so it is the one Canon surface
// whose cost grows with the size of the record: without a ceiling, one request
// for a large collection builds every body into memory to parse its links.
// Both caps are far above what any map is readable at — the client stops
// drawing and switches to its list long before either — so they are here to
// bound the server, not to shape the picture.
export const MAX_GRAPH_PAGES = 1000;
/** Linked pages from OTHER collections, which the viewer may also see. */
export const MAX_LINKED_PAGES = 250;

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

    // The label, now that both facts are known. See PRECEDENCE in the header.
    for (const id of pageIds) {
      const node = nodes.get(id);
      if (node?.kind !== 'page') continue;
      node.provenance = node.references > 0 ? 'federated' : node.origin ? 'imported' : 'authored';
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

  // ---- internals ---------------------------------------------------------

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
