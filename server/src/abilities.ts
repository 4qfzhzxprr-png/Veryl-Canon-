import type { DatabaseSync } from 'node:sqlite';
import { CanonError, PageAbility, Role, ROLE_RANK } from './model.js';
import { OrgRole, ORG_ROLE_RANK, listOrgRoleHolders } from './orgrole.js';

// ONE VOCABULARY FOR REFUSAL (USER-TESTING.md T4.4, and the second round of it).
//
// The `abilities` work gave the page view a sentence worth reading:
//
//   "Editing needs the edit role on Clinical Policy; you hold view there.
//    Bo Ferrante, Dana Whitfield, Joel Brennan and 2 others hold it."
//
// Three things are in that sentence and all three are load-bearing: what the
// act needs, what the caller holds, and WHO CAN — somebody to ask. A second
// round of testing found the product still had a second way of saying no, and
// it was the one that turned up where it mattered: a red toast in a corner,
// behind a modal backdrop, gone in three seconds — "Requires edit access to
// this collection". Two vocabularies, and the worse one on the Members screen,
// on Delete beside a live data source, and on the cross-collection conflict
// that is the one contradiction the seeded record actually holds.
//
// So the sentence is built HERE, once, and every screen that must refuse
// something asks this file for its words. The rules themselves stay exactly
// where they were — in store.ts, sources.ts, relations.ts, beside the check
// each one mirrors. Nothing in this file decides anything; it says, in English,
// what a decision made elsewhere came to.
//
// WHY THE SENTENCE NAMES ITS COLLECTION
//
// It used to say "on this collection", which is unambiguous on a page and
// useless anywhere else. Asserting that two pages conflict needs `edit` on
// BOTH pages' collections, and a contributor pointing at a page in another
// collection was told "Requires edit access to this collection" — "which
// collection? The one I'm on, where I hold edit? Or the one I'm pointing at?"
// A refusal that can travel has to name the thing it is about, so every
// sentence below carries the collection's name and every screen may therefore
// repeat it about a collection the reader is not currently looking at.

/** A refusal, in the shape every ability projection uses. */
export const CAN: PageAbility = { can: true, why: null };

/** A refusal carrying its sentence. `why` is never empty. */
export function cannot(why: string): PageAbility {
  return { can: false, why };
}

/**
 * Who on this collection holds at least `needed`, as a sentence to hand
 * somebody who does not. Capped at three names because the point is to give a
 * person somebody to ask, not to print a directory.
 */
export function whoHoldsRole(db: DatabaseSync, collectionId: string, needed: Role): string {
  const rows = db
    .prepare(
      `SELECT a.name AS name, m.role AS role
       FROM collection_members m JOIN actors a ON a.id = m.actor_id
       WHERE m.collection_id = ?`,
    )
    .all(collectionId) as { name: string; role: Role }[];
  const names = rows
    .filter((r) => ROLE_RANK[r.role] >= ROLE_RANK[needed])
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) return 'Nobody here holds it; an administrator of this collection can grant it.';
  return `${nameList(names)} ${names.length === 1 ? 'holds' : 'hold'} it.`;
}

/**
 * The same sentence for an organisation-level role — the one a Canon-wide
 * source is registered under. An org role is not held "here", so the wording
 * says where it is held instead of pretending it is a collection.
 */
export function whoHoldsOrgRole(db: DatabaseSync, needed: OrgRole): string {
  const names = listOrgRoleHolders(db)
    .filter((h) => ORG_ROLE_RANK[h.role] >= ORG_ROLE_RANK[needed])
    .map((h) => actorName(db, h.actorId))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    return `Nobody in this Canon holds ${needed}; an administrator of this Canon can grant it.`;
  }
  return `${nameList(names)} ${names.length === 1 ? 'holds' : 'hold'} it for this Canon.`;
}

/**
 * WHO CAN, said only to somebody who could already have found out.
 *
 * Naming names gives nothing away to a member: anyone holding `view` can
 * already read the collection's membership and every comment on every page in
 * it. To somebody holding NO role there it would be a disclosure — the shape of
 * a restricted collection's staff list, handed out by a 403 — so they are told
 * where to go instead of who to ask. The refusal is the same in every other
 * respect, and neither answer confirms anything the other denies.
 */
