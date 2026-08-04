import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/api.js';
import { ConfigError, assertConfigValid, resolveBindHost, validateConfig } from '../src/config.js';
import { MIGRATIONS, openDb } from '../src/db.js';
import { Logger, attachRequestLog, redact, redactUrl, requestPath } from '../src/log.js';
import { latestVersion, type Migration } from '../src/migrate.js';
import {
  attachReadiness,
  auditChainCheck,
  databaseCheck,
  doorCheck,
  recordChecks,
  recordFileCheck,
  runReadiness,
  schemaCheck,
  startRecordWatch,
  type ReadinessCheck,
} from '../src/ready.js';
import { installGracefulShutdown } from '../src/shutdown.js';
import { CanonStore } from '../src/store.js';

// Operability: the properties a deployment is judged on rather than the ones a
// feature is. Can this process say whether it can serve? Does it refuse a
// configuration that cannot mean what it says? Does it finish what it started
// when it is told to stop? And does anything it writes about itself contain a
// secret?

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('readiness: fails when the schema is behind the binary, passes when it is current', async () => {
  const db = openDb(':memory:');

  const current = await runReadiness([databaseCheck(db), schemaCheck(db, MIGRATIONS)]);
  assert.equal(current.ready, true, JSON.stringify(current.checks));

  // The same process, built against a migration that has not run here.
  const ahead: Migration[] = [
    ...MIGRATIONS,
    { version: latestVersion(MIGRATIONS) + 1, name: 'unapplied', up: () => {} },
  ];
  const behind = await runReadiness([databaseCheck(db), schemaCheck(db, ahead)]);
  assert.equal(behind.ready, false);
  const schema = behind.checks.find((c) => c.name === 'schema')!;
  assert.equal(schema.ok, false);
  assert.match(schema.detail, /pending/);
  db.close();
});

test('readiness: fails when the record is not reachable', async () => {
  const db = openDb(':memory:');
  db.close();
  const report = await runReadiness([databaseCheck(db)]);
  assert.equal(report.ready, false);
  assert.match(report.checks[0]!.detail, /unreadable/);
});

test('readiness: a configured door that does not answer fails readiness', async () => {
  const unreachable = doorCheck('identity_provider', 'http://127.0.0.1:1/.well-known/openid-configuration', {
    timeoutMs: 250,
  });
  const report = await runReadiness([unreachable]);
  assert.equal(report.ready, false);
  assert.match(report.checks[0]!.detail, /unreachable/);

  const door = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const base = await listening(door);
  try {
    const reachable = await runReadiness([doorCheck('identity_provider', `${base}/.well-known/openid-configuration`)]);
    assert.equal(reachable.ready, true, JSON.stringify(reachable.checks));
  } finally {
    door.close();
  }
});

test('readiness: GET /ready answers 200 when it can serve and 503 when it cannot, and /health stays up either way', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  let healthy = true;
  const flaky: ReadinessCheck = {
    name: 'record',
    run: () => ({ name: 'record', ok: healthy, detail: healthy ? 'fine' : 'the record is unreachable' }),
  };
  // cacheMs 0 so the test sees each answer rather than a cached one.
  const server = attachReadiness(createApi(store), [flaky], { cacheMs: 0 });
  const base = await listening(server);
  try {
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { ready: boolean }).ready, true);

    healthy = false;
    const notReady = await fetch(`${base}/ready`);
    assert.equal(notReady.status, 503, 'a process that cannot serve answered a readiness probe 200');
    const body = (await notReady.json()) as { ready: boolean; checks: { detail: string }[] };
    assert.equal(body.ready, false);
    assert.match(body.checks[0]!.detail, /unreachable/);

    // Liveness is a different question: the process is up, so restarting it
    // would fix nothing.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  } finally {
    server.close();
    db.close();
  }
});

