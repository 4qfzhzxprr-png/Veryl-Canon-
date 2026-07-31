// The TLS half of the pinning proof, run in its own process.
//
// `pinning.test.ts` spawns this with NODE_EXTRA_CA_CERTS pointing at the test
// certificate — the only way to make a certificate trusted, since Node reads
// that variable at start-up. Here the certificate, issued for `pinned.example`
// alone, is served on 127.0.0.1, and the real connector is driven at it twice
// with the socket pinned to that same correct address: once under the name the
// certificate carries, once under a name it does not. The result is printed as
// one line of JSON for the parent to assert on.
//
// This file is not a test suite (the runner's glob is `*.test.js`); it is the
// fixture that test needs a separate process for.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ConnectorError, HttpConnector } from '../src/httpconnector.js';
import { outboundPolicyFromEnv } from '../src/outbound.js';

interface Outcome {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

const [certPath, keyPath] = process.argv.slice(2);
if (!certPath || !keyPath) throw new Error('usage: tlspin-child.js <cert.pem> <key.pem>');

const server = createServer(
  { cert: readFileSync(certPath), key: readFileSync(keyPath) },
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'PLAN-7', selector: 'deductible', value: 1500 }));
  },
);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

const connector = new HttpConnector({
  serviceIdentity: 'svc-canon',
  requestTimeoutMs: 5000,
  outbound: outboundPolicyFromEnv({
    CANON_SOURCE_ALLOWED_HOSTS: 'pinned.example wrong.example',
    // The certificate is served on loopback, so the development opt-in is on.
    // It relaxes which addresses are permitted; it does not relax the pin.
    CANON_SOURCE_ALLOW_PRIVATE: 'true',
  } as NodeJS.ProcessEnv),
  // Both names pin to the same, correct address. The only difference between
  // the two attempts below is the name the certificate is judged against.
  resolver: async () => [{ address: '127.0.0.1', family: 4 }],
});

async function attempt(hostname: string): Promise<Outcome> {
  try {
    const resolved = await connector.resolve(
      {
        id: 'src-1',
        name: 'Benefits Admin',
        kind: 'http',
        baseUrl: `https://${hostname}:${port}`,
        authMode: 'service',
        freshnessWindowMs: 0,
      },
      { selector: 'deductible', key: 'PLAN-7', asker: null },
    );
    return { ok: true, value: resolved.value };
  } catch (err) {
    const failure = err as ConnectorError;
    return { ok: false, code: failure.code, message: failure.message };
  }
}

const matching = await attempt('pinned.example');
const mismatched = await attempt('wrong.example');
server.close();
process.stdout.write(`${JSON.stringify({ matching, mismatched })}\n`);
