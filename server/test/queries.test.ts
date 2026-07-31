import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

// Structured queries (FEATURES.md §6) and record health (§8). The target is
// the example FEATURES.md itself gives — "all Canonical policies owned by
// Compliance with a review date in the next 60 days" — and the invariant that
// matters most is that permission filtering happens in the SELECT: a non-member
// sees nothing because nothing was ever selected for them.

const quiet: NotificationTransport = { deliver() {} };

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' }); // admin
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' }); // edit
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' }); // approve
  const compliance = store.createActor({ kind: 'person', name: 'Compliance team', email: 'compliance@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  store.setMember(dana.id, collection.id, compliance.id, 'view');
  return { db, store, dana, marc, iris, compliance, collection };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

function canonicalPolicy(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  opts: { ownerId: string; reviewDate: string; body?: string; type?: 'policy' | 'spec' | 'plan' },
) {
  const page = store.createPage(editorId, { collectionId, type: opts.type ?? 'policy', title });
  store.editDraft(editorId, page.id, {
    body: opts.body ?? `${title} body.`,
    fields: { ownerId: opts.ownerId, approverId, reviewDate: opts.reviewDate },
  });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

// A date `days` from a fixed "now", so the 60-day example is exact rather than
// dependent on when the suite happens to run.
function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test('queries: the FEATURES.md example — Canonical policies owned by Compliance, review date in the next 60 days', () => {
  const { store, marc, iris, compliance, collection } = setup();

  const due = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(30),
  });
  // Owned by Compliance, but the review is a year out.
  canonicalPolicy(store, marc.id, iris.id, collection.id, 'Access policy', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(365),
  });
  // Due inside the window, but owned by someone else.
  canonicalPolicy(store, marc.id, iris.id, collection.id, 'Vendor policy', {
    ownerId: marc.id,
    reviewDate: daysFromToday(20),
  });
  // Due inside the window and owned by Compliance, but a Spec, not a Policy.
  canonicalPolicy(store, marc.id, iris.id, collection.id, 'Vault spec', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(10),
    type: 'spec',
  });
  // Due inside the window and owned by Compliance, but never approved.
  const draft = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Draft policy' });
  store.editDraft(marc.id, draft.id, {
    body: 'Not yet.',
    fields: { ownerId: compliance.id, approverId: iris.id, reviewDate: daysFromToday(5) },
  });
  store.publish(marc.id, draft.id);

  const results = store.runQuery(marc.id, {
    collectionIds: [collection.id],
    types: ['policy'],
    statuses: ['canonical'],
    ownerIds: [compliance.id],
    reviewDateAfter: daysFromToday(0),
    reviewDateBefore: daysFromToday(60),
    sort: 'reviewDate',
    direction: 'asc',
  });
  assert.deepEqual(results.map((r) => r.pageId), [due.id]);
  assert.equal(results[0]!.title, 'Retention policy');
  assert.equal(results[0]!.ownerId, compliance.id);
  assert.equal(results[0]!.status, 'canonical');
  assert.equal(results[0]!.pastReview, false);
});

test('queries: permission filtering is in the SELECT — a non-member sees nothing', () => {
  const { store, dana, marc, iris, compliance, collection } = setup();
  canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(30),
  });

  // A second collection the first collection's members cannot see.
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const secret = store.createCollection(outsider.id, { name: 'Board' });
  const secretPage = store.createPage(outsider.id, { collectionId: secret.id, type: 'note', title: 'Board minutes' });
  store.editDraft(outsider.id, secretPage.id, { body: 'Confidential.' });
  store.publish(outsider.id, secretPage.id);

  // The outsider's own query returns their own page and nothing of ours.
  assert.deepEqual(store.runQuery(outsider.id, {}).map((r) => r.pageId), [secretPage.id]);
  // Naming our collection explicitly changes nothing: the membership join, not
  // the filter, is what decides.
  assert.deepEqual(store.runQuery(outsider.id, { collectionIds: [collection.id] }), []);
  // And a member of ours never sees the board minutes, however wide the query.
  assert.ok(!store.runQuery(dana.id, {}).some((r) => r.pageId === secretPage.id));
  assert.deepEqual(store.runQuery(dana.id, { collectionIds: [secret.id] }), []);

  // Someone in no collection at all sees nothing, and is still a known actor.
  const nobody = store.createActor({ kind: 'person', name: 'Nobody' });
  assert.deepEqual(store.runQuery(nobody.id, {}), []);
  expectCode(() => store.runQuery('no-such-actor', {}), 'not_found');
});