test('readiness: the answer is cached, so a probe every second is not a request to the IdP every second', async () => {
  let calls = 0;
  const counted: ReadinessCheck = {
    name: 'counted',
    run: () => {
      calls++;
      return { name: 'counted', ok: true, detail: 'ok' };
    },
  };
  const db = openDb(':memory:');
  const server = attachReadiness(createApi(new CanonStore(db, { deliver() {} })), [counted], { cacheMs: 60_000 });
  const base = await listening(server);
  try {
    await fetch(`${base}/ready`);
    await fetch(`${base}/ready`);
    await fetch(`${base}/ready`);
    assert.equal(calls, 1);
  } finally {
    server.close();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Readiness that means something (USER-TESTING.md T3.3)
// ---------------------------------------------------------------------------

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'canon-ready-'));
  return { path: (name: string) => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The repository root, found rather than counted: the compiled test's depth
 * below it depends on tsconfig's rootDir, and `dist/` holds a directory called
 * `server/src` too, so the marker has to be something only the source tree has.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    if (existsSync(join(dir, 'CONFIGURATION.md')) && existsSync(join(dir, 'server', 'src', 'ready.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('the repository root was not found above the compiled test file');
}

test('readiness: a Canon whose record cannot be read does not report ready', async () => {
  const dir = scratch();
  const path = dir.path('canon.db');
  const db = openDb(path);
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  store.createCollection(dana.id, { name: 'Compliance' });
  // Everything into the file itself, so what is corrupted below is the record
  // and not an empty page one with the record still sitting in the WAL.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  try {
    const checks = recordChecks(db, { path });
    const before = await runReadiness(checks);
    assert.equal(before.ready, true, JSON.stringify(before.checks));

    // What "I corrupted the database" means to the person who did it: the file
    // is overwritten underneath the process serving from it. Page one is left
    // alone so SQLite still opens the file — which is exactly the shape that
    // made this invisible, because the open connection goes on answering out of
    // its own page cache and every count it is asked for is still right.
    const bytes = readFileSync(path);
    assert.ok(bytes.byteLength > 8192, 'the fixture record is too small to corrupt meaningfully');
    bytes.fill(0xa5, 4096);
    writeFileSync(path, bytes);
    rmSync(path + '-wal', { force: true });
    rmSync(path + '-shm', { force: true });

    const after = await runReadiness(checks);
    assert.equal(after.ready, false, 'a Canon that cannot read its own record reported itself ready');
    const file = after.checks.find((c) => c.name === 'record_file')!;
    assert.equal(file.ok, false);
    assert.match(file.detail, /unreadable/);
    // …and the answer a load balancer gets still names no path on this server.
    assert.equal(
      after.checks.some((c) => c.detail.includes(path)),
      false,
      'an unauthenticated probe was handed the record’s path on disk',
    );
  } finally {
    try {
      db.close();
    } catch {
      // A connection onto a destroyed file may refuse to close. Not the point.
    }
    dir.cleanup();
  }
});

test('readiness: a record file that is not there at all is not ready', async () => {
  const dir = scratch();
  try {
    const report = await runReadiness([recordFileCheck(dir.path('nothing.db'))]);
    assert.equal(report.ready, false);
    assert.match(report.checks[0]!.detail, /unreadable/);
  } finally {
    dir.cleanup();
  }
});

test('readiness: the database check reads the record’s own rows, not a count of them', async () => {
  const db = openDb(':memory:');
  const check = databaseCheck(db);
  assert.equal((await runReadiness([check])).ready, true);

  // The one row every open creates (system.ts). Its absence is unambiguously a
  // fault rather than an empty Canon — and a `count(*)` over an empty table
  // would have reported the same cheerful zero either way.
  db.exec(`DELETE FROM actors WHERE id = 'system:canon'`);
  const gone = await runReadiness([check]);
  assert.equal(gone.ready, false);
  assert.match(gone.checks[0]!.detail, /system:canon/);
  db.close();
});

test('readiness: a Canon that would append unchained audit events is not ready', async () => {
  const db = openDb(':memory:');
  const check = auditChainCheck(db);
  const intact = await runReadiness([check]);
  assert.equal(intact.ready, true, JSON.stringify(intact.checks));

  // The trigger is what makes the log tamper-evident, and a gap in a chain
  // cannot be filled in afterwards. A process without it is up and must not
  // be in a pool.
  db.exec('DROP TRIGGER audit_chain_link');
  const unchained = await runReadiness([check]);
  assert.equal(unchained.ready, false);
  assert.match(unchained.checks[0]!.detail, /unchained/);
  db.close();
});

test('readiness: the record watch says an unreadable record out loud, once a window, and says when it returns', async () => {
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => void lines.push(line), level: 'debug' });
  let readable = false;
  let clock = 0;
  const check: ReadinessCheck = {
    name: 'record_file',
    run: () => ({
      name: 'record_file',
      ok: readable,
      detail: readable ? 'the record file opens and answers' : 'the record file is unreadable: malformed',
    }),
  };

  // No timer: the pass is driven by hand so the window is exact.
  const watch = startRecordWatch([check], { log, intervalMs: 0, repeatAfterMs: 60_000, now: () => clock });
  await delay(0); // the pass startRecordWatch runs immediately
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(events().length, 1, 'the first failure was not logged immediately');
  assert.equal(events()[0]!.level, 'error');
  assert.equal(events()[0]!.msg, 'the record cannot be read');
  assert.equal(events()[0]!.check, 'record_file');
  assert.match(String(events()[0]!.detail), /unreadable/);

  // Inside the window it is counted, not repeated: a fault that recurs every
  // few seconds must not be able to fill the disk of the one machine whose
  // database is already broken.
  await watch.pass();
  await watch.pass();
  await watch.pass();
  assert.equal(events().length, 1, 'a repeating failure repeated itself in the log');

  clock += 61_000;
  await watch.pass();
  assert.equal(events().length, 2);
  assert.equal(events()[1]!.suppressed, 3, 'the held-back failures were not counted');
  assert.equal(events()[1]!.consecutive, 5);

  // And the other half of the story, which an operator reading only errors
  // would otherwise never get.
  readable = true;
  await watch.pass();
  assert.equal(events().length, 3);
  assert.equal(events()[2]!.level, 'info');
  assert.equal(events()[2]!.msg, 'the record reads again');
  assert.equal(events()[2]!.afterFailures, 5);

  watch.stop();
});

// ---------------------------------------------------------------------------
// One line per request (USER-TESTING.md T3.4)
// ---------------------------------------------------------------------------

test('logging: one line per request — method, path, status, duration and the actor', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => void lines.push(line), level: 'debug' });
  const server = attachRequestLog(
    attachReadiness(createApi(store, null, undefined, null, log), [databaseCheck(db)], { cacheMs: 0 }),
    log,
  );
  const base = await listening(server);
  try {
    const question = 'when is the appeals deadline for a denied claim';
    await fetch(`${base}/search?q=${encodeURIComponent(question)}`, {
      headers: {
        'x-actor-id': dana.id,
        cookie: 'canon_session=sess-1234.d1ffe1e5',
      },
    });
    await fetch(`${base}/ready`);

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((e) => e.msg === 'request');
    assert.equal(events.length, 2, JSON.stringify(events));

    const search = events[0]!;
    assert.equal(search.method, 'GET');
    assert.equal(search.path, '/search');
    assert.equal(typeof search.status, 'number');
    assert.equal(typeof search.ms, 'number');
    assert.equal(search.actor, dana.id, 'the resolved actor is what joins this line to the audit log');
    assert.equal(search.level, 'info');

    // The probe is a probe, whatever it answers: a load balancer asks every
    // second and an operator turned this on to see people, not health checks.
    assert.equal(events[1]!.path, '/ready');
    assert.equal(events[1]!.level, 'debug');

    // The whole of the privacy decision, asserted rather than described.
    const everything = lines.join('\n');
    for (const forbidden of [question, 'appeals', 'q=', 'canon_session', 'd1ffe1e5']) {
      assert.equal(everything.includes(forbidden), false, `${forbidden} appeared in the request log:\n${everything}`);
    }
  } finally {
    server.close();
    db.close();
  }
});

