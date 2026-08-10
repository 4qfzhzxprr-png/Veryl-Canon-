import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function expectCodeAsync(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
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

  const gaps = await store.listGaps(dana.id);
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
  const gap = (await store.listGaps(dana.id))[0]!;
  assert.ok(!('actorId' in gap) && !('askedBy' in gap));
});

test('gaps: operators only, in the same voice as every other refusal', async () => {
  const { store, marc, dana } = setup();
  await store.ask(marc.id, { question: 'What is the office dress code?' });

  // Marc asked the question; Marc still cannot read the gap list, because the
  // list is everyone’s questions, and question text belongs to the asker and
  // to operators — the audit log’s own rule.
  await expectCodeAsync(() => store.listGaps(marc.id), 'forbidden');
  expectCode(() => store.closeGap(marc.id, 'anything', { outcome: 'dismissed' }), 'forbidden');
  assert.equal((await store.listGaps(dana.id)).length, 1);
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
  const gap = (await store.listGaps(dana.id))[0]!;
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
  assert.equal((await store.listGaps(dana.id, { status: 'open' })).length, 0);
});

test('gaps: a resolution that did not take reopens; a dismissal stands and counts', async () => {
  const { store, dana, marc } = setup();

  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  const gap = (await store.listGaps(dana.id))[0]!;

  // Resolved without actually fixing anything: the next asking reopens it,
  // because the record evidently still cannot answer.
  store.closeGap(dana.id, gap.id, { outcome: 'resolved', note: 'wrote the sustainability page' });
  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  const reopened = await store.listGaps(dana.id, { status: 'open' });
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]!.id, gap.id, 'the same gap, reopened, history intact');
  assert.equal(reopened[0]!.timesAsked, 2);

  // Dismissed is a decision about the QUESTION, and it stands — but the count
  // keeps moving, because “dismissed, and still asked monthly” is exactly what
  // gets a dismissal revisited.
  store.closeGap(dana.id, gap.id, { outcome: 'dismissed', note: 'not compliance material' });
  await store.ask(marc.id, { question: 'What is the carbon reduction target?' });
  assert.equal((await store.listGaps(dana.id, { status: 'open' })).length, 0, 'a dismissal is not reopened');
  const dismissed = await store.listGaps(dana.id, { status: 'dismissed' });
  assert.equal(dismissed[0]!.timesAsked, 3, 'and the asking is still counted');

  // Closing a gap demands the sentence, whichever way it closes. A dismissal
  // used to be the one closure with no reason on it — "not the record's
  // business" decided in silence is precisely the decision somebody reviews
  // later (fourth round, Dana: "my Wi-Fi dismissal is now reasonless
  // forever") — so both outcomes now refuse an empty note.
  await store.ask(marc.id, { question: 'Which airline do we book?' });
  const other = (await store.listGaps(dana.id, { status: 'open' }))[0]!;
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'resolved' }), 'invalid');
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'archived' }), 'invalid');
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'dismissed' }), 'invalid');
  expectCode(() => store.closeGap(dana.id, other.id, { outcome: 'dismissed', note: '   ' }), 'invalid');
  const closed = store.closeGap(dana.id, other.id, { outcome: 'dismissed', note: 'travel booking is not this record’s business' });
  assert.equal(closed.status, 'dismissed');
  assert.equal(closed.resolution, 'travel booking is not this record’s business');
  // And the reason is auditable where every other closure is.
  const audited = store.queryAudit(dana.id, { action: 'gap.dismissed' });
  assert.equal(audited[0]!.details.note, 'travel booking is not this record’s business');
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

test('gaps: a gap the record has since learned to answer is flagged, and the probe leaves no trace', async () => {
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
  await store.ask(marc.id, { question: 'How do we handle submarine procurement?' });

  // Before anybody teaches the record anything, both open gaps still refuse.
  const before = await store.listGaps(dana.id);
  assert.ok(before.every((g) => g.nowAnswers === false), 'probed, and honestly still refused');

  // The alias lands and earns the mark, exactly as in the loop test above.
  store.editDraft(marc.id, page.id, { fields: { aliases: ['urgent claims'] } });
  store.publish(marc.id, page.id);
  store.editDraft(marc.id, page.id, {});
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id);
  await store.embeddings.ready();

  const askEvents = store.queryAudit(dana.id, { action: 'answer.ask' }).length;
  const gaps = await store.listGaps(dana.id);
  const urgent = gaps.find((g) => g.question === question)!;
  const submarine = gaps.find((g) => /submarine/.test(g.question))!;
  assert.equal(urgent.nowAnswers, true, 'the record learned the word, and the open gap says so');
  assert.equal(submarine.nowAnswers, false, 'a gap the record still refuses is not flagged');

  // The probes were dry runs: no phantom ask on the audit log, no gap row
  // recorded against the record asking itself, and no count moved.
  assert.equal(store.queryAudit(dana.id, { action: 'answer.ask' }).length, askEvents);
  const again = await store.listGaps(dana.id);
  assert.equal(again.length, gaps.length, 'probing created no gap');
  assert.equal(again.find((g) => /submarine/.test(g.question))!.timesAsked, 1, 'probing is not asking');
});

