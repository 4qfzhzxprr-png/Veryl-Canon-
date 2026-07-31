import { agentAuthFromEnv } from './agentauth.js';
import { createApi } from './api.js';
import { personAuthFromEnv } from './auth.js';
import { defaultConnectorRegistry } from './connectors.js';
import { openDb } from './db.js';
import { HttpConnector } from './httpconnector.js';
import { smtpTransportFromEnv } from './email.js';
import { notifierFor } from './notify.js';
import { attachStatic } from './static.js';
import { CanonStore } from './store.js';

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
const server = attachStatic(createApi(store, agentAuth, undefined, personAuth)); // web UI from server/public

server.listen(port, () => {
  console.log(`Veryl Canon (alpha) listening on :${port}, record at ${dbPath}`);
  // Which doors are open, said out loud. A deployment must never have to read
  // the code to find out whether it is running open (SECURITY.md R1), so this
  // is deliberately noisy and deliberately alarming when it should be.
  if (personAuth.oidc) {
    console.log(
      `Single sign-on live: OpenID Connect against ${personAuth.oidc.config.issuer} ` +
        `as client ${personAuth.oidc.config.clientId}, returning to ${personAuth.oidc.config.redirectUri}`,
    );
  } else {
    console.log('No identity provider configured (CANON_OIDC_ISSUER unset): people cannot sign in with SSO');
  }
  if (personAuth.devAuth) {
    console.warn(
      '*** CANON_DEV_AUTH=true: the X-Actor-Id header is accepted and NOTHING ABOUT IT IS VERIFIED. ***\n' +
        '*** Anyone who can reach this port is any actor they name, and POST /actors is open.        ***\n' +
        '*** This is for local work and tests. Never run it where a real corpus lives.               ***',
    );
  } else {
    console.log('Dev authentication is off (CANON_DEV_AUTH unset): X-Actor-Id is refused, POST /actors does not exist');
  }
  if (!personAuth.oidc && !personAuth.devAuth && !agentAuth) {
    console.warn('No door is open: set CANON_OIDC_ISSUER, CANON_DEV_AUTH or CANON_REGISTRY_URL, or nobody can do anything');
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
    console.warn(
      'CANON_SESSION_SECRET is unset: session cookies are signed with a key invented at start-up, ' +
        'so every restart signs everybody out and no second instance can read this one’s cookies',
    );
  }
  console.log(
    agentAuth
      ? `Agent Passport authentication live against the Registry at ${agentAuth.registry.baseUrl} ` +
          `(re-verify within ${agentAuth.registry.cacheTtlMs}ms)`
      : 'No Registry configured (CANON_REGISTRY_URL unset): Agent Passports refused',
  );
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
      console.error(`[notify] flush failed: ${(err as Error).message}`);
    });
  }, flushInterval);
  timer.unref(); // never hold the process open on the timer alone
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
        console.log(`[freshness] ${result.flipped} page(s) past review → Needs Update, ${result.notified} owner(s) notified`);
      }
    } catch (err) {
      console.error(`[freshness] sweep failed: ${(err as Error).message}`);
    }
  }, sweepInterval);
  sweepTimer.unref();
} else if (!sweepActorId) {
  console.log(
    'No maintenance actor configured (CANON_MAINTENANCE_ACTOR_ID unset): the freshness sweep runs only on ' +
      'POST /maintenance/freshness',
  );
}
