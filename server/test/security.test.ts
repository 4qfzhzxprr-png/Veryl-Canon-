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
import { RateLimiter } from '../src/ratelimit.js';
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
    transport: () => assert.fail('nothing may be fetched when the policy forbids the host'),
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
    transport: () => assert.fail('nothing may be fetched when the name resolves somewhere private'),
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

// ---------------------------------------------------------------------------
// R3 — a mention notified any actor, including non-members

test('mentions: an actor with no role in the collection is not notified, and the commenter is told', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const secret = store.createCollection(dana.id, { name: 'Board papers', restricted: true });
  store.setMember(dana.id, secret.id, marc.id, 'comment');
  const page = store.createPage(dana.id, { collectionId: secret.id, type: 'note', title: 'Redundancy plan' });

  const comment = store.createComment(marc.id, page.id, {
    body: `@${dana.id} @${outsider.id} is the headcount figure current?`,
  });

  // The comment itself lands in full, mention text and all.
  assert.match(comment.body, new RegExp(outsider.id));
  assert.deepEqual(comment.mentions.notified, [dana.id]);
  assert.deepEqual(comment.mentions.withheld, [{ actorId: outsider.id, reason: 'no_access' }]);

  // The leak was the notification's subject (the page title) and its body (the
  // comment text). Neither was written.
  assert.deepEqual(store.listNotifications(outsider.id), []);
  const mine = store.listNotifications(dana.id);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.subject, /Redundancy plan/);

  // And the record says who was reached for, so an admin can act on it.
  const [event] = store.queryAudit(dana.id, { action: 'comment.create' });
  assert.deepEqual(event!.details.mentions, [dana.id]);
  assert.deepEqual(event!.details.mentionsWithheld, [outsider.id]);
});

// ---------------------------------------------------------------------------
// R4 — existence was checked before permission
//
// Two places, chosen because a listing already hid the object or because the
// id is guessable. Everything else stays 403 on purpose; see SECURITY.md R4.

test('oracle: a source you cannot see answers exactly as one that was never registered', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  const scoped = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 1000,
    collectionIds: [collection.id],
  });

  // The listing already omits it; `get` must not put it back one id at a time.
  assert.deepEqual(store.listSources(outsider.id), []);
  const hidden = expectCode(() => store.getSource(outsider.id, scoped.id), 'not_found');
  const invented = expectCode(() => store.getSource(outsider.id, 'a4f0b1c2-0000-4000-8000-000000000000'), 'not_found');
  assert.equal(
    hidden.message.replace(scoped.id, '<id>'),
    invented.message.replace('a4f0b1c2-0000-4000-8000-000000000000', '<id>'),
    'the two refusals are word for word the same',
  );
  // Administering one you cannot see answers the same way, for the same reason.
  expectCode(() => store.deleteSource(outsider.id, scoped.id), 'not_found');
  // A member who can see it and simply lacks admin still gets the explanation.
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  expectCode(() => store.deleteSource(marc.id, scoped.id), 'forbidden');
});

