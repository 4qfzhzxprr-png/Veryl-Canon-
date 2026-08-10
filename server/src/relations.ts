import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { forbiddenRole, notFoundIfStranger } from './abilities.js';
import { Actor, CanonError, DocType, PageStatus, Role, ROLE_RANK } from './model.js';

// Page relations: the explicit edge Canon gains when two pages contradict each
// other (DATA-BACKBONE.md §7, "Two pages contradict each other").
//
//   "Never merged, never auto-resolved. Canon gains an explicit relation
//    between pages — conflicts with, superseded by — asserted by a person or
//    proposed by an agent and accepted by one. Because it is explicit it may be
//    drawn: contradiction becomes something visible on the knowledge map rather
//    than something discovered during an audit."
//
// Every word of that is load-bearing here.
//
// EXPLICIT, WHICH IS WHY IT MAY BE DRAWN
//
// Nothing in this file reads a page body, compares two policies, or scores a
// similarity. A relation exists because a person wrote it down, exactly as a
// link, a parent, or a reference field does — which is the only reason
// graph.ts is allowed to draw it (§5: "Canon does not need an inferred graph,
// because it already has an explicit one"). A relation Canon inferred would be
// a model-written intermediate layer drawn as a picture, and it would be
// believed.
//
// CANON DOES NOT DECIDE
//
// Asserting `supersedes` does not archive the superseded page, does not change
// its status, and does not stop it being cited. Asserting `conflicts_with`
// blanks nothing. The relation is a statement ABOUT the record that the record
// now holds; what to do about it is a person's job, and §7's whole argument is
// that a system which quietly resolved it would be indistinguishable from one
// that invented an answer.
//
// A NOTE IS REQUIRED FOR `conflicts_with`
//
// The same rule proposals.ts applies to a rationale, for the same reason: an
// unexplained assertion that two policies conflict is not much use to whoever
// has to settle it. They would have to re-derive from two page bodies what the
// asserter already knew. `supersedes` carries an optional note because the
// claim is self-explanatory — this one replaces that one — while "these two
// disagree" is not a claim anybody can act on without knowing HOW.
//
// `conflicts_with` IS ONE ROW, CANONICALLY ORDERED
//
// "A conflicts with B" and "B conflicts with A" are the same fact, so they are
// the same row: the pair is sorted by page id before insert, and every read
// looks at both ends. Two rows would be two records of one assertion, and two
// records of one fact drift — one gets removed and the other does not, the
// audit log holds two `relation.assert` events for one act, and the map draws
// the conflict twice. The UNIQUE constraint then genuinely prevents asserting
// the same conflict twice, which it could not do if the pair's order carried
// meaning. `supersedes` IS directed and is stored exactly as asserted: which
// page replaced which is the whole content of the claim.
//
// AN AGENT MAY NOT ASSERT ONE, AND GETS NO SECOND PATH
//
// §7 asks for "asserted by a person or proposed by an agent and accepted by
// one". The proposal half is proposals.ts, and it does not fit this shape:
// a proposal is a complete piece of proposed page CONTENT — title, body,
// fields — written against a base version, whose acceptance publishes a new
// version through `publishAcceptedProposal`. A relation is none of those
// things. Making `page_proposals` carry one would mean either a `kind` column
// and a branch in `accept()` that publishes nothing (a second feature wearing
// the first's table, with the base-version, lock, and supersede-the-rest
// semantics all meaningless), or smuggling the relation through the `fields`
// JSON, which is inventing structure inside a blob. Neither is reuse.
//
// So agents get no path to assert a relation, rather than a second one. The
// loop §7 actually describes is already built and needs nothing here: an agent
// that notices two pages contradicting each other raises a PROPOSAL carrying
// its reasoning (`POST /pages/:id/proposals`, rationale required), and a
// person settles it — by asserting the relation, which is a person's act. The
// refusal is enforced twice, exactly as accepting a proposal is: agentauth.ts
// leaves POST /pages/:id/relations and DELETE /relations/:id out of its route
// table, so a passport is refused at the door, and this file refuses an actor
// of kind `agent` outright, which is the check that also holds in dev mode
// where an agent's actor id can arrive in X-Actor-Id with no passport behind
// it. READING relations is `read` like any other read of the record, and is
// classified there.
//
// PERMISSIONS ARE ON BOTH ENDS
//
// Asserting takes `edit` on BOTH pages' collections. A relation is a statement
// about two pages, and someone who may edit only one of them would be writing
// a claim onto a page they have no standing over — "this Compliance policy is
// superseded by my note" asserted by somebody with no Compliance access. The
// same rule removes one. Reading takes `view` on the page being read, and each
// relation is then dropped if the asker cannot see its other end: a relation to
// an invisible page is absent, never a placeholder saying "something you may
// not see, here".
//
// Both acts are audited — `relation.assert`, `relation.remove` — with both
// ends and the note in the details, so the log can answer "who said these
// contradict, and when, and why".

