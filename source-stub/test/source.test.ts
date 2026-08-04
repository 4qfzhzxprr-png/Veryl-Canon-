import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createBenefitsApi } from '../src/api.js';
import { BenefitsStore } from '../src/store.js';

const GOLD = {
  planId: 'plan-gold-2026',
  name: 'Gold PPO 2026',
  deductible: 1500,
  outOfPocketMaximum: 6000,
  genericCoinsurance: 10,
  brandCoinsurance: 30,
  effectiveDate: '2026-01-01',
};

const EXEC = {
  planId: 'plan-exec-2026',
  name: 'Executive PPO 2026',
  deductible: 250,
  outOfPocketMaximum: 2000,
  genericCoinsurance: 0,
  brandCoinsurance: 10,
  effectiveDate: '2026-01-01',
};

async function startStub() {
  const store = new BenefitsStore();
  const server = createBenefitsApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, options: { body?: unknown; asker?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.asker !== undefined) headers['X-Asker'] = options.asker;
    const res = await fetch(base + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { store, server, base, call };
}

test('stub: health, and seeding plans through the admin face', async () => {
  const { server, call } = await startStub();
  try {
    const health = await call('GET', '/health');
    assert.equal(health.json.product, 'Benefits Administration');
    assert.equal(health.json.stage, 'stub');

    const seeded = await call('POST', '/admin/plans', { body: GOLD });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.json.planId, 'plan-gold-2026');
    assert.equal(seeded.json.deductible, 1500);
    assert.ok(seeded.json.updatedAt);

    await call('POST', '/admin/plans', { body: EXEC });
    const listed = (await call('GET', '/admin/plans')).json as any[];
    assert.deepEqual(
      listed.map((p) => p.planId),
      ['plan-exec-2026', 'plan-gold-2026'],
    );

    // Seeding again replaces, so a demonstration can move a number and watch
    // the next resolution follow it.
    await call('POST', '/admin/plans', { body: { ...GOLD, deductible: 1750 } });
    assert.equal((await call('GET', '/admin/plans')).json.find((p: any) => p.planId === GOLD.planId).deductible, 1750);

    // Nonsense is refused rather than stored.
    assert.equal((await call('POST', '/admin/plans', { body: { ...GOLD, planId: '' } })).status, 400);
    assert.equal((await call('POST', '/admin/plans', { body: { ...GOLD, deductible: -1 } })).status, 400);
    assert.equal((await call('POST', '/admin/plans', { body: { ...GOLD, genericCoinsurance: 140 } })).status, 400);
    assert.equal((await call('POST', '/admin/plans', { body: { ...GOLD, effectiveDate: 'January' } })).status, 400);
  } finally {
    server.close();
  }
});

test('stub: lookup answers by key and selector, and by nothing else', async () => {
  const { server, call } = await startStub();
  try {
    await call('POST', '/admin/plans', { body: GOLD });
    await call('PUT', '/admin/entitlements/person-jo', { body: { plans: ['*'] } });

    const deductible = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' });
    assert.equal(deductible.status, 200);
    assert.deepEqual(
      { key: deductible.json.key, selector: deductible.json.selector, value: deductible.json.value, unit: deductible.json.unit },
      { key: 'plan-gold-2026', selector: 'deductible', value: 1500, unit: 'USD' },
    );
    assert.equal(deductible.json.system, 'benefits-admin');
    assert.ok(deductible.json.asOf, 'the answer carries when the source last changed the plan');

    const oop = await call('GET', '/lookup?key=plan-gold-2026&selector=outOfPocketMaximum', { asker: 'person-jo' });
    assert.deepEqual([oop.json.value, oop.json.unit], [6000, 'USD']);

    const generic = await call('GET', '/lookup?key=plan-gold-2026&selector=genericCoinsurance', { asker: 'person-jo' });
    assert.deepEqual([generic.json.value, generic.json.unit], [10, 'percent']);

    const brand = await call('GET', '/lookup?key=plan-gold-2026&selector=brandCoinsurance', { asker: 'person-jo' });
    assert.deepEqual([brand.json.value, brand.json.unit], [30, 'percent']);

    const effective = await call('GET', '/lookup?key=plan-gold-2026&selector=effectiveDate', { asker: 'person-jo' });
    assert.deepEqual([effective.json.value, effective.json.unit], ['2026-01-01', 'date']);

    // An unknown selector is a 404, never a guess and never a null.
    const bogus = await call('GET', '/lookup?key=plan-gold-2026&selector=dentalMaximum', { asker: 'person-jo' });
    assert.equal(bogus.status, 404);
    assert.equal(bogus.json.error, 'unknown_selector');
    assert.ok(bogus.json.known.includes('deductible'));

    // Key and selector are both required; there is no "give me the plan".
    assert.equal((await call('GET', '/lookup?selector=deductible', { asker: 'person-jo' })).status, 400);
    assert.equal((await call('GET', '/lookup?key=plan-gold-2026', { asker: 'person-jo' })).status, 400);

    // And there is no search. You cannot rank what you cannot enumerate.
    const search = await call('GET', '/search?q=deductible', { asker: 'person-jo' });
    assert.equal(search.status, 501);
    assert.equal(search.json.error, 'not_supported');
  } finally {
    server.close();
  }
});

