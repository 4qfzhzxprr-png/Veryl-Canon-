// R10: group claims, and the mapping from a directory group to Canon roles
// (server/src/groupmap.ts).
//
// SECURITY.md R10 said: "a partner with hundreds of staff will want
// group-to-collection mapping, and designing it badly (an IdP group silently
// granting `admin`) would undo F2 and F11 at once." The property that keeps
// that from happening is that MAPPED access and HAND-GRANTED access are stored
// apart and neither inherits the other, so most of this file is about the four
// combinations of the two.
//
// Run against the real idp-stub, which really does stop putting a group in the
// ID token when the group is taken away.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersonAuth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { applyGroupMapping, groupsFromClaims, parseGroupRules } from '../src/groupmap.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';
import { authRig } from './authrig.js';

const quiet: NotificationTransport = { deliver() {} };

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------
// Configuration is refused at configuration time

test('config: the rule syntax is parsed, comments and all', () => {
  const rules = parseGroupRules(`
    # who edits Compliance
    Canon-Compliance-Editors -> collection:c-1:edit
    Canon-Compliance-Leads   -> collection:c-1:admin ; Canon-Operators -> org:operator
    Group With Spaces, And A Comma -> collection:c-2:view
  `);
  assert.equal(rules.length, 4);
  assert.deepEqual(rules[0], { group: 'Canon-Compliance-Editors', target: 'collection', collectionId: 'c-1', role: 'edit' });
  assert.deepEqual(rules[2], { group: 'Canon-Operators', target: 'org', orgRole: 'operator' });
  assert.equal(rules[3]!.group, 'Group With Spaces, And A Comma', 'directory names contain commas; lines separate rules');
});

test('config: a rule naming a role or a collection Canon does not have is refused, not ignored', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });

  // Syntax and vocabulary, at parse time.
  expectCode(() => parseGroupRules('Editors -> collection:c-1'), 'invalid');
  expectCode(() => parseGroupRules('Editors collection:c-1:edit'), 'invalid');
  expectCode(() => parseGroupRules('-> collection:c-1:edit'), 'invalid');
  const badRole = expectCode(() => parseGroupRules(`Editors -> collection:${collection.id}:editor`), 'invalid');
  assert.equal(badRole.details.reason, 'group_map_unknown_role');
  assert.match(badRole.message, /view, comment, edit, approve, admin/);
  const badOrg = expectCode(() => parseGroupRules('Ops -> org:root'), 'invalid');
  assert.equal(badOrg.details.reason, 'group_map_unknown_org_role');
  expectCode(() => parseGroupRules('Everyone -> org:member'), 'invalid');
  expectCode(() => parseGroupRules('Editors -> whatever:c-1:edit'), 'invalid');

  // And the collection, against the record, when the door is built. The
  // deployment does not start: a mapping quietly ignored would show up weeks
  // later as somebody holding less access than the operator granted.
  const build = (rules: string) =>
    new PersonAuth({
      db,
      store,
      devAuth: true,
      oidc: null,
      mapping: { claim: 'groups', rules: parseGroupRules(rules) },
    });
  const unknown = expectCode(() => build('Editors -> collection:no-such-collection:edit'), 'invalid');
  assert.equal(unknown.details.reason, 'group_map_unknown_collection');
  assert.match(unknown.message, /Create the collection first/);
  assert.ok(build(`Editors -> collection:${collection.id}:edit`), 'and a rule naming a real collection is accepted');
});

test('config: the group claim is read defensively', () => {
  assert.deepEqual(groupsFromClaims({ groups: ['a', 'b', ' c '] }, 'groups'), ['a', 'b', 'c']);
  assert.deepEqual(groupsFromClaims({ roles: ['a'] }, 'roles'), ['a'], 'the claim name is configuration');
  assert.deepEqual(groupsFromClaims({ groups: 'just-one' }, 'groups'), ['just-one']);
  assert.deepEqual(groupsFromClaims({}, 'groups'), []);
  assert.deepEqual(groupsFromClaims({ groups: null }, 'groups'), []);
  assert.deepEqual(groupsFromClaims({ groups: { a: 1 } }, 'groups'), [], 'nonsense reads as none, never as everything');
  assert.deepEqual(groupsFromClaims({ groups: ['ok', 7, null] }, 'groups'), ['ok']);
});

