import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import { renderCollectionAttestationHtml, renderPageAttestationHtml } from '../src/attestation.js';
import { MAX_EFFECTIVE_DATE_HORIZON_DAYS, MIN_EFFECTIVE_DATE } from '../src/effectivedate.js';

// USER-TESTING.md T1.5. An auditor set a canonical clinical policy's effective
// date to 2019-01-01 — seven years before the page existed — and Canon accepted
// it silently, printed it as EFFECTIVE DATE January 1, 2019, and put it in an
// attestation beside a creation date that contradicted it. Ten of the sixteen
// Canonical policies in the same collection were backdated and six carried no
// effective date at all, so, in her words, "my falsified entry is
// indistinguishable from the legitimate ones."
//
// The fix is NOT that backdating is refused. A policy that genuinely took
// effect in 2019 and was migrated into Canon in 2026 is the ordinary case, and
// refusing it would teach people to type today's date. The fix is that a
// backdated date must SAY WHERE IT COMES FROM, and that whether it does or not
// is visible in three places: the page itself, the record-health surface, and
// the attestation bundle beside the creation date it contradicts.
//
// These tests are the auditor's own procedure, run against the record.

const TODAY = new Date().toISOString().slice(0, 10);

function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Clinical Policy' });
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

/** A Canonical policy, with whatever effective date and basis it is given. */
function canonicalPolicy(
  env: ReturnType<typeof setup>,
  title: string,
  fields: { effectiveDate?: string | null; effectiveDateBasis?: string | null } = {},
) {
  const page = env.store.createPage(env.marc.id, {
    collectionId: env.collection.id,
    type: 'policy',
    title,
  });
  env.store.editDraft(env.marc.id, page.id, {
    body: `${title} body.`,
    fields: {
      ownerId: env.marc.id,
      approverId: env.iris.id,
      reviewDate: '2099-01-01',
      effectiveDate: fields.effectiveDate ?? TODAY,
      ...(fields.effectiveDateBasis !== undefined ? { effectiveDateBasis: fields.effectiveDateBasis } : {}),
    },
  });
  env.store.submitForReview(env.marc.id, page.id);
  return env.store.approve(env.iris.id, page.id);
}

/**
 * A page as a build BEFORE this rule would have left it: a backdated effective
 * date with nothing recorded about where it came from. There is no supported
 * way to create one now, which is the point — so the test writes the row the
 * way an older Canon did, current value and version alike. `page_versions` is
 * append-only at the storage layer, so the trigger comes off for the forgery
 * and goes straight back on, exactly as attestation.test.ts does to simulate a
 * tampered log.
 */
function backdateAsLegacyRecord(db: DatabaseSync, pageId: string, effectiveDate: string): void {
  db.exec('DROP TRIGGER IF EXISTS page_versions_append_only_update');
  try {
    db.prepare('UPDATE pages SET effective_date = ?, effective_date_basis = NULL WHERE id = ?').run(
      effectiveDate,
      pageId,
    );
    const rows = db.prepare('SELECT number, fields_json FROM page_versions WHERE page_id = ?').all(pageId) as {
      number: number;
      fields_json: string;
    }[];
    for (const row of rows) {
      const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
      fields.effectiveDate = effectiveDate;
      delete fields.effectiveDateBasis;
      db.prepare('UPDATE page_versions SET fields_json = ? WHERE page_id = ? AND number = ?').run(
        JSON.stringify(fields),
        pageId,
        row.number,
      );
    }
  } finally {
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS page_versions_append_only_update BEFORE UPDATE ON page_versions ' +
        "BEGIN SELECT RAISE(ABORT, 'page_versions is append-only'); END",
    );
  }
}

// ---------------------------------------------------------------------------
// 1. The shape. `isIsoDate` existed all along and was never called on this field.

