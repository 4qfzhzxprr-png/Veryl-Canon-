// Canon's HttpConnector exercised against the benefits stub in-process: the
// same pairing a deployment runs against a live record system, and the same
// arrangement registry-stub uses for Canon's RegistryClient.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBenefitsApi } from '../src/api.js';
import { BenefitsStore } from '../src/store.js';
import {
  ConnectorError,
  ConnectorSource,
  HttpConnector,
  isConnectorError,
} from '../../server/src/httpconnector.js';
import { OutboundTransport, pinnedHttpRequest } from '../../server/src/pinnedhttp.js';

// The stub listens on 127.0.0.1, and Canon's outbound policy
// (server/src/outbound.ts) blocks loopback and permits no host at all until a
// deployment names one. That default is the point of the policy, so it is not
// bypassed here: this file sets the development opt-in explicitly, in the two
// environment variables a developer would set, before any connector is built.
// The connector under test is the real one, and so is the policy it enforces.
process.env.CANON_SOURCE_ALLOWED_HOSTS = '127.0.0.1 localhost';
process.env.CANON_SOURCE_ALLOW_PRIVATE = 'true';

// The connector takes the core's Asker object (server/src/connectors.ts), so
// tests name a person the same way Canon's reference layer does.
const asker = (actorId: string) => ({ actorId, kind: 'person' as const, name: actorId, email: null, registryRef: null });

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

function sourceFor(baseUrl: string, authMode: 'per_asker' | 'service' = 'per_asker'): ConnectorSource {
  return {
    id: 'src-benefits',
    name: 'Benefits Admin',
    kind: 'benefits-admin',
    baseUrl,
    authMode,
    freshnessWindowMs: 24 * 60 * 60 * 1000,
  };
}

async function startStub() {
  const store = new BenefitsStore();
  const server = createBenefitsApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store.seedPlan(GOLD);
  store.seedPlan(EXEC);
  store.setEntitlements('person-jo', { plans: ['plan-gold-2026'] });
  store.setEntitlements('person-ada', { plans: ['*'] });
  store.setEntitlements('svc-canon', { plans: ['plan-gold-2026'] });
  return { store, server, baseUrl, source: sourceFor(baseUrl) };
}

// Every assertion about failure goes through this, so "the connector threw"
// and "the connector returned nothing usable" can never be confused.
async function expectFailure(promise: Promise<unknown>): Promise<ConnectorError> {
  let settled: unknown;
  try {
    settled = await promise;
  } catch (err) {
    assert.ok(isConnectorError(err), `expected a ConnectorError, got ${String(err)}`);
    return err as ConnectorError;
  }
  assert.fail(`expected a failure, but the connector produced a value: ${JSON.stringify(settled)}`);
}

test('connector: resolves a reference by key and selector', async () => {
  const { server, source } = await startStub();
  try {
    const connector = new HttpConnector();
    assert.equal(connector.name, 'http-lookup-v1');

    const before = Date.now();
    const resolved = await connector.resolve(source, {
      selector: 'deductible',
      key: 'plan-gold-2026',
      asker: asker('person-jo'),
    });
    assert.equal(resolved.value, 1500);
    assert.ok(Date.parse(resolved.resolvedAt) >= before, 'resolvedAt is when Canon resolved it');
    // Exactly the documented shape, and nothing smuggled alongside it.
    assert.deepEqual(Object.keys(resolved).sort(), ['resolvedAt', 'value']);

    // Every selector the page might reference, including a non-numeric one.
    const date = await connector.resolve(source, {
      selector: 'effectiveDate',
      key: 'plan-gold-2026',
      asker: asker('person-jo'),
    });
    assert.equal(date.value, '2026-01-01');
    const coins = await connector.resolve(source, {
      selector: 'brandCoinsurance',
      key: 'plan-gold-2026',
      asker: asker('person-jo'),
    });
    assert.equal(coins.value, 30);
  } finally {
    server.close();
  }
});

