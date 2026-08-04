// The Knowledge API end to end (STUDIO-CONTRACT.md; DATA-BACKBONE.md §7).
//
// Canon's API is booted against the real registry-stub in-process, exactly as
// agentauth.test.ts does — a Studio app is an agent, so it authenticates
// through the same door, and these tests would be meaningless against a fake
// Registry. What they add is the second identity: the person the app acts for,
// and the three-way intersection that follows from naming both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { RateLimiter } from '../src/ratelimit.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

interface Rig {
  registry: RegistryStore;
  registryServer: Server;
  db: DatabaseSync;
  store: CanonStore;
  call: (
    method: string,
    path: string,
    auth?: { actor?: string; passport?: string; onBehalfOf?: string },
    body?: unknown,
  ) => Promise<{ status: number; json: any }>;
  close: () => void;
}

async function rig(opts: { ttlMs?: number; withRegistry?: boolean; limiter?: RateLimiter } = {}): Promise<Rig> {
  const registry = new RegistryStore();
  const registryServer = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;

  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const auth =
    opts.withRegistry === false
      ? null
      : new AgentAuth({
          db,
          store,
          registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: opts.ttlMs ?? 0, requestTimeoutMs: 500 }),
        });
  const canon = createApi(store, auth, opts.limiter ?? new RateLimiter({}));
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;

  const call = async (
    method: string,
    path: string,
    headers: { actor?: string; passport?: string; onBehalfOf?: string } = {},
    body?: unknown,
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(headers.actor ? { 'x-actor-id': headers.actor } : {}),
        ...(headers.passport ? { 'x-agent-passport': headers.passport } : {}),
        ...(headers.onBehalfOf ? { 'x-on-behalf-of': headers.onBehalfOf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  return {
    registry,
    registryServer,
    db,
    store,
    call,
    close: () => {
      canon.close();
      registryServer.close();
    },
  };
}

// A benefits collection with one Canonical policy, a second collection that
// only some actors can see, and the people involved.
async function seed(r: Rig) {
  const admin = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
  // Dana administers this Canon, said outright: several tests below read audit
  // events that name no collection (`knowledge.ask`, `knowledge.denied`,
  // `agent.denied`), which reach an operator rather than the administrator of
  // some collection (orgrole.ts).
  r.store.bootstrapAdministrator(admin.id);
  const jo = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Jo Patel' })).json;
  const approver = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Iris' })).json;

  const benefits = (await r.call('POST', '/collections', { actor: admin.id }, { name: 'Benefits' })).json;
  const legal = (await r.call('POST', '/collections', { actor: admin.id }, { name: 'Legal' })).json;
  for (const c of [benefits, legal]) {
    await r.call('PUT', `/collections/${c.id}/members/${approver.id}`, { actor: admin.id }, { role: 'approve' });
  }

  const canonical = async (collectionId: string, title: string, body: string) => {
    const page = (await r.call('POST', '/pages', { actor: admin.id }, { collectionId, type: 'policy', title })).json;
    await r.call(
      'PUT',
      `/pages/${page.id}/draft`,
      { actor: admin.id },
      { body, fields: { ownerId: admin.id, approverId: approver.id, reviewDate: '2099-01-01', effectiveDate: TODAY } },
    );
    await r.call('POST', `/pages/${page.id}/submit`, { actor: admin.id }, {});
    await r.call('POST', `/pages/${page.id}/approve`, { actor: approver.id }, {});
    return page;
  };

  const coverage = await canonical(
    benefits.id,
    'Prescription coverage policy',
    'Generic prescriptions are covered at 100 percent after the annual deductible is met.',
  );
  const secret = await canonical(
    legal.id,
    'Prescription settlement policy',
    'Generic prescriptions are covered at 5 percent under the disputed settlement.',
  );

  return { admin, jo, approver, benefits, legal, coverage, secret };
}

/** Register and certify a Studio app in the Registry, and provision its actor. */
async function studioApp(
  r: Rig,
  opts: { name?: string; permittedCollections?: string[]; permittedActions?: string[] } = {},
) {
  const app = r.registry.register({
    name: opts.name ?? 'Benefits Assistant',
    permittedCollections: opts.permittedCollections ?? ['*'],
    permittedActions: opts.permittedActions ?? ['read'],
  });
  r.registry.certify(app.agentId);
  // First contact provisions the agent actor, on the plain agent surface so
  // the Knowledge API's own log stays exactly one event per Knowledge call.
  await r.call('GET', '/collections', { passport: app.passport });
  const actor = r.store.listActors().find((a) => a.registryRef === app.agentId)!;
  return { ...app, actorId: actor.id };
}

// ---------------------------------------------------------------------------

test('a Studio app is an agent: passport plus the person it acts for, or nothing', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, coverage } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');

    // No passport at all: this surface is for apps, and says so.
    const person = await r.call('GET', `/knowledge/pages/${coverage.id}`, { actor: jo.id });
    assert.equal(person.status, 401);
    assert.equal(person.json.reason, 'app_passport_required');

    // A passport, but no person named. "Both, always" has no meaning if one
    // half may be left off at the caller's discretion.
    const alone = await r.call('GET', `/knowledge/pages/${coverage.id}`, { passport: app.passport });
    assert.equal(alone.status, 401);
    assert.equal(alone.json.reason, 'on_behalf_of_required');
    assert.equal(alone.json.header, 'X-On-Behalf-Of');

    // A person Canon has never heard of is refused, not served.
    const ghost = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: 'nobody-at-all',
    });
    assert.equal(ghost.status, 403);
    assert.equal(ghost.json.reason, 'on_behalf_of_unknown');

    // An app may not act on behalf of another agent.
    const impostor = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: app.actorId,
    });
    assert.equal(impostor.status, 403);
    assert.equal(impostor.json.reason, 'on_behalf_of_not_a_person');

    // Both halves present, both permitted: the page is served.
    const ok = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.id, coverage.id);
    assert.match(ok.json.current.body, /100 percent/);

    // whoami reports the intersection as it currently stands, per call.
    const who = await r.call('GET', '/knowledge/whoami', { passport: app.passport, onBehalfOf: jo.id });
    assert.equal(who.status, 200);
    assert.equal(who.json.app.registryRef, app.agentId);
    assert.equal(who.json.person.actorId, jo.id);
    assert.deepEqual(
      who.json.collections.map((c: any) => c.id),
      [benefits.id],
    );
    assert.equal(who.json.collections[0].role, 'view');

    // Canon holds a reference to the app, never its credential.
    assert.equal(JSON.stringify(who.json).includes(app.passport), false);
  } finally {
    r.close();
  }
});

