// A REAL Canon, started the way an operator starts one.
//
// Not `createApi` in-process: `node dist/server/src/index.js`, the entry point
// a deployment runs, so the proof gets the static file server, the security
// headers, the readiness probe and the configuration validation as well as the
// API. The point of this package is that the thing under test is the thing
// that ships; assembling a convenient subset of it here would put the proof
// back where the unit suites already are.
//
// The record is written BEFORE the server starts, through the built store —
// the same objects `seed-demo` uses — and then the file is handed to the
// server. Nothing in the fixture goes through HTTP, so a fixture that fails
// fails as a fixture rather than as a mysterious empty screen.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SERVER_DIR = join(REPO_ROOT, 'server');
const ENTRY = join(SERVER_DIR, 'dist', 'server', 'src', 'index.js');

/** A port nobody is listening on, asked of the kernel rather than guessed. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function reachable(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // Not up yet. The loop, not an exception, is the answer.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Start a Canon over a freshly built record.
 *
 * `seed` is called with the built module namespace and a `CanonStore` open on
 * the new database; whatever it returns (ids, names) comes back to the caller
 * as `fixture`.
 */
export async function startCanon(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'canon-proof-'));
  const dbPath = join(dir, 'proof.db');

  const { openDb } = await import(join(SERVER_DIR, 'dist', 'server', 'src', 'db.js'));
  const { CanonStore } = await import(join(SERVER_DIR, 'dist', 'server', 'src', 'store.js'));
  const db = openDb(dbPath);
  // Notifications are written to the outbox either way; this keeps the proof
  // from trying to reach a mail relay that is not there.
  const store = new CanonStore(db, { deliver() {} });
  const fixture = await seed(store, { dbPath, serverDir: SERVER_DIR });
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      CANON_DB: dbPath,
      // The dev door, which is what the client's identity picker is for. With
      // it as the only door the server binds loopback of its own accord
      // (config.ts resolveBindHost), so the proof never opens a port off-box.
      CANON_DEV_AUTH: 'true',
      CANON_SKIP_DNS_CHECK: 'true',
      // Timers that would otherwise fire mid-proof and rewrite the record
      // underneath an assertion.
      CANON_FRESHNESS_INTERVAL_MS: '0',
      CANON_FLUSH_INTERVAL_MS: '0',
      CANON_REQUEST_LOG: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const up = await reachable(`${baseUrl}/health`, Date.now() + 20_000);
  if (!up) {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Canon did not come up on ${baseUrl}${exited ? ` (exited ${exited.code}/${exited.signal})` : ''}:\n${log.join('')}`,
    );
  }

  return {
    baseUrl,
    fixture,
    serverLog: () => log.join(''),
    async stop() {
      if (exited === null) {
        const ended = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        // The server installs a graceful shutdown; if it does not take, the
        // proof must still not hang a CI job.
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await ended;
        clearTimeout(timer);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
