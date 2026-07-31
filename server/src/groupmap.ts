// Group claims from the identity provider, mapped onto Canon roles
// (SECURITY.md R10).
//
// THE PROBLEM. A person who signs in through SSO and holds no Canon role sees
// an empty Canon. That is the correct default — a claim from a directory is not
// a Canon permission — but a partner with three hundred staff cannot hand-assign
// membership, and R10 said so.
//
// THE SHAPE. The ID token carries a group claim (a configurable claim name; the
// value is an array of opaque strings). A deployment configures a mapping from
// group to (collection, role) and from group to org role. The mapping is applied
// on EVERY confirmation of the person's session, not only at first sign-in, so a
// group removed at the identity provider removes the access it granted inside
// the same window R9's confirmation guarantees — sixty seconds by default.
//
// WHAT THIS DELIBERATELY IS NOT.
//
// - It is not a UI. Mapping a directory group onto a role in a regulated record
//   is a deployment decision, made once, reviewable in the same place the rest
//   of the deployment's configuration is reviewed, and changed by the people who
//   can change that. A screen for it invites someone to do it at speed.
// - It never widens the record's own permission model. A rule grants a
//   COLLECTION ROLE from Canon's fixed vocabulary (`view` … `admin`) or an ORG
//   ROLE, and there is no third kind of target: a group cannot make somebody a
//   page's approver, cannot bypass a document type's rules, cannot mint a
//   collection, and cannot grant anything on a collection that does not exist.
//   A mapped role reaches the record through exactly the table a hand grant
//   does, so every check downstream is the same check.
// - It is not silent about what it did. Every rule is inspectable
//   (`GET /auth/mapping`), and for any person an operator can ask which group
//   granted which role where (`GET /auth/access/:actorId`), which is the answer
//   to "why does this person have edit here".
//
// MAPPED ACCESS IS NOT HAND-GRANTED ACCESS. The two are stored apart
// (orgrole.ts) and the effective role is the stronger of them. So revoking a
// group removes exactly what that group granted and leaves an administrator's
// hand grant standing, and withdrawing a hand grant does not leave a phantom
// mapping behind. Without that separation this feature would quietly undo F2
// and R5 — the audit narrowing and the operator stand-in both rest on
// membership meaning something deliberate.
//
// THE SYNTAX. One rule per line (or separated by `;`), `#` starts a comment:
//
//     # who edits the Compliance collection
//     Canon-Compliance-Editors -> collection:8f14…:edit
//     Canon-Compliance-Leads   -> collection:8f14…:admin
//     Canon-Operators          -> org:operator
//
// Group names are opaque and are compared exactly: they may contain spaces and
// commas (they are directory group names, and Active Directory's are full of
// both), which is why the separator is a line and not a comma.

import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { CanonError, Role, ROLE_RANK } from './model.js';
import {
  isOrgRole,
  ORG_ROLE_RANK,
  OrgRole,
  recomputeMembership,
  recordGroups,
  setMappedOrgRole,
} from './orgrole.js';

const ROLES: readonly Role[] = ['view', 'comment', 'edit', 'approve', 'admin'];

export type GroupRule =
  | { group: string; target: 'collection'; collectionId: string; role: Role }
  | { group: string; target: 'org'; orgRole: OrgRole };

export interface GroupMapping {
  /** The ID-token claim the groups arrive in. Default `groups`. */
  claim: string;
  rules: GroupRule[];
}

export const DEFAULT_GROUPS_CLAIM = 'groups';

/**
 * Parse the rule text. Every syntax error is a refusal naming the line: a
 * mapping that is quietly half-read is a mapping nobody can reason about, and a
 * deployment must find out at start-up rather than when somebody cannot open a
 * policy.
 */
