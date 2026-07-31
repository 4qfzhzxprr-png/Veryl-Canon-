import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentAuth } from '../src/agentauth.js';
import { createApi, MAX_REQUEST_BODY_BYTES } from '../src/api.js';
import { csvField } from '../src/csv.js';
import { openDb } from '../src/db.js';
import { assertHeaderSafe, composeMessage, formatAddress } from '../src/email.js';
import { ConnectorError, HttpConnector } from '../src/httpconnector.js';
import { CanonError } from '../src/model.js';
import {
  assertOutboundAllowed,
  assertRegistrableBaseUrl,
  isBlockedAddress,
  outboundPolicyFromEnv,
} from '../src/outbound.js';
import { RegistryClient } from '../src/registry.js';
import { MAX_QUESTION_LENGTH } from '../src/retrieval.js';
import { parseSmtpUrl } from '../src/smtp.js';
import { SourceService } from '../src/sources.js';
import { CanonStore } from '../src/store.js';
import type { NotificationTransport } from '../src/notify.js';

// The M4 security review's regression suite. Every test here fails without the
// fix it guards; each names the finding it belongs to (see SECURITY.md).

const quiet: NotificationTransport = { deliver() {} };

function policy(env: Record<string, string>) {
  return outboundPolicyFromEnv(env as NodeJS.ProcessEnv);
}

const OPEN = policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.internal, *.example.com' });
const NOTHING = policy({});

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------
// F1 — SSRF through federated sources

test('ssrf: the empty policy is no outbound federation, not anything', () => {
  assert.throws(
    () => assertOutboundAllowed(new URL('https://benefits.internal/lookup'), NOTHING),
    /permits no outbound federation/,
  );
  assert.doesNotThrow(() => assertOutboundAllowed(new URL('https://benefits.internal/lookup'), OPEN));
});

test('ssrf: the cloud metadata address and the private ranges are blocked', () => {
  for (const address of [
    '169.254.169.254', // AWS/GCP/Azure instance metadata
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.9',
    '192.168.1.1',
    '100.64.0.1', // carrier-grade NAT
    '::1',
    'fd00::1', // unique local
    'fe80::1', // link local
    '::ffff:169.254.169.254', // v4-mapped v6 spelling of the same address
    '64:ff9b::a9fe:a9fe', // NAT64 spelling of the same address
    '2002:a9fe:a9fe::1', // 6to4 spelling of the same address
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
  for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedAddress(address), false, `${address} should be reachable`);
  }
});

test('ssrf: a literal internal address is refused even when allowlisted by mistake', () => {
  const listed = policy({ CANON_SOURCE_ALLOWED_HOSTS: '169.254.169.254, 127.0.0.1' });
  assert.throws(
    () => assertOutboundAllowed(new URL('http://169.254.169.254/latest/meta-data/'), listed),
    /loopback, link-local or private/,
  );
  // ...unless the deployment says, explicitly, that it is a development one.
  const dev = policy({ CANON_SOURCE_ALLOWED_HOSTS: '127.0.0.1', CANON_SOURCE_ALLOW_PRIVATE: 'true' });
  assert.doesNotThrow(() => assertOutboundAllowed(new URL('http://127.0.0.1:9000/lookup'), dev));
});

test('ssrf: non-HTTP(S) schemes and embedded credentials are refused', () => {
  for (const url of ['file:///etc/passwd', 'gopher://benefits.internal/x', 'ftp://benefits.internal/x']) {
    assert.throws(() => assertOutboundAllowed(new URL(url), OPEN), /federates over/);
  }
  assert.throws(
    () => assertOutboundAllowed(new URL('https://user:secret@benefits.internal/lookup'), OPEN),
    /embedded credentials/,
  );
});