// ---------------------------------------------------------------------------
// Granting, on the first sign-in and on every confirmation afterwards

async function mappedRig(opts: { confirmWindowMs?: number; groupsClaim?: string; canonGroupsClaim?: string } = {}) {
  return authRig({
    confirmWindowMs: opts.confirmWindowMs ?? 10_000,
    ...(opts.groupsClaim ? { groupsClaim: opts.groupsClaim } : {}),
    ...(opts.canonGroupsClaim ? { canonGroupsClaim: opts.canonGroupsClaim } : {}),
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com', groups: ['Canon-Compliance-Editors'] },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com', groups: [] },
    ],
    prepare: (store) => {
      const owner = store.createActor({ kind: 'person', name: 'Owner' });
      store.bootstrapAdministrator(owner.id);
      const compliance = store.createCollection(owner.id, { name: 'Compliance' });
      const board = store.createCollection(owner.id, { name: 'Board' });
      return { ownerId: owner.id, compliance: compliance.id, board: board.id };
    },
    rules: (ids) => `
      Canon-Compliance-Editors -> collection:${ids.compliance}:edit
      Canon-Board              -> collection:${ids.board}:view
      Canon-Operators          -> org:operator
    `,
  });
}

/** Age every session past its confirmation window, the way the clock would. */
function age(r: Awaited<ReturnType<typeof mappedRig>>): void {
  r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 300_000).toISOString());
}

test('mapping: a group grants its role on the first sign-in', async () => {
  const r = await mappedRig();
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'edit');
    assert.equal(r.store.roleOf(dana.id, r.seeded.board!), null, 'a group she is not in grants nothing');

    // A person in no mapped group still sees an empty Canon, which is the
    // correct default and the thing R10 did not change.
    await r.signIn('iris');
    const iris = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;
    assert.deepEqual(r.store.listCollections(iris.id), []);

    const event = r.store.queryAudit(dana.id, { action: 'person.access_mapped' })[0];
    assert.ok(event, 'the grant is on the record');
    assert.deepEqual(event!.details.groups, ['Canon-Compliance-Editors']);
  } finally {
    r.close();
  }
});

test('mapping: a group added at the provider grants access at the next confirmation', async () => {
  const r = await mappedRig();
  try {
    const { jar } = await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.roleOf(dana.id, r.seeded.board!), null);

    r.idp.updateUser('dana', { groups: ['Canon-Compliance-Editors', 'Canon-Board', 'Canon-Operators'] });
    assert.equal(r.store.roleOf(dana.id, r.seeded.board!), null, 'inside the window, nothing has changed');

    age(r);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    assert.equal(r.store.roleOf(dana.id, r.seeded.board!), 'view', 'the mapping is applied on EVERY confirmation');
    assert.equal(r.store.orgRoleOf(dana.id), 'operator', 'including the org role');
  } finally {
    r.close();
  }
});

test('mapping: removing a group removes exactly what it granted, within the same window', async () => {
  const r = await mappedRig();
  try {
    const { jar } = await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'edit');

    r.idp.updateUser('dana', { groups: [] });
    age(r);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), null, 'the access the group granted is gone');
    assert.deepEqual(r.store.listCollections(dana.id), []);

    const events = r.store.queryAudit(dana.id, { action: 'person.access_mapped' });
    assert.ok(
      events.some((e) => (e.details.revoked as { collectionId: string }[]).some((x) => x.collectionId === r.seeded.compliance)),
      'and the removal is on the record as plainly as the grant was',
    );
  } finally {
    r.close();
  }
});