test('queries: the filter vocabulary is fixed, and a typo is refused rather than silently empty', () => {
  const { store, marc, iris, compliance, collection } = setup();
  const canonical = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(30),
  });
  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(marc.id, note.id, { body: 'Rough.' });
  store.publish(marc.id, note.id);
  store.archivePage(marc.id, note.id);

  expectCode(() => store.runQuery(marc.id, { types: ['policyy'] as never }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { statuses: ['cannonical'] as never }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { sort: 'whatever' as never }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { direction: 'sideways' as never }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { reviewDateBefore: 'soon' }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { hasOwner: 'yes' as never }), 'invalid');
  expectCode(() => store.runQuery(marc.id, { limit: 0 }), 'invalid');

  // Archived pages leave the record's ordinary view; asking for them by name is
  // how you get them back.
  assert.deepEqual(store.runQuery(marc.id, {}).map((r) => r.pageId), [canonical.id]);
  assert.deepEqual(store.runQuery(marc.id, { statuses: ['archived'] }).map((r) => r.pageId), [note.id]);

  // hasOwner / hasReviewDate are the health questions, asked directly.
  const unowned = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'Ownerless spec' });
  assert.deepEqual(store.runQuery(marc.id, { hasOwner: false }).map((r) => r.pageId), [unowned.id]);
  assert.deepEqual(store.runQuery(marc.id, { hasReviewDate: true }).map((r) => r.pageId), [canonical.id]);
});

test('queries: sorting, limits, and the past-review flag', () => {
  const { store, dana, marc, iris, compliance, collection } = setup();
  const soon = canonicalPolicy(store, marc.id, iris.id, collection.id, 'A policy', {
    ownerId: compliance.id,
    reviewDate: '2026-02-01',
  });
  const later = canonicalPolicy(store, marc.id, iris.id, collection.id, 'B policy', {
    ownerId: compliance.id,
    reviewDate: '2099-02-01',
  });

  const byReview = store.runQuery(marc.id, { sort: 'reviewDate', direction: 'asc' });
  assert.deepEqual(byReview.map((r) => r.pageId), [soon.id, later.id]);
  assert.deepEqual(
    store.runQuery(marc.id, { sort: 'reviewDate', direction: 'desc' }).map((r) => r.pageId),
    [later.id, soon.id],
  );
  assert.deepEqual(store.runQuery(marc.id, { sort: 'title', direction: 'asc', limit: 1 }).map((r) => r.title), ['A policy']);

  // pastReview is derived from the review date, so it is true before the sweep
  // has run — the flag is the record's arithmetic, the status is its decision.
  assert.equal(byReview[0]!.pastReview, true);
  assert.equal(byReview[0]!.status, 'canonical');
  store.sweepFreshness(dana.id);
  const afterSweep = store.runQuery(marc.id, { statuses: ['needs_update'] });
  assert.deepEqual(afterSweep.map((r) => r.pageId), [soon.id]);
  assert.equal(afterSweep[0]!.pastReview, true);
});

test('saved queries: owned by their creator, scoped to collections they can see', () => {
  const { store, marc, iris, compliance, collection } = setup();
  const due = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
    ownerId: compliance.id,
    reviewDate: daysFromToday(30),
  });

  const saved = store.saveQuery(marc.id, {
    name: 'Compliance policies due in 60 days',
    query: {
      collectionIds: [collection.id],
      types: ['policy'],
      statuses: ['canonical'],
      ownerIds: [compliance.id],
      reviewDateBefore: daysFromToday(60),
      sort: 'reviewDate',
      direction: 'asc',
    },
  });
  assert.equal(saved.createdBy, marc.id);
  assert.equal(saved.query.types?.[0], 'policy');
  assert.deepEqual(store.runSavedQuery(marc.id, saved.id).map((r) => r.pageId), [due.id]);

  // Listing shows only your own.
  assert.deepEqual(store.listQueries(marc.id).map((q) => q.id), [saved.id]);
  assert.deepEqual(store.listQueries(iris.id), []);

  // Reading or deleting someone else's is refused, and an unknown one is not_found.
  expectCode(() => store.getQuery(iris.id, saved.id), 'forbidden');
  expectCode(() => store.deleteQuery(iris.id, saved.id), 'forbidden');
  expectCode(() => store.runSavedQuery(iris.id, saved.id), 'forbidden');
  expectCode(() => store.getQuery(marc.id, 'no-such-query'), 'not_found');

  // A query naming a collection its author cannot see is refused when saved,
  // not quietly emptied when run.
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const secret = store.createCollection(outsider.id, { name: 'Board' });
  expectCode(() => store.saveQuery(marc.id, { name: 'Peek', query: { collectionIds: [secret.id] } }), 'forbidden');
  expectCode(() => store.saveQuery(marc.id, { name: '  ' }), 'invalid');
  expectCode(() => store.saveQuery(marc.id, { name: 'Bad', query: { types: ['nope'] as never } }), 'invalid');

  // Saving and deleting are on the audit record like every other write.
  const saves = store.queryAudit(marc.id, { action: 'query.save' });
  assert.equal(saves.length, 1);
  assert.equal(saves[0]!.details.queryId, saved.id);
  store.deleteQuery(marc.id, saved.id);
  assert.deepEqual(store.listQueries(marc.id), []);
  assert.equal(store.queryAudit(marc.id, { action: 'query.delete' }).length, 1);
});