test('ssrf: the allowlist is exact, with an explicit wildcard form', () => {
  assert.doesNotThrow(() => assertOutboundAllowed(new URL('https://hr.example.com/x'), OPEN));
  assert.throws(() => assertOutboundAllowed(new URL('https://example.com/x'), OPEN), /not in this deployment/);
  assert.throws(
    () => assertOutboundAllowed(new URL('https://benefits.internal.attacker.test/x'), OPEN),
    /not in this deployment/,
  );
  const ported = policy({ CANON_SOURCE_ALLOWED_HOSTS: 'benefits.internal:8443' });
  assert.doesNotThrow(() => assertOutboundAllowed(new URL('https://benefits.internal:8443/x'), ported));
  assert.throws(() => assertOutboundAllowed(new URL('https://benefits.internal/x'), ported), /not in this deployment/);
});

test('ssrf: registering a source is where the baseUrl is first judged', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const sources = new SourceService(db, store, NOTHING);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  const base = {
    name: 'Metadata',
    kind: 'http',
    authMode: 'service' as const,
    freshnessWindowMs: 60_000,
    collectionIds: [collection.id],
  };

  const err = expectCode(
    () => sources.create(dana.id, { ...base, baseUrl: 'http://169.254.169.254/latest/meta-data/' }),
    'invalid',
  );
  assert.match(err.message, /not one Canon may reach/);
  expectCode(() => sources.create(dana.id, { ...base, baseUrl: 'file:///etc/passwd' }), 'invalid');

  // The hermetic connector's fixture namespace still registers: it names no
  // network location and makes no request.
  assert.ok(sources.create(dana.id, { ...base, kind: 'static', baseUrl: 'static:benefits' }).id);
  assert.ok(sources.create(dana.id, { ...base, name: 'Bare', kind: 'static', baseUrl: 'benefits' }).id);
});

test('ssrf: a source cannot be walked to a forbidden host by an update', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const sources = new SourceService(db, store, OPEN);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  const source = sources.create(dana.id, {
    name: 'Benefits Admin',
    kind: 'http',
    baseUrl: 'https://benefits.internal',
    authMode: 'service',
    freshnessWindowMs: 60_000,
    collectionIds: [collection.id],
  });
  expectCode(() => sources.update(dana.id, source.id, { baseUrl: 'http://169.254.169.254/' }), 'invalid');
  assert.equal(sources.row(source.id).baseUrl, 'https://benefits.internal');
});

test('ssrf: the connector re-checks at resolution time, not only at registration', async () => {
  const connector = new HttpConnector({
    outbound: NOTHING,
    serviceIdentity: 'svc-canon',
    fetchImpl: () => assert.fail('nothing may be fetched when the policy forbids the host'),
  });
  const source = {
    id: 's1',
    name: 'Metadata',
    kind: 'http',
    baseUrl: 'http://169.254.169.254/',
    authMode: 'service' as const,
    freshnessWindowMs: 0,
  };
  await assert.rejects(
    connector.resolve(source, { selector: 'role', key: 'x', asker: null }),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'not_permitted');
      assert.equal(err.kind, 'unanswered');
      return true;
    },
  );
});

