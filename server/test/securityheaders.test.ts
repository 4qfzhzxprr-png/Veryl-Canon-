import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi, MAX_REQUEST_BODY_BYTES } from '../src/api.js';
import { attachStatic, securityHeaders } from '../src/static.js';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';

// Marcus's security review and the production-readiness survey both flagged it:
// the web UI shipped without a single security header — no CSP, no
// clickjacking guard, no content-type-sniffing guard. These lock the baseline
// in so a regression is a failing test rather than a finding.

function servedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Canon</title><script type="module" src="/app.js"></script>');
  writeFileSync(join(dir, 'app.js'), 'export const ok = true;\n');
  return dir;
}

async function boot(hsts: boolean): Promise<{ base: string; close: () => Promise<void> }> {
  const store = new CanonStore(openDb(':memory:'));
  const server = attachStatic(createApi(store), servedDir(), hsts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('securityHeaders: the document carries a real CSP that forbids inline script', () => {
  const headers = securityHeaders({ html: true, hsts: false });
  const csp = headers['content-security-policy'] ?? '';
  // The injection vector that matters is shut: no 'unsafe-inline' on scripts.
  assert.ok(csp.includes("script-src 'self'"), csp);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `scripts must not allow unsafe-inline: ${csp}`);
  // Inline styles are allowed on purpose — the app sets style="" on skeletons
  // and the SVG map — and that is the documented trade.
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, csp);
  // Framing, plugins and a rewritten <base> are shut outright.
  assert.match(csp, /frame-ancestors 'none'/, csp);
  assert.match(csp, /object-src 'none'/, csp);
  assert.match(csp, /base-uri 'self'/, csp);
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['x-content-type-options'], 'nosniff');
});

test('securityHeaders: HSTS only when the edge is HTTPS, never on plain HTTP', () => {
  assert.equal(securityHeaders({ html: true, hsts: false })['strict-transport-security'], undefined);
  assert.match(
    securityHeaders({ html: true, hsts: true })['strict-transport-security'] ?? '',
    /max-age=\d+; includeSubDomains/,
  );
  // A non-document response never carries the document-only headers.
  const asset = securityHeaders({ html: false, hsts: true });
  assert.equal(asset['content-security-policy'], undefined);
  assert.equal(asset['x-frame-options'], undefined);
  assert.equal(asset['x-content-type-options'], 'nosniff');
});

test('served document carries the CSP and framing guard over HTTP', async () => {
  const { base, close } = await boot(false);
  try {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // Plain HTTP deployment: no HSTS, because the browser would ignore it and
    // its presence would imply a guarantee this transport does not make.
    assert.equal(res.headers.get('strict-transport-security'), null);
  } finally {
    await close();
  }
});

test('a sub-resource carries the transport headers but not the document policy', async () => {
  const { base, close } = await boot(true);
  try {
    const res = await fetch(base + '/app.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), null);
    // hsts:true here — the asset still pins the upgrade.
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=/);
  } finally {
    await close();
  }
});

test('the JSON API surface is nosniff and leaks no referrer', async () => {
  const { base, close } = await boot(false);
  try {
    const res = await fetch(base + '/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await close();
  }
  // Keep the body cap constant referenced so this file fails to compile if the
  // API's shape shifts underneath the header change.
  assert.ok(MAX_REQUEST_BODY_BYTES > 0);
});
