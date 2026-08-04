import { agentAuthFromEnv } from './agentauth.js';
import { createApi } from './api.js';
import { personAuthFromEnv } from './auth.js';
import { assertConfigValid, ConfigError, resolveBindHost } from './config.js';
import { defaultConnectorRegistry } from './connectors.js';
import { MIGRATIONS, openDb } from './db.js';
import { DEFAULT_SWEEP_INTERVAL_MS, startFreshnessSweeps } from './freshness.js';
import { headAnchorOptionsFromEnv, startHeadAnchors } from './headanchor.js';
import { HttpConnector } from './httpconnector.js';
import { smtpTransportFromEnv } from './email.js';
import { attachRequestLog, loggerFromEnv, redactUrl, requestLogEnabled } from './log.js';
import { attachMetrics, Metrics, metricsEnabled } from './metrics.js';
import { currentSchemaVersion, latestVersion } from './migrate.js';
import { notifierFor } from './notify.js';
import { attachReadiness, readinessChecksFromEnv, recordChecks, startRecordWatch } from './ready.js';
import { scheduledBackupOptionsFromEnv, startScheduledBackups } from './scheduledbackup.js';
import { installGracefulShutdown } from './shutdown.js';
import { attachStatic } from './static.js';
import { CanonStore } from './store.js';
import { embeddingProviderFromEnv } from './embeddingproviders.js';

const log = loggerFromEnv();