test('ssrf: a redirect to a host the policy forbids is not followed', async () => {
  // A permitted host answers 302 to the metadata address. The permitted host is
  // reachable; the address it points at is not, and the second request must
  // never leave the process.
  let hops = 0;
  const dev = policy({ CANON_SOURCE_ALLOWED_HOSTS: '127.0.0.1', CANON_SOURCE_ALLOW_PRIVATE: 'true' });
  const redirector: Server = createServer((_req, res) => {
    hops += 1;
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const port = (redirector.address() as AddressInfo).port;
  try {
    // The redirect target is outside the allowlist even under the development
    // policy that let the first hop through.
    const connector = new HttpConnector({ outbound: dev, serviceIdentity: 'svc', requestTimeoutMs: 1000 });
    await assert.rejects(
      connector.resolve(
        {
          id: 's1',
          name: 'Redirector',
          kind: 'http',
          baseUrl: `http://127.0.0.1:${port}`,
          authMode: 'service',
          freshnessWindowMs: 0,
        },
        { selector: 'deductible', key: 'PLAN-7', asker: null },
      ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError);
        assert.equal(err.code, 'not_permitted');
        assert.match(err.message, /redirected to/);
        return true;
      },
    );
    assert.equal(hops, 1, 'the redirect was not followed');
  } finally {
    redirector.close();
  }
});

test('ssrf: a name that resolves to a private address is refused at resolution', async () => {
  // localhost is in the allowlist by name and resolves to loopback. The
  // structural check passes on the name; the resolved check is what refuses it,
  // which is the DNS half of the guard.
  const byName = policy({ CANON_SOURCE_ALLOWED_HOSTS: 'localhost' });
  const connector = new HttpConnector({
    outbound: byName,
    serviceIdentity: 'svc',
    fetchImpl: () => assert.fail('nothing may be fetched when the name resolves somewhere private'),
  });
  await assert.rejects(
    connector.resolve(
      {
        id: 's1',
        name: 'Local',
        kind: 'http',
        baseUrl: 'http://localhost:9/',
        authMode: 'service',
        freshnessWindowMs: 0,
      },
      { selector: 'deductible', key: 'PLAN-7', asker: null },
    ),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.equal(err.code, 'not_permitted');
      assert.match(err.message, /resolves to/);
      return true;
    },
  );
});

test('ssrf: assertRegistrableBaseUrl leaves connector-local names alone', () => {
  assert.doesNotThrow(() => assertRegistrableBaseUrl('', NOTHING));
  assert.doesNotThrow(() => assertRegistrableBaseUrl('benefits', NOTHING));
  assert.doesNotThrow(() => assertRegistrableBaseUrl('static:benefits', NOTHING));
  assert.throws(() => assertRegistrableBaseUrl('http://benefits.internal', NOTHING), /outbound federation/);
});

// ---------------------------------------------------------------------------
// A property, not a fix: agent classification fails closed
//
// agentauth.ts keeps its own route table, deliberately separate from api.ts's.
// The safety of that arrangement rests entirely on an unclassified route being
// REFUSED rather than guessed at, and nothing asserted it. These three routes
// exist in api.ts and are absent from the classification table; if a later
// change to either table makes one of them reachable by an agent, this fails.