export function parseGroupRules(text: string): GroupRule[] {
  const rules: GroupRule[] = [];
  const lines = text
    .split(/[\n;]/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  for (const line of lines) {
    const arrow = line.indexOf('->');
    if (arrow < 0) {
      throw new CanonError('invalid', `Group mapping rule has no '->': ${line}`, { reason: 'group_map_syntax', line });
    }
    const group = line.slice(0, arrow).trim();
    const target = line.slice(arrow + 2).trim();
    if (!group) {
      throw new CanonError('invalid', `Group mapping rule names no group: ${line}`, {
        reason: 'group_map_syntax',
        line,
      });
    }
    if (target.startsWith('org:')) {
      const orgRole = target.slice(4).trim();
      if (!isOrgRole(orgRole) || orgRole === 'member') {
        throw new CanonError(
          'invalid',
          `Group mapping rule names an org role Canon does not have: ${orgRole || '(empty)'}. ` +
            `Use operator or administrator; member is what everyone is already.`,
          { reason: 'group_map_unknown_org_role', line, orgRole },
        );
      }
      rules.push({ group, target: 'org', orgRole });
      continue;
    }
    if (target.startsWith('collection:')) {
      const rest = target.slice('collection:'.length);
      const colon = rest.lastIndexOf(':');
      if (colon <= 0) {
        throw new CanonError(
          'invalid',
          `Group mapping rule must read collection:<collectionId>:<role>: ${line}`,
          { reason: 'group_map_syntax', line },
        );
      }
      const collectionId = rest.slice(0, colon).trim();
      const role = rest.slice(colon + 1).trim();
      if (!ROLES.includes(role as Role)) {
        throw new CanonError(
          'invalid',
          `Group mapping rule names a role Canon does not have: ${role || '(empty)'}. ` +
            `Canon's roles are ${ROLES.join(', ')}.`,
          { reason: 'group_map_unknown_role', line, role },
        );
      }
      if (!collectionId) {
        throw new CanonError('invalid', `Group mapping rule names no collection: ${line}`, {
          reason: 'group_map_syntax',
          line,
        });
      }
      rules.push({ group, target: 'collection', collectionId, role: role as Role });
      continue;
    }
    throw new CanonError(
      'invalid',
      `Group mapping rule target must be collection:<id>:<role> or org:<role>: ${line}`,
      { reason: 'group_map_syntax', line },
    );
  }
  return rules;
}

/**
 * Check every rule against the record itself. A rule naming a collection that
 * does not exist is REFUSED HERE, at configuration time — the deployment does
 * not start — rather than ignored at sign-in, where the symptom would be a
 * person quietly holding less access than the operator believes they were
 * given, discovered weeks later.
 */
export function validateGroupRules(db: DatabaseSync, rules: readonly GroupRule[]): void {
  for (const rule of rules) {
    if (rule.target !== 'collection') continue;
    const row = db.prepare('SELECT id FROM collections WHERE id = ?').get(rule.collectionId) as
      | { id: string }
      | undefined;
    if (!row) {
      throw new CanonError(
        'invalid',
        `Group mapping rule for '${rule.group}' names a collection that does not exist: ${rule.collectionId}. ` +
          `Create the collection first, or correct the mapping.`,
        { reason: 'group_map_unknown_collection', group: rule.group, collectionId: rule.collectionId },
      );
    }
  }
}

/** `CANON_OIDC_GROUPS_CLAIM`, `CANON_GROUP_MAP` and `CANON_GROUP_MAP_FILE`. */
export function groupMappingFromEnv(env: NodeJS.ProcessEnv = process.env): GroupMapping {
  const claim = env.CANON_OIDC_GROUPS_CLAIM?.trim() || DEFAULT_GROUPS_CLAIM;
  const inline = env.CANON_GROUP_MAP ?? '';
  const file = env.CANON_GROUP_MAP_FILE?.trim();
  let text = inline;
  if (file) {
    let fromFile: string;
    try {
      fromFile = readFileSync(file, 'utf8');
    } catch (err) {
      throw new CanonError('invalid', `CANON_GROUP_MAP_FILE cannot be read: ${(err as Error).message}`, {
        reason: 'group_map_unreadable',
      });
    }
    text = `${text}\n${fromFile}`;
  }
  return { claim, rules: parseGroupRules(text) };
}

/** Read the group claim out of validated ID-token claims. Anything unusable reads as no groups. */
export function groupsFromClaims(claims: Record<string, unknown>, claim: string): string[] {
  const value = claims[claim];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  }
  // A provider that sends a single group as a bare string is common enough to
  // accept; anything else (an object, a number) is not a group list and is read
  // as none rather than guessed at.
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export interface MappingChange {
  collectionId: string;
  role: Role;
  group: string;
}

export interface MappingOutcome {
  changed: boolean;
  groups: string[];
  granted: MappingChange[];
  revoked: MappingChange[];
  orgRole: { from: OrgRole | null; to: OrgRole | null } | null;
}

/**
 * Apply the mapping for one person, from the groups their current ID token
 * carries. Idempotent: called on every confirmation, and reports `changed:
 * false` when the answer is the same as last time, so a session that is simply
 * being kept alive writes no audit event.
 *
 * The group grants are rewritten WHOLESALE from the claim rather than merged
 * into what was there. That is what makes removal work: a group that is no
 * longer in the token has no row after this runs, whatever it granted before.
 */
export function applyGroupMapping(
  db: DatabaseSync,
  actorId: string,
  groups: readonly string[],
  mapping: GroupMapping,
): MappingOutcome {
  const held = new Set(groups);
  const desired = new Map<string, MappingChange>();
  let orgWanted: OrgRole | null = null;
  for (const rule of mapping.rules) {
    if (!held.has(rule.group)) continue;
    if (rule.target === 'org') {
      if (!orgWanted || ORG_ROLE_RANK[rule.orgRole] > ORG_ROLE_RANK[orgWanted]) orgWanted = rule.orgRole;
      continue;
    }
    const key = `${rule.collectionId} ${rule.group}`;
    const existing = desired.get(key);
    // One group naming the same collection twice keeps the stronger role; the
    // rules are a set of statements, not an ordered program.
    if (!existing || ROLE_RANK[rule.role] > ROLE_RANK[existing.role]) {
      desired.set(key, { collectionId: rule.collectionId, role: rule.role, group: rule.group });
    }
  }

  const current = db
    .prepare('SELECT collection_id, group_name, role FROM collection_group_grants WHERE actor_id = ?')
    .all(actorId) as { collection_id: string; group_name: string; role: Role }[];

  const granted: MappingChange[] = [];
  const revoked: MappingChange[] = [];
  const touched = new Set<string>();

  for (const row of current) {
    const key = `${row.collection_id} ${row.group_name}`;
    const want = desired.get(key);
    if (want && want.role === row.role) continue;
    db.prepare(
      'DELETE FROM collection_group_grants WHERE collection_id = ? AND actor_id = ? AND group_name = ?',
    ).run(row.collection_id, actorId, row.group_name);
    touched.add(row.collection_id);
    if (!want) revoked.push({ collectionId: row.collection_id, role: row.role, group: row.group_name });
  }

  const at = new Date().toISOString();
  for (const [key, want] of desired) {
    const existing = current.find((r) => `${r.collection_id} ${r.group_name}` === key);
    if (existing && existing.role === want.role) continue;
    db.prepare(
      'INSERT INTO collection_group_grants (collection_id, actor_id, group_name, role, granted_at) VALUES (?, ?, ?, ?, ?)',
    ).run(want.collectionId, actorId, want.group, want.role, at);
    touched.add(want.collectionId);
    granted.push(want);
  }

  for (const collectionId of touched) recomputeMembership(db, collectionId, actorId);

  const orgBefore = orgRoleFromMapped(db, actorId);
  const orgChanged = setMappedOrgRole(db, actorId, orgWanted);
  const groupsChanged = recordGroups(db, actorId, [...held]);

  return {
    changed: granted.length > 0 || revoked.length > 0 || orgChanged || groupsChanged,
    groups: [...held].sort(),
    granted,
    revoked,
    orgRole: orgChanged ? { from: orgBefore, to: orgWanted } : null,
  };
}

function orgRoleFromMapped(db: DatabaseSync, actorId: string): OrgRole | null {
  const row = db.prepare('SELECT mapped_role FROM actor_org_roles WHERE actor_id = ?').get(actorId) as
    | { mapped_role: string | null }
    | undefined;
  return isOrgRole(row?.mapped_role) ? (row!.mapped_role as OrgRole) : null;
}

/** The rules as configured, for the inspection route. */
export function describeMapping(mapping: GroupMapping): {
  claim: string;
  rules: { group: string; grants: string }[];
} {
  return {
    claim: mapping.claim,
    rules: mapping.rules.map((rule) => ({
      group: rule.group,
      grants: rule.target === 'org' ? `org:${rule.orgRole}` : `collection:${rule.collectionId}:${rule.role}`,
    })),
  };
}
