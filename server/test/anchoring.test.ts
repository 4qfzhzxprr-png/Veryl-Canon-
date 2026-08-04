import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  AttestationService,
  renderCollectionAttestationHtml,
  renderPageAttestationHtml,
} from '../src/attestation.js';
import { compareAttestations, renderComparison } from '../src/attestcompare.js';
import { GENESIS_HASH, chainHash, ensureAuditChain, verifyAuditChain } from '../src/auditchain.js';
import { PersonAuth, type IdTokenClaims, type OidcConfig } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { anchorDisclosure, headAnchor, startHeadAnchors, takeAnchor } from '../src/headanchor.js';
import { identityProvenance } from '../src/identityprovenance.js';
import { Logger } from '../src/log.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

// The evidence a bundle carries about ITSELF: how identity was established
// (USER-TESTING.md T3.1), where the chain head had got to and what saying so is
// worth (T3.2), and the comparison of two retained bundles that is the only
// check in this product an attacker with write access to the record cannot
// answer.
//
// The centrepiece is `compare: the competent forgery`. It reproduces the
// auditor's own three-part test end to end — delete an event, reattribute the
// approval, recompute every link — asserts that `GET /audit/verify` reports a
// clean chain afterwards, which it must, and then asserts that the retained
// bundle names the forgery exactly. If that test ever goes green for the wrong
// reason, the product's whole evidence story is back to where T3.2 found it.

const quiet: NotificationTransport = { deliver() {} };
const TODAY = new Date().toISOString().slice(0, 10);

