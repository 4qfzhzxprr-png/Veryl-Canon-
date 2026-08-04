import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { backupTo, describeVerification, restoreFrom, verifyDatabase } from '../src/backup.js';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

// Backup and restore (backup.ts). The audit log is a compliance artefact with
// no second copy anywhere, so the promises under test are narrow and absolute:
// a backup taken while the server is writing holds a consistent record; an
// artefact that has been damaged is caught BEFORE it replaces a live record;
// and a restore is only a restore once what was restored has been read back.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'canon-backup-'));
  return { path: (name: string) => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A small record with pages, versions and audit events in it. */
function seed(path: string) {
  const db = openDb(path);
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  const page = store.createPage(dana.id, { collectionId: collection.id, type: 'policy', title: 'Appeals' });
  store.editDraft(dana.id, page.id, {
    body: 'An appeal is acknowledged within five business days.',
    fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2027-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(dana.id, page.id);
  store.approve(iris.id, page.id);
  return { db, store, dana, iris, collection, page };
}

test('backup: a snapshot taken under a concurrent write is consistent, and restores with the record intact', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db, store, dana, collection, page } = seed(live);
    const auditBefore = (db.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n;
    assert.ok(auditBefore > 0, 'the fixture should have written audit events');

    // A second connection, mid write transaction, exactly as another request
    // would be. Under WAL this does not block the snapshot's read.
    const writer = new DatabaseSync(live);
    writer.exec('BEGIN IMMEDIATE');
    writer
      .prepare('INSERT INTO actors (id, kind, name, email, registry_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('uncommitted', 'person', 'Never Committed', null, null, new Date().toISOString());

    const artefact = dir.path('backups/canon-1.db');
    const summary = await backupTo(db, artefact);
    assert.equal(summary.verification.ok, true, describeVerification(summary.verification));
    assert.ok(summary.bytes > 0);

    writer.exec('ROLLBACK');
    writer.close();

    // The live record keeps going after the snapshot; the artefact must not
    // change under it.
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'Written after the backup' });
    db.close();

    const restoredPath = dir.path('restored.db');
    const restore = await restoreFrom(artefact, restoredPath);
    assert.equal(restore.after.ok, true, describeVerification(restore.after));

    const restored = openDb(restoredPath);
    const restoredStore = new CanonStore(restored, { deliver() {} });
    const read = restoredStore.getPage(dana.id, page.id);
    assert.equal(read.title, 'Appeals');
    assert.equal(read.status, 'canonical');
    const version = restoredStore.getVersion(dana.id, page.id, read.currentVersion!);
    assert.match(version.body, /acknowledged within five business days/);

    const uncommitted = restored.prepare('SELECT id FROM actors WHERE id = ?').get('uncommitted');
    assert.equal(uncommitted, undefined, 'an uncommitted write leaked into the snapshot');
    const after = restored.prepare('SELECT id FROM pages WHERE title = ?').get('Written after the backup');
    assert.equal(after, undefined, 'a write made after the snapshot leaked into it');

    const auditAfter = (restored.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n;
    assert.equal(auditAfter, auditBefore, 'the audit log did not survive the round trip intact');
    restored.close();
  } finally {
    dir.cleanup();
  }
});

test('backup: verification catches a corrupted artefact, and the restore refuses it', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('canon-backup.db');
    await backupTo(db, artefact);
    db.close();

    // Damage the middle of the file, where the pages are — leaving the header
    // intact, so it still opens and still looks like a database. This is what
    // bit rot and a truncated transfer actually look like; a file that fails to
    // open would be caught by anything.
    const bytes = readFileSync(artefact);
    const start = Math.floor(bytes.length / 2);
    for (let i = 0; i < 4096 && start + i < bytes.length; i++) bytes[start + i] = 0x00;
    writeFileSync(artefact, bytes);

    const report = await verifyDatabase(artefact);
    assert.equal(report.ok, false, 'a corrupted artefact verified clean');
    assert.ok(report.problems.length > 0);

    const target = dir.path('would-have-been-clobbered.db');
    seed(target).db.close();
    const before = readFileSync(target);
    await assert.rejects(
      () => restoreFrom(artefact, target, { force: true }),
      /did not verify|nothing was restored/,
    );
    assert.deepEqual(readFileSync(target), before, 'a refused restore still touched the live record');
  } finally {
    dir.cleanup();
  }
});

test('backup: a truncated artefact and an empty one are both refused', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('short.db');
    await backupTo(db, artefact);
    db.close();

    const bytes = readFileSync(artefact);
    writeFileSync(artefact, bytes.subarray(0, Math.floor(bytes.length / 3)));
    const truncated = await verifyDatabase(artefact);
    assert.equal(truncated.ok, false);

    const empty = dir.path('empty.db');
    closeSync(openSync(empty, 'w'));
    const emptyReport = await verifyDatabase(empty);
    assert.equal(emptyReport.ok, false);
    assert.match(emptyReport.problems.join(' '), /empty/);

    const missing = await verifyDatabase(dir.path('nothing-here.db'));
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /no such file/);
  } finally {
    dir.cleanup();
  }
});

