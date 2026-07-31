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
import {
  AgentAuth,
  agentAuthFromEnv,
  currentAgentSession,
  permitsSourceForRequest,
  refuseUnpermittedSource,
  runInAgentRequestScope,
} from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { setHandOrgRole } from '../src/orgrole.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';
import { staticConnectorOf } from '../src/connectors.js';

interface Rig {
  registry: RegistryStore;
  registryServer: Server;
  canon: Server;
  db: DatabaseSync;
  store: CanonStore;
  // Canon's door itself, for the enforcement primitives that federation calls
  // from inside a handler rather than from the route table.
  auth: AgentAuth | null;
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
    auth,
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
  // Dana runs this Canon, and now has to say so: administering one collection
  // is no longer the stand-in for an org-level role (orgrole.ts). It is what
  // makes `GET /actors` show her the agent actors these tests look for —
  // SECURITY.md F11's residual, closed.
  setHandOrgRole(r.db, dana.id, 'administrator', null);
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
    // An audit event naming no collection reaches the actor it is about and
    // otherwise only an OPERATOR of this Canon (SECURITY.md R5, and the
    // org-level role that replaced its "admin on some collection" stand-in).
    // An unattributable refusal is about nobody, so Dana reads it as an
    // operator — administering a collection would no longer be enough.
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    setHandOrgRole(r.db, dana.id, 'operator', null);
    await r.call('POST', '/collections', { actor: dana.id }, { name: 'Compliance' });
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

// ---------------------------------------------------------------------------
// Federated sources, governed like collections (DATA-BACKBONE.md §6;
// REGISTRY-CONTRACT.md §4).
//
// The federation core — sources.ts, connectors.ts, references.ts, and the
// GET /pages/:id/references and /sources routes in api.ts — is another
// stream's work and is not in this tree. Its routes are therefore classified
// here but not yet mounted, so a call through fetch would be answered by
// api.ts's own 404 before agentauth ever saw it. These tests exercise the
// enforcement primitives directly instead: `enforce` for whole requests, and
// the request-scoped `refuseUnpermittedSource` for individual references. When
// the federation core lands, the routes it mounts meet exactly these rules.

test('permittedSources rides the verification into the session and the audit', async () => {
  const r = await rig({ ttlMs: 5_000 });
  try {
    const { dana, collection } = await seed(r);
    const bot = r.registry.register({
      name: 'BenefitsBot',
      permittedCollections: [collection.id],
      permittedSources: ['src-benefits'],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);

    const session = await r.auth!.authenticate(bot.passport);
    assert.deepEqual(session.permittedSources, ['src-benefits']);
    assert.equal(session.permitsSource('src-benefits'), true);
    assert.equal(session.permitsSource('src-payroll'), false);

    // The session event records what the Registry granted, sources included:
    // the audit log has to be able to answer "what was this agent allowed to
    // reach" a year later, when the Registry's record has moved on.
    const sessions = (await r.call('GET', '/audit?action=agent.session', { actor: dana.id })).json;
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].details.permittedSources, ['src-benefits']);

    // A limits change in the Registry arrives with the next verification, on
    // the same clock as a revocation.
    r.registry.setPermissions(bot.agentId, { permittedSources: ['*'] });
    r.auth!.registry.invalidate(bot.passport);
    const widened = await r.auth!.authenticate(bot.passport);
    assert.equal(widened.permitsSource('anything-at-all'), true);
  } finally {
    r.close();
  }
});

