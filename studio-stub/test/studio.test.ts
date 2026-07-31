// The Studio app driving Veryl Canon end to end (STUDIO-CONTRACT.md).
//
// Three real services, in-process: the registry-stub issuing and certifying
// the app's Agent Passport, Canon serving the Knowledge API, and this app in
// front of both. Nothing here is mocked, because the thing under test is the
// contract between them — the app's HTTP face in, one Knowledge API call out,
// and the three-way intersection deciding what comes back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../../server/src/agentauth.js';
import { createApi } from '../../server/src/api.js';
import { openDb } from '../../server/src/db.js';
import { RegistryClient } from '../../server/src/registry.js';
import { CanonStore } from '../../server/src/store.js';
import { createStudioApi } from '../src/api.js';
import { BenefitsApp } from '../src/app.js';
import { KnowledgeClient } from '../src/client.js';

interface Rig {
  registry: RegistryStore;
  store: CanonStore;
  /** The Studio app's own HTTP face — what a person talks to. */
  studio: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  /** Canon directly, as a person, for seeding and for reading the audit log. */
  canon: (method: string, path: string, actorId?: string, body?: unknown) => Promise<{ status: number; json: any }>;
  appActorId: string;
  agentId: string;
  close: () => void;
}

async function rig(opts: { permittedCollections?: string[]; permittedActions?: string[] } = {}): Promise<{
  rig: Rig;
  seed: Awaited<ReturnType<typeof seedCanon>>;
}> {
  const registry = new RegistryStore();
  const registryServer = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;

  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const canonServer = createApi(
    store,
    new AgentAuth({
      db,
      store,
      registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: 0, requestTimeoutMs: 500 }),
    }),
  );
  await new Promise<void>((resolve) => canonServer.listen(0, resolve));
  const canonUrl = `http://127.0.0.1:${(canonServer.address() as AddressInfo).port}`;

  const canon = async (method: string, path: string, actorId?: string, body?: unknown) => {
    const res = await fetch(canonUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(actorId ? { 'x-actor-id': actorId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  const seed = await seedCanon(canon);

  // The app is registered and certified in the Registry like any agent, and
  // limited there. Canon is told nothing about it beyond what the passport
  // resolves to.
  const registered = registry.register({
    name: 'Benefits Assistant',
    permittedCollections: opts.permittedCollections ?? ['*'],
    permittedActions: opts.permittedActions ?? ['read'],
  });
  registry.certify(registered.agentId);

  const studioServer = createStudioApi(
    new BenefitsApp({
      name: 'Benefits Assistant',
      client: new KnowledgeClient({ baseUrl: canonUrl, passport: registered.passport, requestTimeoutMs: 2000 }),
    }),
  );
  await new Promise<void>((resolve) => studioServer.listen(0, resolve));
  const studioUrl = `http://127.0.0.1:${(studioServer.address() as AddressInfo).port}`;

  const studio = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(studioUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  // First contact provisions the app's Canon actor, so the collections it
  // needs can be granted to it. (In a deployment an administrator does this
  // once, in Canon, after the app is registered in the Registry.)
  await fetch(`${canonUrl}/collections`, { headers: { 'x-agent-passport': registered.passport } });
  const appActor = store.listActors().find((a) => a.registryRef === registered.agentId)!;

  return {
    rig: {
      registry,
      store,
      studio,
      canon,
      appActorId: appActor.id,
      agentId: registered.agentId,
      close: () => {
        studioServer.close();
        canonServer.close();
        registryServer.close();
      },
    },
    seed,
  };
}

async function seedCanon(canon: Rig['canon']) {
  const admin = (await canon('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
  const jo = (await canon('POST', '/actors', undefined, { kind: 'person', name: 'Jo Patel' })).json;
  const approver = (await canon('POST', '/actors', undefined, { kind: 'person', name: 'Iris' })).json;

  const benefits = (await canon('POST', '/collections', admin.id, { name: 'Benefits' })).json;
  const legal = (await canon('POST', '/collections', admin.id, { name: 'Legal' })).json;
  for (const c of [benefits, legal]) {
    await canon('PUT', `/collections/${c.id}/members/${approver.id}`, admin.id, { role: 'approve' });
  }

  const canonical = async (collectionId: string, title: string, body: string) => {
    const page = (await canon('POST', '/pages', admin.id, { collectionId, type: 'policy', title })).json;
    await canon('PUT', `/pages/${page.id}/draft`, admin.id, {
      body,
      fields: { ownerId: admin.id, approverId: approver.id },
    });
    await canon('POST', `/pages/${page.id}/submit`, admin.id, {});
    await canon('POST', `/pages/${page.id}/approve`, approver.id, {});
    return page;
  };

  const coverage = await canonical(
    benefits.id,
    'Prescription coverage policy',
    'Generic prescriptions are covered at 100 percent after the annual deductible is met.',
  );
  const settlement = await canonical(
    legal.id,
    'Prescription settlement policy',
    'Generic prescriptions are covered at 5 percent under the disputed settlement.',
  );
  return { admin, jo, approver, benefits, legal, coverage, settlement };
}

// ---------------------------------------------------------------------------

test('the app answers a benefits question with citations, on behalf of a named person', async () => {
  const { rig: r, seed } = await rig();
  try {
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');

    const asked = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(asked.json.refused, false);
    assert.equal(asked.json.citations.length, 1);
    assert.equal(asked.json.citations[0].pageId, seed.coverage.id);
    assert.equal(asked.json.citations[0].version, 1);

    // The rendering carries the citation, both identities, and no invention.
    const rendered: string = asked.json.rendered;
    assert.match(rendered, /Benefits Assistant — answering for Jo Patel/);
    assert.match(rendered, /100 percent/);
    assert.match(rendered, /Prescription coverage policy — version 1/);
    assert.equal(rendered.includes('5 percent'), false);

    // Canon's audit log names both, from one call.
    const events = (await r.canon('GET', '/audit?action=knowledge.ask', seed.admin.id)).json;
    assert.equal(events.length, 1);
    assert.equal(events[0].actorId, r.appActorId);
    assert.equal(events[0].actorKind, 'agent');
    assert.equal(events[0].details.onBehalfOf, seed.jo.id);
    assert.equal(events[0].details.personName, 'Jo Patel');
    assert.deepEqual(events[0].details.citedPageIds, [seed.coverage.id]);
  } finally {
    r.close();
  }
});

test('the app cannot answer from what the person cannot read', async () => {
  const { rig: r, seed } = await rig();
  try {
    // The app can see everything in Canon; Jo can see only Benefits.
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.legal.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');

    const asked = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(asked.json.refused, false);
    assert.deepEqual(
      asked.json.citations.map((c: any) => c.pageId),
      [seed.coverage.id],
      'the Legal policy the app can read must not reach an answer for Jo',
    );
    assert.equal(asked.json.rendered.includes('5 percent'), false);

    // Search agrees: same app, same query, bounded by the person.
    const found = await r.studio('GET', `/find?person=${seed.jo.id}&q=prescriptions`);
    assert.deepEqual(
      found.json.hits.map((h: any) => h.pageId),
      [seed.coverage.id],
    );

    // Naming that collection outright is refused, not quietly answered.
    const scoped = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id },
      question: 'How are generic prescriptions covered?',
      collectionId: seed.legal.id,
    });
    assert.equal(scoped.json.refused, true);
    assert.equal(scoped.json.error.status, 403);
    assert.equal(scoped.json.error.refusedBy, 'person');
    assert.match(scoped.json.rendered, /No answer: Jo Patel|does not have access/);
  } finally {
    r.close();
  }
});

test('the app cannot answer from what the app cannot read', async () => {
  const { rig: r, seed } = await rig();
  try {
    // Jo is an approver everywhere; the app is a member of nothing.
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'approve');
    r.store.setMember(seed.admin.id, seed.legal.id, seed.jo.id, 'approve');

    const asked = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(asked.json.refused, true, 'a person cannot lend the app access the app does not have');
    assert.deepEqual(asked.json.citations, []);
    assert.match(asked.json.rendered, /The record does not say/);

    // And whoami says exactly why: the intersection is empty.
    const who = await r.studio('GET', `/whoami?person=${seed.jo.id}`);
    assert.equal(who.status, 200);
    assert.deepEqual(who.json.whoami.collections, []);
    assert.match(who.json.rendered, /the intersection is empty/);
  } finally {
    r.close();
  }
});

test('the Registry narrows the app however generous Canon is', async () => {
  const { rig: r, seed } = await rig({ permittedCollections: [] });
  try {
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');

    const who = await r.studio('GET', `/whoami?person=${seed.jo.id}`);
    assert.deepEqual(who.json.whoami.collections, [], 'the Registry permits no collection, so nothing is effective');

    const asked = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(asked.json.refused, true);
    assert.deepEqual(asked.json.citations, []);

    // Widen the Registry alone and the same call answers — no restart, no
    // re-issued credential, no cache to clear.
    r.registry.setPermissions(r.agentId, { permittedCollections: [seed.benefits.id] });
    const again = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(again.json.refused, false);
    assert.equal(again.json.citations[0].pageId, seed.coverage.id);
  } finally {
    r.close();
  }
});

test('revocation stops the app on the very next question', async () => {
  const { rig: r, seed } = await rig();
  try {
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');
    const ask = () =>
      r.studio('POST', '/ask', { person: { actorId: seed.jo.id, name: 'Jo Patel' }, question: 'How are generic prescriptions covered?' });

    assert.equal((await ask()).json.refused, false);

    r.registry.revoke(r.agentId, { reason: 'withdrawn from Studio' });
    const after = await ask();
    assert.equal(after.json.refused, true);
    assert.equal(after.json.error.status, 403);
    assert.equal(after.json.error.code, 'forbidden');
    assert.match(after.json.rendered, /No answer/);

    // A revoked app is not "an app with no results": it is refused, and the
    // rendering says a refusal rather than a silence.
    assert.equal(after.json.rendered.includes('The record does not say'), false);
  } finally {
    r.close();
  }
});

test('the record’s silence is answered as silence, never as an invention', async () => {
  const { rig: r, seed } = await rig();
  try {
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');

    const asked = await r.studio('POST', '/ask', {
      person: { actorId: seed.jo.id, name: 'Jo Patel' },
      question: 'What is our policy on submarine procurement?',
    });
    assert.equal(asked.json.refused, true);
    assert.equal(asked.json.answer, null);
    assert.deepEqual(asked.json.citations, []);
    assert.equal(asked.json.reason, 'no_canonical_match');
    assert.match(asked.json.rendered, /The record does not say \(no_canonical_match\)/);
    assert.match(asked.json.rendered, /nothing was guessed/);
  } finally {
    r.close();
  }
});

test('the app names a person on every call, and Canon refuses it otherwise', async () => {
  const { rig: r, seed } = await rig();
  try {
    const anonymous = await r.studio('POST', '/ask', { question: 'How are generic prescriptions covered?' });
    assert.equal(anonymous.status, 400);
    assert.equal(anonymous.json.error, 'no_person');

    // A person Canon does not know is refused at Canon's door, not here.
    const ghost = await r.studio('POST', '/ask', {
      person: { actorId: 'someone-else', name: 'Nobody' },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(ghost.json.refused, true);
    assert.equal(ghost.json.error.status, 403);
    assert.match(ghost.json.error.message, /may not act for them/);

    // The app may not act on behalf of another agent, either.
    const impostor = await r.studio('POST', '/ask', {
      person: { actorId: r.appActorId },
      question: 'How are generic prescriptions covered?',
    });
    assert.equal(impostor.json.refused, true);
    assert.equal(impostor.json.error.status, 403);

    // Every one of those is on Canon's record against the app.
    const denials = (await r.canon('GET', '/audit?action=knowledge.denied', seed.admin.id)).json;
    assert.ok(denials.length >= 2);
    assert.ok(denials.every((e: any) => e.actorId === r.appActorId));
  } finally {
    r.close();
  }
});

test('when Canon does not answer, the app degrades visibly rather than guessing', async () => {
  const { rig: r, seed } = await rig();
  try {
    r.store.setMember(seed.admin.id, seed.benefits.id, r.appActorId, 'view');
    r.store.setMember(seed.admin.id, seed.benefits.id, seed.jo.id, 'view');

    // Point the app at a Canon that is not there.
    const orphan = new BenefitsApp({
      name: 'Benefits Assistant',
      client: new KnowledgeClient({ baseUrl: 'http://127.0.0.1:1', passport: 'vap_whatever', requestTimeoutMs: 300 }),
    });
    const answer = await orphan.answerFor({ actorId: seed.jo.id, name: 'Jo Patel' }, 'How are generic prescriptions covered?');
    assert.equal(answer.refused, true);
    assert.equal(answer.answer, null);
    assert.deepEqual(answer.citations, []);
    assert.equal(answer.error?.code, 'unreachable');
    assert.match(answer.rendered, /No answer/);
  } finally {
    r.close();
  }
});
