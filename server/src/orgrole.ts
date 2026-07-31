// Organisation-level roles, and the difference between access a person was
// given by hand and access a directory group grants them.
//
// WHY THIS EXISTS. Canon had collection roles (`view` … `admin`) and nothing
// above them, so five places asked "does this actor hold `admin` on ANY
// collection?" as a stand-in for "is this person an operator of this Canon":
// the audit narrowing for collection-less events (store.ts), the actor
// directory (auth.ts `visibleActors`), the notification flush (notify.ts
// `flushFor`), Canon-wide source registration (sources.ts
// `requireSourceAdmin`), and the freshness sweep (freshness.ts
// `requireOperator`). SECURITY.md R5 named the first four and said "when an
// organisation-level administrator role arrives, those checks change
// together"; grepping found the fifth. They now all ask this module instead.
//
// The stand-in was wrong in both directions, which is the whole argument for
// this file: a team lead who administers one collection was an operator of the
// entire Canon, and a genuine operator with no collection membership was
// invisible — unable to flush the outbox, run the sweep, or find anybody in
// the directory.
//
// THE THREE ROLES, and what each one means.
//
//   member         The default, held by everyone who has not been given
//                  something else. Everything a member can do comes from their
//                  collection roles and from nowhere else. Stored as the
//                  ABSENCE of a row, so provisioning a person grants nothing.
//   operator       Runs this Canon. May flush the notification outbox, run the
//                  freshness sweep, register a Canon-wide source, read audit
//                  events that name no collection, list the actor directory,
//                  and end a person's sessions (auth.ts). Grants no access to
//                  any collection's content and cannot hand any out.
//   administrator  An operator who also administers permissions: sets other
//                  people's org roles, and may grant or remove collection
//                  membership anywhere.
//
// DOES `administrator` IMPLY COLLECTION ACCESS? No, and deliberately not. An
// administrator holds no `view` on any collection they were not given one in:
// they cannot read a page, search a body, retrieve a passage, or be answered
// from material they hold no collection role in. Running the system is not the
// same job as being entitled to the corpus, and a regulated buyer asks about
// exactly that separation.
//
// What an administrator CAN do is grant themselves a collection role — that is
// what "administers permissions" means, and a Canon whose last collection admin
// leaves must not become unadministrable. The difference that matters is that
// the grant is an ordinary `collection.member_set` audit event with their name
// on it, made before the read rather than discovered after it. Accountable
// access, not silent access. This is stated in SECURITY.md as the residual it
// is, rather than sold as an impossibility.
//
// HAND GRANTS AND MAPPED GRANTS. From R10, a deployment can map an identity
// provider's groups onto Canon roles (groupmap.ts). That makes one row in
// `collection_members` the answer to two different questions, so this module
// keeps the two apart and derives the effective role from them:
//
//   collection_hand_grants   what an administrator granted, by hand.
//   collection_group_grants  what a group mapping granted, one row per group,
//                            rewritten on every confirmation of the person's
//                            session.
//   collection_members       the EFFECTIVE role — the strongest of the two
//                            sides — which every other query in Canon reads
//                            exactly as it always has.
//
// Keeping `collection_members` as the effective table is what makes this
// change additive: the membership join in search, retrieval, embeddings,
// queries, the graph and the audit narrowing is untouched. Removing a group
// removes exactly the rows that group granted and recomputes; a hand grant
// underneath survives. Removing a hand grant does the same in reverse. Neither
// side can silently inherit the other's access, which is the property F2 and
// R5 depend on.

import type { DatabaseSync } from 'node:sqlite';
import { CanonError, Role, ROLE_RANK } from './model.js';

export type OrgRole = 'member' | 'operator' | 'administrator';

export const ORG_ROLES: readonly OrgRole[] = ['member', 'operator', 'administrator'];

