import { agentAuthFromEnv } from './agentauth.js';
import { createApi } from './api.js';
import { openDb } from './db.js';
import { attachStatic } from './static.js';
import { CanonStore } from './store.js';

const dbPath = process.env.CANON_DB ?? 'canon.db';
const port = Number(process.env.PORT ?? 3000);

const db = openDb(dbPath);
const store = new CanonStore(db);
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
