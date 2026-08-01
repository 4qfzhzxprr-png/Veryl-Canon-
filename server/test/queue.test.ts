import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { staticConnectorOf } from '../src/connectors.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { setHandOrgRole } from '../src/orgrole.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

// The queue (USER-TESTING.md T2.1). Two people hit this and for both it was the
// biggest thing wrong with the product: a Director of Compliance who found his
// 25 pending approvals by opening 44 pages one at a time, and a contributor who
// learned by accident that a conflict had been asserted against a policy she
// owns.
//
// The test that would have failed on the day the finding was written is the
// first one below, and it is written twice over: the page in review naming me
// as approver is in MY queue and in NOBODY else's, and a page I may not see is
// in nobody's at all. The second half is the one that matters most — a queue is
// a spanning read over every collection at once, so it is the surface where a
// permission mistake would be least visible and most expensive.

const quiet: NotificationTransport = { deliver() {} };

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  // Dana administers Compliance and runs this Canon; Marcus approves in it;
  // Priya writes in it; Iris is a second approver, so "waiting on Marcus" has
  // somebody to be distinguished from.
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marcus = store.createActor({ kind: 'person', name: 'Marcus', email: 'marcus@example.com' });
  const priya = store.createActor({ kind: 'person', name: 'Priya', email: 'priya@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marcus.id, 'approve');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  store.setMember(dana.id, collection.id, priya.id, 'edit');
  setHandOrgRole(db, dana.id, 'operator', null);
  return { db, store, dana, marcus, priya, iris, collection };
}

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A Policy submitted for review, waiting on `approverId`. */
function policyInReview(
  store: CanonStore,
  editorId: string,
  collectionId: string,
  title: string,
  opts: { ownerId: string; approverId: string; reviewDate?: string },
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body: `${title} body.`,
    fields: {
      ownerId: opts.ownerId,
      approverId: opts.approverId,
      reviewDate: opts.reviewDate ?? daysFromToday(365),
      effectiveDate: daysFromToday(0),
    },
  });
  store.submitForReview(editorId, page.id);
  return page;
}

// ---- the finding itself -------------------------------------------------

test('the queue: a page in review naming me as approver is in my queue and in nobody else\'s', () => {
  const { store, dana, marcus, priya, iris, collection } = setup();

  const mine = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
  });
  const hers = policyInReview(store, priya.id, collection.id, 'Access policy', {
    ownerId: priya.id,
    approverId: iris.id,
  });

  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval.map((p) => p.pageId), [mine.id]);
  assert.deepEqual(store.myQueue(iris.id).awaitingMyApproval.map((p) => p.pageId), [hers.id]);
  // Dana administers the collection, which is not the same as being asked.
  assert.deepEqual(store.myQueue(dana.id).awaitingMyApproval, []);
  // Priya wrote both and can approve neither.
  assert.deepEqual(store.myQueue(priya.id).awaitingMyApproval, []);

  // The count is most of the value: Marcus's complaint was not that the page
  // was missing, it was that nothing told him how much was waiting.
  assert.equal(store.myQueue(marcus.id).counts.awaitingMyApproval, 1);
  assert.equal(store.myQueue(marcus.id).counts.total, 1);

  // And the queue is what the server will actually accept: approving is
  // refused for the page that is not in your queue, and works for the one
  // that is.
  expectCode(() => store.approve(iris.id, mine.id), 'forbidden');
  store.approve(marcus.id, mine.id);
  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval, []);
});

