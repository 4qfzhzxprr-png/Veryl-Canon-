// Agent proposals (FEATURES.md §5, the Next tier): the propose-and-review
// loop that lets an agent offer a change to material it may not publish, and
// a person turn that offer into the record.
//
// The invariants these tests exist to hold:
//   * a proposal is not a draft and never takes the page lock;
//   * a proposal without a rationale is not a proposal;
//   * accepting is a person's act, and produces a version authored by the
//     proposer with the accepting person recorded;
//   * a type's rules survive acceptance — Canonical still only through review;
//   * a proposal written against a base version the page has left is refused
//     and superseded, never silently applied over the newer record.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { Notification, NotificationTransport } from '../src/notify.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

const quiet: NotificationTransport = { deliver() {} };

function setup(transport: NotificationTransport = quiet) {
  const store = new CanonStore(openDb(':memory:'), transport);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const rosa = store.createActor({ kind: 'person', name: 'Rosa', email: 'rosa@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const bot = store.createActor({ kind: 'agent', name: 'Freshness Agent', registryRef: 'passport:fresh-1' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  store.setMember(dana.id, collection.id, rosa.id, 'comment');
  store.setMember(dana.id, collection.id, vera.id, 'view');
  // Canon's half of the intersection for the agent: it may edit, which is
  // what proposing takes. It still cannot accept anything.
  store.setMember(dana.id, collection.id, bot.id, 'edit');
  return { store, dana, marc, iris, rosa, vera, bot, collection };
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

function ofKind(store: CanonStore, actorId: string, kind: Notification['kind']): Notification[] {
  return store.listNotifications(actorId).filter((n) => n.kind === kind);
}

// A published Note owned by Marc: the ordinary page an agent watches.
function publishedNote(store: CanonStore, editorId: string, collectionId: string, title = 'Q2 figures') {
  const page = store.createPage(editorId, { collectionId, type: 'note', title });
  store.editDraft(editorId, page.id, { body: 'Revenue was $4.1M in Q2.', fields: { ownerId: editorId } });
  return store.publish(editorId, page.id);
}

test('proposals: an agent proposes, a person accepts, and the version is the agent’s work', () => {
  const { store, marc, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);

  const proposal = store.createProposal(bot.id, page.id, {
    rationale: 'The source figure changed: the finance system now reports $4.4M for Q2.',
    body: 'Revenue was $4.4M in Q2.',
  });
  assert.equal(proposal.authorId, bot.id);
  assert.equal(proposal.authorKind, 'agent'); // visibly agent work
  assert.equal(proposal.status, 'open');
  assert.equal(proposal.baseVersion, 1);
  assert.equal(proposal.stale, false);
  assert.match(proposal.rationale, /source figure changed/);
  // Nothing has changed about what the page says.
  assert.equal(store.getPage(marc.id, page.id).currentVersion, 1);
  assert.equal(store.getVersion(marc.id, page.id, 1).body, 'Revenue was $4.1M in Q2.');

  const decision = store.acceptProposal(marc.id, proposal.id, {});
  assert.equal(decision.page.currentVersion, 2);
  assert.equal(decision.proposal.status, 'accepted');
  assert.equal(decision.proposal.decidedBy, marc.id); // the accepting person is recorded
  assert.equal(decision.proposal.version, 2);
  assert.ok(decision.proposal.decidedAt);

  // Attribution: the agent authored the version; the person published it.
  const v2 = store.getVersion(marc.id, page.id, 2);
  assert.equal(v2.body, 'Revenue was $4.4M in Q2.');
  assert.equal(v2.authorId, bot.id, 'an accepted proposal is authored by the proposer');
  assert.match(v2.note!, /accepted by Marc/);

  // Unstated parts of the page carry over from the version it was based on.
  assert.equal(v2.title, 'Q2 figures');
  assert.equal(v2.fields.ownerId, marc.id);

  // The publish event names the acting person and the differing author.
  const publishes = store.queryAudit(marc.id, { action: 'page.publish' });
  const accepted = publishes.find((e) => e.details.version === 2)!;
  assert.equal(accepted.actorId, marc.id);
  assert.equal(accepted.actorKind, 'person');
  assert.equal(accepted.details.authorId, bot.id);

  // And the accepted content is what search and the record now hold.
  assert.equal(store.getPage(marc.id, page.id).currentVersion, 2);
});

test('proposals: a proposal never takes the page lock, in either order', () => {
  const { store, marc, dana, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);

  // A person is mid-edit; the agent proposes anyway, and the draft is untouched.
  store.editDraft(marc.id, page.id, { body: 'Marc is rewriting this paragraph.' });
  const proposal = store.createProposal(bot.id, page.id, {
    rationale: 'This contradicts the Pricing page.',
    body: 'Revenue was $4.4M in Q2.',
  });
  const draft = store.getDraft(marc.id, page.id)!;
  assert.equal(draft.editorId, marc.id, 'the human editor still holds the lock');
  assert.equal(draft.body, 'Marc is rewriting this paragraph.', 'the proposal did not touch the draft');

  // And a person can still edit while proposals are open — the lock is theirs.
  store.editDraft(marc.id, page.id, { body: 'Marc finished the paragraph.' });
  // Accepting would clear that draft, so it is refused rather than clobbering it.
  const locked = expectCode(() => store.acceptProposal(dana.id, proposal.id, {}), 'locked');
  assert.match((locked as CanonError).message, /being edited by Marc/);
  store.publish(marc.id, page.id); // Marc's own work lands first, on his own schedule

  // Several proposals coexist on one page, from an agent and a person alike.
  const second = store.createProposal(dana.id, page.id, { rationale: 'Tidy the heading.', title: 'Q2 revenue' });
  const open = store.listProposals(marc.id, page.id, { status: 'open' });
  assert.equal(open.length, 2);
  assert.deepEqual(new Set(open.map((p) => p.authorId)), new Set([bot.id, dana.id]));
  assert.equal(second.authorKind, 'person'); // people propose under the same rules

  // Taking the lock is still free with two proposals open.
  store.editDraft(dana.id, page.id, { body: 'Dana typing.' });
  assert.equal(store.getDraft(dana.id, page.id)!.editorId, dana.id);
});

test('proposals: a rationale is required — an unexplained change is not reviewable', () => {
  const { store, marc, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);
  expectCode(() => store.createProposal(bot.id, page.id, { rationale: '', body: 'x' }), 'invalid');
  expectCode(() => store.createProposal(bot.id, page.id, { rationale: '   ', body: 'x' }), 'invalid');
  const err = expectCode(
    () => store.createProposal(bot.id, page.id, { rationale: undefined as unknown as string, body: 'x' }),
    'invalid',
  );
  assert.match((err as CanonError).message, /rationale/i);
  assert.equal(store.listProposals(marc.id, page.id).length, 0);
});

test('proposals: rejection takes a comment, and the author is told', () => {
  const { store, marc, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);
  const proposal = store.createProposal(bot.id, page.id, {
    rationale: 'The source figure changed.',
    body: 'Revenue was $9.9M in Q2.',
  });

  expectCode(() => store.rejectProposal(marc.id, proposal.id, { comment: '  ' }), 'invalid');

  const rejected = store.rejectProposal(marc.id, proposal.id, {
    comment: 'That is the forecast, not the reported figure. Use the closed-books number.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decidedBy, marc.id);
  assert.match(rejected.decisionNote!, /closed-books/);
  assert.equal(store.getPage(marc.id, page.id).currentVersion, 1, 'a rejected proposal changes nothing');

  // The proposing agent hears why, through the same inbox a person reads.
  const told = ofKind(store, bot.id, 'proposal_rejected');
  assert.equal(told.length, 1);
  assert.match(told[0]!.body, /closed-books/);

  // A settled proposal is settled.
  expectCode(() => store.acceptProposal(marc.id, proposal.id, {}), 'workflow');
  expectCode(() => store.rejectProposal(marc.id, proposal.id, { comment: 'again' }), 'workflow');
});

test('proposals: a new proposal notifies the page owner, or those who could act on it', () => {
  const { store, dana, marc, iris, rosa, vera, bot, collection } = setup();
  const owned = publishedNote(store, marc.id, collection.id); // Marc owns it
  store.createProposal(bot.id, owned.id, { rationale: 'Figure moved.', body: 'x' });
  assert.equal(ofKind(store, marc.id, 'proposal_opened').length, 1);
  assert.equal(ofKind(store, dana.id, 'proposal_opened').length, 0, 'a named owner is the one who hears');

  // A page with no owner yet falls back to the members who could act on it,
  // the same fallback a review request uses when a type names no approver.
  const unowned = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Scratch' });
  store.createProposal(bot.id, unowned.id, { rationale: 'A gap: this page has no retention line.', body: 'y' });
  for (const actor of [dana, marc, iris]) {
    assert.equal(ofKind(store, actor.id, 'proposal_opened').length >= 1, true, `${actor.name} should hear`);
  }
  assert.equal(ofKind(store, rosa.id, 'proposal_opened').length, 0); // comment role cannot act on it
  assert.equal(ofKind(store, vera.id, 'proposal_opened').length, 0);
  assert.equal(ofKind(store, bot.id, 'proposal_opened').length, 0); // never its own proposal
});

test('proposals: accepting one whose base version has moved is refused and supersedes it', () => {
  const { store, marc, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);
  const proposal = store.createProposal(bot.id, page.id, {
    rationale: 'The source figure changed.',
    body: 'Revenue was $4.4M in Q2.',
  });
  assert.equal(proposal.baseVersion, 1);

  // The record moves on under the proposal.
  store.editDraft(marc.id, page.id, { body: 'Revenue was $4.2M in Q2, restated.' });
  store.publish(marc.id, page.id);

  // Staleness is visible before anyone tries to accept.
  const listed = store.listProposals(marc.id, page.id)[0]!;
  assert.equal(listed.status, 'open');
  assert.equal(listed.stale, true);

  const err = expectCode(() => store.acceptProposal(marc.id, proposal.id, {}), 'conflict') as CanonError;
  assert.equal(err.details.baseVersion, 1);
  assert.equal(err.details.currentVersion, 2);
  assert.match(err.message, /proposed again/);

  // The newer content survives untouched: no silent clobber.
  assert.equal(store.getPage(marc.id, page.id).currentVersion, 2);
  assert.equal(store.getVersion(marc.id, page.id, 2).body, 'Revenue was $4.2M in Q2, restated.');
  assert.equal(store.listVersions(marc.id, page.id).length, 2);

  // The proposal is marked, audited, and its author told to re-propose.
  const after = store.listProposals(marc.id, page.id)[0]!;
  assert.equal(after.status, 'superseded');
  assert.equal(after.stale, false, 'stale describes an open proposal; this one is settled');
  const events = store.queryAudit(marc.id, { action: 'proposal.supersede' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.details.reason, 'base_version_moved');
  assert.equal(events[0]!.details.proposalId, proposal.id);
  assert.equal(ofKind(store, bot.id, 'proposal_superseded').length, 1);

  // Re-proposing against the current record works, and accepts cleanly.
  const again = store.createProposal(bot.id, page.id, {
    rationale: 'Re-proposed against the restated figure.',
    body: 'Revenue was $4.4M in Q2, restated.',
  });
  assert.equal(again.baseVersion, 2);
  assert.equal(store.acceptProposal(marc.id, again.id, {}).page.currentVersion, 3);
});

test('proposals: accepting one supersedes the others, which were written against the old record', () => {
  const { store, marc, dana, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);
  const first = store.createProposal(bot.id, page.id, { rationale: 'Figure moved.', body: 'A' });
  const second = store.createProposal(dana.id, page.id, { rationale: 'Contradicts page X.', body: 'B' });

  store.acceptProposal(marc.id, first.id, {});

  const settled = store.listProposals(marc.id, page.id);
  const other = settled.find((p) => p.id === second.id)!;
  assert.equal(other.status, 'superseded');
  assert.equal(other.supersededBy, first.id);
  const events = store.queryAudit(marc.id, { action: 'proposal.supersede' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.details.reason, 'page_moved');
  assert.equal(ofKind(store, dana.id, 'proposal_superseded').length, 1);
  assert.equal(store.getVersion(marc.id, page.id, 2).body, 'A');
});

test('proposals: a reviewed type keeps its rules — Canonical only through its named approver', () => {
  const { store, dana, marc, iris, bot, collection } = setup();
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });

  // A Policy needs an owner and a named approver before anything can publish,
  // and an accepted proposal is a publish.
  const bare = store.createProposal(bot.id, page.id, {
    rationale: 'The retention period in the source system is now 7 years.',
    body: 'Records are kept 7 years.',
  });
  const err = expectCode(() => store.acceptProposal(marc.id, bare.id, {}), 'workflow') as CanonError;
  assert.match(err.message, /requires an owner/);
  assert.equal(store.listProposals(marc.id, page.id)[0]!.status, 'open', 'a refused acceptance settles nothing');

  const complete = store.createProposal(bot.id, page.id, {
    rationale: 'The retention period in the source system is now 7 years.',
    body: 'Records are kept 7 years.',
    fields: { ownerId: marc.id, approverId: iris.id, effectiveDate: TODAY, reviewDate: '2099-01-01' },
  });
  const decision = store.acceptProposal(marc.id, complete.id, {});

  // Accepted, published, authored by the agent — and NOT Canonical. The mark
  // applies to reviewed content, and nothing has been reviewed yet.
  assert.equal(decision.page.currentVersion, 1);
  assert.equal(decision.page.status, 'draft');
  assert.equal(store.getVersion(marc.id, page.id, 1).authorId, bot.id);

  // Reaching Canonical is the ordinary workflow, unchanged.
  store.editDraft(marc.id, page.id, { body: 'Records are kept 7 years.' });
  store.submitForReview(marc.id, page.id);

  // A proposal on a page under review is welcome, but waits: the review
  // workflow owns the page until it settles.
  const during = store.createProposal(bot.id, page.id, { rationale: 'Name the destruction method.', body: 'z' });
  expectCode(() => store.acceptProposal(marc.id, during.id, {}), 'workflow');

  expectCode(() => store.approve(dana.id, page.id), 'forbidden'); // admin is not the named approver
  const canonical = store.approve(iris.id, page.id);
  assert.equal(canonical.status, 'canonical');

  // The approval moved the page to version 2, so the proposal written against
  // version 1 is now stale and must be re-proposed rather than applied.
  assert.equal(store.listProposals(marc.id, page.id).find((p) => p.id === during.id)!.stale, true);
  expectCode(() => store.acceptProposal(marc.id, during.id, {}), 'conflict');
});

test('proposals: accepting is a person’s act — an agent cannot accept, its own or anyone’s', () => {
  const { store, marc, dana, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);

  const mine = store.createProposal(bot.id, page.id, { rationale: 'Figure moved.', body: 'A' });
  const self = expectCode(() => store.acceptProposal(bot.id, mine.id, {}), 'forbidden') as CanonError;
  assert.equal(self.details.reason, 'review_is_a_persons_act');
  expectCode(() => store.rejectProposal(bot.id, mine.id, { comment: 'no' }), 'forbidden');

  // Not its own, and not a person's either: the rule is about who is asking.
  const theirs = store.createProposal(dana.id, page.id, { rationale: 'Tidy the heading.', title: 'Q2 revenue' });
  expectCode(() => store.acceptProposal(bot.id, theirs.id, {}), 'forbidden');

  // A person cannot accept their own proposal either; someone else decides.
  expectCode(() => store.acceptProposal(dana.id, theirs.id, {}), 'workflow');
  assert.equal(store.acceptProposal(marc.id, theirs.id, {}).proposal.status, 'accepted');
});

test('proposals: permissions — proposing takes edit, reading takes view', () => {
  const { store, marc, rosa, vera, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);

  // Canon's half of the intersection, applied to people and agents alike.
  expectCode(() => store.createProposal(rosa.id, page.id, { rationale: 'r', body: 'x' }), 'forbidden'); // comment
  expectCode(() => store.createProposal(vera.id, page.id, { rationale: 'r', body: 'x' }), 'forbidden'); // view
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  expectCode(() => store.createProposal(outsider.id, page.id, { rationale: 'r', body: 'x' }), 'forbidden');

  const proposal = store.createProposal(bot.id, page.id, { rationale: 'Figure moved.', body: 'A' });
  assert.equal(store.listProposals(vera.id, page.id).length, 1, 'view can read what is proposed');
  expectCode(() => store.listProposals(outsider.id, page.id), 'forbidden');

  // Deciding takes edit too: comment and view roles cannot settle a proposal.
  expectCode(() => store.acceptProposal(vera.id, proposal.id, {}), 'forbidden');
  expectCode(() => store.rejectProposal(rosa.id, proposal.id, { comment: 'no' }), 'forbidden');

  // Archived pages take no proposals.
  const old = publishedNote(store, marc.id, collection.id, 'Old');
  store.archivePage(marc.id, old.id);
  expectCode(() => store.createProposal(bot.id, old.id, { rationale: 'r', body: 'x' }), 'workflow');
  expectCode(() => store.createProposal(bot.id, 'no-such-page', { rationale: 'r', body: 'x' }), 'not_found');
});

test('proposals: the whole loop is on the audit record, attributed to whoever acted', () => {
  const { store, marc, dana, bot, collection } = setup();
  const page = publishedNote(store, marc.id, collection.id);

  const accepted = store.createProposal(bot.id, page.id, { rationale: 'Figure moved.', body: 'A' });
  const alsoOpen = store.createProposal(bot.id, page.id, { rationale: 'Second thought.', body: 'B' });
  const rejected = store.createProposal(dana.id, page.id, { rationale: 'Tidy the heading.', title: 'Q2 revenue' });
  store.rejectProposal(marc.id, rejected.id, { comment: 'The heading matches the tree; leave it.' });
  store.acceptProposal(marc.id, accepted.id, {});

  const creates = store.queryAudit(marc.id, { action: 'proposal.create' });
  assert.equal(creates.length, 3);
  const byAgent = creates.filter((e) => e.actorId === bot.id);
  assert.equal(byAgent.length, 2);
  assert.ok(byAgent.every((e) => e.actorKind === 'agent'));
  assert.ok(byAgent.every((e) => e.pageId === page.id && typeof e.details.rationale === 'string'));

  const accepts = store.queryAudit(marc.id, { action: 'proposal.accept' });
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.actorId, marc.id);
  assert.equal(accepts[0]!.actorKind, 'person');
  assert.equal(accepts[0]!.details.authorId, bot.id);
  assert.equal(accepts[0]!.details.acceptedBy, marc.id);
  assert.equal(accepts[0]!.details.version, 2);

  const rejects = store.queryAudit(marc.id, { action: 'proposal.reject' });
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0]!.details.proposalId, rejected.id);
  assert.match(rejects[0]!.details.comment as string, /leave it/);

  const supersedes = store.queryAudit(marc.id, { action: 'proposal.supersede' });
  assert.equal(supersedes.length, 1);
  assert.equal(supersedes[0]!.details.proposalId, alsoOpen.id);
});

// ---- the intersection, over HTTP, against the real Registry stub ---------

interface Rig {
  registry: RegistryStore;
  store: CanonStore;
  close: () => void;
  call: (
    method: string,
    path: string,
    auth?: { actor?: string; passport?: string },
    body?: unknown,
  ) => Promise<{ status: number; json: any }>;
}

async function rig(): Promise<Rig> {
  const registry = new RegistryStore();
  const registryServer: Server = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;

  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: 0, requestTimeoutMs: 500 }),
  });
  const canon = createApi(store, auth);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;

  const call = async (
    method: string,
    path: string,
    authHeaders: { actor?: string; passport?: string } = {},
    body?: unknown,
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authHeaders.actor ? { 'x-actor-id': authHeaders.actor } : {}),
        ...(authHeaders.passport ? { 'x-agent-passport': authHeaders.passport } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  return {
    registry,
    store,
    call,
    close: () => {
      canon.close();
      registryServer.close();
    },
  };
}