test('effective date: a date, inside a window a document-control system can mean', () => {
  const env = setup();
  const { store, marc, collection } = env;
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });

  // Prose is not a date. This is the check that was missing entirely: the
  // review date beside it was validated and this one never was.
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: 'January 2019' } }), 'invalid');
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '2019-13-45' } }), 'invalid');
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '2019-02-30' } }), 'invalid');
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '19-01-01' } }), 'invalid');

  // A slipped century is a typo, not a date, in both directions. Neither is a
  // judgement about how old a policy may be: below the floor and beyond the
  // horizon the value has stopped meaning anything a person could act on.
  const belowFloor = expectCode(
    () => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '0219-01-01' } }),
    'invalid',
  );
  assert.match(belowFloor!.message, /typo/);
  assert.equal(belowFloor!.details.earliest, MIN_EFFECTIVE_DATE);

  // "Effective from 2099" is as unsupportable as 2019 and nobody had tested it.
  const beyondHorizon = expectCode(
    () => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '2099-01-01' } }),
    'invalid',
  );
  assert.match(beyondHorizon!.message, /not a commitment anyone can keep/);
  assert.equal(beyondHorizon!.details.latest, daysFromToday(MAX_EFFECTIVE_DATE_HORIZON_DAYS));

  // A future effective date inside the horizon is ordinary and is accepted: a
  // policy approved now to take effect next quarter is what the field is for.
  store.editDraft(marc.id, page.id, { fields: { effectiveDate: daysFromToday(90) } });
  assert.equal(store.getDraft(marc.id, page.id)!.fields.effectiveDate, daysFromToday(90));

  // And it is still Policy-only, on both halves of the field.
  const spec = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  expectCode(() => store.editDraft(marc.id, spec.id, { fields: { effectiveDate: TODAY } }), 'invalid');
  expectCode(
    () => store.editDraft(marc.id, spec.id, { fields: { effectiveDateBasis: 'Migrated from the old wiki' } }),
    'invalid',
  );
  // But a client sending the whole field set with nothing in the basis is not
  // making a claim, and is not refused for it.
  store.editDraft(marc.id, spec.id, { fields: { effectiveDateBasis: null } });
});

// ---------------------------------------------------------------------------
// 2. Required on a Policy, and on nothing else. TYPE_RULES answers, not a list.

test('effective date: required before a Policy can publish, and only a Policy', () => {
  const env = setup();
  const { store, marc, iris, collection } = env;

  const policy = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, policy.id, {
    body: 'Keep records seven years.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01' },
  });
  const refused = expectCode(() => store.publish(marc.id, policy.id), 'workflow');
  assert.match(refused!.message, /requires an effective date/);
  // The same bar on the way to Canonical, so it cannot be walked round by
  // submitting instead of publishing.
  expectCode(() => store.submitForReview(marc.id, policy.id), 'workflow');
  store.editDraft(marc.id, policy.id, { fields: { effectiveDate: TODAY } });
  assert.equal(store.publish(marc.id, policy.id).effectiveDate, TODAY);

  // A Spec, a Plan and a Note are not asked: they do not carry the field at all.
  const spec = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  store.editDraft(marc.id, spec.id, { body: 'Endpoints.', fields: { ownerId: marc.id, approverId: iris.id } });
  assert.equal(store.publish(marc.id, spec.id).effectiveDate, null);
  const plan = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q4' });
  store.editDraft(marc.id, plan.id, { body: 'Milestones.', fields: { ownerId: marc.id } });
  assert.equal(store.publish(marc.id, plan.id).effectiveDate, null);
  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(marc.id, note.id, { body: 'Thinking.' });
  assert.equal(store.publish(marc.id, note.id).effectiveDate, null);
});

// ---------------------------------------------------------------------------
// 3. The auditor's forgery, and the migration it was indistinguishable from.

test('effective date: backdating without saying where the date comes from is refused', () => {
  const env = setup();
  const { store, marc, iris, collection } = env;
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Consent policy' });

  // Ruth's keystroke: seven years before the page existed, and nothing else.
  const refused = expectCode(
    () =>
      store.editDraft(marc.id, page.id, {
        body: 'Consent is obtained in writing.',
        fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: '2019-01-01' },
      }),
    'invalid',
  );
  assert.match(refused!.message, /earlier than anything Canon holds about this page/);
  assert.equal(refused!.details.needs, 'effectiveDateBasis');
  assert.equal(refused!.details.effectiveDate, '2019-01-01');

  // The migration: the same date, with the source of it named. Accepted.
  const basis = 'Adopted 2019-01-01 by the Clinical Governance Committee, minute CGC-2018-11-14; migrated from Confluence.';
  store.editDraft(marc.id, page.id, {
    body: 'Consent is obtained in writing.',
    fields: {
      ownerId: marc.id,
      approverId: iris.id,
      reviewDate: '2099-01-01',
      effectiveDate: '2019-01-01',
      effectiveDateBasis: basis,
    },
  });
  store.submitForReview(marc.id, page.id);
  const canonical = store.approve(iris.id, page.id);
  assert.equal(canonical.effectiveDate, '2019-01-01');
  assert.equal(canonical.effectiveDateBasis, basis);

  // The basis is a structured field like every other: versioned, and carried
  // in the version's own fields rather than in prose somewhere.
  const [version] = store.listVersions(marc.id, page.id);
  assert.equal(version!.fields.effectiveDateBasis, basis);

  // Whitespace is not a basis: the requirement cannot be met with the space bar.
  const second = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Second' });
  expectCode(
    () =>
      store.editDraft(marc.id, second.id, {
        fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: '2019-01-01', effectiveDateBasis: '   ' },
      }),
    'invalid',
  );
});

