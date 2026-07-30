// Canon's RegistryClient exercised against the stub in-process: the same
// pairing Epic D's M3 demonstration runs against a live Registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRegistryApi } from '../src/api.js';
import { RegistryStore } from '../src/store.js';
import { RegistryClient, REVOCATION_GUARANTEE_MS } from '../../server/src/registry.js';

async function startStub() {
  const store = new RegistryStore();
  const server = createRegistryApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, server, baseUrl };
}

test('client: issue then verify carries identity and limits', async () => {
  const { store, server, baseUrl } = await startStub();
  try {
    const bot = store.register({ name: 'PolicyBot', permittedCollections: ['col-1'], permittedActions: ['read', 'comment'] });
    store.certify(bot.agentId);

    const client = new RegistryClient({ baseUrl });
    const result = await client.verifyPassport(bot.passport);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.agent.agentId, bot.agentId);
      assert.equal(result.agent.name, 'PolicyBot');
      assert.equal(result.agent.certified, true);
      assert.deepEqual(result.agent.permittedCollections, ['col-1']);
      assert.deepEqual(result.agent.permittedActions, ['read', 'comment']);
      assert.equal(result.cached, false);
    }

    const unknown = await client.verifyPassport('vap_nobody');
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.reason], [false, 'unknown_passport']);

    const empty = await client.verifyPassport('');
    assert.deepEqual([empty.ok, !empty.ok && empty.reason], [false, 'unknown_passport']);

    const pending = store.register({ name: 'PendingBot' });
    const lapsed = await client.verifyPassport(pending.passport);
    assert.deepEqual([lapsed.ok, !lapsed.ok && lapsed.reason], [false, 'certification_lapsed']);
  } finally {
    server.close();
  }
});

test('client: revocation takes effect within the cache TTL', async () => {
  const { store, server, baseUrl } = await startStub();
  try {
    const ttlMs = 100; // a short TTL injected for the test; production caps at 60s
    const client = new RegistryClient({ baseUrl, cacheTtlMs: ttlMs });
    const bot = store.register({ name: 'PolicyBot' });
    store.certify(bot.agentId);

    assert.equal((await client.verifyPassport(bot.passport)).ok, true);

    store.revoke(bot.agentId, { reason: 'demonstrated live' });
    const revokedAt = Date.now();

    // Inside the window the cached answer may still allow — that is the
    // window the contract grants (at most one minute; here 100ms).
    const inWindow = await client.verifyPassport(bot.passport);
    assert.equal(inWindow.ok && inWindow.cached, true);

    await sleep(ttlMs + 20);
    const after = await client.verifyPassport(bot.passport);
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.reason, 'revoked');
    assert.ok(Date.now() - revokedAt < REVOCATION_GUARANTEE_MS, 'cutoff landed well inside the one-minute guarantee');
  } finally {
    server.close();
  }
});

test('client: caches within the TTL, re-asks after it expires', async () => {
  const { store, server, baseUrl } = await startStub();
  try {
    let upstreamCalls = 0;
    const counting: typeof fetch = (input, init) => {
      upstreamCalls += 1;
      return fetch(input, init);
    };
    const client = new RegistryClient({ baseUrl, cacheTtlMs: 80, fetchImpl: counting });
    const bot = store.register({ name: 'PolicyBot' });
    store.certify(bot.agentId);

    const first = await client.verifyPassport(bot.passport);
    const second = await client.verifyPassport(bot.passport);
    assert.equal(upstreamCalls, 1);
    assert.equal(first.ok && !first.cached, true);
    assert.equal(second.ok && second.cached, true);

    await sleep(100);
    const third = await client.verifyPassport(bot.passport);
    assert.equal(upstreamCalls, 2);
    assert.equal(third.ok && !third.cached, true);

    // invalidate() drops the cache without waiting for expiry.
    client.invalidate(bot.passport);
    await client.verifyPassport(bot.passport);
    assert.equal(upstreamCalls, 3);

    // The TTL is clamped to the one-minute guarantee, whatever is asked for.
    const eager = new RegistryClient({ baseUrl, cacheTtlMs: 10 * 60 * 1000 });
    assert.equal(eager.cacheTtlMs, REVOCATION_GUARANTEE_MS);
  } finally {
    server.close();
  }
});

test('client: fails closed when the Registry is down', async () => {
  const { store, server, baseUrl } = await startStub();
  const bot = store.register({ name: 'PolicyBot' });
  store.certify(bot.agentId);

  const client = new RegistryClient({ baseUrl, cacheTtlMs: 50, requestTimeoutMs: 500 });
  const ok = await client.verifyPassport(bot.passport);
  assert.equal(ok.ok, true);

  // Stop the Registry and let the cached answer expire: no stale allowance.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sleep(70);
  const down = await client.verifyPassport(bot.passport);
  assert.equal(down.ok, false);
  if (!down.ok) assert.equal(down.reason, 'registry_unreachable');

  // A passport never seen before gets the same refusal, and the refusal is
  // not cached: nothing about an outage is remembered as an answer.
  const fresh = await client.verifyPassport('vap_never_seen');
  assert.equal(!fresh.ok && fresh.reason, 'registry_unreachable');
});
