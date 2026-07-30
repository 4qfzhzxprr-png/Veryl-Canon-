import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { parseMentions } from '../src/comments.js';
import type { Notification, NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

// A quiet transport keeps test output clean while still marking sent,
// exactly like the dev transport does.
const quiet: NotificationTransport = { deliver() {} };

function setup(transport: NotificationTransport = quiet) {
  const store = new CanonStore(openDb(':memory:'), transport);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const rosa = store.createActor({ kind: 'person', name: 'Rosa', email: 'rosa@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  store.setMember(dana.id, collection.id, rosa.id, 'comment');
  store.setMember(dana.id, collection.id, vera.id, 'view');
  return { store, dana, marc, iris, rosa, vera, collection };
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

function ofKind(store: CanonStore, actorId: string, kind: Notification['kind']): Notification[] {
  return store.listNotifications(actorId).filter((n) => n.kind === kind);
}

test('comments: require the comment role; attributed and on the audit record', () => {
  const { store, marc, rosa, vera, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Figures' });

  expectCode(() => store.createComment(vera.id, page.id, { body: 'view is not enough' }), 'forbidden');
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.createComment(outsider.id, page.id, { body: 'sneak' }), 'forbidden');

  const comment = store.createComment(rosa.id, page.id, { body: 'Is the Q2 figure current?' });
  assert.equal(comment.authorId, rosa.id);
  assert.equal(comment.authorKind, 'person');
  assert.equal(comment.anchor, null); // page-level
  assert.equal(comment.resolvedAt, null);

  const listed = store.listComments(vera.id, page.id); // view role can read comments
  assert.deepEqual(listed.map((c) => c.id), [comment.id]);

  const events = store.queryAudit(rosa.id, { action: 'comment.create' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorId, rosa.id);
  assert.equal(events[0]!.pageId, page.id);
  assert.equal(events[0]!.details.commentId, comment.id);
  assert.equal(events[0]!.details.anchored, false);
});

test('comments: an inline anchor round-trips as quoted text plus context', () => {
  const { store, marc, rosa, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Policy draft' });
  store.editDraft(marc.id, page.id, { body: 'Records are kept 7 years. Access is logged.' });
  store.publish(marc.id, page.id);

  const inline = store.createComment(rosa.id, page.id, {
    body: 'Seven years, or seven years after termination?',
    anchor: { quote: 'kept 7 years', context: 'Records are kept 7 years.' },
  });
  assert.deepEqual(inline.anchor, { quote: 'kept 7 years', context: 'Records are kept 7 years.' });

  // Context is optional; the quote alone is a valid anchor.
  const bare = store.createComment(rosa.id, page.id, {
    body: 'Logged where?',
    anchor: { quote: 'Access is logged.' },
  });
  assert.deepEqual(bare.anchor, { quote: 'Access is logged.', context: null });

  // The stored anchors survive the read path unchanged.
  const listed = store.listComments(rosa.id, page.id);
  assert.deepEqual(
    listed.map((c) => c.anchor),
    [inline.anchor, bare.anchor],
  );

  const events = store.queryAudit(rosa.id, { action: 'comment.create' });
  assert.ok(events.every((e) => e.details.anchored === true));
});

test('comments: bodies are required and an anchor requires its quote', () => {
  const { store, marc, rosa, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  expectCode(() => store.createComment(rosa.id, page.id, { body: '   ' }), 'invalid');
  expectCode(() => store.createComment(rosa.id, page.id, { body: 'hm', anchor: { quote: '  ' } }), 'invalid');
  expectCode(() => store.createComment(rosa.id, 'no-such-page', { body: 'lost' }), 'not_found');
});

test('comments: resolve and reopen, with permissions and audit events', () => {
  const { store, marc, rosa, vera, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  const comment = store.createComment(rosa.id, page.id, { body: 'Stale?' });

  expectCode(() => store.resolveComment(vera.id, comment.id), 'forbidden'); // view cannot resolve

  const resolved = store.resolveComment(marc.id, comment.id);
  assert.equal(resolved.resolvedBy, marc.id);
  assert.ok(resolved.resolvedAt);
  expectCode(() => store.resolveComment(rosa.id, comment.id), 'workflow'); // already resolved

  const reopened = store.reopenComment(rosa.id, comment.id);
  assert.equal(reopened.resolvedAt, null);
  assert.equal(reopened.resolvedBy, null);
  expectCode(() => store.reopenComment(rosa.id, comment.id), 'workflow'); // not resolved

  const resolves = store.queryAudit(marc.id, { action: 'comment.resolve' });
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0]!.actorId, marc.id);
  assert.equal(resolves[0]!.details.commentId, comment.id);
  assert.equal(store.queryAudit(marc.id, { action: 'comment.reopen' }).length, 1);
});

test('comments: archived pages are read-only', () => {
  const { store, marc, rosa, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Old' });
  store.archivePage(marc.id, page.id);
  expectCode(() => store.createComment(rosa.id, page.id, { body: 'too late' }), 'workflow');
});

test('mentions: parsing is simple and exact', () => {
  assert.deepEqual(parseMentions('no mentions here'), []);
  assert.deepEqual(parseMentions('ping @abc-123 and @abc-123 again'), ['abc-123']); // deduped
  assert.deepEqual(parseMentions('@a1 then @b2'), ['a1', 'b2']);
});

test('mentions: each mentioned actor gets a notification; unknown ids are plain text', () => {
  const { store, marc, iris, rosa, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Q2 figures' });

  const body = `@${iris.id} and @${marc.id}: is this current? cc @nobody-real (and @${rosa.id} myself)`;
  const comment = store.createComment(rosa.id, page.id, { body });

  for (const actor of [iris, marc]) {
    const mentions = ofKind(store, actor.id, 'mention');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]!.body, body);
    assert.equal(mentions[0]!.link, `/pages/${page.id}#comment-${comment.id}`);
    assert.match(mentions[0]!.subject, /Rosa mentioned you/);
  }
  assert.equal(ofKind(store, rosa.id, 'mention').length, 0); // no self-notification

  // The audit event records who was actually mentioned; the unknown id was not.
  const events = store.queryAudit(rosa.id, { action: 'comment.create' });
  assert.deepEqual(new Set(events[0]!.details.mentions as string[]), new Set([iris.id, marc.id]));
});

test('notifications: submitting a policy notifies its named approver', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id },
  });
  store.submitForReview(marc.id, page.id);

  const requests = ofKind(store, iris.id, 'review_requested');
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.subject, /Review requested: Access policy/);
  assert.match(requests[0]!.body, /Marc submitted/);
  assert.equal(requests[0]!.link, `/pages/${page.id}`);
  // The approver is named, so approve-role members at large are not pinged.
  assert.equal(ofKind(store, dana.id, 'review_requested').length, 0);
});

test('notifications: submitting a plan notifies all approve-role members, not the submitter', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q4 plan' });
  store.editDraft(marc.id, page.id, { body: 'Milestones.', fields: { ownerId: marc.id } });
  store.submitForReview(marc.id, page.id);

  // A Plan names no approver: iris (approve) and dana (admin, which implies
  // approve) are notified; the submitter is not.
  assert.equal(ofKind(store, iris.id, 'review_requested').length, 1);
  assert.equal(ofKind(store, dana.id, 'review_requested').length, 1);
  assert.equal(ofKind(store, marc.id, 'review_requested').length, 0);
});

