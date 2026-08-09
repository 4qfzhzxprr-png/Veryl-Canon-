import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { CanonError } from './model.js';

// ZIP extraction for uploaded exports (import.ts said "the operator unzips
// first" — true until the operator became a browser; see /imports/upload).
//
// Zero-dependency, like everything else here, which means this file IS a ZIP
// reader and has to earn that. It reads the central directory (the authority
// on sizes and offsets — local headers may carry zeros under the data-
// descriptor flag), supports exactly the two methods every export tool
// writes (store, deflate), and REFUSES everything else by name rather than
// carrying it: encryption, ZIP64, unknown methods, traversal names, and the
// three bomb shapes (too many entries, too big an entry, too big a total).
// The inflate itself is capped with zlib's maxOutputLength, so an entry that
// lies about its size is caught by the decompressor, not by the disk.
//
// The rules, each with a test in test/zip.test.ts:
//   - an entry lands inside the destination directory or the whole archive
//     is refused — `..`, absolute names, backslashes and NUL are all fatal,
//     not skipped, because a partner archive with one hostile name is not a
//     partner archive with the rest presumed friendly;
//   - declared and actual sizes must agree, entry by entry;
//   - every refusal the DIRECTORY can prove (names, methods, caps) is thrown
//     before the first byte is written. Corruption inside an entry's data is
//     only provable mid-extraction; it still throws, and the CALLER owns the
//     unpack directory and discards it whole on any throw — the no-partial-
//     tree property lives one layer up, where the directory does.

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;

interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function invalid(message: string, details?: Record<string, unknown>): CanonError {
  return new CanonError('invalid', message, details);
}

/** Find the End Of Central Directory record: last occurrence, searched from
 * the tail (the spec allows a trailing comment up to 64KiB). */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 65_557); // 22-byte EOCD + max comment
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw invalid('Not a ZIP archive: no end-of-central-directory record');
}

/** Parse and VALIDATE the whole central directory before anything extracts. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === ZIP64_MARK || cdOffset === ZIP64_MARK) {
    throw invalid('ZIP64 archives are not supported: split the export into smaller archives');
  }
  if (total > MAX_ZIP_ENTRIES) {
    throw invalid(`Archive has ${total} entries; the limit is ${MAX_ZIP_ENTRIES}`);
  }
  if (cdOffset + cdSize > buf.length) throw invalid('Corrupt ZIP: central directory extends past the file');

  const entries: ZipEntry[] = [];
  let at = cdOffset;
  let totalBytes = 0;
  for (let n = 0; n < total; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CDIR_SIG) {
      throw invalid('Corrupt ZIP: central directory entry missing where the record says one is');
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressedSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    if (flags & 0x1) throw invalid(`Encrypted entry refused: ${name}`);
    if (compressedSize === ZIP64_MARK || uncompressedSize === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw invalid('ZIP64 archives are not supported: split the export into smaller archives');
    }
    if (method !== 0 && method !== 8) {
      throw invalid(`Unsupported compression method ${method} on ${name}: only store and deflate are read`);
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw invalid(`Entry too large: ${name} declares ${uncompressedSize} bytes; the per-file limit is ${MAX_ZIP_ENTRY_BYTES}`);
    }
    const isDirectory = name.endsWith('/');
    if (!isDirectory) totalBytes += uncompressedSize;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw invalid(`Archive unpacks past the ${MAX_ZIP_TOTAL_BYTES}-byte total limit`);
    }
    assertSafeName(name);
    entries.push({ name, isDirectory, method, flags, compressedSize, uncompressedSize, localOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A name is a relative POSIX path into the destination, or the archive dies. */
function assertSafeName(name: string): void {
  if (!name || name.includes('\0')) throw invalid('Corrupt ZIP: entry name is empty or carries NUL');
  if (name.includes('\\')) throw invalid(`Refused entry name with backslash: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw invalid(`Refused absolute entry name: ${name}`);
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) throw invalid(`Refused traversal entry name: ${name}`);
}

function entryData(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) {
    throw invalid(`Corrupt ZIP: no local header where the directory points for ${entry.name}`);
  }
  // Local name/extra lengths, not the central ones: writers pad them apart.
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) throw invalid(`Corrupt ZIP: ${entry.name} is truncated`);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else {
    try {
      // maxOutputLength is the bomb guard: an entry that lies about its size
      // is stopped by the decompressor, not discovered by the disk filling.
      data = inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize || 1 });
    } catch {
      throw invalid(`Corrupt ZIP: ${entry.name} does not inflate to its declared ${entry.uncompressedSize} bytes`);
    }
  }
  if (data.length !== entry.uncompressedSize) {
    throw invalid(`Corrupt ZIP: ${entry.name} declares ${entry.uncompressedSize} bytes and inflates to ${data.length}`);
  }
  return data;
}

/**
 * Unpack an archive into `dest`. The whole central directory is validated
 * first (names, methods, caps), so those refusals write nothing; a corrupt
 * entry body throws mid-extraction, and the caller discards `dest` whole.
 */
export function extractZip(buf: Buffer, dest: string): { files: number; bytes: number } {
  const entries = readZipEntries(buf);
  const root = resolve(dest);
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const target = resolve(join(root, ...entry.name.split('/')));
    // Belt over the name check's braces: the resolved path stays inside.
    if (target !== root && !target.startsWith(root + sep)) {
      throw invalid(`Refused entry escaping the destination: ${entry.name}`);
    }
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entryData(buf, entry);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files += 1;
    bytes += data.length;
  }
  return { files, bytes };
}