test('the queue: a page I cannot see is in nobody\'s queue, however it is asked for', () => {
  const { store, marcus, collection, dana } = setup();

  // A second Canon-within-a-Canon: a collection Marcus is not a member of, in
  // which he is nonetheless named as the approver of a page in review. The
  // draft names him, the outbox would have told him, and he still may not read
  // the page — so the queue does not offer it to him.
  const chair = store.createActor({ kind: 'person', name: 'Chair', email: 'chair@example.com' });
  const board = store.createCollection(chair.id, { name: 'Board' });
  const writer = store.createActor({ kind: 'person', name: 'Writer', email: 'writer@example.com' });
  store.setMember(chair.id, board.id, writer.id, 'edit');
  store.setMember(chair.id, board.id, marcus.id, 'approve');
  const boardPage = policyInReview(store, writer.id, board.id, 'Board minutes policy', {
    ownerId: writer.id,
    approverId: marcus.id,
  });
  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval.map((p) => p.pageId), [boardPage.id]);

  // Membership is withdrawn. Nothing about the page changes — the draft still
  // names him — and it leaves his queue, because the queue is the membership
  // join and not a list of names.
  store.removeMember(chair.id, board.id, marcus.id);
  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval, []);
  assert.equal(store.myQueue(marcus.id).counts.total, 0);
  // Nor is it in the queue of anybody else in Compliance.
  assert.deepEqual(store.myQueue(dana.id).awaitingMyApproval, []);
  // The page is still there, and still waiting on somebody who can see it.
  assert.deepEqual(store.myQueue(chair.id).awaitingMyApproval, []); // named approver is Marcus
  expectCode(() => store.getPage(marcus.id, boardPage.id), 'forbidden');
});

// ---- the other strands --------------------------------------------------

test('the queue: my stale pages, whether or not a sweep has run', () => {
  const { store, dana, marcus, priya, collection } = setup();

  const stale = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
    reviewDate: daysFromToday(-3),
  });
  store.approve(marcus.id, stale.id);
  const fresh = policyInReview(store, priya.id, collection.id, 'Access policy', {
    ownerId: priya.id,
    approverId: marcus.id,
    reviewDate: daysFromToday(300),
  });
  store.approve(marcus.id, fresh.id);
  const somebodyElses = policyInReview(store, priya.id, collection.id, 'Vendor policy', {
    ownerId: dana.id,
    approverId: marcus.id,
    reviewDate: daysFromToday(-3),
  });
  store.approve(marcus.id, somebodyElses.id);

  // Before any sweep: still Canonical, and already past its date. A deployment
  // with no freshness timer has only this kind, and its owners are exactly as
  // behind — so the queue counts it.
  const before = store.myQueue(priya.id);
  assert.deepEqual(before.myPagesPastReview.map((p) => p.pageId), [stale.id]);
  assert.equal(before.myPagesPastReview[0]!.status, 'canonical');
  assert.equal(before.myPagesPastReview[0]!.pastReview, true);

  // After the sweep the status has changed and the page has not moved: one
  // entry, not two, because the two runs behind this strand are merged by id.
  store.sweepFreshness(dana.id);
  const after = store.myQueue(priya.id);
  assert.deepEqual(after.myPagesPastReview.map((p) => p.pageId), [stale.id]);
  assert.equal(after.myPagesPastReview[0]!.status, 'needs_update');
  // Dana's stale page is Dana's.
  assert.deepEqual(store.myQueue(dana.id).myPagesPastReview.map((p) => p.pageId), [somebodyElses.id]);
});

test('the queue: sent back to me, and my drafts in progress, are the same page only once', () => {
  const { store, marcus, priya, collection } = setup();

  const sent = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
  });
  const inProgress = store.createPage(priya.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(priya.id, inProgress.id, { body: 'Half a thought.' });

  // While it is in review it is Marcus's move, not Priya's: her own draft is
  // not in her drafts strand, because she cannot edit it.
  const during = store.myQueue(priya.id);
  assert.deepEqual(during.myDrafts.map((p) => p.pageId), [inProgress.id]);
  assert.deepEqual(during.sentBackToMe, []);
  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval.map((p) => p.pageId), [sent.id]);

  store.sendBack(marcus.id, sent.id, { comment: 'Name the escalation path.' });
  const after = store.myQueue(priya.id);
  assert.deepEqual(after.sentBackToMe.map((p) => p.pageId), [sent.id]);
  // It is a draft of hers as well, and it appears once — in the strand that
  // says what happened to it.
  assert.deepEqual(after.myDrafts.map((p) => p.pageId), [inProgress.id]);
  assert.equal(after.counts.total, 2);
  // Marcus has handed it back, so it has left his queue.
  assert.deepEqual(store.myQueue(marcus.id).awaitingMyApproval, []);
});

