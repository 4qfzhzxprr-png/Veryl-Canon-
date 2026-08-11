import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCollectionAttestationHtml } from '../src/attestation.js';
import { concentrationOfDuty, marksStandingIn } from '../src/concentration.js';
import { openDb } from '../src/db.js';
import { GroupMapping, applyGroupMapping, parseGroupRules } from '../src/groupmap.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { setHandGrant, setHandOrgRole } from '../src/orgrole.js';
import { CanonStore } from '../src/store.js';

// Concentration of duty (concentration.ts), after the auditor's re-review:
// "a concentration-of-duty view distinguishing an authorised approval
// concentration from an accidental one — the register now exposes the fact,
// but not its legitimacy."
//
// What the tests below are actually protecting, in the order the finding puts
// them:
//
//   * the GRANTER is read from the `page.approve` event and not from
//     `pages.approver_id`, which is null on a Plan;
//   * the DENOMINATOR is the collection's own roster, so "two of two" and
//     "two of nine" are visibly different answers;
//   * the ORIGIN of each approver's role distinguishes a hand grant from a
//     directory group mapping;
//   * the SELF-APPROVAL check is run over the record, and finds the one case
//     Canon's own submit-time refusal does not cover;
//   * and none of it is visible to somebody with no role in the collection,
//     because the permission filtering is in the SELECT.
//
// And one negative test that is the point of the whole file: there is no score
// anywhere in the output.

const quiet: NotificationTransport = { deliver() {} };
const TODAY = new Date().toISOString().slice(0, 10);

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana Whitfield', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc Oyelaran', email: 'marc@example.com' });
  const nadia = store.createActor({ kind: 'person', name: 'Nadia Haddad', email: 'nadia@example.com' });
  const helena = store.createActor({ kind: 'person', name: 'Helena Brandt', email: 'helena@example.com' });
  const priya = store.createActor({ kind: 'person', name: 'Priya Raman', email: 'priya@example.com' });
  const outsider = store.createActor({ kind: 'person', name: 'Sam Okafor', email: 'sam@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Clinical Policy' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, nadia.id, 'approve');
  store.setMember(dana.id, collection.id, helena.id, 'approve');
  store.setMember(dana.id, collection.id, priya.id, 'view');
  return { db, store, dana, marc, nadia, helena, priya, outsider, collection };
}

function policy(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  type: 'policy' | 'spec' | 'plan' = 'policy',
) {
  const page = store.createPage(editorId, { collectionId, type, title });
  store.editDraft(editorId, page.id, {
    body: `${title} body.`,
    fields: {
      ownerId: editorId,
      ...(type === 'plan' ? {} : { approverId }),
      reviewDate: '2030-01-01',
      ...(type === 'policy' ? { effectiveDate: TODAY } : {}),
    },
  });
  store.submitForReview(editorId, page.id);
  store.approve(approverId, page.id);
  return page;
}

// ---------------------------------------------------------------------------
// The count itself

test('concentration: who granted, how many each, and out of how many could have', () => {
  const { store, dana, marc, nadia, helena, collection } = setup();
  for (const n of [1, 2, 3]) policy(store, marc.id, nadia.id, collection.id, `Nadia policy ${n}`);
  policy(store, marc.id, helena.id, collection.id, 'Helena policy');

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;

  assert.equal(c.marks, 4);
  assert.equal(c.granters.length, 2, 'two people granted marks');
  assert.equal(c.granters[0]!.name, 'Nadia Haddad', 'ordered by marks granted, most first');
  assert.equal(c.granters[0]!.marks, 3);
  assert.equal(c.granters[1]!.marks, 1);
  // Dana holds `admin`, which outranks `approve`, so she is in the denominator
  // and in the dormant list: the difference between "two of two" and "two of
  // three" is the whole finding.
  assert.equal(c.eligible, 3, 'admin outranks approve and is a person who could have granted these');
  assert.deepEqual(
    c.dormant.map((d) => d.name),
    ['Dana Whitfield'],
  );
  assert.match(c.headline, /4 Canonical mark\(s\).*granted by 2 people/);
  assert.match(c.headline, /3 person\(s\) hold a role permitting approval here, so 1 of them granted none/);
});

