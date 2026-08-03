import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

// The review workflow as the people in USER-TESTING.md §T4 meet it: what an
// approver is shown before deciding (T4.2), where a send-back reason lands
// (T4.3), and whether an action on offer is an action the server will accept
// (T4.4).
//
// A Policy states an effective date before it can publish (T1.5); these
// fixtures are written and published in the same breath, so today's date is the
// honest one and needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-01-31`;

const quiet: NotificationTransport = { deliver() {} };

function setup() {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana Okafor', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc Ellis', email: 'marc@example.com' });
  const nadia = store.createActor({ kind: 'person', name: 'Nadia Haddad', email: 'nadia@example.com' });
  const grace = store.createActor({ kind: 'person', name: 'Grace Abara', email: 'grace@example.com' });
  const rosa = store.createActor({ kind: 'person', name: 'Rosa Vidal', email: 'rosa@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera Lund', email: 'vera@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: false });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, nadia.id, 'approve');
  store.setMember(dana.id, collection.id, grace.id, 'approve');
  store.setMember(dana.id, collection.id, rosa.id, 'comment');
  store.setMember(dana.id, collection.id, vera.id, 'view');
  return { store, dana, marc, nadia, grace, rosa, vera, collection };
}

/** A Policy drafted by Marc, complete enough to submit, awaiting Nadia. */
function policyInReview(fx: ReturnType<typeof setup>) {
  const { store, marc, nadia, collection } = fx;
  const page = store.createPage(marc.id, {
    collectionId: collection.id,
    type: 'policy',
    title: 'Complaint handling',
  });
  store.editDraft(marc.id, page.id, {
    body: 'A complaint is acknowledged within five working days.',
    fields: {
      ownerId: marc.id,
      approverId: nadia.id,
      effectiveDate: TODAY,
      reviewDate: NEXT_YEAR,
    },
  });
  store.submitForReview(marc.id, page.id);
  return page;
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

// ---------------------------------------------------------------------------
// T4.3 — the send-back reason lands on the page

test('send-back: the reason becomes a comment on the page, by the approver', () => {
  const fx = setup();
  const { store, marc, nadia } = fx;
  const page = policyInReview(fx);

  store.sendBack(nadia.id, page.id, { comment: 'Name the escalation path for a complaint held over 20 days.' });

  const comments = store.listComments(marc.id, page.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.authorId, nadia.id);
  assert.match(comments[0]!.body, /escalation path/);
  // Marked as what it is, so a panel does not show the most consequential
  // sentence on the page as an ordinary remark.
  assert.equal(comments[0]!.sentBack, true);

  // The log and the panel are demonstrably the same refusal.
  const [event] = store.queryAudit(nadia.id, { pageId: page.id, action: 'page.send_back' });
  assert.equal(event!.details.commentId, comments[0]!.id);
  assert.match(String(event!.details.comment), /escalation path/);
});

test('send-back: an ordinary comment is not marked as one', () => {
  const fx = setup();
  const { store, marc, rosa } = fx;
  const page = policyInReview(fx);
  store.sendBack(fx.nadia.id, page.id, { comment: 'Name the escalation path.' });
  store.createComment(rosa.id, page.id, { body: 'Agreed, and the 20-day figure is from the 2024 handbook.' });

  const comments = store.listComments(marc.id, page.id);
  assert.deepEqual(
    comments.map((c) => c.sentBack),
    [true, false],
  );
});

test('sentBack: the notice stands until the author does something about it', () => {
  const fx = setup();
  const { store, marc, nadia, vera } = fx;
  const page = policyInReview(fx);
  assert.equal(store.sentBack(marc.id, page.id), null, 'nothing has been sent back yet');

  store.sendBack(nadia.id, page.id, { comment: 'Name the escalation path.' });
  const notice = store.sentBack(marc.id, page.id);
  assert.ok(notice);
  assert.equal(notice.byId, nadia.id);
  assert.match(notice.reason, /escalation path/);
  assert.equal(notice.commentId, store.listComments(marc.id, page.id)[0]!.id);
  assert.ok(notice.at);

  // Readable by anyone who can read the page: why a page is a Draft rather
  // than Canonical is a fact about the page, not a private message.
  assert.ok(store.sentBack(vera.id, page.id));

  // Resubmitting is the later act, so the send-back stops being the answer.
  store.editDraft(marc.id, page.id, { body: 'Escalation: the Head of Complaints, at 20 days.' });
  store.submitForReview(marc.id, page.id);
  assert.equal(store.sentBack(marc.id, page.id), null);
  // ...and withdrawing does not bring it back, because it is a later act too.
  store.withdrawFromReview(marc.id, page.id, {});
  assert.equal(store.sentBack(marc.id, page.id), null);
});

test('sentBack: the comment stays marked once the page has moved on', () => {
  const fx = setup();
  const { store, marc, nadia } = fx;
  const page = policyInReview(fx);
  store.sendBack(nadia.id, page.id, { comment: 'Name the escalation path.' });
  store.editDraft(marc.id, page.id, { body: 'Escalation: the Head of Complaints.' });
  store.submitForReview(marc.id, page.id);

  assert.equal(store.sentBack(marc.id, page.id), null, 'the banner has gone');
  assert.equal(store.listComments(marc.id, page.id)[0]!.sentBack, true, 'the comment is still a refusal');
});

test('send-back: a reason that cannot be recorded is not a send-back', () => {
  const fx = setup();
  const { store, nadia } = fx;
  const page = policyInReview(fx);
  expectCode(() => store.sendBack(nadia.id, page.id, { comment: '   ' }), 'invalid');
  assert.equal(store.getPage(nadia.id, page.id).status, 'in_review', 'the page did not move');
  assert.equal(store.listComments(nadia.id, page.id).length, 0);
});

// ---------------------------------------------------------------------------
// Third round, finding 1 — the review baseline is the last version to hold
// the Canonical mark, read from the approval events, and never merely the
// last version to publish.

test('lastCanonicalVersion: publishing after the mark does not move the review baseline', () => {
  const fx = setup();
  const { store, marc, nadia } = fx;
  const page = policyInReview(fx);
  assert.equal(store.lastCanonicalVersion(marc.id, page.id), null, 'no version has held the mark yet');
  store.approve(nadia.id, page.id, {}); // v1, Canonical

  // Lena's case, step for step: an edit adds vocabulary, publishing makes it
  // the current version with no approver's name on the move, and the page is
  // re-drafted and submitted. The current version now already CONTAINS the
  // alias — so a diff against it shows nothing, and the baseline the review
  // surface needs is v1, where the mark last stood.
  store.editDraft(marc.id, page.id, { fields: { aliases: ['COB'] } });
  store.publish(marc.id, page.id); // v2, and the page drops to Draft
  store.editDraft(marc.id, page.id, { body: 'A complaint is acknowledged within five working days, or escalated.' });
  store.submitForReview(marc.id, page.id);

  const baseline = store.lastCanonicalVersion(marc.id, page.id);
  assert.ok(baseline);
  assert.equal(baseline.number, 1, 'the baseline is the marked v1, not the published v2');
  assert.deepEqual(baseline.fields.aliases ?? [], [], 'so the alias change is IN the diff, not under it');
  assert.deepEqual(store.getDraft(marc.id, page.id)!.fields.aliases, ['COB']);

  // Approval moves it: the mark now covers what was just accepted.
  store.approve(nadia.id, page.id, {});
  assert.equal(store.lastCanonicalVersion(marc.id, page.id)!.number, 3);
});

test('lastCanonicalVersion: reading it needs `view`, like the history it is one row of', () => {
  const fx = setup();
  const { store } = fx;
  const page = policyInReview(fx);
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.lastCanonicalVersion(outsider.id, page.id), 'forbidden');
});

// ---------------------------------------------------------------------------
// T4.4 — nothing is offered that the server will refuse

test('abilities: the named approver, and nobody else', () => {
  const fx = setup();
  const { store, marc, nadia, grace, rosa } = fx;
  const page = policyInReview(fx);

  const hers = store.pageAbilities(nadia.id, page.id);
  assert.equal(hers.approve.can, true);
  assert.equal(hers.approve.why, null);
  assert.equal(hers.sendBack.can, true);

  // Grace holds `approve` on the collection and is not the named approver.
  const his = store.pageAbilities(grace.id, page.id);
  assert.equal(his.approve.can, false);
  assert.equal(his.approve.why, 'Only Nadia Haddad, the named approver on this draft, can approve it.');
  // Send back is a different act with a different rule, and she may do it.
  assert.equal(his.sendBack.can, true);

  const theirs = store.pageAbilities(rosa.id, page.id);
  assert.equal(theirs.approve.can, false);
  assert.match(theirs.approve.why!, /needs the approve role/);
  assert.match(theirs.approve.why!, /Dana Okafor, Grace Abara and Nadia Haddad hold it/);
});

test('abilities: the withdraw answer is the author’s, and says who else it is not', () => {
  const fx = setup();
  const { store, marc, nadia } = fx;
  const page = policyInReview(fx);
  assert.equal(store.pageAbilities(marc.id, page.id).withdraw.can, true);
  const nadias = store.pageAbilities(nadia.id, page.id).withdraw;
  assert.equal(nadias.can, false);
  assert.match(nadias.why!, /Only Marc Ellis, who submitted this page for review, can withdraw it/);
});

test('abilities: submitting speaks in validateReadyToPublish’s own words', () => {
  const fx = setup();
  const { store, marc, nadia, collection } = fx;
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, page.id, { body: 'Claims are kept for six years.' });

  const before = store.pageAbilities(marc.id, page.id).submit;
  assert.equal(before.can, false);
  // The sentence is the server's, not a paraphrase: the same one submitting
  // would have been refused with.
  const refusal = expectCode(() => store.submitForReview(marc.id, page.id), 'workflow');
  assert.equal(before.why, (refusal as CanonError).message);

  store.editDraft(marc.id, page.id, {
    fields: { ownerId: marc.id, approverId: nadia.id, effectiveDate: TODAY, reviewDate: NEXT_YEAR },
  });
  assert.equal(store.pageAbilities(marc.id, page.id).submit.can, true);
});