test('stub: an unknown key is a refusal, not an empty value', async () => {
  const { server, call } = await startStub();
  try {
    await call('PUT', '/admin/entitlements/person-jo', { body: { plans: ['*'] } });
    const missing = await call('GET', '/lookup?key=plan-does-not-exist&selector=deductible', { asker: 'person-jo' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'unknown_plan');
    assert.equal(missing.json.value, undefined, 'a 404 carries no value at all');
  } finally {
    server.close();
  }
});

test('stub: entitlements are enforced per caller', async () => {
  const { server, call } = await startStub();
  try {
    await call('POST', '/admin/plans', { body: GOLD });
    await call('POST', '/admin/plans', { body: EXEC });
    await call('PUT', '/admin/entitlements/person-jo', { body: { plans: ['plan-gold-2026'] } });
    await call('PUT', '/admin/entitlements/person-ada', { body: { plans: ['plan-gold-2026', 'plan-exec-2026'] } });

    // Jo may see the standard plan.
    const jo = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' });
    assert.equal(jo.status, 200);
    assert.equal(jo.json.value, 1500);

    // Jo may not see the executive plan, whoever is asking on Jo's behalf.
    const denied = await call('GET', '/lookup?key=plan-exec-2026&selector=deductible', { asker: 'person-jo' });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'not_entitled');
    assert.equal(denied.json.value, undefined);

    // Ada may.
    const ada = await call('GET', '/lookup?key=plan-exec-2026&selector=deductible', { asker: 'person-ada' });
    assert.deepEqual([ada.status, ada.json.value], [200, 250]);

    // A caller nobody granted anything to sees nothing, existing or not — the
    // 403 lands before existence is checked, so 403s cannot map the catalogue.
    const stranger = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-nobody' });
    assert.equal(stranger.status, 403);
    const phantom = await call('GET', '/lookup?key=plan-not-real&selector=deductible', { asker: 'person-nobody' });
    assert.equal(phantom.status, 403);

    // Anonymous callers are refused outright: this system answers no one it
    // cannot name, which is what makes per-asker resolution meaningful.
    const anon = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error, 'no_asker');
    const blank = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: '   ' });
    assert.equal(blank.status, 401);

    // The admin face reports what it granted; grants replace, they do not merge.
    await call('PUT', '/admin/entitlements/person-jo', { body: { plans: ['plan-exec-2026'] } });
    const grants = (await call('GET', '/admin/entitlements')).json as any[];
    assert.deepEqual(
      grants.map((g) => [g.asker, g.plans]),
      [
        ['person-ada', ['plan-exec-2026', 'plan-gold-2026']],
        ['person-jo', ['plan-exec-2026']],
      ],
    );
    assert.equal((await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' })).status, 403);

    assert.equal((await call('PUT', '/admin/entitlements/person-jo', { body: { plans: 'everything' } })).status, 400);
  } finally {
    server.close();
  }
});

test('stub: the failure modes can be switched on and off', async () => {
  const { server, call } = await startStub();
  try {
    await call('POST', '/admin/plans', { body: GOLD });
    await call('PUT', '/admin/entitlements/person-jo', { body: { plans: ['*'] } });
    assert.deepEqual((await call('GET', '/admin/behaviour')).json, { delayMs: 0, failStatus: null });

    // Broken: every lookup fails, entitled or not.
    await call('PUT', '/admin/behaviour', { body: { failStatus: 500 } });
    const broken = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' });
    assert.equal(broken.status, 500);
    assert.equal(broken.json.error, 'source_failure');
    assert.equal(broken.json.injected, true);
    assert.equal(broken.json.value, undefined);
    // Health still answers, so a monitor can tell "slow" from "gone".
    assert.equal((await call('GET', '/health')).status, 200);

    await call('PUT', '/admin/behaviour', { body: { failStatus: null } });
    assert.equal((await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' })).status, 200);

    // Slow: the lookup takes at least the configured delay.
    await call('PUT', '/admin/behaviour', { body: { delayMs: 120 } });
    const started = Date.now();
    const slow = await call('GET', '/lookup?key=plan-gold-2026&selector=deductible', { asker: 'person-jo' });
    assert.equal(slow.status, 200);
    assert.ok(Date.now() - started >= 110, 'the injected delay actually delayed the answer');

    await call('PUT', '/admin/behaviour', { body: { delayMs: 0 } });
    assert.deepEqual((await call('GET', '/admin/behaviour')).json, { delayMs: 0, failStatus: null });

    assert.equal((await call('PUT', '/admin/behaviour', { body: { delayMs: -5 } })).status, 400);
    assert.equal((await call('PUT', '/admin/behaviour', { body: { failStatus: 200 } })).status, 400);
  } finally {
    server.close();
  }
});