test('backup: the audit chain is feature-detected — verified, broken, or honestly unavailable', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('chain.db');
    await backupTo(db, artefact, { auditChainVerifier: null });
    db.close();

    // No verifier in this build: reported, never assumed intact, and not a failure.
    const none = await verifyDatabase(artefact, { auditChainVerifier: null });
    assert.equal(none.auditChain, 'unavailable');
    assert.equal(none.ok, true);

    // A verifier that says the chain is whole.
    const good = await verifyDatabase(artefact, { auditChainVerifier: () => ({ ok: true }) });
    assert.equal(good.auditChain, 'verified');
    assert.equal(good.ok, true);

    // A verifier that says it is not. This must fail verification outright: a
    // backup of an audit log whose chain is broken is not a backup of an audit
    // log, and the whole point of the chain is that it is checked.
    const bad = await verifyDatabase(artefact, { auditChainVerifier: () => ({ ok: false, brokenAt: 41 }) });
    assert.equal(bad.auditChain, 'broken');
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(' '), /audit chain/);

    // A verifier this module cannot call — a signature written later — is
    // reported as unavailable rather than condemning a good artefact.
    const wrongShape = await verifyDatabase(artefact, {
      auditChainVerifier: () => {
        throw new Error('expects two arguments');
      },
    });
    assert.equal(wrongShape.auditChain, 'unavailable');
    assert.equal(wrongShape.ok, true);
    assert.match(wrongShape.auditChainDetail, /could not run/);
  } finally {
    dir.cleanup();
  }
});

test('backup: a snapshot that fails verification is discarded rather than left to be trusted', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('doomed.db');
    await assert.rejects(
      () => backupTo(db, artefact, { auditChainVerifier: () => ({ ok: false }) }),
      /did not verify|NOT backed up/,
    );
    assert.equal(existsSync(artefact), false, 'a failed snapshot was left on disk looking like a backup');
    assert.equal(existsSync(`${artefact}.partial`), false, 'the partial file was left behind');
    db.close();
  } finally {
    dir.cleanup();
  }
});

test('backup: neither a backup nor a restore overwrites anything without being told to', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('one.db');
    await backupTo(db, artefact);
    await assert.rejects(() => backupTo(db, artefact), /already exists/);
    const forced = await backupTo(db, artefact, { force: true });
    assert.equal(forced.verification.ok, true);

    const target = dir.path('existing-record.db');
    seed(target).db.close();
    await assert.rejects(() => restoreFrom(artefact, target), /already exists|refusing to replace/);

    // Forced, the displaced record is moved aside rather than deleted: a
    // restore run against the wrong target has to be recoverable.
    const summary = await restoreFrom(artefact, target, { force: true });
    assert.equal(summary.after.ok, true);
    const displaced = readFileSync(target); // the restored one
    assert.ok(displaced.length > 0);
    db.close();
  } finally {
    dir.cleanup();
  }
});

test('backup: verification reports the schema version and refuses an artefact from the future', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('future.db');
    await backupTo(db, artefact);
    db.close();

    const ok = await verifyDatabase(artefact);
    assert.equal(ok.ok, true);
    assert.ok(ok.counts.pages! >= 1);
    assert.ok(ok.counts.audit_events! >= 1);

    // Written by a Canon this build has never heard of.
    const tampered = new DatabaseSync(artefact);
    tampered
      .prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
      .run(99, 'from-the-future', new Date().toISOString());
    tampered.close();

    const refused = await verifyDatabase(artefact);
    assert.equal(refused.ok, false);
    assert.equal(refused.schemaVersion, 99);
    assert.match(refused.problems.join(' '), /schema version 99/);
  } finally {
    dir.cleanup();
  }
});

test('backup: verifying an artefact never writes to it', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('immutable.db');
    await backupTo(db, artefact);
    db.close();

    const before = readFileSync(artefact);
    await verifyDatabase(artefact);
    await verifyDatabase(artefact);
    assert.deepEqual(readFileSync(artefact), before, 'verification altered the artefact it was checking');
    assert.equal(existsSync(`${artefact}-wal`), false, 'verification left a WAL beside the artefact');
  } finally {
    dir.cleanup();
  }
});

test('backup: a restore leaves no stale WAL beside the record it put back', async () => {
  const dir = scratch();
  try {
    const live = dir.path('canon.db');
    const { db } = seed(live);
    const artefact = dir.path('clean.db');
    await backupTo(db, artefact);
    db.close();

    const target = dir.path('target.db');
    // A record with a WAL of its own beside it, as a stopped server leaves.
    const previous = openDb(target);
    new CanonStore(previous, { deliver() {} }).createActor({ kind: 'person', name: 'Someone' });
    const fd = openSync(`${target}-wal`, 'a');
    writeSync(fd, 'stale');
    closeSync(fd);
    previous.close();

    await restoreFrom(artefact, target, { force: true });
    assert.equal(existsSync(`${target}-wal`), false, 'the displaced record’s WAL was left beside the restored one');
  } finally {
    dir.cleanup();
  }
});
