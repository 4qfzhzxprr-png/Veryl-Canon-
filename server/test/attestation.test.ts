import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../src/api.js';
import {
  GENESIS_HASH,
  chainHash,
  ensureAuditChain,
  registerAuditChainFunction,
  verifyAuditChain,
} from '../src/auditchain.js';
import { normalizeInstant, renderPageAttestationHtml } from '../src/attestation.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

// Attestation and export (FEATURES.md §7), in three parts: the audit hash
// chain that makes "tamper-evident" a claim rather than a word, the
// point-in-time reconstruction that answers "what did this say on that date
// and who had approved it", and the bundle an auditor is handed.

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  const iris = store.createActor({ kind: 'person', name: 'Iris' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { db, store, dana, marc, iris, collection };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

/**
 * Direct database access, as somebody past the application would have it. The
 * append-only triggers are the honest operator's guard rail; an attacker
 * writing to the file drops them in one statement, and that is precisely the
 * case the chain exists to make visible. Every tampering test below starts
 * here, because a test that only defeated the triggers would be testing the
 * triggers.
 */
function asAnAttacker(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS audit_events_append_only_update');
  db.exec('DROP TRIGGER IF EXISTS audit_events_append_only_delete');
  db.exec('DROP TRIGGER IF EXISTS audit_chain_append_only_update');
  db.exec('DROP TRIGGER IF EXISTS audit_chain_append_only_delete');
}

/** A record with a handful of real events in it, and the ids they landed on. */
function withActivity() {
  const env = setup();
  const page = env.store.createPage(env.marc.id, {
    collectionId: env.collection.id,
    type: 'policy',
    title: 'Retention',
  });
  env.store.editDraft(env.marc.id, page.id, {
    body: 'Keep records seven years.',
    fields: { ownerId: env.marc.id, approverId: env.iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  env.store.submitForReview(env.marc.id, page.id);
  env.store.approve(env.iris.id, page.id, { note: 'Approved' });
  return { ...env, page };
}

// ---------------------------------------------------------------------------
// Part 1 — the hash chain

test('chain: an untouched log verifies clean, and every event carries a link', () => {
  const { db, store, dana } = withActivity();
  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, true);
  assert.equal(result.firstBreak, null);
  assert.equal(result.unchained, 0);
  assert.equal(result.chainedFromEventId, 1);
  assert.equal(result.verified, result.events);
  assert.equal(result.partial, false);
  assert.ok(result.head);

  // A bounded walk says so rather than reporting a reassuring "ok" for a log
  // it did not finish reading. This is also the shape the UI probes with.
  const bounded = store.verifyAuditChain(dana.id, { limit: 1 });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.partial, true);
  assert.equal(bounded.verified, 1);

  // Every event has a link, the first links to genesis, and each links to the
  // one before it. Recomputed here from the columns, not read from the chain,
  // so this test would fail if the trigger and `chainHash` ever disagreed.
  const events = db.prepare('SELECT * FROM audit_events ORDER BY id').all() as Record<string, unknown>[];
  const links = db.prepare('SELECT * FROM audit_chain ORDER BY event_id').all() as Record<string, unknown>[];
  assert.equal(links.length, events.length);
  let prev = GENESIS_HASH;
  for (const [i, row] of events.entries()) {
    const link = links[i]!;
    assert.equal(link.event_id, row.id);
    assert.equal(link.prev_hash, prev);
    assert.equal(
      link.hash,
      chainHash(prev, {
        id: Number(row.id),
        at: row.at as string,
        actorId: row.actor_id as string,
        actorKind: row.actor_kind as string,
        action: row.action as string,
        collectionId: (row.collection_id as string) ?? null,
        pageId: (row.page_id as string) ?? null,
        detailsJson: row.details_json as string,
      }),
    );
    prev = link.hash as string;
  }
  assert.equal(result.head!.hash, prev);
});

test('chain: a TAMPERED event is detected, and named', () => {
  const { db, store, dana } = withActivity();
  const target = db.prepare("SELECT id FROM audit_events WHERE action = 'page.approve'").get() as { id: number };

  asAnAttacker(db);
  // The most attractive edit there is: make somebody else the approver.
  db.prepare('UPDATE audit_events SET actor_id = ? WHERE id = ?').run('somebody-else', target.id);

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'content_mismatch');
  assert.equal(result.firstBreak!.eventId, target.id);
  assert.equal(result.firstBreak!.action, 'page.approve');
  assert.match(result.firstBreak!.explanation, /content has changed/);
  // Everything before the tampered event still verifies: the break has a
  // position, which is what "detectable at a point" means.
  assert.equal(result.verified, target.id - 1);
});

test('chain: a tampered DETAILS payload is detected even when every other column is untouched', () => {
  const { db, store, dana } = withActivity();
  const target = db.prepare("SELECT id FROM audit_events WHERE action = 'page.publish'").get() as { id: number };
  asAnAttacker(db);
  db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?').run('{"version":99}', target.id);

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'content_mismatch');
  assert.equal(result.firstBreak!.eventId, target.id);
});

test('chain: a DELETED event is detected — the link it leaves behind is the evidence', () => {
  const { db, store, dana } = withActivity();
  const target = db.prepare("SELECT id FROM audit_events WHERE action = 'page.submit'").get() as { id: number };

  asAnAttacker(db);
  db.prepare('DELETE FROM audit_events WHERE id = ?').run(target.id);

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'orphan_link');
  assert.equal(result.firstBreak!.eventId, target.id);
  assert.match(result.firstBreak!.explanation, /deleted/);
});