/** A deployment with the dev door open and nothing else — the T3.1 case. */
const DEV_ENV: NodeJS.ProcessEnv = { CANON_DEV_AUTH: 'true' };
/** A deployment behind a real identity provider. */
const SSO_ENV: NodeJS.ProcessEnv = { CANON_OIDC_ISSUER: 'https://idp.example.com' };

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  const iris = store.createActor({ kind: 'person', name: 'Iris' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { db, store, dana, marc, iris, collection };
}

/** A page written, submitted and approved by somebody other than its author. */
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

function bundleWith(db: DatabaseSync, store: CanonStore, env: NodeJS.ProcessEnv) {
  return new AttestationService(db, store, env);
}

/** JSON in, JSON out — a bundle as somebody who kept one actually holds it. */
function asFile(bundle: unknown): unknown {
  return JSON.parse(JSON.stringify(bundle));
}

// ---------------------------------------------------------------------------
// Identity (USER-TESTING.md T3.1)
// ---------------------------------------------------------------------------

test('identity: a bundle generated with the dev door open says so, on its face and in the manifest', () => {
  const { db, store, dana, page } = withActivity();
  const bundle = bundleWith(db, store, DEV_ENV).bundle(dana.id, page.id);
  const identity = bundle.manifest.identity;

  assert.equal(identity.doors.mode, 'dev');
  assert.equal(identity.doors.devAuthOpen, true);
  assert.equal(identity.doors.issuer, null);
  assert.match(identity.statement, /ASSERTED AND NOT VERIFIED/);
  assert.match(identity.statement, /CANON_DEV_AUTH=true/);
  // Every person in this record was created by hand, so none of them is
  // federated and the census says which.
  assert.equal(identity.federated, 0);
  assert.ok(identity.asserted >= 3, 'the people in this record were all asserted');
  assert.ok(
    identity.actors.every((a) => a.basis === 'asserted'),
    'nobody in a hand-built record was established by an identity provider',
  );

  // In the asserts list, phrased as a claim rather than as a footnote.
  assert.ok(
    bundle.manifest.asserts.some((a) => /ASSERTED AND NOT VERIFIED/.test(a)),
    'the bundle does not assert how identity was established',
  );

  // On the face of the rendered document: before any attribution is read.
  const html = renderPageAttestationHtml(bundle);
  const title = html.indexOf('<h1>');
  const notice = html.indexOf('Identity here was ASSERTED AND NOT VERIFIED');
  assert.ok(notice > title, 'the identity notice is not on the face of the document');
  assert.ok(notice - title < 800, 'the identity notice is too far down to be on the face of the document');
});

test('identity: a federated actor is named with its issuer and subject; one without a subject is an exception', () => {
  const { db, store, dana, page } = withActivity();
  // Provisioning is done by the real code path rather than by hand, so this
  // test would notice if `sso_subject` ever stopped being how a sign-in is
  // recorded.
  const oidc: OidcConfig = {
    issuer: 'https://idp.example.com',
    clientId: 'veryl-canon',
    clientSecret: 'secret',
    redirectUri: 'https://canon.example.com/auth/callback',
    scope: 'openid',
    clockToleranceSec: 60,
    requestTimeoutMs: 1000,
    metadataTtlMs: 1000,
  };
  const auth = new PersonAuth({ db, store, devAuth: false, oidc });
  const claims: IdTokenClaims = {
    sub: 'nadia-real',
    name: 'Nadia Haddad',
    email: 'nadia@example.com',
    emailVerified: true,
    raw: {},
  };
  const { actor: nadia } = auth.provision(claims);
  // …and the second Nadia Haddad, carrying the real Nadia's address, created
  // the way the dev door creates one. This is the pair the auditor made.
  const impostor = store.createActor({ kind: 'person', name: 'Nadia Haddad', email: 'nadia@example.com' });
  store.setMember(dana.id, (store.getPage(dana.id, page.id) as { collectionId: string }).collectionId, nadia.id, 'view');

  const identity = identityProvenance(db, [nadia.id, impostor.id, dana.id], SSO_ENV);
  const federated = identity.actors.find((a) => a.actorId === nadia.id)!;
  const asserted = identity.actors.find((a) => a.actorId === impostor.id)!;

  assert.equal(federated.basis, 'federated');
  assert.equal(federated.issuer, 'https://idp.example.com');
  assert.equal(federated.subject, 'nadia-real');
  assert.match(federated.statement, /Match that subject against your directory/);

  assert.equal(asserted.basis, 'asserted');
  assert.equal(asserted.subject, null);
  assert.match(asserted.statement, /no identity-provider subject/);
  // On an SSO deployment, an actor with no subject is worth a question and the
  // bundle says so rather than leaving two identical-looking rows.
  assert.match(asserted.statement, /exception to it and worth a question/);

  assert.equal(identity.doors.mode, 'sso');
  assert.equal(identity.doors.issuer, 'https://idp.example.com');
  assert.match(identity.statement, /verified an ID token signed by the OpenID Connect issuer/);
  assert.match(identity.statement, /were not, and are marked below/);
});

test('identity: with no door open at all, the bundle says that too rather than implying SSO', () => {
  const { db, store, dana, page } = withActivity();
  const bundle = bundleWith(db, store, {}).bundle(dana.id, page.id);
  assert.equal(bundle.manifest.identity.doors.mode, 'closed');
  assert.match(bundle.manifest.identity.statement, /No door for people is open/);
});

test('identity: the rendered document names it per actor and is still self-contained', () => {
  const { db, store, dana, collection } = withActivity();
  const register = bundleWith(db, store, DEV_ENV).register(dana.id, collection.id);
  const html = renderCollectionAttestationHtml(register);

  assert.match(html, /How identity was established/);
  assert.match(html, /Provider subject/);
  assert.match(html, /Established by/);
  // The one thing the audit credited and that must never regress.
  for (const forbidden of ['<script', '<link', '<img', ' src=', 'href=', '@import', 'url(']) {
    assert.ok(!html.includes(forbidden), `the attestation HTML reaches outside itself: ${forbidden}`);
  }
});

test('identity: the exclusions name what the bundle cannot support', () => {
  const { db, store, dana, page } = withActivity();
  const limits = bundleWith(db, store, DEV_ENV).bundle(dana.id, page.id).manifest.limits.join('\n');
  assert.match(limits, /does not establish that the person named was at the keyboard/);
  assert.match(limits, /Names in this record are not unique/);
  assert.match(limits, /Nothing in this bundle was signed/);
  assert.match(limits, /Separation of duties is enforced within Canon only/);
});

// ---------------------------------------------------------------------------
// The head anchor (USER-TESTING.md T3.2)
// ---------------------------------------------------------------------------

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'canon-anchor-'));
  return { path: (name: string) => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('anchor: the record carries the head, the chain it belongs to, and when it was taken', () => {
  const { db } = withActivity();
  const anchor = headAnchor(db);
  const verified = verifyAuditChain(db);

  assert.equal(anchor.format, 'canon-audit-head-anchor-v1');
  assert.equal(anchor.headEventId, verified.head!.eventId);
  assert.equal(anchor.headHash, verified.head!.hash);
  assert.equal(anchor.events, verified.events);
  assert.ok(anchor.chainStartedAt, 'an anchor that cannot say which record it is about is not comparable');
  assert.match(anchor.takenAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('anchor: taking one writes nothing to the record — an anchor inside the log would move the head it reports', () => {
  const { db } = withActivity();
  const before = headAnchor(db);
  takeAnchor({ db, log: new Logger({ sink: () => {} }) });
  const after = headAnchor(db);
  assert.equal(after.headEventId, before.headEventId);
  assert.equal(after.headHash, before.headHash);
  assert.equal(after.events, before.events);
});

test('anchor: the timer logs a line and appends to the file, and says the line proves nothing on its own', () => {
  const { db } = withActivity();
  const dir = scratch();
  const file = dir.path('anchors.ndjson');
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => void lines.push(line) });
  try {
    const run = startHeadAnchors({ db, log, intervalMs: 60_000, file });
    assert.equal(run.schedule.scheduled, true);
    assert.equal(run.schedule.sink, 'log+file');
    if (run.timer) clearInterval(run.timer);

    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.msg === 'audit head anchor');
    assert.ok(logged, 'no anchor reached the log');
    assert.equal(logged.headEventId, run.first!.headEventId);
    assert.match(String(logged.proves), /nothing until a copy of this line is held where Canon cannot write it/);

    const written = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(written.length, 1);
    assert.deepEqual(JSON.parse(written[0]!), run.first);
  } finally {
    dir.cleanup();
  }
});

test('anchor: a file that cannot be written is a warning, not a reason to stop serving', () => {
  const { db } = withActivity();
  const lines: string[] = [];
  const log = new Logger({ sink: (line) => void lines.push(line) });
  const record = takeAnchor({ db, log, file: join(tmpdir(), 'canon-no-such-dir', 'nested', 'anchors.ndjson') });
  assert.ok(record.headHash, 'the anchor was not taken');
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(events.some((e) => e.msg === 'audit head anchor'), 'the line did not reach the log');
  assert.ok(events.some((e) => e.msg === 'audit head anchor not written to file' && e.level === 'warn'));
});

test('anchor: turning it off is stated, and the bundle says the deployment publishes nothing', () => {
  const { db } = withActivity();
  const run = startHeadAnchors({ db, log: new Logger({ sink: () => {} }), intervalMs: 0 });
  assert.equal(run.schedule.scheduled, false);
  assert.equal(run.timer, null);
  assert.match(run.schedule.reason!, /publishes no head anchor/);

  const off = anchorDisclosure({ CANON_ANCHOR_INTERVAL_MS: '0' });
  assert.equal(off.emitted, false);
  assert.match(off.statement, /records no head anchor/);
  assert.match(off.statement, /Retaining THIS DOCUMENT is the mitigation/);

  // …and with it on, the disclosure still refuses to call it evidence.
  const on = anchorDisclosure({ CANON_ANCHOR_FILE: '/var/anchors.ndjson' });
  assert.equal(on.emitted, true);
  assert.equal(on.sink, 'log+file');
  assert.match(on.statement, /inside Canon’s own trust boundary/);
});

test('verify: the response says what ok MEANS, beside the boolean itself', () => {
  const { db, store, dana } = withActivity();
  const result = store.verifyAuditChain(dana.id);
  assert.equal(result.ok, true);
  assert.match(result.okMeans, /internally consistent/);
  assert.match(result.okMeans, /NOT a statement that the log is authentic/);
  assert.match(result.okMeans, /recomputes every later link produces a log that answers/);
  assert.match(result.externalAnchor, /proves nothing/);
  assert.match(result.externalAnchor, /retained attestation bundle/);
});

// ---------------------------------------------------------------------------
// Comparing two retained bundles — the check that survives a forged log
// ---------------------------------------------------------------------------

/** Direct database access, as somebody past the application has it. */
function asAnAttacker(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS audit_events_append_only_update');
  db.exec('DROP TRIGGER IF EXISTS audit_events_append_only_delete');
  db.exec('DROP TRIGGER IF EXISTS audit_chain_append_only_update');
  db.exec('DROP TRIGGER IF EXISTS audit_chain_append_only_delete');
  db.exec('DROP TRIGGER IF EXISTS audit_chain_link');
}

/** Recompute every link over whatever the log says now. The competent part. */
function recomputeTheWholeChain(db: DatabaseSync): void {
  db.exec('DELETE FROM audit_chain');
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY id').all() as Record<string, unknown>[];
  const insert = db.prepare('INSERT INTO audit_chain (event_id, prev_hash, hash) VALUES (?, ?, ?)');
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const hash = chainHash(prev, {
      id: Number(row.id),
      at: row.at as string,
      actorId: row.actor_id as string,
      actorKind: row.actor_kind as string,
      action: row.action as string,
      collectionId: (row.collection_id as string) ?? null,
      pageId: (row.page_id as string) ?? null,
      detailsJson: row.details_json as string,
    });
    insert.run(Number(row.id), prev, hash);
    prev = hash;
  }
  // Put the guard rails back, so the record looks untouched to anybody who
  // arrives afterwards. An attacker who bothered to recompute 1,171 links
  // bothers with this too.
  ensureAuditChain(db);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  `);
}

test('compare: two bundles of an untouched record differ only by ordinary growth', () => {
  const { db, store, dana, marc, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const retained = asFile(service.bundle(dana.id, page.id));

  // The record does what a record does: somebody edits and publishes again.
  store.editDraft(marc.id, page.id, { body: 'Keep records eight years.' });
  store.publish(marc.id, page.id, { note: 'revision' });
  const fresh = asFile(service.bundle(dana.id, page.id));

  const result = compareAttestations(retained, fresh);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.counts.tamper, 0);
  assert.ok(result.findings.some((f) => f.kind === 'events_appended'));
  assert.ok(result.findings.some((f) => f.kind === 'versions_published'));
  assert.ok(result.findings.some((f) => f.kind === 'head_advanced'));
  assert.match(result.verdict, /No difference between these two copies that the record could not have made/);
});

test('compare: THE COMPETENT FORGERY — the chain verifies clean and the retained bundle names it exactly', () => {
  const { db, store, dana, marc, iris, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);

  // 1. The auditor keeps a bundle. This is the whole of the mitigation.
  const retained = asFile(service.bundle(dana.id, page.id));

  const submit = db
    .prepare("SELECT id FROM audit_events WHERE page_id = ? AND action = 'page.submit'")
    .get(page.id) as { id: number };
  const approve = db
    .prepare("SELECT id FROM audit_events WHERE page_id = ? AND action = 'page.approve'")
    .get(page.id) as { id: number };

  // 2. The forgery: the submission never happened, and the author approved
  //    their own page. Then every link is recomputed over the new story.
  asAnAttacker(db);
  db.prepare('DELETE FROM audit_events WHERE id = ?').run(submit.id);
  db.prepare('UPDATE audit_events SET actor_id = ? WHERE id = ?').run(marc.id, approve.id);
  recomputeTheWholeChain(db);

  // 3. Canon, asked about itself, reports a clean chain. It must: this is what
  //    a self-contained chain is, and pretending otherwise is the overclaim
  //    auditchain.ts refuses to make.
  const verdict = store.verifyAuditChain(dana.id);
  assert.equal(verdict.ok, true, 'the forgery was not competent enough to be the test we mean');
  assert.equal(verdict.firstBreak, null);

  // 4. And a fresh bundle asserts the forged attribution as fact.
  const fresh = asFile(service.bundle(dana.id, page.id));
  const freshApproval = (fresh as { approvals: { approverId: string }[] }).approvals[0];
  assert.equal(freshApproval?.approverId, marc.id, 'the forgery did not take');

  // 5. The retained copy names it.
  const result = compareAttestations(retained, fresh);
  assert.equal(result.ok, false, 'a retained bundle failed to catch a forged log');
  assert.match(result.verdict, /THE RECORD HAS CHANGED|no longer true of the record/);

  const deleted = result.findings.find((f) => f.kind === 'event_deleted');
  assert.ok(deleted, 'the deleted submission was not named');
  assert.equal(deleted.eventId, submit.id);
  assert.match(deleted.message, /page\.submit/);

  const changed = result.findings.filter((f) => f.kind === 'event_changed' && f.eventId === approve.id);
  assert.ok(changed.length >= 1, 'the reattributed approval was not named');
  assert.ok(
    changed.some((f) => /actorId/.test(f.message) && String(f.earlier) === iris.id && String(f.later) === marc.id),
    'the comparison did not name who the approval moved from and to',
  );

  const rehashed = result.findings.filter((f) => f.kind === 'event_rehashed');
  assert.ok(rehashed.length >= 1, 'the wholesale recomputation left no finding');
  assert.match(rehashed[0]!.message, /signature of a wholesale recomputation/);

  // The rendering a person actually reads leads with the verdict.
  const report = renderComparison(result);
  assert.match(report, /VERDICT: THE RECORD HAS CHANGED BEHIND YOU/);
  assert.match(report, /Differences an append-only record cannot make/);
});

test('compare: an event moved into this page’s history is named as an insertion, not as growth', () => {
  const { db, store, dana, marc, collection, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  // A second page, with a history of its own, written BEFORE the copy is kept.
  const other = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Something else' });
  store.editDraft(marc.id, other.id, { body: 'Unrelated.' });
  store.publish(marc.id, other.id, { note: 'first' });
  const retained = asFile(service.bundle(dana.id, page.id));

  // The forgery: an event that belonged to the other page is re-pointed at
  // this one, giving this page a history it did not have. Its id is below the
  // head the retained copy recorded, so it cannot be an append.
  asAnAttacker(db);
  const stolen = db
    .prepare("SELECT id FROM audit_events WHERE page_id = ? AND action = 'page.publish'")
    .get(other.id) as { id: number };
  db.prepare('UPDATE audit_events SET page_id = ? WHERE id = ?').run(page.id, stolen.id);
  recomputeTheWholeChain(db);

  const fresh = asFile(service.bundle(dana.id, page.id));
  const result = compareAttestations(retained, fresh);
  assert.equal(result.ok, false);
  const inserted = result.findings.find((f) => f.kind === 'event_inserted_into_the_past');
  assert.ok(inserted, JSON.stringify(result.findings.map((f) => f.kind)));
  assert.equal(inserted.eventId, stolen.id);
  assert.match(inserted.message, /inserted into history rather than appended to it/);
});

test('compare: a register drawn for the same instant cannot lose the approval it recorded', () => {
  const { db, store, dana, collection, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const at = new Date().toISOString();
  const retained = asFile(service.register(dana.id, collection.id, { at }));
  assert.equal(
    (retained as { register: { pageId: string }[] }).register.some((r) => r.pageId === page.id),
    true,
    'the fixture page was not Canonical at that instant, so this test proves nothing',
  );

  // The approval never happened. The chain is recomputed over the new story,
  // so Canon verifies clean — and the register redrawn for the SAME instant no
  // longer names the approval that granted the mark it is still showing.
  asAnAttacker(db);
  db.prepare("DELETE FROM audit_events WHERE action = 'page.approve' AND page_id = ?").run(page.id);
  recomputeTheWholeChain(db);
  assert.equal(store.verifyAuditChain(dana.id).ok, true, 'the forgery left a break, so this is a different test');

  const fresh = asFile(service.register(dana.id, collection.id, { at }));
  const result = compareAttestations(retained, fresh);
  assert.equal(result.ok, false);
  const approval = result.findings.find((f) => f.kind === 'register_approval_changed');
  assert.ok(approval, JSON.stringify(result.findings.map((f) => f.kind)));
  assert.match(approval.message, /it cannot stop having happened/);
});

test('compare: two registers drawn for different instants are not compared, and say why', () => {
  const { db, store, dana, collection } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const a = asFile(service.register(dana.id, collection.id, { at: '2026-01-01' }));
  const b = asFile(service.register(dana.id, collection.id, { at: '2026-06-01' }));
  const result = compareAttestations(a, b);
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((f) => f.kind === 'register_not_compared'));
});

test('compare: an actor who was federated and no longer is, is a finding', () => {
  const { db, store, dana, page } = withActivity();
  const service = bundleWith(db, store, SSO_ENV);
  db.exec('ALTER TABLE actors ADD COLUMN sso_subject TEXT');
  db.prepare('UPDATE actors SET sso_subject = ? WHERE id = ?').run('https://idp.example.com#dana', dana.id);

  const retained = asFile(service.bundle(dana.id, page.id));
  db.prepare('UPDATE actors SET sso_subject = NULL WHERE id = ?').run(dana.id);
  const fresh = asFile(service.bundle(dana.id, page.id));

  const result = compareAttestations(retained, fresh);
  assert.equal(result.ok, false);
  const downgraded = result.findings.find((f) => f.kind === 'identity_downgraded');
  assert.ok(downgraded, JSON.stringify(result.findings.map((f) => f.kind)));
  assert.match(downgraded.message, /tied this actor to a real person has been removed/);
});

test('compare: it checks each file against itself before it compares them', () => {
  const { db, store, dana, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const retained = asFile(service.bundle(dana.id, page.id)) as Record<string, unknown>;
  const edited = JSON.parse(JSON.stringify(retained)) as Record<string, unknown> & {
    versions: { body: string }[];
  };
  // Somebody edits the KEPT copy — the other direction of the same attack.
  edited.versions[0]!.body = 'Keep records for as long as you like.';

  const result = compareAttestations(retained, edited);
  assert.ok(
    result.findings.some((f) => f.kind === 'digest_mismatch'),
    'an edited bundle passed its own digest check',
  );
  // …and the difference itself is still named.
  assert.ok(result.findings.some((f) => f.kind === 'version_changed'));
});

test('compare: it refuses what it cannot compare, with a sentence rather than a stack trace', () => {
  const { db, store, dana, marc, collection, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const one = asFile(service.bundle(dana.id, page.id));
  const other = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Something else' });
  const two = asFile(service.bundle(dana.id, other.id));

  assert.throws(
    () => compareAttestations(one, two),
    (err: unknown) => err instanceof CanonError && /different subjects/.test(err.message),
  );
  assert.throws(
    () => compareAttestations({ hello: 'world' }, one),
    (err: unknown) => err instanceof CanonError && /no manifest/.test(err.message),
  );
  assert.throws(
    () => compareAttestations({ manifest: { format: 'something-else' } }, one),
    (err: unknown) => err instanceof CanonError && /veryl-canon-attestation-v1/.test(err.message),
  );
});

test('compare: the order the files are given in does not matter', () => {
  const { db, store, dana, marc, page } = withActivity();
  const service = bundleWith(db, store, DEV_ENV);
  const retained = asFile(service.bundle(dana.id, page.id));
  store.editDraft(marc.id, page.id, { body: 'Keep records eight years.' });
  const fresh = asFile(service.bundle(dana.id, page.id));

  const backwards = compareAttestations(fresh, retained);
  assert.equal(backwards.ok, true);
  assert.ok(backwards.findings.some((f) => f.kind === 'order'));
  assert.equal(backwards.earlier.generatedAt < backwards.later.generatedAt, true);
});

test('keep this: the bundle tells its reader to keep it, and how to use it later', () => {
  const { db, store, dana, page } = withActivity();
  const bundle = bundleWith(db, store, DEV_ENV).bundle(dana.id, page.id);
  const keep = bundle.manifest.keepThis.join('\n');
  assert.match(keep, /KEEP THIS FILE, somewhere Canon cannot write/);
  assert.match(keep, /compare-attestations/);
  assert.match(bundle.manifest.howToVerify.join('\n'), /Compare this bundle against one you kept earlier/);

  const html = renderPageAttestationHtml(bundle);
  assert.match(html, /Keep this document/);
  assert.match(html, /A retained attestation is an external anchor/);
});