test('dual attribution: the app writes as itself, with the person on the record', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits } = await seed(r);
    const app = await studioApp(r, { permittedActions: ['read', 'comment', 'write'] });
    r.store.setMember(admin.id, benefits.id, app.actorId, 'edit');
    r.store.setMember(admin.id, benefits.id, jo.id, 'edit');

    const page = (
      await r.call(
        'POST',
        '/knowledge/pages',
        { passport: app.passport, onBehalfOf: jo.id },
        { collectionId: benefits.id, type: 'note', title: 'Open enrolment FAQ' },
      )
    ).json;
    assert.equal(page.createdBy, app.actorId, 'history names the app: it is what acted');

    const draft = await r.call(
      'PUT',
      `/knowledge/pages/${page.id}/draft`,
      { passport: app.passport, onBehalfOf: jo.id },
      { body: 'Enrolment closes on 30 November.' },
    );
    assert.equal(draft.status, 200);
    assert.equal(draft.json.editorId, app.actorId);

    const published = await r.call('POST', `/knowledge/pages/${page.id}/publish`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(published.status, 200);
    const versions = (await r.call('GET', `/pages/${page.id}/versions`, { actor: admin.id })).json;
    assert.equal(versions[0].authorId, app.actorId, 'the version is the app’s work');

    const comment = await r.call(
      'POST',
      `/knowledge/pages/${page.id}/comments`,
      { passport: app.passport, onBehalfOf: jo.id },
      { body: 'Drafted from the benefits handbook.' },
    );
    assert.equal(comment.status, 200);
    assert.equal(comment.json.authorKind, 'agent');

    // The audit log answers "who did what, through what": every Knowledge API
    // call is an event attributed to the app and naming the person.
    const events = (await r.call('GET', '/audit', { actor: admin.id })).json.filter(
      (e: any) => e.details?.surface === 'knowledge',
    );
    assert.ok(events.length >= 4, `expected one event per call, got ${events.length}`);
    assert.ok(events.every((e: any) => e.actorId === app.actorId && e.actorKind === 'agent'));
    assert.ok(events.every((e: any) => e.details.onBehalfOf === jo.id && e.details.personName === 'Jo Patel'));
    assert.ok(events.every((e: any) => e.details.registryRef === app.agentId));
    const actions = events.map((e: any) => e.action);
    for (const expected of ['knowledge.page_create', 'knowledge.draft', 'knowledge.publish', 'knowledge.comment']) {
      assert.ok(actions.includes(expected), `${expected} must be audited`);
    }
    // And the store's own history events are there too, attributed to the app.
    const publishes = (await r.call('GET', '/audit?action=page.publish', { actor: admin.id })).json;
    assert.ok(publishes.some((e: any) => e.actorId === app.actorId));
  } finally {
    r.close();
  }
});