test('effective date: an agent proposing a backdated date is asked the same question', () => {
  const env = setup();
  const { store, marc, iris, collection } = env;
  const agent = store.createActor({ kind: 'agent', name: 'Scout', registryRef: 'ap-scout' });
  store.setMember(env.dana.id, collection.id, agent.id, 'edit');
  const policy = canonicalPolicy(env, 'Consent policy');

  expectCode(
    () =>
      store.createProposal(agent.id, policy.id, {
        rationale: 'The register says it took effect in 2019.',
        fields: { effectiveDate: '2019-01-01' },
      }),
    'invalid',
  );

  // With the source named, the proposal opens. An agent may make the claim; it
  // may not make it silently, and a person still accepts it.
  const proposal = store.createProposal(agent.id, policy.id, {
    rationale: 'The register says it took effect in 2019.',
    fields: { effectiveDate: '2019-01-01', effectiveDateBasis: 'Controlled-document register, entry CP-014.' },
  });
  assert.equal(proposal.fields.effectiveDateBasis, 'Controlled-document register, entry CP-014.');
  const accepted = store.acceptProposal(iris.id, proposal.id, {});
  assert.equal(accepted.page.effectiveDate, '2019-01-01');
  assert.equal(accepted.page.effectiveDateBasis, 'Controlled-document register, entry CP-014.');
});

test('effective date: the declaration is asked of whoever sets the date, not of the record', () => {
  const env = setup();
  const { db, store, marc, iris } = env;
  // A page as an older build left it: backdated, unexplained. This is the
  // migration-safety property in one test — the ten pages the auditor found
  // keep working, because the question is asked of a person setting a date and
  // there is nobody to ask about a date somebody set in a previous build.
  const legacy = canonicalPolicy(env, 'Legacy policy');
  backdateAsLegacyRecord(db, legacy.id, '2019-01-01');

  // Publishing runs the type's rules over the whole field set, and the
  // inherited 2019 date passes them untouched.
  store.editDraft(marc.id, legacy.id, { body: 'Revised wording, same policy.' });
  assert.equal(store.publish(marc.id, legacy.id).effectiveDate, '2019-01-01');
  // And so does the road back to Canonical.
  store.editDraft(marc.id, legacy.id, { body: 'Revised wording, same policy, reviewed.' });
  store.submitForReview(marc.id, legacy.id);
  const republished = store.approve(iris.id, legacy.id);
  assert.equal(republished.status, 'canonical');
  assert.equal(republished.effectiveDate, '2019-01-01'); // untouched, and still unexplained
  assert.equal(republished.effectiveDateBasis, null);

  // But the moment somebody CHANGES it, they answer for the new date.
  expectCode(() => store.editDraft(marc.id, legacy.id, { fields: { effectiveDate: '2018-06-01' } }), 'invalid');

  // Clearing the date takes the basis with it rather than leaving an
  // explanation of nothing behind — and the page then cannot publish, because a
  // Policy owes the record an effective date.
  const explained = canonicalPolicy(env, 'Explained policy', {
    effectiveDate: '2020-03-01',
    effectiveDateBasis: 'Board resolution 2020-03; migrated from SharePoint.',
  });
  store.editDraft(marc.id, explained.id, { fields: { effectiveDate: null } });
  assert.equal(store.getDraft(marc.id, explained.id)!.fields.effectiveDateBasis, null);
  expectCode(() => store.publish(marc.id, explained.id), 'workflow');
});

// ---------------------------------------------------------------------------
// 4. Record health: the exception she asked to be able to sample.

