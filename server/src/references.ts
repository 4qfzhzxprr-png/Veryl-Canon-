import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, Role, ROLE_RANK } from './model.js';
import { Asker, ConnectorRegistry, ResolveRequest } from './connectors.js';
import { Source, SourceAuthMode, SourceService } from './sources.js';
import { refuseUnpermittedSource } from './agentauth.js';

// Federation, part three: reference fields and their resolution
// (DATA-BACKBONE.md §6). A reference field is a structured field on a page
// whose value is NOT stored but resolved:
//
//     { sourceId, selector, key }
//
// resolving to:
//
//     { value, resolvedAt, fromCache, stale, sourceName, error? }
//
// Structure over prose (principle 2): a reference is data on the page, never a
// pattern parsed out of a body. It lives in its own table for the same reason
// comments do — the page's immutable version fields describe what the page
// *says*, while a reference describes what the page *reaches*, and the two
// have different lifecycles. Nothing here ever reads a page body.
//
// THE THREE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. Never copy the fact. The cache below holds the last resolved value with
//    the time it was fetched, and that is allowed precisely because it is
//    labelled, timestamped, and never authoritative. Past the source's
//    freshness window the value is still returned — a page that will not
//    render because an API is down is a bad page — but it is returned with
//    `stale: true`, never presented as current.
//
// 2. Never invent a value. A connector failure returns the last cached value
//    marked stale WITH the error, or an error and no value at all when
//    nothing was ever cached. There is no default, no zero, no guess.
//
// 3. Never launder a permission. The asker must hold `view` on the page's
//    collection before anything is resolved. A `per_asker` source then
//    carries the asker's own identity to the source, and ITS CACHE IS KEYED
//    PER ASKER, so one actor's entitled value can never be served to another
//    actor. A `service` source resolves once, and that value is visible to
//    everyone who can view the collection — which is what choosing that mode
//    means, stated in those words.
//
// Every resolution is an audit event (`reference.resolve`) naming who asked,
// which source, which page and selector, and whether the value came from the
// source or from the cache. That log is what makes federation defensible to a
// compliance lead; it is load-bearing, not decoration.

export const REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_references (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES pages(id),
  source_id  TEXT NOT NULL REFERENCES sources(id),
  selector   TEXT NOT NULL,
  ref_key    TEXT NOT NULL,
  label      TEXT,
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE (page_id, source_id, selector, ref_key)
);

CREATE INDEX IF NOT EXISTS idx_page_references_page ON page_references(page_id);
CREATE INDEX IF NOT EXISTS idx_page_references_source ON page_references(source_id);

