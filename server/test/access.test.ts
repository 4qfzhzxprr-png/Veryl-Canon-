import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

// Asking for access, and the inbox that answers it.
//
// The feature is small. The BOUNDARY is not, and it is what these tests are
// mostly about: a request names the refusal it follows and never a page, so
// that the endpoint cannot become the existence oracle Canon's search boundary
// was drawn to prevent (policy question 1 — "existence, never identity").
//
// So the four things pinned here, in order of what would be worst if it broke:
//
//   1. an asker learns NOTHING from asking. Not what collection decides it, not
//      what the page is called, not whether the id they sent was real;
//   2. a ground the asker cannot substantiate answers exactly as an unknown one
//      does, so the two cannot be told apart by trying both;
//   3. only an administrator of the deciding collection sees the request, and
//      only they can decide it;
//   4. a grant goes through `setMember`, so membership keeps one road in.

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const kit = store.createActor({ kind: 'person', name: 'Kit', email: 'kit@example.com' });
  const compliance = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, compliance.id, kit.id, 'view');
  return { store, dana, kit, compliance };
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

test('access: a member asks for the role above the one they hold, and it reaches the administrator', () => {
  const { store, dana, kit, compliance } = setup();

  const asked = store.requestAccess(kit.id, {
    ground: 'collection',
    collectionId: compliance.id,
    role: 'edit',
    note: 'I am writing the claims runbook and cannot save a draft.',
  });
  assert.equal(asked.status, 'open');
  assert.equal(asked.requestedRole, 'edit');
  // The asker named this collection themselves, so it comes back.
  assert.equal(asked.collectionId, compliance.id);

  // It reaches the one person who can act on it, with the sentence it was made
  // on — a request nobody can see is worse than no request.
  const inbox = store.listAccessRequests(dana.id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.askerId, kit.id);
  assert.equal(inbox[0]!.askerName, 'Kit');
  assert.equal(inbox[0]!.askerRole, 'view');
  assert.match(inbox[0]!.note ?? '', /claims runbook/);

  const told = store.listNotifications(dana.id).find((n) => n.kind === 'access_requested');
  assert.ok(told, 'the administrator is told');
  assert.match(told.subject, /Kit is asking for access to Compliance/);
});

test('access: the request carries a sentence, because a decision is made on it', () => {
  const { store, kit, compliance } = setup();
  const refused = expectCode(
    () => store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, role: 'edit' }),
    'invalid',
  );
  assert.match(refused.message, /Say what you need to do/);
});

test('access: granting goes through setMember, so membership keeps one road in', () => {
  const { store, dana, kit, compliance } = setup();
  const asked = store.requestAccess(kit.id, {
    ground: 'collection',
    collectionId: compliance.id,
    role: 'edit',
    note: 'I cannot save a draft.',
  });

  const decided = store.decideAccessRequest(dana.id, asked.id, { outcome: 'granted', role: 'edit' });
  assert.equal(decided.status, 'granted');
  assert.equal(decided.grantedRole, 'edit');
  assert.equal(store.roleOf(kit.id, compliance.id), 'edit', 'the grant actually happened');
  // The membership event `setMember` writes is there, not a second kind of
  // grant invented here.
  assert.equal(store.queryAudit(dana.id, { action: 'collection.member_set' }).length >= 1, true);
  assert.equal(store.queryAudit(dana.id, { action: 'access.granted' }).length, 1);

  const told = store.listNotifications(kit.id).find((n) => n.kind === 'access_decided');
  assert.match(told!.subject, /gave you edit on Compliance/);
});

