import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { store, dana, marc, iris, collection };
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

test('permissions: a non-member cannot see or write to a collection', () => {
  const { store, collection } = setup();
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.getCollection(outsider.id, collection.id), 'forbidden');
  expectCode(
    () => store.createPage(outsider.id, { collectionId: collection.id, type: 'note', title: 'Sneak' }),
    'forbidden',
  );
  assert.equal(store.listCollections(outsider.id).length, 0);
});

// USER-TESTING.md T4.4, second round: the Members screen was the last one in
// the product offering a control it would refuse — a fully enabled Remove
// beside every colleague, for somebody holding `edit`, answered by a
// three-second toast in the far corner. These are what it draws its buttons
// from, and the property that keeps them honest.
test('abilities: a collection says who may administer its membership, and who can instead', () => {
  const { store, dana, marc, collection } = setup();

  const hers = store.collectionAbilities(dana.id, collection.id);
  assert.equal(hers.role, 'admin');
  assert.equal(hers.addMember.can, true);
  assert.equal(hers.removeMember.can, true);
  assert.equal(hers.createPage.can, true);

  const his = store.collectionAbilities(marc.id, collection.id);
  assert.equal(his.role, 'edit');
  assert.equal(his.createPage.can, true, 'edit is what creating a page takes');
  assert.equal(his.removeMember.can, false);
  // The three parts of the one sentence: what the act needs, what he holds,
  // and somebody to ask.
  assert.match(his.removeMember.why!, /Removing a member needs the admin role on Compliance/);
  assert.match(his.removeMember.why!, /you hold edit there/);
  assert.match(his.removeMember.why!, /Dana holds it\.$/);
  assert.match(his.addMember.why!, /Adding a member needs the admin role on Compliance/);

  // And it is a mirror: what it reports as refused, the server refuses.
  const refused = expectCode(() => store.removeMember(marc.id, collection.id, dana.id), 'forbidden');
  assert.equal(refused.message, his.removeMember.why);
});

test('abilities: an administrator of the Canon may administer a membership, and is told so', () => {
  const { store, dana, collection } = setup();
  // The break-glass path for a collection whose last admin left (store.ts,
  // `requirePermissionAdmin`). A mirror that missed it would tell an
  // administrator they cannot do a thing the server accepts from them.
  const ade = store.createActor({ kind: 'person', name: 'Ade', email: 'ade@example.com' });
  store.setMember(dana.id, collection.id, ade.id, 'view');
  assert.equal(store.collectionAbilities(ade.id, collection.id).addMember.can, false);
  store.bootstrapAdministrator(ade.id);
  const now = store.collectionAbilities(ade.id, collection.id);
  assert.equal(now.role, 'view');
  assert.equal(now.addMember.can, true);
  assert.equal(now.removeMember.can, true);
});

test('abilities: reading a collection’s abilities needs `view`, like the collection itself', () => {
  const { store, collection } = setup();
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.collectionAbilities(outsider.id, collection.id), 'forbidden');
});

test('a refusal names who can only to somebody who could already have looked', () => {
  const { store, marc, collection } = setup();
  // A member is told the names: anyone holding `view` can read the membership
  // table and every comment on every page in it, so this gives nothing away.
  assert.match(store.collectionAbilities(marc.id, collection.id).removeMember.why!, /Dana holds it/);

  // A non-member is told where to go instead. The same sentence with names in
  // it would be a restricted collection's staff list, handed out by a 403.
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const refused = expectCode(() => store.getCollection(outsider.id, collection.id), 'forbidden');
  assert.match(refused.message, /This needs the view role on Compliance; you hold none there\./);
  assert.match(refused.message, /An administrator of this collection can grant it\.$/);
  assert.ok(!refused.message.includes('Dana'), 'a non-member is told nobody’s name');
});

