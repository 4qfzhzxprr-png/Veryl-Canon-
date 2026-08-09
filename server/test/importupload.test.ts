import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { importSpoolDir } from '../src/import.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

// POST /imports/upload, end to end: the gap the readiness assessment called
// "the difference between a product and a demo with your logo on it" — a
// partner's corpus arriving through the product instead of through whoever
// has shell access. The upload path must be EXACTLY the importer underneath:
// same draft-only arrival, same audit trail, same idempotency — plus a spool
// that never keeps a corpus it finished with.

function findFixtures(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'test', 'fixtures');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('test fixtures not found above the compiled test file');
}

const CONFLUENCE = join(findFixtures(), 'confluence-space');

/** Zip a directory the way export tools do: one wrapping folder inside. */
function zipDir(root: string, wrapper: string): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const add = (name: string, raw: Buffer) => {
    const packed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = raw.length ? crc32(raw) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const at = offset;
    parts.push(local, nameBuf, packed);
    offset += local.length + nameBuf.length + packed.length;
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(at, 42);
    central.push(cd, nameBuf);
  };
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relName);
      else add(`${wrapper}/${relName}`, readFileSync(full));
    }
  };
  walk(root, '');
  const cdBuf = Buffer.concat(central);
  const count = central.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Member Benefits' });
  store.setMember(dana.id, collection.id, marc.id, 'admin');
  return { store, dana, marc, collection };
}

/** Spool an archive the way the request pipeline does, for store-level tests. */
function spooled(zip: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-upload-test-'));
  const path = join(dir, 'archive.zip');
  writeFileSync(path, zip);
  return path;
}

test('upload: a zipped Confluence export lands exactly like an unpacked one', () => {
  const { store, marc, collection } = setup();
  const zip = zipDir(CONFLUENCE, 'BENEFITS-SPACE');
  const summary = store.runImportUpload(marc.id, {
    source: 'confluence',
    collectionId: collection.id,
    archivePath: spooled(zip),
  });

  // The same numbers the directory-path import asserts: the importer under
  // the upload is the importer, not a sibling of it.
  assert.equal(summary.hierarchy, 'tree');
  assert.equal(summary.counts.imported, 6);
  assert.equal(summary.counts.failed, 1, 'the truncated fixture file is reported, not imported');

  const tree = store.tree(marc.id, collection.id);
  assert.deepEqual(tree.map((n) => n.title).sort(), ['Benefits Overview', 'Messy Legacy Page']);

  // The spool kept nothing: no unpack directory under the run id, no archive.
  assert.equal(existsSync(join(importSpoolDir(), summary.runId)), false, 'unpack dir must not outlive the run');
});

test('upload: the same run id twice is one corpus, not two', () => {
  const { store, marc, collection } = setup();
  const zip = zipDir(CONFLUENCE, 'BENEFITS-SPACE');
  const first = store.runImportUpload(marc.id, {
    source: 'confluence', collectionId: collection.id, runId: 'upload-rerun', archivePath: spooled(zip),
  });
  assert.equal(first.counts.imported, 6);
  const again = store.runImportUpload(marc.id, {
    source: 'confluence', collectionId: collection.id, runId: 'upload-rerun', archivePath: spooled(zip),
  });
  assert.equal(again.counts.imported, 0);
  assert.equal(again.counts.skipped >= 6, true, 're-upload of an unchanged corpus skips every page');
});

test('upload: a non-admin costs no unpacking, and the archive does not linger', () => {
  const { store, dana, collection } = setup();
  const viewer = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  store.setMember(dana.id, collection.id, viewer.id, 'view');
  const path = spooled(zipDir(CONFLUENCE, 'SPACE'));
  try {
    store.runImportUpload(viewer.id, { source: 'confluence', collectionId: collection.id, archivePath: path });
    assert.fail('expected forbidden');
  } catch (err) {
    assert.ok(err instanceof CanonError);
    assert.equal(err.code, 'forbidden');
  }
  assert.equal(existsSync(path), false, 'a refused upload is still cleaned out of the spool');
});