test('API: an agent needs Registry write AND Canon edit to propose, and can never accept', async () => {
  const r = await rig();
  try {
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    // She runs this Canon: `GET /actors` shows the whole directory — including
    // the agent actor this test then grants a role to — to an operator, not to
    // whoever administers a collection (SECURITY.md F11, orgrole.ts).
    r.store.bootstrapAdministrator(dana.id);
    const collection = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Compliance' })).json;
    const page = (
      await r.call(
        'POST',
        '/pages',
        { actor: dana.id },
        { collectionId: collection.id, type: 'note', title: 'Q2 figures' },
      )
    ).json;
    await r.call('PUT', `/pages/${page.id}/draft`, { actor: dana.id }, { body: 'Revenue was $4.1M in Q2.' });
    await r.call('POST', `/pages/${page.id}/publish`, { actor: dana.id }, {});

    const bot = r.registry.register({
      name: 'Freshness Agent',
      permittedCollections: [collection.id],
      permittedActions: ['read'],
    });
    r.registry.certify(bot.agentId);
    // First contact provisions the agent's Canon actor.
    await r.call('GET', '/collections', { passport: bot.passport });
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find((a) => a.kind === 'agent');

    const body = { rationale: 'The source figure changed.', body: 'Revenue was $4.4M in Q2.' };

    // Registry says read only: refused at the door, before Canon's roles matter.
    const noWrite = await r.call('POST', `/pages/${page.id}/proposals`, { passport: bot.passport }, body);
    assert.equal(noWrite.status, 403);
    assert.equal(noWrite.json.reason, 'action_not_permitted');

    // Registry grants write; Canon still grants nothing.
    r.registry.setPermissions(bot.agentId, {
      permittedCollections: [collection.id],
      permittedActions: ['read', 'write'],
    });
    const noRole = await r.call('POST', `/pages/${page.id}/proposals`, { passport: bot.passport }, body);
    assert.equal(noRole.status, 403);
    assert.equal(noRole.json.needed, 'edit');

    // Both halves allow: the agent proposes.
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'edit' });
    const proposed = await r.call('POST', `/pages/${page.id}/proposals`, { passport: bot.passport }, body);
    assert.equal(proposed.status, 200, JSON.stringify(proposed.json));
    assert.equal(proposed.json.authorKind, 'agent');
    assert.equal(proposed.json.status, 'open');

    // A rationale is required over HTTP too.
    const unexplained = await r.call('POST', `/pages/${page.id}/proposals`, { passport: bot.passport }, { body: 'x' });
    assert.equal(unexplained.status, 400);

    // Reading the page's proposals is `read`, and the page is unchanged.
    const listed = await r.call('GET', `/pages/${page.id}/proposals?status=open`, { passport: bot.passport });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.length, 1);
    assert.equal((await r.call('GET', `/pages/${page.id}`, { actor: dana.id })).json.currentVersion, 1);

    // Accepting and rejecting are not in the agent vocabulary at all: the
    // routes are absent from agentauth's table, so the door refuses them.
    for (const verb of ['accept', 'reject']) {
      const attempt = await r.call(
        'POST',
        `/proposals/${proposed.json.id}/${verb}`,
        { passport: bot.passport },
        { comment: 'mine now' },
      );
      assert.equal(attempt.status, 403);
      assert.equal(attempt.json.reason, 'route_not_available_to_agents');
    }
    const denials = (await r.call('GET', '/audit?action=agent.denied', { actor: dana.id })).json;
    assert.ok(denials.some((e: any) => e.details.reason === 'route'));

    // A person accepts, and the agent's words become the record.
    const accepted = await r.call('POST', `/proposals/${proposed.json.id}/accept`, { actor: dana.id }, {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.page.currentVersion, 2);
    assert.equal(accepted.json.proposal.status, 'accepted');
    const v2 = (await r.call('GET', `/pages/${page.id}/versions/2`, { actor: dana.id })).json;
    assert.equal(v2.authorId, agent.id);
    assert.equal(v2.body, 'Revenue was $4.4M in Q2.');
  } finally {
    r.close();
  }
});

