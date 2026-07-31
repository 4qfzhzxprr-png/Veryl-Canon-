import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { store, dana, marc, iris, collection };
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

test('permissions: a non-member cannot see or write to a collection', () => {
  const { store, collection } = setup();
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.getCollection(outsider.id, collection.id), 'forbidden');
  expectCode(
    () => store.createPage(outsider.id, { collectionId: collection.id, type: 'note', title: 'Sneak' }),
    'forbidden',
  );
  assert.equal(store.listCollections(outsider.id).length, 0);
});

test('agents require a Registry reference; Canon stores no credentials of its own', () => {
  const { store } = setup();
  expectCode(() => store.createActor({ kind: 'agent', name: 'Helper' }), 'invalid');
  const agent = store.createActor({ kind: 'agent', name: 'Helper', registryRef: 'passport:helper-1' });
  assert.equal(agent.registryRef, 'passport:helper-1');
});

test('publishing: drafts become immutable versions and the pointer moves', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Meeting notes' });
  assert.equal(page.currentVersion, null);

  store.editDraft(marc.id, page.id, { body: 'First cut' });
  const v1 = store.publish(marc.id, page.id, { note: 'initial' });
  assert.equal(v1.currentVersion, 1);
  assert.equal(store.getDraft(marc.id, page.id), null);

  store.editDraft(marc.id, page.id, { body: 'Second cut' });
  const v2 = store.publish(marc.id, page.id);
  assert.equal(v2.currentVersion, 2);

  const versions = store.listVersions(marc.id, page.id);
  assert.deepEqual(versions.map((v) => [v.number, v.body]), [[1, 'First cut'], [2, 'Second cut']]);
});