test('record health: counts past review, unowned, orphaned, and stale drafts', () => {
  const { db, store, dana, marc, iris, compliance, collection } = setup();

  // The collection home: the first root page.
  const home = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Compliance home' });
  store.editDraft(marc.id, home.id, { body: 'Welcome.' });
  store.publish(marc.id, home.id);

  // Past review, and swept.
  const stale = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
    ownerId: compliance.id,
    reviewDate: '2026-01-01',
  });
  store.movePage(marc.id, stale.id, { parentId: home.id });
  // Current, and in the tree.
  const current = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Access policy', {
    ownerId: compliance.id,
    reviewDate: '2099-01-01',
  });
  store.movePage(marc.id, current.id, { parentId: home.id });
  // An orphan: parentless, and not the home.
  const orphan = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'Loose spec' });
  // An old draft, and a fresh one. A Note needs no owner, so it is not counted
  // as unowned — TYPE_RULES decides that, not the health summary.
  const oldDraft = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Forgotten plan' });
  store.movePage(marc.id, oldDraft.id, { parentId: home.id });
  db.prepare('UPDATE pages SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', oldDraft.id);
  const freshNote = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.movePage(marc.id, freshNote.id, { parentId: home.id });

  store.sweepFreshness(dana.id, { on: '2026-06-01' });

  const health = store.collectionHealth(marc.id, collection.id, { on: '2026-06-01' });
  assert.equal(health.collectionId, collection.id);
  assert.equal(health.pastReview, 1); // the retention policy
  assert.equal(health.needsUpdate, 1); // and the sweep moved it
  assert.equal(health.withoutOwner, 2); // the loose spec and the forgotten plan; the Note owes nothing
  assert.equal(health.orphaned, 1); // the loose spec; the home is not an orphan
  assert.equal(health.staleDrafts, 1); // the forgotten plan, untouched since 2020
  assert.equal(health.staleDraftDays, 30);
  assert.equal(health.truncated, false);
  assert.equal(health.pages, 6);

  // The window is the caller's to choose.
  assert.equal(store.collectionHealth(marc.id, collection.id, { on: '2026-06-01', staleDraftDays: 3650 }).staleDrafts, 0);

  // Health is a read of the collection: view is enough, and a non-member is refused.
  assert.equal(store.collectionHealth(compliance.id, collection.id, { on: '2026-06-01' }).pastReview, 1);
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.collectionHealth(outsider.id, collection.id), 'forbidden');
  void orphan;
});