test('chain: deleting an event AND its link is still detected, one event later', () => {
  const { db, store, dana } = withActivity();
  const target = db.prepare("SELECT id FROM audit_events WHERE action = 'page.submit'").get() as { id: number };

  asAnAttacker(db);
  // The thorough version of the same attack: take the link too, so no orphan
  // is left. The next event still points back at a hash that is now gone.
  db.prepare('DELETE FROM audit_events WHERE id = ?').run(target.id);
  db.prepare('DELETE FROM audit_chain WHERE event_id = ?').run(target.id);

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'link_mismatch');
  assert.equal(result.firstBreak!.eventId, target.id + 1);
  assert.equal(result.verified, target.id - 1);
});

test('chain: a REORDERED log is detected', () => {
  const { db, store, dana } = withActivity();
  const rows = db
    .prepare("SELECT id, action, at, actor_id, details_json FROM audit_events WHERE action LIKE 'page.%' ORDER BY id")
    .all() as { id: number; action: string; at: string; actor_id: string; details_json: string }[];
  const [first, second] = [rows[0]!, rows[1]!];

  asAnAttacker(db);
  // Swap two events' contents between their ids: the log now tells the story
  // in a different order while every row still exists and every id is intact.
  const swap = db.prepare('UPDATE audit_events SET action = ?, at = ?, actor_id = ?, details_json = ? WHERE id = ?');
  swap.run(second.action, second.at, second.actor_id, second.details_json, first.id);
  swap.run(first.action, first.at, first.actor_id, first.details_json, second.id);

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'content_mismatch');
  assert.equal(result.firstBreak!.eventId, first.id);
});

test('chain: an event inserted between two existing ones has no link, and says so', () => {
  const { db, store, dana } = withActivity();
  asAnAttacker(db);
  // Straight into the table with the trigger's own output suppressed: the
  // attacker writes the row and no link with it.
  db.exec('DROP TRIGGER IF EXISTS audit_chain_link');
  db.prepare(
    `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
     VALUES (?, ?, ?, ?, NULL, NULL, '{}')`,
  ).run('2026-01-01T00:00:00.000Z', 'ghost', 'person', 'page.approve');

  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.kind, 'missing_link');
  assert.match(result.firstBreak!.explanation, /bypassed the trigger/);
});