// ---------------------------------------------------------------------------
// The Gaps screen's own sentences, pinned in the shipped file the way
// answers.test.ts pins the Ask view: the privacy wording must not overclaim,
// the stale-gap chip must exist, and the laundering guard must stand where
// the operator acts.

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

test('gaps view: the privacy sentence claims what is true, not more', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewGaps('), source.indexOf('async function viewAudit('));
  // The old sentence — "not shown because it is not stored" — was true of the
  // gaps table and false of the product: an operator can join a gap to its
  // asker through the audit log, deliberately, under that log's own rule.
  assert.ok(!view.includes('because it is not stored'), 'the overclaim is gone');
  assert.match(view, /none is stored in this list/, 'the true claim is scoped to this list');
  assert.match(view, /audit log, which has its own rule/, 'and the deliberate join is named, not hidden');
});

test('gaps view: a stale gap gets its chip and a prefilled resolution, and only when the probe says so', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewGaps('), source.indexOf('async function viewAudit('));
  assert.match(view, /The record now answers this — re-check before resolving\./);
  // Strict equality against true: an unprobed gap (past the cap, or an older
  // server) must render as "not probed", never as "now answers".
  assert.ok(view.includes('g.nowAnswers === true'), 'absence of the flag is not evidence either way');
});

test('gaps view: the laundering guard stands beside the resolve input', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewGaps('), source.indexOf('async function viewAudit('));
  assert.match(view, /never paste their question verbatim into a page/);
  assert.ok(
    view.indexOf('class="gap-note"') < view.indexOf('never paste their question verbatim'),
    'the guard is in the card with the input, where the operator acts',
  );
});

// ---------------------------------------------------------------------------
// The steward's half of the loop (Phase 7).
//
// Round seven, tester 24: "`#/gaps` is operator-only — no collection role opens
// it, not even `admin`. The refusal is well written, but the person whose job
// is record health cannot see the record's holes. Worse, the gaps list and the
// fix live with different people" — the prescribed remedy is the "Also known
// as" alias field, which lives in the steward's editor.
//
// So the same list, narrowed, and the narrowing is what these pin.

function twoCollections() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const kit = store.createActor({ kind: 'person', name: 'Kit', email: 'kit@example.com' });
  const lena = store.createActor({ kind: 'person', name: 'Lena', email: 'lena@example.com' });
  store.bootstrapAdministrator(dana.id);
  const benefits = store.createCollection(dana.id, { name: 'Member Benefits' });
  const legal = store.createCollection(dana.id, { name: 'Legal Hold' });
  // Kit administers one collection; Lena the other. Neither is an operator.
  store.setMember(dana.id, benefits.id, kit.id, 'admin');
  store.setMember(dana.id, legal.id, lena.id, 'admin');
  return { db, store, dana, kit, lena, benefits, legal };
}

test('gaps: a collection’s administrator reads the gaps asked of that collection, and no others', async () => {
  const { store, dana, kit, lena, benefits, legal } = twoCollections();
  await store.ask(kit.id, { question: 'How long do we keep denied claims?', collectionId: benefits.id });
  await store.ask(lena.id, { question: 'When does a hold expire?', collectionId: legal.id });
  await store.ask(dana.id, { question: 'What is the office dress code?' });

  // The operator's list is unchanged: everything, including the question asked
  // of no collection at all.
  const all = await store.listGaps(dana.id);
  assert.equal(all.length, 3);

  const kits = await store.listGaps(kit.id);
  assert.deepEqual(kits.map((g) => g.question), ['How long do we keep denied claims?']);
  const lenas = await store.listGaps(lena.id);
  assert.deepEqual(lenas.map((g) => g.question), ['When does a hold expire?']);

  // A gap asked across the WHOLE record belongs to neither steward: nothing
  // about it says whose material it was, and guessing would put one team's
  // question in front of another team's steward.
  assert.equal(kits.some((g) => g.collectionId === null), false);
  assert.equal(lenas.some((g) => g.collectionId === null), false);

  // And the screen can say which of the two lists it is holding.
  assert.deepEqual(store.gapScopeOf(dana.id), { scope: 'operator', collectionIds: [] });
  assert.deepEqual(store.gapScopeOf(kit.id), { scope: 'steward', collectionIds: [benefits.id] });
});

test('gaps: a steward closes a gap of their own, and cannot touch anybody else’s', async () => {
  const { store, dana, kit, lena, benefits, legal } = twoCollections();
  await store.ask(kit.id, { question: 'How long do we keep denied claims?', collectionId: benefits.id });
  await store.ask(lena.id, { question: 'When does a hold expire?', collectionId: legal.id });

  const mine = (await store.listGaps(kit.id))[0]!;
  const theirs = (await store.listGaps(lena.id))[0]!;

  // Closing follows reading: the steward who added the alias is the person
  // with the sentence worth keeping.
  const closed = store.closeGap(kit.id, mine.id, {
    outcome: 'resolved',
    note: 'Added "denied claims" as an alias on Claims Retention Standard.',
  });
  assert.equal(closed.status, 'resolved');
  assert.equal(store.queryAudit(dana.id, { action: 'gap.resolved' }).length, 1);

  // Somebody else's gap reads as no such gap — the same answer an invented id
  // gets, so trying ids tells a steward nothing about what other collections
  // are being asked.
  const other = expectCode(() => store.closeGap(kit.id, theirs.id, { outcome: 'dismissed', note: 'no' }), 'not_found');
  const invented = expectCode(() => store.closeGap(kit.id, 'no-such-gap', { outcome: 'dismissed', note: 'no' }), 'not_found');
  assert.equal(other.message.replace(theirs.id, 'ID'), invented.message.replace('no-such-gap', 'ID'));
  assert.equal((await store.listGaps(lena.id))[0]!.status, 'open', 'their gap is untouched');

  // A member who administers nothing is still refused, in the same words.
  const marc = store.createActor({ kind: 'person', name: 'Marc' });
  store.setMember(dana.id, benefits.id, marc.id, 'edit');
  await expectCodeAsync(() => store.listGaps(marc.id), 'forbidden');
});

test('gaps: a steward’s pointers never name a page they cannot open', async () => {
  const { db, store, dana, kit, benefits, legal } = twoCollections();
  // A gap recorded against the steward's collection whose `nearest` pointers
  // were captured from somebody with wider access. It should not happen —
  // pointers come from the asker's own permission-filtered results — but "very
  // unlikely" is not a rule, and a page title is identity.
  const hidden = store.createPage(dana.id, { collectionId: legal.id, type: 'note', title: 'Litigation hold — Redwood' });
  await store.ask(kit.id, { question: 'What must we preserve?', collectionId: benefits.id });
  const gap = (await store.listGaps(dana.id))[0]!;
  db.prepare('UPDATE gaps SET nearest_json = ? WHERE id = ?')
    .run(JSON.stringify([{ pageId: hidden.id, title: 'Litigation hold — Redwood' }]), gap.id);

  const operatorSees = (await store.listGaps(dana.id))[0]!;
  assert.equal(operatorSees.nearest.length, 1, 'an operator’s list is unchanged');
  const stewardSees = (await store.listGaps(kit.id))[0]!;
  assert.deepEqual(stewardSees.nearest, [], 'a title of a page they cannot open is not a pointer, it is a leak');
});

test('gaps view: a narrowed list says it is narrowed, and its empty state claims nothing wider', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const view = source.slice(source.indexOf('async function viewGaps('), source.indexOf('async function viewAudit('));
  // The scope comes from the server rather than being inferred, because an
  // empty list is exactly the case where inference is impossible and exactly
  // the case where the wrong sentence does the most harm.
  assert.match(view, /answer\.scope === 'steward'/);
  assert.match(view, /the collections you administer/);
  // Phase 5's rule, applied to the screen this phase widened: "No open gaps.
  // Every question the record refused has been looked at" is true for an
  // operator and false for a steward reading one collection's worth.
  assert.match(view, /This says nothing about the rest of the record\./);
});
