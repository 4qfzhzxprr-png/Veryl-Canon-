import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBenefitsApi } from '../../source-stub/src/api.js';
import { BenefitsStore } from '../../source-stub/src/store.js';
import { openDb } from '../src/db.js';
import { ConnectorError, HttpConnector } from '../src/httpconnector.js';
import { CanonStore } from '../src/store.js';
import {
  AddressResolver,
  ResolvedAddress,
  canonicalAddress,
  outboundPolicyFromEnv,
  resetDefaultOutboundPolicy,
  resolveOutboundTarget,
} from '../src/outbound.js';
import { OutboundRequest, OutboundResponse, OutboundTransport } from '../src/pinnedhttp.js';
import type { NotificationTransport } from '../src/notify.js';
import { CERT_PEM, KEY_PEM } from './tlspin-cert.js';

// SECURITY.md F1, the half the M4 review could not close: the address policy
// checked DNS but did not PIN it, so a name could answer with a public address
// when Canon looked and a private one microseconds later when Canon connected.
//
// The fix is `outbound.ts`'s `resolveOutboundTarget` (resolve once, judge what
// you resolved) plus `pinnedhttp.ts` (connect with a `lookup` that returns
// only what was judged). This file is the evidence. A rebinding fix that is
// not tested against actual rebinding is a claim rather than a fix, so the
// resolver is a seam here and every test drives it deliberately.

const quiet: NotificationTransport = { deliver() {} };

// This suite reaches loopback, which the shipped default forbids. It sets the
// development opt-in the same way a developer would rather than bypassing the
// policy, and it is set before anything reads it.
process.env.CANON_SOURCE_ALLOWED_HOSTS = '127.0.0.1 localhost rebind.test';
process.env.CANON_SOURCE_ALLOW_PRIVATE = 'true';
resetDefaultOutboundPolicy();

function policy(env: Record<string, string>) {
  return outboundPolicyFromEnv(env as NodeJS.ProcessEnv);
}

/** The harness the finding calls for: one answer, then a different one. */
function scriptedResolver(answers: readonly (readonly ResolvedAddress[])[]): {
  resolve: AddressResolver;
  calls: () => number;
  hostnames: () => readonly string[];
} {
  let calls = 0;
  const hostnames: string[] = [];
  return {
    calls: () => calls,
    hostnames: () => hostnames,
    resolve: async (hostname) => {
      hostnames.push(hostname);
      const answer = answers[Math.min(calls, answers.length - 1)] ?? [];
      calls += 1;
      return [...answer];
    },
  };
}

const v4 = (address: string): ResolvedAddress[] => [{ address, family: 4 }];

/** A source shape the connector accepts; only the fields it reads. */
const sourceAt = (baseUrl: string) => ({
  id: 'src-1',
  name: 'Benefits Admin',
  kind: 'http',
  baseUrl,
  authMode: 'service' as const,
  freshnessWindowMs: 0,
});

async function listen(server: Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function expectFailure(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    const value = await promise;
    assert.fail(`expected a failure, but the connector produced ${JSON.stringify(value)}`);
  } catch (err) {
    assert.ok(err instanceof ConnectorError, `expected a ConnectorError, got ${String(err)}`);
    return err;
  }
}

// ---------------------------------------------------------------------------
// The pin itself, over a real socket.

