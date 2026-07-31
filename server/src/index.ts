import { agentAuthFromEnv } from './agentauth.js';
import { createApi } from './api.js';
import { openDb } from './db.js';
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
const store = new CanonStore(db, mail ?? undefined);
// Agent Passport authentication is live only when a Registry is configured
// (CANON_REGISTRY_URL); otherwise Canon runs in dev mode, X-Actor-Id only.
const agentAuth = agentAuthFromEnv(db, store);
const server = attachStatic(createApi(store, agentAuth)); // web UI from server/public, API untouched

server.listen(port, () => {
  console.log(`Veryl Canon (alpha) listening on :${port}, record at ${dbPath}`);
  console.log(
    agentAuth
      ? `Agent Passport authentication live against the Registry at ${agentAuth.registry.baseUrl} ` +
          `(re-verify within ${agentAuth.registry.cacheTtlMs}ms)`
      : 'No Registry configured (CANON_REGISTRY_URL unset): dev mode, X-Actor-Id only, Agent Passports refused',
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