test('agents: queries and health are read and narrowed; the freshness sweep is closed to them', async () => {
  const registry = new RegistryStore();
  const registryServer = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;

  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: 0, requestTimeoutMs: 500 }),
  });
  const canon = createApi(store, auth);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, passport: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-passport': passport },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
    const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
    const permitted = store.createCollection(dana.id, { name: 'Compliance' });
    const withheld = store.createCollection(dana.id, { name: 'Board' });
    store.setMember(dana.id, permitted.id, iris.id, 'approve');
    store.setMember(dana.id, withheld.id, iris.id, 'approve');
    const open = canonicalPolicy(store, dana.id, iris.id, permitted.id, 'Retention policy', {
      ownerId: dana.id,
      reviewDate: daysFromToday(30),
    });
    canonicalPolicy(store, dana.id, iris.id, withheld.id, 'Board policy', {
      ownerId: dana.id,
      reviewDate: daysFromToday(30),
    });

    // A read-only agent, permitted in one collection of the two.
    const bot = registry.register({
      name: 'PolicyBot',
      permittedCollections: [permitted.id],
      permittedActions: ['read'],
    });
    registry.certify(bot.agentId);
    // Canon's own half of the intersection: the agent needs a role here too.
    const first = await call('GET', '/collections', bot.passport);
    assert.equal(first.status, 200);
    const agentActor = store.listActors().find((a) => a.kind === 'agent')!;
    store.setMember(dana.id, permitted.id, agentActor.id, 'view');
    store.setMember(dana.id, withheld.id, agentActor.id, 'view'); // Canon allows; the Registry does not

    // Running a query is `read`, and the result is narrowed to the collections
    // the Registry permits — Canon's membership alone would have shown both.
    const ran = await call('POST', '/queries/run', bot.passport, { types: ['policy'] });
    assert.equal(ran.status, 200);
    assert.deepEqual(ran.json.map((r: any) => r.pageId), [open.id]);

    // Health is `read` on the named collection: permitted here, refused there.
    assert.equal((await call('GET', `/collections/${permitted.id}/health`, bot.passport)).status, 200);
    const refusedHealth = await call('GET', `/collections/${withheld.id}/health`, bot.passport);
    assert.equal(refusedHealth.status, 403);
    assert.equal(refusedHealth.json.reason, 'collection_not_permitted');

    // Saving and listing a query is the agent's own object: `read`, no collection.
    const saved = await call('POST', '/queries', bot.passport, { name: 'Mine', query: { types: ['policy'] } });
    assert.equal(saved.status, 200);
    assert.deepEqual((await call('GET', '/queries', bot.passport)).json.map((q: any) => q.id), [saved.json.id]);

    // The freshness sweep is not in the agent route table at all, so it is
    // refused to every agent however wide the passport — the decision, tested.
    const wide = registry.register({
      name: 'MaintenanceBot',
      permittedCollections: ['*'],
      permittedActions: ['read', 'comment', 'write'],
    });
    registry.certify(wide.agentId);
    const sweep = await call('POST', '/maintenance/freshness', wide.passport, {});
    assert.equal(sweep.status, 403);
    assert.equal(sweep.json.reason, 'route_not_available_to_agents');
    const denials = store.queryAudit(dana.id, { action: 'agent.denied' });
    assert.ok(denials.some((e) => e.details.reason === 'route'));
  } finally {
    canon.close();
    registryServer.close();
  }
});

test('queries and health over HTTP', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor-id': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
    const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
    const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
    const compliance = store.createActor({ kind: 'person', name: 'Compliance team' });
    const collection = store.createCollection(dana.id, { name: 'Compliance' });
    store.setMember(dana.id, collection.id, marc.id, 'edit');
    store.setMember(dana.id, collection.id, iris.id, 'approve');
    const due = canonicalPolicy(store, marc.id, iris.id, collection.id, 'Retention policy', {
      ownerId: compliance.id,
      reviewDate: daysFromToday(30),
    });

    assert.equal((await call('POST', '/queries/run')).status, 401);

    const ran = await call('POST', '/queries/run', marc.id, {
      collectionIds: [collection.id],
      types: ['policy'],
      statuses: ['canonical'],
      ownerIds: [compliance.id],
      reviewDateBefore: daysFromToday(60),
    });
    assert.equal(ran.status, 200);
    assert.deepEqual(ran.json.map((r: any) => r.pageId), [due.id]);

    const bad = await call('POST', '/queries/run', marc.id, { types: ['nope'] });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid');

    const saved = await call('POST', '/queries', marc.id, {
      name: 'Due in 60 days',
      query: { collectionIds: [collection.id], reviewDateBefore: daysFromToday(60) },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await call('GET', '/queries', marc.id)).json.map((q: any) => q.id), [saved.json.id]);
    // GET /queries/:id returns the DEFINITION; results come from /queries/run.
    const fetched = await call('GET', `/queries/${saved.json.id}`, marc.id);
    assert.equal(fetched.json.name, 'Due in 60 days');
    assert.equal(fetched.json.results, undefined);
    const viaSaved = await call('POST', '/queries/run', marc.id, { savedQueryId: saved.json.id });
    assert.deepEqual(viaSaved.json.map((r: any) => r.pageId), [due.id]);
    assert.equal((await call('GET', `/queries/${saved.json.id}`, iris.id)).status, 403);

    const health = await call('GET', `/collections/${collection.id}/health`, marc.id);
    assert.equal(health.status, 200);
    assert.equal(health.json.pastReview, 0);
    assert.equal(health.json.needsUpdate, 0);
    assert.equal(health.json.withoutOwner, 0);

    const deleted = await call('DELETE', `/queries/${saved.json.id}`, marc.id);
    assert.deepEqual(deleted.json, { ok: true });
    assert.deepEqual((await call('GET', '/queries', marc.id)).json, []);
  } finally {
    server.close();
  }
});