test('access: a decline records why, and a grant need not', () => {
  const { store, dana, kit, compliance } = setup();
  const asked = store.requestAccess(kit.id, {
    ground: 'collection',
    collectionId: compliance.id,
    role: 'edit',
    note: 'I cannot save a draft.',
  });
  // The same asymmetry approve/sendBack already keeps: a grant writes its own
  // record; "no" tells somebody nothing they can act on.
  const refused = expectCode(() => store.decideAccessRequest(dana.id, asked.id, { outcome: 'declined' }), 'invalid');
  assert.match(refused.message, /Declining records why/);

  const declined = store.decideAccessRequest(dana.id, asked.id, {
    outcome: 'declined',
    note: 'Ask Priya to write it; this collection is limited to the policy team.',
  });
  assert.equal(declined.status, 'declined');
  assert.equal(store.roleOf(kit.id, compliance.id), 'view', 'nothing was granted');
  const told = store.listNotifications(kit.id).find((n) => n.kind === 'access_decided');
  assert.match(told!.body, /policy team/);
});

test('access: only an administrator of the deciding collection sees it, or can decide it', () => {
  const { store, dana, kit, compliance } = setup();
  const asked = store.requestAccess(kit.id, {
    ground: 'collection',
    collectionId: compliance.id,
    role: 'edit',
    note: 'I cannot save a draft.',
  });

  // The asker is a member and holds `view`. They must not see their own request
  // in the DECIDER's listing, which is the inbox, not a receipt.
  assert.equal(store.listAccessRequests(kit.id).length, 0);
  // Nor decide it — and the refusal is `not_found`, not `forbidden`, because
  // "there is a request here" is itself something an id-holder must not learn.
  expectCode(() => store.decideAccessRequest(kit.id, asked.id, { outcome: 'granted' }), 'not_found');
  assert.equal(store.roleOf(kit.id, compliance.id), 'view');

  // Somebody with no standing at all sees and does nothing.
  const outsider = store.createActor({ kind: 'person', name: 'Mallory' });
  assert.equal(store.listAccessRequests(outsider.id).length, 0);
  expectCode(() => store.decideAccessRequest(outsider.id, asked.id, { outcome: 'granted' }), 'not_found');
});

test('access: an org administrator’s inbox is every collection’s, like their membership break-glass', () => {
  const { store, dana, kit, compliance } = setup();
  store.requestAccess(kit.id, {
    ground: 'collection',
    collectionId: compliance.id,
    role: 'edit',
    note: 'I cannot save a draft.',
  });
  const ade = store.createActor({ kind: 'person', name: 'Ade' });
  assert.equal(store.listAccessRequests(ade.id).length, 0);
  store.bootstrapAdministrator(ade.id);
  // Same break-glass `requirePermissionAdmin` already grants, and for the same
  // reason: a collection whose last administrator left still has requests in it.
  assert.equal(store.listAccessRequests(ade.id).length, 1);
});

test('access: a collection you hold nothing in is not a refusal you can carry', () => {
  const { store, compliance } = setup();
  const outsider = store.createActor({ kind: 'person', name: 'Mallory' });

  // THE ORACLE, REFUSED. If this endpoint accepted any collection id somebody
  // typed, it would answer "sent" for one that exists and something else for
  // one that does not — one call, no search needed. It answers the same way for
  // both, and the same way it answers a real collection this actor holds
  // nothing in.
  const real = expectCode(
    () => store.requestAccess(outsider.id, { ground: 'collection', collectionId: compliance.id, note: 'let me in' }),
    'not_found',
  );
  const invented = expectCode(
    () => store.requestAccess(outsider.id, { ground: 'collection', collectionId: 'no-such-collection', note: 'let me in' }),
    'not_found',
  );
  assert.equal(real.message, invented.message, 'a real collection and an invented one answer identically');
  assert.equal(store.listAccessRequests(outsider.id).length, 0);
});

test('access: asking for a role you already hold is refused rather than filed', () => {
  const { store, dana, kit, compliance } = setup();
  store.setMember(dana.id, compliance.id, kit.id, 'edit');
  expectCode(
    () => store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, role: 'view', note: 'more' }),
    'invalid',
  );
});

test('access: one open request per thing asked about, and the second says so', () => {
  const { store, kit, compliance } = setup();
  store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, note: 'I need to comment.' });
  const again = expectCode(
    () => store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, note: 'still need it' }),
    'conflict',
  );
  assert.match(again.message, /already asked/);
});