test('abilities: an approver is not offered a submit they would be refused', () => {
  const fx = setup();
  const { store, marc, nadia, collection } = fx;
  const page = store.createPage(nadia.id, { collectionId: collection.id, type: 'policy', title: 'Conflicts' });
  store.editDraft(nadia.id, page.id, {
    body: 'Her own draft.',
    fields: { ownerId: marc.id, approverId: nadia.id, effectiveDate: TODAY, reviewDate: NEXT_YEAR },
  });
  const submit = store.pageAbilities(nadia.id, page.id).submit;
  assert.equal(submit.can, false);
  assert.match(submit.why!, /an approver cannot submit their own draft/);
  expectCode(() => store.submitForReview(nadia.id, page.id), 'workflow');
});

test('abilities: the submitter is not offered an approve the server would refuse', () => {
  const fx = setup();
  const { store, marc, nadia, grace, collection } = fx;
  // A Plan names no approver, so any approve-holder may accept it — except the
  // one who submitted it. `approve` has always enforced that from the audit
  // log; this pins the mirror to the gate, because the gap between them was a
  // live green button that silently no-oped for the person it refused
  // (USER-TESTING.md, third round, finding 9).
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'Migration plan' });
  store.editDraft(grace.id, page.id, { body: 'Cut over on the first Saturday.', fields: { ownerId: marc.id } });
  store.submitForReview(grace.id, page.id);

  const hers = store.pageAbilities(grace.id, page.id).approve;
  assert.equal(hers.can, false);
  // The mirror speaks in the gate's own sentence, so the greyed button and the
  // refusal it predicts can never drift apart.
  const refusal = expectCode(() => store.approve(grace.id, page.id, {}), 'forbidden');
  assert.equal(hers.why, `${(refusal as CanonError).message}.`);

  // Anybody else holding approve is still offered it, and the server agrees.
  assert.equal(store.pageAbilities(nadia.id, page.id).approve.can, true);
  store.approve(nadia.id, page.id, {});
  assert.equal(store.getPage(nadia.id, page.id).status, 'canonical');
});

