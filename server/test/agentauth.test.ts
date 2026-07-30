// Agent Passport authentication end to end (CORE-PLAN.md Epic D, M3;
// REGISTRY-CONTRACT.md). Canon's API is booted against the real
// registry-stub in-process — the same pairing the M3 demonstration runs
// against a live Registry, with only the base URL differing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth, agentAuthFromEnv } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

interface Rig {
  registry: RegistryStore;
  registryServer: Server;
  canon: Server;
  db: DatabaseSync;
  store: CanonStore;
  call: (
    method: string,
    path: string,
    auth?: { actor?: string; passport?: string },
    body?: unknown,
  ) => Promise<{ status: number; json: any }>;
  close: () => void;
}

async function rig(opts: { ttlMs?: number; withRegistry?: boolean } = {}): Promise<Rig> {
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
  const canon = createApi(store, auth);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, authHeaders: { actor?: string; passport?: string } = {}, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authHeaders.actor ? { 'x-actor-id': authHeaders.actor } : {}),
        ...(authHeaders.passport ? { 'x-agent-passport': authHeaders.passport } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  return {
    registry,
    registryServer,
    canon,
    db,
    store,
    call,
    close: () => {
      canon.close();
      registryServer.close();
    },
  };
}

// A person with a collection, and the agent granted a role in it.
async function seed(r: Rig, opts: { role?: string } = {}) {
  const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
  const collection = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Compliance' })).json;
  const page = (
    await r.call('POST', '/pages', { actor: dana.id }, { collectionId: collection.id, type: 'note', title: 'Handbook' })
  ).json;
  await r.call('PUT', `/pages/${page.id}/draft`, { actor: dana.id }, { body: 'Access is logged.' });
  await r.call('POST', `/pages/${page.id}/publish`, { actor: dana.id }, {});
  return { dana, collection, page, role: opts.role ?? 'view' };
}

test('passport auth resolves to an agent actor, provisioning it once', async () => {
  const r = await rig();
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({
      name: 'PolicyBot',
      permittedCollections: [collection.id],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);

    // First sight: no agent actor exists yet.
    const before = (await r.call('GET', '/actors', { actor: dana.id })).json;
    assert.equal(before.filter((a: any) => a.kind === 'agent').length, 0);

    // The agent needs a Canon role too — the intersection's other half.
    const first = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, []); // authenticated, but Canon grants nothing yet

    const actors = (await r.call('GET', '/actors', { actor: dana.id })).json;
    const agents = actors.filter((a: any) => a.kind === 'agent');
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, 'PolicyBot');
    assert.equal(agents[0].registryRef, bot.agentId);

    // Canon grants the agent view on the collection; now both halves allow.
    await r.call('PUT', `/collections/${collection.id}/members/${agents[0].id}`, { actor: dana.id }, { role: 'view' });
    const second = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(second.json.length, 1);
    assert.equal(second.json[0].id, collection.id);

    // Second sight reuses the actor: no duplicate row.
    const after = (await r.call('GET', '/actors', { actor: dana.id })).json;
    assert.equal(after.filter((a: any) => a.kind === 'agent').length, 1);

    // Canon holds a reference, never a credential.
    assert.equal(
      JSON.stringify(after).includes(bot.passport),
      false,
      'no passport is ever stored in or served from Canon',
    );
  } finally {
    r.close();
  }
});

test('refusals fail closed with the contract’s semantics', async () => {
  const r = await rig();
  try {
    const unknown = await r.call('GET', '/collections', { passport: 'vap_nobody' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.reason, 'unknown_passport');

    const pending = r.registry.register({ name: 'PendingBot' });
    const lapsed = await r.call('GET', '/collections', { passport: pending.passport });
    assert.equal(lapsed.status, 403);
    assert.equal(lapsed.json.reason, 'certification_lapsed');

    // A refusal Canon cannot attribute is still audited, against a one-way
    // fingerprint of the presented passport rather than the passport itself.
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    const failures = (await r.call('GET', '/audit?action=agent.auth_failed', { actor: dana.id })).json;
    assert.equal(failures.length, 2);
    assert.ok(failures.every((e: any) => e.actorId.startsWith('passport:')));
    assert.equal(JSON.stringify(failures).includes(pending.passport), false);
  } finally {
    r.close();
  }
});

test('the passport wins, and a mismatched X-Actor-Id is rejected', async () => {
  const r = await rig();
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: ['*'], permittedActions: ['read'] });
    r.registry.certify(bot.agentId);

    const mismatch = await r.call('GET', '/collections', { actor: dana.id, passport: bot.passport });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.json.reason, 'identity_mismatch');

    // The agent's own actor id alongside its passport is consistent, not a mix.
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'view' });
    const agreed = await r.call('GET', '/collections', { actor: agent.id, passport: bot.passport });
    assert.equal(agreed.status, 200);
    assert.equal(agreed.json.length, 1);
  } finally {
    r.close();
  }
});