// ---------------------------------------------------------------------------
// The `relation` ground: the one that completes policy question 1.
//
// `relations.ts` tells you that a page you hold conflicts with SOMETHING and
// nothing about what. This turns that disclosure into an act without widening
// it by one field.

function conflicted() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const kit = store.createActor({ kind: 'person', name: 'Kit', email: 'kit@example.com' });
  const legal = store.createActor({ kind: 'person', name: 'Lena', email: 'lena@example.com' });

  const ops = store.createCollection(kit.id, { name: 'Operations' });
  const secret = store.createCollection(legal.id, { name: 'Legal Hold' });
  // Dana can see both, so Dana can assert the conflict across them.
  store.setMember(kit.id, ops.id, dana.id, 'edit');
  store.setMember(legal.id, secret.id, dana.id, 'edit');

  const mine = store.createPage(kit.id, { collectionId: ops.id, type: 'note', title: 'Retention runbook' });
  const theirs = store.createPage(legal.id, { collectionId: secret.id, type: 'note', title: 'Litigation hold — Redwood' });
  const relation = store.assertRelation(dana.id, mine.id, {
    toPageId: theirs.id,
    kind: 'conflicts_with',
    note: 'The runbook deletes what the hold preserves.',
  });
  return { store, dana, kit, legal, ops, secret, mine, theirs, relation };
}

test('access: the relation ground asks about a page the asker was never shown', () => {
  const { store, kit, legal, secret, mine, theirs, relation } = conflicted();

  // What Kit can see: a conflict, and nothing about the far end.
  const seen = store.listRelations(kit.id, mine.id);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.other, { withheld: true });

  const asked = store.requestAccess(kit.id, {
    ground: 'relation',
    relationId: relation.id,
    note: 'My runbook is recorded as contradicting something and I cannot see what.',
  });

  // THE WHOLE RULE, IN THE RECEIPT. Kit learns nothing from having asked: not
  // the collection that will decide, not the page, not its title.
  assert.equal(asked.collectionId, null, 'the deciding collection is not disclosed by the asking');
  assert.equal(asked.fromPageId, mine.id, 'their own page is named, because it is theirs');
  assert.equal(JSON.stringify(asked).includes(theirs.id), false, 'no id of the withheld page anywhere in the receipt');
  assert.equal(JSON.stringify(asked).includes(secret.id), false);
  assert.equal(JSON.stringify(asked).includes('Litigation hold'), false);
  // Nor from their own listing, later.
  const mineListed = store.listMyAccessRequests(kit.id);
  assert.equal(JSON.stringify(mineListed).includes(secret.id), false);
  assert.equal(JSON.stringify(mineListed).includes('Litigation hold'), false);

  // And it landed with the people who can actually decide it — who see the
  // page, because they administer the collection holding it.
  const inbox = store.listAccessRequests(legal.id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.subjectPageId, theirs.id);
  assert.equal(inbox[0]!.subjectTitle, 'Litigation hold — Redwood');
  assert.equal(inbox[0]!.collectionId, secret.id);
  // The administrator of the OTHER collection sees nothing: the request is
  // about a page in Legal Hold, and Operations has no say in it.
  assert.equal(store.listAccessRequests(kit.id).length, 0);
});

test('access: a relation ground you cannot substantiate answers as an unknown one does', () => {
  const { store, dana, relation } = conflicted();
  const stranger = store.createActor({ kind: 'person', name: 'Mallory' });

  // Neither end visible: this person was never shown the relation, so asking
  // about it must tell them nothing — including whether it exists.
  const unseen = expectCode(
    () => store.requestAccess(stranger.id, { ground: 'relation', relationId: relation.id, note: 'curious' }),
    'not_found',
  );
  const invented = expectCode(
    () => store.requestAccess(stranger.id, { ground: 'relation', relationId: 'no-such-relation', note: 'curious' }),
    'not_found',
  );
  assert.equal(unseen.message, invented.message, 'a real relation and an invented one answer identically');

  // BOTH ends visible — Dana, who asserted the conflict and holds `edit` in
  // both collections. There is nothing withheld to ask for, and the same answer
  // is given rather than a different one that would confirm the pair.
  const both = expectCode(
    () => store.requestAccess(dana.id, { ground: 'relation', relationId: relation.id, note: 'again' }),
    'not_found',
  );
  assert.equal(both.message, unseen.message);
});