test('mapping: revoking a group does not delete a hand grant underneath it', async () => {
  const r = await mappedRig();
  try {
    const { jar } = await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    // An administrator grants `view` by hand; the group grants `edit`. The
    // effective role is the stronger of the two.
    r.store.setMember(r.seeded.ownerId!, r.seeded.compliance!, dana.id, 'view');
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'edit');

    r.idp.updateUser('dana', { groups: [] });
    age(r);
    await r.call('GET', '/collections', { jar });

    assert.equal(
      r.store.roleOf(dana.id, r.seeded.compliance!),
      'view',
      'losing the group loses the group’s role and nothing else',
    );
    const explained = r.store.explainAccess(r.seeded.ownerId!, dana.id);
    assert.deepEqual(explained.collections, [
      { collectionId: r.seeded.compliance!, role: 'view', hand: 'view', groups: [] },
    ]);
  } finally {
    r.close();
  }
});

test('mapping: a hand grant survives confirmation after confirmation, and leaves no phantom mapping', async () => {
  const r = await mappedRig();
  try {
    const { jar } = await r.signIn('iris'); // in no group at all
    const iris = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;
    r.store.setMember(r.seeded.ownerId!, r.seeded.board!, iris.id, 'approve');

    for (let i = 0; i < 3; i += 1) {
      age(r);
      assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    }
    assert.equal(r.store.roleOf(iris.id, r.seeded.board!), 'approve', 'a hand grant is not the mapping’s to withdraw');

    // And withdrawing it by hand really withdraws it: no group is holding it up.
    const removal = r.store.removeMember(r.seeded.ownerId!, r.seeded.board!, iris.id);
    assert.deepEqual(removal, { removed: true, remaining: null, groups: [] });
    assert.equal(r.store.roleOf(iris.id, r.seeded.board!), null);
  } finally {
    r.close();
  }
});

test('mapping: withdrawing a hand grant tells the administrator when a group still holds it', async () => {
  const r = await mappedRig();
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    r.store.setMember(r.seeded.ownerId!, r.seeded.compliance!, dana.id, 'admin');
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'admin');

    // The administrator takes their grant back — and is told, rather than left
    // to discover, that the directory is still granting `edit` here.
    const removal = r.store.removeMember(r.seeded.ownerId!, r.seeded.compliance!, dana.id);
    assert.equal(removal.removed, false);
    assert.equal(removal.remaining, 'edit');
    assert.deepEqual(removal.groups, [{ group: 'Canon-Compliance-Editors', role: 'edit' }]);
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'edit');

    const events = r.store.queryAudit(r.seeded.ownerId!, { action: 'collection.member_removed' });
    assert.equal(events[0]!.details.remainingRole, 'edit', 'and so is anybody reading the log');
  } finally {
    r.close();
  }
});

test('mapping: it grants collection roles and nothing more', async () => {
  const r = await mappedRig();
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;

    // `edit` is `edit`: the mapped role goes through the same table and the
    // same checks a hand grant does, so it cannot approve, cannot administer
    // the collection, and cannot reach a collection no rule named.
    const page = r.store.createPage(dana.id, {
      collectionId: r.seeded.compliance!,
      type: 'policy',
      title: 'Retention',
    });
    r.store.editDraft(dana.id, page.id, {
      body: 'Seven years.',
      fields: { ownerId: dana.id, approverId: r.seeded.ownerId!, reviewDate: '2027-01-01' },
    });
    r.store.submitForReview(dana.id, page.id);
    expectCode(() => r.store.approve(dana.id, page.id), 'forbidden');
    expectCode(() => r.store.setMember(dana.id, r.seeded.compliance!, dana.id, 'admin'), 'forbidden');
    expectCode(() => r.store.getCollection(dana.id, r.seeded.board!), 'forbidden');
    assert.equal(r.store.orgRoleOf(dana.id), 'member', 'and a collection rule grants no org role');
  } finally {
    r.close();
  }
});

test('mapping: the claim name is configuration on both sides', async () => {
  // The provider issues `roles`; Canon is told to read `roles`.
  const r = await mappedRig({ groupsClaim: 'roles' });
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), 'edit');
  } finally {
    r.close();
  }
});

