import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CAN,
  cannot,
  collectionName,
  forbiddenRole,
  needsOrgRole,
  needsRoleHere,
  whoHoldsOrgRole,
} from './abilities.js';
import { Actor, CanonError, PageAbility, Role, ROLE_RANK } from './model.js';
import { OutboundPolicy, OutboundRefused, assertRegistrableBaseUrl, defaultOutboundPolicy } from './outbound.js';
import { ORG_ROLE_RANK, isOrgOperator, orgRoleOf } from './orgrole.js';

// Federation, part one: the registered external systems Canon may resolve a
// value from (DATA-BACKBONE.md §6). A Source is a governed object, registered
// and limited the way agents are — because if a connection to an external
// system were ungoverned, the Registry's limits would stop at Canon's door and
// an agent barred from a collection could read the same facts through the
// source behind it.
//
// The shape is the document's, exactly:
//   id, name, kind, baseUrl, authMode (per_asker | service), freshnessWindowMs,
//   owner (here: createdBy), and the collections it may be referenced from.
//
// CANON STORES NO SECRET MATERIAL FOR A SOURCE. There is deliberately no
// credential column below, and there never will be one: a per-asker credential
// is never stored (that is the whole point of `per_asker` — the asker's own
// identity travels to the source at resolution time), and a service
// credential belongs to the deployment's configuration, which the connector
// reads for itself. Canon holds the *reference*, exactly as it holds a
// Registry reference on an agent actor rather than a copied credential
// (DATA-BACKBONE.md §3, "What Canon deliberately does not store"). If a future
// change wants to add a `credential` column here, that is the change to
// refuse.
//
// SCOPE, and what an empty scope means. A source may be scoped to a set of
// collections: those, and only those, may hold references to it. A source
// with NO scoped collections is Canon-wide — referenceable from every
// collection in Core. That is the simple choice and it is stated here so it is
// never a surprise: an unscoped source is a deliberate act by an administrator,
// not a default that leaked.
//
// WHO MAY REGISTER ONE. Changing a source changes what the record can reach,
// so it takes `admin`:
//   - a scoped source requires admin on *every* collection in its scope, both
//     before and after a change, so nobody can move a source into or out of a
//     collection they do not administer;
//   - an unscoped (Canon-wide) source requires the org-level `operator` role
//     (orgrole.ts). This used to read "admin on at least one collection" — the
//     stand-in for an organisation role Canon did not have — and this comment
//     said it was "the one check to change" when that role arrived. It has.

