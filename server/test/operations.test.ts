import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../src/api.js';
import { ConfigError, assertConfigValid, validateConfig } from '../src/config.js';
import { MIGRATIONS, openDb } from '../src/db.js';
import { Logger, redact, redactUrl } from '../src/log.js';
import { latestVersion, type Migration } from '../src/migrate.js';
import {
  attachReadiness,
  databaseCheck,
  doorCheck,
  runReadiness,
  schemaCheck,
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