test('concentration: one approver out of one is a different sentence from one out of many', () => {
  const { db, store, dana, marc, nadia, helena, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Only policy');

  // As the collection stands, Nadia is one of three who could have.
  const wide = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.match(wide.headline, /ONE person, Nadia Haddad/);
  assert.match(wide.headline, /3 person\(s\) hold a role permitting approval here, so 2 of them granted none/);

  // Narrow the roster to Nadia alone and the same single grant reads
  // differently: nobody else could have done it.
  store.removeMember(dana.id, collection.id, helena.id);
  setHandOrgRole(db, dana.id, 'operator', null);
  // Nadia takes the admin role before Dana steps down from it: a collection
  // cannot be left with no administrator, and Nadia already holds approve, so
  // the eligible roster this test is about is unchanged by the handover.
  store.setMember(dana.id, collection.id, nadia.id, 'admin');
  store.setMember(dana.id, collection.id, dana.id, 'edit');
  const narrow = store.collectionHealth(nadia.id, collection.id).approvalConcentration;
  assert.equal(narrow.eligible, 1);
  assert.match(narrow.headline, /the work was spread across everybody who could have done it/);
  assert.equal(narrow.dormant.length, 0);
});

test('concentration: the granter is read from the approval, not from the approver column', () => {
  const { store, dana, marc, nadia, collection } = setup();
  // A Plan names no approver — `pages.approver_id` is null — and any holder of
  // `approve` may accept it. Reading the column would report this mark as
  // granted by nobody.
  const plan = policy(store, marc.id, nadia.id, collection.id, 'Migration plan', 'plan');
  const page = store.getPage(dana.id, plan.id);
  assert.equal(page.approverId, null, 'a Plan names nobody, which is why the column cannot answer this');

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.equal(c.marks, 1);
  assert.equal(c.granters.length, 1);
  assert.equal(c.granters[0]!.name, 'Nadia Haddad');

  // And the register prints it in its own column beside the empty one.
  const bundle = store.collectionAttestation(dana.id, collection.id);
  const entry = bundle.register.find((r) => r.pageId === plan.id)!;
  assert.equal(entry.approverName, null, 'nobody was named to approve a Plan');
  assert.equal(entry.grantedByName, 'Nadia Haddad', 'but somebody plainly granted the mark');
});

// ---------------------------------------------------------------------------
// Where the authority came from

test('concentration: a hand grant and a group mapping are two different sentences', () => {
  const { db, store, dana, marc, nadia, helena, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');
  policy(store, marc.id, helena.id, collection.id, 'Helena policy');
  setHandOrgRole(db, dana.id, 'operator', null); // so group names are not withheld

  const handed = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.deepEqual(
    handed.granters.map((g) => g.origin),
    ['hand', 'hand'],
  );
  assert.ok(
    handed.notes.some((n) => /given the role BY HAND, in Canon, by an administrator/.test(n)),
    'a hand-granted concentration says so',
  );

  // Now let a directory group carry both of them instead. `applyGroupMapping`
  // writes the group grants and recomputes `collection_members`; the hand
  // grants are withdrawn so the group is the only thing holding them up.
  const mapping: GroupMapping = {
    rules: parseGroupRules(`Clinical-Approvers -> collection:${collection.id}:approve`),
    claim: 'groups',
  };
  for (const person of [nadia, helena]) {
    applyGroupMapping(db, person.id, ['Clinical-Approvers'], mapping);
    db.prepare('DELETE FROM collection_hand_grants WHERE collection_id = ? AND actor_id = ?').run(
      collection.id,
      person.id,
    );
  }
  // Recompute through the same path a withdrawal takes.
  applyGroupMapping(db, nadia.id, ['Clinical-Approvers'], mapping);
  applyGroupMapping(db, helena.id, ['Clinical-Approvers'], mapping);

  const mapped = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.deepEqual(
    mapped.granters.map((g) => g.origin),
    ['group', 'group'],
  );
  assert.ok(
    mapped.notes.some((n) => /This concentration follows from that mapping/.test(n)),
    'a mapped concentration says where it comes from',
  );
  assert.deepEqual(mapped.granters[0]!.groups, [{ group: 'Clinical-Approvers', role: 'approve' }]);
  assert.equal(mapped.groupsWithheld, false, 'an operator may already ask for anybody’s groups');
});

test('concentration: a group NAME is withheld from a reader who could not ask for it, and says it was', () => {
  const { db, store, dana, marc, nadia, priya, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');
  const mapping: GroupMapping = {
    rules: parseGroupRules(`Clinical-Approvers -> collection:${collection.id}:approve`),
    claim: 'groups',
  };
  applyGroupMapping(db, nadia.id, ['Clinical-Approvers'], mapping);
  // Withdraw the hand grant underneath it, so the group is the only thing
  // holding her role up and the origin is unambiguously `group`.
  setHandGrant(db, collection.id, nadia.id, null);

  // Priya holds `view` and no org role. She sees that the role is mapped —
  // which is the fact the finding asked for — and not what the group is called.
  const seen = store.collectionHealth(priya.id, collection.id).approvalConcentration;
  assert.equal(seen.granters[0]!.origin, 'group');
  assert.deepEqual(seen.granters[0]!.groups, [], 'the name is not hers to see');
  assert.equal(seen.groupsWithheld, true);
  assert.ok(
    seen.notes.some((n) => /whose NAME is not shown to you/.test(n)),
    'a withheld fact that does not say it was withheld is the failure this product is against',
  );

  // Dana, an operator, may already call explainAccess on anybody.
  setHandOrgRole(db, dana.id, 'operator', null);
  const full = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.deepEqual(full.granters[0]!.groups, [{ group: 'Clinical-Approvers', role: 'approve' }]);
  assert.equal(full.groupsWithheld, false);
});

test('concentration: an approver who also administers the collection is named as one', () => {
  const { store, dana, marc, collection } = setup();
  // Dana administers, so she may grant the approve role — including to herself.
  policy(store, marc.id, dana.id, collection.id, 'Dana-approved policy');
  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  const her = c.granters.find((g) => g.name === 'Dana Whitfield')!;
  assert.equal(her.collectionAdmin, true);
  assert.ok(
    c.notes.some((n) => /also administer this collection/.test(n)),
    'their authority to approve is not independent of them, and the report says so',
  );
});

test('concentration: somebody who granted a mark and has since left the collection is named, not dropped', () => {
  const { store, dana, marc, nadia, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');
  store.removeMember(dana.id, collection.id, nadia.id);

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.equal(c.granters.length, 1);
  assert.equal(c.granters[0]!.mayApproveNow, false);
  assert.equal(c.granters[0]!.role, null);
  assert.equal(c.granters[0]!.origin, 'not_held_now');
  assert.equal(c.grantersWithoutTheRoleNow, 1);
  assert.ok(c.notes.some((n) => /hold NO role in this collection today/.test(n)));
  assert.ok(
    c.limits.some((l) => /The roster is TODAY’S/.test(l)),
    'the denominator describes today and the approvals describe history; that is stated',
  );
});

// ---------------------------------------------------------------------------
// Separation of duty, checked over the record rather than assumed from the code

test('concentration: the submit-time refusal is real, and the report shows the check was made', () => {
  const { store, dana, marc, nadia, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');

  // The rule this is the read-side mirror of.
  const page = store.createPage(nadia.id, { collectionId: collection.id, type: 'policy', title: 'Her own policy' });
  store.editDraft(nadia.id, page.id, {
    body: 'Body.',
    fields: { ownerId: nadia.id, approverId: nadia.id, reviewDate: '2030-01-01', effectiveDate: TODAY },
  });
  expectCode(() => store.submitForReview(nadia.id, page.id), 'workflow');

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.equal(c.selfApproved.length, 0);
  assert.equal(c.separationChecked, 1);
  assert.equal(c.separationUnknown, 0);
  assert.ok(
    c.notes.some((n) => /on 1 of the 1 mark\(s\): none was approved by the person who put it forward/.test(n)),
    '"we found none" and "we did not look" must not read identically',
  );
});

// The gap this report FOUND, and the rule that closed it.
//
// `submitForReview` refuses "the approver cannot submit their own draft" only
// where the TYPE names an approver. A Plan names none, so somebody holding
// `approve` could submit their own Plan and then grant it the Canonical mark.
// The report turned it up while measuring, with `refusedAtSubmission: false`.
//
// It is closed at APPROVE, because the rule is about who grants the mark: at
// submission it would still be avoidable by submitting under one identity and
// approving under another, and it would wrongly refuse the ordinary case of
// tidying up a colleague's draft and putting it forward for somebody else.
test('separation: the person who submitted a page cannot grant it the Canonical mark', () => {
  const { store, nadia, collection } = setup();
  // Nadia holds `approve`, which outranks `edit`, so she can write a Plan.
  const page = store.createPage(nadia.id, { collectionId: collection.id, type: 'plan', title: 'Her own plan' });
  store.editDraft(nadia.id, page.id, { body: 'Body.', fields: { ownerId: nadia.id, reviewDate: '2030-01-01' } });
  store.submitForReview(nadia.id, page.id);
  assert.throws(() => store.approve(nadia.id, page.id), /cannot grant it the Canonical mark/);
});

test('separation: the rule holds for a type that DOES name an approver, at both ends', () => {
  const { store, marc, nadia, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'plan', title: 'A plan somebody else put forward' });
  store.editDraft(marc.id, page.id, { body: 'Body.', fields: { ownerId: marc.id, reviewDate: '2030-01-01' } });
  store.submitForReview(marc.id, page.id);
  // Marc submitted, so Nadia may still approve: the rule refuses the submitter,
  // not everybody. This is the case that must keep working.
  const approved = store.approve(nadia.id, page.id);
  assert.equal(approved.status, 'canonical');
});

test('concentration: a self-approval already in the record is still reported', () => {
  const { db, store, dana, nadia, collection } = setup();
  // A record written before the rule existed. Written directly, because the
  // product will no longer produce one — and the report must still find it,
  // since a partner's record may hold marks granted under the old behaviour.
  const page = store.createPage(nadia.id, { collectionId: collection.id, type: 'plan', title: 'Her own plan' });
  store.editDraft(nadia.id, page.id, { body: 'Body.', fields: { ownerId: nadia.id, reviewDate: '2030-01-01' } });
  store.submitForReview(nadia.id, page.id);
  const other = store.createActor({ kind: 'person', name: 'Stand-in' });
  store.setMember(dana.id, collection.id, other.id, 'approve');
  store.approve(other.id, page.id);
  // Reattribute the approval to the submitter, as the old behaviour would have
  // recorded it.
  db.exec('DROP TRIGGER IF EXISTS audit_events_append_only_update');
  db.prepare("UPDATE audit_events SET actor_id = ? WHERE action = 'page.approve' AND page_id = ?").run(nadia.id, page.id);

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.equal(c.selfApproved.length, 1);
  assert.equal(c.selfApproved[0]!.title, 'Her own plan');
  assert.equal(c.selfApproved[0]!.approverName, 'Nadia Haddad');
});

// ---------------------------------------------------------------------------
// Permission, in the SELECT

test('concentration: somebody with no role in the collection is refused before any of this is computed', () => {
  const { store, marc, nadia, outsider, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');
  expectCode(() => store.collectionHealth(outsider.id, collection.id), 'forbidden');
  // collectionAttestation now masks existence for a stranger (abilities.ts P1):
  // an outsider with no role is told the collection does not exist rather than
  // handed a 403 naming it. The refusal-before-compute intent still holds — the
  // register is never assembled for a non-member — the vocabulary is just the
  // existence-masking not_found now. (collectionHealth stays the informative
  // 403: it is a concentration read, outside the masked read surface.)
  expectCode(() => store.collectionAttestation(outsider.id, collection.id), 'not_found');
});

test('concentration: the reads are empty for a non-member even with the role check removed', () => {
  // The rule at the head of queries.ts is that the filtering is in the SELECT,
  // never after it — so the queries must answer nothing for a non-member on
  // their own, without the `requireRole` above them. Called directly, past the
  // guard, exactly as a future caller might.
  const { db, store, marc, nadia, outsider, collection } = setup();
  policy(store, marc.id, nadia.id, collection.id, 'Nadia policy');

  const pages = marksStandingIn(db, outsider.id, collection.id, 100);
  assert.deepEqual(pages, [], 'a non-member selects no marked pages');

  // And handed the population anyway — the worst case, where a caller has
  // already leaked it — the roster and the approvals are still empty.
  const member = marksStandingIn(db, marc.id, collection.id, 100);
  assert.equal(member.length, 1);
  const c = concentrationOfDuty({
    db,
    actorId: outsider.id,
    collectionId: collection.id,
    at: TODAY,
    pages: member,
    population: 'handed in past the guard',
    namesGroups: false,
  });
  assert.equal(c.eligible, 0, 'a non-member reads no roster');
  assert.equal(c.granters.length, 0, 'a non-member reads no approvals');
  assert.equal(c.marksWithoutApprovalEvent, 1, 'and the page it could not attribute is named, not silently dropped');
});

// ---------------------------------------------------------------------------
// The register carries it as evidence

test('concentration: the register attestation carries the view, inside the content digest', () => {
  const { store, dana, marc, nadia, helena, collection } = setup();
  for (const n of [1, 2, 3]) policy(store, marc.id, nadia.id, collection.id, `Nadia policy ${n}`);
  policy(store, marc.id, helena.id, collection.id, 'Helena policy');

  const bundle = store.collectionAttestation(dana.id, collection.id);
  assert.equal(bundle.concentration.marks, 4);
  assert.equal(bundle.concentration.granters.length, 2);
  assert.equal(bundle.concentration.eligible, 3);
  assert.ok(
    bundle.manifest.asserts.some((a) => /out of the 3 who hold a role permitting approval/.test(a)),
    'the manifest asserts the ratio it printed',
  );
  assert.ok(
    bundle.manifest.asserts.some((a) => /Canon does NOT score the concentration/.test(a)),
    'and asserts what it refused to compute',
  );
  // Everybody the section names is in the bundle's people table, so a reader
  // can check them against their own directory the way T3.1 requires.
  const named = new Set(bundle.actors.map((a) => a.id));
  for (const person of [...bundle.concentration.granters, ...bundle.concentration.dormant]) {
    assert.ok(named.has(person.actorId), `${person.name} is named in the section and in the people table`);
  }

  const html = renderCollectionAttestationHtml(bundle);
  assert.match(html, /Concentration of duty/);
  assert.match(html, /Nadia Haddad/);
  assert.match(html, /Granted by/, 'the register grew a column for who actually granted the mark');
  // Self-contained, as the whole file must stay: no reference of any kind out.
  assert.doesNotMatch(html, /<script|<img|<link|https?:\/\//i);
});

test('concentration: no score anywhere — not in the JSON, not on the page', () => {
  const { store, dana, marc, nadia, collection } = setup();
  for (const n of [1, 2, 3]) policy(store, marc.id, nadia.id, collection.id, `Nadia policy ${n}`);

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  // Every number in the report is a count of things somebody can list. A
  // fraction, a percentage or a 0-to-1 index would be a judgement wearing a
  // number's clothes, and concentration.ts refuses to make one. Walked over the
  // parsed value rather than over the JSON text, so a timestamp's milliseconds
  // are not mistaken for a score.
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'number') {
      assert.ok(Number.isInteger(value), `every number in the report is a count; ${path} is ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  walk(c, 'approvalConcentration');
  const words = JSON.stringify(c).toLowerCase();
  for (const banned of ['"score"', '"risk"', '"rating"', '"severity"', 'concentrationscore']) {
    assert.ok(!words.includes(banned), `the report must not carry a ${banned}`);
  }

  const html = renderCollectionAttestationHtml(store.collectionAttestation(dana.id, collection.id));
  assert.doesNotMatch(html, /risk score|concentration score|0\.\d\d\b/i);
});

test('concentration: a collection with nothing Canonical says so rather than dividing by zero', () => {
  const { store, dana, marc, collection } = setup();
  const draft = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Never published' });
  store.editDraft(marc.id, draft.id, { body: 'Body.', fields: { ownerId: marc.id, reviewDate: '2030-01-01' } });

  const c = store.collectionHealth(dana.id, collection.id).approvalConcentration;
  assert.equal(c.marks, 0);
  assert.equal(c.granters.length, 0);
  assert.equal(c.eligible, 3);
  assert.match(c.headline, /No page in this population holds a Canonical mark Canon can attribute/);
  assert.equal(c.dormant.length, 3, 'three people may approve here and none has');
});