test('logging: the request line and the error line carry the id the caller was given', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  (store as unknown as { listCollections: () => never }).listCollections = () => {
    throw new Error('SQLITE_ERROR: no such column: secret');
  };
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => void lines.push(line), level: 'debug' });
  const server = attachRequestLog(createApi(store, null, undefined, null, log), log);
  const base = await listening(server);
  try {
    const res = await fetch(`${base}/collections`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { errorId: string };

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const request = events.find((e) => e.msg === 'request')!;
    assert.equal(request.status, 500);
    assert.equal(request.level, 'warn', 'a 5xx belongs above the noise floor');
    assert.equal(request.errorId, body.errorId, 'a bug report quoting the id does not join to its request');

    const failure = events.find((e) => e.msg === 'unhandled request error')!;
    assert.equal(failure.level, 'error');
    assert.equal(failure.errorId, body.errorId);
    assert.match(String(failure.error), /SQLITE_ERROR/, 'the detail is on the server, where it belongs');
  } finally {
    server.close();
    db.close();
  }
});

test('logging: requestPath keeps the path and loses the query string', () => {
  assert.equal(requestPath('/pages/8f14e45f/versions/3'), '/pages/8f14e45f/versions/3');
  assert.equal(requestPath('/search?q=what%20is%20our%20notice%20period'), '/search');
  assert.equal(requestPath('/auth/callback?code=live-authorization-code&state=x'), '/auth/callback');
  assert.equal(requestPath(undefined), '/');
  assert.equal(requestPath('/' + 'a'.repeat(400)).length, 257, 'an unbounded path is an unbounded log line');
});