test('the queue: a conflict asserted against a page I own finds its owner', async () => {
  const { store, dana, marcus, priya, collection } = setup();

  const hers = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
  });
  store.approve(marcus.id, hers.id);
  const theirs = policyInReview(store, priya.id, collection.id, 'Records policy', {
    ownerId: dana.id,
    approverId: marcus.id,
  });
  store.approve(marcus.id, theirs.id);

  // Dana asserts that the two contradict each other. Nothing about Priya's
  // page changes; the record simply now holds the statement — and before this,
  // nothing told her (T2.1, second half).
  store.assertRelation(dana.id, theirs.id, {
    toPageId: hers.id,
    kind: 'conflicts_with',
    note: 'These give different retention periods for the same class of record.',
  });

  const priyas = store.myQueue(priya.id);
  assert.equal(priyas.conflictsOnMyPages.length, 1);
  assert.equal(priyas.conflictsOnMyPages[0]!.mine.id, hers.id);
  assert.equal(priyas.conflictsOnMyPages[0]!.other.id, theirs.id);
  assert.match(priyas.conflictsOnMyPages[0]!.note!, /different retention periods/);
  // Dana owns the other end, so it is Dana's work too — anchored on her page.
  const danas = store.myQueue(dana.id);
  assert.equal(danas.conflictsOnMyPages.length, 1);
  assert.equal(danas.conflictsOnMyPages[0]!.mine.id, theirs.id);
  // Marcus approved both and owns neither.
  assert.deepEqual(store.myQueue(marcus.id).conflictsOnMyPages, []);

  // Archiving one end retires the contradiction with it.
  store.archivePage(dana.id, theirs.id);
  assert.deepEqual(store.myQueue(priya.id).conflictsOnMyPages, []);
});

test('the queue: an open divergence on a page I own, and only on a page I own', async () => {
  const { store, dana, marcus, priya, collection } = setup();
  const state = { authority: 1500, other: 1500 };
  staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': () => state.authority } });
  staticConnectorOf(store.connectors).define('claims', { deductible: { 'PLAN-7': () => state.other } });
  const authority = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 0,
    collectionIds: [collection.id],
  });
  const corroborating = store.createSource(dana.id, {
    name: 'Claims',
    kind: 'static',
    baseUrl: 'static:claims',
    authMode: 'service',
    freshnessWindowMs: 0,
    collectionIds: [collection.id],
  });

  const page = store.createPage(priya.id, { collectionId: collection.id, type: 'note', title: 'Benefits summary' });
  store.editDraft(priya.id, page.id, { body: 'The deductible is below.', fields: { ownerId: priya.id } });
  store.publish(priya.id, page.id);
  store.addReference(priya.id, page.id, { sourceId: authority.id, selector: 'deductible', key: 'PLAN-7' });
  store.addReference(priya.id, page.id, {
    sourceId: corroborating.id,
    selector: 'deductible',
    key: 'PLAN-7',
    role: 'corroborating',
  });

  // Agreeing systems are not work.
  await store.resolveReferences(priya.id, page.id);
  assert.deepEqual(store.myQueue(priya.id).divergencesOnMyPages, []);

  state.other = 1200;
  await store.resolveReferences(priya.id, page.id);
  const priyas = store.myQueue(priya.id);
  assert.equal(priyas.divergencesOnMyPages.length, 1);
  assert.equal(priyas.divergencesOnMyPages[0]!.pageId, page.id);
  // A divergence row carries no title of its own, and a queue entry that could
  // not say what it was about would be the only one on the screen that could
  // not: the queue reads it back through the same membership join.
  assert.equal(priyas.divergencesOnMyPages[0]!.pageTitle, 'Benefits summary');
  assert.equal(priyas.divergencesOnMyPages[0]!.collectionId, collection.id);
  // Marcus can see the page; he is not accountable for it, so it is not his
  // queue that fills up.
  assert.deepEqual(store.myQueue(marcus.id).divergencesOnMyPages, []);

  // Settling it with a reason takes it off the queue, which is the only thing
  // that does — §7 never resolves one on its own.
  store.closeDivergence(priya.id, priyas.divergencesOnMyPages[0]!.id, { reason: 'Claims holds last year\'s figure.' });
  assert.deepEqual(store.myQueue(priya.id).divergencesOnMyPages, []);
});

