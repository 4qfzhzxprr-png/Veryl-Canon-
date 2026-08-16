import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { attachStatic, requestedFile, resolveUi, type Ui } from '../src/static.js';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';

// Two clients live in this image while the migration runs (web/MIGRATION.md):
// the original in public/, and the React build in public-app/. The rules for
// serving them are the ones worth testing, because every one of them has a
// failure that is silent:
//
//   * a flat-file-only name rule serves the document and 404s every script it
//     names — a blank page with nothing in the log;
//   * `no-cache` on hashed chunks wastes a download per deploy, and `immutable`
//     on index.html serves a document pointing at chunks that no longer exist;
//   * `/classic.html` following the flag would strand the React client's own
//     handoff for unmigrated routes;
//   * and widening the path rule at all is the change that lets a traversal in.

function tempDirs(): { parent: string; classic: string; app: string } {
  const parent = mkdtempSync(join(tmpdir(), 'canon-clients-'));
  // The file that must never be served, one level above both directories.
  writeFileSync(join(parent, 'secret.js'), 'the record\n');

  const classic = join(parent, 'public');
  mkdirSync(classic);
  writeFileSync(join(classic, 'index.html'), '<!doctype html><title>classic</title>');
  writeFileSync(join(classic, 'app.js'), 'export const classic = true;\n');
  writeFileSync(join(classic, 'styles.css'), '.classic{}\n');

  const app = join(parent, 'public-app');
  mkdirSync(app);
  mkdirSync(join(app, 'assets'));
  mkdirSync(join(app, 'fonts'));
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>react</title>');
  writeFileSync(join(app, 'assets', 'index-a1b2c3.js'), 'export const react = true;\n');
  writeFileSync(join(app, 'assets', 'index-a1b2c3.css'), '.react{}\n');
  writeFileSync(join(app, 'fonts', 'geist-latin.woff2'), 'not really a font');
  return { parent, classic, app };
}