test('connector: the asker reaches the source, and the source enforces it', async () => {
  const { server, source, baseUrl } = await startStub();
  try {
    const connector = new HttpConnector();

    // Ada is entitled to both plans; Jo only to the standard one. Same
    // reference, same Canon, different reader — different answer, decided by
    // the source rather than by Canon. This is what "Canon does not launder
    // permissions" means, executed.
    const ada = await connector.resolve(source, {
      selector: 'deductible',
      key: 'plan-exec-2026',
      asker: asker('person-ada'),
    });
    assert.equal(ada.value, 250);

    const jo = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-exec-2026', asker: asker('person-jo') }),
    );
    assert.equal(jo.code, 'forbidden');

    // And the identity really is on the wire, under the header the source
    // reads. The seam is the outbound transport rather than fetch, because
    // Canon no longer uses fetch for a source request: it resolves the name
    // itself and connects to the address it checked (server/src/pinnedhttp.ts).
    const seen: string[] = [];
    const watching: OutboundTransport = (request) => {
      const asker = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-asker')?.[1];
      seen.push(asker ?? '(none)');
      return pinnedHttpRequest(request);
    };
    const watcher = new HttpConnector({ transport: watching });
    await watcher.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') });
    assert.deepEqual(seen, ['person-jo']);

    // A `service` source presents the deployment's configured identity
    // instead — and is bounded by what that identity may see, which is why
    // service resolution is a decision to publish a value, not a way around
    // the source's access model.
    const serviceSource = sourceFor(baseUrl, 'service');
    const asService = new HttpConnector({ serviceIdentity: 'svc-canon', transport: watching });
    seen.length = 0;
    const value = await asService.resolve(serviceSource, {
      selector: 'deductible',
      key: 'plan-gold-2026',
      asker: asker('person-jo'),
    });
    assert.deepEqual([value.value, seen], [1500, ['svc-canon']]);

    const beyondService = await expectFailure(
      asService.resolve(serviceSource, { selector: 'deductible', key: 'plan-exec-2026', asker: asker('person-ada') }),
    );
    assert.equal(beyondService.code, 'forbidden');
  } finally {
    server.close();
  }
});

test('connector: a refusal is a real answer, and is not retried', async () => {
  const { server, source } = await startStub();
  try {
    const connector = new HttpConnector();

    const forbidden = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-exec-2026', asker: asker('person-jo') }),
    );
    assert.deepEqual(
      [forbidden.kind, forbidden.code, forbidden.status, forbidden.retryable],
      ['refused', 'forbidden', 403, false],
    );
    assert.deepEqual([forbidden.sourceId, forbidden.selector, forbidden.key], ['src-benefits', 'deductible', 'plan-exec-2026']);

    const unknownKey = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-imaginary', asker: asker('person-ada') }),
    );
    assert.deepEqual([unknownKey.kind, unknownKey.code, unknownKey.retryable], ['refused', 'not_found', false]);

    const unknownSelector = await expectFailure(
      connector.resolve(source, { selector: 'dentalMaximum', key: 'plan-gold-2026', asker: asker('person-ada') }),
    );
    assert.deepEqual([unknownSelector.kind, unknownSelector.code], ['refused', 'not_found']);
  } finally {
    server.close();
  }
});

test('connector: a slow source times out as no answer', async () => {
  const { store, server, source } = await startStub();
  try {
    store.setBehaviour({ delayMs: 400 });
    const connector = new HttpConnector({ requestTimeoutMs: 60 });

    const started = Date.now();
    const failed = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') }),
    );
    assert.deepEqual([failed.kind, failed.code, failed.retryable], ['unanswered', 'timeout', true]);
    assert.ok(Date.now() - started < 350, 'the connector gave up rather than waiting on the source');

    // Recovery is immediate; nothing about the outage was remembered.
    store.setBehaviour({ delayMs: 0 });
    const recovered = await connector.resolve(source, {
      selector: 'deductible',
      key: 'plan-gold-2026',
      asker: asker('person-jo'),
    });
    assert.equal(recovered.value, 1500);
  } finally {
    server.close();
  }
});