test('sources are an intersection too, and silence grants none', async () => {
  const r = await rig();
  try {
    const { dana, collection, page } = await seed(r);
    const other = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Everything else' })).json;

    // Permitted the collection the page lives in, and one source.
    const bot = r.registry.register({
      name: 'BenefitsBot',
      permittedCollections: [collection.id],
      permittedSources: ['src-benefits'],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);
    const session = await r.auth!.authenticate(bot.passport);
    r.store.setMember(dana.id, collection.id, session.actorId, 'view');

    // Direction 1 — the collection is permitted, the source is not. The page
    // is readable; the reference from the withheld source is refused in place.
    assert.equal((await r.call('GET', `/pages/${page.id}`, { passport: bot.passport })).status, 200);
    const enforced = r.auth!.enforce(session, { method: 'GET', pathname: `/pages/${page.id}/references` });
    assert.equal(enforced.action, 'read');
    assert.equal(enforced.collectionId, collection.id, 'the page’s collection governs the page');
    const refusal = runInAgentRequestScope(r.auth, session, () =>
      refuseUnpermittedSource('src-payroll', { pageId: page.id, selector: 'salary' }),
    );
    assert.ok(refusal, 'an unpermitted source must be refused, not resolved');
    assert.equal(refusal!.error, 'source_not_permitted');
    assert.equal(refusal!.sourceId, 'src-payroll');
    assert.equal(refusal!.refusedBy, 'registry');
    // ...while the permitted one is not refused at all.
    assert.equal(
      runInAgentRequestScope(r.auth, session, () => refuseUnpermittedSource('src-benefits', { pageId: page.id })),
      null,
    );

    // Direction 2 — the source is permitted, the collection is not. The
    // Registry's source grant buys nothing on a page the agent cannot reach.
    const elsewhere = (
      await r.call('POST', '/pages', { actor: dana.id }, { collectionId: other.id, type: 'note', title: 'Payroll' })
    ).json;
    assert.equal(session.permitsSource('src-benefits'), true);
    assert.throws(
      () => r.auth!.enforce(session, { method: 'GET', pathname: `/pages/${elsewhere.id}/references` }),
      (err: any) => err.details.reason === 'collection_not_permitted',
      'a permitted source does not open an unpermitted collection',
    );

    // Absent means none: an agent whose limits say nothing about sources
    // resolves nothing, however wide its collections are.
    const quiet = r.registry.register({ name: 'QuietBot', permittedCollections: ['*'], permittedActions: ['read'] });
    r.registry.certify(quiet.agentId);
    const quietSession = await r.auth!.authenticate(quiet.passport);
    assert.deepEqual(quietSession.permittedSources, []);
    assert.equal(quietSession.permitsSource('src-benefits'), false);
    assert.ok(runInAgentRequestScope(r.auth, quietSession, () => refuseUnpermittedSource('src-benefits')));

    // `"*"` means every source, exactly as it means every collection.
    const wide = r.registry.register({
      name: 'WideBot',
      permittedCollections: ['*'],
      permittedSources: ['*'],
      permittedActions: ['read'],
    });
    r.registry.certify(wide.agentId);
    const wideSession = await r.auth!.authenticate(wide.passport);
    assert.equal(wideSession.permitsSource('src-never-registered'), true);
    assert.equal(
      runInAgentRequestScope(r.auth, wideSession, () => refuseUnpermittedSource('src-never-registered')),
      null,
    );

    // People are unaffected: outside an agent scope everything is permitted
    // here, because Canon's own permissions are the only gate a person meets.
    assert.equal(currentAgentSession(), null);
    assert.equal(permitsSourceForRequest('src-payroll'), true);
    assert.equal(refuseUnpermittedSource('src-payroll'), null);
  } finally {
    r.close();
  }
});

test('reading through a source is not redefining one: administration needs "*"', async () => {
  const r = await rig();
  try {
    const { collection } = await seed(r);
    const named = r.registry.register({
      name: 'BenefitsBot',
      permittedCollections: [collection.id],
      permittedSources: ['src-benefits'],
      permittedActions: ['read', 'write'],
    });
    r.registry.certify(named.agentId);
    const session = await r.auth!.authenticate(named.passport);

    // Registering, changing, or removing a source is write AND "*".
    for (const [method, pathname] of [
      ['POST', '/sources'],
      ['PUT', '/sources/src-benefits'],
      ['DELETE', '/sources/src-benefits'],
    ]) {
      assert.throws(
        () => r.auth!.enforce(session, { method: method!, pathname: pathname!, body: {} }),
        (err: any) => err.details.reason === 'source_administration_not_permitted',
        `${method} ${pathname} must need "*"`,
      );
    }

    // Reading one it was named is fine, and reading one it was not is not.
    assert.equal(r.auth!.enforce(session, { method: 'GET', pathname: '/sources/src-benefits' }).action, 'read');
    assert.throws(
      () => r.auth!.enforce(session, { method: 'GET', pathname: '/sources/src-payroll' }),
      (err: any) => err.details.reason === 'source_not_permitted' && err.details.sourceId === 'src-payroll',
    );

    // A listing is narrowed, not refused — the rule collections already have.
    const listing = r.auth!.enforce(session, { method: 'GET', pathname: '/sources' });
    assert.deepEqual(listing.narrow([{ id: 'src-benefits' }, { id: 'src-payroll' }]), [{ id: 'src-benefits' }]);

    // With "*", administration opens.
    const admin = r.registry.register({
      name: 'AdminBot',
      permittedCollections: ['*'],
      permittedSources: ['*'],
      permittedActions: ['read', 'write'],
    });
    r.registry.certify(admin.agentId);
    const adminSession = await r.auth!.authenticate(admin.passport);
    assert.equal(r.auth!.enforce(adminSession, { method: 'POST', pathname: '/sources', body: {} }).action, 'write');

    // But write is still needed: "*" over sources is not an action grant.
    const reader = r.registry.register({
      name: 'ReadOnlyBot',
      permittedCollections: ['*'],
      permittedSources: ['*'],
      permittedActions: ['read'],
    });
    r.registry.certify(reader.agentId);
    const readerSession = await r.auth!.authenticate(reader.passport);
    assert.throws(
      () => r.auth!.enforce(readerSession, { method: 'POST', pathname: '/sources', body: {} }),
      (err: any) => err.details.reason === 'action_not_permitted',
    );
  } finally {
    r.close();
  }
});

test('a refused source resolution is an agent.denied event naming the source', async () => {
  const r = await rig();
  try {
    const { dana, collection, page } = await seed(r);
    const bot = r.registry.register({
      name: 'BenefitsBot',
      permittedCollections: [collection.id],
      permittedSources: ['src-benefits'],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);
    const session = await r.auth!.authenticate(bot.passport);

    runInAgentRequestScope(r.auth, session, () => {
      refuseUnpermittedSource('src-payroll', { pageId: page.id, selector: 'salary', key: 'EMP-7' });
      refuseUnpermittedSource('src-benefits', { pageId: page.id }); // permitted: nothing logged
    });

    const denials = (await r.call('GET', '/audit?action=agent.denied', { actor: dana.id })).json;
    assert.equal(denials.length, 1, 'a permitted source is not a denial');
    const [event] = denials;
    assert.equal(event.actorKind, 'agent');
    assert.equal(event.actorId, session.actorId);
    assert.equal(event.pageId, page.id);
    assert.equal(event.details.reason, 'source');
    assert.equal(event.details.sourceId, 'src-payroll');
    assert.equal(event.details.selector, 'salary');
    assert.equal(event.details.registryRef, bot.agentId);

    // The same family covers a whole request refused about a source.
    assert.throws(() => r.auth!.enforce(session, { method: 'GET', pathname: '/sources/src-payroll' }));
    const both = (await r.call('GET', '/audit?action=agent.denied', { actor: dana.id })).json;
    assert.equal(both.length, 2);
    assert.ok(both.every((e: any) => e.details.sourceId === 'src-payroll'));
  } finally {
    r.close();
  }
});

// Regression: /ask and /pages/:id/related were added by a later stream than
// agentauth, so they fell through to the fail-closed default and a certified
// read-only agent was refused a grounded answer. The contract (section 4)
// names grounded answers as `read`; the classification table now says so too.
// Caught running the M3 demo end to end, not by the suite.
test('a read-certified agent may ask, and the answer respects both sides', async () => {
  const r = await rig();
  try {
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    const iris = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Iris' })).json;

    const open = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Benefits' })).json;
    const shut = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Secret' })).json;
    for (const c of [open, shut]) {
      await r.call('PUT', `/collections/${c.id}/members/${iris.id}`, { actor: dana.id }, { role: 'approve' });
    }

    const canonical = async (collectionId: string, title: string, body: string) => {
      const page = (
        await r.call('POST', '/pages', { actor: dana.id }, { collectionId, type: 'policy', title })
      ).json;
      await r.call(
        'PUT',
        `/pages/${page.id}/draft`,
        { actor: dana.id },
        { body, fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2099-01-01' } },
      );
      await r.call('POST', `/pages/${page.id}/submit`, { actor: dana.id }, {});
      await r.call('POST', `/pages/${page.id}/approve`, { actor: iris.id }, {});
      return page;
    };

    const visible = await canonical(open.id, 'Coverage policy', 'Generic prescriptions are covered at 100 percent.');
    await canonical(shut.id, 'Secret coverage policy', 'Generic prescriptions are covered at 5 percent.');

    const agent = r.registry.register({ name: 'Benefits Assistant' });
    r.registry.certify(agent.agentId);
    r.registry.setPermissions(agent.agentId, { permittedCollections: [open.id], permittedActions: ['read'] });

    // Canon's half of the intersection: the Registry allowing it is not enough.
    const denied = await r.call('POST', '/ask', { passport: agent.passport }, { question: 'How are generic prescriptions covered?' });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.refused, true, 'with no Canon role the agent must be told nothing');

    const actor = r.store.listActors().find((a) => a.kind === 'agent')!;
    r.store.setMember(dana.id, open.id, actor.id, 'view');

    const asked = await r.call('POST', '/ask', { passport: agent.passport }, { question: 'How are generic prescriptions covered?' });
    assert.equal(asked.status, 200, `expected an answer, got ${asked.status}: ${JSON.stringify(asked.json)}`);
    assert.equal(asked.json.refused, false);
    assert.ok(asked.json.citations.length >= 1, 'the agent must get a cited answer');
    assert.ok(
      asked.json.citations.every((c: { pageId: string }) => c.pageId === visible.id),
      'nothing from a collection the agent cannot see may be cited',
    );

    // read does not imply write.
    const wrote = await r.call(
      'POST',
      '/pages',
      { passport: agent.passport },
      { collectionId: open.id, type: 'note', title: 'nope' },
    );
    assert.equal(wrote.status, 403);
  } finally {
    r.close();
  }
});

// The whole intersection, through the real endpoints. Neither the federation
// stream nor the Registry stream could write this: the first had no passport
// auth, the second had no /pages/:id/references route. It is the case
// DATA-BACKBONE.md §6 turns on — a page an agent may read, carrying a value
// from a source it may not reach — and the rule is that the reference comes
// back visibly refused rather than quietly missing, because a silently absent
// value reads as "there is no such value".
test('a reference from an unpermitted source is refused visibly, not omitted', async () => {
  const r = await rig();
  try {
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    // The `agent.denied` event this test reads names a source rather than a
    // collection, and a collection-less event reaches an operator of the Canon
    // (orgrole.ts) rather than anyone who administers a collection.
    setHandOrgRole(r.db, dana.id, 'operator', null);
    const collection = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Benefits' })).json;
    const page = (
      await r.call('POST', '/pages', { actor: dana.id }, { collectionId: collection.id, type: 'note', title: 'Plan summary' })
    ).json;

    staticConnectorOf(r.store.connectors).define('benefits', { deductible: { 'plan-gold': '$1,500' } });
    const allowed = r.store.createSource(dana.id, {
      name: 'Benefits Admin',
      kind: 'static',
      baseUrl: 'static:benefits',
      authMode: 'service',
      freshnessWindowMs: 60_000,
      collectionIds: [collection.id],
    });
    const barred = r.store.createSource(dana.id, {
      name: 'Payroll',
      kind: 'static',
      baseUrl: 'static:benefits',
      authMode: 'service',
      freshnessWindowMs: 60_000,
      collectionIds: [collection.id],
    });
    r.store.addReference(dana.id, page.id, { sourceId: allowed.id, selector: 'deductible', key: 'plan-gold', label: 'Deductible' });
    r.store.addReference(dana.id, page.id, { sourceId: barred.id, selector: 'deductible', key: 'plan-gold', label: 'Salary band' });

    const agent = r.registry.register({ name: 'Benefits Assistant' });
    r.registry.certify(agent.agentId);
    // The Registry permits the collection and ONE of the two sources.
    r.registry.setPermissions(agent.agentId, {
      permittedCollections: [collection.id],
      permittedSources: [allowed.id],
      permittedActions: ['read'],
    });
    const actor = r.store.listActors().find((a) => a.kind === 'agent');
    // First contact provisions the actor; ask once so it exists, then grant Canon's half.
    await r.call('GET', `/pages/${page.id}`, { passport: agent.passport });
    const agentActor = actor ?? r.store.listActors().find((a) => a.kind === 'agent')!;
    r.store.setMember(dana.id, collection.id, agentActor.id, 'view');

    const resolved = await r.call('GET', `/pages/${page.id}/references`, { passport: agent.passport });
    assert.equal(resolved.status, 200, `expected the page's references, got ${JSON.stringify(resolved.json)}`);
    assert.equal(resolved.json.length, 2, 'both references must be returned — refusal is data, not omission');

    const ok = resolved.json.find((x: any) => x.sourceId === allowed.id);
    const refused = resolved.json.find((x: any) => x.sourceId === barred.id);
    assert.equal(ok.value, '$1,500', 'the permitted source resolves normally');
    assert.equal(ok.error, undefined);
    assert.equal(refused.value, null, 'the barred source yields no value');
    assert.match(refused.error, /does not permit/i, 'and says why, in the reference itself');
    assert.equal(refused.sourceName, 'Payroll', 'the reader still learns which source was refused');

    // A person is unaffected: no agent scope, no refusal.
    const asPerson = await r.call('GET', `/pages/${page.id}/references`, { actor: dana.id });
    assert.equal(asPerson.json.filter((x: any) => x.error).length, 0);

    // And the denial is on the record.
    const denials = r.store.queryAudit(dana.id, { action: 'agent.denied' });
    assert.ok(
      denials.some((e) => (e.details as any).sourceId === barred.id),
      'a refused source resolution must be audited',
    );
  } finally {
    r.close();
  }
});