test('pin: the socket lands on the address that was validated, and a later answer never reaches it', async () => {
  // Two real servers, same port, different loopback addresses, different
  // values. Which value comes back is therefore proof of which address the
  // socket connected to — no inference required.
  const first = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'PLAN-7', selector: 'deductible', value: 1500 }));
  });
  const second = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'PLAN-7', selector: 'deductible', value: 9999 }));
  });
  const port = await listen(first, '127.0.0.1');
  await listen(second, '127.0.0.2', port);

  // The rebinding answer: 127.0.0.1 the first time it is asked, 127.0.0.2
  // every time after. Under the old code the socket re-resolved and could
  // have taken either; under the pin it takes what this request checked.
  const resolver = scriptedResolver([v4('127.0.0.1'), v4('127.0.0.2')]);
  const dialled: string[] = [];
  const watching: OutboundTransport = async (request) => {
    dialled.push(request.address);
    const { pinnedHttpRequest } = await import('../src/pinnedhttp.js');
    const answer = await pinnedHttpRequest(request);
    // What the socket reports, not what we asked for.
    assert.equal(canonicalAddress(answer.peerAddress ?? ''), canonicalAddress(request.address));
    return answer;
  };

  try {
    const connector = new HttpConnector({
      outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'rebind.test', CANON_SOURCE_ALLOW_PRIVATE: 'true' }),
      serviceIdentity: 'svc-canon',
      requestTimeoutMs: 2000,
      resolver: resolver.resolve,
      transport: watching,
    });
    const source = sourceAt(`http://rebind.test:${port}`);
    const request = { selector: 'deductible', key: 'PLAN-7', asker: null };

    const one = await connector.resolve(source, request);
    assert.equal(one.value, 1500, 'the connection went to the address this request validated');
    assert.equal(resolver.calls(), 1, 'the name was resolved exactly once: there is no second lookup to poison');
    assert.deepEqual(dialled, ['127.0.0.1']);

    // A second request resolves again — the pin is per request, not a cache —
    // and lands on that request's own answer.
    const two = await connector.resolve(source, request);
    assert.equal(two.value, 9999, 'the second request validated 127.0.0.2 and went there');
    assert.equal(resolver.calls(), 2);
    assert.deepEqual(dialled, ['127.0.0.1', '127.0.0.2']);
    assert.deepEqual(resolver.hostnames(), ['rebind.test', 'rebind.test']);
  } finally {
    first.close();
    second.close();
  }
});

test('pin: a rebinding answer that the policy blocks is refused, and nothing is dialled', async () => {
  // Permitted first, blocked second — the attack, exactly. The first request
  // goes through; the second is refused before a socket exists.
  const resolver = scriptedResolver([v4('198.51.100.10'), v4('169.254.169.254')]);
  let dials = 0;
  const transport: OutboundTransport = async (request) => {
    dials += 1;
    assert.equal(request.address, '198.51.100.10', 'only the checked address is ever dialled');
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ key: 'PLAN-7', selector: 'deductible', value: 1500 }),
      peerAddress: request.address,
    };
  };
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: resolver.resolve,
    transport,
  });
  const source = sourceAt('http://benefits.example');
  const request = { selector: 'deductible', key: 'PLAN-7', asker: null };

  assert.equal((await connector.resolve(source, request)).value, 1500);
  assert.equal(dials, 1);

  const refused = await expectFailure(connector.resolve(source, request));
  assert.equal(refused.code, 'not_permitted');
  assert.equal(refused.kind, 'unanswered');
  assert.match(refused.message, /resolves to 169\.254\.169\.254/);
  assert.equal(dials, 1, 'the second request never reached a socket');
});

test('pin: every address a host answers with is judged, not just the one that gets used', async () => {
  const resolver = scriptedResolver([[
    { address: '198.51.100.10', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ]]);
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: resolver.resolve,
    transport: () => assert.fail('a host with a blocked address among its answers must not be dialled'),
  });
  const failed = await expectFailure(
    connector.resolve(sourceAt('http://benefits.example'), { selector: 'deductible', key: 'PLAN-7', asker: null }),
  );
  assert.equal(failed.code, 'not_permitted');
  assert.match(failed.message, /resolves to 10\.0\.0\.5/);
});

test('pin: a resolver answering with a name rather than an address is refused', async () => {
  // A pin built from a name is not a pin: the socket would resolve it itself.
  const resolver = scriptedResolver([[{ address: 'inside.corp', family: 4 }]]);
  await assert.rejects(
    resolveOutboundTarget(
      new URL('http://benefits.example/lookup'),
      policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
      resolver.resolve,
    ),
    /is not an address/,
  );
});

test('pin: an IP-literal baseUrl needs no resolver and consults none', async () => {
  const resolver = scriptedResolver([v4('169.254.169.254')]);
  const target = await resolveOutboundTarget(
    new URL('https://198.51.100.10/lookup'),
    policy({ CANON_SOURCE_ALLOWED_HOSTS: '198.51.100.10' }),
    resolver.resolve,
  );
  assert.deepEqual([...target.addresses], [{ address: '198.51.100.10', family: 4 }]);
  assert.equal(resolver.calls(), 0);
  assert.equal(target.port, 443);
});