test('the intersection narrows in every direction and widens in none', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, legal, coverage, secret } = await seed(r);

    // The app is generously permitted in Canon: it can see both collections.
    const app = await studioApp(r, { permittedActions: ['read', 'write'] });
    r.store.setMember(admin.id, benefits.id, app.actorId, 'edit');
    r.store.setMember(admin.id, legal.id, app.actorId, 'edit');
    // Jo can see only Benefits.
    r.store.setMember(admin.id, benefits.id, jo.id, 'edit');

    // Direction 1 — the app is permitted, the person is not. An app can never
    // lend a person access the person does not have.
    const lent = await r.call('GET', `/knowledge/pages/${secret.id}`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(lent.status, 403);
    assert.equal(lent.json.reason, 'person_not_permitted');
    assert.equal(lent.json.refusedBy, 'person');
    // ...and the same page is plainly readable by the app on the agent surface,
    // which is what makes the refusal the person's and not the app's.
    assert.equal((await r.call('GET', `/pages/${secret.id}`, { passport: app.passport })).status, 200);

    // Direction 2 — the person is permitted, the app is not. A person can
    // never lend the app access the app does not have.
    const stripped = await studioApp(r, { name: 'Unmembered App', permittedActions: ['read'] });
    const borrowed = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: stripped.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(borrowed.status, 403);
    assert.equal(borrowed.json.reason, 'app_not_permitted');
    assert.equal(borrowed.json.refusedBy, 'app');
    // Jo can read that page perfectly well on their own.
    assert.equal((await r.call('GET', `/pages/${coverage.id}`, { actor: jo.id })).status, 200);

    // Direction 3 — the Registry denies the collection, though both Canon
    // halves allow it.
    const limited = await studioApp(r, {
      name: 'Legal-only App',
      permittedCollections: [legal.id],
      permittedActions: ['read'],
    });
    r.store.setMember(admin.id, benefits.id, limited.actorId, 'view');
    const outside = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: limited.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(outside.status, 403);
    assert.equal(outside.json.reason, 'collection_not_permitted');

    // Direction 4 — the Registry denies the action, though both Canon halves
    // hold edit.
    const readOnly = await studioApp(r, { name: 'Read-only App', permittedActions: ['read'] });
    r.store.setMember(admin.id, benefits.id, readOnly.actorId, 'edit');
    const wrote = await r.call(
      'PUT',
      `/knowledge/pages/${coverage.id}/draft`,
      { passport: readOnly.passport, onBehalfOf: jo.id },
      { body: 'no' },
    );
    assert.equal(wrote.status, 403);
    assert.equal(wrote.json.reason, 'action_not_permitted');

    // Inside all three, the call is served.
    const served = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(served.status, 200);

    // Every refusal is on the record, and every one names the person the call
    // was made for. The two Canon halves refuse inside the Knowledge API, so
    // they are knowledge.denied...
    const denials = (await r.call('GET', '/audit?action=knowledge.denied', { actor: admin.id })).json;
    assert.equal(denials.length, 2);
    const person = denials.find((e: any) => e.details.refusedBy === 'person');
    assert.equal(person.details.onBehalfOf, jo.id);
    assert.equal(person.actorId, app.actorId);
    assert.ok(denials.some((e: any) => e.details.refusedBy === 'app'));

    // ...and the Registry refuses at the same door every agent meets, before
    // the handler runs, so those are agent.denied — carrying the person too.
    const registryDenials = (await r.call('GET', '/audit?action=agent.denied', { actor: admin.id })).json;
    assert.ok(registryDenials.length >= 2);
    assert.ok(
      registryDenials.filter((e: any) => e.details.onBehalfOf === jo.id).length >= 2,
      'a Registry refusal of a Studio app’s call still names the person it was made for',
    );
  } finally {
    r.close();
  }
});