export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  member: 1,
  operator: 2,
  administrator: 3,
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Storage
//
// Four tables and one backfill, in one const so db.ts takes one `db.exec`
// line. Nothing here alters an existing table: `collection_members` keeps its
// shape and its meaning, and the two grant tables sit beside it.
//
// The backfill is the migration. Every membership row a record already holds
// was granted by hand — group mapping did not exist when it was written — so
// each becomes a hand grant, except where a group grant already explains it,
// which is what keeps the statement safe to run on every start-up rather than
// once.

export const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS actor_org_roles (
  actor_id    TEXT PRIMARY KEY REFERENCES actors(id),
  hand_role   TEXT CHECK (hand_role IN ('operator', 'administrator')),
  mapped_role TEXT CHECK (mapped_role IN ('operator', 'administrator')),
  granted_by  TEXT,
  granted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_hand_grants (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  actor_id      TEXT NOT NULL REFERENCES actors(id),
  role          TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'approve', 'admin')),
  PRIMARY KEY (collection_id, actor_id)
);

CREATE TABLE IF NOT EXISTS collection_group_grants (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  actor_id      TEXT NOT NULL REFERENCES actors(id),
  group_name    TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'approve', 'admin')),
  granted_at    TEXT NOT NULL,
  PRIMARY KEY (collection_id, actor_id, group_name)
);

CREATE INDEX IF NOT EXISTS idx_group_grants_actor ON collection_group_grants(actor_id);

CREATE TABLE IF NOT EXISTS actor_groups (
  actor_id   TEXT NOT NULL REFERENCES actors(id),
  group_name TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (actor_id, group_name)
);

INSERT OR IGNORE INTO collection_hand_grants (collection_id, actor_id, role)
SELECT m.collection_id, m.actor_id, m.role
  FROM collection_members m
 WHERE NOT EXISTS (
   SELECT 1 FROM collection_group_grants g
    WHERE g.collection_id = m.collection_id AND g.actor_id = m.actor_id
 );
`;

function nowIso(): string {
  return new Date().toISOString();
}

function strongerOrg(a: OrgRole | null, b: OrgRole | null): OrgRole {
  const left = a ?? 'member';
  const right = b ?? 'member';
  return ORG_ROLE_RANK[left] >= ORG_ROLE_RANK[right] ? left : right;
}

// ---------------------------------------------------------------------------
// Reading an org role

/** The effective org role: the stronger of what was granted and what is mapped. */
export function orgRoleOf(db: DatabaseSync, actorId: string): OrgRole {
  const row = db.prepare('SELECT hand_role, mapped_role FROM actor_org_roles WHERE actor_id = ?').get(actorId) as
    | { hand_role: string | null; mapped_role: string | null }
    | undefined;
  if (!row) return 'member';
  const hand = isOrgRole(row.hand_role) ? row.hand_role : null;
  const mapped = isOrgRole(row.mapped_role) ? row.mapped_role : null;
  return strongerOrg(hand, mapped);
}

/** Both halves, for the "why does this person hold this" surfaces. */
export function orgRoleDetail(
  db: DatabaseSync,
  actorId: string,
): { role: OrgRole; hand: OrgRole | null; mapped: OrgRole | null; grantedBy: string | null; grantedAt: string | null } {
  const row = db
    .prepare('SELECT hand_role, mapped_role, granted_by, granted_at FROM actor_org_roles WHERE actor_id = ?')
    .get(actorId) as
    | { hand_role: string | null; mapped_role: string | null; granted_by: string | null; granted_at: string | null }
    | undefined;
  const hand = isOrgRole(row?.hand_role) ? row!.hand_role as OrgRole : null;
  const mapped = isOrgRole(row?.mapped_role) ? row!.mapped_role as OrgRole : null;
  return {
    role: strongerOrg(hand, mapped),
    hand,
    mapped,
    grantedBy: row?.granted_by ?? null,
    grantedAt: row?.granted_at ?? null,
  };
}

export function holdsOrgRole(db: DatabaseSync, actorId: string, needed: OrgRole): boolean {
  return ORG_ROLE_RANK[orgRoleOf(db, actorId)] >= ORG_ROLE_RANK[needed];
}

/** True for `operator` and for `administrator`: "is this person an operator of this Canon?" */
export function isOrgOperator(db: DatabaseSync, actorId: string): boolean {
  return holdsOrgRole(db, actorId, 'operator');
}

export function isOrgAdministrator(db: DatabaseSync, actorId: string): boolean {
  return holdsOrgRole(db, actorId, 'administrator');
}

/**
 * The refusal every replaced stand-in now raises. `what` names the act, so the
 * message tells the reader what they were trying to do and what it takes —
 * the CanonError convention (SECURITY.md R7): written for the person reading it.
 */
export function requireOrgRole(db: DatabaseSync, actorId: string, needed: OrgRole, what: string): void {
  const held = orgRoleOf(db, actorId);
  if (ORG_ROLE_RANK[held] >= ORG_ROLE_RANK[needed]) return;
  throw new CanonError(
    'forbidden',
    `${what} requires the ${needed} role for this Canon; ask an administrator. ` +
      `Administering one collection is not the same thing.`,
    { reason: 'org_role_required', neededOrgRole: needed, heldOrgRole: held },
  );
}

export function countOrgRole(db: DatabaseSync, role: OrgRole): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM actor_org_roles
        WHERE hand_role = ? OR mapped_role = ?
           OR (? = 'operator' AND (hand_role = 'administrator' OR mapped_role = 'administrator'))`,
    )
    .get(role, role, role) as { n: number };
  return Number(row?.n ?? 0);
}

