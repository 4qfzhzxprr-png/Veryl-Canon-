import { createIdpApi } from './api.js';
import { IdpStore } from './store.js';

const port = Number(process.env.PORT ?? 3200);
const issuer = process.env.IDP_ISSUER ?? `http://127.0.0.1:${port}`;

const store = new IdpStore({ issuer });

// A demonstration wants something to sign in as. Seeding here rather than
// making every run POST /admin/users first is the same courtesy registry-stub
// pays: a stub that needs a setup script is a stub nobody starts.
const client = store.registerClient({
  clientId: process.env.IDP_CLIENT_ID ?? 'veryl-canon',
  clientSecret: process.env.IDP_CLIENT_SECRET ?? 'canon-dev-secret',
  redirectUris: (process.env.IDP_REDIRECT_URIS ?? 'http://127.0.0.1:3000/auth/callback,http://localhost:3000/auth/callback')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
});
store.seedUser({ sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' });
store.seedUser({ sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' });

const server = createIdpApi(store);

server.listen(port, () => {
  console.log(`Veryl Canon IdP (stub) listening on :${port} — state is in-memory and disposable`);
  console.log(`  issuer        ${store.issuer}`);
  console.log(`  discovery     ${store.issuer}/.well-known/openid-configuration`);
  console.log(`  client_id     ${client.clientId}`);
  console.log(`  client_secret ${client.clientSecret}`);
  console.log(`  redirect_uris ${client.redirectUris.join(', ')}`);
  console.log('  users         dana, iris (POST /admin/users to add more)');
  console.log('  THIS IS A TEST DOUBLE. Its administrative face is unauthenticated; never run it anywhere real.');
});