test('access: granting a relation request lets the asker in, and only then names it', () => {
  const { store, kit, legal, secret, theirs, relation } = conflicted();
  const asked = store.requestAccess(kit.id, {
    ground: 'relation',
    relationId: relation.id,
    note: 'I need to know what my runbook contradicts.',
  });
  const inbox = store.listAccessRequests(legal.id);
  store.decideAccessRequest(legal.id, inbox[0]!.id, { outcome: 'granted', role: 'view' });

  assert.equal(store.roleOf(kit.id, secret.id), 'view');
  // Now the far end is theirs to read, so the relation says what it is — and
  // the receipt may name the collection, because naming it is no longer a
  // disclosure but the answer to "what did I just get".
  const seen = store.listRelations(kit.id, store.getPage(kit.id, theirs.id).id);
  assert.ok(seen.length >= 1);
  const listed = store.listMyAccessRequests(kit.id).find((r) => r.id === asked.id)!;
  assert.equal(listed.status, 'granted');
  assert.equal(listed.collectionId, secret.id);
});

test('access: a declined relation request still names nothing', () => {
  const { store, kit, legal, secret, relation } = conflicted();
  store.requestAccess(kit.id, { ground: 'relation', relationId: relation.id, note: 'I need to settle this.' });
  const inbox = store.listAccessRequests(legal.id);
  store.decideAccessRequest(legal.id, inbox[0]!.id, {
    outcome: 'declined',
    note: 'This is under legal hold; your legal contact will get in touch.',
  });

  const listed = store.listMyAccessRequests(kit.id)[0]!;
  assert.equal(listed.status, 'declined');
  assert.equal(listed.collectionId, null, 'a refusal must not disclose what it refused');
  const told = store.listNotifications(kit.id).find((n) => n.kind === 'access_decided')!;
  assert.equal(told.subject, 'Your request for access was declined');
  assert.equal(told.subject.includes('Legal Hold'), false);
  assert.equal(JSON.stringify(told).includes(secret.id), false);
});

test('access: the asker can take it back, and nobody else can', () => {
  const { store, dana, kit, compliance } = setup();
  const asked = store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, note: 'Never mind.' });
  expectCode(() => store.withdrawAccessRequest(dana.id, asked.id), 'not_found');
  const gone = store.withdrawAccessRequest(kit.id, asked.id);
  assert.equal(gone.status, 'withdrawn');
  assert.equal(store.listAccessRequests(dana.id).length, 0);
});

test('access: the queue is the inbox — counted for the decider, uncounted for the asker', () => {
  const { store, dana, kit, compliance } = setup();
  const before = store.myQueue(dana.id).counts.total;
  store.requestAccess(kit.id, { ground: 'collection', collectionId: compliance.id, note: 'I cannot save a draft.' });

  const deciders = store.myQueue(dana.id);
  assert.equal(deciders.accessRequests.length, 1);
  assert.equal(deciders.counts.accessRequests, 1);
  assert.equal(deciders.counts.total, before + 1, 'somebody waiting on a decision only you can make is work');

  const askers = store.myQueue(kit.id);
  assert.equal(askers.accessRequests.length, 0, 'the asker is not their own inbox');
  assert.equal(askers.accessAsked.length, 1);
  assert.equal(askers.counts.total, 0, 'waiting on somebody else is never counted');
  assert.equal(askers.accessAsked[0]!.collectionId, compliance.id);
});