test('oracle: an import run in a collection you hold no role in reads as no such run', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Imported' });
  const root = mkdtempSync(join(tmpdir(), 'canon-sec-runs-'));
  writeFileSync(join(root, 'Page_1.html'), '<html><head><title>Page</title></head><body><p>x</p></body></html>');
  try {
    // A run id is CALLER-SUPPLIED, and an operator's is a word, not a UUID.
    store.runImport(dana.id, {
      source: 'google-docs',
      path: root,
      collectionId: collection.id,
      runId: 'migration-1',
    });
    assert.equal(store.getImportRun(dana.id, 'migration-1').runId, 'migration-1');

    const taken = expectCode(() => store.getImportRun(outsider.id, 'migration-1'), 'not_found');
    const free = expectCode(() => store.getImportRun(outsider.id, 'migration-2'), 'not_found');
    assert.equal(
      taken.message.replace('migration-1', '<id>'),
      free.message.replace('migration-2', '<id>'),
      'a guessable id space must not answer differently for an id that is real',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R5 — audit events naming no collection were visible to everyone

test('audit: an event naming no collection reaches its actor and an operator, and nobody else', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' }); // dana is admin: the operator
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  store.setMember(dana.id, collection.id, marc.id, 'edit'); // a member, not an operator
  const bot = store.createActor({ kind: 'agent', name: 'PolicyBot', registryRef: 'passport:bot-1' });
  store.setMember(dana.id, collection.id, bot.id, 'view');

  // An ask that names no collection: the event carries the question text.
  await store.ask(bot.id, { question: 'What is the parental leave allowance for contractors?' });
  const asks = (actorId: string) => store.queryAudit(actorId, { action: 'answer.ask' });

  assert.equal(asks(bot.id).length, 1, 'the actor the event is about reads it');
  assert.equal(asks(dana.id).length, 1, 'an operator reads it');
  assert.match(String(asks(dana.id)[0]!.details.question), /parental leave/);
  assert.equal(asks(marc.id).length, 0, 'an ordinary member of a collection does not');

  // The F2 narrowing is unchanged: a collection-scoped event still reaches
  // every member of that collection, operator or not.
  assert.equal(
    store.queryAudit(marc.id, { action: 'collection.member_set' }).length > 0,
    true,
    'collection-scoped events still reach members',
  );
});

// ---------------------------------------------------------------------------
// R6 — an import required only `edit`

test('imports: running one takes admin on the target collection, not edit', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  const collection = store.createCollection(dana.id, { name: 'Imported' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  const root = mkdtempSync(join(tmpdir(), 'canon-sec-import-role-'));
  writeFileSync(join(root, 'Page_1.html'), '<html><head><title>Page</title></head><body><p>x</p></body></html>');
  try {
    const refused = expectCode(
      () => store.runImport(marc.id, { source: 'google-docs', path: root, collectionId: collection.id }),
      'forbidden',
    );
    assert.equal(refused.details.needed, 'admin');
    assert.equal(store.tree(dana.id, collection.id).length, 0, 'nothing was read and nothing was written');

    const summary = store.runImport(dana.id, { source: 'google-docs', path: root, collectionId: collection.id });
    assert.equal(summary.counts.imported, 1);
    // Reading what an import did to a collection you belong to stays at `view`:
    // the bar is on aiming the run, not on seeing what it did.
    assert.equal(store.getImportRun(marc.id, summary.runId).runId, summary.runId);
    assert.equal(store.listImportRuns(marc.id).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R7 — internal error messages reached the client

test('errors: an unexpected failure returns a correlation id, never the internal message', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  // Stand-in for any bug that throws something other than a CanonError. The
  // message is exactly the kind that used to be handed to the caller.
  const internal = 'SQLITE_ERROR: no such column: secret (near "SELECT" in /srv/canon/data/canon.db)';
  (store as unknown as { listActors: () => never }).listActors = () => {
    throw new Error(internal);
  };

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/actors`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; message: string; errorId: string };
    assert.equal(body.error, 'internal');
    assert.equal(body.message.includes('SQLITE_ERROR'), false, 'no SQL reaches the caller');
    assert.equal(body.message.includes('/srv/canon'), false, 'no server path reaches the caller');
    assert.match(body.errorId, /^[0-9a-f-]{36}$/);
    // Correlatable: the detail is in the server's log, under that id.
    assert.ok(
      logged.some((line) => line.includes(body.errorId) && line.includes('SQLITE_ERROR')),
      'the detail was logged against the id',
    );

    // A CanonError's message is a product feature and is untouched.
    const missing = await fetch(`${base}/collections/nope`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { message: string }).message, 'No such collection: nope');
  } finally {
    console.error = realError;
    server.close();
  }
});

// ---------------------------------------------------------------------------
// R8 — no rate limiting

test('limits: an expensive route is bucketed per actor, and reading the record never is', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  store.setMember(dana.id, collection.id, marc.id, 'view');
  const page = store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'Handbook' });

  // A deliberately tiny bucket: two questions, no refill inside the test.
  const limiter = new RateLimiter({ ask: { burst: 2, perMinute: 0 } });
  const server = createApi(store, null, limiter);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = (actorId: string) =>
    fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': actorId },
      body: JSON.stringify({ question: 'Is vault access logged?' }),
    });
  try {
    assert.equal((await ask(dana.id)).status, 200);
    assert.equal((await ask(dana.id)).status, 200);
    const refused = await ask(dana.id);
    assert.equal(refused.status, 429);
    const body = (await refused.json()) as { error: string; bucket: string };
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.bucket, 'ask');

    // Per actor: one caller's burst is not another's.
    assert.equal((await ask(marc.id)).status, 200);

    // THE ONE THING THIS MUST NOT DO: lock somebody out of the record. Dana's
    // ask bucket is empty and every read still answers.
    for (const path of [`/pages/${page.id}`, '/collections', '/search?q=handbook', '/audit', '/notifications']) {
      const res = await fetch(`${base}${path}`, { headers: { 'x-actor-id': dana.id } });
      assert.equal(res.status, 200, `${path} must never be rate limited`);
    }
  } finally {
    server.close();
  }
});

test('limits: a failed passport costs a token, a successful one costs nothing', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const verified = {
    agentId: 'agent-1',
    name: 'PolicyBot',
    certified: true,
    permittedCollections: ['*'],
    permittedSources: [],
    permittedActions: ['read'],
    checkedAt: new Date().toISOString(),
    recheckAfterSeconds: 60,
  };
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({
      baseUrl: 'http://registry.invalid',
      cacheTtlMs: 0, // never cached, so every request really asks
      fetchImpl: async (_url, init) => {
        const passport = (JSON.parse(String(init?.body ?? '{}')) as { passport?: string }).passport ?? '';
        return passport === 'vap_good'
          ? new Response(JSON.stringify(verified), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'unknown_passport', message: 'No such passport' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
      },
    }),
  });
  const limiter = new RateLimiter({ auth: { burst: 2, perMinute: 0 } });
  const server = createApi(store, auth, limiter);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const present = (passport: string) => fetch(`${base}/collections`, { headers: { 'x-agent-passport': passport } });
  try {
    // Five honest sessions spend nothing: brute force is a run of failures.
    for (let i = 0; i < 5; i += 1) assert.equal((await present('vap_good')).status, 200);

    assert.equal((await present('vap_guess-1')).status, 401);
    assert.equal((await present('vap_guess-2')).status, 401);
    const stopped = await present('vap_guess-3');
    assert.equal(stopped.status, 429, 'the third guess in a row is refused before the Registry is asked');
    assert.equal(((await stopped.json()) as { bucket: string }).bucket, 'auth');
  } finally {
    server.close();
  }
});