test('mapping: a claim name that does not match grants nothing, rather than guessing', async () => {
  const r = await mappedRig({ groupsClaim: 'roles', canonGroupsClaim: 'groups' });
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.roleOf(dana.id, r.seeded.compliance!), null);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// "Why does this person have edit here?"

test('inspection: an operator can see the rules, and where one person’s access came from', async () => {
  const r = await mappedRig();
  try {
    const owner = (await r.signIn('dana')).jar; // Dana is not the operator here
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    r.store.setOrgRole(r.seeded.ownerId!, dana.id, 'operator');

    const mapping = await r.call('GET', '/auth/mapping', { jar: owner });
    assert.equal(mapping.status, 200);
    assert.equal(mapping.json.claim, 'groups');
    assert.deepEqual(mapping.json.rules[0], {
      group: 'Canon-Compliance-Editors',
      grants: `collection:${r.seeded.compliance}:edit`,
    });

    r.store.setMember(r.seeded.ownerId!, r.seeded.board!, dana.id, 'view'); // by hand
    const access = await r.call('GET', `/auth/access/${dana.id}`, { jar: owner });
    assert.equal(access.status, 200);
    assert.deepEqual(access.json.groups, ['Canon-Compliance-Editors']);
    const compliance = access.json.collections.find((c: any) => c.collectionId === r.seeded.compliance);
    assert.deepEqual(compliance, {
      collectionId: r.seeded.compliance,
      role: 'edit',
      hand: null,
      groups: [{ group: 'Canon-Compliance-Editors', role: 'edit' }],
    });
    const board = access.json.collections.find((c: any) => c.collectionId === r.seeded.board);
    assert.deepEqual(board.groups, [], 'a hand grant is not attributed to a group');
    assert.equal(board.hand, 'view');
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The applier on its own, where the awkward combinations are cheap to write

test('mapping: applying it twice changes nothing the second time', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const owner = store.createActor({ kind: 'person', name: 'Owner' });
  const person = store.createActor({ kind: 'person', name: 'Person' });
  const collection = store.createCollection(owner.id, { name: 'Compliance' });
  const mapping = {
    claim: 'groups',
    rules: parseGroupRules(`Editors -> collection:${collection.id}:edit\nLeads -> collection:${collection.id}:admin`),
  };

  const first = applyGroupMapping(db, person.id, ['Editors'], mapping);
  assert.equal(first.changed, true);
  assert.equal(store.roleOf(person.id, collection.id), 'edit');

  const again = applyGroupMapping(db, person.id, ['Editors'], mapping);
  assert.equal(again.changed, false, 'a session merely being kept alive writes no audit event');

  // Two groups granting different roles in one collection: the stronger wins,
  // and losing the stronger group falls back to the weaker rather than to none.
  applyGroupMapping(db, person.id, ['Editors', 'Leads'], mapping);
  assert.equal(store.roleOf(person.id, collection.id), 'admin');
  applyGroupMapping(db, person.id, ['Editors'], mapping);
  assert.equal(store.roleOf(person.id, collection.id), 'edit');
  applyGroupMapping(db, person.id, [], mapping);
  assert.equal(store.roleOf(person.id, collection.id), null);
});

test('mapping: an org role from a group is withdrawn with the group, and never touches a hand grant', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const owner = store.createActor({ kind: 'person', name: 'Owner' });
  store.bootstrapAdministrator(owner.id);
  const person = store.createActor({ kind: 'person', name: 'Person' });
  const mapping = { claim: 'groups', rules: parseGroupRules('Ops -> org:operator') };

  applyGroupMapping(db, person.id, ['Ops'], mapping);
  assert.equal(store.orgRoleOf(person.id), 'operator');
  applyGroupMapping(db, person.id, [], mapping);
  assert.equal(store.orgRoleOf(person.id), 'member');

  // A hand-granted role survives the mapping saying nothing about it.
  store.setOrgRole(owner.id, person.id, 'administrator');
  applyGroupMapping(db, person.id, [], mapping);
  assert.equal(store.orgRoleOf(person.id), 'administrator');
  // And the two halves are visible separately, which is what "why" needs.
  const explained = store.explainAccess(owner.id, person.id);
  assert.equal(explained.orgRoleHand, 'administrator');
  assert.equal(explained.orgRoleMapped, null);
});