// ---------------------------------------------------------------------------
// The configuration reference claims completeness (USER-TESTING.md T3.5)
// ---------------------------------------------------------------------------

test('configuration: every variable the code reads is named in CONFIGURATION.md', () => {
  const root = repoRoot();
  const reference = readFileSync(join(root, 'CONFIGURATION.md'), 'utf8');
  const roots = [join(root, 'server', 'src'), join(root, 'server', 'scripts')];
  const found = new Set<string>();
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.ts')) continue;
      for (const match of readFileSync(join(root, name), 'utf8').matchAll(/\bCANON_[A-Z0-9_]+\b/g)) {
        found.add(match[0]);
      }
    }
  }
  assert.ok(found.size > 30, 'the scan found almost nothing, so it is not scanning the source');
  const missing = [...found].filter((name) => !reference.includes(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `CONFIGURATION.md says it is "every environment variable Canon reads, gathered from the code rather than ` +
      `from memory". These are read by the code and are not in it: ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Start-up configuration validation
// ---------------------------------------------------------------------------

const resolves = async (): Promise<void> => {};
const neverResolves = async (host: string): Promise<never> => {
  throw new Error(`getaddrinfo ENOTFOUND ${host}`);
};

/** A configuration a real deployment could actually have. */
function sound(): NodeJS.ProcessEnv {
  return {
    CANON_OIDC_ISSUER: 'https://idp.example.com',
    CANON_OIDC_CLIENT_ID: 'veryl-canon',
    CANON_OIDC_CLIENT_SECRET: 'a-real-secret-value',
    CANON_SESSION_SECRET: 'thirty-two-characters-of-entropy!',
    CANON_BASE_URL: 'https://canon.example.com',
    CANON_MAINTENANCE_ACTOR_ID: 'ops-actor',
  };
}

test('startup: a sound configuration validates with no problems', async () => {
  const report = await validateConfig(sound(), { resolve: resolves });
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
});

test('startup: SSO with no session secret is refused, naming the variable', async () => {
  const env = sound();
  delete env.CANON_SESSION_SECRET;
  const report = await validateConfig(env, { resolve: resolves });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.problems.map((p) => p.variable),
    ['CANON_SESSION_SECRET'],
  );
  assert.match(report.problems[0]!.message, /signs everybody out/);
});

test('startup: dev authentication beside a real identity provider is refused', async () => {
  const env = { ...sound(), CANON_DEV_AUTH: 'true' };
  const report = await validateConfig(env, { resolve: resolves });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.variable === 'CANON_DEV_AUTH'));
  assert.match(report.problems.find((p) => p.variable === 'CANON_DEV_AUTH')!.message, /any actor they name/);

  // Alone, it is the development setting it has always been — a warning at most.
  const devOnly = await validateConfig({ CANON_DEV_AUTH: 'true' }, { resolve: resolves });
  assert.equal(devOnly.ok, true);
});

test('startup: dev authentication on a public bind is refused, and loopback is fine', async () => {
  // The exact posture a privacy review demonstrated against: the unverified
  // header exposed to a network. Forcing it public is a refusal.
  const exposed = await validateConfig(
    { CANON_DEV_AUTH: 'true', CANON_BIND: '0.0.0.0' },
    { resolve: resolves },
  );
  assert.equal(exposed.ok, false);
  const problem = exposed.problems.find((p) => p.variable === 'CANON_BIND');
  assert.ok(problem, 'the refusal names CANON_BIND');
  assert.match(problem!.message, /reachable from the network/);

  // A specific external address is refused for the same reason.
  const specific = await validateConfig(
    { CANON_DEV_AUTH: 'true', CANON_BIND: '10.0.0.7' },
    { resolve: resolves },
  );
  assert.equal(specific.ok, false);

  // Loopback, explicit or resolved, is exactly the safe default: no refusal.
  for (const host of ['127.0.0.1', '::1', 'localhost', '127.0.0.5']) {
    const loop = await validateConfig({ CANON_DEV_AUTH: 'true', CANON_BIND: host }, { resolve: resolves });
    assert.equal(loop.ok, true, `${host} is loopback and must be allowed`);
  }
});

test('startup: the bind host is loopback exactly when the dev header is the only door', () => {
  // Dev auth alone → loopback, so the demo stack is never reachable off-box.
  assert.equal(resolveBindHost({ CANON_DEV_AUTH: 'true' }), '127.0.0.1');
  // A real door alongside it means the deployment is meant to be reachable.
  assert.equal(resolveBindHost({ CANON_DEV_AUTH: 'true', CANON_OIDC_ISSUER: 'https://idp' }), '0.0.0.0');
  assert.equal(resolveBindHost({ CANON_DEV_AUTH: 'true', CANON_REGISTRY_URL: 'https://reg' }), '0.0.0.0');
  // No dev auth: all interfaces, the behaviour before this guard existed.
  assert.equal(resolveBindHost({ CANON_OIDC_ISSUER: 'https://idp' }), '0.0.0.0');
  assert.equal(resolveBindHost({}), '0.0.0.0');
  // An explicit CANON_BIND always wins — the operator said what they meant.
  assert.equal(resolveBindHost({ CANON_DEV_AUTH: 'true', CANON_BIND: '192.168.1.4' }), '192.168.1.4');
});

test('startup: a federation allowlist naming a host that does not resolve is refused', async () => {
  const env = { ...sound(), CANON_SOURCE_ALLOWED_HOSTS: 'benefits.example.com, *.internal, 10.0.0.7:8080' };
  const report = await validateConfig(env, { resolve: neverResolves });
  assert.equal(report.ok, false);
  const problem = report.problems.find((p) => p.variable === 'CANON_SOURCE_ALLOWED_HOSTS')!;
  assert.ok(problem);
  assert.match(problem.message, /benefits\.example\.com does not resolve/);
  assert.equal(
    report.problems.filter((p) => p.variable === 'CANON_SOURCE_ALLOWED_HOSTS').length,
    1,
    'a wildcard entry and a literal address have nothing to look up and must not be checked',
  );

  const resolving = await validateConfig(env, { resolve: resolves });
  assert.equal(resolving.ok, true);
});

test('startup: SMTP with no sender, a bad URL and a non-numeric interval are each refused', async () => {
  const smtp = await validateConfig({ ...sound(), CANON_SMTP_URL: 'smtp://relay.internal:587' }, { resolve: resolves });
  assert.equal(smtp.ok, false);
  assert.ok(smtp.problems.some((p) => p.variable === 'CANON_MAIL_FROM'));

  const badUrl = await validateConfig({ ...sound(), CANON_REGISTRY_URL: 'not a url' }, { resolve: resolves });
  assert.equal(badUrl.ok, false);
  assert.ok(badUrl.problems.some((p) => p.variable === 'CANON_REGISTRY_URL'));

  const badNumber = await validateConfig({ ...sound(), CANON_FLUSH_INTERVAL_MS: 'hourly' }, { resolve: resolves });
  assert.equal(badNumber.ok, false);
  assert.ok(badNumber.problems.some((p) => p.variable === 'CANON_FLUSH_INTERVAL_MS'));
});

test('startup: an identity provider with nowhere to send people back to is refused', async () => {
  const env = sound();
  delete env.CANON_BASE_URL;
  const report = await validateConfig(env, { resolve: resolves });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.variable === 'CANON_BASE_URL'));

  // …unless the redirect URI is stated outright, which is the other way to mean it.
  const explicit = await validateConfig(
    { ...env, CANON_OIDC_REDIRECT_URI: 'https://canon.example.com/auth/callback' },
    { resolve: resolves },
  );
  assert.equal(explicit.ok, true);
});

test('startup: assertConfigValid throws a ConfigError naming every problem, and returns the warnings', async () => {
  await assert.rejects(
    () => assertConfigValid({ ...sound(), CANON_DEV_AUTH: 'true', CANON_SESSION_SECRET: undefined }, { resolve: resolves }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 2);
      assert.match(err.message, /refused to start/);
      assert.match(err.message, /CANON_SESSION_SECRET/);
      assert.match(err.message, /CANON_DEV_AUTH/);
      assert.match(err.message, /CONFIGURATION\.md/);
      return true;
    },
  );

  // The freshness sweep runs by default now, as Canon's own system actor
  // (system.ts), so an UNSET maintenance actor is the recommended arrangement
  // and warns about nothing. What warns is the reverse of what used to: naming
  // an actor, which puts somebody's name on work the clock did.
  const bare = await assertConfigValid({ CANON_DEV_AUTH: 'true' }, { resolve: resolves });
  assert.equal(
    bare.some((w) => w.variable === 'CANON_MAINTENANCE_ACTOR_ID'),
    false,
    'a deployment that configures nothing has working freshness and needs telling nothing',
  );

  const named = await assertConfigValid(
    { CANON_DEV_AUTH: 'true', CANON_MAINTENANCE_ACTOR_ID: 'a-person' },
    { resolve: resolves },
  );
  const attribution = named.find((w) => w.variable === 'CANON_MAINTENANCE_ACTOR_ID');
  assert.ok(attribution, 'naming a maintenance actor is worth a word about whose name goes in the log');
  assert.match(attribution!.message, /attributed to it/);

  // And turning the timer off is the arrangement that costs the promise.
  const off = await assertConfigValid(
    { CANON_DEV_AUTH: 'true', CANON_FRESHNESS_INTERVAL_MS: '0' },
    { resolve: resolves },
  );
  const stopped = off.find((w) => w.variable === 'CANON_FRESHNESS_INTERVAL_MS');
  assert.ok(stopped);
  assert.match(stopped!.message, /stale knowledge announces itself/);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

test('shutdown: an in-flight request finishes, new ones are refused, and the record is closed', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const server = createServer(async (req, res) => {
    if (req.url === '/slow') {
      await held;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('finished');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('quick');
  });

  const cleared: string[] = [];
  const timer = setInterval(() => cleared.push('fired'), 5);
  let closedRecord = false;
  let exitCode: number | null = null;

  const handle = installGracefulShutdown({
    server,
    timers: [timer],
    timeoutMs: 5000,
    signals: [], // no real signal handlers: a test must not take the runner down
    onDrained: () => {
      closedRecord = true;
    },
    exit: (code) => {
      exitCode = code;
    },
  });

  const base = await listening(server);
  try {
    const inFlight = fetch(`${base}/slow`);
    // Let the request reach the handler before shutting down.
    while (handle.inFlight() === 0) await delay(5);

    const shutting = handle.shutdown('test');
    assert.equal(handle.closing(), true);

    // A new request during the drain is refused rather than queued.
    const refused = await fetch(`${base}/quick`).catch(() => null);
    if (refused) assert.equal(refused.status, 503, 'a new request was accepted while shutting down');

    release();
    const response = await inFlight;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'finished', 'the in-flight request was cut off');

    await shutting;
    assert.equal(closedRecord, true, 'the record was not closed');
    assert.equal(exitCode, 0, 'a clean drain must exit 0');

    const before = cleared.length;
    await delay(30);
    assert.equal(cleared.length, before, 'a timer kept firing after shutdown');
  } finally {
    clearInterval(timer);
    server.close();
  }
});

test('shutdown: a request that will not finish is given a deadline, not forever', async () => {
  const server = createServer(() => {
    /* never responds */
  });
  let exitCode: number | null = null;
  const handle = installGracefulShutdown({
    server,
    timeoutMs: 150,
    signals: [],
    exit: (code) => {
      exitCode = code;
    },
  });
  const base = await listening(server);
  try {
    const stuck = fetch(`${base}/hangs`).catch(() => null);
    while (handle.inFlight() === 0) await delay(5);
    await handle.shutdown('test');
    assert.equal(exitCode, 1, 'an unclean drain must be distinguishable from a clean one');
    await stuck;
  } finally {
    server.close();
  }
});

test('shutdown: calling it twice runs the sequence once', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  let closes = 0;
  const handle = installGracefulShutdown({
    server,
    signals: [],
    onDrained: () => {
      closes++;
    },
    exit: () => {},
  });
  await listening(server);
  await Promise.all([handle.shutdown('a'), handle.shutdown('b')]);
  assert.equal(closes, 1);
  server.close();
});

// ---------------------------------------------------------------------------
// Logging: no secrets
// ---------------------------------------------------------------------------

test('logging: a relay URL with a password in it never reaches a log line', () => {
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => lines.push(line), level: 'debug' });

  const smtp = 'smtp://canon:hunter2@relay.internal:587?starttls=required';
  log.info(`connecting to ${smtp}`);
  log.info('mail configured', { url: smtp, from: 'canon@example.com' });
  log.error('relay refused', { error: `550 from ${smtp}` });
  log.warn('registry', { registry: 'https://svc:s3cr3t@registry.veryl.example/verify' });
  log.info('a token went past', { detail: 'Authorization: Bearer abcdef.ghijkl.mnopqr' });
  log.info('client', { CANON_OIDC_CLIENT_SECRET: 'oidc-secret-value', clientId: 'veryl-canon' });
  log.info('passport=pp_live_9f1c33 presented');

  const everything = lines.join('\n');
  for (const secret of ['hunter2', 's3cr3t', 'abcdef.ghijkl.mnopqr', 'oidc-secret-value', 'pp_live_9f1c33']) {
    assert.equal(everything.includes(secret), false, `${secret} appeared in a log line:\n${everything}`);
  }
  // …and what is left is still useful.
  assert.match(everything, /relay\.internal:587/);
  assert.match(everything, /registry\.veryl\.example/);
  assert.match(everything, /veryl-canon/);
});

test('logging: redactUrl keeps the host and loses the credential', () => {
  assert.equal(redactUrl('smtp://user:pass@relay:587'), 'smtp://user:[redacted]@relay:587');
  assert.equal(redactUrl('https://token@example.com/x'), 'https://token:[redacted]@example.com/x');
  assert.equal(redactUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(redact('client_secret=abc123'), 'client_secret=[redacted]');
  assert.equal(redact('nothing to hide here'), 'nothing to hide here');
});

test('logging: levels are honoured and the format is one JSON object per line', () => {
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => lines.push(line), level: 'warn' });
  log.debug('not this');
  log.info('nor this');
  log.warn('this', { port: 3000 });
  log.error('and this');
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.msg, 'this');
  assert.equal(parsed.port, 3000);
  assert.equal(typeof parsed.at, 'string');
});