// ---------------------------------------------------------------------------
// Redirects: where rebinding hides.

test('redirect: each hop is resolved again and pinned again, so a hop that rebinds is refused', async () => {
  // One host, two hops. It answers with a permitted address when the first hop
  // is checked and with the metadata address when the second is — which is
  // rebinding through a redirect, the case a per-request check alone misses.
  const resolver = scriptedResolver([v4('198.51.100.10'), v4('169.254.169.254')]);
  const dialled: string[] = [];
  const transport: OutboundTransport = async (request) => {
    dialled.push(request.address);
    return {
      status: 302,
      headers: { location: 'http://benefits.example/lookup-again' },
      body: '',
      peerAddress: request.address,
    };
  };
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: resolver.resolve,
    transport,
  });
  const failed = await expectFailure(
    connector.resolve(sourceAt('http://benefits.example'), { selector: 'deductible', key: 'PLAN-7', asker: null }),
  );
  assert.equal(failed.code, 'not_permitted');
  assert.match(failed.message, /redirected to/);
  assert.match(failed.message, /resolves to 169\.254\.169\.254/);
  assert.deepEqual(dialled, ['198.51.100.10'], 'the second hop never reached a socket');
  assert.equal(resolver.calls(), 2, 'the redirect target was resolved on its own, not reused');
});

test('redirect: a hop to a host outside the allowlist is refused', async () => {
  const resolver = scriptedResolver([v4('198.51.100.10')]);
  const transport: OutboundTransport = async (request) => ({
    status: 301,
    headers: { location: 'http://elsewhere.example/lookup' },
    body: '',
    peerAddress: request.address,
  });
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: resolver.resolve,
    transport,
  });
  const failed = await expectFailure(
    connector.resolve(sourceAt('http://benefits.example'), { selector: 'deductible', key: 'PLAN-7', asker: null }),
  );
  assert.equal(failed.code, 'not_permitted');
  assert.match(failed.message, /not in this deployment/);
});

test('redirect: a permitted hop is followed, and the walk is still bounded', async () => {
  const resolver = scriptedResolver([v4('198.51.100.10')]);
  let hops = 0;
  const transport: OutboundTransport = async (request) => {
    hops += 1;
    if (hops === 1) {
      return { status: 302, headers: { location: '/lookup2' }, body: '', peerAddress: request.address };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ key: 'PLAN-7', selector: 'deductible', value: 1500 }),
      peerAddress: request.address,
    };
  };
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: resolver.resolve,
    transport,
  });
  const source = sourceAt('http://benefits.example');
  const request = { selector: 'deductible', key: 'PLAN-7', asker: null };
  assert.equal((await connector.resolve(source, request)).value, 1500);
  assert.equal(hops, 2);

  // And a source that answers 3xx forever stops rather than walking.
  let forever = 0;
  const looping = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: scriptedResolver([v4('198.51.100.10')]).resolve,
    transport: async (r) => {
      forever += 1;
      return { status: 302, headers: { location: '/again' }, body: '', peerAddress: r.address };
    },
  });
  const spun = await expectFailure(looping.resolve(source, request));
  assert.equal(spun.code, 'source_error');
  assert.equal(forever, 4, 'the first request plus three redirects, and no more');
});

// ---------------------------------------------------------------------------
// TLS: the pin moves the packets, the hostname still decides the certificate.