CREATE TABLE IF NOT EXISTS reference_cache (
  reference_id TEXT NOT NULL REFERENCES page_references(id),
  asker_id     TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  resolved_at  TEXT NOT NULL,
  PRIMARY KEY (reference_id, asker_id)
);
`;

// asker_id on a cache row: the asking actor for a per_asker source, and this
// sentinel for a service source, whose one value belongs to the collection
// rather than to a person. An empty string can never collide with an actor id.
const SERVICE_ASKER = '';

/** The unresolved descriptor: what the page carries, and what the UI renders. */
export interface PageReference {
  id: string;
  pageId: string;
  sourceId: string;
  sourceName: string;
  /** The source's mode, so a reader can see a service-resolved value for what it is. */
  authMode: SourceAuthMode;
  selector: string;
  key: string;
  label: string | null;
  createdBy: string;
  createdAt: string;
}

/** The resolved shape, exactly per DATA-BACKBONE.md §6. */
export interface ResolvedReference {
  referenceId: string;
  sourceId: string;
  sourceName: string;
  authMode: SourceAuthMode;
  selector: string;
  key: string;
  label: string | null;
  /** Null only when nothing could be resolved and nothing was ever cached. */
  value: unknown;
  resolvedAt: string | null;
  fromCache: boolean;
  stale: boolean;
  error?: string;
}

export interface ReferenceInput {
  sourceId: string;
  selector: string;
  key: string;
  label?: string | null;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface ReferenceHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function now(): string {
  return new Date().toISOString();
}

export class ReferenceService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: ReferenceHost,
    private readonly sources: SourceService,
    private readonly connectors: ConnectorRegistry,
  ) {}

  // ---- the reference field on a page ----------------------------------

  add(actorId: string, pageId: string, input: ReferenceInput): PageReference {
    const actor = this.host.getActor(actorId);
    const page = this.page(pageId);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (!input?.sourceId) throw new CanonError('invalid', 'A reference names its source');
    if (!input.selector?.trim()) throw new CanonError('invalid', 'A reference names what to ask the source for');
    if (!input.key?.trim()) throw new CanonError('invalid', 'A reference carries the key to ask the source with');

    const source = this.sources.row(input.sourceId);
    if (!this.sources.permittedIn(source, page.collectionId)) {
      throw new CanonError('forbidden', `Source '${source.name}' may not be referenced from this collection`, {
        sourceId: source.id,
        collectionId: page.collectionId,
      });
    }

    const id = randomUUID();
    const selector = input.selector.trim();
    const key = input.key.trim();
    try {
      this.db
        .prepare(
          `INSERT INTO page_references (id, page_id, source_id, selector, ref_key, label, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, pageId, source.id, selector, key, input.label?.trim() || null, actorId, now());
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new CanonError('conflict', 'This page already carries that reference', {
          sourceId: source.id,
          selector,
          key,
        });
      }
      throw err;
    }

    this.audit(actor, 'reference.add', {
      collectionId: page.collectionId,
      pageId,
      details: { referenceId: id, sourceId: source.id, sourceName: source.name, selector, key },
    });
    return this.reference(id);
  }

  remove(actorId: string, referenceId: string): void {
    const actor = this.host.getActor(actorId);
    const reference = this.reference(referenceId);
    const page = this.page(reference.pageId);
    this.requireRole(actorId, page.collectionId, 'edit');
    this.db.prepare('DELETE FROM reference_cache WHERE reference_id = ?').run(referenceId);
    this.db.prepare('DELETE FROM page_references WHERE id = ?').run(referenceId);
    this.audit(actor, 'reference.remove', {
      collectionId: page.collectionId,
      pageId: reference.pageId,
      details: {
        referenceId,
        sourceId: reference.sourceId,
        sourceName: reference.sourceName,
        selector: reference.selector,
        key: reference.key,
      },
    });
  }

  /**
   * The unresolved descriptors a page carries. This is what travels inside the
   * page payload the UI already fetches, so a page renders its references
   * without a second call; resolution stays on its own endpoint because it
   * reaches outside Canon and is audited per call.
   */
  list(actorId: string, pageId: string): PageReference[] {
    const page = this.page(pageId);
    this.requireRole(actorId, page.collectionId, 'view');
    const rows = this.db
      .prepare('SELECT id FROM page_references WHERE page_id = ? ORDER BY created_at, id')
      .all(pageId) as { id: string }[];
    return rows.map((r) => this.reference(r.id));
  }

  // ---- resolution ------------------------------------------------------

  /**
   * Resolves every reference on a page for the asking actor. One audit event
   * per reference, and never a throw for a source that failed: a failure is
   * data on the returned reference, because the page must still render and
   * the reader must still be told.
   */
  async resolveReferences(actorId: string, pageId: string): Promise<ResolvedReference[]> {
    const actor = this.host.getActor(actorId);
    const page = this.page(pageId);
    // Canon's own permission first, always. Nothing reaches a source on
    // behalf of an actor who may not read the page.
    this.requireRole(actorId, page.collectionId, 'view');

    const references = this.db
      .prepare('SELECT id FROM page_references WHERE page_id = ? ORDER BY created_at, id')
      .all(pageId) as { id: string }[];

    const resolved: ResolvedReference[] = [];
    for (const row of references) {
      const reference = this.reference(row.id);
      // The Registry's half of the intersection, per reference. An agent may
      // read this page and still be barred from the source behind one of its
      // values (DATA-BACKBONE.md §6, REGISTRY-CONTRACT.md §4). The refusal is
      // returned as data on the reference rather than dropping it, because a
      // silently missing value reads as "there is no such value". Returns null
      // for people, and for agents the Registry does permit.
      const refusal = refuseUnpermittedSource(reference.sourceId, {
        referenceId: reference.id,
        pageId,
        sourceName: reference.sourceName,
        authMode: reference.authMode,
        selector: reference.selector,
        key: reference.key,
      });
      if (refusal) {
        const source = this.sources.row(reference.sourceId);
        resolved.push({
          referenceId: reference.id,
          sourceId: source.id,
          sourceName: source.name,
          authMode: source.authMode,
          selector: reference.selector,
          key: reference.key,
          label: reference.label,
          value: null,
          resolvedAt: null,
          fromCache: false,
          stale: false,
          error: refusal.message,
        });
        continue;
      }
      const result = await this.resolveOne(actor, page.collectionId, reference);
      resolved.push(result);
    }
    return resolved;
  }

  // ---- internals -------------------------------------------------------

  private async resolveOne(
    actor: Actor,
    collectionId: string,
    reference: PageReference,
  ): Promise<ResolvedReference> {
    const source = this.sources.row(reference.sourceId);
    const base = {
      referenceId: reference.id,
      sourceId: source.id,
      sourceName: source.name,
      authMode: source.authMode,
      selector: reference.selector,
      key: reference.key,
      label: reference.label,
    };
    // A per_asker value belongs to its asker; a service value belongs to the
    // collection. The cache key says which, and that is what keeps one
    // actor's entitled value from reaching another's screen.
    const askerId = source.authMode === 'per_asker' ? actor.id : SERVICE_ASKER;
    const cached = this.cached(reference.id, askerId);

    // The scope can change after a reference is written. A source no longer
    // permitted here resolves to nothing — visibly, with the reason — rather
    // than quietly continuing to serve a value into a collection an
    // administrator has removed it from.
    if (!this.sources.permittedIn(source, collectionId)) {
      const error = `Source '${source.name}' is no longer permitted in this collection`;
      this.auditResolve(actor, collectionId, reference, source, { origin: 'none', stale: false, error });
      return { ...base, value: null, resolvedAt: null, fromCache: false, stale: false, error };
    }

    if (cached && this.isFresh(cached.resolvedAt, source.freshnessWindowMs)) {
      this.auditResolve(actor, collectionId, reference, source, { origin: 'cache', stale: false });
      return { ...base, value: cached.value, resolvedAt: cached.resolvedAt, fromCache: true, stale: false };
    }

    try {
      const request: ResolveRequest = {
        selector: reference.selector,
        key: reference.key,
        // per_asker carries the asker into the source; service does not, and
        // the null is the honest statement of that difference.
        asker: source.authMode === 'per_asker' ? askerOf(actor) : null,
      };
      const answer = await this.connectors.get(source.kind).resolve(source, request);
      if (answer === null || answer === undefined || answer.value === undefined) {
        throw new CanonError('unavailable', `Source '${source.name}' returned no value`);
      }
      const resolvedAt = answer.resolvedAt || now();
      this.writeCache(reference.id, askerId, answer.value, resolvedAt);
      this.auditResolve(actor, collectionId, reference, source, { origin: 'source', stale: false });
      return { ...base, value: answer.value, resolvedAt, fromCache: false, stale: false };
    } catch (err) {
      const error = (err as Error).message || String(err);
      if (cached) {
        // Staleness is unavoidable, so it is displayed rather than hidden:
        // the last known value, its fetch time, the stale mark, and the
        // reason it could not be refreshed.
        this.auditResolve(actor, collectionId, reference, source, { origin: 'cache', stale: true, error });
        return {
          ...base,
          value: cached.value,
          resolvedAt: cached.resolvedAt,
          fromCache: true,
          stale: true,
          error,
        };
      }
      // Nothing was ever cached: an error and no value. Never a guess.
      this.auditResolve(actor, collectionId, reference, source, { origin: 'none', stale: false, error });
      return { ...base, value: null, resolvedAt: null, fromCache: false, stale: false, error };
    }
  }

  // Strictly inside the window: a window of 0 means "always ask the source",
  // which is what an administrator setting 0 is asking for.
  private isFresh(resolvedAt: string, freshnessWindowMs: number): boolean {
    const age = Date.now() - Date.parse(resolvedAt);
    if (!Number.isFinite(age)) return false;
    return age >= 0 && age < freshnessWindowMs;
  }

  private cached(referenceId: string, askerId: string): { value: unknown; resolvedAt: string } | null {
    const row = this.db
      .prepare('SELECT value_json, resolved_at FROM reference_cache WHERE reference_id = ? AND asker_id = ?')
      .get(referenceId, askerId) as { value_json: string; resolved_at: string } | undefined;
    if (!row) return null;
    return { value: JSON.parse(row.value_json) as unknown, resolvedAt: row.resolved_at };
  }

  private writeCache(referenceId: string, askerId: string, value: unknown, resolvedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO reference_cache (reference_id, asker_id, value_json, resolved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (reference_id, asker_id)
         DO UPDATE SET value_json = excluded.value_json, resolved_at = excluded.resolved_at`,
      )
      .run(referenceId, askerId, JSON.stringify(value ?? null), resolvedAt);
  }

  private reference(id: string): PageReference {
    const row = this.db
      .prepare(
        `SELECT r.*, s.name AS source_name, s.auth_mode AS auth_mode
         FROM page_references r JOIN sources s ON s.id = r.source_id WHERE r.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such reference: ${id}`);
    return {
      id: row.id as string,
      pageId: row.page_id as string,
      sourceId: row.source_id as string,
      sourceName: row.source_name as string,
      authMode: row.auth_mode as SourceAuthMode,
      selector: row.selector as string,
      key: row.ref_key as string,
      label: (row.label as string) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }

  private page(id: string): { id: string; collectionId: string } {
    const row = this.db.prepare('SELECT id, collection_id FROM pages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return { id: row.id as string, collectionId: row.collection_id as string };
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

  // The federation log. Who asked, which source, which page and selector, and
  // whether the value came from the source or the cache — plus the failure
  // when there was one, so an outage is as legible afterwards as it was live.
  private auditResolve(
    actor: Actor,
    collectionId: string,
    reference: PageReference,
    source: Source,
    outcome: { origin: 'source' | 'cache' | 'none'; stale: boolean; error?: string },
  ): void {
    this.audit(actor, 'reference.resolve', {
      collectionId,
      pageId: reference.pageId,
      details: {
        referenceId: reference.id,
        sourceId: source.id,
        sourceName: source.name,
        authMode: source.authMode,
        selector: reference.selector,
        key: reference.key,
        origin: outcome.origin,
        fromCache: outcome.origin === 'cache',
        stale: outcome.stale,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });
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
        now(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}

function askerOf(actor: Actor): Asker {
  return {
    actorId: actor.id,
    kind: actor.kind,
    name: actor.name,
    email: actor.email,
    registryRef: actor.registryRef,
  };
}
