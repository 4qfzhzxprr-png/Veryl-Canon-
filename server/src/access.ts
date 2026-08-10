import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { collectionName } from './abilities.js';
import { Actor, CanonError, Role, ROLE_RANK } from './model.js';
import { isOrgAdministrator } from './orgrole.js';

// Asking for access, from the refusal that made you want it.
//
// Two testers asked for the same thing in the same words: "the wall already
// names who holds the role; it should be able to ask for them. Administrators
// have no inbox of requests either." This is both halves — the ask, and
// somewhere it lands, because a request nobody can see is worse than no
// request at all.
//
// THE SHAPE OF THE THING, AND WHY IT IS NOT A PAGE ID
//
// The obvious design is `POST /access-requests { pageId }`, and it is the one
// design this file may not have. Canon's search boundary was drawn deliberately
// (policy question 1: EXISTENCE, NEVER IDENTITY): a relationship the record
// states about a page you hold is disclosed, and nothing identifying about the
// far page is — no id, no title, no type, no status, no collection. Search
// takes an arbitrary term and therefore reports no hidden-match count at all,
// because a count is an oracle somebody can binary-search titles with.
//
// An endpoint that accepted any id somebody typed and answered differently for
// "no such thing" and "that exists, request sent" would be exactly that oracle,
// rebuilt on the other side of the product — and worse, because it would be one
// call rather than a search. So a request NEVER NAMES ITS SUBJECT. It names the
// REFUSAL, and the server resolves what that refusal was about:
//
//   * `collection` — "I hold a role on this collection and I need a bigger
//     one." The asker names a collection they are already a member of, which is
//     verified from their own membership. It discloses nothing because they
//     could already read the collection, its members and its pages.
//
//   * `relation` — "something the record says about MY page points at a page I
//     cannot see." The asker names the relation, not the page. The relation
//     must be one asserted against a page they can view, and its far end must
//     be one they cannot: exactly the disclosure `relations.ts` already makes,
//     turned into an act. The far page's id, title and collection never travel
//     back — the asker learns nothing they were not already shown, and the
//     administrators of a collection they cannot name get a request they can
//     answer.
//
// A ground the asker cannot substantiate answers `not_found` — the same answer
// an unknown id gets, so the endpoint cannot be used to tell those apart.
//
// WHAT IS DELIBERATELY ABSENT: a ground for "a page I searched for", and one
// for a page id typed into a box. Both are the fishing expedition the boundary
// exists to prevent. A body link that was withheld (3.9) has the same shape as
// `relation` and would be a third ground; it is not built here rather than
// half-built, and the reason is that a link lives inside prose, where a control
// beside it is a control inside a sentence.

export const ACCESS_REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS access_requests (
  id             TEXT PRIMARY KEY,
  asker_id       TEXT NOT NULL REFERENCES actors(id),
  -- Who must decide: the administrators of THIS collection. For a relation
  -- ground this is the collection holding the page the asker cannot see, and
  -- it is never sent back to the asker.
  collection_id  TEXT NOT NULL REFERENCES collections(id),
  ground         TEXT NOT NULL CHECK (ground IN ('collection', 'relation')),
  -- The page the request is ABOUT, when the ground names one. Administrator's
  -- side only: it is the identity the refusal withheld.
  subject_page_id TEXT REFERENCES pages(id),
  -- The page the asker was reading — one of their own, so it may be named back
  -- to them. It is what makes "which request was that?" answerable.
  from_page_id   TEXT REFERENCES pages(id),
  relation_id    TEXT REFERENCES page_relations(id),
  requested_role TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'granted', 'declined', 'withdrawn')),
  decided_by     TEXT REFERENCES actors(id),
  decided_at     TEXT,
  decision_note  TEXT,
  granted_role   TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_requests_collection ON access_requests(collection_id, status);