test('connector: a broken or unreachable source is no answer, never a value', async () => {
  const { store, server, source } = await startStub();
  const connector = new HttpConnector({ requestTimeoutMs: 500 });
  try {
    store.setBehaviour({ failStatus: 500 });
    const broken = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') }),
    );
    assert.deepEqual([broken.kind, broken.code, broken.status, broken.retryable], ['unanswered', 'source_error', 500, true]);

    store.setBehaviour({ failStatus: 503 });
    const unavailable = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') }),
    );
    assert.deepEqual([unavailable.kind, unavailable.code, unavailable.status], ['unanswered', 'source_error', 503]);

    store.setBehaviour({ failStatus: null });
    assert.equal(
      (await connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') })).value,
      1500,
    );
  } finally {
    server.close();
  }

  // With the source gone entirely, the same discipline holds.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const down = await expectFailure(
    connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') }),
  );
  assert.deepEqual([down.kind, down.code, down.retryable], ['unanswered', 'unreachable', true]);
});

test('connector: an answer it cannot trust is no answer', async () => {
  // A hostile source: whatever it is doing, none of it may become a value.
  let reply: { status: number; body: string; contentType?: string } = { status: 200, body: '{}' };
  const rogue: Server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => rogue.listen(0, resolve));
  const source = sourceFor(`http://127.0.0.1:${(rogue.address() as AddressInfo).port}`);
  const connector = new HttpConnector();
  const request = { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') };

  try {
    reply = { status: 200, body: '<html>maintenance</html>', contentType: 'text/html' };
    const notJson = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([notJson.kind, notJson.code], ['unanswered', 'unparseable']);

    reply = { status: 200, body: JSON.stringify({ key: 'plan-gold-2026', selector: 'deductible' }) };
    const noValue = await expectFailure(connector.resolve(source, request));
    assert.equal(noValue.code, 'unparseable');

    reply = { status: 200, body: JSON.stringify({ value: null }) };
    const nullValue = await expectFailure(connector.resolve(source, request));
    assert.equal(nullValue.code, 'unparseable', 'null is not a value; it is the absence of one');

    reply = { status: 200, body: JSON.stringify({ value: { amount: 1500 } }) };
    const objectValue = await expectFailure(connector.resolve(source, request));
    assert.equal(objectValue.code, 'unparseable');

    // Answered, but about another plan: accepting this is how a reader is
    // shown someone else's deductible.
    reply = { status: 200, body: JSON.stringify({ key: 'plan-exec-2026', selector: 'deductible', value: 250 }) };
    const wrongKey = await expectFailure(connector.resolve(source, request));
    assert.equal(wrongKey.code, 'unparseable');

    reply = { status: 200, body: JSON.stringify({ key: 'plan-gold-2026', selector: 'brandCoinsurance', value: 30 }) };
    const wrongSelector = await expectFailure(connector.resolve(source, request));
    assert.equal(wrongSelector.code, 'unparseable');

    // 401 is Canon's problem, not an answer about the value.
    reply = { status: 401, body: JSON.stringify({ error: 'no_asker', message: 'name the caller' }) };
    const anon = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([anon.kind, anon.code, anon.retryable], ['unanswered', 'unauthenticated', true]);

    // An unclassifiable status is no answer either — including the 501 a
    // record system returns when asked to search.
    reply = { status: 501, body: JSON.stringify({ error: 'not_supported', message: 'no search here' }) };
    const unsupported = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([unsupported.kind, unsupported.code], ['unanswered', 'source_error']);

    // A refusal that is not even JSON is still classified by its status.
    reply = { status: 403, body: 'nope', contentType: 'text/plain' };
    const refused = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([refused.kind, refused.code], ['refused', 'forbidden']);

    // Finally: the one shape it does accept.
    reply = { status: 200, body: JSON.stringify({ key: 'plan-gold-2026', selector: 'deductible', value: 1500 }) };
    assert.equal((await connector.resolve(source, request)).value, 1500);
  } finally {
    rogue.close();
  }
});