test('chain: the links are append-only at the storage layer too', () => {
  const { db } = withActivity();
  assert.throws(() => db.exec("UPDATE audit_chain SET hash = 'x'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_chain'), /append-only/);
});

test('chain: verifying takes admin on a collection, like the sweep', () => {
  const { store, marc } = withActivity();
  expectCode(() => store.verifyAuditChain(marc.id), 'forbidden'); // marc holds edit
});

test('chain: a pre-chain database is chained FROM ITS HEAD FORWARD, and says how much it does not cover', () => {
  const file = join(tmpdir(), `canon-chain-${randomUUID()}.db`);
  try {
    // A record written by a build that had no chain: audit events, no links.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE audit_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        actor_kind    TEXT NOT NULL,
        action        TEXT NOT NULL,
        collection_id TEXT,
        page_id       TEXT,
        details_json  TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO audit_events (at, actor_id, actor_kind, action, details_json)
        VALUES ('2026-01-01T00:00:00.000Z', 'a1', 'person', 'page.create', '{}'),
               ('2026-01-02T00:00:00.000Z', 'a1', 'person', 'page.publish', '{"version":1}'),
               ('2026-01-03T00:00:00.000Z', 'a1', 'person', 'page.approve', '{"version":1}');
    `);
    old.close();

    const db = openDb(file);
    const meta = ensureAuditChain(db); // idempotent; openDb already ran it
    assert.equal(meta.chainedFromEventId, 4, 'the chain starts after the events that were already there');
    assert.equal(meta.preChainEvents, 3);
    assert.match(meta.note, /not covered by the chain/);

    // The three old events are untouched and unlinked. History is append-only,
    // so a migration that rewrote them to fit the chain would be the very thing
    // the chain is supposed to detect.
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_chain').get() as { n: number }).n, 0);

    // From here forward everything is chained, and verification reports both
    // halves honestly rather than a single reassuring "ok".
    const store = new CanonStore(db);
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const collection = store.createCollection(dana.id, { name: 'Compliance' });
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'New' });

    const result = store.verifyAuditChain(dana.id);
    assert.equal(result.ok, true);
    assert.equal(result.unchained, 3);
    assert.equal(result.chainedFromEventId, 4);
    assert.equal(result.verified, result.events - 3);
    assert.equal(result.head!.eventId, result.events);

    // And a tamper AFTER the migration point is still caught.
    asAnAttacker(db);
    db.prepare("UPDATE audit_events SET action = 'page.archive' WHERE id = 5").run();
    const after = store.verifyAuditChain(dana.id);
    assert.equal(after.ok, false);
    assert.equal(after.firstBreak!.eventId, 5);

    db.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});

test('chain: an unchained event is honest about what a clean chain does not prove', () => {
  // Not a behaviour test — a promise test. The wording an auditor reads is
  // part of the feature, and a future edit that quietly upgrades the claim
  // ("proves the log is complete", "cannot be tampered with") should fail here.
  const { store, dana } = withActivity();
  const result = store.verifyAuditChain(dana.id);
  assert.match(result.limits, /same database/);
  assert.match(result.limits, /recompute every later link/);
  assert.match(result.limits, /anchor/);
  assert.doesNotMatch(result.proves, /complete/);
});

test('chain: the hash function is registered on every connection openDb hands out', () => {
  const db = new DatabaseSync(':memory:');
  registerAuditChainFunction(db);
  db.exec(`CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL,
    action TEXT NOT NULL, collection_id TEXT, page_id TEXT, details_json TEXT NOT NULL DEFAULT '{}')`);
  ensureAuditChain(db);
  db.prepare(
    `INSERT INTO audit_events (at, actor_id, actor_kind, action, details_json)
     VALUES ('2026-01-01T00:00:00.000Z', 'a', 'person', 'test', '{}')`,
  ).run();
  const link = db.prepare('SELECT prev_hash, hash FROM audit_chain WHERE event_id = 1').get() as {
    prev_hash: string;
    hash: string;
  };
  assert.equal(link.prev_hash, GENESIS_HASH);
  assert.equal(
    link.hash,
    chainHash(GENESIS_HASH, {
      id: 1,
      at: '2026-01-01T00:00:00.000Z',
      actorId: 'a',
      actorKind: 'person',
      action: 'test',
      collectionId: null,
      pageId: null,
      detailsJson: '{}',
    }),
  );
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------------------
// Part 2 — point-in-time reconstruction

/** A page with two published versions, separated in time, and archived last. */
async function history() {
  const env = setup();
  const page = env.store.createPage(env.marc.id, {
    collectionId: env.collection.id,
    type: 'policy',
    title: 'Retention policy',
  });
  env.store.editDraft(env.marc.id, page.id, {
    body: 'Keep records for seven years.',
    fields: { ownerId: env.marc.id, approverId: env.iris.id, reviewDate: '2030-01-01', effectiveDate: TODAY },
  });
  env.store.submitForReview(env.marc.id, page.id);
  env.store.approve(env.iris.id, page.id, { note: 'Approved as Canonical' });
  await sleep(5);
  env.store.editDraft(env.marc.id, page.id, {
    body: 'Keep records for ten years.',
    fields: { ownerId: env.dana.id, reviewDate: '2040-01-01' },
  });
  env.store.publish(env.marc.id, page.id, { note: 'Extended to ten years' });
  await sleep(5);
  const versions = env.store.listVersions(env.dana.id, page.id);
  return { ...env, page, v1: versions[0]!, v2: versions[1]! };
}

test('as-of: before the page existed, Canon says so rather than reaching for the nearest version', async () => {
  const { store, dana, page } = await history();
  const before = new Date(Date.parse(store.getPage(dana.id, page.id).createdAt) - 60_000).toISOString();
  const answer = store.pageAsOf(dana.id, page.id, before);
  assert.equal(answer.existed, false);
  assert.equal(answer.reason, 'not_yet_created');
  assert.equal(answer.version, null);
  assert.equal(answer.status, null);
  assert.equal(answer.canonical, false);
  assert.match(answer.answer, /did not exist/);
});

test('as-of: a page that existed but had never published answers honestly', () => {
  const { store, marc, dana, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  const answer = store.pageAsOf(dana.id, page.id, new Date().toISOString());
  assert.equal(answer.existed, true);
  assert.equal(answer.reason, 'no_published_version');
  assert.equal(answer.version, null);
  assert.equal(answer.title, 'Scratch'); // the title it was created with
  assert.equal(answer.status, 'draft');
  assert.match(answer.answer, /no published version/);
});

test('as-of: between two versions, the earlier one is what the page said', async () => {
  const { store, dana, page, v1, v2 } = await history();
  const between = new Date((Date.parse(v1.createdAt) + Date.parse(v2.createdAt)) / 2).toISOString();
  const answer = store.pageAsOf(dana.id, page.id, between);
  assert.equal(answer.existed, true);
  assert.equal(answer.version!.number, 1);
  assert.equal(answer.version!.body, 'Keep records for seven years.');
});

test('as-of: exactly at a version boundary, that version is what stood', async () => {
  const { store, dana, page, v1, v2 } = await history();
  // The instant a version was published is a moment at which it stands.
  assert.equal(store.pageAsOf(dana.id, page.id, v1.createdAt).version!.number, 1);
  assert.equal(store.pageAsOf(dana.id, page.id, v2.createdAt).version!.number, 2);
  // And one millisecond before v2 the record still said what v1 said.
  const justBefore = new Date(Date.parse(v2.createdAt) - 1).toISOString();
  assert.equal(store.pageAsOf(dana.id, page.id, justBefore).version!.number, 1);
});

test('as-of: fields and status are AS THEY WERE, not as they are now', async () => {
  const { store, dana, marc, page, v1, v2 } = await history();

  // Now: version 2, owner Dana, review 2040, and back to Draft because
  // publishing after Canonical drops the mark.
  const today = store.getPage(dana.id, page.id);
  assert.equal(today.status, 'draft');
  assert.equal(today.ownerId, dana.id);
  assert.equal(today.reviewDate, '2040-01-01');

  // Then: version 1, owner Marc, review 2030, and Canonical — with the
  // approval that granted it named.
  const then = store.pageAsOf(dana.id, page.id, v1.createdAt);
  assert.equal(then.version!.number, 1);
  assert.equal(then.fields!.ownerId, marc.id);
  assert.equal(then.fields!.reviewDate, '2030-01-01');
  assert.equal(then.status, 'canonical');
  assert.equal(then.canonical, true);
  assert.equal(then.approval!.approverId, store.getActor(then.approval!.approverId).id);
  assert.equal(then.approval!.version, 1);
  assert.match(then.answer, /Canonical mark, granted by Iris/);

  // The approval that covered v1 is NOT reported as covering v2: republishing
  // after Canonical drops the mark, and an attestation that carried the old
  // approval forward would be attesting to an approval nobody gave.
  const later = store.pageAsOf(dana.id, page.id, v2.createdAt);
  assert.equal(later.version!.number, 2);
  assert.equal(later.canonical, false);
  assert.equal(later.approval, null);
});

test('as-of: after archival, the answer says archived rather than serving it as the record', async () => {
  const { store, dana, marc, page } = await history();
  store.archivePage(marc.id, page.id);
  await sleep(2);

  const answer = store.pageAsOf(dana.id, page.id, new Date().toISOString());
  assert.equal(answer.existed, true);
  assert.equal(answer.status, 'archived');
  assert.equal(answer.canonical, false);
  assert.ok(answer.archivedAt);
  assert.match(answer.answer, /archived/);

  // Before the archival it was not archived: the reconstruction is of that
  // instant, not of the page's eventual fate.
  const before = new Date(Date.parse(answer.archivedAt!) - 3).toISOString();
  assert.equal(store.pageAsOf(dana.id, page.id, before).archivedAt, null);
});

test('as-of: a bare date means the START of that day, and a bad timestamp is refused', () => {
  assert.equal(normalizeInstant('2026-03-01'), '2026-03-01T00:00:00.000Z');
  assert.equal(normalizeInstant('2026-03-01T09:30:00Z'), '2026-03-01T09:30:00.000Z');
  const { store, dana, page } = { ...setup(), page: { id: 'x' } };
  expectCode(() => store.pageAsOf(dana.id, page.id, 'yesterday'), 'invalid');
  expectCode(() => store.pageAsOf(dana.id, page.id, ''), 'invalid');
});

// ---------------------------------------------------------------------------
// Part 3 — the bundle

test('bundle: contains every version, every approval, every status change and the chained audit trail', async () => {
  const { store, dana, page, v1 } = await history();
  const bundle = store.pageAttestation(dana.id, page.id, { at: v1.createdAt });

  assert.equal(bundle.versions.length, 2);
  assert.deepEqual(bundle.versions.map((v) => v.number), [1, 2]);
  assert.equal(bundle.versions[0]!.body, 'Keep records for seven years.');
  assert.equal(bundle.versions[1]!.note, 'Extended to ten years');

  assert.equal(bundle.approvals.length, 1);
  assert.equal(bundle.approvals[0]!.approverName, 'Iris');
  assert.equal(bundle.approvals[0]!.version, 1);

  // Every status the page has held, in order, each with the actor who moved it.
  assert.deepEqual(
    bundle.statusHistory.map((s) => s.status),
    ['draft', 'in_review', 'canonical', 'canonical', 'draft'],
  );
  assert.equal(bundle.statusHistory[1]!.actorName, 'Marc');
  assert.equal(bundle.statusHistory[2]!.actorName, 'Iris');

  // The field history answers "who changed the review date and when" exactly.
  const reviewChanges = bundle.fieldHistory.filter((f) => f.field === 'reviewDate');
  assert.deepEqual(reviewChanges.map((f) => [f.from, f.to]), [[null, '2030-01-01'], ['2030-01-01', '2040-01-01']]);

  // Every audit event naming the page, each with its chain link.
  assert.ok(bundle.auditEvents.length >= 5);
  assert.ok(bundle.auditEvents.every((e) => e.chain && /^[0-9a-f]{64}$/.test(e.chain.hash)));

  // The point-in-time answer travels inside the bundle when `at` is given.
  assert.equal(bundle.asOf!.version!.number, 1);
  assert.equal(bundle.asOf!.canonical, true);

  // The manifest names the chain head, its own generation event, and how to
  // check the claim without trusting the file.
  assert.equal(bundle.manifest.format, 'veryl-canon-attestation-v1');
  assert.equal(bundle.manifest.generatedBy.name, 'Dana');
  assert.ok(bundle.manifest.generationEventId);
  assert.equal(bundle.manifest.auditChain.verifiedAtGeneration.ok, true);
  assert.match(bundle.manifest.auditChain.head!.hash, /^[0-9a-f]{64}$/);
  assert.ok(bundle.manifest.howToVerify.length >= 4);
  assert.ok(bundle.manifest.limits.some((l) => /permission-filtered/i.test(l)));
  assert.ok(bundle.manifest.asserts.some((a) => /Every published version/.test(a)));
});

test('bundle: the content digest is reproducible from the bundle itself', async () => {
  const { store, dana, page } = await history();
  const bundle = store.pageAttestation(dana.id, page.id, {});
  const { manifest, ...content } = bundle;
  const { createHash } = await import('node:crypto');
  const recomputed = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  assert.equal(recomputed, manifest.contentDigest);
});

test("bundle: each event's chain hash recomputes from the fields the bundle lists", async () => {
  const { store, dana, page } = await history();
  const bundle = store.pageAttestation(dana.id, page.id, {});
  // Step 2 of the manifest's own instructions, run against the bundle: an
  // auditor with nothing but this file and a SHA-256 implementation.
  for (const event of bundle.auditEvents) {
    assert.ok(event.chain);
    assert.equal(
      chainHash(event.chain!.prevHash, {
        id: event.id,
        at: event.at,
        actorId: event.actorId,
        actorKind: event.actorKind,
        action: event.action,
        collectionId: event.collectionId,
        pageId: event.pageId,
        detailsJson: JSON.stringify(event.details),
      }),
      event.chain!.hash,
    );
  }
});

test('as-of: reading restricted material through it leaves a view on the log', async () => {
  const { store, dana, page } = await history(); // the fixture collection is restricted
  store.pageAsOf(dana.id, page.id, new Date().toISOString());
  const views = store.queryAudit(dana.id, { action: 'page.view' }).filter((e) => e.pageId === page.id);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.details.via, 'as-of');

  // An unrestricted collection logs writes but not reads, here as everywhere.
  const open = store.createCollection(dana.id, { name: 'Open' });
  const openPage = store.createPage(dana.id, { collectionId: open.id, type: 'note', title: 'Public-ish' });
  store.pageAsOf(dana.id, openPage.id, new Date().toISOString());
  assert.equal(store.queryAudit(dana.id, { action: 'page.view' }).filter((e) => e.pageId === openPage.id).length, 0);
});

test('bundle: generating one is itself an audited act', async () => {
  const { store, dana, page } = await history();
  store.pageAttestation(dana.id, page.id, { at: '2026-01-01' });
  const events = store.queryAudit(dana.id, { action: 'attestation.generate' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.pageId, page.id);
  assert.equal(events[0]!.actorId, dana.id);
  assert.equal(events[0]!.details.subject, 'page');
  assert.equal(events[0]!.details.at, '2026-01-01T00:00:00.000Z');
  // And the event is inside the chain the bundle it produced names.
  assert.equal(store.verifyAuditChain(dana.id).ok, true);
});

test('bundle HTML: self-contained — no external reference of any kind', async () => {
  const { store, dana, page, v1 } = await history();
  const html = renderPageAttestationHtml(store.pageAttestation(dana.id, page.id, { at: v1.createdAt }));

  assert.match(html, /^<!doctype html>/);
  // Nothing that could reach the network when a regulator opens the file in
  // five years: no script, no stylesheet link, no image, no font, no iframe,
  // no CSS url() or @import, no absolute URL at all.
  for (const forbidden of [/<script/i, /<iframe/i, /<img/i, /<link/i, /\ssrc=/i, /\shref=/i, /url\(/i, /@import/i]) {
    assert.doesNotMatch(html, forbidden, `attestation HTML must not contain ${forbidden}`);
  }
  assert.doesNotMatch(html, /https?:\/\//);
  // The CSS is inline and the document really does carry the record.
  assert.match(html, /<style>/);
  assert.match(html, /Keep records for seven years\./);
  assert.match(html, /Approved as Canonical/);
  assert.match(html, /How to verify this without trusting it/);
  assert.match(html, /What this document does not prove/);
});

test('bundle HTML: a retention schedule attests as a table, and still reaches nothing', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, {
    collectionId: collection.id,
    type: 'policy',
    title: 'Retention schedule',
  });
  store.editDraft(marc.id, page.id, {
    body: [
      '## Schedule',
      '',
      '| Record type | Retention | Owner |',
      '| --- | ---: | --- |',
      '| Client engagement file | 7 years | Legal |',
      '| Payroll | 6 years | People |',
      '',
      'See [the policy](https://example.test/retention).',
    ].join('\n'),
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id, { note: 'Approved' });

  const html = renderPageAttestationHtml(store.pageAttestation(dana.id, page.id, {}));

  // The clause being attested to is a table, so the attestation shows a table.
  assert.match(html, /<th[^>]*>Record type<\/th>/);
  assert.match(html, /<td[^>]*>Client engagement file<\/td>/);
  assert.match(html, /<td class="md-right">7 years<\/td>/);
  assert.doesNotMatch(html, /\| Record type \| Retention \|/, 'not as a line of pipes');
  assert.match(html, /<h2>Schedule<\/h2>/, "the body's own headings are headings");

  // And the document is still a document that can reach nothing: the link in
  // the body kept its text and its target, as text, and became no anchor.
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /the policy \(https:\/\/example.test\/retention\)/);
});

test('bundle HTML: a hostile title, body, note and send-back comment cannot escape', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const hostile = '</title><script>alert("xss")</script><img src=x onerror=alert(1)>';
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: hostile });
  store.editDraft(marc.id, page.id, {
    body: `Body: ${hostile}\n<style>body{display:none}</style>`,
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, page.id);
  store.sendBack(iris.id, page.id, { comment: hostile });
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id, { note: hostile });

  const html = renderPageAttestationHtml(store.pageAttestation(dana.id, page.id, { at: new Date().toISOString() }));

  // The only `<script`, `<img` or `<style>` that may appear is the document's
  // own — and the document has exactly one <style> and no script or image.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.equal(html.match(/<style>/g)!.length, 1);
  // The hostile string never appears as written. `onerror=` survives as TEXT
  // inside `&lt;img src=x onerror=alert(1)&gt;`, which is the correct outcome:
  // the record's content is shown verbatim and it is inert, because the angle
  // brackets that would have made it an attribute are gone.
  assert.ok(!html.includes(hostile), 'the hostile string must never appear unescaped');
  assert.ok(!html.includes('<img src=x onerror='));
  // The hostile text is present, escaped, in the title element and the body.
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.match(html, /<title>Attestation — &lt;\/title&gt;/);
  // The </title> in the page title did not close the document's own title.
  assert.equal(html.match(/<\/title>/g)!.length, 1);
});

test('bundle: aliases are in the readable document, and their absence is an em-dash, not a missing row', async () => {
  // Ruth's management-letter point (third round): vocabulary that steers
  // answers must be provable in the record. The JSON side always carried the
  // fields verbatim; what was missing was the HUMAN-readable document — the
  // one that has to open in five years, in front of somebody who cannot ask
  // which schema generated it. So a page with aliases shows them, and a page
  // without shows the row with an em-dash: an absent row would be
  // indistinguishable from an older rendering that did not know the field.
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Claims standard' });
  store.editDraft(marc.id, page.id, {
    body: 'An expedited claim is decided within seventy-two hours.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id);
  // Version 2 is the one that learns the words, so the per-version renderings
  // must disagree with each other: v1 an em-dash, v2 the names.
  store.editDraft(marc.id, page.id, { fields: { aliases: ['urgent claims', 'COB'] } });
  store.publish(marc.id, page.id);

  const bundle = store.pageAttestation(dana.id, page.id, {});
  assert.deepEqual(bundle.page.aliases, ['urgent claims', 'COB'], 'the JSON names the current version’s names');
  const html = renderPageAttestationHtml(bundle);
  assert.match(html, /<dt>Also known as<\/dt><dd>urgent claims, COB<\/dd>/, 'the page today states its names');
  assert.match(html, /<dt>Also known as<\/dt><dd>—<\/dd>/, 'and the version that carried none says so with an em-dash');

  // A page that never carried an alias still carries the row.
  const bare = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Plain note' });
  store.editDraft(marc.id, bare.id, { body: 'Nothing to see.' });
  store.publish(marc.id, bare.id);
  const bareBundle = store.pageAttestation(dana.id, bare.id, {});
  assert.deepEqual(bareBundle.page.aliases, []);
  const bareHtml = renderPageAttestationHtml(bareBundle);
  assert.match(bareHtml, /<dt>Also known as<\/dt><dd>—<\/dd>/);
  assert.doesNotMatch(bareHtml, /<dt>Also known as<\/dt><dd>[^—]/, 'no rendering invents a name');
});

// ---------------------------------------------------------------------------
// The collection register

test('register: the Canonical pages as at a date, with owners, approvers and review dates', async () => {
  const { store, dana, marc, iris, collection, page, v1 } = await history();
  // A second policy, approved and left Canonical.
  const second = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, second.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2035-06-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, second.id);
  store.approve(iris.id, second.id, {});
  await sleep(3);

  const now = store.collectionAttestation(dana.id, collection.id, {});
  assert.deepEqual(now.register.map((e) => e.title), ['Access policy']);
  assert.equal(now.register[0]!.ownerName, 'Marc');
  assert.equal(now.register[0]!.approverName, 'Iris');
  assert.equal(now.register[0]!.reviewDate, '2035-06-01');
  assert.ok(now.register[0]!.approvedAt);
  // The page that lost the mark is named rather than hidden.
  assert.deepEqual(now.notCanonical.map((e) => e.title), ['Retention policy']);

  // As at the moment the first policy was approved: it was Canonical then, and
  // the second policy did not exist yet, so it is in neither list.
  const then = store.collectionAttestation(dana.id, collection.id, { at: v1.createdAt });
  assert.deepEqual(then.register.map((e) => e.pageId), [page.id]);
  assert.equal(then.register[0]!.reviewDate, '2030-01-01'); // as it was, not 2040
  assert.equal(then.notCanonical.length, 0);
  assert.equal(then.manifest.subject.kind, 'collection');
});

test('register: generating one is audited, and the HTML rendering is self-contained', async () => {
  const { store, dana, collection } = await history();
  const bundle = store.collectionAttestation(dana.id, collection.id, { at: '2026-06-01', format: 'html' });
  const events = store.queryAudit(dana.id, { action: 'attestation.generate' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.collectionId, collection.id);
  assert.equal(events[0]!.details.subject, 'collection');
  assert.equal(events[0]!.details.format, 'html');

  const { renderCollectionAttestationHtml } = await import('../src/attestation.js');
  const html = renderCollectionAttestationHtml(bundle);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /Compliance/);
});

// ---------------------------------------------------------------------------
// Permission

test('permission: all three surfaces refuse a non-member, and refuse before answering', async () => {
  const { store, page, collection } = await history();
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.pageAsOf(outsider.id, page.id, new Date().toISOString()), 'forbidden');
  expectCode(() => store.pageAttestation(outsider.id, page.id, {}), 'forbidden');
  expectCode(() => store.collectionAttestation(outsider.id, collection.id, {}), 'forbidden');
  expectCode(() => store.verifyAuditChain(outsider.id), 'forbidden');
  // A refusal writes no attestation event: the refused call did nothing.
  const { store: other, dana } = await history();
  assert.equal(other.queryAudit(dana.id, { action: 'attestation.generate' }).length, 0);
});

test('permission: view is enough — an attestation adds assembly, not access', async () => {
  const { store, dana, collection, page } = await history();
  const reader = store.createActor({ kind: 'person', name: 'Reader' });
  store.setMember(dana.id, collection.id, reader.id, 'view');
  const bundle = store.pageAttestation(reader.id, page.id, { at: new Date().toISOString() });
  assert.equal(bundle.manifest.generatedBy.name, 'Reader');
  assert.equal(bundle.versions.length, 2);
  // No email address of anybody appears in a bundle, whoever generated it.
  assert.ok(bundle.actors.every((a) => !('email' in a)));
});

// ---------------------------------------------------------------------------
// Over HTTP

test('API: as-of, attestation JSON, attestation HTML and chain verification over HTTP', async () => {
  const { store, dana, marc, page, v1, collection } = await history();
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, actor: string) => fetch(base + path, { headers: { 'x-actor-id': actor } });

  try {
    const asOf = await get(`/pages/${page.id}/as-of?at=${encodeURIComponent(v1.createdAt)}`, dana.id);
    assert.equal(asOf.status, 200);
    const asOfBody = (await asOf.json()) as any;
    assert.equal(asOfBody.version.number, 1);
    assert.equal(asOfBody.canonical, true);

    const missingAt = await get(`/pages/${page.id}/as-of`, dana.id);
    assert.equal(missingAt.status, 400);

    const json = await get(`/pages/${page.id}/attestation?at=${encodeURIComponent(v1.createdAt)}`, dana.id);
    assert.equal(json.headers.get('content-type'), 'application/json');
    const bundle = (await json.json()) as any;
    assert.equal(bundle.versions.length, 2);

    const html = await get(`/pages/${page.id}/attestation?format=html`, dana.id);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html.headers.get('content-disposition') ?? '', /^attachment; filename="canon-attestation-/);
    const text = await html.text();
    assert.match(text, /^<!doctype html>/);
    assert.doesNotMatch(text, /<script/i);

    const register = await get(`/collections/${collection.id}/attestation?format=html`, dana.id);
    assert.match(register.headers.get('content-type') ?? '', /text\/html/);

    const verify = await get('/audit/verify', dana.id);
    assert.equal(verify.status, 200);
    const verified = (await verify.json()) as any;
    assert.equal(verified.ok, true);
    assert.match(verified.head.hash, /^[0-9a-f]{64}$/);

    // Not an operator: the chain check is refused, and the page surfaces are not.
    assert.equal((await get('/audit/verify', marc.id)).status, 403);
    assert.equal((await get(`/pages/${page.id}/attestation`, marc.id)).status, 200);
  } finally {
    server.close();
  }
});

test('API: attestation is closed to agents by classification, like the audit CSV', async () => {
  const { store, page } = await history();
  const server = createApi(store); // no AgentAuth: a passport is refused outright
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of [`/pages/${page.id}/attestation`, `/pages/${page.id}/as-of?at=2026-01-01`, '/audit/verify']) {
      const res = await fetch(base + path, { headers: { 'x-agent-passport': 'anything' } });
      assert.equal(res.status, 503, `${path} should refuse a passport where no Registry is configured`);
    }
  } finally {
    server.close();
  }
});