test('upload: a traversal runId cannot delete anything outside the spool (S5 A1)', () => {
  // The critical the S5 panel found: runId is a path component of the spool
  // directory the importer rm -rf's in its finally, and the finally runs even
  // when the role check refuses. A no-role caller must NOT be able to delete
  // an arbitrary tree — the request refuses, and the victim survives.
  const { store, dana, collection } = setup();
  const outsider = store.createActor({ kind: "person", name: "Mallory", email: "m@example.com" });
  // A sibling directory of the spool that must be untouched.
  const spool = importSpoolDir();
  mkdirSync(spool, { recursive: true });
  const victim = mkdtempSync(join(dirname(spool), "victim-"));
  writeFileSync(join(victim, "keep.txt"), "important");
  const traversal = `../${victim.split(sep).pop()}`;
  try {
    store.runImportUpload(outsider.id, {
      source: "confluence", collectionId: collection.id,
      runId: traversal, archivePath: spooled(Buffer.from("nope")),
    });
    assert.fail("a traversal runId must be refused");
  } catch (err) {
    assert.ok(err instanceof CanonError);
    // Rejected as invalid BEFORE any filesystem work — not a role refusal.
    assert.equal(err.code, "invalid");
  }
  assert.equal(existsSync(join(victim, "keep.txt")), true, "the victim tree must survive");
  rmSync(victim, { recursive: true, force: true });
  void dana;
});

test('upload: `..` and absolute-looking runIds are refused, and a normal one still works', () => {
  const { store, marc, collection } = setup();
  for (const bad of ["..", ".", "a/b", "a\\b", "with space", "x".repeat(201)]) {
    try {
      store.runImportUpload(marc.id, {
        source: "confluence", collectionId: collection.id,
        runId: bad, archivePath: spooled(Buffer.from("nope")),
      });
      assert.fail(`runId ${JSON.stringify(bad)} should be refused`);
    } catch (err) {
      assert.ok(err instanceof CanonError && err.code === "invalid", `for ${JSON.stringify(bad)}`);
    }
  }
  // A plain safe token is fine.
  const zip = zipDir(CONFLUENCE, "SPACE");
  const ok = store.runImportUpload(marc.id, {
    source: "confluence", collectionId: collection.id, runId: "run_2026-08-09.1", archivePath: spooled(zip),
  });
  assert.equal(ok.counts.imported, 6);
});

test('upload: an archive that is not a zip refuses in words and cleans up', () => {
  const { store, marc, collection } = setup();
  const path = spooled(Buffer.from('<html>this is a saved web page, not an export</html>'));
  try {
    store.runImportUpload(marc.id, { source: 'confluence', collectionId: collection.id, archivePath: path });
    assert.fail('expected invalid');
  } catch (err) {
    assert.ok(err instanceof CanonError);
    assert.equal(err.code, 'invalid');
    assert.match(err.message, /end-of-central-directory|Not a ZIP/);
  }
  assert.equal(existsSync(path), false);
});

test('upload: over HTTP, the whole path works and the cap answers in words', async () => {
  const { store, marc, collection } = setup();
  const canon = createApi(store, null);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;
  try {
    const zip = zipDir(CONFLUENCE, 'BENEFITS-SPACE');
    const params = new URLSearchParams({ source: 'confluence', collectionId: collection.id });
    const res = await fetch(`${base}/imports/upload?${params}`, {
      method: 'POST',
      headers: { 'x-actor-id': marc.id, 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
    });
    assert.equal(res.status, 200);
    const summary = (await res.json()) as { counts: { imported: number } };
    assert.equal(summary.counts.imported, 6);

    // The cap refuses mid-stream, names the limit, and points at the knob.
    process.env.CANON_IMPORT_UPLOAD_MAX_BYTES = '64';
    try {
      const over = await fetch(`${base}/imports/upload?${params}`, {
        method: 'POST',
        headers: { 'x-actor-id': marc.id, 'content-type': 'application/zip' },
        body: new Uint8Array(zip),
      }).catch(() => null);
      // The server destroys the connection mid-body; a client that still got
      // an answer got the refusal.
      if (over) {
        assert.equal(over.status, 400);
        const body = (await over.json()) as { message: string };
        assert.match(body.message, /larger than 64 bytes/);
      }
    } finally {
      delete process.env.CANON_IMPORT_UPLOAD_MAX_BYTES;
    }
  } finally {
    await new Promise<void>((resolve) => canon.close(() => resolve()));
  }
});