test('an app cannot read through a person, or a person through an app, in bulk either', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, legal, coverage } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, legal.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');

    // Listings are narrowed by both halves, not refused.
    const collections = await r.call('GET', '/knowledge/collections', {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.deepEqual(
      collections.json.map((c: any) => c.id),
      [benefits.id],
      'the app sees two collections; Jo sees one; the app acting for Jo sees one',
    );

    // Search is narrowed in the SQL, before ranking. Both policies match.
    const asApp = (await r.call('GET', '/search?q=prescriptions', { passport: app.passport })).json;
    assert.equal(asApp.length, 2, 'the app alone can find both');
    const found = await r.call('GET', '/knowledge/search?q=prescriptions', {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(found.status, 200);
    assert.deepEqual(
      found.json.map((h: any) => h.pageId),
      [coverage.id],
    );

    // The tree of a collection the person cannot see is refused outright.
    const tree = await r.call('GET', `/knowledge/collections/${legal.id}/tree`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(tree.status, 403);
    assert.equal(tree.json.refusedBy, 'person');

    // And the other way: a person's own breadth buys the app nothing. Jo is
    // an approver in Legal; the app is not a member there at all.
    const narrowApp = await studioApp(r, { name: 'Benefits-only App' });
    r.store.setMember(admin.id, benefits.id, narrowApp.actorId, 'view');
    r.store.setMember(admin.id, legal.id, jo.id, 'approve');
    const throughPerson = await r.call('GET', '/knowledge/search?q=prescriptions', {
      passport: narrowApp.passport,
      onBehalfOf: jo.id,
    });
    assert.deepEqual(
      throughPerson.json.map((h: any) => h.pageId),
      [coverage.id],
      'Jo can now see both, but the app cannot, so the pair sees one',
    );
  } finally {
    r.close();
  }
});

test('grounded answers through the Knowledge API stay Canonical-only, cited, and refuse when silent', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, legal, coverage } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, legal.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');

    const question = 'How are generic prescriptions covered?';
    const asked = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question },
    );
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(asked.json.refused, false);
    assert.ok(asked.json.citations.length >= 1, 'an answer without citations is never returned');
    assert.ok(
      asked.json.citations.every((c: any) => c.pageId === coverage.id),
      'nothing outside the intersection may be cited',
    );
    assert.ok(asked.json.citations.every((c: any) => typeof c.version === 'number' && c.snippet.length > 0));
    assert.equal(
      asked.json.answer.includes('5 percent'),
      false,
      'the answer text must not carry material from the collection Jo cannot see',
    );

    // A Draft is not Canonical, and a Note can never be, so neither is cited.
    const note = (
      await r.call('POST', '/pages', { actor: admin.id }, { collectionId: benefits.id, type: 'note', title: 'Scratch' })
    ).json;
    await r.call(
      'PUT',
      `/pages/${note.id}/draft`,
      { actor: admin.id },
      { body: 'Generic prescriptions are rumoured to be covered at 40 percent.' },
    );
    await r.call('POST', `/pages/${note.id}/publish`, { actor: admin.id }, {});
    const again = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question },
    );
    assert.ok(
      again.json.citations.every((c: any) => c.pageId !== note.id),
      'a Note never carries the Canonical mark, so it never grounds an answer',
    );
    assert.equal(again.json.answer.includes('40 percent'), false);

    // Silence is answered as silence.
    const silent = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question: 'What is our policy on submarine procurement?' },
    );
    assert.equal(silent.json.refused, true);
    assert.deepEqual(silent.json.citations, []);
    assert.equal(silent.json.answer, null);
    assert.equal(silent.json.reason, 'no_canonical_match');

    // Every ask is audited with both actors and exactly what was cited.
    const asks = (await r.call('GET', '/audit?action=knowledge.ask', { actor: admin.id })).json;
    assert.equal(asks.length, 3);
    assert.ok(asks.every((e: any) => e.details.onBehalfOf === jo.id && e.actorId === app.actorId));
    const answered = asks.find((e: any) => e.details.refused === false);
    assert.deepEqual(answered.details.citedPageIds, [coverage.id]);

    // Naming a collection the person cannot see is refused rather than
    // silently answered from somewhere else.
    const scoped = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question, collectionId: legal.id },
    );
    assert.equal(scoped.status, 403);
    assert.equal(scoped.json.refusedBy, 'person');
  } finally {
    r.close();
  }
});