test('agents: a route the classification table does not name is refused', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const verified = {
    agentId: 'agent-1',
    name: 'PolicyBot',
    certified: true,
    permittedCollections: ['*'],
    permittedSources: ['*'],
    permittedActions: ['read', 'comment', 'write'],
    checkedAt: new Date().toISOString(),
    recheckAfterSeconds: 60,
  };
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({
      baseUrl: 'http://registry.invalid',
      cacheTtlMs: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify(verified), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
  });
  const server = createApi(store, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Everything the Registry could grant is granted: read, comment, write,
    // every collection, every source. The route table is the only thing left.
    for (const [method, path] of [
      ['POST', '/imports'],
      ['GET', '/imports'],
      ['GET', '/audit.csv'],
      ['POST', '/notifications/flush'],
      ['POST', '/actors'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-agent-passport': 'vap_test' },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(res.status, 403, `${method} ${path} should be refused to agents`);
      assert.equal((await res.json()).reason, 'route_not_available_to_agents');
    }
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// F2 — the audit log was readable in full by any actor

test('audit: a collection-scoped event reaches only members of that collection', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const secret = store.createCollection(dana.id, { name: 'Board papers', restricted: true });
  const page = store.createPage(dana.id, { collectionId: secret.id, type: 'note', title: 'Redundancy plan' });
  store.editDraft(dana.id, page.id, { body: 'draft' });
  store.publish(dana.id, page.id);

  const mine = store.queryAudit(dana.id, {});
  assert.ok(mine.some((e) => e.collectionId === secret.id), 'a member reads their own collection');

  const theirs = store.queryAudit(outsider.id, {});
  assert.equal(
    theirs.filter((e) => e.collectionId === secret.id).length,
    0,
    'a non-member reads nothing from a collection they hold no role in',
  );
  assert.equal(theirs.some((e) => e.pageId === page.id), false, 'not even the page ids');
});

test('audit: the CSV export is narrowed by the same rule as the JSON query', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const secret = store.createCollection(dana.id, { name: 'Board papers' });
  store.createPage(dana.id, { collectionId: secret.id, type: 'note', title: 'Redundancy plan' });

  assert.equal(store.auditCsv(outsider.id, {}).body.includes(secret.id), false);
  assert.equal(store.auditCsv(dana.id, {}).body.includes(secret.id), true);
});

test('audit: the row limit is a bound parameter, not text spliced into SQL', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Busy' });
  for (let i = 0; i < 5; i += 1) {
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: `N${i}` });
  }
  // A limit that is not a number used to be spliced into the statement as
  // text. It now falls back to the default, and the table is still there.
  assert.equal(store.queryAudit(dana.id, { limit: Number('nonsense') }).length > 0, true);
  assert.equal(store.queryAudit(dana.id, { limit: '3' as unknown as number }).length, 3);
  assert.equal(
    store.queryAudit(dana.id, { limit: '1; DROP TABLE audit_events --' as unknown as number }).length > 0,
    true,
  );
  assert.equal(store.queryAudit(dana.id, {}).length > 0, true, 'the audit table survived');
  assert.equal(store.searchIndex.search(dana.id, { q: 'nothing', limit: Number('x') }).length, 0);
});

// ---------------------------------------------------------------------------
// F3 — CSV formula injection in the audit export

test('csv: a cell that would execute in a spreadsheet is defused', () => {
  assert.equal(csvField("=cmd|'/c calc'!A0"), `"'=cmd|'/c calc'!A0"`);
  assert.equal(csvField('+1+1'), `"'+1+1"`);
  assert.equal(csvField('@SUM(A1:A9)'), `"'@SUM(A1:A9)"`);
  assert.equal(csvField("-2+3+cmd|'/c calc'!A0"), `"'-2+3+cmd|'/c calc'!A0"`);
  assert.equal(csvField('\t=1+1'), '"\'\t=1+1"');
  // Ordinary values, including negative numbers, are untouched.
  assert.equal(csvField('-42'), '-42');
  assert.equal(csvField(-42), '-42');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('Benefits, Overview'), '"Benefits, Overview"');
});

// ---------------------------------------------------------------------------
// F4 — an import could follow a symlink out of the export directory