// Configuration validation, before anything is opened and long before a port is
// bound (config.ts). A deployment whose settings cannot mean what they say —
// single sign-on with no session secret, the dev door beside a real identity
// provider, an allowlist naming a host that does not resolve — is refused here
// with the variable named, rather than starting cleanly and failing in front of
// a partner at the first sign-in.
let warnings;
try {
  warnings = await assertConfigValid(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    // Written whole to stderr rather than as a log event: this is the last
    // thing the operator sees, and it is meant to be read, not parsed.
    process.stderr.write(err.message + '\n');
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

const dbPath = process.env.CANON_DB ?? 'canon.db';
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
// Email delivery is configuration, not code: with CANON_SMTP_URL set,
// notifications go out by SMTP; without it the dev transport logs them,
// exactly as before. See server/README.md for the environment variables.
const mail = smtpTransportFromEnv();
// Federation (DATA-BACKBONE.md §6). The registry ships with the hermetic
// static connector only, so without this a deployment could federate against
// nothing real. The HTTP connector handles sources of kind 'http': a record
// system queried by key, with the asking actor carried in a header for
// per_asker sources. CANON_SOURCE_SERVICE_IDENTITY is what a `service` source
// presents; absent, a service source fails visibly rather than resolving
// anonymously, which is the correct refusal.
const connectors = defaultConnectorRegistry().register(
  new HttpConnector({
    serviceIdentity: process.env.CANON_SOURCE_SERVICE_IDENTITY,
    requestTimeoutMs: Number(process.env.CANON_SOURCE_TIMEOUT_MS ?? 3000),
  }),
);
// Semantic retrieval (DATA-BACKBONE.md §5). Without CANON_EMBEDDINGS this is
// the built-in hashed bag of words: hermetic, dependency-free, and no kind of
// semantic — see embeddingproviders.ts for what the other two settings buy and
// what each one costs. A model change re-derives the index from the record,
// because two models are two unrelated vector spaces.
const embeddings = embeddingProviderFromEnv();
const store = new CanonStore(db, mail ?? undefined, embeddings ?? undefined, connectors);
// Agent Passport authentication is live only when a Registry is configured
// (CANON_REGISTRY_URL); otherwise Canon runs in dev mode, X-Actor-Id only.
const agentAuth = agentAuthFromEnv(db, store);
// The people-facing door (auth.ts): SSO when CANON_OIDC_ISSUER is set, the
// X-Actor-Id stand-in when CANON_DEV_AUTH=true, and nothing at all otherwise.
// Assembled here so a deployment's identity configuration is read once, at
// start-up, and announced below rather than discovered on the first request.
const personAuth = personAuthFromEnv(db, store);
// The limiter slot sits between the two doors: rate limiting (ratelimit.ts)
// and person authentication (auth.ts) landed in the same round, each adding a
// parameter. Default limiter, explicit personAuth.
//
// Four wrappers, outermost first: the request log, then static files (the web
// UI), then readiness, then the API. Readiness is deliberately outside api.ts's
// route table — see ready.ts on why liveness and readiness are different
// questions — and the request log is outside everything, so a static file and a
// probe are logged exactly as an API call is. Turned off with
// CANON_REQUEST_LOG=off, for a deployment whose front door already writes one.
const api = createApi(store, agentAuth, undefined, personAuth, log);
// HSTS is pinned only when the operator's base URL says the edge is HTTPS —
// see securityHeaders in static.ts for why sending it over plain HTTP is
// pointless and sending it over a real TLS edge is the whole point.
const secureEdge = (process.env.CANON_BASE_URL ?? '').trim().startsWith('https://');
const served = attachStatic(
  attachReadiness(api, readinessChecksFromEnv(db, process.env, { path: dbPath })),
  undefined,
  secureEdge,
);

// Metrics (metrics.ts), off unless CANON_METRICS is on. It measures every
// request — static, readiness and API alike — and serves the scrape at
// /metrics. The gauges are read at scrape time so none is a cached lie; each
// is aggregate operational data, never a page id or a secret.
const metrics = new Metrics();
const metricsOn = metricsEnabled();
metrics.registerGauge('canon_build_info', 'Build and runtime identity; value is always 1.', () => [
  {
    labels: {
      version: String(currentSchemaVersion(db)),
      schema_expected: String(latestVersion(MIGRATIONS)),
      node: process.version,
      stage: 'alpha',
    },
    value: 1,
  },
]);
metrics.registerGauge('canon_uptime_seconds', 'Seconds since this process started.', () => [
  { value: Math.round(process.uptime()) },
]);
metrics.registerGauge('canon_schema_version', 'The schema version this record is at.', () => [
  { value: currentSchemaVersion(db) },
]);
metrics.registerGauge('canon_record_readable', 'Whether a trivial read of the record succeeds right now (1) or not (0).', () => {
  try {
    db.prepare('SELECT 1').get();
    return [{ value: 1 }];
  } catch {
    return [{ value: 0 }];
  }
});
metrics.registerGauge('canon_audit_events_total', 'Events in the append-only audit log.', () => [
  { value: (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n },
]);
metrics.registerGauge('process_resident_memory_bytes', 'Resident set size of this process.', () => [
  { value: process.memoryUsage().rss },
]);
const measured = attachMetrics(served, metrics, metricsOn);

// A metrics scrape is a probe, so it is logged like /health and /ready — at
// debug, not as one more info line a second.
const server = requestLogEnabled()
  ? attachRequestLog(measured, log, { quiet: ['/health', '/ready', '/metrics'] })
  : measured;

// The timers, held so shutdown can clear them. Both are created below.
const timers: NodeJS.Timeout[] = [];

// Graceful shutdown (shutdown.ts), installed before the server listens so a
// SIGTERM during start-up is still handled: stop accepting, finish what is in
// flight, clear the timers, close the record.
installGracefulShutdown({
  server,
  timers,
  timeoutMs: Number(process.env.CANON_SHUTDOWN_TIMEOUT_MS ?? 10_000),
  log,
  onDrained: () => {
    db.close(); // checkpoints the WAL: this is what makes the next start clean
    log.info('record closed', { db: dbPath });
  },
});

// The freshness sweep (FEATURES.md §3), on the same pattern as the outbox flush
// below: POST /maintenance/freshness does the same thing on demand, and this
// timer is what makes "stale knowledge announces itself" true without anyone
// remembering to press it. Hourly by default — review dates are days, so a
// shorter period buys nothing and a longer one delays an owner's notice.
//
// Unlike the flush, it runs on EVERY deployment, configured or not, and its
// first pass is immediate — which is why it sits BEFORE `listen`. A record that
// has been down for a week must not serve one request presenting a page as
// Canonical that its own review date says is overdue.
//
// It used to run only where CANON_MAINTENANCE_ACTOR_ID named an actor, so the
// product's central claim about staleness was false of every deployment that had
// not read this log — and the flips it did make were attributed to whichever
// person that variable named, in a log whose value is that it does not say
// people did things they did not do. Both are fixed in freshness.ts, where
// startFreshnessSweeps argues the whole thing; a deployment that deliberately
// names a maintenance actor still gets exactly what it asked for.
// The record watch (ready.ts). A readiness answer is only as loud as somebody
// asking for it, and in USER-TESTING.md T3.3 nobody was: the orchestrator was
// pointed at `/health`, so a Canon that could not read its own record kept
// accepting connections, refused every one of them, and wrote nothing down.
// This asks the record's own checks every few seconds and logs an error, rate
// limited, when the answer is no. It does not exit; ready.ts argues why.
//
// Before `listen`, so a record that is already unreadable is said out loud
// rather than announced as a healthy start-up.
const recordWatch = startRecordWatch(recordChecks(db, { path: dbPath }), {
  intervalMs: Number(process.env.CANON_RECORD_WATCH_INTERVAL_MS ?? 10_000),
  log,
});
if (recordWatch.timer) timers.push(recordWatch.timer);

// The head anchor (headanchor.ts, USER-TESTING.md T3.2). Canon cannot prove its
// own log to itself — a competent forgery recomputes every link and verifies
// clean — so the only thing worth building is the value an operator ships off
// the box: `(headEventId, headHash, takenAt)`, on a schedule, in a shape a log
// collector or a cron line can carry away.
//
// Before `listen`, like the record watch, so the first anchor describes the head
// as it was BEFORE this run served anything. That is the anchor that bounds the
// whole run.
//
// It is deliberately not sold as more than it is, here or anywhere else: the
// line below is written by Canon, to Canon's log, and Canon could rewrite it.
// Only the copy that leaves this machine is evidence.
const anchors = startHeadAnchors(headAnchorOptionsFromEnv(db, log));
if (anchors.timer) timers.push(anchors.timer);

const sweeps = startFreshnessSweeps(store, {
  intervalMs: Number(process.env.CANON_FRESHNESS_INTERVAL_MS ?? DEFAULT_SWEEP_INTERVAL_MS),
  actorId: process.env.CANON_MAINTENANCE_ACTOR_ID,
  mailConfigured: Boolean(mail),
  log,
});
if (sweeps.timer) timers.push(sweeps.timer);

// The scheduled backup (scheduledbackup.ts). Off unless CANON_BACKUP_INTERVAL_MS
// names a period and CANON_BACKUP_DIR names a destination — config.ts refuses
// the first without the second. It reuses the same verified VACUUM INTO the CLI
// does, on the record's own connection, and lands the artefact on local disk
// only: shipping it off the box stays the operator's act (OPERATIONS.md). Held
// so shutdown clears it.
const backups = startScheduledBackups(scheduledBackupOptionsFromEnv(db, log));
if (backups.timer) timers.push(backups.timer);
if (metricsOn) {
  log.info('metrics endpoint enabled', {
    path: '/metrics',
    note: 'aggregate operational data, no PII — let only your scraper reach it (CONFIGURATION.md)',
  });
} else {
  log.info('no metrics endpoint', { reason: 'CANON_METRICS is unset; set it to on to expose /metrics' });
}
if (backups.schedule.scheduled) {
  log.info('scheduled backups running', {
    everyMs: backups.schedule.intervalMs,
    directory: backups.schedule.directory,
    keep: backups.schedule.keep,
    note: 'local disk only — ship each artefact off the box (OPERATIONS.md)',
  });
} else {
  log.info('no scheduled backup', { reason: backups.schedule.reason });
}

// The interface to bind. Loopback when the unverified dev header is the only
// door, so the demo stack is never reachable off-box; the operator's
// CANON_BIND, or all interfaces, once a real door is configured (config.ts).
const bindHost = resolveBindHost();
server.listen(port, bindHost, () => {
  log.info('Veryl Canon listening', {
    port,
    host: bindHost,
    db: dbPath,
    stage: 'alpha',
    schemaVersion: currentSchemaVersion(db),
    schemaExpected: latestVersion(MIGRATIONS),
    pid: process.pid,
    node: process.version,
  });
  for (const warning of warnings) {
    log.warn('configuration', { variable: warning.variable, detail: warning.message });
  }
  // Which doors are open, said out loud. A deployment must never have to read
  // the code to find out whether it is running open (SECURITY.md R1), so this
  // is deliberately noisy and deliberately alarming when it should be.
  if (personAuth.oidc) {
    log.info('single sign-on live', {
      issuer: personAuth.oidc.config.issuer,
      clientId: personAuth.oidc.config.clientId,
      redirectUri: personAuth.oidc.config.redirectUri,
    });
  } else {
    log.info('no identity provider configured (CANON_OIDC_ISSUER unset): people cannot sign in with SSO');
  }
  if (personAuth.devAuth) {
    log.warn(
      '*** CANON_DEV_AUTH=true: the X-Actor-Id header is accepted and NOTHING ABOUT IT IS VERIFIED. ' +
        'Anyone who can reach this port is any actor they name, and POST /actors is open. ' +
        'This is for local work and tests. Never run it where a real corpus lives. ***',
    );
  } else {
    log.info('dev authentication is off (CANON_DEV_AUTH unset): X-Actor-Id is refused, POST /actors does not exist');
  }
  if (!personAuth.oidc && !personAuth.devAuth && !agentAuth) {
    log.warn('no door is open: set CANON_OIDC_ISSUER, CANON_DEV_AUTH or CANON_REGISTRY_URL, or nobody can do anything');
  }
  if (personAuth.oidc) {
    // R9. Said out loud beside the agent guarantee below, because they are now
    // the same promise made twice and an operator should be able to compare
    // them without reading the code.
    console.log(
      personAuth.confirmWindowMs === 0
        ? 'Sessions are confirmed with the identity provider on EVERY request'
        : `Sessions are confirmed with the identity provider at least every ${personAuth.confirmWindowMs}ms ` +
            '(the ceiling is 60000ms and is the revocation guarantee, not a tuning knob)',
    );
  }
  // R10. A mapping is deployment configuration, so what it says is announced
  // where the rest of the deployment's configuration is announced.
  if (personAuth.mapping.rules.length > 0) {
    console.log(
      `Group mapping live: ${personAuth.mapping.rules.length} rule(s) from the '${personAuth.mapping.claim}' claim ` +
        '(GET /auth/mapping to read them, GET /auth/access/:actorId to ask why somebody holds what)',
    );
    for (const rule of personAuth.mapping.rules) {
      if (rule.target === 'org' && rule.orgRole === 'administrator') {
        console.warn(
          `*** Group '${rule.group}' grants the ADMINISTRATOR role for this Canon. Anyone your identity ***\n` +
            '*** provider puts in that group can administer permissions here.                            ***',
        );
      }
    }
  }
  if (personAuth.oidc && personAuth.ephemeralSecret) {
    log.warn(
      'CANON_SESSION_SECRET is unset: session cookies are signed with a key invented at start-up, ' +
        'so every restart signs everybody out and no second instance can read this one’s cookies',
    );
  }
  if (agentAuth) {
    // redactUrl, not the raw string: a Registry URL is operator input and
    // could carry userinfo. Nothing in this process prints a credential.
    log.info('agent passport authentication live', {
      registry: redactUrl(agentAuth.registry.baseUrl),
      reverifyWithinMs: agentAuth.registry.cacheTtlMs,
    });
  } else {
    log.info('no Registry configured (CANON_REGISTRY_URL unset): Agent Passports refused');
  }
  // Freshness, said out loud beside the doors, because it is the same kind of
  // fact: what this deployment will actually do, rather than what the feature
  // does in principle. `GET /maintenance/freshness` answers the same question to
  // the person in the editor, who is the one the answer is really for.
  if (sweeps.schedule.scheduled) {
    log.info('freshness sweep running', {
      everyMs: sweeps.schedule.intervalMs,
      as: sweeps.schedule.actor?.name,
      actorId: sweeps.schedule.actor?.id,
      actorKind: sweeps.schedule.actor?.kind,
      ownerNotice: sweeps.schedule.ownerNotice,
      firstPassFlipped: sweeps.first?.flipped ?? 0,
    });
    if (sweeps.schedule.ownerNotice === 'outbox') {
      log.info(
        'no mail relay configured (CANON_SMTP_URL unset): a past-review notice is written to the outbox and ' +
          'readable at GET /notifications, and nothing carries it to the owner. The editor says so.',
      );
    }
  } else {
    log.warn('freshness sweep NOT running', { detail: sweeps.schedule.reason });
  }
  // Anchoring, said out loud beside the sweep, and said with its caveat: an
  // operator who reads "anchoring on" and stops there has a scheduled log line
  // and no anchor at all.
  if (anchors.schedule.scheduled) {
    log.info('audit head anchor running', {
      everyMs: anchors.schedule.intervalMs,
      sink: anchors.schedule.sink,
      file: anchors.schedule.file,
      headEventId: anchors.first?.headEventId ?? null,
      shipItOffBox:
        'this line is inside Canon’s trust boundary and proves nothing here; carry a copy somewhere Canon ' +
        'cannot write (OPERATIONS.md, "Anchor the chain head")',
    });
  } else {
    log.warn('audit head anchor NOT running', { detail: anchors.schedule.reason });
  }
  log.info('probes', {
    liveness: 'GET /health',
    readiness: 'GET /ready',
    recordWatchMs: recordWatch.timer ? Number(process.env.CANON_RECORD_WATCH_INTERVAL_MS ?? 10_000) : 0,
    requestLog: requestLogEnabled() ? 'one line per request at info; 5xx at warn; probes at debug' : 'off',
  });
});

// The outbox delivery pass. POST /notifications/flush does the same thing on
// demand; this timer means a relay that was briefly down costs nobody a
// notification. CANON_FLUSH_INTERVAL_MS=0 turns it off for deployments that
// would rather drive the flush from their own scheduler.
const flushInterval = Number(process.env.CANON_FLUSH_INTERVAL_MS ?? 60_000);
if (mail && flushInterval > 0) {
  const notifier = notifierFor(store);
  const timer = setInterval(() => {
    notifier?.flushPending().catch((err: unknown) => {
      log.error('outbox flush failed', { error: (err as Error).message });
    });
  }, flushInterval);
  timer.unref(); // never hold the process open on the timer alone
  timers.push(timer);
}