// ---- the outbox, at last rendered ---------------------------------------

test('the queue: the outbox rides the queue, minus anything about a page I may no longer see', () => {
  const { store, dana, marcus, priya, collection } = setup();

  const page = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
    reviewDate: daysFromToday(-3),
  });
  // The submission wrote Marcus a `review_requested` notice, and nothing in
  // the product has ever shown it to him.
  const marcusNotices = store.myQueue(marcus.id).notices;
  assert.equal(marcusNotices.length, 1);
  assert.equal(marcusNotices[0]!.kind, 'review_requested');
  assert.match(marcusNotices[0]!.subject, /Retention policy/);

  store.approve(marcus.id, page.id);
  // The freshness sweep writes a `review_due` notice for the owner. This is
  // the notice whose absence forced the editor's promise to be narrowed to "a
  // notice is written to the record and nothing carries it to the owner".
  store.sweepFreshness(dana.id);
  const priyaNotices = store.myQueue(priya.id).notices;
  assert.ok(priyaNotices.some((n) => n.kind === 'review_due'));
  assert.ok(priyaNotices.some((n) => n.kind === 'draft_approved'));
  // Notices do not count toward the badge: the outbox has no read state, so a
  // number counting them would never go down.
  const queue = store.myQueue(priya.id);
  assert.equal(queue.counts.notices, queue.notices.length);
  assert.equal(queue.counts.total, queue.myPagesPastReview.length);

  // A notice keeps the page's TITLE for as long as the row lives. Withdraw the
  // membership and the notice goes with the page it names.
  store.removeMember(dana.id, collection.id, priya.id);
  assert.deepEqual(store.myQueue(priya.id).notices, []);
});

// ---- the surface --------------------------------------------------------

test('the queue over HTTP has no subject but the asker, and is closed to agents', async () => {
  const { db, store, dana, marcus, priya, collection } = setup();

  const page = policyInReview(store, priya.id, collection.id, 'Retention policy', {
    ownerId: priya.id,
    approverId: marcus.id,
  });

  const registry = new RegistryStore();
  const registryServer = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: 0, requestTimeoutMs: 500 }),
  });
  const server = createApi(store, auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, actorId: string) => {
    const res = await fetch(base + path, { headers: { 'x-actor-id': actorId } });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    const mine = await get('/queue', marcus.id);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.actorId, marcus.id);
    assert.deepEqual(mine.body.awaitingMyApproval.map((p: any) => p.pageId), [page.id]);
    assert.equal(mine.body.counts.total, 1);

    // There is no way to ask for somebody else's: the query string is not a
    // subject, and an unknown parameter changes nothing.
    const spoofed = await get(`/queue?actor=${marcus.id}&actorId=${marcus.id}`, dana.id);
    assert.equal(spoofed.status, 200);
    assert.equal(spoofed.body.actorId, dana.id);
    assert.deepEqual(spoofed.body.awaitingMyApproval, []);

    // An agent presenting a passport is refused at the door: the route is
    // unclassified in agentauth.ts, which fails closed.
    const bot = registry.register({ name: 'Watcher' });
    registry.certify(bot.agentId);
    registry.setPermissions(bot.agentId, {
      permittedCollections: [collection.id],
      permittedActions: ['read'],
    });
    const res = await fetch(`${base}/queue`, { headers: { 'x-agent-passport': bot.passport } });
    assert.equal(res.status, 403);
    const refusal = (await res.json()) as any;
    assert.match(JSON.stringify(refusal), /route_not_available_to_agents/);
  } finally {
    server.close();
    registryServer.close();
  }
});