test('import: a symlink out of the export directory is refused, not read', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Imported' });

  const root = mkdtempSync(join(tmpdir(), 'canon-sec-export-'));
  const outside = mkdtempSync(join(tmpdir(), 'canon-sec-outside-'));
  const secretFile = join(outside, 'secret.html');
  writeFileSync(secretFile, '<html><head><title>Root password</title></head><body><p>hunter2</p></body></html>');
  writeFileSync(join(root, 'Real+Page_1.html'), '<html><head><title>Real Page</title></head><body><p>ok</p></body></html>');
  symlinkSync(secretFile, join(root, 'Stolen+Page_2.html'));

  try {
    const summary = store.runImport(dana.id, { source: 'google-docs', path: root, collectionId: collection.id });
    const stolen = summary.files.find((f) => f.file.startsWith('Stolen'));
    assert.ok(stolen, 'the symlink is reported, not silently dropped');
    assert.equal(stolen.outcome, 'skipped');
    assert.match(stolen.reason ?? '', /outside the export directory/);
    assert.equal(stolen.pageId, null);

    const titles = store.tree(dana.id, collection.id).map((p) => p.title);
    assert.deepEqual(titles, ['Real Page'], 'only the real page landed in the record');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('import: CANON_IMPORT_ROOTS bounds where a run may read from', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Imported' });
  const permitted = mkdtempSync(join(tmpdir(), 'canon-sec-allowed-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'canon-sec-elsewhere-'));
  writeFileSync(join(elsewhere, 'Page_1.html'), '<html><head><title>Page</title></head><body><p>x</p></body></html>');
  const before = process.env.CANON_IMPORT_ROOTS;
  process.env.CANON_IMPORT_ROOTS = permitted;
  try {
    expectCode(
      () => store.runImport(dana.id, { source: 'google-docs', path: elsewhere, collectionId: collection.id }),
      'forbidden',
    );
    assert.doesNotThrow(() =>
      store.runImport(dana.id, { source: 'google-docs', path: permitted, collectionId: collection.id }),
    );
  } finally {
    if (before === undefined) delete process.env.CANON_IMPORT_ROOTS;
    else process.env.CANON_IMPORT_ROOTS = before;
    rmSync(permitted, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F5 — SMTP header injection through an unvalidated actor email

test('email: a line break in an address never reaches a header', () => {
  assert.throws(
    () => formatAddress({ name: 'Mallory', address: 'mallory@example.com\r\nBcc: everyone@example.com' }),
    /line break/,
  );
  assert.throws(() => assertHeaderSafe('X', 'a\nb'), /line break/);
  assert.throws(
    () =>
      composeMessage({
        from: { name: 'Canon', address: 'canon@example.com' },
        to: { name: 'Mallory', address: 'mallory@example.com\nBcc: everyone@example.com' },
        subject: 'Hello',
        text: 'x',
        html: '<p>x</p>',
      }),
    /line break/,
  );
  // A long non-ASCII display name folds with a legitimate CRLF continuation
  // and must still compose.
  const composed = composeMessage({
    from: { name: 'Canon', address: 'canon@example.com' },
    to: { name: 'Ünïcödé '.repeat(12).trim(), address: 'iris@example.com' },
    subject: 'Réview requested',
    text: 'x',
    html: '<p>x</p>',
  });
  assert.match(composed.raw, /^To: =\?UTF-8\?B\?/m);
});

test('email: a subject carrying CRLF is encoded, never injected', () => {
  const composed = composeMessage({
    from: { name: 'Canon', address: 'canon@example.com' },
    to: { name: 'Iris', address: 'iris@example.com' },
    subject: 'Review requested\r\nBcc: everyone@example.com',
    text: 'x',
    html: '<p>x</p>',
  });
  assert.equal(/^Bcc:/m.test(composed.raw), false);
});

// ---------------------------------------------------------------------------
// F6 — unbounded request bodies and unbounded questions

test('limits: a request body larger than the cap is refused', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const oversized = JSON.stringify({ kind: 'person', name: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/actors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': dana.id },
      body: oversized,
    }).catch(() => null);
    // Either the server answered 400 or it closed the stream mid-upload; both
    // are refusals, and neither buffers the whole body.
    if (res) assert.equal(res.status, 400);
    assert.equal(store.listActors().length, 1, 'nothing was created');
  } finally {
    server.close();
  }
});

test('limits: a multi-megabyte question is refused rather than embedded', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  store.createCollection(dana.id, { name: 'Benefits' });
  await assert.rejects(
    store.ask(dana.id, { question: 'a '.repeat(MAX_QUESTION_LENGTH) }),
    (err: unknown) => {
      assert.ok(err instanceof CanonError);
      assert.equal(err.code, 'invalid');
      assert.match(err.message, /at most/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// F7 — a relay password echoed in an error message

test('secrets: a malformed CANON_SMTP_URL is not echoed back with its password', () => {
  const err = expectCode(() => parseSmtpUrl('smtp://canon:hunter2@ relay.internal:587'), 'invalid');
  assert.equal(err.message.includes('hunter2'), false, 'the password must not reach the message');
  assert.equal(err.message, 'CANON_SMTP_URL is not a URL');
});