test('abilities: a page lock is a sentence with a name in it', () => {
  const fx = setup();
  const { store, dana, marc } = fx;
  const page = store.createPage(marc.id, {
    collectionId: fx.collection.id,
    type: 'note',
    title: 'Working notes',
  });
  store.editDraft(marc.id, page.id, { body: 'Mine.' });
  const danas = store.pageAbilities(dana.id, page.id).edit;
  assert.equal(danas.can, false);
  assert.match(danas.why!, /Marc Ellis is editing this page/);
  // A Note never goes to review, and says so rather than offering the button.
  assert.match(store.pageAbilities(marc.id, page.id).submit.why!, /never goes to review/);
});

test('abilities: reading them needs `view`, like the page itself', () => {
  const fx = setup();
  const { store } = fx;
  const page = policyInReview(fx);
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.pageAbilities(outsider.id, page.id), 'forbidden');
  expectCode(() => store.sentBack(outsider.id, page.id), 'forbidden');
});

// The property the whole projection lives or dies on. It is allowed to be
// pessimistic; it is never allowed to be optimistic. So: take every actor, on
// pages in every interesting state, and check that each act reported `can:
// false` really is refused — a green button the server rejects is the defect
// T4.4 names, and this is the test that would catch it coming back.
test('abilities: nothing reported as refused is actually accepted', () => {
  const fx = setup();
  const { store, dana, marc, nadia, grace, rosa, vera, collection } = fx;
  const inReview = policyInReview(fx);

  const draft = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, draft.id, { body: 'Six years.' });

  const note = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.editDraft(marc.id, note.id, { body: 'Scratch.' });
  store.publish(marc.id, note.id);
  store.archivePage(marc.id, note.id);

  const acts: Record<string, (actorId: string, pageId: string) => unknown> = {
    edit: (a, p) => store.editDraft(a, p, { body: 'edited' }),
    comment: (a, p) => store.createComment(a, p, { body: 'a comment' }),
    submit: (a, p) => store.submitForReview(a, p),
    approve: (a, p) => store.approve(a, p, {}),
    sendBack: (a, p) => store.sendBack(a, p, { comment: 'no' }),
    withdraw: (a, p) => store.withdrawFromReview(a, p, {}),
    archive: (a, p) => store.archivePage(a, p),
  };

  for (const pageId of [inReview.id, draft.id, note.id]) {
    for (const actor of [dana, marc, nadia, grace, rosa, vera]) {
      const abilities = store.pageAbilities(actor.id, pageId) as unknown as Record<
        string,
        { can: boolean; why: string | null }
      >;
      for (const [name, act] of Object.entries(acts)) {
        const ability = abilities[name]!;
        if (ability.can) continue;
        assert.ok(ability.why, `${name} was refused with no sentence`);
        let threw = false;
        try {
          act(actor.id, pageId);
        } catch (err) {
          threw = err instanceof CanonError;
        }
        assert.ok(threw, `${actor.name} was told they cannot ${name}, and the server accepted it`);
      }
    }
  }
});