export const SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  base_url            TEXT NOT NULL DEFAULT '',
  auth_mode           TEXT NOT NULL CHECK (auth_mode IN ('per_asker', 'service')),
  freshness_window_ms INTEGER NOT NULL,
  created_by          TEXT NOT NULL REFERENCES actors(id),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_collections (
  source_id     TEXT NOT NULL REFERENCES sources(id),
  collection_id TEXT NOT NULL REFERENCES collections(id),
  PRIMARY KEY (source_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_source_collections_collection
  ON source_collections(collection_id);
`;

// Whose permissions the resolution carries (DATA-BACKBONE.md §6, "Whose
// permissions"). `per_asker` sends the asking actor's identity to the source,
// so the source decides. `service` resolves once with the deployment's own
// account, and the resulting value is treated as visible to everyone who can
// view the collection — an administrator choosing it is choosing to publish
// the value to that collection, and the product says so in those words.
export type SourceAuthMode = 'per_asker' | 'service';
export const SOURCE_AUTH_MODES: readonly SourceAuthMode[] = ['per_asker', 'service'];

export interface Source {
  id: string;
  name: string;
  kind: string; // which connector resolves it; see connectors.ts
  baseUrl: string;
  authMode: SourceAuthMode;
  freshnessWindowMs: number;
  /** Collections this source may be referenced from. Empty = Canon-wide. */
  collectionIds: string[];
  createdBy: string;
  createdAt: string;
}

/**
 * What the asking actor may do to one registered source. Same shape and same
 * discipline as `PageAbilities` (model.ts): a mirror of the checks in this
 * file, never one of them.
 */
export interface SourceAbilities {
  edit: PageAbility;
  delete: PageAbility;
}

// The three acts on a source, each in its own words, so the sentence a screen
// SHOWS and the sentence a request GETS are the same sentence. `wide` is the
// same act aimed at a Canon-wide source, which is an org-level act rather than
// a collection one and says so.
const REGISTER_SOURCE = { scoped: 'Registering this source', wide: 'Registering a Canon-wide source' };
const EDIT_SOURCE = { scoped: 'Changing this source', wide: 'Changing a Canon-wide source' };
const DELETE_SOURCE = { scoped: 'Deleting this source', wide: 'Deleting a Canon-wide source' };

export interface SourceInput {
  name: string;
  kind: string;
  baseUrl?: string;
  authMode: SourceAuthMode;
  freshnessWindowMs: number;
  collectionIds?: string[];
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface SourceHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function now(): string {
  return new Date().toISOString();
}

export class SourceService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: SourceHost,
    /**
     * Which hosts this deployment may reach (outbound.ts). A source is a
     * governed object, and where it points is the governed part: an
     * operator-supplied baseUrl is otherwise a server-side request forgery
     * primitive aimed at whatever is inside the network. Defaults to the
     * process-wide policy, which permits nothing until a deployment says so.
     */
    private readonly outbound: OutboundPolicy = defaultOutboundPolicy(),
  ) {}

  create(actorId: string, input: SourceInput): Source {
    const actor = this.host.getActor(actorId);
    const draft = this.validate(input);
    this.requireSourceAdmin(actorId, draft.collectionIds);

    const source: Source = {
      id: randomUUID(),
      ...draft,
      createdBy: actorId,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO sources
           (id, name, kind, base_url, auth_mode, freshness_window_ms, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        source.name,
        source.kind,
        source.baseUrl,
        source.authMode,
        source.freshnessWindowMs,
        source.createdBy,
        source.createdAt,
      );
    this.setScope(source.id, source.collectionIds);
    this.audit(actor, 'source.create', {
      details: {
        sourceId: source.id,
        name: source.name,
        kind: source.kind,
        authMode: source.authMode,
        freshnessWindowMs: source.freshnessWindowMs,
        collectionIds: source.collectionIds,
      },
    });
    return this.row(source.id);
  }

  update(actorId: string, id: string, input: Partial<SourceInput>): Source {
    const actor = this.host.getActor(actorId);
    const before = this.row(id);
    // Same rule as `get`: you cannot administer what you cannot see, and a
    // source you cannot see answers as one that does not exist (SECURITY.md
    // R4). A member who can see it and simply lacks admin still gets the
    // explanatory `forbidden` from requireSourceAdmin below.
    this.requireVisible(actorId, before);
    const merged = this.validate({
      name: input.name ?? before.name,
      kind: input.kind ?? before.kind,
      baseUrl: input.baseUrl ?? before.baseUrl,
      authMode: input.authMode ?? before.authMode,
      freshnessWindowMs: input.freshnessWindowMs ?? before.freshnessWindowMs,
      collectionIds: input.collectionIds ?? before.collectionIds,
    });
    // Admin under both the old scope and the new one: a source cannot be
    // walked out of a collection you administer, nor into one you do not.
    this.requireSourceAdmin(actorId, before.collectionIds, EDIT_SOURCE);
    this.requireSourceAdmin(actorId, merged.collectionIds, EDIT_SOURCE);

    this.db
      .prepare(
        `UPDATE sources SET name = ?, kind = ?, base_url = ?, auth_mode = ?, freshness_window_ms = ?
         WHERE id = ?`,
      )
      .run(merged.name, merged.kind, merged.baseUrl, merged.authMode, merged.freshnessWindowMs, id);
    this.setScope(id, merged.collectionIds);

    const after = this.row(id);
    this.audit(actor, 'source.update', {
      details: {
        sourceId: id,
        name: after.name,
        kind: after.kind,
        authMode: after.authMode,
        freshnessWindowMs: after.freshnessWindowMs,
        collectionIds: after.collectionIds,
        // What actually moved, so the log answers "what changed" without a diff.
        changed: changedFields(before, after),
      },
    });
    return after;
  }

  remove(actorId: string, id: string): void {
    const actor = this.host.getActor(actorId);
    const source = this.row(id);
    this.requireVisible(actorId, source); // see `update`, and SECURITY.md R4
    this.requireSourceAdmin(actorId, source.collectionIds, DELETE_SOURCE);
    // Pages referencing this source would resolve to nothing. Refuse visibly
    // rather than leave dangling references behind; the table belongs to
    // references.ts, which is why this reads it rather than writing it.
    const used = this.db
      .prepare('SELECT COUNT(*) AS n FROM page_references WHERE source_id = ?')
      .get(id) as { n: number };
    if (used.n > 0) {
      throw new CanonError('conflict', `This source is referenced by ${used.n} page reference(s)`, {
        sourceId: id,
        references: used.n,
      });
    }
    this.db.prepare('DELETE FROM source_collections WHERE source_id = ?').run(id);
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    this.audit(actor, 'source.delete', {
      details: { sourceId: id, name: source.name, kind: source.kind, collectionIds: source.collectionIds },
    });
  }

  get(actorId: string, id: string): Source {
    const source = this.row(id);
    this.requireVisible(actorId, source);
    return source;
  }

  list(actorId: string): Source[] {
    this.host.getActor(actorId);
    const rows = this.db
      .prepare(
        `SELECT s.id FROM sources s
         WHERE NOT EXISTS (SELECT 1 FROM source_collections sc WHERE sc.source_id = s.id)
            OR EXISTS (
                 SELECT 1 FROM source_collections sc
                 JOIN collection_members m ON m.collection_id = sc.collection_id
                 WHERE sc.source_id = s.id AND m.actor_id = ?)
         ORDER BY s.created_at, s.id`,
      )
      .all(actorId) as { id: string }[];
    return rows.map((r) => this.row(r.id));
  }

  /**
   * WHAT THIS ACTOR MAY DO TO THIS SOURCE, AND WHERE THEY MAY NOT, WHO CAN.
   *
   * USER-TESTING.md T4.4 named "a red Delete on a live data source, offered to
   * people the server refuses" and it was the last of the three still standing:
   * pressing it produced a three-second toast reading "Requires admin access to
   * this collection", behind the confirmation dialog that had just opened, in
   * the far corner of the screen. It named no collection and nobody to ask.
   *
   * Same discipline as `CanonStore.pageAbilities`: this MIRRORS the checks
   * `update` and `remove` make above and never makes one. `can: true` where the
   * act would refuse is a bug; `can: false` where it would succeed is merely
   * unhelpful, so where a rule is fiddly this restates it in the same order the
   * act applies it, and the refusal-with-references below is the act's own
   * sentence.
   */
  abilities(actorId: string, source: Source): SourceAbilities {
    const admin = this.whyNotSourceAdmin(actorId, source.collectionIds, EDIT_SOURCE);
    // `remove` asks the same question in its own words, and then one more: a
    // source with references still pointing at it is refused whoever asks,
    // because deleting it would leave a page asking a question of nothing.
    let remove = this.whyNotSourceAdmin(actorId, source.collectionIds, DELETE_SOURCE);
    if (remove.can) {
      const used = (
        this.db.prepare('SELECT COUNT(*) AS n FROM page_references WHERE source_id = ?').get(source.id) as {
          n: number;
        }
      ).n;
      if (used > 0) {
        remove = cannot(
          `${used} page reference${used === 1 ? '' : 's'} still point${used === 1 ? 's' : ''} at this source. ` +
            'Remove them from their pages first: a reference is never silently dropped, because a missing ' +
            'value must not read as “there is no such value”.',
        );
      }
    }
    return { edit: admin, delete: remove };
  }

  /**
   * Whether this actor could register ANY source at all, for the one control
   * that exists before a source does. Registering takes admin on the scope
   * chosen, or the org-level `operator` role for a Canon-wide one — so somebody
   * who administers a collection may register a source scoped to it, and the
   * modal's own scope picker mirrors the rest (see the client).
   */
  registerAbility(actorId: string): PageAbility {
    this.host.getActor(actorId);
    if (isOrgOperator(this.db, actorId)) return CAN;
    const admins = this.db
      .prepare("SELECT COUNT(*) AS n FROM collection_members WHERE actor_id = ? AND role = 'admin'")
      .get(actorId) as { n: number };
    if (admins.n > 0) return CAN;
    return cannot(
      'Registering a source needs the admin role on the collections it is scoped to, and you administer none. ' +
        'A source referenceable from every collection needs the operator role for this Canon. ' +
        whoHoldsOrgRole(this.db, 'operator'),
    );
  }

  /**
   * `requireSourceAdmin`, asked rather than enforced. The two are deliberately
   * adjacent: they take the same argument in the same order, and the sentence
   * names the collection that failed rather than "this collection", because the
   * reader is on the source register looking at a row that may be scoped to a
   * collection they are not in.
   */
  private whyNotSourceAdmin(
    actorId: string,
    collectionIds: string[],
    act: { scoped: string; wide: string },
  ): PageAbility {
    if (collectionIds.length === 0) {
      const held = orgRoleOf(this.db, actorId);
      if (ORG_ROLE_RANK[held] >= ORG_ROLE_RANK.operator) return CAN;
      return needsOrgRole(this.db, held, `${act.wide} (one with no collection scope)`, 'operator');
    }
    for (const collectionId of collectionIds) {
      const role = this.host.roleOf(actorId, collectionId);
      if (role && ROLE_RANK[role] >= ROLE_RANK.admin) continue;
      return needsRoleHere(
        this.db,
        { id: collectionId, name: collectionName(this.db, collectionId) },
        role,
        act.scoped,
        'admin',
      );
    }
    return CAN;
  }

  // Used by references.ts on both the write and the read path: a reference may
  // only exist, and may only resolve, where the source is in scope.
  permittedIn(source: Source, collectionId: string): boolean {
    return source.collectionIds.length === 0 || source.collectionIds.includes(collectionId);
  }

  /** The stored source, with no permission check. Internal to federation. */
  row(id: string): Source {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such source: ${id}`);
    const scope = this.db
      .prepare('SELECT collection_id FROM source_collections WHERE source_id = ? ORDER BY collection_id')
      .all(id) as { collection_id: string }[];
    return {
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as string,
      baseUrl: row.base_url as string,
      authMode: row.auth_mode as SourceAuthMode,
      freshnessWindowMs: row.freshness_window_ms as number,
      collectionIds: scope.map((s) => s.collection_id),
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }

  // ---- internals -------------------------------------------------------

  private validate(input: SourceInput): Omit<Source, 'id' | 'createdBy' | 'createdAt'> {
    if (!input?.name?.trim()) throw new CanonError('invalid', 'A source requires a name');
    if (!input.kind?.trim()) throw new CanonError('invalid', 'A source requires a kind (which connector resolves it)');
    if (!SOURCE_AUTH_MODES.includes(input.authMode)) {
      throw new CanonError('invalid', `Unknown auth mode: ${String(input.authMode)}`, {
        supported: SOURCE_AUTH_MODES,
      });
    }
    // Never one global default (DATA-BACKBONE.md §6): the window is set from
    // how fast that field actually changes and what the compliance owner will
    // accept, so it is stated per source rather than inherited from Canon.
    const window = input.freshnessWindowMs;
    if (typeof window !== 'number' || !Number.isFinite(window) || window < 0 || !Number.isInteger(window)) {
      throw new CanonError(
        'invalid',
        'A source requires freshnessWindowMs: a whole number of milliseconds, set from how fast this system\'s values change',
      );
    }
    // Where a source points is checked when it is registered AND again when a
    // reference resolves (httpconnector.ts). Registration-time alone is not
    // enough — a name can be repointed after the check — and resolution-time
    // alone would leave an unreachable source sitting in the register looking
    // legitimate. Both, or neither is worth much.
    const baseUrl = (input.baseUrl ?? '').trim();
    try {
      assertRegistrableBaseUrl(baseUrl, this.outbound);
    } catch (err) {
      if (err instanceof OutboundRefused) {
        throw new CanonError('invalid', `This source's baseUrl is not one Canon may reach: ${err.message}`, {
          baseUrl,
          reason: err.code,
        });
      }
      throw err;
    }

    const collectionIds = [...new Set(input.collectionIds ?? [])];
    for (const collectionId of collectionIds) {
      const exists = this.db.prepare('SELECT 1 AS hit FROM collections WHERE id = ?').get(collectionId) as
        | { hit: number }
        | undefined;
      if (!exists) throw new CanonError('not_found', `No such collection: ${collectionId}`);
    }
    return {
      name: input.name.trim(),
      kind: input.kind.trim(),
      baseUrl,
      authMode: input.authMode,
      freshnessWindowMs: window,
      collectionIds: collectionIds.sort(),
    };
  }

  private setScope(sourceId: string, collectionIds: string[]): void {
    this.db.prepare('DELETE FROM source_collections WHERE source_id = ?').run(sourceId);
    const insert = this.db.prepare(
      'INSERT INTO source_collections (source_id, collection_id) VALUES (?, ?)',
    );
    for (const collectionId of collectionIds) insert.run(sourceId, collectionId);
  }

  // Registering or changing a source takes admin on its scope; a Canon-wide
  // source takes the org-level `operator` role (orgrole.ts). That second check
  // used to read "admin on at least one collection", which was the stand-in
  // SECURITY.md R5 named and this header called "the one check to change" when
  // an org-level role arrived. It has arrived, and this is that change: a
  // source referenceable from every collection in the record is an act at the
  // altitude of the whole Canon, so it takes a role at that altitude.
  private requireSourceAdmin(actorId: string, collectionIds: string[], act = REGISTER_SOURCE): void {
    // Enforced by asking `whyNotSourceAdmin` — which is the mirror the register
    // draws its greyed buttons from — so the two can never disagree about
    // either the answer or the words. This is the direction that is safe: the
    // mirror never decides, the check just borrows its sentence.
    const answer = this.whyNotSourceAdmin(actorId, collectionIds, act);
    if (answer.can) return;
    if (collectionIds.length === 0) {
      throw new CanonError('forbidden', answer.why!, {
        reason: 'org_role_required',
        neededOrgRole: 'operator',
        heldOrgRole: orgRoleOf(this.db, actorId),
      });
    }
    const failed = collectionIds.find((id) => {
      const role = this.host.roleOf(actorId, id);
      return !role || ROLE_RANK[role] < ROLE_RANK.admin;
    })!;
    throw forbiddenRole(this.db, failed, this.host.roleOf(actorId, failed), 'admin', act.scoped);
  }

  // Reading a source's registration is not reading its values: metadata only,
  // and it carries no secret material (see the header). A scoped source is
  // visible to members of its collections; a Canon-wide one to any actor.
  //
  // A source the caller cannot see reads as NOT FOUND, not as forbidden
  // (SECURITY.md R4). `list` above already omits it, so the two answers to the
  // same question — "is there a source with this id?" — used to disagree: the
  // listing said no and `get` said "yes, and you may not have it". The source
  // register is an inventory of the external systems Canon federates with, and
  // an inventory that can be confirmed one id at a time is still disclosed.
  // The refusal is therefore the identical error `row` raises for an id that
  // was never registered, so the two are indistinguishable.
  private requireVisible(actorId: string, source: Source): void {
    this.host.getActor(actorId);
    if (source.collectionIds.length === 0) return;
    const visible = source.collectionIds.some((id) => this.host.roleOf(actorId, id) !== null);
    if (!visible) throw new CanonError('not_found', `No such source: ${source.id}`);
  }

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

function changedFields(before: Source, after: Source): string[] {
  const changed: string[] = [];
  for (const key of ['name', 'kind', 'baseUrl', 'authMode', 'freshnessWindowMs'] as const) {
    if (before[key] !== after[key]) changed.push(key);
  }
  if (before.collectionIds.join(',') !== after.collectionIds.join(',')) changed.push('collectionIds');
  return changed;
}