export function listOrgRoleHolders(
  db: DatabaseSync,
): { actorId: string; role: OrgRole; hand: OrgRole | null; mapped: OrgRole | null }[] {
  const rows = db
    .prepare(
      `SELECT actor_id, hand_role, mapped_role FROM actor_org_roles
        WHERE hand_role IS NOT NULL OR mapped_role IS NOT NULL
        ORDER BY actor_id`,
    )
    .all() as { actor_id: string; hand_role: string | null; mapped_role: string | null }[];
  return rows.map((r) => {
    const hand = isOrgRole(r.hand_role) ? r.hand_role : null;
    const mapped = isOrgRole(r.mapped_role) ? r.mapped_role : null;
    return { actorId: r.actor_id, role: strongerOrg(hand, mapped), hand, mapped };
  });
}

// ---------------------------------------------------------------------------
// Writing an org role
//
// No permission check lives here: this module answers "what is true", and the
// callers (store.setOrgRole, the bootstrap below, groupmap.ts) each say who
// may change it. That is the same division agentauth.ts keeps between the
// Registry's answer and Canon's enforcement of it.

/** Grant or clear a hand-held org role. `member` clears it; the mapped half is untouched. */
export function setHandOrgRole(db: DatabaseSync, actorId: string, role: OrgRole, grantedBy: string | null): void {
  const value = role === 'member' ? null : role;
  db.prepare(
    `INSERT INTO actor_org_roles (actor_id, hand_role, mapped_role, granted_by, granted_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (actor_id) DO UPDATE SET hand_role = excluded.hand_role, granted_by = excluded.granted_by,
                                          granted_at = excluded.granted_at`,
  ).run(actorId, value, grantedBy, nowIso());
  pruneOrgRoleRow(db, actorId);
}

/** Set the mapped half from a group mapping. Returns true when it changed. */
export function setMappedOrgRole(db: DatabaseSync, actorId: string, role: OrgRole | null): boolean {
  const value = role === 'member' ? null : role;
  const before = orgRoleDetail(db, actorId).mapped;
  if (before === (value ?? null)) return false;
  db.prepare(
    `INSERT INTO actor_org_roles (actor_id, hand_role, mapped_role, granted_by, granted_at)
     VALUES (?, NULL, ?, NULL, ?)
     ON CONFLICT (actor_id) DO UPDATE SET mapped_role = excluded.mapped_role`,
  ).run(actorId, value, nowIso());
  pruneOrgRoleRow(db, actorId);
  return true;
}

