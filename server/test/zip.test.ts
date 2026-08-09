import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { CanonError } from '../src/model.js';
import { MAX_ZIP_ENTRIES, extractZip, readZipEntries } from '../src/zip.js';

// A ZIP WRITER, here in the tests, so the reader is proven against real
// archives rather than against its own assumptions — including archives no
// honest tool would write. Overrides exist precisely to lie: a declared size
// that isn't, an encryption flag, a hostile name.

interface WriteEntry {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  flags?: number;
  declaredSize?: number;
  declaredTotal?: number; // EOCD entry-count override
}

function makeZip(entries: WriteEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const packed = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const crc = raw.length ? crc32(raw) : 0;
    const declared = e.declaredSize ?? raw.length;
    const flags = e.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const localOffset = offset;
    parts.push(local, name, packed);
    offset += local.length + name.length + packed.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, name);
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const total = entries[0]?.declaredTotal ?? entries.length;
  eocd.writeUInt16LE(Math.min(total, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(total, 0xffff), 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function dest(): string {
  return mkdtempSync(join(tmpdir(), 'canon-zip-test-'));
}

function refuses(buf: Buffer, needle: string) {
  const out = dest();
  try {
    extractZip(buf, out);
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, 'invalid');
    assert.match(err.message, new RegExp(needle));
    return err;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.fail(`expected refusal matching /${needle}/, but extraction succeeded`);
}

test('zip: store and deflate entries round-trip, trees and all', () => {
  const out = dest();
  try {
    const zip = makeZip([
      { name: 'space/', data: '', method: 0 },
      { name: 'space/index.html', data: '<html>index</html>' },
      { name: 'space/pages/One.html', data: '<h1>One</h1>', method: 0 },
      { name: 'space/attachments/pic.bin', data: Buffer.from([0, 1, 2, 255]) },
    ]);
    const { files } = extractZip(zip, out);
    assert.equal(files, 3);
    assert.equal(readFileSync(join(out, 'space', 'index.html'), 'utf8'), '<html>index</html>');
    assert.equal(readFileSync(join(out, 'space', 'pages', 'One.html'), 'utf8'), '<h1>One</h1>');
    assert.deepEqual([...readFileSync(join(out, 'space', 'attachments', 'pic.bin'))], [0, 1, 2, 255]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('zip: every hostile name is fatal for the whole archive, and nothing is written', () => {
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:evil.txt', 'a\\b.txt', 'nul\0.txt']) {
    const out = dest();
    try {
      const zip = makeZip([
        { name: 'innocent.html', data: 'fine' },
        { name, data: 'hostile' },
      ]);
      assert.throws(() => extractZip(zip, out), CanonError, name);
      // The friendly entry did not survive its neighbour: directory-level
      // refusals happen before the first byte lands.
      assert.deepEqual(readdirSync(out), [], `refusal for ${name} left files behind`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test('zip: encryption, unknown methods, and ZIP64 are refused by name', () => {
  refuses(makeZip([{ name: 'secret.html', data: 'x', flags: 0x1 }]), 'Encrypted entry');
  refuses(makeZip([{ name: 'odd.html', data: 'x', method: 99 as never }]), 'Unsupported compression method');
  const zip64 = makeZip([{ name: 'big.html', data: 'x', declaredSize: 0xffffffff }]);
  refuses(zip64, 'ZIP64');
});

test('zip: the three bomb shapes are stopped at the directory', () => {
  refuses(makeZip([{ name: 'many.html', data: 'x', declaredTotal: MAX_ZIP_ENTRIES + 1 }]), 'entries; the limit');
  refuses(makeZip([{ name: 'wide.html', data: 'x', declaredSize: 129 * 1024 * 1024 }]), 'Entry too large');
  refuses(
    makeZip(
      Array.from({ length: 5 }, (_, i) => ({
        name: `part-${i}.html`,
        data: 'x',
        declaredSize: 120 * 1024 * 1024,
      })),
    ),
    'Entry too large|total limit',
  );
});

test('zip: an entry that lies about its size is caught by the decompressor', () => {
  // Declares 1 byte, inflates to more: maxOutputLength stops it.
  const under = makeZip([{ name: 'liar.html', data: 'much longer than one byte', declaredSize: 1 }]);
  refuses(under, 'does not inflate|declares');
  // Declares more than it inflates to: the size check catches the shortfall.
  const over = makeZip([{ name: 'short.html', data: 'tiny', declaredSize: 4000 }]);
  refuses(over, 'declares');
});

test('zip: not a zip says so, without inventing an archive', () => {
  const out = dest();
  try {
    assert.throws(() => extractZip(Buffer.from('<html>not a zip</html>'), out), /end-of-central-directory/);
    assert.ok(existsSync(out) && readdirSync(out).length === 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('zip: readZipEntries reports without writing, for callers that only ask', () => {
  const entries = readZipEntries(makeZip([{ name: 'a/', data: '', method: 0 }, { name: 'a/b.html', data: 'hi' }]));
  assert.deepEqual(
    entries.map((e) => [e.name, e.isDirectory]),
    [['a/', true], ['a/b.html', false]],
  );
});
