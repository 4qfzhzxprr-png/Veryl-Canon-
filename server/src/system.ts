import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError } from './model.js';

// The system actor: Canon itself, when Canon is the one acting.
//
// WHY THIS EXISTS. Canon's audit log carries one actor per event, and until now
// there were only two kinds of actor — a person and an agent. Maintenance work
// that Canon does on its own clock (today: the freshness sweep) therefore had to
// borrow somebody's name, which a deployment supplied with
// `CANON_MAINTENANCE_ACTOR_ID`. In the demo corpus that name was Dana
// Whitfield's, and the record said nineteen times that Dana had marked pages
// past review on an afternoon she spent doing nothing of the kind.
//
// That is a falsehood in the record's own history, which is the one thing this
// product exists to prevent. DATA-BACKBONE.md §2, principle 5 says attribution
// is universal — every write names who made it — and the previous reading of it
// was that Canon must never write "under a nameless system identity". The
// mistake was in the word *nameless*. The principle asks that the log never say
// nothing about who acted; it does not ask that the log say a person acted when
// a machine did. So the answer is a system actor that is NAMED, singular, fixed,
// and unmistakably not a person.
//
// WHAT IT IS.
//
//   id     'system:canon' — deliberately not a UUID. Every other actor id in
//          the record is a UUID, so this one is recognisable on sight in a raw
//          audit row, in a CSV export, and in a database somebody is reading
//          with `sqlite3`. The colon cannot occur in a UUID, so no person or
//          agent can ever be given this id by accident.
//   kind   'system' — a third ActorKind, so `actor_kind` on the audit event is
//          true without anybody having to know which id is special. Every
//          surface that already renders "agent" beside an actor now has a third
//          case to render, which is the point: it shows up everywhere.
//   name   'Canon' — what actually did it.
//   email  null, forever. It is not a recipient of anything.
//
// WHAT IT CANNOT DO, and where each refusal lives.
//
//   Be signed in as        auth.ts refuses `X-Actor-Id: system:canon` at
//                          `identify`, and no identity provider subject can ever
//                          provision it (it is not created by provisioning).
//                          agentauth.ts looks a passport up by `registry_ref`
//                          with `kind = 'agent'`, and this actor is neither.
//   Be created             store.createActor refuses `kind: 'system'`, so
//                          `POST /actors` cannot mint a second one. The single
//                          row is written by ensureSystemActor at open time.
//   Hold a role            store.setMember, store.setOrgRole and
//                          store.bootstrapAdministrator all refuse it. Its
//                          authority is not a grant and must never become one:
//                          it is allowed to run the sweep because it IS the
//                          sweep, and it can do nothing else because nothing
//                          else calls it.
//   Be mistaken for a
//   person                 It carries the `system` kind through every list, the
//                          web UI tags it, and it is absent from the dev
//                          identity picker.
//
// It is deliberately ONE actor rather than one per subsystem. A record with
// `system:freshness`, `system:outbox` and `system:import` in it invites the
// reader to work out which of them is trustworthy; there is one machine here and
// the audit event's `action` already says which part of it spoke.

export const SYSTEM_ACTOR_ID = 'system:canon';
export const SYSTEM_ACTOR_NAME = 'Canon';

/**
 * Is this id the system actor's? A string comparison and not a database read,
 * because the callers are permission checks and identity refusals: they must be
 * cheap enough to sit in front of everything, and they must give the same answer
 * on a record where the row has somehow been removed.
 */
export function isSystemActorId(id: string | null | undefined): boolean {
  return id === SYSTEM_ACTOR_ID;
}

/** The system actor as a value, for the paths that need one without a read. */
export const SYSTEM_ACTOR: Actor = {
  id: SYSTEM_ACTOR_ID,
  kind: 'system',
  name: SYSTEM_ACTOR_NAME,
  email: null,
  registryRef: null,
  createdAt: '1970-01-01T00:00:00.000Z',
};

/**
 * Write the single system actor row if it is not there. Called from openDb on
 * every open, after the migrations that teach `actors.kind` the third value —
 * the same shape as ensureAuditChain: a fact about the record that must be true
 * before the first write, established by opening it rather than by a step
 * somebody has to remember.
 *
 * `INSERT OR IGNORE` rather than an upsert: the name is not configuration and
 * nothing should be able to rename it, but neither should reopening a record
 * rewrite a row for no reason.
 */
export function ensureSystemActor(db: DatabaseSync): void {
  db.prepare(
    `INSERT OR IGNORE INTO actors (id, kind, name, email, registry_ref, created_at)
     VALUES (?, 'system', ?, NULL, NULL, ?)`,
  ).run(SYSTEM_ACTOR_ID, SYSTEM_ACTOR_NAME, SYSTEM_ACTOR.createdAt);
}

/**
 * The refusal every "you cannot do that to the system actor" path raises.
 * `what` names the act, per the CanonError convention (SECURITY.md R7): the
 * message is written for whoever is reading it, and it says why rather than
 * only no.
 */
export function refuseSystemActor(id: string, what: string): void {
  if (!isSystemActorId(id)) return;
  throw new CanonError(
    'forbidden',
    `${what} is not something that can be done to ${SYSTEM_ACTOR_NAME} (${SYSTEM_ACTOR_ID}). ` +
      'That actor is this Canon acting on its own clock — it is not a person, it holds no role, ' +
      'and nobody can sign in as it.',
    { reason: 'system_actor', actorId: SYSTEM_ACTOR_ID },
  );
}

/**
 * `actors.kind` gained a third value, and SQLite bakes a CHECK constraint into
 * the stored table definition with no way to alter one — so a record written by
 * an earlier build is brought forward by the documented rebuild (create, copy,
 * drop, rename), exactly as freshness.ts does for the `pages` status CHECK.
 *
 * Foreign keys off around the swap, because a dozen tables reference
 * `actors(id)` and the old table is dropped mid-flight; `foreign_key_check`
 * before the commit, so "it worked" is verified rather than assumed. Without
 * this, the first open of an upgraded record would fail at the INSERT of the
 * system actor row — which is the correct failure and a bad way to find out.
 */
export function ensureSystemActorKind(db: DatabaseSync): void {
  const definition = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actors'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (!definition) return; // no actors table yet; the baseline will create it current
  if (definition.includes("'system'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE actors_kind_rebuild (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('person', 'agent', 'system')),
        name         TEXT NOT NULL,
        email        TEXT,
        registry_ref TEXT,
        created_at   TEXT NOT NULL
      )
    `);
    db.exec(
      `INSERT INTO actors_kind_rebuild (id, kind, name, email, registry_ref, created_at)
       SELECT id, kind, name, email, registry_ref, created_at FROM actors`,
    );
    db.exec('DROP TABLE actors');
    db.exec('ALTER TABLE actors_kind_rebuild RENAME TO actors');
    const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (broken.length > 0) throw new Error('rebuilding actors for the system kind broke a foreign key');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