test('notifications: approval notifies the draft editor and page owner, deduplicated', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, page.id, {
    body: 'Keep 7 years.',
    fields: { ownerId: marc.id, approverId: iris.id },
  });
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id);

  // Marc is both the editor and the owner: exactly one notification.
  const approvals = ofKind(store, marc.id, 'draft_approved');
  assert.equal(approvals.length, 1);
  assert.match(approvals[0]!.subject, /Approved as Canonical: Retention/);
  assert.equal(ofKind(store, iris.id, 'draft_approved').length, 0); // approver acted; no self-ping
});

test('notifications: send-back notifies the editor and owner, carrying the comment', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  // Dana owns the page; Marc edits the draft. Both should hear about a send-back.
  store.editDraft(marc.id, page.id, {
    body: 'Vague.',
    fields: { ownerId: dana.id, approverId: iris.id },
  });
  store.submitForReview(marc.id, page.id);
  store.sendBack(iris.id, page.id, { comment: 'Name the systems in scope.' });

  for (const actor of [marc, dana]) {
    const sentBack = ofKind(store, actor.id, 'draft_sent_back');
    assert.equal(sentBack.length, 1);
    assert.match(sentBack[0]!.subject, /Sent back: Access policy/);
    assert.match(sentBack[0]!.body, /Name the systems in scope\./);
  }
  assert.equal(ofKind(store, iris.id, 'draft_sent_back').length, 0);
});

