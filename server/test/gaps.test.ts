import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import { normalizeQuestion } from '../src/gaps.js';

// The refused-questions loop (gaps.ts): every refusal is a gap report, held
// until an operator closes it. What is tested here, in order of what would
// hurt most if it quietly broke: the privacy property (no asker, ever), the
// permission gate (operators only — the audit log's redaction rule carried
// forward), and the loop itself — refusal recorded, triaged, and the
// dismissed-but-still-asked counter that gets a dismissal revisited.

const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  store.bootstrapAdministrator(dana.id);
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { db, store, dana, marc, iris, collection };
}

function publishCanonical(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body,
    fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

test('gaps: a refusal becomes a gap, deduplicated by what was meant', async () => {
  const { store, dana, marc } = setup();

  await store.ask(marc.id, { question: 'How do we handle submarine procurement?' });
  await store.ask(marc.id, { question: '  how do we handle SUBMARINE procurement??' });
  await store.ask(dana.id, { question: 'How do we handle submarine procurement?' });

  const gaps = store.listGaps(dana.id);
  assert.equal(gaps.length, 1, 'three phrasings of one question are one gap');
  assert.equal(gaps[0]!.timesAsked, 3);
  assert.equal(gaps[0]!.status, 'open');
  // The verbatim text shown is the LAST asking, so an operator sees a real
  // sentence, not the normalised key.
  assert.equal(gaps[0]!.question, 'How do we handle submarine procurement?');

});

test('gaps: no asker is stored — the column does not exist', async () => {
  const { db, store, marc, dana } = setup();
  await store.ask(marc.id, { question: 'What is the office dress code?' });

  // The property is structural, so it is asserted structurally: the table has
  // no column that could hold an actor, and therefore no future query can
  // leak one. This is redactAuditDetails’ rule made unbreakable rather than
  // re-applied.
  const columns = (db.prepare('PRAGMA table_info(gaps)').all() as { name: string }[]).map((c) => c.name);
  for (const column of columns) {
    assert.ok(!/actor|asker|who|user/i.test(column), `gaps.${column} looks like it names a person`);
  }
  const gap = store.listGaps(dana.id)[0]!;
  assert.ok(!('actorId' in gap) && !('askedBy' in gap));
});

test('gaps: operators only, in the same voice as every other refusal', async () => {
  const { store, marc, dana } = setup();
  await store.ask(marc.id, { question: 'What is the office dress code?' });

  // Marc asked the question; Marc still cannot read the gap list, because the
  // list is everyone’s questions, and question text belongs to the asker and
  // to operators — the audit log’s own rule.
  expectCode(() => store.listGaps(marc.id), 'forbidden');
  expectCode(() => store.closeGap(marc.id, 'anything', { outcome: 'dismissed' }), 'forbidden');
  assert.equal(store.listGaps(dana.id).length, 1);
});

test('gaps: the loop closes — refusal, alias, resolution, and the fix holds', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Claims Processing Standard',
    'An expedited claim, where delay would jeopardise the member’s health, is decided within seventy-two hours.',
  );
  publishCanonical(store, marc.id, iris.id, collection.id, 'Claims intake register',
    'Every claim received is entered in the intake register on the day it arrives.');
  publishCanonical(store, marc.id, iris.id, collection.id, 'Office plant care',
    'Plants are watered on Fridays by whoever is on the rota.');
  await store.embeddings.ready();

  const question = 'How quickly must we decide an urgent claim?';
  await store.ask(marc.id, { question });

  // The gap carries the refusal’s own pointers, so the operator triaging it
  // starts at the page that needs the word.
  const gap = store.listGaps(dana.id)[0]!;
  assert.equal(gap.question, question);
  assert.ok(gap.nearest.some((n) => n.pageId === page.id), 'the gap points at the page to teach');

  // The operator (or the owner they nudge) teaches the record the word…
  store.editDraft(marc.id, page.id, { fields: { aliases: ['urgent claims'] } });
  store.publish(marc.id, page.id);
  store.editDraft(marc.id, page.id, {});
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id);
  await store.embeddings.ready();

  // …resolves the gap with the sentence that says so…
  const resolved = store.closeGap(dana.id, gap.id, {
    outcome: 'resolved',
    note: 'Added “urgent claims” as an alias on Claims Processing Standard',
  });
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.resolution!, /alias/);

  // …and the closure is on the audit record like any other act.
  const events = store.queryAudit(dana.id, { action: 'gap.resolved' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.details.gapId, gap.id);

  // The fix holds: the same question now answers, so no reopening happens.
  const after = await store.ask(marc.id, { question });
  assert.equal(after.refused, false);
  assert.equal(store.listGaps(dana.id, { status: 'open' }).length, 0);
});

test('gaps: a resolution that did not take reopens; a dismissal stands and counts', async () => {
  const { store, dana, marc } = setup();

  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  const gap = store.listGaps(dana.id)[0]!;

  // Resolved without actually fixing anything: the next asking reopens it,
  // because the record evidently still cannot answer.
  store.closeGap(dana.id, gap.id, { outcome: 'resolved', note: 'wrote the sustainability page' });
  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  const reopened = store.listGaps(dana.id, { status: 'open' });
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]!.id, gap.id, 'the same gap, reopened, history intact');
  assert.equal(reopened[0]!.timesAsked, 2);

  // Dismissed is a decision about the QUESTION, and it stands — but the count
  // keeps moving, because “dismissed, and still asked monthly” is exactly what
  // gets a dismissal revisited.
  store.closeGap(dana.id, gap.id, { outcome: 'dismissed', note: 'not compliance material' });
  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  assert.equal(store.listGaps(dana.id, { status: 'open' }).length, 0, 'a dismissal is not reopened');
  const dismissed = store.listGaps(dana.id, { status: 'dismissed' });
  assert.equal(dismissed[0]!.timesAsked, 3, 'and the asking is still counted');

  // Resolving demands the sentence; dismissing does not.
  await store.ask(marc.id, { question: 'Which airline do we book?' });
  const other = store.listGaps(dana.id, { status: 'open' })[0]!;
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'resolved' }), 'invalid');
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'archived' }), 'invalid');
  assert.equal(store.closeGap(dana.id, other.id, { outcome: 'dismissed' }).status, 'dismissed');
});

test('gaps: recording never costs the asker their answer', async () => {
  const { db, store, marc } = setup();
  // Break the gaps table outright; the refusal must still come back whole.
  db.exec('DROP TABLE gaps');
  const response = await store.ask(marc.id, { question: 'What is the office dress code?' });
  assert.equal(response.refused, true);
  assert.equal(response.reason, 'no_canonical_match');
});

test('normalizeQuestion: folds what a person would call the same question, and nothing more', () => {
  assert.equal(normalizeQuestion('  How long   do we KEEP claims?  '), 'how long do we keep claims');
  assert.equal(normalizeQuestion('how long do we keep claims?!?'), 'how long do we keep claims');
  assert.notEqual(
    normalizeQuestion('how long do we keep claims'),
    normalizeQuestion('how long do we keep claim records'),
    'different questions stay different gaps — a false merge hides a gap',
  );
});