// USER-TESTING.md T3.7. Four situations used to answer byte for byte alike:
// the Registry withholding the collection, the person not holding it, the app
// not holding it, and the record simply having nothing to say. The contract
// told apps not to render those the same way while giving them no way to tell
// them apart.
//
// The distinction is drawn ONLY for an ask that names a collection — an asker
// who names one already knows it exists, because the Registry limit that let
// the name through was written by an administrator. The test below asserts
// both halves: that a scoped ask separates all four, and that an unscoped one
// still separates NONE of them, which is the property the leakage probing
// depended on.
test('a scoped ask tells its four refusals apart; an unscoped one deliberately does not', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, legal, coverage } = await seed(r);
    const app = await studioApp(r);
    // The app may read Benefits; Jo may read both. Nobody's Canon role touches
    // the Registry, which permits everything for now.
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    r.store.setMember(admin.id, legal.id, jo.id, 'view');

    const question = 'How are generic prescriptions covered?';
    const ask = (body: unknown) => r.call('POST', '/knowledge/ask', { passport: app.passport, onBehalfOf: jo.id }, body);

    // 1. The APP is not permitted the collection in Canon. This is the one
    //    T3.7 found silent: the person's gate passed, the candidate SQL
    //    returned nothing, and the response was "the record does not say".
    const appGate = await ask({ question, collectionId: legal.id });
    assert.equal(appGate.status, 403);
    assert.equal(appGate.json.reason, 'app_not_permitted');
    assert.equal(appGate.json.refusedBy, 'app');
    assert.equal(appGate.json.collectionId, legal.id);
    assert.equal(appGate.json.held, null, 'a collection the app holds no role in discloses no role');

    // 2. The PERSON is not permitted it. Unchanged, and it refuses first: the
    //    gates run Registry, person, app, and each one narrows.
    r.store.removeMember(admin.id, legal.id, jo.id);
    const personGate = await ask({ question, collectionId: legal.id });
    assert.equal(personGate.status, 403);
    assert.equal(personGate.json.reason, 'person_not_permitted');
    assert.equal(personGate.json.refusedBy, 'person');

    // 3. The record is silent inside a collection all three gates opened. This
    //    is now the ONLY thing a scoped `no_canonical_match` can mean.
    const silent = await ask({ question: 'What is our policy on submarine procurement?', collectionId: benefits.id });
    assert.equal(silent.status, 200);
    assert.deepEqual(silent.json, { answer: null, citations: [], refused: true, reason: 'no_canonical_match' });

    // 4. The REGISTRY withholds it, before the handler runs at all.
    r.registry.setPermissions(app.agentId, { permittedCollections: [benefits.id] });
    const registryGate = await ask({ question, collectionId: legal.id });
    assert.equal(registryGate.status, 403);
    assert.equal(registryGate.json.reason, 'collection_not_permitted');

    // And the answer still comes back where every gate is open.
    const answered = await ask({ question, collectionId: benefits.id });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.refused, false);
    assert.ok(answered.json.citations.every((c: any) => c.pageId === coverage.id));

    // ---- what stays indistinguishable, on purpose ------------------------
    //
    // The same four situations, asked as an OPEN question, must produce one
    // response. Saying anything else would tell an app that a collection it
    // was never told about exists and holds material on its subject.
    r.registry.setPermissions(app.agentId, { permittedCollections: ['*'] });
    r.store.setMember(admin.id, legal.id, jo.id, 'view'); // Jo can see Legal; the app cannot
    const openSilent = await ask({ question: 'What is our policy on submarine procurement?' });
    assert.deepEqual(openSilent.json, { answer: null, citations: [], refused: true, reason: 'no_canonical_match' });

    // Legal holds a Canonical page answering this question and Jo may read it,
    // but the app may not — so the pair is answered from Benefits only, and
    // the refusal that would have named Legal is never composed. Ask about
    // something ONLY Legal answers and the response is the one above, to the
    // byte, with nothing in it to say a Legal exists. (The pair still reads
    // Benefits, so this is the record's silence, not an empty intersection.)
    const hidden = await ask({ question: 'What does the disputed settlement say?' });
    assert.deepEqual(
      hidden.json,
      openSilent.json,
      'an open question is never told that material it may not read exists',
    );
  } finally {
    r.close();
  }
});