test('notifications: outbox pattern — a failing transport leaves the row queued, unsent', () => {
  const failing: NotificationTransport = {
    deliver() {
      throw new Error('smtp down');
    },
  };
  const { store, marc, iris, rosa, collection } = setup(failing);
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  store.createComment(rosa.id, page.id, { body: `look @${iris.id}` });

  const queued = ofKind(store, iris.id, 'mention');
  assert.equal(queued.length, 1); // the write survived the failed delivery
  assert.equal(queued[0]!.sentAt, null); // still in the outbox
});

test('notifications: a working transport marks sent; each actor sees only their own', () => {
  const delivered: Notification[] = [];
  const capturing: NotificationTransport = {
    deliver(n) {
      delivered.push(n);
    },
  };
  const { store, marc, iris, rosa, collection } = setup(capturing);
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  store.createComment(rosa.id, page.id, { body: `for @${iris.id} only` });

  const mine = store.listNotifications(iris.id);
  assert.equal(mine.length, 1);
  assert.ok(mine[0]!.sentAt); // marked sent after delivery
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.recipientId, iris.id);
  assert.equal(store.listNotifications(marc.id).length, 0); // own notifications only
  assert.equal(store.listNotifications(rosa.id).length, 0);
});

test('agent comments are attributed and marked as agent work', () => {
  const { store, dana, marc, collection } = setup();
  const agent = store.createActor({ kind: 'agent', name: 'Freshness Agent', registryRef: 'passport:fresh-1' });
  store.setMember(dana.id, collection.id, agent.id, 'comment');

  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Q2 figures' });
  const comment = store.createComment(agent.id, page.id, {
    body: `The Q2 number changed upstream, @${marc.id}.`,
    anchor: { quote: 'Q2' },
  });
  assert.equal(comment.authorId, agent.id);
  assert.equal(comment.authorKind, 'agent');

  const events = store.queryAudit(dana.id, { action: 'comment.create' });
  assert.equal(events[0]!.actorKind, 'agent');
  assert.equal(ofKind(store, marc.id, 'mention').length, 1); // agent mentions notify like anyone's
});

test('API smoke: comments, mentions, and notifications over HTTP', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'x-actor-id': actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const rosa = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Rosa' })).json;
    const vera = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Vera' })).json;

    const c = (await call('POST', '/collections', dana.id, { name: 'Compliance' })).json;
    await call('PUT', `/collections/${c.id}/members/${rosa.id}`, dana.id, { role: 'comment' });
    await call('PUT', `/collections/${c.id}/members/${vera.id}`, dana.id, { role: 'view' });

    const page = (await call('POST', '/pages', dana.id, { collectionId: c.id, type: 'note', title: 'Figures' }))
      .json;

    const denied = await call('POST', `/pages/${page.id}/comments`, vera.id, { body: 'view only' });
    assert.equal(denied.status, 403);

    const created = await call('POST', `/pages/${page.id}/comments`, rosa.id, {
      body: `Stale, @${dana.id}?`,
      anchor: { quote: 'Q2 revenue', context: 'the Q2 revenue table' },
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.json.anchor, { quote: 'Q2 revenue', context: 'the Q2 revenue table' });

    const listed = (await call('GET', `/pages/${page.id}/comments`, vera.id)).json;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].authorId, rosa.id);

    const resolved = (await call('POST', `/comments/${created.json.id}/resolve`, rosa.id)).json;
    assert.equal(resolved.resolvedBy, rosa.id);
    const reopened = (await call('POST', `/comments/${created.json.id}/reopen`, rosa.id)).json;
    assert.equal(reopened.resolvedAt, null);

    const unauthenticated = await call('GET', '/notifications');
    assert.equal(unauthenticated.status, 401);
    const inbox = (await call('GET', '/notifications', dana.id)).json;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, 'mention');
    assert.equal(inbox[0].link, `/pages/${page.id}#comment-${created.json.id}`);
    assert.equal((await call('GET', '/notifications', vera.id)).json.length, 0);
  } finally {
    server.close();
  }
});