async function boot(ui: Ui): Promise<{
  base: string;
  port: number;
  dirs: ReturnType<typeof tempDirs>;
  close: () => Promise<void>;
}> {
  const dirs = tempDirs();
  const store = new CanonStore(openDb(':memory:'));
  const server = attachStatic(createApi(store), {
    publicDir: dirs.classic,
    appDir: dirs.app,
    ui,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    dirs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A request line written straight onto the socket, because fetch and the URL
 *  parser normalise away exactly the inputs an attacker would send. */
function raw(port: number, requestTarget: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: canon\r\nConnection: close\r\n\r\n`);
    });
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (out += chunk));
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// Which document `/` serves
// --------------------------------------------------------------------------

test('CANON_UI=react serves the React document at /, classic serves the original', async () => {
  for (const [ui, expected] of [['react', 'react'], ['classic', 'classic']] as const) {
    const { base, close } = await boot(ui);
    try {
      const res = await fetch(base + '/');
      assert.equal(res.status, 200);
      assert.match(await res.text(), new RegExp(`<title>${expected}</title>`));
    } finally {
      await close();
    }
  }
});

test('/classic.html is the original document whichever client is active', async () => {
  // The React client sends every route it has not taken over to this address.
  // If it followed the flag, the deployment that most needs the handoff — the
  // one running React — would be the one where it loops back to React.
  for (const ui of ['react', 'classic'] as const) {
    const { base, close } = await boot(ui);
    try {
      const res = await fetch(base + '/classic.html');
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>classic<\/title>/);
    } finally {
      await close();
    }
  }
});

test('the original client’s own files stay reachable while React is active', async () => {
  // /classic.html is a document that loads app.js and styles.css. Serving the
  // document without them is a handoff to a blank page.
  const { base, close } = await boot('react');
  try {
    for (const name of ['/app.js', '/styles.css']) {
      const res = await fetch(base + name);
      assert.equal(res.status, 200, `${name} must still be served`);
    }
  } finally {
    await close();
  }
});

// --------------------------------------------------------------------------
// The bundler's output
// --------------------------------------------------------------------------

test('a hashed asset is served, and cached forever', async () => {
  const { base, close } = await boot('react');
  try {
    const js = await fetch(base + '/assets/index-a1b2c3.js');
    assert.equal(js.status, 200, 'the flat-name rule would have 404d this');
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    // The content hash is in the name, so the URL changes when the bytes do.
    assert.match(js.headers.get('cache-control') ?? '', /immutable/);

    const css = await fetch(base + '/assets/index-a1b2c3.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('cache-control') ?? '', /immutable/);
  } finally {
    await close();
  }
});

test('the document is never cached, or a deploy serves one naming deleted chunks', async () => {
  for (const [ui, path] of [['react', '/'], ['classic', '/'], ['react', '/classic.html']] as const) {
    const { base, close } = await boot(ui);
    try {
      const res = await fetch(base + path);
      assert.equal(res.headers.get('cache-control'), 'no-cache', `${ui} ${path}`);
    } finally {
      await close();
    }
  }
});

test('a font ships from its subdirectory but is not claimed to be immutable', async () => {
  // Vite copies public/ verbatim: no content hash in the name, so a long
  // max-age here would pin a stale file to a URL that can be reused.
  const { base, close } = await boot('react');
  try {
    const res = await fetch(base + '/fonts/geist-latin.woff2');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  } finally {
    await close();
  }
});

// --------------------------------------------------------------------------
// The path rule — what widening it must NOT have admitted
// --------------------------------------------------------------------------

test('requestedFile: the two build directories, and nothing else', () => {
  assert.equal(requestedFile('/app.js'), 'app.js');
  assert.equal(requestedFile('/assets/index-a1b2c3.js'), 'assets/index-a1b2c3.js');
  assert.equal(requestedFile('/fonts/geist-latin.woff2'), 'fonts/geist-latin.woff2');

  // A directory no build writes to is not a directory we serve from.
  assert.equal(requestedFile('/src/main.tsx'), null);
  assert.equal(requestedFile('/node_modules/x.js'), null);
  // One level deep and no further.
  assert.equal(requestedFile('/assets/nested/x.js'), null);
});

test('requestedFile: traversal, dotfiles and empty segments are all refused', () => {
  for (const path of [
    '/../secret.js',
    '/assets/../../secret.js',
    '/assets/..',
    '/./app.js',
    '/.env',
    '/assets/.env',
    '/assets//app.js',
    '//app.js',
    '/assets/',
    // Percent-encoded, decoded BEFORE the rules are applied — which is the
    // ordering that matters. Encoding first was the classic way past a check
    // like this one.
    '/%2e%2e%2fsecret.js',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.js',
    // A backslash is a separator on the platform this might one day run on.
    '/..\\secret.js',
    // A malformed escape is not a file name either.
    '/%zz.js',
  ]) {
    assert.equal(requestedFile(path), null, `${path} must not resolve to a file`);
  }
});

test('an encoded traversal on the wire reaches nothing, unnormalised', async () => {
  // Written to the socket by hand: fetch would collapse these before sending,
  // and a test that proves the client is careful proves nothing about us.
  const { port, close } = await boot('react');
  try {
    for (const target of [
      '/%2e%2e%2fsecret.js',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.js',
      '/..%2fsecret.js',
    ]) {
      const response = await raw(port, target);
      assert.ok(!response.includes('the record'), `${target} leaked a file above the served directory`);
      assert.match(response, /^HTTP\/1\.1 404 /, `${target} should have fallen through to the API`);
    }
  } finally {
    await close();
  }
});

test('an unmatched path falls through to the API rather than becoming index.html', async () => {
  // No single-page-app fallback, on purpose: the clients route on the fragment,
  // which never reaches the server. A catch-all here would answer every
  // mistyped API path with an HTML document.
  const { base, close } = await boot('react');
  try {
    const res = await fetch(base + '/pages/does-not-exist');
    // 401, not 404: this IS an API route, and nobody is signed in. Which
    // refusal it is does not matter here — what matters is that the API gave
    // it, so the request was never turned into a document.
    assert.equal(res.status, 401);
    assert.ok(
      !(res.headers.get('content-type') ?? '').includes('text/html'),
      'a JSON surface must not answer with a document',
    );
  } finally {
    await close();
  }
});

test('a request that is not a read is never answered from disk', async () => {
  const { base, close } = await boot('react');
  try {
    const res = await fetch(base + '/assets/index-a1b2c3.js', { method: 'DELETE' });
    assert.notEqual(res.status, 200);
  } finally {
    await close();
  }
});

// --------------------------------------------------------------------------
// Asking for a client that was not built
// --------------------------------------------------------------------------

test('resolveUi: react without a build degrades to classic, and says so', () => {
  const { parent, app } = tempDirs();

  assert.deepEqual(resolveUi('react', app), { ui: 'react' });
  assert.deepEqual(resolveUi(undefined, app), { ui: 'classic' });
  assert.deepEqual(resolveUi('classic', app), { ui: 'classic' });
  assert.deepEqual(resolveUi('  ReAcT  ', app), { ui: 'react' }, 'the value is not case-sensitive');

  // The image was built without the web client. A Canon serving the original UI
  // is a working Canon, so this must not refuse to start — but it must not be
  // silent either, or the operator sets the flag, sees no change, and has
  // nothing to read.
  const missing = resolveUi('react', join(parent, 'never-built'));
  assert.equal(missing.ui, 'classic');
  assert.match(missing.reason ?? '', /CANON_UI=react/);
  assert.match(missing.reason ?? '', /never-built/);
});