// USER-TESTING.md, second round: "A new page is created with no owner, and
// nothing prompts for one. Nine pages in one seeded collection show — for
// Owner."
test('a page is owned from the moment it is created, by its creator unless told otherwise', () => {
  const { store, dana, marc, collection } = setup();

  const mine = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  assert.equal(mine.ownerId, marc.id);

  // Named at creation, which is what the New page dialog does when the creator
  // knows the page belongs to somebody else.
  const hers = store.createPage(marc.id, {
    collectionId: collection.id,
    type: 'spec',
    title: 'Vault spec',
    ownerId: dana.id,
  });
  assert.equal(hers.ownerId, dana.id);

  // A Note has no owner field, so it is given none rather than one it would
  // silently lose at its first publish.
  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  assert.equal(note.ownerId, null);

  // Unowned stays possible, but only by saying so.
  const unowned = store.createPage(marc.id, {
    collectionId: collection.id,
    type: 'plan',
    title: 'Q4 plan',
    ownerId: null,
  });
  assert.equal(unowned.ownerId, null);

  // An owner Canon cannot name is not an owner.
  expectCode(
    () => store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q1', ownerId: 'nobody' }),
    'not_found',
  );

  // And the draft inherits it, so the editor opens on it and a publish keeps
  // it — the owner is set once and travels.
  const draft = store.editDraft(marc.id, mine.id, { body: 'Six years.' });
  assert.equal(draft.fields.ownerId, marc.id);

  // On the record, even when it is the default: "who was this page born
  // accountable to" is what an auditor asks of a page whose owner has since
  // changed twice.
  const created = store.queryAudit(dana.id, { action: 'page.create' }).find((e) => e.pageId === mine.id)!;
  assert.equal(created.details.ownerId, marc.id);
});

test('agents require a Registry reference; Canon stores no credentials of its own', () => {
  const { store } = setup();
  expectCode(() => store.createActor({ kind: 'agent', name: 'Helper' }), 'invalid');
  const agent = store.createActor({ kind: 'agent', name: 'Helper', registryRef: 'passport:helper-1' });
  assert.equal(agent.registryRef, 'passport:helper-1');
});

test('publishing: drafts become immutable versions and the pointer moves', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Meeting notes' });
  assert.equal(page.currentVersion, null);

  store.editDraft(marc.id, page.id, { body: 'First cut' });
  const v1 = store.publish(marc.id, page.id, { note: 'initial' });
  assert.equal(v1.currentVersion, 1);
  assert.equal(store.getDraft(marc.id, page.id), null);

  store.editDraft(marc.id, page.id, { body: 'Second cut' });
  const v2 = store.publish(marc.id, page.id);
  assert.equal(v2.currentVersion, 2);

  const versions = store.listVersions(marc.id, page.id);
  assert.deepEqual(versions.map((v) => [v.number, v.body]), [[1, 'First cut'], [2, 'Second cut']]);
});