// A row with nothing in either half says nothing; keeping it would make
// "member" look like a granted state rather than the absence of one.
function pruneOrgRoleRow(db: DatabaseSync, actorId: string): void {
  db.prepare('DELETE FROM actor_org_roles WHERE actor_id = ? AND hand_role IS NULL AND mapped_role IS NULL').run(
    actorId,
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
//
// The first administrator is the one grant nobody can be authorised to make,
// because the authority to make it is the thing being granted. Canon solves it
// twice over, and both are deliberate rather than incidental:
//
//   1. CANON_BOOTSTRAP_ADMIN_SUBJECT names a person AT THE IDENTITY PROVIDER —
//      their `sub` claim, or `issuer#sub` for a deployment that ever adds a
//      second provider. On every sign-in and every confirmation, that person is
//      (re-)made an administrator. This is the safe answer and the one a
//      deployment should use: it grants nothing to whoever happens to arrive
//      first, it is idempotent, and it cannot be locked out, because it is
//      re-asserted on each sign-in rather than applied once.
//
//   2. If no bootstrap subject is configured AND the record holds no
//      administrator at all, the FIRST person to sign in becomes one, with a
//      loud line on the console and an `org_role.bootstrap` audit event naming
//      them.
//
// Why (2) is safe enough to ship. The window is exactly one person wide and it
// closes permanently at the first sign-in — the second person to arrive gets
// nothing. The person who opens it is already someone the deployment's own
// identity provider authenticated, which is the same bar every other person in
// Canon passes. And the alternative is worse in a way that matters: with no
// bootstrap, `requireOrgRole` refuses everybody forever and the only repair is
// hand-editing the record's database, which is precisely the operation an
// audit log cannot describe. A deployment that does not want the window open at
// all sets the subject and it never opens.

export interface BootstrapOutcome {
  granted: boolean;
  reason: 'configured_subject' | 'first_person' | null;
}

/**
 * Apply the bootstrap rules to a person who has just authenticated.
 * `subjectKeys` are the spellings that identify them at the provider (bare
 * `sub` and `issuer#sub`), so a configured subject may be written either way.
 */
export function bootstrapAdministrator(
  db: DatabaseSync,
  actorId: string,
  subjectKeys: string[],
  configured: string[],
): BootstrapOutcome {
  const wanted = configured.map((s) => s.trim()).filter(Boolean);
  if (wanted.length > 0) {
    const named = subjectKeys.some((key) => wanted.includes(key));
    if (!named) return { granted: false, reason: null };
    if (orgRoleOf(db, actorId) === 'administrator') return { granted: false, reason: null };
    setHandOrgRole(db, actorId, 'administrator', null);
    return { granted: true, reason: 'configured_subject' };
  }
  if (countOrgRole(db, 'administrator') > 0) return { granted: false, reason: null };
  setHandOrgRole(db, actorId, 'administrator', null);
  return { granted: true, reason: 'first_person' };
}

/** `CANON_BOOTSTRAP_ADMIN_SUBJECT`, comma- or space-separated. */
export function bootstrapSubjectsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CANON_BOOTSTRAP_ADMIN_SUBJECT ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Collection membership: hand grants, group grants, and the effective role

export interface GrantExplanation {
  collectionId: string;
  role: Role;
  hand: Role | null;
  /** One entry per directory group that grants a role here, strongest first. */
  groups: { group: string; role: Role }[];
}

function strongerRole(a: Role | null, b: Role | null): Role | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * Recompute one person's effective role in one collection from the two grant
 * tables, and write it to `collection_members` — the table every other query in
 * Canon reads. No grant on either side means no row at all, so a person whose
 * group was removed and who was never granted anything by hand disappears from
 * the collection exactly as they would have before any of this existed.
 */
export function recomputeMembership(db: DatabaseSync, collectionId: string, actorId: string): Role | null {
  const hand = db
    .prepare('SELECT role FROM collection_hand_grants WHERE collection_id = ? AND actor_id = ?')
    .get(collectionId, actorId) as { role: Role } | undefined;
  const mapped = db
    .prepare('SELECT role FROM collection_group_grants WHERE collection_id = ? AND actor_id = ?')
    .all(collectionId, actorId) as { role: Role }[];
  let effective: Role | null = hand?.role ?? null;
  for (const row of mapped) effective = strongerRole(effective, row.role);
  if (!effective) {
    db.prepare('DELETE FROM collection_members WHERE collection_id = ? AND actor_id = ?').run(collectionId, actorId);
    return null;
  }
  db.prepare(
    `INSERT INTO collection_members (collection_id, actor_id, role) VALUES (?, ?, ?)
     ON CONFLICT (collection_id, actor_id) DO UPDATE SET role = excluded.role`,
  ).run(collectionId, actorId, effective);
  return effective;
}

/** Record a hand grant (or, with `null`, withdraw one) and recompute the effective role. */
export function setHandGrant(
  db: DatabaseSync,
  collectionId: string,
  actorId: string,
  role: Role | null,
): { effective: Role | null; mapped: { group: string; role: Role }[] } {
  if (role) {
    db.prepare(
      `INSERT INTO collection_hand_grants (collection_id, actor_id, role) VALUES (?, ?, ?)
       ON CONFLICT (collection_id, actor_id) DO UPDATE SET role = excluded.role`,
    ).run(collectionId, actorId, role);
  } else {
    db.prepare('DELETE FROM collection_hand_grants WHERE collection_id = ? AND actor_id = ?').run(
      collectionId,
      actorId,
    );
  }
  const effective = recomputeMembership(db, collectionId, actorId);
  const mapped = db
    .prepare('SELECT group_name, role FROM collection_group_grants WHERE collection_id = ? AND actor_id = ?')
    .all(collectionId, actorId) as { group_name: string; role: Role }[];
  return { effective, mapped: mapped.map((m) => ({ group: m.group_name, role: m.role })) };
}

/** What one person holds, and where each piece of it came from. */
export function explainCollectionAccess(db: DatabaseSync, actorId: string): GrantExplanation[] {
  const ids = new Set<string>();
  for (const row of db
    .prepare('SELECT collection_id FROM collection_members WHERE actor_id = ?')
    .all(actorId) as { collection_id: string }[]) {
    ids.add(row.collection_id);
  }
  const out: GrantExplanation[] = [];
  for (const collectionId of [...ids].sort()) {
    const hand = db
      .prepare('SELECT role FROM collection_hand_grants WHERE collection_id = ? AND actor_id = ?')
      .get(collectionId, actorId) as { role: Role } | undefined;
    const groups = (
      db
        .prepare(
          'SELECT group_name, role FROM collection_group_grants WHERE collection_id = ? AND actor_id = ? ORDER BY group_name',
        )
        .all(collectionId, actorId) as { group_name: string; role: Role }[]
    )
      .map((g) => ({ group: g.group_name, role: g.role }))
      .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]);
    const effective = (
      db
        .prepare('SELECT role FROM collection_members WHERE collection_id = ? AND actor_id = ?')
        .get(collectionId, actorId) as { role: Role } | undefined
    )?.role;
    if (!effective) continue;
    out.push({ collectionId, role: effective, hand: hand?.role ?? null, groups });
  }
  return out;
}

/** The groups this person presented at their last confirmation. */
export function groupsOf(db: DatabaseSync, actorId: string): string[] {
  return (
    db.prepare('SELECT group_name FROM actor_groups WHERE actor_id = ? ORDER BY group_name').all(actorId) as {
      group_name: string;
    }[]
  ).map((r) => r.group_name);
}

/** Replace the recorded groups wholesale. Returns true when the set changed. */
export function recordGroups(db: DatabaseSync, actorId: string, groups: string[]): boolean {
  const before = groupsOf(db, actorId);
  const after = [...new Set(groups)].sort();
  if (before.length === after.length && before.every((g, i) => g === after[i])) return false;
  db.prepare('DELETE FROM actor_groups WHERE actor_id = ?').run(actorId);
  const insert = db.prepare('INSERT INTO actor_groups (actor_id, group_name, seen_at) VALUES (?, ?, ?)');
  const at = nowIso();
  for (const group of after) insert.run(actorId, group, at);
  return true;
}