// The one thing an open question MAY be told: that the pair asking it can read
// nothing at all. That is the caller's own standing, not the record's
// contents — the same fact whoami hands the same caller in full — and it is
// the commonest way a Studio integration fails on its first afternoon.
test('an ask by a pair that can read nothing says so, rather than blaming the record', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits } = await seed(r);
    const app = await studioApp(r);
    const ask = (body: unknown) => r.call('POST', '/knowledge/ask', { passport: app.passport, onBehalfOf: jo.id }, body);
    const question = 'How are generic prescriptions covered?';

    // Certified, permitted every collection by the Registry, a member of none
    // in Canon: the app reads nothing, and the honest answer says which of the
    // two silences this is.
    const unconfigured = await ask({ question });
    assert.equal(unconfigured.status, 200, 'this is not a refusal of the call: it succeeded and had nowhere to look');
    assert.equal(unconfigured.json.refused, true);
    assert.equal(unconfigured.json.reason, 'nothing_readable');
    assert.deepEqual(unconfigured.json.citations, []);

    // whoami says the same thing, from the same computation, so an app that
    // renders "we can read nothing for you" can prove it before asking.
    const who = await r.call('GET', '/knowledge/whoami', { passport: app.passport, onBehalfOf: jo.id });
    assert.deepEqual(who.json.collections, []);

    // The person alone is not enough, and neither is the app alone: the reason
    // holds until BOTH hold a role, which is the intersection restated.
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    assert.equal((await ask({ question })).json.reason, 'nothing_readable');
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    const now = await ask({ question });
    assert.equal(now.json.refused, false);

    // An empty Registry limit is nowhere, not anywhere — and now says so.
    r.registry.setPermissions(app.agentId, { permittedCollections: [] });
    const withheld = await ask({ question });
    assert.equal(withheld.json.refused, true);
    assert.equal(withheld.json.reason, 'nothing_readable');

    // Back inside the limit, a question the record cannot answer is the
    // record's silence again, and says the other thing.
    r.registry.setPermissions(app.agentId, { permittedCollections: ['*'] });
    const quiet = await ask({ question: 'What is our policy on submarine procurement?' });
    assert.equal(quiet.json.reason, 'no_canonical_match');

    // The audit log carries which silence it was, so an operator reading a
    // week of refusals can tell a misconfigured app from a thin corpus.
    const asks = (await r.call('GET', '/audit?action=knowledge.ask', { actor: admin.id })).json;
    const reasons = asks.filter((e: any) => e.details.refused).map((e: any) => e.details.reason);
    assert.deepEqual(reasons.slice().sort(), ['no_canonical_match', 'nothing_readable', 'nothing_readable', 'nothing_readable']);
  } finally {
    r.close();
  }
});

test('the Registry’s collection limit bounds an answer that names no collection', async () => {
  const r = await rig();
  try {
    const { admin, jo, benefits, legal, secret } = await seed(r);
    // The Registry permits Legal only; Canon is generous to both actors.
    const app = await studioApp(r, { name: 'Legal Assistant', permittedCollections: [legal.id] });
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, legal.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    r.store.setMember(admin.id, legal.id, jo.id, 'view');

    const answer = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question: 'How are generic prescriptions covered?' },
    );
    assert.equal(answer.status, 200);
    assert.ok(
      answer.json.citations.every((c: any) => c.pageId === secret.id),
      'only the collection the Registry permits may ground the answer',
    );
    assert.equal(answer.json.answer.includes('100 percent'), false);

    // Take the last permitted collection away and the app is answered nothing
    // at all rather than everything: an empty limit is nowhere, not anywhere.
    r.registry.setPermissions(app.agentId, { permittedCollections: [] });
    const none = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: app.passport, onBehalfOf: jo.id },
      { question: 'How are generic prescriptions covered?' },
    );
    assert.equal(none.status, 200);
    assert.equal(none.json.refused, true);
  } finally {
    r.close();
  }
});

test('permission is evaluated per call: revocation and permission changes bite on the next one', async () => {
  const ttlMs = 100; // the Registry contract clamps to sixty seconds; this is well inside it
  const r = await rig({ ttlMs });
  try {
    const { admin, jo, benefits, coverage } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');

    const read = () =>
      r.call('GET', `/knowledge/pages/${coverage.id}`, { passport: app.passport, onBehalfOf: jo.id });
    assert.equal((await read()).status, 200);

    // 1. Canon takes the PERSON's access away. No Registry round-trip is
    //    involved at all: the very next call is refused.
    r.store.removeMember(admin.id, benefits.id, jo.id);
    const withoutPerson = await read();
    assert.equal(withoutPerson.status, 403);
    assert.equal(withoutPerson.json.refusedBy, 'person');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    assert.equal((await read()).status, 200);

    // 2. Canon takes the APP's access away. Same story, same call.
    r.store.removeMember(admin.id, benefits.id, app.actorId);
    const withoutApp = await read();
    assert.equal(withoutApp.status, 403);
    assert.equal(withoutApp.json.refusedBy, 'app');
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    assert.equal((await read()).status, 200);

    // 3. The Registry revokes the app's certification. Inside the contract's
    //    one-minute guarantee — here, inside the cache TTL — access is cut.
    r.registry.revoke(app.agentId, { reason: 'withdrawn from Studio' });
    const revokedAt = Date.now();
    await sleep(ttlMs + 30);
    const revoked = await read();
    assert.equal(revoked.status, 403);
    assert.equal(revoked.json.reason, 'revoked');
    assert.ok(Date.now() - revokedAt < 60_000);

    // No grant was minted anywhere: the app holds nothing to fall back on.
    assert.equal((await r.call('GET', '/knowledge/whoami', { passport: app.passport, onBehalfOf: jo.id })).status, 403);
  } finally {
    r.close();
  }
});