test('history is append-only, enforced at the storage layer', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const c = store.createCollection(dana.id, { name: 'X' });
  const page = store.createPage(dana.id, { collectionId: c.id, type: 'note', title: 'N' });
  store.editDraft(dana.id, page.id, { body: 'v1' });
  store.publish(dana.id, page.id);

  assert.throws(() => db.exec(`UPDATE page_versions SET body = 'tampered'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM page_versions'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_events'), /append-only/);
});

test('page lock: one editor at a time, with a visible "being edited by"', () => {
  const { store, dana, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Shared' });
  store.editDraft(marc.id, page.id, { body: 'Marc typing' });

  const err = expectCode(() => store.editDraft(dana.id, page.id, { body: 'Dana typing' }), 'locked');
  assert.match((err as CanonError).message, /being edited by Marc/);
  expectCode(() => store.publish(dana.id, page.id), 'locked');
  expectCode(() => store.discardDraft(dana.id, page.id), 'locked');

  store.discardDraft(marc.id, page.id);
  store.editDraft(dana.id, page.id, { body: 'Dana typing' });
  assert.equal(store.getDraft(dana.id, page.id)!.editorId, dana.id);
});

test('type rules: a policy cannot publish without owner and approver', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, page.id, { body: 'Keep records 7 years.' });
  expectCode(() => store.publish(marc.id, page.id), 'workflow');

  store.editDraft(marc.id, page.id, {
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  const published = store.publish(marc.id, page.id);
  assert.equal(published.currentVersion, 1);
  assert.equal(published.ownerId, marc.id);
  assert.equal(published.effectiveDate, TODAY);
});

test('type rules: effective date is Policy-only', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'spec', title: 'API spec' });
  expectCode(() => store.editDraft(marc.id, page.id, { fields: { effectiveDate: '2026-09-01' } }), 'invalid');
});

test('review workflow: draft -> in review -> canonical, by the named approver only', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });

  const submitted = store.submitForReview(marc.id, page.id);
  assert.equal(submitted.status, 'in_review');
  expectCode(() => store.editDraft(marc.id, page.id, { body: 'sneaky edit' }), 'workflow');
  expectCode(() => store.publish(marc.id, page.id), 'workflow');
  expectCode(() => store.approve(marc.id, page.id), 'forbidden'); // marc holds edit, not approve

  const canonical = store.approve(iris.id, page.id);
  assert.equal(canonical.status, 'canonical');
  assert.equal(canonical.currentVersion, 1);

  // Editing after Canonical drops the mark on the next publish: the mark
  // applies to reviewed content, not whatever came after.
  store.editDraft(marc.id, page.id, { body: 'Amended.' });
  const republished = store.publish(marc.id, page.id);
  assert.equal(republished.status, 'draft');
  assert.equal(republished.currentVersion, 2);
});

// Four testers, in four different roles, read the approver's name where the
// drafter's belonged: on the version, in the compare header, and in the
// downloaded attestation. Canon ENFORCES author != approver at submission and
// then reported them as the same person in the artifacts that exist to prove
// it did. The audit log was right throughout, which is what gave the game away.
test('approval records the drafter as author, not the approver who granted the mark', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention policy' });
  store.editDraft(marc.id, page.id, {
    body: 'Claims records are kept for seven years.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(marc.id, page.id);
  const canonical = store.approve(iris.id, page.id);
  assert.equal(canonical.status, 'canonical');

  // Marc typed it; Iris granted the mark. The version says Marc.
  const versions = store.listVersions(iris.id, page.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.authorId, marc.id);
  assert.notEqual(versions[0]!.authorId, iris.id);

  // And the split is still legible in the log, from the other direction.
  const approvals = store.queryAudit(iris.id, { action: 'page.approve' });
  assert.equal(approvals[0]!.actorId, iris.id);
});

// A reviewer removed her own membership from a collection she had created four
// minutes earlier — one unconfirmed click — and stranded it: no administrator
// left, so members could not be changed, restriction could not be altered, and
// Canon has no archive or delete for a collection. Even the org administrator
// got "No access" from every screen.
test('the last administrator of a collection cannot be removed or demoted', () => {
  const { store, dana, marc, collection } = setup();
  store.setMember(dana.id, collection.id, marc.id, 'edit');

  expectCode(() => store.removeMember(dana.id, collection.id, dana.id), 'workflow');
  expectCode(() => store.setMember(dana.id, collection.id, dana.id, 'edit'), 'workflow');
  assert.equal(store.roleOf(dana.id, collection.id), 'admin', 'still administered');

  // The way out is the act that was missing: hand the role on first.
  store.setMember(dana.id, collection.id, marc.id, 'admin');
  store.removeMember(dana.id, collection.id, dana.id);
  assert.equal(store.roleOf(marc.id, collection.id), 'admin');
});

test('review workflow: the approver can send a draft back with a comment', () => {
  const { store, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q4 plan' });
  store.editDraft(marc.id, page.id, { body: 'Ship it all.', fields: { ownerId: marc.id } });
  store.submitForReview(marc.id, page.id);

  expectCode(() => store.sendBack(iris.id, page.id, { comment: '' }), 'invalid');
  const back = store.sendBack(iris.id, page.id, { comment: 'Too vague; name the milestones.' });
  assert.equal(back.status, 'draft');

  const events = store.queryAudit(iris.id, { action: 'page.send_back' });
  assert.equal(events[0]!.details.comment, 'Too vague; name the milestones.');
});

// The auditor's sequence from USER-TESTING.md T1.3, as a test. A page carries
// its approver in two places — the page row (the published version's) and the
// draft's fields (the one being proposed) — and they differ exactly when the
// approval is handed to somebody else, which is the case that broke.
test('review: the approver the record NAMES is the approver the record ACCEPTS', () => {
  const { store, dana, marc, iris, collection } = setup();
  const nadia = store.createActor({ kind: 'person', name: 'Nadia' });
  store.setMember(dana.id, collection.id, nadia.id, 'approve');

  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  store.submitForReview(marc.id, page.id);
  store.approve(iris.id, page.id);
  assert.equal(store.getPage(marc.id, page.id).approverId, iris.id);

  // An edit drops the Canonical mark on publish (the mark applies to reviewed
  // content), and the next revision hands the approval to Nadia and goes back
  // into review.
  store.editDraft(marc.id, page.id, { body: 'All access is logged and reviewed.' });
  store.publish(marc.id, page.id);
  store.editDraft(marc.id, page.id, { fields: { approverId: nadia.id } });
  store.submitForReview(marc.id, page.id);

  // The page row still says Iris, and truthfully — she approved v1. "Who can
  // approve THIS" is a different question with a different answer, and that is
  // the answer every surface that names an approver has to use.
  assert.equal(store.getPage(marc.id, page.id).approverId, iris.id);
  const review = store.reviewState(marc.id, page.id)!;
  assert.equal(review.approverId, nadia.id);
  assert.equal(review.namesApprover, true);
  assert.equal(review.submittedById, marc.id);
  assert.ok(review.submittedAt);

  // The invariant asserted rather than described: the one named is the one
  // accepted, and nobody else — including the person the page row names.
  expectCode(() => store.approve(iris.id, page.id), 'forbidden');
  const canonical = store.approve(review.approverId!, page.id);
  assert.equal(canonical.status, 'canonical');
  assert.equal(canonical.approverId, nadia.id);
  assert.equal(store.reviewState(marc.id, page.id), null); // nothing pending any more
});

test('review: a brand-new page names its owner, approver and dates the moment it is submitted', () => {
  const { store, dana, marc, iris, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Expenses' });
  store.editDraft(marc.id, page.id, {
    body: 'Receipts within 30 days.',
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  store.submitForReview(marc.id, page.id);

  // Nothing has published, so the page row is empty of the three fields a
  // version publishes. That is what rendered "In review. Waiting on the named
  // approver, —" with owner, approver and both dates blank on every author's
  // first submission.
  //
  // The OWNER is the exception, and deliberately: a page is owned from the
  // moment it is created (see `createPage`), because an unowned page is never a
  // fact about the record — only a gap the product left. Marc created this one
  // and named nobody else, so it is his.
  const row = store.getPage(marc.id, page.id);
  assert.equal(row.currentVersion, null);
  assert.equal(row.ownerId, marc.id);
  assert.equal(row.approverId, null);
  assert.equal(row.effectiveDate, null);

  const review = store.reviewState(marc.id, page.id)!;
  assert.equal(review.approverId, iris.id);
  assert.equal(review.fields.ownerId, marc.id);
  assert.equal(review.fields.effectiveDate, TODAY);
  assert.equal(review.fields.reviewDate, '2099-01-01');

  // Readable by somebody holding only `view`: who is waiting on a page must
  // not depend on holding the page lock. The draft's BODY still does.
  const reader = store.createActor({ kind: 'person', name: 'Reader' });
  store.setMember(dana.id, collection.id, reader.id, 'view');
  assert.equal(store.reviewState(reader.id, page.id)!.approverId, iris.id);
  expectCode(() => store.getDraft(reader.id, page.id), 'forbidden');

  // A Plan names no approver, so the answer is "any approver here" rather than
  // a name — and `namesApprover` is what says so, so null is never read as
  // "nobody knows".
  const plan = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Q4 plan' });
  store.editDraft(marc.id, plan.id, { body: 'Ship it.', fields: { ownerId: marc.id } });
  store.submitForReview(marc.id, plan.id);
  const planReview = store.reviewState(marc.id, plan.id)!;
  assert.equal(planReview.namesApprover, false);
  assert.equal(planReview.approverId, null);
});

// T4.5: the page that was stuck with nobody's name on it.
test('review: an author withdraws their own submission, and only their own', () => {
  const { store, dana, marc, iris, collection } = setup();
  const sam = store.createActor({ kind: 'person', name: 'Sam' });
  store.setMember(dana.id, collection.id, sam.id, 'edit');

  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Expenses' });
  store.editDraft(marc.id, page.id, {
    body: 'Receipts within 30 d',
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  store.submitForReview(marc.id, page.id);
  assert.equal(store.reviewState(marc.id, page.id)!.canWithdraw, true);

  // Not the approver's tool: she has Send back, which costs her a comment to
  // the author and puts her refusal on the record.
  expectCode(() => store.withdrawFromReview(iris.id, page.id), 'forbidden');
  assert.equal(store.reviewState(iris.id, page.id)!.canWithdraw, false);
  // Nor anybody else's who merely holds `edit` here.
  expectCode(() => store.withdrawFromReview(sam.id, page.id), 'forbidden');

  const back = store.withdrawFromReview(marc.id, page.id, { reason: 'Submitted a paragraph early' });
  assert.equal(back.status, 'draft');

  // Unstuck: the editor unlocks and the ordinary road to Canonical is open.
  store.editDraft(marc.id, page.id, { body: 'Receipts within 30 days, with the missing paragraph.' });
  store.submitForReview(marc.id, page.id);
  assert.equal(store.approve(iris.id, page.id).status, 'canonical');
  expectCode(() => store.withdrawFromReview(marc.id, page.id), 'workflow'); // decided; not undoable here

  const events = store.queryAudit(dana.id, { action: 'page.withdraw' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorId, marc.id);
  assert.equal(events[0]!.details.reason, 'Submitted a paragraph early');
});

test('review: withdrawal loosens neither half of separation of duties', () => {
  const { store, dana, marc, iris, collection } = setup();

  // The approver still cannot submit their own draft for review. (Iris holds
  // `approve`, which outranks `edit`, so she can write one.)
  const hers = store.createPage(iris.id, { collectionId: collection.id, type: 'policy', title: 'Her own policy' });
  store.editDraft(iris.id, hers.id, {
    body: 'Mine.',
    fields: { ownerId: iris.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  expectCode(() => store.submitForReview(iris.id, hers.id), 'workflow');

  // And an author still cannot approve their own work — before a withdrawal
  // or after one. Marc holds `edit`, not `approve`, and the named approver is
  // Iris either way.
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Access policy' });
  store.editDraft(marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  store.submitForReview(marc.id, page.id);
  expectCode(() => store.approve(marc.id, page.id), 'forbidden');
  store.withdrawFromReview(marc.id, page.id);
  // Naming himself does not help: submitting a draft he is the approver of is
  // the refusal above, and it did not move.
  store.editDraft(marc.id, page.id, { fields: { approverId: marc.id } });
  expectCode(() => store.submitForReview(marc.id, page.id), 'workflow');
  store.editDraft(marc.id, page.id, { fields: { approverId: iris.id } });
  store.submitForReview(marc.id, page.id);
  expectCode(() => store.approve(marc.id, page.id), 'forbidden');
  assert.equal(store.approve(iris.id, page.id).status, 'canonical');
  assert.equal(store.queryAudit(dana.id, { action: 'page.withdraw' }).length, 1);
});

test('notes publish directly and never carry the Canonical mark', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(marc.id, page.id, { body: 'rough thoughts' });
  expectCode(() => store.submitForReview(marc.id, page.id), 'workflow');
  const published = store.publish(marc.id, page.id);
  assert.equal(published.status, 'draft');
});

test('trees: a branch moves with its children, ids stay stable, cycles are rejected', () => {
  const { store, marc, collection } = setup();
  const plan = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Plan' });
  const spec = store.createPage(marc.id, { collectionId: collection.id, parentId: plan.id, type: 'spec', title: 'Spec' });
  const sub = store.createPage(marc.id, { collectionId: collection.id, parentId: spec.id, type: 'note', title: 'Sub' });
  const other = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Other' });

  expectCode(() => store.movePage(marc.id, plan.id, { parentId: sub.id }), 'invalid'); // cycle

  store.movePage(marc.id, spec.id, { parentId: other.id });
  const tree = store.tree(marc.id, collection.id);
  const otherNode = tree.find((n) => n.id === other.id)!;
  assert.equal(otherNode.children[0]!.id, spec.id);
  assert.equal(otherNode.children[0]!.children[0]!.id, sub.id); // child followed the branch
  assert.equal(store.getPage(marc.id, spec.id).id, spec.id); // stable identity
});

test('audit: restricted-collection views and all writes are on the record, filterable', () => {
  const { store, dana, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Sensitive' });
  store.getPage(dana.id, page.id, { logView: true });

  const views = store.queryAudit(dana.id, { action: 'page.view', actorId: dana.id });
  assert.equal(views.length, 1);
  assert.equal(views[0]!.pageId, page.id);

  const creates = store.queryAudit(dana.id, { action: 'page.create' });
  assert.equal(creates[0]!.actorId, marc.id);

  // An unrestricted collection logs writes but not reads.
  const open = store.createCollection(dana.id, { name: 'Open' });
  const openPage = store.createPage(dana.id, { collectionId: open.id, type: 'note', title: 'Public-ish' });
  store.getPage(dana.id, openPage.id, { logView: true });
  const openViews = store
    .queryAudit(dana.id, { action: 'page.view' })
    .filter((e) => e.pageId === openPage.id);
  assert.equal(openViews.length, 0);
});

test('agent contributions are attributed and marked as agent work in the audit log', () => {
  const { store, dana, collection } = setup();
  const agent = store.createActor({ kind: 'agent', name: 'Freshness Agent', registryRef: 'passport:fresh-1' });
  store.setMember(dana.id, collection.id, agent.id, 'edit');

  const page = store.createPage(agent.id, { collectionId: collection.id, type: 'note', title: 'Stale figures' });
  store.editDraft(agent.id, page.id, { body: 'The Q2 number changed upstream.' });
  store.publish(agent.id, page.id);

  const version = store.getVersion(dana.id, page.id, 1);
  assert.equal(version.authorId, agent.id);
  const events = store.queryAudit(dana.id, { actorId: agent.id, action: 'page.publish' });
  assert.equal(events[0]!.actorKind, 'agent');
});

test('restore creates a new version; history is never rewritten', () => {
  const { store, marc, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'N' });
  store.editDraft(marc.id, page.id, { body: 'good' });
  store.publish(marc.id, page.id);
  store.editDraft(marc.id, page.id, { body: 'worse' });
  store.publish(marc.id, page.id);

  const restored = store.restore(marc.id, page.id, 1);
  assert.equal(restored.currentVersion, 3);
  assert.equal(store.getVersion(marc.id, page.id, 3).body, 'good');
  assert.equal(store.getVersion(marc.id, page.id, 2).body, 'worse'); // still there
});
