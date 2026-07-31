import { agentAuthFromEnv } from './agentauth.js';
import { createApi } from './api.js';
import { personAuthFromEnv } from './auth.js';
import { assertConfigValid, ConfigError } from './config.js';
import { defaultConnectorRegistry } from './connectors.js';
import { MIGRATIONS, openDb } from './db.js';
import { HttpConnector } from './httpconnector.js';
import { smtpTransportFromEnv } from './email.js';
import { loggerFromEnv, redactUrl } from './log.js';
import { currentSchemaVersion, latestVersion } from './migrate.js';
import { notifierFor } from './notify.js';
import { attachReadiness, readinessChecksFromEnv } from './ready.js';
import { installGracefulShutdown } from './shutdown.js';
import { attachStatic } from './static.js';
import { CanonStore } from './store.js';

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
const store = new CanonStore(db, mail ?? undefined, undefined, connectors);
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
// Three wrappers, outermost first: static files (the web UI), then readiness,
// then the API. Readiness is deliberately outside api.ts's route table — see
// ready.ts on why liveness and readiness are different questions.
const server = attachStatic(
  attachReadiness(createApi(store, agentAuth, undefined, personAuth), readinessChecksFromEnv(db)),
); // web UI from server/public

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

server.listen(port, () => {
  log.info('Veryl Canon listening', {
    port,
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
  log.info('probes', { liveness: 'GET /health', readiness: 'GET /ready' });
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

// The freshness sweep (FEATURES.md §3), on the same pattern as the flush above:
// POST /maintenance/freshness does the same thing on demand, and this timer is
// what makes "stale knowledge announces itself" true without anyone remembering
// to press it. Hourly by default — review dates are days, so a shorter period
// buys nothing and a longer one delays an owner's notice.
//
// It runs only when CANON_MAINTENANCE_ACTOR_ID names the actor it runs as.
// Attribution is universal (DATA-BACKBONE.md §2, principle 5): every flip is an
// audit event, and an audit event with no actor behind it would be the one
// unattributed write in the record. So the deployment names a maintenance actor
// — which must hold admin on a collection, like any other operator — rather
// than Canon inventing a nameless system identity for itself.
const sweepInterval = Number(process.env.CANON_FRESHNESS_INTERVAL_MS ?? 3_600_000);
const sweepActorId = process.env.CANON_MAINTENANCE_ACTOR_ID?.trim();
if (sweepActorId && sweepInterval > 0) {
  const sweepTimer = setInterval(() => {
    try {
      const result = store.sweepFreshness(sweepActorId);
      if (result.flipped > 0) {
        log.info('freshness sweep', { flipped: result.flipped, notified: result.notified });
      }
    } catch (err) {
      log.error('freshness sweep failed', { error: (err as Error).message });
    }
  }, sweepInterval);
  sweepTimer.unref();
  timers.push(sweepTimer);
} else if (!sweepActorId) {
  log.info(
    'no maintenance actor configured (CANON_MAINTENANCE_ACTOR_ID unset): the freshness sweep runs only on ' +
      'POST /maintenance/freshness',
  );
}