test('API: rejecting takes a comment, and a stale proposal answers 409', async () => {
  const r = await rig();
  try {
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    const marc = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Marc' })).json;
    const collection = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Compliance' })).json;
    await r.call('PUT', `/collections/${collection.id}/members/${marc.id}`, { actor: dana.id }, { role: 'edit' });
    const page = (
      await r.call('POST', '/pages', { actor: dana.id }, { collectionId: collection.id, type: 'note', title: 'N' })
    ).json;
    await r.call('PUT', `/pages/${page.id}/draft`, { actor: dana.id }, { body: 'v1' });
    await r.call('POST', `/pages/${page.id}/publish`, { actor: dana.id }, {});

    const one = (
      await r.call('POST', `/pages/${page.id}/proposals`, { actor: marc.id }, { rationale: 'Because.', body: 'v2' })
    ).json;
    const two = (
      await r.call('POST', `/pages/${page.id}/proposals`, { actor: marc.id }, { rationale: 'Also.', body: 'v3' })
    ).json;

    const noComment = await r.call('POST', `/proposals/${one.id}/reject`, { actor: dana.id }, {});
    assert.equal(noComment.status, 400);
    const rejected = await r.call('POST', `/proposals/${one.id}/reject`, { actor: dana.id }, { comment: 'Not yet.' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.status, 'rejected');

    // The page moves on, so the second proposal no longer knows what it replaces.
    await r.call('PUT', `/pages/${page.id}/draft`, { actor: dana.id }, { body: 'v2 by hand' });
    await r.call('POST', `/pages/${page.id}/publish`, { actor: dana.id }, {});

    const stale = (await r.call('GET', `/pages/${page.id}/proposals?status=open`, { actor: dana.id })).json;
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale, true);

    const conflict = await r.call('POST', `/proposals/${two.id}/accept`, { actor: dana.id }, {});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, 'conflict');
    assert.equal((await r.call('GET', `/pages/${page.id}`, { actor: dana.id })).json.current.body, 'v2 by hand');
    const settled = (await r.call('GET', `/pages/${page.id}/proposals`, { actor: dana.id })).json;
    assert.deepEqual(
      settled.map((p: any) => p.status),
      ['rejected', 'superseded'],
    );
  } finally {
    r.close();
  }
});