test('fail closed: with no Registry configured, the Knowledge API is shut', async () => {
  const r = await rig({ withRegistry: false });
  try {
    const { admin, jo, coverage } = await seed(r);
    const app = r.registry.register({ name: 'Benefits Assistant', permittedCollections: ['*'] });
    r.registry.certify(app.agentId);

    const refused = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error, 'unavailable');
    assert.match(refused.json.message, /CANON_REGISTRY_URL/);

    // And a person cannot slip in through the app's door without a passport.
    const bare = await r.call('GET', `/knowledge/pages/${coverage.id}`, { actor: jo.id });
    assert.equal(bare.status, 401);
    assert.equal(bare.json.reason, 'app_passport_required');

    // People are unaffected on their own surface.
    assert.equal((await r.call('GET', `/pages/${coverage.id}`, { actor: admin.id })).status, 200);
  } finally {
    r.close();
  }
});

test('a Registry outage refuses Knowledge API calls rather than serving stale trust', async () => {
  const ttlMs = 80;
  const r = await rig({ ttlMs });
  try {
    const { admin, jo, benefits, coverage } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    assert.equal(
      (await r.call('GET', `/knowledge/pages/${coverage.id}`, { passport: app.passport, onBehalfOf: jo.id })).status,
      200,
    );

    await new Promise<void>((resolve) => r.registryServer.close(() => resolve()));
    await sleep(ttlMs + 30);
    const down = await r.call('GET', `/knowledge/pages/${coverage.id}`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(down.status, 503);
    assert.equal(down.json.reason, 'registry_unreachable');
  } finally {
    r.close();
  }
});

test('the write surface lands under Canon’s workflow: no app grants the Canonical mark', async () => {
  const r = await rig();
  try {
    const { admin, jo, approver, benefits } = await seed(r);
    const app = await studioApp(r, { permittedActions: ['read', 'comment', 'write'] });
    r.store.setMember(admin.id, benefits.id, app.actorId, 'edit');
    r.store.setMember(admin.id, benefits.id, jo.id, 'edit');

    const page = (
      await r.call(
        'POST',
        '/knowledge/pages',
        { passport: app.passport, onBehalfOf: jo.id },
        { collectionId: benefits.id, type: 'policy', title: 'Vision cover' },
      )
    ).json;
    await r.call(
      'PUT',
      `/knowledge/pages/${page.id}/draft`,
      { passport: app.passport, onBehalfOf: jo.id },
      { body: 'Vision cover renews annually.', fields: { ownerId: admin.id, approverId: approver.id, reviewDate: '2099-01-01', effectiveDate: TODAY } },
    );

    // The app can bring the draft to the door of review...
    const submitted = await r.call('POST', `/knowledge/pages/${page.id}/submit`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.status, 'in_review');

    // ...but approval is not in the Knowledge API's vocabulary at all. The
    // Canonical mark is granted by a person, in Canon.
    const approve = await r.call('POST', `/knowledge/pages/${page.id}/approve`, {
      passport: app.passport,
      onBehalfOf: jo.id,
    });
    assert.equal(approve.status, 404);

    // A person completes the workflow, and the record shows both hands.
    const approved = await r.call('POST', `/pages/${page.id}/approve`, { actor: approver.id }, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, 'canonical');

    // An app cannot publish what a person could not: Jo drops to comment, the
    // app keeps edit, and the very next write is refused.
    r.store.setMember(admin.id, benefits.id, jo.id, 'comment');
    const blocked = await r.call(
      'PUT',
      `/knowledge/pages/${page.id}/draft`,
      { passport: app.passport, onBehalfOf: jo.id },
      { body: 'Revised without the person’s standing.' },
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.reason, 'person_not_permitted');
    assert.equal(blocked.json.needed, 'edit');

    // Commenting needs the comment role from both halves, and Jo still has it.
    const commented = await r.call(
      'POST',
      `/knowledge/pages/${page.id}/comments`,
      { passport: app.passport, onBehalfOf: jo.id },
      { body: 'Checked against the handbook.' },
    );
    assert.equal(commented.status, 200);
  } finally {
    r.close();
  }
});

// USER-TESTING.md T3.8. The `ask` bucket keyed on the actor, and on this
// surface the actor is the APP — so a whole company got twelve questions a
// minute between them, and one impatient person could spend the lot.
//
// The key is now the pair, and there is a second bucket keyed on the app alone.
// That second one is why keying the first on an app-asserted header is safe:
// forging person identifiers subdivides a budget, it does not enlarge one.
test('the ask bucket is keyed by the person, and the app’s own ceiling is what makes that safe', async () => {
  // Two questions each per person; six for the app across everybody. No refill
  // inside the test, so every number below is exact.
  const limiter = new RateLimiter({ ask: { burst: 2, perMinute: 0 }, askApp: { burst: 6, perMinute: 0 } });
  const r = await rig({ limiter });
  try {
    const { admin, jo, approver: iris, benefits } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    r.store.setMember(admin.id, benefits.id, iris.id, 'view');

    const ask = (person: string) =>
      r.call(
        'POST',
        '/knowledge/ask',
        { passport: app.passport, onBehalfOf: person },
        { question: 'How are generic prescriptions covered?' },
      );

    // Jo spends Jo's two and is refused the third.
    assert.equal((await ask(jo.id)).status, 200);
    assert.equal((await ask(jo.id)).status, 200);
    const spent = await ask(jo.id);
    assert.equal(spent.status, 429);
    assert.equal(spent.json.bucket, 'ask');

    // THE FINDING: Iris asks through the same app, and Jo's exhaustion is not
    // hers. Before this, the company shared one bucket and this was a 429.
    assert.equal((await ask(iris.id)).status, 200, 'one person’s questions are not the company’s');
    assert.equal((await ask(iris.id)).status, 200);
    assert.equal((await ask(iris.id)).status, 429);

    // AND THE FORGERY BOUND. `X-On-Behalf-Of` is asserted by the app and Canon
    // does not verify it, so an app could name a fresh person per request. It
    // buys two more questions and then meets the ceiling it cannot forge: its
    // own actor, resolved from its passport by the Registry. Six spent, six
    // allowed, and the seventh is refused however it is addressed.
    const alva = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Alva' })).json;
    r.store.setMember(admin.id, benefits.id, alva.id, 'view');
    assert.equal((await ask(alva.id)).status, 200);
    assert.equal((await ask(alva.id)).status, 200);
    const ceiling = await ask(alva.id);
    assert.equal(ceiling.status, 429);
    assert.equal(ceiling.json.bucket, 'ask', 'Alva’s own bucket empties first');

    const nobody = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Invented' })).json;
    const forged = await ask(nobody.id);
    assert.equal(forged.status, 429, 'a fresh person id does not mint a fresh budget');
    assert.equal(forged.json.bucket, 'askApp');

    // A person's own bucket is per (app, person): a SECOND app acting for Jo
    // is a different caller, with its own budget, because it is a different
    // party to the call with its own Registry limits and its own Canon role.
    const second = await studioApp(r, { name: 'Second Assistant' });
    r.store.setMember(admin.id, benefits.id, second.actorId, 'view');
    const throughSecond = await r.call(
      'POST',
      '/knowledge/ask',
      { passport: second.passport, onBehalfOf: jo.id },
      { question: 'How are generic prescriptions covered?' },
    );
    assert.equal(throughSecond.status, 200);
  } finally {
    r.close();
  }
});

// The other half of T3.8 on this surface: a Studio call refused at a gate, or
// sent malformed, reaches no retrieval and so spends nothing.
test('a Studio ask refused before the work costs the person nothing', async () => {
  const limiter = new RateLimiter({ ask: { burst: 2, perMinute: 0 }, askApp: { burst: 20, perMinute: 0 } });
  const r = await rig({ limiter });
  try {
    const { admin, jo, benefits, legal } = await seed(r);
    const app = await studioApp(r);
    r.store.setMember(admin.id, benefits.id, app.actorId, 'view');
    r.store.setMember(admin.id, benefits.id, jo.id, 'view');
    r.store.setMember(admin.id, legal.id, jo.id, 'view');

    const question = 'How are generic prescriptions covered?';
    const headers = { passport: app.passport, onBehalfOf: jo.id };

    // A question Canon will not accept, a person Canon has never heard of, and
    // a collection the app may not read: 400, 403, 403, and no tokens spent.
    assert.equal((await r.call('POST', '/knowledge/ask', headers, { question: '' })).status, 400);
    assert.equal(
      (await r.call('POST', '/knowledge/ask', { passport: app.passport, onBehalfOf: 'nobody' }, { question })).status,
      403,
    );
    assert.equal((await r.call('POST', '/knowledge/ask', headers, { question, collectionId: legal.id })).status, 403);

    // The two questions Jo actually has are still there.
    assert.equal((await r.call('POST', '/knowledge/ask', headers, { question })).status, 200);
    assert.equal((await r.call('POST', '/knowledge/ask', headers, { question })).status, 200);
    assert.equal((await r.call('POST', '/knowledge/ask', headers, { question })).status, 429);
  } finally {
    r.close();
  }
});
