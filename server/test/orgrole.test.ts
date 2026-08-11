// The organisation-level role (server/src/orgrole.ts) and the five checks that
// used to ask "does this actor hold `admin` on ANY collection?" instead.
//
// SECURITY.md R5 named four of them — the audit narrowing for collection-less
// events, the actor directory, the notification flush, and Canon-wide source
// registration — and said "when an organisation-level administrator role
// arrives, those three checks change together". A grep found a fifth, the
// freshness sweep. Every one of them is tested here from both sides: the team
// lead who administers one collection and is NOT an operator, and the operator
// who belongs to no collection at all and IS one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { ORG_ROLE_RANK, orgRoleOf, setHandOrgRole } from '../src/orgrole.js';
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

async function expectCodeAsync(promise: Promise<unknown>, code: string): Promise<CanonError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

/**
 * The cast this file keeps using:
 *   lead  — administers one collection, and nothing else. The team lead the
 *           old stand-in wrongly promoted to operator of the whole Canon.
 *   ops   — the org's operator, a member of NO collection. The person the old
 *           stand-in made invisible.
 *   admin — the org's administrator.
 *   marc  — an ordinary contributor.
 */
function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const lead = store.createActor({ kind: 'person', name: 'Team lead', email: 'lead@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const ops = store.createActor({ kind: 'person', name: 'Ops', email: 'ops@example.com' });
  const admin = store.createActor({ kind: 'person', name: 'Admin', email: 'admin@example.com' });
  const collection = store.createCollection(lead.id, { name: 'Their team' });
  store.setMember(lead.id, collection.id, marc.id, 'edit');
  setHandOrgRole(db, ops.id, 'operator', null);
  setHandOrgRole(db, admin.id, 'administrator', null);
  return { db, store, lead, marc, ops, admin, collection };
}

// ---------------------------------------------------------------------------
// The model itself

test('org role: the default is member, and it is the absence of a grant', () => {
  const { db, store, lead, marc, ops, admin } = setup();
  assert.equal(store.orgRoleOf(marc.id), 'member');
  assert.equal(store.orgRoleOf(lead.id), 'member', 'administering a collection is not an org role');
  assert.equal(store.orgRoleOf(ops.id), 'operator');
  assert.equal(store.orgRoleOf(admin.id), 'administrator');
  assert.equal(store.isOperator(admin.id), true, 'administrator implies operator');
  assert.equal(store.isOperator(ops.id), true);
  assert.equal(store.isOperator(lead.id), false);
  assert.ok(ORG_ROLE_RANK.administrator > ORG_ROLE_RANK.operator);
  assert.ok(ORG_ROLE_RANK.operator > ORG_ROLE_RANK.member);

  // Nothing is stored for a member: "member" is what an actor is when the
  // record says nothing about them.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM actor_org_roles').get() as { n: number };
  assert.equal(Number(rows.n), 2);
});

// ---------------------------------------------------------------------------
// Stand-in 1 — the audit narrowing for collection-less events (store.ts, R5)

test('stand-in 1: a collection-less audit event reaches an operator, not a collection admin', async () => {
  const { store, lead, marc, ops, collection } = setup();
  const bot = store.createActor({ kind: 'agent', name: 'PolicyBot', registryRef: 'passport:bot-1' });
  store.setMember(lead.id, collection.id, bot.id, 'view');
  await store.ask(bot.id, { question: 'What is the parental leave allowance?' }); // names no collection

  const asks = (actorId: string) => store.queryAudit(actorId, { action: 'answer.ask' });
  assert.equal(asks(ops.id).length, 1, 'the operator reads it, holding no collection role at all');
  assert.equal(asks(bot.id).length, 1, 'so does the actor it is about');
  assert.equal(asks(lead.id).length, 0, 'the administrator of one collection no longer does');
  assert.equal(asks(marc.id).length, 0);

  // F2's rule is untouched: a collection-scoped event still reaches members,
  // and still does not reach an operator who is not one.
  assert.ok(store.queryAudit(marc.id, { action: 'collection.member_set' }).length > 0);
  assert.equal(store.queryAudit(ops.id, { action: 'collection.member_set' }).length, 0);
});

// ---------------------------------------------------------------------------
// Stand-in 2 — the actor directory (auth.ts visibleActors, F11's residual)

test('stand-in 2: the whole directory goes to an operator, not to a collection admin', async () => {
  const { store, lead, marc, ops } = setup();
  const { visibleActors } = await import('../src/auth.js');

  const asOps = visibleActors(store, ops.id);
  assert.equal(asOps.length, 4, 'an operator can find anybody, which is what granting a role needs');
  assert.ok(asOps.every((a) => a.email !== null));

  const asLead = visibleActors(store, lead.id);
  assert.deepEqual(
    asLead.map((a) => a.name).sort(),
    ['Marc', 'Team lead'],
    'F11 residual closed: administering one collection shows you your colleagues, not the organisation',
  );
  assert.equal(asLead.find((a) => a.name === 'Marc')!.email, null, 'and not their addresses');
  assert.equal(visibleActors(store, marc.id).length, 2);
});

// ---------------------------------------------------------------------------
// Stand-in 3 — the notification flush (notify.ts flushFor)

test('stand-in 3: flushing the outbox takes the operator role', async () => {
  const { store, lead, marc, ops } = setup();
  const { notifierFor } = await import('../src/notify.js');
  const notifier = notifierFor(store)!;

  await expectCodeAsync(notifier.flushFor(marc.id), 'forbidden');
  const refused = await expectCodeAsync(notifier.flushFor(lead.id), 'forbidden');
  assert.equal(refused.details.neededOrgRole, 'operator');
  assert.equal(refused.details.heldOrgRole, 'member');
  const result = await notifier.flushFor(ops.id);
  assert.equal(result.attempted, 0, 'and the operator may run it with no collection membership');
});

// ---------------------------------------------------------------------------
// Stand-in 4 — Canon-wide source registration (sources.ts requireSourceAdmin)

test('stand-in 4: a Canon-wide source takes the operator role; a scoped one still takes collection admin', () => {
  const { store, lead, ops, collection } = setup();
  const canonWide = {
    name: 'HRIS',
    kind: 'static',
    baseUrl: 'static:hris',
    authMode: 'per_asker' as const,
    freshnessWindowMs: 1000,
  };
  expectCode(() => store.createSource(lead.id, canonWide), 'forbidden');
  const source = store.createSource(ops.id, canonWide);
  assert.deepEqual(source.collectionIds, []);

  // A source scoped to a collection is still that collection's admin's act,
  // and an operator who is not a member of it cannot register one there.
  const scoped = { ...canonWide, name: 'Benefits', collectionIds: [collection.id] };
  expectCode(() => store.createSource(ops.id, scoped), 'forbidden');
  assert.ok(store.createSource(lead.id, scoped).id);
});

// ---------------------------------------------------------------------------
// Stand-in 5 — the freshness sweep (freshness.ts requireOperator), found by grep

test('stand-in 5: the freshness sweep takes the operator role', () => {
  const { store, lead, marc, ops } = setup();
  expectCode(() => store.sweepFreshness(marc.id), 'forbidden');
  const refused = expectCode(() => store.sweepFreshness(lead.id), 'forbidden');
  assert.equal(refused.details.neededOrgRole, 'operator');
  assert.equal(store.sweepFreshness(ops.id).flipped, 0, 'the operator sweeps, belonging to no collection');
});

// ---------------------------------------------------------------------------
// What `administrator` is NOT

test('administrator: the role does not carry collection access, in any direction', async () => {
  const { store, lead, admin, collection } = setup();
  const page = store.createPage(lead.id, { collectionId: collection.id, type: 'note', title: 'Salary bands' });
  store.editDraft(lead.id, page.id, { body: 'Band 4 tops out at 92,000.' });
  store.publish(lead.id, page.id);

  // Every read path, refused: the page, the tree, the collection, search,
  // retrieval, and grounded answers. Running the system is not being entitled
  // to the corpus, and that is the separation a regulated buyer asks about.
  // An org administrator holds no role IN this collection, so a read of its
  // pages or of the collection answers as it would for one that never existed:
  // running the system is not entitlement to the corpus, and the refusal must
  // not confirm the corpus is there (existence, never identity).
  expectCode(() => store.getPage(admin.id, page.id), 'not_found');
  expectCode(() => store.tree(admin.id, collection.id), 'forbidden');
  expectCode(() => store.getCollection(admin.id, collection.id), 'not_found');
  assert.deepEqual(store.listCollections(admin.id), []);
  assert.deepEqual(store.searchIndex.search(admin.id, { q: 'salary' }), []);
  const answered = await store.ask(admin.id, { question: 'What does band 4 top out at?' });
  assert.equal(answered.refused, true, 'the record is silent to somebody with no role in it');
  assert.deepEqual(answered.citations, []);
  assert.deepEqual(store.runQuery(admin.id, {}), []);
  assert.deepEqual(store.recordGraph(admin.id).nodes, []);
});

test('administrator: may grant collection membership anywhere — and the grant is the audit event', () => {
  const { store, lead, admin, ops, collection } = setup();

  // The break-glass path, and the reason it is not a hole: an administrator
  // cannot read the collection, but they can grant themselves a role, and that
  // grant is an ordinary audit event with their name on it. Accountable
  // access rather than silent access.
  store.setMember(admin.id, collection.id, admin.id, 'view');
  assert.equal(store.roleOf(admin.id, collection.id), 'view');
  const events = store.queryAudit(lead.id, { action: 'collection.member_set' });
  assert.ok(
    events.some((e) => e.actorId === admin.id && e.details.memberId === admin.id),
    'the collection’s own administrator can see who let themselves in',
  );

  // An operator cannot: administering permissions is the administrator's job,
  // and running the system is not the same job.
  expectCode(() => store.setMember(ops.id, collection.id, ops.id, 'admin'), 'forbidden');
  assert.equal(store.roleOf(ops.id, collection.id), null);
});

test('administrator: a collection that does not exist is not_found, not a silent grant', () => {
  const { store, admin } = setup();
  expectCode(() => store.setMember(admin.id, 'no-such-collection', admin.id, 'view'), 'not_found');
});

// ---------------------------------------------------------------------------
// Granting the role itself

test('org role: only an administrator sets one, and the last one cannot stand down', () => {
  const { store, lead, marc, ops, admin } = setup();
  expectCode(() => store.setOrgRole(marc.id, marc.id, 'administrator'), 'forbidden');
  expectCode(() => store.setOrgRole(lead.id, lead.id, 'operator'), 'forbidden');
  const refused = expectCode(() => store.setOrgRole(ops.id, marc.id, 'operator'), 'forbidden');
  assert.equal(refused.details.neededOrgRole, 'administrator');

  assert.deepEqual(store.setOrgRole(admin.id, marc.id, 'operator'), { actorId: marc.id, orgRole: 'operator' });
  assert.equal(store.isOperator(marc.id), true);
  assert.deepEqual(store.setOrgRole(admin.id, marc.id, 'member'), { actorId: marc.id, orgRole: 'member' });
  assert.equal(store.isOperator(marc.id), false);

  // The last administrator standing down would leave a Canon nobody can ever
  // administer again: refused, with the repair named.
  const last = expectCode(() => store.setOrgRole(admin.id, admin.id, 'member'), 'workflow');
  assert.equal(last.details.reason, 'last_administrator');
  store.setOrgRole(admin.id, marc.id, 'administrator');
  assert.deepEqual(store.setOrgRole(admin.id, admin.id, 'member'), { actorId: admin.id, orgRole: 'member' });

  // And the whole grant is on the record.
  assert.ok(store.queryAudit(marc.id, { action: 'org_role.set' }).length > 0);
});

test('org role: listing who holds one is an operator’s question', () => {
  const { store, marc, ops, admin } = setup();
  expectCode(() => store.listOrgRoles(marc.id), 'forbidden');
  const held = store.listOrgRoles(ops.id);
  assert.deepEqual(
    held.map((h) => h.orgRole).sort(),
    ['administrator', 'operator'],
  );
  assert.ok(held.every((h) => h.mapped === null), 'these were granted by hand, not by a directory group');
  assert.ok(held.some((h) => h.actorId === admin.id && h.hand === 'administrator'));
});

// ---------------------------------------------------------------------------
// Bootstrap

test('bootstrap: the first administrator can be made once, and only once', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const first = store.createActor({ kind: 'person', name: 'First' });
  const second = store.createActor({ kind: 'person', name: 'Second' });

  assert.equal(store.bootstrapAdministrator(first.id), 'administrator');
  assert.equal(store.orgRoleOf(first.id), 'administrator');
  // The window is one person wide and it closes for good.
  const refused = expectCode(() => store.bootstrapAdministrator(second.id), 'forbidden');
  assert.equal(refused.details.reason, 'already_bootstrapped');
  assert.equal(store.orgRoleOf(second.id), 'member');
  assert.ok(store.queryAudit(first.id, { action: 'org_role.bootstrap' }).length > 0, 'and it is on the record');
});