export const RELATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_relations (
  id           TEXT PRIMARY KEY,
  from_page_id TEXT NOT NULL REFERENCES pages(id),
  to_page_id   TEXT NOT NULL REFERENCES pages(id),
  kind         TEXT NOT NULL CHECK (kind IN ('conflicts_with', 'supersedes')),
  note         TEXT,
  asserted_by  TEXT NOT NULL REFERENCES actors(id),
  asserted_at  TEXT NOT NULL,
  UNIQUE (from_page_id, to_page_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_page_relations_from ON page_relations(from_page_id);
CREATE INDEX IF NOT EXISTS idx_page_relations_to ON page_relations(to_page_id);
`;

/** §7's two kinds, and nothing else. */
export type RelationKind = 'conflicts_with' | 'supersedes';
export const RELATION_KINDS: readonly RelationKind[] = ['conflicts_with', 'supersedes'];

/** The row, exactly as §7 shapes it (with the id every stored object carries). */
export interface PageRelation {
  id: string;
  fromPageId: string;
  toPageId: string;
  kind: RelationKind;
  /** Required for `conflicts_with`; optional, and often absent, for `supersedes`. */
  note: string | null;
  assertedBy: string;
  assertedAt: string;
}

/**
 * How the relation reads FROM one page. `supersedes` is directed, so the same
 * row is "supersedes" at one end and "superseded by" at the other — §7 names
 * the relation in both voices ("conflicts with, superseded by") and a page view
 * that could only say one of them would be telling half the truth.
 */
export type RelationReading = 'conflicts_with' | 'supersedes' | 'superseded_by';

/** The other end of a relation, as much of it as the asker may see. */
export interface RelationOtherPage {
  id: string;
  title: string;
  type: DocType;
  status: PageStatus;
  collectionId: string;
}

/**
 * The other end when the asker holds no role in its collection.
 *
 * EXISTENCE, NEVER IDENTITY. This is a reversal, and the argument it reverses
 * is written a few lines below in `list`: a relation to an invisible page used
 * to be dropped outright, on the reasoning that "your policy conflicts with
 * something you may not see" is a sentence that tells you about the something.
 *
 * That reasoning is sound about IDENTITY and wrong about EXISTENCE, and the
 * product had already decided so somewhere else: `answers.ts` tells an asker
 * that a cited page "is recorded as conflicting … (and with a page you cannot
 * see)". Two surfaces, opposite rules, and the one that disclosed was the one
 * built after a compliance director found the gap by asking the same question
 * three ways. Canon's whole claim is that the record can be trusted; a record
 * that silently omits the existence of a contradiction is not one.
 *
 * So: the relation is listed, and it carries NOTHING about the page at the far
 * end — no id, no title, no type, no status, no collection. Not a redacted
 * page: the absence of one. The relation's own note goes with it (see `list`),
 * because a note is prose one person typed about the page you may not see.
 *
 * What this deliberately does NOT do is turn an open-ended query into an
 * oracle. The disclosure is bounded to relations asserted against a page the
 * asker already holds; nothing here lets someone enumerate the record by
 * asking about pages they have no standing over.
 */
export interface RelationOtherWithheld {
  withheld: true;
}

export type RelationOther = RelationOtherPage | RelationOtherWithheld;

/** True when the far end is outside what this asker may read. */
export function isWithheld(other: RelationOther): other is RelationOtherWithheld {
  return (other as RelationOtherWithheld).withheld === true;
}

/**
 * One relation, listed for one page: which end it is, and what is at the other.
 *
 * `fromPageId`/`toPageId` are narrowed to allow null, because the stored row
 * NAMES BOTH ENDS and one of them may be a page this asker cannot see. The
 * withheld marker on `other` would have been decoration while the id it hides
 * rode out on the row beside it — a test caught exactly that. The end the asker
 * is reading from is always present; the far end is null when withheld, and
 * `other` is where a caller should read it from anyway.
 */
export interface PageRelationView extends Omit<PageRelation, 'fromPageId' | 'toPageId'> {
  fromPageId: string | null;
  toPageId: string | null;
  /** The page this listing was for. */
  pageId: string;
  /** Which end of the stored row that page is. */
  end: 'from' | 'to';
  /** What the relation says when read from `pageId`. */
  reads: RelationReading;
  other: RelationOther;
}

/**
 * A conflict listed for the person accountable for one of its ends: the same
 * view as `list`, anchored on the page they own, plus that page's own title and
 * status so a listing can name it without a second read.
 */
export interface OwnedConflict extends PageRelationView {
  /** The page this actor owns — the one `pageId` names. */
  mine: RelationOtherPage;
}

export interface RelationInput {
  toPageId: string;
  kind: RelationKind;
  note?: string | null;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface RelationHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

interface RelationPageRow {
  id: string;
  collectionId: string;
  title: string;
  type: DocType;
  status: PageStatus;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The stored order of a pair. `conflicts_with` is symmetric, so it is stored
 * once with the ids sorted; `supersedes` is directed and is stored as asserted.
 * One function, so the write path and the duplicate check can never disagree
 * about which row a pair is.
 */
export function relationPair(kind: RelationKind, fromPageId: string, toPageId: string): [string, string] {
  if (kind !== 'conflicts_with') return [fromPageId, toPageId];
  return fromPageId <= toPageId ? [fromPageId, toPageId] : [toPageId, fromPageId];
}

export class RelationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: RelationHost,
  ) {}

  // ---- asserting (a person's act) --------------------------------------

  assert(actorId: string, fromPageId: string, input: RelationInput): PageRelationView {
    const actor = this.requirePerson(actorId);
    const kind = input?.kind as RelationKind;
    if (!RELATION_KINDS.includes(kind)) {
      throw new CanonError(
        'invalid',
        `A relation is one of: ${RELATION_KINDS.join(', ')}`,
        { kind: input?.kind ?? null, kinds: RELATION_KINDS },
      );
    }
    const toPageId = String(input?.toPageId ?? '').trim();
    if (!toPageId) throw new CanonError('invalid', 'A relation names the other page');
    if (toPageId === fromPageId) {
      throw new CanonError('invalid', 'A page cannot conflict with or supersede itself');
    }

    const from = this.page(fromPageId);
    const to = this.page(toPageId);
    // Both ends, because a relation is a statement about both pages. The
    // Registry's half of the intersection never applies: these routes are not
    // available to agents at all.
    this.requireRole(actorId, from.collectionId, 'edit', 'Asserting a relation');
    this.requireRole(actorId, to.collectionId, 'edit', 'Asserting a relation');
    for (const page of [from, to]) {
      if (page.status === 'archived') {
        throw new CanonError('workflow', 'Archived pages are read-only', { pageId: page.id });
      }
    }

    // §7's own reasoning, applied to one kind: an unexplained assertion that
    // two policies conflict is not much use to whoever has to settle it.
    const note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (kind === 'conflicts_with' && !note) {
      throw new CanonError(
        'invalid',
        'Asserting that two pages conflict requires a note saying how they disagree: an unexplained conflict is not something anyone can settle',
        { kind },
      );
    }

    const [storedFrom, storedTo] = relationPair(kind, from.id, to.id);
    // The inverse of a supersession is a contradiction of the record's own
    // making — B cannot supersede A while A supersedes B. Canon does not pick
    // one: it refuses the second, and the person removes the first if the
    // record has changed its mind. (`conflicts_with` needs no such check; it
    // is stored canonically, so the inverse IS the same row and the UNIQUE
    // constraint catches it below.)
    if (kind === 'supersedes') {
      const inverse = this.db
        .prepare("SELECT id FROM page_relations WHERE from_page_id = ? AND to_page_id = ? AND kind = 'supersedes'")
        .get(storedTo, storedFrom) as { id: string } | undefined;
      if (inverse) {
        throw new CanonError(
          'conflict',
          `The record already holds that "${to.title}" supersedes "${from.title}"; remove that relation before asserting the reverse`,
          { relationId: inverse.id, kind },
        );
      }
    }

    const id = randomUUID();
    const at = now();
    try {
      this.db
        .prepare(
          `INSERT INTO page_relations (id, from_page_id, to_page_id, kind, note, asserted_by, asserted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, storedFrom, storedTo, kind, note || null, actorId, at);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new CanonError('conflict', 'The record already holds that relation between these two pages', {
          kind,
          fromPageId: storedFrom,
          toPageId: storedTo,
        });
      }
      throw err;
    }

    this.audit(actor, 'relation.assert', {
      collectionId: from.collectionId,
      pageId: from.id,
      details: {
        relationId: id,
        kind,
        fromPageId: storedFrom,
        toPageId: storedTo,
        // Which page the assertion was made from, which the stored order may
        // have swapped for a symmetric relation.
        assertedFromPageId: from.id,
        assertedToPageId: to.id,
        toCollectionId: to.collectionId,
        note: note || null,
      },
    });

    return this.view(
      {
        id,
        fromPageId: storedFrom,
        toPageId: storedTo,
        kind,
        note: note || null,
        assertedBy: actorId,
        assertedAt: at,
      },
      from.id,
      // Read back from the page the assertion was made from, whose other end
      // is the page it named — whichever way the pair was stored.
      to,
    );
  }

  /**
   * Every relation touching this page, from either end, with the other end
   * resolved. Permission-filtered in the SELECT — the join is on the OTHER
   * page's collection — so a relation whose far end this asker may not see is
   * absent from the answer rather than redacted in it.
   */
  list(actorId: string, pageId: string): PageRelationView[] {
    const page = this.page(pageId);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to the collection is
    // told the page does not exist rather than which collection refuses them.
    notFoundIfStranger(this.host.roleOf(actorId, page.collectionId), `No such page: ${pageId}`);
    this.requireRole(actorId, page.collectionId, 'view');
    // The membership test moved from the JOIN to a column. It used to be an
    // INNER JOIN, which dropped the whole relation when the far page was
    // invisible; now the relation comes back either way and `visible` decides
    // how much of the far end travels with it. See RelationOtherWithheld for
    // why that reversed.
    const rows = this.db
      .prepare(
        `SELECT r.id, r.from_page_id, r.to_page_id, r.kind, r.note, r.asserted_by, r.asserted_at,
                o.id AS other_id, o.title AS other_title, o.type AS other_type,
                o.status AS other_status, o.collection_id AS other_collection_id,
                EXISTS (SELECT 1 FROM collection_members m
                         WHERE m.collection_id = o.collection_id AND m.actor_id = ?) AS other_visible
           FROM page_relations r
           JOIN pages o ON o.id = CASE WHEN r.from_page_id = ? THEN r.to_page_id ELSE r.from_page_id END
          WHERE r.from_page_id = ? OR r.to_page_id = ?
          ORDER BY r.asserted_at, r.rowid`,
      )
      .all(actorId, pageId, pageId, pageId) as Record<string, unknown>[];
    return rows.map((row) => {
      const visible = Boolean(row.other_visible);
      return this.view(
        {
          id: row.id as string,
          fromPageId: row.from_page_id as string,
          toPageId: row.to_page_id as string,
          kind: row.kind as RelationKind,
          // The note travels with the page it is about. It is free text one
          // person typed to explain a contradiction, which means it can name,
          // quote or describe the page at the other end — everything the
          // withheld marker exists to keep back. The asserter's NAME stays:
          // that is a structured fact about who made an assertion against a
          // page this asker holds, not prose about one they do not.
          note: visible ? ((row.note as string) ?? null) : null,
          assertedBy: row.asserted_by as string,
          assertedAt: row.asserted_at as string,
        },
        pageId,
        visible
          ? {
              id: row.other_id as string,
              title: row.other_title as string,
              type: row.other_type as DocType,
              status: row.other_status as PageStatus,
              collectionId: row.other_collection_id as string,
            }
          : { withheld: true },
      );
    });
  }

  /**
   * Every `conflicts_with` assertion touching a page `ownerId` owns, across the
   * record, newest assertion first.
   *
   * §7 makes contradiction explicit so that it may be DRAWN, and the knowledge
   * map draws it. What nothing did was TELL the owner: a new contributor found
   * out that her own Canonical policy had a conflict asserted against it by
   * opening the map's list view for an unrelated reason (USER-TESTING.md T2.1).
   * A relation is asserted by somebody else, about her page, and the record
   * held it silently. This is the read that closes that.
   *
   * Owner means `pages.owner_id`, and here that IS the right column — unlike
   * the approver, whose mid-review answer lives on the draft (store.ts). A
   * conflict is asserted against what is PUBLISHED, and the published page's
   * owner is the person §3 makes accountable for keeping it true.
   *
   * Permission-filtered on the OWNED end in the SELECT: the page must be in a
   * collection this asker belongs to. The far end is not filtered, it is
   * WITHHELD — the same reversal `list` carries, and this is the read where it
   * matters most. This whole method exists because the record held a
   * contradiction against someone's page silently; dropping the row whenever
   * the far end sat in a collection she was not in reproduced exactly that
   * silence, for the conflicts most likely to be worth her time. She is
   * accountable for her page either way, and "something in the record
   * contradicts this, and you cannot see what" is the smallest true thing that
   * lets her go and ask.
   *
   * Archived pages are left out at either end. Archiving is how the record says
   * a page is no longer live; a contradiction with a retired page is not work.
   */
  listConflictsForOwner(actorId: string, ownerId: string, options: { limit?: number } = {}): OwnedConflict[] {
    this.host.getActor(actorId);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const rows = this.db
      .prepare(
        `SELECT r.id, r.from_page_id, r.to_page_id, r.kind, r.note, r.asserted_by, r.asserted_at,
                mine.id AS mine_id, mine.title AS mine_title, mine.type AS mine_type,
                mine.status AS mine_status, mine.collection_id AS mine_collection_id,
                o.id AS other_id, o.title AS other_title, o.type AS other_type,
                o.status AS other_status, o.collection_id AS other_collection_id,
                EXISTS (SELECT 1 FROM collection_members om
                         WHERE om.collection_id = o.collection_id AND om.actor_id = ?) AS other_visible
           FROM page_relations r
           JOIN pages mine ON mine.id IN (r.from_page_id, r.to_page_id)
                          AND mine.owner_id = ? AND mine.status != 'archived'
           JOIN collection_members mm ON mm.collection_id = mine.collection_id AND mm.actor_id = ?
           JOIN pages o ON o.id = CASE WHEN r.from_page_id = mine.id THEN r.to_page_id ELSE r.from_page_id END
                       AND o.status != 'archived'
          WHERE r.kind = 'conflicts_with'
          ORDER BY r.asserted_at DESC, r.rowid DESC
          LIMIT ?`,
      )
      // Bind order follows the statement text, and the visibility EXISTS now
      // sits in the SELECT list — ahead of the owner and membership tests in
      // the FROM clause. Getting this wrong would compare an owner id against
      // an actor id and quietly return nothing.
      .all(actorId, ownerId, actorId, limit) as Record<string, unknown>[];

    // One conflict, one row in the answer. When the owner owns BOTH ends the
    // join matches the relation twice, once anchored on each; the pair is one
    // assertion and one piece of work, so the first anchor wins and the second
    // is dropped rather than listed as a second conflict.
    const seen = new Set<string>();
    const out: OwnedConflict[] = [];
    for (const row of rows) {
      const id = row.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const mine: RelationOtherPage = {
        id: row.mine_id as string,
        title: row.mine_title as string,
        type: row.mine_type as DocType,
        status: row.mine_status as PageStatus,
        collectionId: row.mine_collection_id as string,
      };
      const visible = Boolean(row.other_visible);
      const view = this.view(
        {
          id,
          fromPageId: row.from_page_id as string,
          toPageId: row.to_page_id as string,
          kind: row.kind as RelationKind,
          note: visible ? ((row.note as string) ?? null) : null,
          assertedBy: row.asserted_by as string,
          assertedAt: row.asserted_at as string,
        },
        mine.id,
        visible
          ? {
              id: row.other_id as string,
              title: row.other_title as string,
              type: row.other_type as DocType,
              status: row.other_status as PageStatus,
              collectionId: row.other_collection_id as string,
            }
          : { withheld: true },
      );
      out.push({ ...view, mine });
    }
    return out;
  }

  /**
   * Withdrawing an assertion takes the same standing that making it took:
   * `edit` on both ends. It is a person's act for the same reason asserting
   * is — an agent that could delete the record's statement that two policies
   * contradict each other could quietly un-say the thing a person said.
   */
  remove(actorId: string, relationId: string): void {
    const actor = this.requirePerson(actorId);
    const relation = this.get(relationId);
    const from = this.page(relation.fromPageId);
    const to = this.page(relation.toPageId);
    this.requireRole(actorId, from.collectionId, 'edit', 'Withdrawing a relation');
    this.requireRole(actorId, to.collectionId, 'edit', 'Withdrawing a relation');

    this.db.prepare('DELETE FROM page_relations WHERE id = ?').run(relationId);
    this.audit(actor, 'relation.remove', {
      collectionId: from.collectionId,
      pageId: from.id,
      details: {
        relationId,
        kind: relation.kind,
        fromPageId: relation.fromPageId,
        toPageId: relation.toPageId,
        toCollectionId: to.collectionId,
        note: relation.note,
        assertedBy: relation.assertedBy,
        assertedAt: relation.assertedAt,
      },
    });
  }

  // ---- internals -------------------------------------------------------

  private view(
    relation: PageRelation,
    pageId: string,
    other: RelationPageRow | RelationOtherPage | RelationOtherWithheld,
  ): PageRelationView {
    const end: 'from' | 'to' = relation.fromPageId === pageId ? 'from' : 'to';
    const reads: RelationReading =
      relation.kind === 'conflicts_with' ? 'conflicts_with' : end === 'from' ? 'supersedes' : 'superseded_by';
    const withheld = isWithheld(other as RelationOther);
    return {
      ...relation,
      // The far end's id is the identity this whole thing exists to withhold.
      fromPageId: withheld && end === 'to' ? null : relation.fromPageId,
      toPageId: withheld && end === 'from' ? null : relation.toPageId,
      pageId,
      end,
      reads,
      // Built field by field rather than spread, so a column added to the page
      // row later cannot ride out to a reader who was never shown the page.
      other: withheld
        ? { withheld: true }
        : {
            id: (other as RelationOtherPage).id,
            title: (other as RelationOtherPage).title,
            type: (other as RelationOtherPage).type,
            status: (other as RelationOtherPage).status,
            collectionId: (other as RelationOtherPage).collectionId,
          },
    };
  }

  private get(id: string): PageRelation {
    const row = this.db.prepare('SELECT * FROM page_relations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such relation: ${id}`);
    return {
      id: row.id as string,
      fromPageId: row.from_page_id as string,
      toPageId: row.to_page_id as string,
      kind: row.kind as RelationKind,
      note: (row.note as string) ?? null,
      assertedBy: row.asserted_by as string,
      assertedAt: row.asserted_at as string,
    };
  }

  private page(id: string): RelationPageRow {
    const row = this.db
      .prepare('SELECT id, collection_id, title, type, status FROM pages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      title: row.title as string,
      type: row.type as DocType,
      status: row.status as PageStatus,
    };
  }

  // Asserting and withdrawing are a person's act. agentauth.ts refuses an
  // agent at the door (neither route is in its table); this is the second
  // lock, and the one that also holds in dev mode, where an agent's actor id
  // can arrive in X-Actor-Id with no passport behind it.
  private requirePerson(actorId: string): Actor {
    const actor = this.host.getActor(actorId);
    if (actor.kind === 'agent') {
      throw new CanonError(
        'forbidden',
        'Only a person can assert a relation between pages: an agent that has noticed a contradiction proposes a change carrying its reasoning, and a person settles it',
        { reason: 'relation_is_a_persons_act', actorKind: actor.kind },
      );
    }
    return actor;
  }

  /**
   * `act` is named here and nowhere else, because this is the refusal that had
   * to travel. Asserting needs `edit` on BOTH pages' collections, and a
   * contributor pointing at a page in another collection was told "Requires
   * edit access to this collection" — which collection? The one she was on,
   * where she held edit, or the one she was pointing at? The sentence
   * abilities.ts builds names the collection that refused, what she holds
   * there, and who does hold it (USER-TESTING.md T4.4, second round).
   */
  private requireRole(actorId: string, collectionId: string, needed: Role, act?: string): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw forbiddenRole(this.db, collectionId, role, needed, act);
    }
  }

  // Written here directly, as comments.ts and proposals.ts do: the audit log
  // is append-only storage, and these events belong to the relation rather
  // than to any store operation.
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