test('connector: it refuses to ask a question it cannot ask honestly', async () => {
  const { server, source, baseUrl } = await startStub();
  try {
    const connector = new HttpConnector();

    // No asker for a per-asker source: resolving anonymously here is exactly
    // the permission laundering the design forbids, so it does not happen.
    const anonymous = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('  ') }),
    );
    assert.deepEqual([anonymous.kind, anonymous.code], ['unanswered', 'misconfigured']);

    // A service source with no configured service identity.
    const serviceSource = sourceFor(baseUrl, 'service');
    const unconfigured = await expectFailure(
      connector.resolve(serviceSource, { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') }),
    );
    assert.equal(unconfigured.code, 'misconfigured');

    const noKey = await expectFailure(
      connector.resolve(source, { selector: 'deductible', key: '', asker: asker('person-jo') }),
    );
    assert.equal(noKey.code, 'misconfigured');

    const noSelector = await expectFailure(
      connector.resolve(source, { selector: '', key: 'plan-gold-2026', asker: asker('person-jo') }),
    );
    assert.equal(noSelector.code, 'misconfigured');

    const badBase = await expectFailure(
      connector.resolve({ ...source, baseUrl: 'not a url' }, {
        selector: 'deductible',
        key: 'plan-gold-2026',
        asker: asker('person-jo'),
      }),
    );
    assert.equal(badBase.code, 'misconfigured');

    // A misconfigured connector never reaches the source at all.
    let calls = 0;
    const counting: OutboundTransport = (request) => {
      calls += 1;
      return pinnedHttpRequest(request);
    };
    const silent = new HttpConnector({ transport: counting });
    await expectFailure(silent.resolve(source, { selector: 'deductible', key: '', asker: asker('person-jo') }));
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

test('connector: no failure mode ever yields a value', async () => {
  // The property stated once, over every way this can go wrong at once. If a
  // default, a fallback or a cached guess is ever introduced, this fails.
  const { store, server, source, baseUrl } = await startStub();
  const connector = new HttpConnector({ requestTimeoutMs: 60 });
  const request = { selector: 'deductible', key: 'plan-gold-2026', asker: asker('person-jo') };
  try {
    const scenarios: [string, () => Promise<unknown>][] = [
      ['not entitled', () => connector.resolve(source, { ...request, key: 'plan-exec-2026' })],
      ['unknown key', () => connector.resolve(source, { ...request, key: 'plan-imaginary', asker: asker('person-ada') })],
      ['unknown selector', () => connector.resolve(source, { ...request, selector: 'dentalMaximum', asker: asker('person-ada') })],
      ['no asker', () => connector.resolve(source, { ...request, asker: null })],
      ['no service identity', () => connector.resolve(sourceFor(baseUrl, 'service'), request)],
      [
        'source broken',
        async () => {
          store.setBehaviour({ failStatus: 500 });
          try {
            return await connector.resolve(source, request);
          } finally {
            store.setBehaviour({ failStatus: null });
          }
        },
      ],
      [
        'source slow',
        async () => {
          store.setBehaviour({ delayMs: 300 });
          try {
            return await connector.resolve(source, request);
          } finally {
            store.setBehaviour({ delayMs: 0 });
          }
        },
      ],
      ['source absent', () => connector.resolve({ ...source, baseUrl: 'http://127.0.0.1:1' }, request)],
    ];

    for (const [name, run] of scenarios) {
      let produced: unknown;
      let threw = false;
      try {
        produced = await run();
      } catch (err) {
        threw = true;
        assert.ok(isConnectorError(err), `${name}: expected a ConnectorError`);
      }
      assert.ok(threw, `${name}: the connector produced ${JSON.stringify(produced)} instead of failing`);
    }
  } finally {
    server.close();
  }
});