test('tls: the certificate is checked against the hostname, not the pinned address', () => {
  // Run in a child process, because the only way to make a test certificate
  // trusted is NODE_EXTRA_CA_CERTS, which Node reads at start-up. The child
  // serves that certificate — issued for `pinned.example` alone — on
  // 127.0.0.1, and drives the real connector against it twice: once for the
  // name the certificate carries, once for a name it does not. Both requests
  // are pinned to the same correct address, so the only thing that can differ
  // is whether the certificate is judged against the name.
  const dir = mkdtempSync(join(tmpdir(), 'canon-tlspin-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, CERT_PEM);
  writeFileSync(keyPath, KEY_PEM);
  const child = join(dirname(fileURLToPath(import.meta.url)), 'tlspin-child.js');
  try {
    const run = spawnSync(process.execPath, [child, certPath, keyPath], {
      encoding: 'utf8',
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
      timeout: 30_000,
    });
    assert.equal(run.status, 0, `child failed: ${run.stderr}`);
    const result = JSON.parse(run.stdout.trim()) as {
      matching: { ok: boolean; value?: unknown; code?: string; message?: string };
      mismatched: { ok: boolean; value?: unknown; code?: string; message?: string };
    };

    // The certificate names the host, the pin names the address, and both are
    // satisfied: TLS still works when Canon supplies the socket address.
    assert.equal(result.matching.ok, true, `matching name should verify: ${result.matching.message}`);
    assert.equal(result.matching.value, 1500);

    // Same certificate, same correct address, different name — refused. If the
    // pin had become the identity, this would have succeeded, and Canon would
    // have closed an SSRF hole by opening a man-in-the-middle one.
    assert.equal(result.mismatched.ok, false);
    assert.equal(result.mismatched.code, 'unreachable');
    assert.match(result.mismatched.message ?? '', /altnames|does not match/i);
    assert.equal(result.mismatched.value, undefined, 'and no value, as ever');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Everything the connector guaranteed before still holds over the new socket.

test('classification: timeout, 5xx, 403 and 404 mean what they always meant', async () => {
  let behaviour: { status: number; body: string; delayMs: number } = { status: 200, body: '{}', delayMs: 0 };
  const server = createServer((_req, res) => {
    const send = () => {
      res.writeHead(behaviour.status, { 'content-type': 'application/json' });
      res.end(behaviour.body);
    };
    if (behaviour.delayMs) setTimeout(send, behaviour.delayMs).unref();
    else send();
  });
  const port = await listen(server, '127.0.0.1');
  const connector = new HttpConnector({ serviceIdentity: 'svc-canon', requestTimeoutMs: 200 });
  const source = sourceAt(`http://127.0.0.1:${port}`);
  const request = { selector: 'deductible', key: 'PLAN-7', asker: null };

  try {
    behaviour = { status: 200, body: JSON.stringify({ value: 1500 }), delayMs: 0 };
    assert.equal((await connector.resolve(source, request)).value, 1500);

    behaviour = { status: 403, body: JSON.stringify({ message: 'not entitled' }), delayMs: 0 };
    const forbidden = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([forbidden.kind, forbidden.code, forbidden.status, forbidden.retryable], [
      'refused',
      'forbidden',
      403,
      false,
    ]);

    behaviour = { status: 404, body: JSON.stringify({ message: 'no such plan' }), delayMs: 0 };
    const missing = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([missing.kind, missing.code, missing.status, missing.retryable], [
      'refused',
      'not_found',
      404,
      false,
    ]);

    behaviour = { status: 500, body: JSON.stringify({ message: 'boom' }), delayMs: 0 };
    const broken = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([broken.kind, broken.code, broken.status, broken.retryable], [
      'unanswered',
      'source_error',
      500,
      true,
    ]);

    behaviour = { status: 401, body: JSON.stringify({ message: 'who?' }), delayMs: 0 };
    assert.equal((await expectFailure(connector.resolve(source, request))).code, 'unauthenticated');

    behaviour = { status: 200, body: '<html>maintenance</html>', delayMs: 0 };
    assert.equal((await expectFailure(connector.resolve(source, request))).code, 'unparseable');

    behaviour = { status: 200, body: JSON.stringify({ value: 1500 }), delayMs: 800 };
    const started = Date.now();
    const slow = await expectFailure(connector.resolve(source, request));
    assert.deepEqual([slow.kind, slow.code, slow.retryable], ['unanswered', 'timeout', true]);
    assert.ok(Date.now() - started < 700, 'the connector gave up rather than waiting on the source');
  } finally {
    server.close();
  }

  // A source that is not there at all.
  const gone = await expectFailure(connector.resolve(sourceAt('http://127.0.0.1:1'), request));
  assert.deepEqual([gone.kind, gone.code, gone.retryable], ['unanswered', 'unreachable', true]);
});

test('classification: a body larger than Canon will read is no answer, never a value', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"value":"');
    for (let i = 0; i < 24; i += 1) res.write('x'.repeat(64 * 1024));
    res.end('"}');
  });
  const port = await listen(server, '127.0.0.1');
  try {
    const connector = new HttpConnector({ serviceIdentity: 'svc-canon', requestTimeoutMs: 5000 });
    const failed = await expectFailure(
      connector.resolve(sourceAt(`http://127.0.0.1:${port}`), {
        selector: 'deductible',
        key: 'PLAN-7',
        asker: null,
      }),
    );
    assert.deepEqual([failed.kind, failed.code], ['unanswered', 'unparseable']);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// End to end: the federation path, through Canon, against the real stub.

test('federation: a reference resolves end to end against the real source-stub over a pinned socket', async () => {
  const benefits = new BenefitsStore();
  const stub = createBenefitsApi(benefits);
  const port = await listen(stub, '127.0.0.1');
  benefits.seedPlan({
    planId: 'plan-gold-2026',
    name: 'Gold PPO 2026',
    deductible: 1500,
    outOfPocketMaximum: 6000,
    genericCoinsurance: 10,
    brandCoinsurance: 30,
    effectiveDate: '2026-01-01',
  });

  const { defaultConnectorRegistry } = await import('../src/connectors.js');
  const connectors = defaultConnectorRegistry().register(
    new HttpConnector({ serviceIdentity: 'svc-canon', requestTimeoutMs: 3000 }),
  );
  const store = new CanonStore(openDb(':memory:'), quiet, undefined, connectors);
  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const collection = store.createCollection(dana.id, { name: 'Benefits' });
    benefits.setEntitlements('svc-canon', { plans: ['plan-gold-2026'] });

    const source = store.createSource(dana.id, {
      name: 'Benefits Admin',
      kind: 'http',
      baseUrl: `http://127.0.0.1:${port}`,
      authMode: 'service',
      freshnessWindowMs: 60_000,
      collectionIds: [collection.id],
    });
    const page = store.createPage(dana.id, {
      collectionId: collection.id,
      type: 'policy',
      title: 'Benefits policy',
    });
    store.addReference(dana.id, page.id, {
      sourceId: source.id,
      selector: 'deductible',
      key: 'plan-gold-2026',
      label: 'Plan deductible',
    });

    const resolved = await store.resolveReferences(dana.id, page.id);
    assert.equal(resolved.length, 1);
    const only = resolved[0]!;
    assert.equal(only.error, undefined, `resolution failed: ${only.error}`);
    assert.equal(only.value, 1500);
    assert.equal(only.stale, false);
    assert.equal(only.sourceName, 'Benefits Admin');
    assert.ok(only.resolvedAt && !Number.isNaN(Date.parse(only.resolvedAt)));

    // And the refusal path, from the source's own access model, through Canon.
    const beyond = store.addReference(dana.id, page.id, {
      sourceId: source.id,
      selector: 'deductible',
      key: 'plan-exec-2026',
      label: 'Executive deductible',
    });
    const second = await store.resolveReferences(dana.id, page.id);
    const refused = second.find((r) => r.referenceId === beyond.id)!;
    assert.ok(
      refused.value === undefined || refused.value === null,
      'no value was invented for a key the source will not answer',
    );
    assert.ok(refused.error, 'the failure is shown rather than hidden');
  } finally {
    stub.close();
  }
});

// A silent guard on the seam itself: no code path in the connector may take a
// hostname to the socket. The transport's contract is an address.
test('pin: the transport seam is handed an address, never a name to resolve', async () => {
  const seen: OutboundRequest[] = [];
  const transport: OutboundTransport = async (request): Promise<OutboundResponse> => {
    seen.push(request);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ value: 1500 }),
      peerAddress: request.address,
    };
  };
  const connector = new HttpConnector({
    outbound: policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example' }),
    serviceIdentity: 'svc-canon',
    resolver: scriptedResolver([v4('198.51.100.10')]).resolve,
    transport,
  });
  await connector.resolve(sourceAt('https://benefits.example'), {
    selector: 'deductible',
    key: 'PLAN-7',
    asker: null,
  });
  const only = seen[0]!;
  assert.equal(only.address, '198.51.100.10');
  assert.equal(only.host, 'benefits.example', 'the hostname travels for the certificate, not for the socket');
  assert.equal(only.port, 443);
  assert.notEqual(canonicalAddress(only.address), null, 'the destination is a literal address');
});
