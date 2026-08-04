import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachMetrics, Metrics, metricsEnabled, normaliseRoute, DURATION_BUCKETS } from '../src/metrics.js';

// The production-readiness review found Canon ran in production blind. These
// cover the metrics module: routes are reduced to a bounded shape (no page ids
// leak into a label), the histogram is well-formed, gauges are read at scrape
// time, and the endpoint is off unless a deployment turns it on.

test('metricsEnabled: opt-in only', () => {
  for (const on of ['on', 'true', '1', 'ON', ' true ']) {
    assert.equal(metricsEnabled({ CANON_METRICS: on } as NodeJS.ProcessEnv), true, on);
  }
  for (const off of [undefined, '', 'off', 'no', 'false']) {
    assert.equal(metricsEnabled({ CANON_METRICS: off } as NodeJS.ProcessEnv), false, String(off));
  }
});

test('normaliseRoute: identifiers become their shape, so a label set stays bounded', () => {
  assert.equal(normaliseRoute('/pages/8f14e45f-ceea-467a-9f0b-1c2d3e4f5061/versions/3'), '/pages/:id/versions/:n');
  assert.equal(normaliseRoute('/collections'), '/collections');
  assert.equal(normaliseRoute('/auth/access/db11d8bd-5557-4343-8cd5-99de5cc13c79'), '/auth/access/:id');
  // A long opaque token (not a UUID) is still an id.
  assert.equal(normaliseRoute('/x/AKIAIOSFODNN7EXAMPLE0000'), '/x/:id');
  // Ordinary words survive.
  assert.equal(normaliseRoute('/knowledge/whoami'), '/knowledge/whoami');
  assert.equal(normaliseRoute('/'), '/');
});

test('Metrics: requests count by method/route/status and land in the histogram', () => {
  const m = new Metrics();
  m.recordRequest('GET', '/collections', 200, 30);
  m.recordRequest('GET', '/collections', 200, 8);
  m.recordRequest('POST', '/ask', 200, 2500);
  m.recordRequest('GET', '/collections', 500, 12);
  const text = m.render();

  assert.match(text, /canon_http_requests_total\{method="GET",route="\/collections",status="200"\} 2/);
  assert.match(text, /canon_http_requests_total\{method="GET",route="\/collections",status="500"\} 1/);
  assert.match(text, /canon_http_requests_total\{method="POST",route="\/ask",status="200"\} 1/);

  // The histogram is keyed by method+route (not status), so all THREE
  // GET /collections observations share it — 8ms, 12ms, 30ms — including the
  // one that answered 500. The 0.01s bucket holds only the 8ms one; the 0.025s
  // bucket holds the 8ms and 12ms; the 0.05s bucket holds all three.
  assert.match(text, /_bucket\{method="GET",route="\/collections",le="0\.01"\} 1/);
  assert.match(text, /_bucket\{method="GET",route="\/collections",le="0\.025"\} 2/);
  assert.match(text, /_bucket\{method="GET",route="\/collections",le="0\.05"\} 3/);
  assert.match(text, /_bucket\{method="GET",route="\/collections",le="\+Inf"\} 3/);
  assert.match(text, /_count\{method="GET",route="\/collections"\} 3/);
  // sum = 0.008 + 0.012 + 0.03 = 0.05s
  assert.match(text, /_sum\{method="GET",route="\/collections"\} 0\.05\b/);
});

test('Metrics: histogram buckets are cumulative and monotonic', () => {
  const m = new Metrics();
  for (const ms of [3, 20, 300, 4000]) m.recordRequest('GET', '/x', 200, ms);
  const text = m.render();
  const buckets = DURATION_BUCKETS.map((b) => {
    const match = new RegExp(`_bucket\\{method="GET",route="/x",le="${b.toString().replace('.', '\\.')}"\\} (\\d+)`).exec(text);
    return Number(match![1]);
  });
  for (let i = 1; i < buckets.length; i += 1) {
    assert.ok(buckets[i]! >= buckets[i - 1]!, `bucket ${i} (${buckets[i]}) < previous (${buckets[i - 1]})`);
  }
  assert.equal(buckets[buckets.length - 1], 4, 'the last real bucket holds all four');
});

test('Metrics: a gauge is read at scrape time, and a throwing one is omitted not fatal', () => {
  const m = new Metrics();
  let n = 41;
  m.registerGauge('canon_test_value', 'A test value.', () => [{ value: (n += 1) }]);
  m.registerGauge('canon_build_info', 'Identity.', () => [{ labels: { node: 'v22', stage: 'alpha' }, value: 1 }]);
  m.registerGauge('canon_broken', 'Throws.', () => {
    throw new Error('record unreadable');
  });

  const first = m.render();
  assert.match(first, /canon_test_value 42/);
  assert.match(first, /canon_build_info\{node="v22",stage="alpha"\} 1/);
  // Read again: the value is fresh, not cached.
  assert.match(m.render(), /canon_test_value 43/);
  // The broken gauge produced its HELP/TYPE but no sample, and did not crash.
  assert.match(first, /# TYPE canon_broken gauge/);
  assert.ok(!/canon_broken \d/.test(first), 'no sample line for the throwing gauge');
});

async function boot(enabled: boolean): Promise<{ base: string; close: () => Promise<void>; metrics: Metrics }> {
  const metrics = new Metrics();
  const server: Server = createServer((req, res) => {
    // A trivial inner app: 200 for anything but a fixed 404 path.
    if ((req.url ?? '/') === '/missing') {
      res.writeHead(404);
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  attachMetrics(server, metrics, enabled);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, metrics, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('attachMetrics: serves /metrics and records the traffic it saw', async () => {
  const { base, close } = await boot(true);
  try {
    await fetch(base + '/collections');
    await fetch(base + '/missing'); // a 404
    const res = await fetch(base + '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/);
    const body = await res.text();
    assert.match(body, /canon_http_requests_total\{method="GET",route="\/collections",status="200"\} 1/);
    assert.match(body, /canon_http_requests_total\{method="GET",route="\/missing",status="404"\} 1/);
  } finally {
    await close();
  }
});

test('attachMetrics: /metrics is not served when disabled', async () => {
  const { base, close } = await boot(false);
  try {
    // With metrics off the wrapper is a no-op, so /metrics reaches the inner app
    // (which answers 200 {} here) rather than a Prometheus exposition.
    const res = await fetch(base + '/metrics');
    const body = await res.text();
    assert.ok(!body.includes('canon_http_requests_total'), 'no exposition when disabled');
  } finally {
    await close();
  }
});