test('record health: a backdated effective date is a named exception, not a silence', () => {
  const env = setup();
  const { db, store, marc, collection } = env;

  // The three populations the auditor described, in one collection.
  const clean = canonicalPolicy(env, 'Current policy'); // effective today
  const declared = canonicalPolicy(env, 'Migrated policy', {
    effectiveDate: '2019-01-01',
    effectiveDateBasis: 'Adopted 2019 by the Clinical Governance Committee; migrated from Confluence.',
  });
  const forged = canonicalPolicy(env, 'Forged policy');
  backdateAsLegacyRecord(db, forged.id, '2019-01-01');
  const undated = canonicalPolicy(env, 'Undated policy');
  db.prepare('UPDATE pages SET effective_date = NULL, effective_date_basis = NULL WHERE id = ?').run(undated.id);
  const future = canonicalPolicy(env, 'Future policy', { effectiveDate: daysFromToday(90) });

  const health = store.collectionHealth(marc.id, collection.id);
  assert.equal(health.pages, 5);
  // Two pages pre-date their own first publication…
  assert.equal(health.backdatedEffectiveDate, 2);
  // …and exactly one of them says nothing about why. THAT is the exception:
  // before this work both were simply "effective date 2019-01-01".
  assert.equal(health.backdatedWithoutBasis, 1);
  assert.equal(health.canonicalWithoutEffectiveDate, 1);
  assert.equal(health.notYetInForce, 1);

  // A count nobody can open is a rumour, so every count is a filter too, and
  // the auditor's actual question is one call: which Canonical policies claim
  // to pre-date this record and say nothing about why?
  const sample = store.runQuery(marc.id, {
    collectionIds: [collection.id],
    types: ['policy'],
    statuses: ['canonical'],
    backdated: true,
    hasEffectiveDateBasis: false,
  });
  assert.deepEqual(sample.map((r) => r.pageId), [forged.id]);
  assert.equal(sample[0]!.backdated, true);
  assert.equal(sample[0]!.backdatedWithoutBasis, true);
  assert.equal(sample[0]!.effectiveDateBasis, null);

  // And the legitimate migration is a different, equally openable population.
  const migrated = store.runQuery(marc.id, {
    collectionIds: [collection.id],
    backdated: true,
    hasEffectiveDateBasis: true,
  });
  assert.deepEqual(migrated.map((r) => r.pageId), [declared.id]);
  assert.match(migrated[0]!.effectiveDateBasis!, /Clinical Governance Committee/);

  // The six with no date at all are their own list.
  const none = store.runQuery(marc.id, { collectionIds: [collection.id], hasEffectiveDate: false });
  assert.deepEqual(none.map((r) => r.pageId), [undated.id]);

  // Nothing here calls the clean page an exception.
  assert.equal(store.runQuery(marc.id, { collectionIds: [collection.id], backdated: false }).length, 3);
  assert.ok(store.runQuery(marc.id, { collectionIds: [collection.id] }).some((r) => r.pageId === clean.id));
  assert.ok(future.id);
});

// ---------------------------------------------------------------------------
// 5. The attestation: the contradiction, reconciled where she found it.

test('attestation: the effective date is reconciled against the creation date it contradicts', () => {
  const env = setup();
  const { db, store, marc } = env;
  const forged = canonicalPolicy(env, 'Forged policy');
  backdateAsLegacyRecord(db, forged.id, '2019-01-01');

  const bundle = store.pageAttestation(marc.id, forged.id);
  const standing = bundle.effectiveDateStanding;
  assert.equal(standing.effectiveDate, '2019-01-01');
  assert.equal(standing.basis, null);
  assert.equal(standing.backdated, true);
  assert.equal(standing.unexplained, true);
  assert.equal(standing.createdAt, bundle.page.createdAt);
  assert.equal(standing.firstPublishedAt, bundle.versions[0]!.createdAt);
  assert.equal(standing.recordStarts, bundle.versions[0]!.createdAt.slice(0, 10));
  assert.match(standing.note, /No basis was recorded/);

  // The manifest SAYS it, rather than leaving a reader to compare two dates in
  // different sections — which is exactly how this was missed.
  assert.ok(
    bundle.manifest.asserts.some((a) => a.includes('PRECEDES') && a.includes('NO basis')),
    `asserts should name the pre-dating claim: ${JSON.stringify(bundle.manifest.asserts)}`,
  );
  assert.ok(bundle.manifest.limits.some((l) => l.includes('ASSERTION by the person who set it')));

  // And the human rendering carries the same finding where a person reads it.
  const html = renderPageAttestationHtml(bundle);
  assert.match(html, /pre-dates the record/);
  assert.match(html, /No basis was recorded for the earlier date/);
  assert.match(html, /Record starts/);
  assert.ok(!html.includes('http://') && !html.includes('https://'), 'the bundle stays self-contained');
});