test('enforcement is an intersection: the Registry can narrow Canon, never widen it', async () => {
  const r = await rig();
  try {
    const { dana, collection, page } = await seed(r);
    const other = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Everything else' })).json;

    // The Registry permits one collection and read only.
    const bot = r.registry.register({
      name: 'PolicyBot',
      permittedCollections: [collection.id],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);
    await r.call('GET', '/collections', { passport: bot.passport }); // provisions the actor
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');

    // Canon is generous: admin on both collections.
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'admin' });
    await r.call('PUT', `/collections/${other.id}/members/${agent.id}`, { actor: dana.id }, { role: 'admin' });

    // Direction 1 — Canon allows, the Registry denies (collection).
    const outside = await r.call('GET', `/collections/${other.id}`, { passport: bot.passport });
    assert.equal(outside.status, 403);
    assert.equal(outside.json.reason, 'collection_not_permitted');

    // Direction 1 again — Canon allows, the Registry denies (action).
    const write = await r.call('PUT', `/pages/${page.id}/draft`, { passport: bot.passport }, { body: 'Agent edit' });
    assert.equal(write.status, 403);
    assert.equal(write.json.reason, 'action_not_permitted');
    const comment = await r.call('POST', `/pages/${page.id}/comments`, { passport: bot.passport }, { body: 'A note' });
    assert.equal(comment.status, 403);
    assert.equal(comment.json.reason, 'action_not_permitted');

    // Inside both halves, the agent reads.
    const read = await r.call('GET', `/pages/${page.id}`, { passport: bot.passport });
    assert.equal(read.status, 200);
    assert.equal(read.json.current.body, 'Access is logged.');

    // Listings and search are narrowed to permitted collections, not refused.
    const listed = await r.call('GET', '/collections', { passport: bot.passport });
    assert.deepEqual(
      listed.json.map((c: any) => c.id),
      [collection.id],
    );
    const found = await r.call('GET', '/search?q=logged', { passport: bot.passport });
    assert.equal(found.json.length, 1);
    assert.equal(found.json[0].collectionId, collection.id);

    // Direction 2 — the Registry allows everything, Canon denies. A second
    // agent with '*' and write, but no Canon membership at all.
    const wide = r.registry.register({ name: 'WideBot', permittedCollections: ['*'], permittedActions: ['read', 'write'] });
    r.registry.certify(wide.agentId);
    const canonDenied = await r.call('GET', `/collections/${collection.id}`, { passport: wide.passport });
    assert.equal(canonDenied.status, 403);
    assert.equal(canonDenied.json.error, 'forbidden');
    assert.equal(canonDenied.json.needed, 'view'); // Canon's own permission model spoke

    // And even with '*' and write, Canon's role decides what it may do.
    const wideAgent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find(
      (a) => a.registryRef === wide.agentId,
    );
    await r.call('PUT', `/collections/${collection.id}/members/${wideAgent.id}`, { actor: dana.id }, { role: 'view' });
    const stillDenied = await r.call('PUT', `/pages/${page.id}/draft`, { passport: wide.passport }, { body: 'x' });
    assert.equal(stillDenied.status, 403);
    assert.equal(stillDenied.json.needed, 'edit');

    // The denials are audited against the agent, which is known.
    const denials = (await r.call('GET', '/audit?action=agent.denied', { actor: dana.id })).json;
    assert.equal(denials.length, 3);
    assert.ok(denials.every((e: any) => e.actorKind === 'agent'));
  } finally {
    r.close();
  }
});

test('an agent that may write is attributed as an agent in history and audit', async () => {
  const r = await rig();
  try {
    const { dana, collection, page } = await seed(r);
    const bot = r.registry.register({
      name: 'PolicyBot',
      permittedCollections: [collection.id],
      permittedActions: ['read', 'comment', 'write'],
    });
    r.registry.certify(bot.agentId);
    await r.call('GET', '/collections', { passport: bot.passport });
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'edit' });

    const draft = await r.call('PUT', `/pages/${page.id}/draft`, { passport: bot.passport }, { body: 'Revised by an agent.' });
    assert.equal(draft.status, 200);
    assert.equal(draft.json.editorId, agent.id);
    const published = await r.call('POST', `/pages/${page.id}/publish`, { passport: bot.passport }, {});
    assert.equal(published.status, 200);

    const commented = await r.call('POST', `/pages/${page.id}/comments`, { passport: bot.passport }, { body: 'Checked.' });
    assert.equal(commented.status, 200);
    assert.equal(commented.json.authorKind, 'agent');

    const audit = (await r.call('GET', '/audit', { actor: dana.id })).json;
    const agentEvents = audit.filter((e: any) => e.actorId === agent.id);
    assert.ok(agentEvents.length >= 3);
    assert.ok(agentEvents.every((e: any) => e.actorKind === 'agent'));
    assert.ok(agentEvents.some((e: any) => e.action === 'page.publish'));
  } finally {
    r.close();
  }
});