test('history is append-only, enforced at the storage layer', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const c = store.createCollection(dana.id, { name: 'X' });
  const page = store.createPage(dana.id, { collectionId: c.id, type: 'note', title: 'N' });
  store.editDraft(dana.id, page.id, { body: 'v1' });
  store.publish(dana.id, page.id);

  assert.throws(() => db.exec(`UPDATE page_versions SET body = 'tampered'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM page_versions'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_events'), /append-only/);
});

test('page lock: one editor at a time, with a visible "being edited by"', () => {
  const { store, dana, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Shared' });
  store.editDraft(marc.id, page.id, { body: 'Marc typing' });

  const err = expectCode(() => store.editDraft(dana.id, page.id, { body: 'Dana typing' }), 'locked');
  assert.match((err as CanonError).message, /being edited by Marc/);
  expectCode(() => store.publish(dana.id, page.id), 'locked');
  expectCode(() => store.discardDraft(dana.id, page.id), 'locked');

  store.discardDraft(marc.id, page.id);
  store.editDraft(dana.id, page.id, { body: 'Dana typing' });
  assert.equal(store.getDraft(dana.id, page.id)!.editorId, dana.id);
});

test('type rules: a policy cannot publish without owner and approver', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, page.id, { body: 'Keep records 7 years.' });
  expectCode(() => store.publish(marc.id, page.id), 'workflow');

  store.editDraft(marc.id, page.id, {
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: '2026-09-01', reviewDate: '2099-01-01' },
  });
  const published = store.publish(marc.id, page.id);
  assert.equal(published.currentVersion, 1);
  assert.equal(published.ownerId, marc.id);
  assert.equal(published.effectiveDate, '2026-09-01');
});

test('type rules: effective date is Policy-only', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '2026-09-01' } }), 'invalid');
});

test('review workflow: draft -> in review -> canonical, by the named approver only', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01' },
  });

  const submitted = store.submitForReview(marc.id, page.id);
  assert.equal(submitted.status, 'in_review');
  expectCode(() => store.editDraft(marc.id, page.id, { body: 'sneaky edit' }), 'workflow');
  expectCode(() => store.publish(marc.id, page.id), 'workflow');
  expectCode(() => store.approve(marc.id, page.id), 'forbidden'); // marc holds edit, not approve

  const canonical = store.approve(iris.id, page.id);
  assert.equal(canonical.status, 'canonical');
  assert.equal(canonical.currentVersion, 1);

  // Editing after Canonical drops the mark on the next publish: the mark
  // applies to reviewed content, not whatever came after.
  store.editDraft(marc.id, page.id, { body: 'Amended.' });
  const republished = store.publish(marc.id, page.id);
  assert.equal(republished.status, 'draft');
  assert.equal(republished.currentVersion, 2);
});

test('review workflow: the approver can send a draft back with a comment', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q4 plan' });
  store.editDraft(marc.id, page.id, { body: 'Ship it all.', fields: { ownerId: marc.id } });
  store.submitForReview(marc.id, page.id);

  expectCode(() => store.sendBack(iris.id, page.id, { comment: '' }), 'invalid');
  const back = store.sendBack(iris.id, page.id, { comment: 'Too vague; name the milestones.' });
  assert.equal(back.status, 'draft');

  const events = store.queryAudit(iris.id, { action: 'page.send_back' });
  assert.equal(events[0]!.details.comment, 'Too vague; name the milestones.');
});

test('notes publish directly and never carry the Canonical mark', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(marc.id, page.id, { body: 'rough thoughts' });
  expectCode(() => store.submitForReview(marc.id, page.id), 'workflow');
  const published = store.publish(marc.id, page.id);
  assert.equal(published.status, 'draft');
});

test('trees: a branch moves with its children, ids stay stable, cycles are rejected', () => {
  const { store, marc, collection } = setup();
  const plan = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Plan' });
  const spec = store.createPage(marc.id, { collectionId: collection.id, parentId: plan.id, type: 'spec', title: 'Spec' });
  const sub = store.createPage(marc.id, { collectionId: collection.id, parentId: spec.id, type: 'note', title: 'Sub' });
  const other = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Other' });

  expectCode(() => store.movePage(marc.id, plan.id, { parentId: sub.id }), 'invalid'); // cycle

  store.movePage(marc.id, spec.id, { parentId: other.id });
  const tree = store.tree(marc.id, collection.id);
  const otherNode = tree.find((n) => n.id === other.id)!;
  assert.equal(otherNode.children[0]!.id, spec.id);
  assert.equal(otherNode.children[0]!.children[0]!.id, sub.id); // child followed the branch
  assert.equal(store.getPage(marc.id, spec.id).id, spec.id); // stable identity
});

test('audit: restricted-collection views and all writes are on the record, filterable', () => {
  const { store, dana, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Sensitive' });
  store.getPage(dana.id, page.id, { logView: true });

  const views = store.queryAudit(dana.id, { action: 'page.view', actorId: dana.id });
  assert.equal(views.length, 1);
  assert.equal(views[0]!.pageId, page.id);

  const creates = store.queryAudit(dana.id, { action: 'page.create' });
  assert.equal(creates[0]!.actorId, marc.id);

  // An unrestricted collection logs writes but not reads.
  const open = store.createCollection(dana.id, { name: 'Open' });
  const openPage = store.createPage(dana.id, { collectionId: open.id, type: 'note', title: 'Public-ish' });
  store.getPage(dana.id, openPage.id, { logView: true });
  const openViews = store
    .queryAudit(dana.id, { action: 'page.view' })
    .filter((e) => e.pageId === openPage.id);
  assert.equal(openViews.length, 0);
});

test('agent contributions are attributed and marked as agent work in the audit log', () => {
  const { store, dana, collection } = setup();
  const agent = store.createActor({ kind: 'agent', name: 'Freshness Agent', registryRef: 'passport:fresh-1' });
  store.setMember(dana.id, collection.id, agent.id, 'edit');

  const page = store.createPage(agent.id, { collectionId: collection.id, type: 'note', title: 'Stale figures' });
  store.editDraft(agent.id, page.id, { body: 'The Q2 number changed upstream.' });
  store.publish(agent.id, page.id);

  const version = store.getVersion(dana.id, page.id, 1);
  assert.equal(version.authorId, agent.id);
  const events = store.queryAudit(dana.id, { actorId: agent.id, action: 'page.publish' });
  assert.equal(events[0]!.actorKind, 'agent');
});

test('restore creates a new version; history is never rewritten', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  store.editDraft(marc.id, page.id, { body: 'good' });
  store.publish(marc.id, page.id);
  store.editDraft(marc.id, page.id, { body: 'worse' });
  store.publish(marc.id, page.id);

  const restored = store.restore(marc.id, page.id, 1);
  assert.equal(restored.currentVersion, 3);
  assert.equal(store.getVersion(marc.id, page.id, 3).body, 'good');
  assert.equal(store.getVersion(marc.id, page.id, 2).body, 'worse'); // still there
});