test('bootstrap: a configured subject becomes administrator on sign-in, and nobody else does', async () => {
  const r = await authRig({
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' },
    ],
    bootstrapSubjects: ['iris'],
  });
  try {
    // Dana signs in first. Under first-user-wins she would be the
    // administrator; with a subject configured, arriving first buys nothing.
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.orgRoleOf(dana.id), 'member');

    await r.signIn('iris');
    const iris = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;
    assert.equal(r.store.orgRoleOf(iris.id), 'administrator');

    // Re-asserted on every sign-in, so the named person cannot be locked out.
    r.store.setOrgRole(iris.id, iris.id, 'administrator'); // no-op, and legal
    await r.signIn('iris');
    assert.equal(r.store.orgRoleOf(iris.id), 'administrator');
  } finally {
    r.close();
  }
});

test('bootstrap: with no subject configured, the first person to sign in becomes administrator — once', async () => {
  const r = await authRig({
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' },
    ],
  });
  try {
    await r.signIn('dana');
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal(r.store.orgRoleOf(dana.id), 'administrator');

    await r.signIn('iris');
    const iris = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;
    assert.equal(r.store.orgRoleOf(iris.id), 'member', 'the window closed at the first sign-in');

    const events = r.store.queryAudit(dana.id, { action: 'org_role.bootstrap' });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.details.reason, 'first_person');
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The operator's surfaces over HTTP

test('HTTP: the org-role surfaces answer an operator and refuse everybody else', async () => {
  const r = await authRig({
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' },
    ],
    bootstrapSubjects: ['dana'],
  });
  try {
    const dana = (await r.signIn('dana')).jar;
    const iris = (await r.signIn('iris')).jar;
    const irisActor = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;

    const mine = await r.call('GET', '/auth/session', { jar: dana });
    assert.equal(mine.json.orgRole, 'administrator');
    assert.equal((await r.call('GET', '/auth/session', { jar: iris })).json.orgRole, 'member');

    // A member is refused every operator surface.
    assert.equal((await r.call('GET', '/auth/org-roles', { jar: iris })).status, 403);
    assert.equal((await r.write('PUT', `/auth/org-roles/${irisActor.id}`, iris, { role: 'operator' })).status, 403);

    // The administrator grants, and the grant takes effect immediately.
    const granted = await r.write('PUT', `/auth/org-roles/${irisActor.id}`, dana, { role: 'operator' });
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    assert.equal(granted.json.orgRole, 'operator');
    assert.equal((await r.call('GET', '/auth/org-roles', { jar: iris })).status, 200);

    // A role Canon does not have is a 400 rather than a shrug.
    const nonsense = await r.write('PUT', `/auth/org-roles/${irisActor.id}`, dana, { role: 'superuser' });
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.json.reason, 'unknown_org_role');

    // And an anonymous caller gets nothing at all.
    assert.equal((await r.call('GET', '/auth/org-roles')).status, 401);
  } finally {
    r.close();
  }
});

test('HTTP: your own access is yours to read; anybody else’s is an operator’s question', async () => {
  const r = await authRig({
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' },
    ],
    bootstrapSubjects: ['dana'],
  });
  try {
    const dana = (await r.signIn('dana')).jar;
    const iris = (await r.signIn('iris')).jar;
    const danaActor = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    const irisActor = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;

    const own = await r.call('GET', `/auth/access/${irisActor.id}`, { jar: iris });
    assert.equal(own.status, 200);
    assert.equal(own.json.orgRole, 'member');
    assert.deepEqual(own.json.collections, []);

    assert.equal((await r.call('GET', `/auth/access/${danaActor.id}`, { jar: iris })).status, 403);
    const asOperator = await r.call('GET', `/auth/access/${irisActor.id}`, { jar: dana });
    assert.equal(asOperator.status, 200);
    assert.equal(asOperator.json.actorId, irisActor.id);
  } finally {
    r.close();
  }
});