test('every fresh verification is an agent.session audit event', async () => {
  // A TTL long enough that a second request rides the cache: one session.
  const r = await rig({ ttlMs: 5_000 });
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: [collection.id] });
    r.registry.certify(bot.agentId);

    await r.call('GET', '/collections', { passport: bot.passport });
    await r.call('GET', '/collections', { passport: bot.passport });
    const sessions = (await r.call('GET', '/audit?action=agent.session', { actor: dana.id })).json;
    assert.equal(sessions.length, 1, 'a cached answer continues the session rather than starting a new one');
    assert.equal(sessions[0].actorKind, 'agent');
    assert.equal(sessions[0].details.registryRef, bot.agentId);
    assert.deepEqual(sessions[0].details.permittedCollections, [collection.id]);
    assert.deepEqual(sessions[0].details.permittedActions, ['read']);
  } finally {
    r.close();
  }
});

test('revocation in the Registry cuts access well inside the one-minute guarantee', async () => {
  const ttlMs = 100; // the guarantee is sixty seconds; the client clamps to it
  const r = await rig({ ttlMs });
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: [collection.id] });
    r.registry.certify(bot.agentId);
    await r.call('GET', '/collections', { passport: bot.passport });
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'view' });

    const before = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(before.json.length, 1);

    r.registry.revoke(bot.agentId, { reason: 'demonstrated live' });
    const revokedAt = Date.now();

    await sleep(ttlMs + 30);
    const after = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(after.status, 403);
    assert.equal(after.json.reason, 'revoked');
    assert.ok(Date.now() - revokedAt < 60_000, 'cut off inside the one-minute guarantee');

    // A limits change propagates on the same clock.
    const other = r.registry.register({ name: 'LimitBot', permittedCollections: [collection.id] });
    r.registry.certify(other.agentId);
    await r.call('GET', '/collections', { passport: other.passport });
    const limitBot = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find(
      (a) => a.registryRef === other.agentId,
    );
    await r.call('PUT', `/collections/${collection.id}/members/${limitBot.id}`, { actor: dana.id }, { role: 'view' });
    assert.equal((await r.call('GET', `/collections/${collection.id}`, { passport: other.passport })).status, 200);
    r.registry.setPermissions(other.agentId, { permittedCollections: [] });
    await sleep(ttlMs + 30);
    const narrowed = await r.call('GET', `/collections/${collection.id}`, { passport: other.passport });
    assert.equal(narrowed.status, 403);
    assert.equal(narrowed.json.reason, 'collection_not_permitted');
  } finally {
    r.close();
  }
});

test('a Registry outage denies access; nothing is served from stale trust', async () => {
  const ttlMs = 80;
  const r = await rig({ ttlMs });
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: [collection.id] });
    r.registry.certify(bot.agentId);
    await r.call('GET', '/collections', { passport: bot.passport });
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'view' });
    assert.equal((await r.call('GET', '/collections', { passport: bot.passport })).json.length, 1);

    // The Registry goes away, and the cached answer expires with it.
    await new Promise<void>((resolve) => r.registryServer.close(() => resolve()));
    await sleep(ttlMs + 30);
    const down = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(down.status, 503);
    assert.equal(down.json.reason, 'registry_unreachable');

    // Repeating it does not soften: an outage is never an allowance, and is
    // never cached as an answer either.
    const again = await r.call('GET', `/collections/${collection.id}`, { passport: bot.passport });
    assert.equal(again.status, 503);

    // People are unaffected by the Registry's absence.
    assert.equal((await r.call('GET', '/collections', { actor: dana.id })).status, 200);
  } finally {
    r.close();
  }
});

test('dev mode: with no Registry configured, passports are refused and people are unaffected', async () => {
  const r = await rig({ withRegistry: false });
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({ name: 'PolicyBot', permittedCollections: ['*'] });
    r.registry.certify(bot.agentId);

    const refused = await r.call('GET', '/collections', { passport: bot.passport });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error, 'unavailable');
    assert.match(refused.json.message, /CANON_REGISTRY_URL/);
    assert.equal(refused.json.configured, false);

    const person = await r.call('GET', `/collections/${collection.id}`, { actor: dana.id });
    assert.equal(person.status, 200);
    assert.equal((await r.call('GET', '/collections')).status, 401); // still X-Actor-Id or nothing
  } finally {
    r.close();
  }
});

test('the configuration switch is the environment, and it defaults to off', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  assert.equal(agentAuthFromEnv(db, store, {}), null);

  const configured = agentAuthFromEnv(db, store, {
    CANON_REGISTRY_URL: 'http://127.0.0.1:3100/',
    CANON_REGISTRY_TTL_MS: '15000',
  });
  assert.ok(configured);
  assert.equal(configured!.registry.baseUrl, 'http://127.0.0.1:3100');
  assert.equal(configured!.registry.cacheTtlMs, 15_000);

  // However eager the configuration, the guarantee holds.
  const greedy = agentAuthFromEnv(db, store, {
    CANON_REGISTRY_URL: 'http://127.0.0.1:3100',
    CANON_REGISTRY_TTL_MS: '600000',
  });
  assert.equal(greedy!.registry.cacheTtlMs, 60_000);
});