test('API: the whole loop over HTTP, and the response never widens the rule', async () => {
  const store = new CanonStore(openDb(':memory:'));
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
    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const kit = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Kit' })).json;
    const compliance = (await call('POST', '/collections', dana.id, { name: 'Compliance' })).json;
    await call('PUT', `/collections/${compliance.id}/members/${kit.id}`, dana.id, { role: 'view' });

    const asked = await call('POST', '/access-requests', kit.id, {
      ground: 'collection',
      collectionId: compliance.id,
      role: 'comment',
      note: 'I want to raise a question on the retention page.',
    });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.status, 'open');
    // The decider's fields must not ride out on the asker's response.
    assert.equal(asked.json.askerName, undefined);
    assert.equal(asked.json.subjectPageId, undefined);

    // The inbox, and the asker's own listing, are two different views.
    const inbox = await call('GET', '/access-requests', dana.id);
    assert.equal(inbox.json.length, 1);
    const kitInbox = await call('GET', '/access-requests', kit.id);
    assert.equal(kitInbox.json.length, 0, 'the asker has no inbox of their own request');
    const kitSent = await call('GET', '/access-requests?mine=true', kit.id);
    assert.equal(kitSent.json.length, 1);

    // A page id is not a ground, whatever anybody sends.
    const typed = await call('POST', '/access-requests', kit.id, { ground: 'page', pageId: compliance.id, note: 'x' });
    assert.equal(typed.status, 400);

    const decided = await call('POST', `/access-requests/${inbox.json[0].id}/decide`, dana.id, {
      outcome: 'granted',
      role: 'comment',
      note: '',
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.status, 'granted');
    const members = await call('GET', `/collections/${compliance.id}/members`, dana.id);
    assert.equal(members.json.find((m: any) => m.actorId === kit.id).role, 'comment');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// The screen half. Asserted against the file that ships, the way
// pageview.test.ts and imports.test.ts are: the whole finding was that a wall
// named who held the role and could not ask them, so the control has to be ON
// the refusal, and the inbox has to be on the screen administrators open.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

const client = readFileSync(findPublicFile('app.js'), 'utf8');

test('access: the ask sits on the refusal, on all three walls a reader actually meets', () => {
  // The 403 page, which is where a refused person lands. `forbiddenRole`
  // already answers with `{ collectionId, needed, held }` beside its sentence,
  // so this reads the refusal rather than parsing its prose.
  assert.match(client, /const canAsk = err\?\.status === 403 && d\.collectionId && d\.held/);
  // The page view, beside the greyed controls.
  assert.match(client, /group\.count && can\?\.role && can\.role !== 'admin'/);
  // And the withheld relation, which is the disclosure policy question 1
  // decided to make: the control carries the RELATION, never a page.
  assert.match(client, /data-ground="relation"\s*\n?\s*data-relation="\$\{esc\(rel\.id\)\}"/);
});

test('access: nothing in the client sends a page id as a ground', () => {
  const dialog = /function openAskAccessModal\([\s\S]*?\n\}/.exec(client)?.[0] ?? '';
  assert.ok(dialog, 'the dialog exists');
  assert.match(dialog, /'\/access-requests'/);
  // The two grounds, and no third thing that could carry an id somebody typed.
  assert.match(dialog, /\{ ground, collectionId, role: form\.role\.value, note \}/);
  assert.match(dialog, /\{ ground, relationId, note \}/);
  assert.doesNotMatch(dialog, /pageId/);
  // No free-text id field anywhere in it: the context comes from the refusal
  // the control is standing on.
  assert.doesNotMatch(dialog, /name="collectionId"|name="pageId"|name="relationId"/);
});

test('access: the inbox is a strand of the queue, counted, and drawn from the queue’s own payload', () => {
  assert.match(client, /queue\.accessRequests \?\? \[\]/);
  assert.match(client, /queue\.accessAsked \?\? \[\]/);
  assert.match(client, /People asking for access/);
  // "Nothing is waiting on you" must not be printed over a waiting request —
  // the Phase 5 rule, applied to the strand that was just added.
  assert.match(client, /const nothing = [^;]*!\(queue\.accessRequests \?\? \[\]\)\.length/);
});
