import { createStudioApi } from './api.js';
import { BenefitsApp } from './app.js';
import { KnowledgeClient } from './client.js';

// Configuration is the whole of this app's state. Its passport comes from the
// Veryl Agent Registry (it is registered and certified there, like any agent),
// and Canon's URL is the only other thing it knows.

const port = Number(process.env.PORT ?? 3300);
const canonUrl = process.env.CANON_URL ?? 'http://127.0.0.1:3000';
const passport = process.env.STUDIO_PASSPORT ?? '';
const name = process.env.STUDIO_APP_NAME ?? 'Benefits Assistant';

if (!passport) {
  console.error(
    'STUDIO_PASSPORT is required: register this app in the Veryl Agent Registry, certify it, and pass its Agent Passport.',
  );
  process.exit(1);
}

const app = new BenefitsApp({
  name,
  client: new KnowledgeClient({
    baseUrl: canonUrl,
    passport,
    requestTimeoutMs: Number(process.env.STUDIO_TIMEOUT_MS ?? 5000),
  }),
});

createStudioApi(app).listen(port, () => {
  console.log(`${name} (Veryl Studio app, stub) listening on :${port}, reading Veryl Canon at ${canonUrl}`);
  console.log(
    'Every question is asked on behalf of a named person; this app holds no company knowledge and no permissions of its own.',
  );
});