test('attestation: a declared migration and a keystroke are told apart in the bundle', () => {
  const env = setup();
  const { db, store, marc } = env;
  const basis = 'Adopted 2019-01-01 by the Clinical Governance Committee, minute CGC-2018-11-14; migrated from Confluence.';
  const declared = canonicalPolicy(env, 'Migrated policy', { effectiveDate: '2019-01-01', effectiveDateBasis: basis });
  const forged = canonicalPolicy(env, 'Forged policy');
  backdateAsLegacyRecord(db, forged.id, '2019-01-01');

  const good = store.pageAttestation(marc.id, declared.id);
  assert.equal(good.effectiveDateStanding.backdated, true);
  assert.equal(good.effectiveDateStanding.unexplained, false); // the difference
  assert.equal(good.effectiveDateStanding.basis, basis);
  assert.match(good.effectiveDateStanding.note, /Canon records the basis; it cannot verify it/);
  assert.match(renderPageAttestationHtml(good), /Clinical Governance Committee/);

  // Who asserted it, and when, is in the field history beside the date itself —
  // attributed to the author of the version that carried it, which is how every
  // other structured field is attributed.
  const basisChange = good.fieldHistory.find((f) => f.field === 'effectiveDateBasis');
  const dateChange = good.fieldHistory.find((f) => f.field === 'effectiveDate');
  assert.ok(basisChange, 'the basis is a field with a history like any other');
  assert.equal(basisChange!.to, basis);
  assert.equal(basisChange!.version, dateChange!.version); // the date and its basis land together
  assert.equal(basisChange!.byId, good.versions[0]!.authorId);
  assert.equal(basisChange!.at, good.versions[0]!.createdAt);

  const bad = store.pageAttestation(marc.id, forged.id);
  assert.equal(bad.effectiveDateStanding.unexplained, true);
  assert.equal(bad.fieldHistory.some((f) => f.field === 'effectiveDateBasis'), false);

  // The two bundles differ in the record, not merely in presentation.
  assert.notEqual(good.manifest.contentDigest, bad.manifest.contentDigest);
});

test('register: the effective date is a column, and a pre-dating claim is marked in the row', () => {
  const env = setup();
  const { db, store, marc, collection } = env;
  canonicalPolicy(env, 'Current policy');
  canonicalPolicy(env, 'Migrated policy', {
    effectiveDate: '2019-01-01',
    effectiveDateBasis: 'Board resolution 2018-12; migrated from SharePoint.',
  });
  const forged = canonicalPolicy(env, 'Forged policy');
  backdateAsLegacyRecord(db, forged.id, '2019-01-01');

  const register = store.collectionAttestation(marc.id, collection.id);
  assert.equal(register.register.length, 3);
  const entry = register.register.find((e) => e.pageId === forged.id)!;
  assert.equal(entry.effectiveDate, '2019-01-01');
  assert.equal(entry.backdated, true);
  assert.equal(entry.backdatedWithoutBasis, true);
  assert.ok(entry.firstPublishedAt);
  const clean = register.register.find((e) => e.title === 'Current policy')!;
  assert.equal(clean.backdated, false);

  assert.ok(
    register.manifest.asserts.some((a) => a.includes('2 of these page(s)') && a.includes('1 record no basis')),
    `the register counts its own exceptions: ${JSON.stringify(register.manifest.asserts)}`,
  );

  const html = renderCollectionAttestationHtml(register);
  assert.match(html, /Effective dates preceding the record/);
  assert.match(html, /pre-dates the record · no basis/);
  assert.match(html, /Board resolution 2018-12/);
});

// Round seven, Phase 8. The standing non-technical-voice rule — no HTTP verbs,
// no paths, no protocol vocabulary in copy a person reads — had been applied to
// install and setup strings and missed on refusals. A policy owner backdating a
// date was told to fill in `effectiveDateBasis`, which is a name that appears on
// no screen in the product: the editor's label reads "Where the effective date
// comes from".
test('copy: a refusal names the field the way the person filling it in sees it', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Migrated policy' });
  const refused = expectCode(
    () =>
      store.editDraft(marc.id, page.id, {
        fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: '2019-01-01' },
      }),
    'invalid',
  );
  assert.doesNotMatch(refused!.message, /effectiveDateBasis/, 'no raw field name in prose a person reads');
  assert.match(refused!.message, /Where the effective date comes from/);
  // The machine-readable half is untouched: an API caller needs the real field
  // name, and a structured detail is not prose.
  assert.equal(refused!.details.needs, 'effectiveDateBasis');

  // The other two doors into the same requirement say it the same way.
  const publishRefused = expectCode(
    () => store.publish(marc.id, store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'No date' }).id),
    'workflow',
  );
  assert.doesNotMatch(publishRefused!.message, /effectiveDateBasis/);
  const orphanBasis = expectCode(
    () => store.editDraft(marc.id, page.id, { fields: { effectiveDateBasis: 'A committee minute' } }),
    'invalid',
  );
  assert.doesNotMatch(orphanBasis!.message, /effectiveDateBasis/);
});