CREATE INDEX IF NOT EXISTS idx_access_requests_asker ON access_requests(asker_id, status);
`;

export type AccessGround = 'collection' | 'relation';
export type AccessRequestStatus = 'open' | 'granted' | 'declined' | 'withdrawn';

/** What an asker sends. Never a page id: see the header. */
export interface AccessRequestInput {
  ground?: AccessGround;
  /** `collection` ground: a collection the asker already holds a role on. */
  collectionId?: string;
  /** `collection` ground: the role they are asking for. */
  role?: Role;
  /** `relation` ground: a relation asserted against a page they can view. */
  relationId?: string;
  note?: string | null;
}

/**
 * A request as an ADMINISTRATOR reads it: it names the subject, because the
 * administrator can already see it and cannot decide otherwise.
 */
export interface AccessRequest {
  id: string;
  askerId: string;
  collectionId: string;
  ground: AccessGround;
  subjectPageId: string | null;
  fromPageId: string | null;
  relationId: string | null;
  requestedRole: Role | null;
  note: string | null;
  createdAt: string;
  status: AccessRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  grantedRole: Role | null;
  /** The role the asker holds on `collectionId` right now, for the decider. */
  askerRole?: Role | null;
  /**
   * Who is asking, by name. Carried on the row rather than left to the
   * decider's directory: `visibleActors` narrows the directory to actual
   * colleagues, and a `relation` request comes from somebody in a collection
   * this administrator may share nothing with — who would then appear as a
   * truncated id on the one screen where "who is this" is the whole question.
   * The asker identified themselves by asking; this is that, and no more.
   */
  askerName?: string;
  /**
   * The page the request is about, titled. Only ever sent to a DECIDER, who
   * administers the collection holding it and can already read it.
   */
  subjectTitle?: string | null;
}

/**
 * A request as ITS ASKER reads it — the same row with the identity taken back
 * out. A `relation` request carries no collection and no subject page: the
 * asker was refused those, and a receipt for the asking must not be the
 * disclosure the refusal declined to make.
 */
export interface AskedAccessRequest {
  id: string;
  ground: AccessGround;
  /** Only ever set for the `collection` ground, which the asker named. */
  collectionId: string | null;
  /** One of the asker's own pages, so a `relation` request can say what it was about. */
  fromPageId: string | null;
  requestedRole: Role | null;
  note: string | null;
  createdAt: string;
  status: AccessRequestStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Set only when the request was granted, when it is no longer a disclosure. */
  grantedRole: Role | null;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface AccessHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function now(): string {
  return new Date().toISOString();
}

export class AccessRequestService {
  constructor(private readonly db: DatabaseSync) {
    db.exec(ACCESS_REQUESTS_SCHEMA);
  }

  /**
   * Ask.
   *
   * Two values come back, and the split is the whole non-disclosure rule in
   * one signature: `request` is the ASKER'S view, thinner than the row (see
   * `AskedAccessRequest`), and `collectionId` is who must decide — which the
   * store needs in order to tell them, and which must never reach the asker on
   * a `relation` ground. A caller that returns this object whole to an HTTP
   * response would be the leak; the API returns `request` alone.
   */
  ask(
    host: AccessHost,
    actorId: string,
    input: AccessRequestInput,
  ): { request: AskedAccessRequest; collectionId: string } {
    host.getActor(actorId);
    const ground = input?.ground;
    if (ground !== 'collection' && ground !== 'relation') {
      throw new CanonError('invalid', 'A request for access names the refusal it follows, not a page', {
        supported: ['collection', 'relation'],
      });
    }
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    // Required, and this is the one place in Canon where a note on a REQUEST is
    // required rather than on a refusal. An administrator deciding it has to
    // widen somebody's access on the strength of it, and "Kit would like
    // access" is not something anybody can weigh. It is also what stops this
    // being a button people press on the way past.
    if (!note) {
      throw new CanonError('invalid', 'Say what you need to do and why; an administrator decides on that sentence', {
        field: 'note',
      });
    }
    if (note.length > 600) {
      throw new CanonError('invalid', 'Keep the request to a few sentences; it is read by a person');
    }

    const resolved =
      ground === 'collection'
        ? this.resolveCollectionGround(host, actorId, input)
        : this.resolveRelationGround(host, actorId, input);

    // One open request per asker per thing asked about. A second is not
    // refused with a bare `conflict`: the asker is told the first is still
    // waiting, which is the fact they actually wanted.
    const existing = this.db
      .prepare(
        `SELECT id FROM access_requests
          WHERE asker_id = ? AND status = 'open' AND ground = ? AND collection_id = ?
            AND COALESCE(relation_id, '') = COALESCE(?, '')`,
      )
      .get(actorId, ground, resolved.collectionId, resolved.relationId) as { id: string } | undefined;
    if (existing) {
      throw new CanonError('conflict', 'You have already asked for this, and it is still waiting on a decision', {
        requestId: existing.id,
      });
    }

    const id = randomUUID();
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO access_requests
           (id, asker_id, collection_id, ground, subject_page_id, from_page_id, relation_id,
            requested_role, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actorId,
        resolved.collectionId,
        ground,
        resolved.subjectPageId,
        resolved.fromPageId,
        resolved.relationId,
        resolved.requestedRole,
        note,
        createdAt,
      );
    return { request: this.asked(this.row(id)!), collectionId: resolved.collectionId };
  }

  /**
   * `collection`: a collection the asker ALREADY HOLDS A ROLE ON.
   *
   * The narrow line, and it is drawn here rather than argued case by case: a
   * refusal about a collection you hold nothing in gives you nothing to carry,
   * and accepting an arbitrary collection id would make this endpoint answer a
   * question the rest of the product refuses to answer. Somebody who needs
   * access to a collection they cannot see asks a person — which is what the
   * refusal already tells them to do ("An administrator of this collection can
   * grant it"), and it is the honest end of this road rather than a hole in it.
   */
  private resolveCollectionGround(host: AccessHost, actorId: string, input: AccessRequestInput) {
    const collectionId = input.collectionId?.trim();
    if (!collectionId) throw new CanonError('invalid', 'Which collection?', { field: 'collectionId' });
    const held = host.roleOf(actorId, collectionId);
    // The same answer for "no such collection" and "you hold nothing there",
    // because those two must stay indistinguishable here as they are
    // everywhere else in Canon.
    if (!held) throw new CanonError('not_found', 'No refusal of yours points at that collection');
    const role = input.role;
    if (role !== undefined && role !== null && !ROLE_RANK[role as Role]) {
      throw new CanonError('invalid', `Unknown collection role: ${String(role)}`, { field: 'role' });
    }
    const requested = (role as Role | undefined) ?? nextRoleUp(held);
    if (requested && ROLE_RANK[requested] <= ROLE_RANK[held]) {
      throw new CanonError('invalid', `You already hold ${held} on this collection, which includes ${requested}`);
    }
    return {
      collectionId,
      subjectPageId: null as string | null,
      fromPageId: null as string | null,
      relationId: null as string | null,
      requestedRole: (requested ?? null) as Role | null,
    };
  }

  /**
   * `relation`: the far end of something the record says about a page the asker
   * holds. The check is the mirror of the disclosure `relations.ts` makes — the
   * near end must be visible to them and the far end must not — so this
   * endpoint can only ever be asked about a refusal the reader was actually
   * shown.
   */
  private resolveRelationGround(host: AccessHost, actorId: string, input: AccessRequestInput) {
    const relationId = input.relationId?.trim();
    if (!relationId) throw new CanonError('invalid', 'Which relation?', { field: 'relationId' });
    const row = this.db
      .prepare(
        `SELECT r.id, r.from_page_id, r.to_page_id,
                pf.collection_id AS from_collection, pt.collection_id AS to_collection
           FROM page_relations r
           JOIN pages pf ON pf.id = r.from_page_id
           JOIN pages pt ON pt.id = r.to_page_id
          WHERE r.id = ?`,
      )
      .get(relationId) as
      | { id: string; from_page_id: string; to_page_id: string; from_collection: string; to_collection: string }
      | undefined;
    // One sentence for every way this can fail, so no combination of them says
    // anything about what exists.
    const notFound = new CanonError('not_found', 'No refusal of yours points at that');
    if (!row) throw notFound;
    const holdsFrom = Boolean(host.roleOf(actorId, row.from_collection));
    const holdsTo = Boolean(host.roleOf(actorId, row.to_collection));
    if (holdsFrom === holdsTo) {
      // Neither end visible: this reader was never shown the relation at all.
      // Both ends visible: there is nothing being withheld to ask for.
      throw notFound;
    }
    return {
      collectionId: holdsFrom ? row.to_collection : row.from_collection,
      subjectPageId: holdsFrom ? row.to_page_id : row.from_page_id,
      fromPageId: holdsFrom ? row.from_page_id : row.to_page_id,
      relationId: row.id,
      requestedRole: 'view' as Role | null,
    };
  }

  /** The open requests waiting on the administrators of collections this actor administers. */
  listForDecider(host: AccessHost, actorId: string, opts: { status?: AccessRequestStatus | 'all' } = {}): AccessRequest[] {
    host.getActor(actorId);
    const status = opts.status ?? 'open';
    const all = isOrgAdministrator(this.db, actorId);
    // An org administrator decides membership everywhere (`requirePermissionAdmin`),
    // so their inbox is every collection's — the same break-glass, and the same
    // reason: a collection whose last admin left still has requests in it.
    const rows = this.db
      .prepare(
        `SELECT a.*, who.name AS asker_name, p.title AS subject_title
           FROM access_requests a
           JOIN actors who ON who.id = a.asker_id
           LEFT JOIN pages p ON p.id = a.subject_page_id
          WHERE (${all ? '1 = 1' : 'a.collection_id IN (SELECT collection_id FROM collection_members WHERE actor_id = ? AND role = \'admin\')'})
            AND (? = 'all' OR a.status = ?)
          ORDER BY a.created_at DESC`,
      )
      .all(...(all ? [] : [actorId]), status, status) as Record<string, unknown>[];
    return rows.map((row) => {
      const request = toRequest(row);
      return {
        ...request,
        askerRole: host.roleOf(request.askerId, request.collectionId),
        askerName: (row.asker_name as string) ?? request.askerId,
        subjectTitle: (row.subject_title as string) ?? null,
      };
    });
  }

  /** What this actor has asked for, in their own thinner view. */
  listForAsker(host: AccessHost, actorId: string): AskedAccessRequest[] {
    host.getActor(actorId);
    const rows = this.db
      .prepare('SELECT * FROM access_requests WHERE asker_id = ? ORDER BY created_at DESC')
      .all(actorId) as Record<string, unknown>[];
    return rows.map((row) => this.asked(toRequest(row)));
  }

  /**
   * Decide one. The GRANT itself is not made here — `grant` is handed back to
   * the caller, which performs it through `setMember` so that every rule
   * membership has (the system actor, the last administrator, group grants, the
   * audit event) applies exactly as it does on the Members screen. A second
   * path into membership is the last thing this file should build.
   */
  decide(
    host: AccessHost,
    actorId: string,
    requestId: string,
    input: { outcome?: string; role?: Role; note?: string | null },
  ): { request: AccessRequest; grant: { memberId: string; role: Role } | null } {
    const row = this.row(requestId);
    // Existence before permission would say "there is a request here" to
    // anybody with an id. A request the caller does not administer reads as no
    // such request.
    const notFound = new CanonError('not_found', `No such access request: ${requestId}`);
    if (!row) throw notFound;
    if (!this.mayDecide(host, actorId, row.collectionId)) throw notFound;
    if (row.status !== 'open') {
      throw new CanonError('conflict', `This request was already ${row.status}`, { status: row.status });
    }
    const outcome = input.outcome === 'granted' ? 'granted' : input.outcome === 'declined' ? 'declined' : null;
    if (!outcome) throw new CanonError('invalid', "Deciding a request is 'granted' or 'declined'");
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    // The same asymmetry `approve` and `sendBack` already keep, for the same
    // reason. A grant writes its own record — the membership row, the audit
    // event, and the access itself, all visible to the person who asked. A
    // DECLINE is unperformable by its recipient without a sentence: "no" tells
    // somebody nothing they can do next, and they cannot read the reasoning off
    // anything else in the record.
    if (outcome === 'declined' && !note) {
      throw new CanonError('invalid', 'Declining records why, in a sentence the person who asked will read', {
        field: 'note',
      });
    }
    let grant: { memberId: string; role: Role } | null = null;
    if (outcome === 'granted') {
      const role = (input.role as Role | undefined) ?? row.requestedRole ?? 'view';
      if (!ROLE_RANK[role]) throw new CanonError('invalid', `Unknown collection role: ${String(role)}`);
      grant = { memberId: row.askerId, role };
    }
    this.db
      .prepare(
        `UPDATE access_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, granted_role = ?
          WHERE id = ?`,
      )
      .run(outcome, actorId, now(), note || null, grant?.role ?? null, requestId);
    return { request: this.row(requestId)!, grant };
  }

  /** The asker taking it back. Nobody else can, and a decided request cannot. */
  withdraw(host: AccessHost, actorId: string, requestId: string): AskedAccessRequest {
    const row = this.row(requestId);
    const notFound = new CanonError('not_found', `No such access request: ${requestId}`);
    if (!row || row.askerId !== actorId) throw notFound;
    if (row.status !== 'open') throw new CanonError('conflict', `This request was already ${row.status}`);
    this.db.prepare("UPDATE access_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(now(), requestId);
    return this.asked(this.row(requestId)!);
  }

  /** How many open requests are waiting on this actor, for the queue's badge. */
  countForDecider(host: AccessHost, actorId: string): number {
    return this.listForDecider(host, actorId).length;
  }

  /** Everyone who can decide this request: the collection's administrators. */
  decidersOf(collectionId: string): string[] {
    return (
      this.db
        .prepare("SELECT actor_id FROM collection_members WHERE collection_id = ? AND role = 'admin'")
        .all(collectionId) as { actor_id: string }[]
    ).map((r) => r.actor_id);
  }

  /** A collection's name, for a decider — never for an asker. */
  collectionNameFor(collectionId: string): string {
    return collectionName(this.db, collectionId);
  }

  private mayDecide(host: AccessHost, actorId: string, collectionId: string): boolean {
    return host.roleOf(actorId, collectionId) === 'admin' || isOrgAdministrator(this.db, actorId);
  }

  private row(id: string): AccessRequest | null {
    const row = this.db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRequest(row) : null;
  }

  /**
   * The asker's view. Two fields are dropped rather than nulled thoughtfully:
   * `collectionId` and the subject page, on any ground the asker did not name
   * themselves. This is the whole non-disclosure rule, applied at the last
   * possible moment so no listing, export or screen built on this service can
   * put it back by accident.
   */
  private asked(request: AccessRequest): AskedAccessRequest {
    const named = request.ground === 'collection';
    // Once it is GRANTED the asker can see the collection anyway, so naming it
    // is no longer a disclosure — it is the answer to "what did I just get".
    const disclosable = named || request.status === 'granted';
    return {
      id: request.id,
      ground: request.ground,
      collectionId: disclosable ? request.collectionId : null,
      fromPageId: request.fromPageId,
      requestedRole: request.requestedRole,
      note: request.note,
      createdAt: request.createdAt,
      status: request.status,
      decidedAt: request.decidedAt,
      decisionNote: request.decisionNote,
      grantedRole: request.status === 'granted' ? request.grantedRole : null,
    };
  }
}

/** Every role, weakest first. `ROLE_RANK` is the ordering; this is its list. */
const ROLE_ORDER: Role[] = (Object.keys(ROLE_RANK) as Role[]).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);

/** The next role up from one somebody holds, or null at the top. */
export function nextRoleUp(held: Role | null): Role | null {
  if (!held) return 'view';
  const at = ROLE_ORDER.indexOf(held);
  return at >= 0 && at + 1 < ROLE_ORDER.length ? ROLE_ORDER[at + 1]! : null;
}

function toRequest(row: Record<string, unknown>): AccessRequest {
  return {
    id: row.id as string,
    askerId: row.asker_id as string,
    collectionId: row.collection_id as string,
    ground: row.ground as AccessGround,
    subjectPageId: (row.subject_page_id as string) ?? null,
    fromPageId: (row.from_page_id as string) ?? null,
    relationId: (row.relation_id as string) ?? null,
    requestedRole: (row.requested_role as Role) ?? null,
    note: (row.note as string) ?? null,
    createdAt: row.created_at as string,
    status: row.status as AccessRequestStatus,
    decidedBy: (row.decided_by as string) ?? null,
    decidedAt: (row.decided_at as string) ?? null,
    decisionNote: (row.decision_note as string) ?? null,
    grantedRole: (row.granted_role as Role) ?? null,
  };
}
