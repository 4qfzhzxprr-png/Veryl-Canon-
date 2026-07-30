import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createRegistryApi } from '../src/api.js';
import { RegistryStore } from '../src/store.js';

async function startStub() {
  const server = createRegistryApi(new RegistryStore());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { server, base, call };
}

test('stub: registration issues a passport but not standing', async () => {
  const { server, call } = await startStub();
  try {
    const health = await call('GET', '/health');
    assert.equal(health.json.product, 'Veryl Agent Registry');
    assert.equal(health.json.stage, 'stub');

    const bot = (
      await call('POST', '/agents', {
        name: 'PolicyBot',
        permittedCollections: ['col-1'],
        permittedActions: ['read', 'comment'],
      })
    ).json;
    assert.match(bot.passport, /^vap_[0-9a-f]{48}$/);
    assert.equal(bot.certification.state, 'pending');
    assert.deepEqual(bot.permittedCollections, ['col-1']);

    // Identity is not standing: a pending agent verifies as lapsed.
    const denied = await call('POST', '/verify', { passport: bot.passport });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'certification_lapsed');

    // Bad registrations are refused.
    assert.equal((await call('POST', '/agents', { name: '' })).status, 400);
    assert.equal((await call('POST', '/agents', { name: 'X', permittedActions: ['fly'] })).status, 400);
  } finally {
    server.close();
  }
});

test('stub: certify, verify, change limits, expire', async () => {
  const { server, call } = await startStub();
  try {
    const bot = (
      await call('POST', '/agents', { name: 'PolicyBot', permittedCollections: ['col-1'], permittedActions: ['read'] })
    ).json;

    const certified = (await call('POST', `/agents/${bot.agentId}/certify`, {})).json;
    assert.equal(certified.certification.state, 'certified');
    assert.equal(certified.passport, undefined); // the passport appears once, at registration

    const ok = await call('POST', '/verify', { passport: bot.passport });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.certified, true);
    assert.equal(ok.json.agentId, bot.agentId);
    assert.equal(ok.json.name, 'PolicyBot');
    assert.deepEqual(ok.json.permittedCollections, ['col-1']);
    assert.deepEqual(ok.json.permittedActions, ['read']);
    assert.equal(ok.json.recheckAfterSeconds, 60);

    // Limits changes arrive in the next verification.
    await call('PUT', `/agents/${bot.agentId}/permissions`, { permittedCollections: ['*'], permittedActions: ['read', 'write'] });
    const widened = (await call('POST', '/verify', { passport: bot.passport })).json;
    assert.deepEqual(widened.permittedCollections, ['*']);
    assert.deepEqual(widened.permittedActions, ['read', 'write']);

    // Certification with a past expiry verifies as lapsed.
    const brief = (await call('POST', '/agents', { name: 'BriefBot' })).json;
    await call('POST', `/agents/${brief.agentId}/certify`, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const lapsed = await call('POST', '/verify', { passport: brief.passport });
    assert.equal(lapsed.status, 403);
    assert.equal(lapsed.json.error, 'certification_lapsed');
  } finally {
    server.close();
  }
});

test('stub: revocation is a distinct, terminal refusal', async () => {
  const { server, call } = await startStub();
  try {
    const bot = (await call('POST', '/agents', { name: 'PolicyBot' })).json;
    await call('POST', `/agents/${bot.agentId}/certify`, {});
    assert.equal((await call('POST', '/verify', { passport: bot.passport })).status, 200);

    const revoked = (await call('POST', `/agents/${bot.agentId}/revoke`, { reason: 'Incident review' })).json;
    assert.equal(revoked.certification.state, 'revoked');
    assert.equal(revoked.certification.reason, 'Incident review');

    const denied = await call('POST', '/verify', { passport: bot.passport });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'revoked');
    assert.equal(denied.json.revokedAt, revoked.certification.revokedAt);

    // Terminal: no re-certification, and revoking again keeps the first timestamp.
    assert.equal((await call('POST', `/agents/${bot.agentId}/certify`, {})).status, 409);
    const again = (await call('POST', `/agents/${bot.agentId}/revoke`, {})).json;
    assert.equal(again.certification.revokedAt, revoked.certification.revokedAt);
  } finally {
    server.close();
  }
});

test('stub: verification errors and the admin listing', async () => {
  const { server, call } = await startStub();
  try {
    const unknown = await call('POST', '/verify', { passport: 'vap_nobody' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'unknown_passport');

    assert.equal((await call('POST', '/verify', {})).status, 400);
    assert.equal((await call('POST', `/agents/no-such-id/certify`, {})).status, 404);

    const a = (await call('POST', '/agents', { name: 'A' })).json;
    const b = (await call('POST', '/agents', { name: 'B' })).json;
    await call('POST', `/agents/${a.agentId}/certify`, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await call('POST', `/agents/${b.agentId}/revoke`, {});

    const listing = (await call('GET', '/agents')).json as any[];
    assert.equal(listing.length, 2);
    const states = new Map(listing.map((agent) => [agent.name, agent.certification.state]));
    assert.equal(states.get('A'), 'lapsed'); // effective state, derived from expiry
    assert.equal(states.get('B'), 'revoked');
    for (const agent of listing) assert.equal(agent.passport, undefined); // never listed
  } finally {
    server.close();
  }
});