function whoCan(db: DatabaseSync, collectionId: string, needed: Role, held: Role | null): string {
  if (!held) return 'An administrator of this collection can grant it.';
  return whoHoldsRole(db, collectionId, needed);
}

/**
 * The whole refusal for an act that needs a collection role the caller does not
 * hold. `act` is the act in its own words, capitalised, with no trailing
 * punctuation — "Editing", "Removing a member", "Asserting a relation".
 */
export function needsRoleHere(
  db: DatabaseSync,
  collection: { id: string; name: string },
  held: Role | null,
  act: string,
  needed: Role,
): PageAbility {
  return cannot(
    `${act} needs the ${needed} role on ${collection.name}; you hold ${held ?? 'none'} there. ` +
      whoCan(db, collection.id, needed, held),
  );
}

/**
 * THE SAME SENTENCE AT THE LAST CLICK.
 *
 * `requireRole` is written out seven times across this server — store, sources,
 * references, relations, comments, proposals, queries — and every one of them
 * threw the same seven words: "Requires edit access to this collection". That
 * was the second vocabulary. It named no collection, said nothing about what
 * the caller held, and named nobody to ask, and it is what a person met at the
 * moment they had already committed to the act.
 *
 * So the refusal a screen SHOWS and the refusal a request GETS are now one
 * sentence, built here. `act` is optional because most call sites are generic
 * plumbing; where the act has a name worth saying — asserting a relation across
 * a collection boundary — the call site says it.
 *
 * The `details` are unchanged: `{ collectionId, needed, held }`, which is what
 * a client that reads structure rather than prose has always been given.
 */
export function forbiddenRole(
  db: DatabaseSync,
  collectionId: string,
  held: Role | null,
  needed: Role,
  act?: string,
): CanonError {
  const lead = act ? `${act} needs` : 'This needs';
  return new CanonError(
    'forbidden',
    `${lead} the ${needed} role on ${collectionName(db, collectionId)}; you hold ${held ?? 'none'} there. ` +
      whoCan(db, collectionId, needed, held),
    { collectionId, needed, held },
  );
}

/** The same, for an act that needs an organisation-level role. */
export function needsOrgRole(db: DatabaseSync, held: OrgRole, act: string, needed: OrgRole): PageAbility {
  return cannot(
    `${act} needs the ${needed} role for this Canon; you hold ${held}. ` + whoHoldsOrgRole(db, needed),
  );
}

/** "Bo Ferrante, Dana Whitfield, Joel Brennan and 2 others", or the short forms of it. */
export function nameList(names: string[], cap = 3): string {
  const shown = names.slice(0, cap);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  if (shown.length > 1) return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`;
  return shown[0] ?? '';
}

/** A collection's name for a sentence, falling back to its id if it has gone. */
export function collectionName(db: DatabaseSync, collectionId: string): string {
  const row = db.prepare('SELECT name FROM collections WHERE id = ?').get(collectionId) as
    | { name: string }
    | undefined;
  return row?.name ?? collectionId;
}

function actorName(db: DatabaseSync, actorId: string): string {
  const row = db.prepare('SELECT name FROM actors WHERE id = ?').get(actorId) as { name: string } | undefined;
  return row?.name ?? actorId;
}

// The asking actor's standing on one COLLECTION: what the server would accept
// from them right now on the screens that are about a collection rather than
// about a page — Members, and the New page control.
//
// Same rule as `CanonStore.pageAbilities` lives under, and it is the only rule
// this projection has: it MIRRORS the checks, it never makes one. A screen that
// greys a button because of one of these is not enforcing anything; the server
// refuses the request whatever the button looked like.
export interface CollectionAbilities {
  collectionId: string;
  /** The asking actor's effective role here, `null` if they hold none. */
  role: Role | null;
  /** `createPage` — `edit`, and what the New page control is drawn from. */
  createPage: PageAbility;
  /** `setMember` — `admin` here, or `administrator` for the whole Canon. */
  addMember: PageAbility;
  /** `removeMember`, which is the same check; both are named so a screen can say the right verb. */
  removeMember: PageAbility;
  /**
   * `edit` here, phrased as what asserting a relation needs — because a
   * relation needs it on BOTH pages' collections, and the far end's refusal is
   * this sentence about a collection the reader is not looking at.
   */
  assertRelation: PageAbility;
}
