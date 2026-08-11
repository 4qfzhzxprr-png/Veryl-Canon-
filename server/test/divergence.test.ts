import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { sameFact } from '../src/divergence.js';
import { CanonError } from '../src/model.js';
import type { Notification, NotificationTransport } from '../src/notify.js';
import { RegistryClient } from '../src/registry.js';
import { setHandOrgRole } from '../src/orgrole.js';
import { CanonStore } from '../src/store.js';
import { staticConnectorOf } from '../src/connectors.js';

// Authority, corroboration and divergence (DATA-BACKBONE.md §7): the machinery
// that lets Canon notice two systems disagreeing without ever deciding between
// them.
//
// Every test here is one of §7's sentences held to its exact wording. The
// authority's value displays even when it is stale and a corroborating source
// is fresh, because "freshness is not authority". A disagreement is a record
// rather than a decision, so it is written, attributed, notified and audited —
// and never resolved. A closure is a decision the record keeps, so it takes a
// reason and does not clear itself when the systems drift back into agreement.
//
// Everything runs through the hermetic static connector: no external call.

const quiet: NotificationTransport = { deliver() {} };

function setup(transport: NotificationTransport = quiet) {
  const db = openDb(':memory:');
  const store = new CanonStore(db, transport);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, vera.id, 'view');
  return { db, store, dana, marc, vera, outsider, collection };
}

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

/** A registered source answering from its own fixture set. */
function makeSource(
  store: CanonStore,
  adminId: string,
  collectionId: string,
  name: string,
  set: string,
  fixtures: Record<string, Record<string, unknown>>,
  freshnessWindowMs = 0, // 0 = always ask the source, which is what these tests want
) {
  staticConnectorOf(store.connectors).define(set, fixtures);
  return store.createSource(adminId, {
    name,
    kind: 'static',
    baseUrl: `static:${set}`,
    authMode: 'service',
    freshnessWindowMs,
    collectionIds: [collectionId],
  });
}

/** A published Note with a named owner, so the outbox has somebody to tell. */
function ownedPage(store: CanonStore, editorId: string, collectionId: string, title: string, ownerId: string) {
  const page = store.createPage(editorId, { collectionId, type: 'note', title });
  store.editDraft(editorId, page.id, { body: 'The deductible is shown below.', fields: { ownerId } });
  store.publish(editorId, page.id);
  return page;
}

/**
 * The standard arrangement: one page, one authoritative source, one
 * corroborating source, both answering `deductible/PLAN-7`. Both values are
 * mutable so a test can make the systems agree, disagree, or fall over.
 */
function twoSystems(transport: NotificationTransport = quiet) {
  const rig = setup(transport);
  const state: { authority: unknown; other: unknown; authorityDown: boolean; otherDown: boolean } = {
    authority: 1500,
    other: 1500,
    authorityDown: false,
    otherDown: false,
  };
  const benefits = makeSource(rig.store, rig.dana.id, rig.collection.id, 'Benefits Admin', 'benefits', {
    deductible: {
      'PLAN-7': () => {
        if (state.authorityDown) throw new Error('Benefits Admin is unreachable');
        return state.authority;
      },
    },
  });
  const claims = makeSource(rig.store, rig.dana.id, rig.collection.id, 'Claims', 'claims', {
    deductible: {
      'PLAN-7': () => {
        if (state.otherDown) throw new Error('Claims is unreachable');
        return state.other;
      },
    },
  });
  const page = ownedPage(rig.store, rig.marc.id, rig.collection.id, 'Benefits policy', rig.marc.id);
  const authorityRef = rig.store.addReference(rig.marc.id, page.id, {
    sourceId: benefits.id,
    selector: 'deductible',
    key: 'PLAN-7',
    label: 'Plan deductible',
  });
  const otherRef = rig.store.addReference(rig.marc.id, page.id, {
    sourceId: claims.id,
    selector: 'deductible',
    key: 'PLAN-7',
    label: 'Deductible (claims copy)',
    role: 'corroborating',
  });
  return { ...rig, state, benefits, claims, page, authorityRef, otherRef };
}

// ---- the model: authority and corroboration ---------------------------

test('authority: at most one per (page, selector, key) — a second is refused', () => {
  const { store, dana, marc, vera, collection } = setup();
  const benefits = makeSource(store, dana.id, collection.id, 'Benefits Admin', 'benefits', {
    deductible: { 'PLAN-7': 1500, 'PLAN-8': 900 },
  });
  const claims = makeSource(store, dana.id, collection.id, 'Claims', 'claims', { deductible: { 'PLAN-7': 1200 } });
  const page = ownedPage(store, marc.id, collection.id, 'Benefits policy', marc.id);

  const first = store.addReference(marc.id, page.id, { sourceId: benefits.id, selector: 'deductible', key: 'PLAN-7' });
  assert.equal(first.role, 'authority', 'role defaults to authority, so every existing reference keeps its meaning');

  const refused = expectCode(
    () => store.addReference(marc.id, page.id, { sourceId: claims.id, selector: 'deductible', key: 'PLAN-7' }),
    'conflict',
  );
  assert.match(refused.message, /already names Benefits Admin as the authority/);
  assert.match(refused.message, /contradiction in the model rather than in the data/);
  assert.equal(refused.details.authorityReferenceId, first.id);

  // The same source, a different fact: its own authority, no conflict.
  const other = store.addReference(marc.id, page.id, { sourceId: claims.id, selector: 'deductible', key: 'PLAN-8' });
  assert.equal(other.role, 'authority');

  // And what the second source actually wanted to be.
  const corroborating = store.addReference(marc.id, page.id, {
    sourceId: claims.id,
    selector: 'deductible',
    key: 'PLAN-7',
    role: 'corroborating',
  });
  assert.equal(corroborating.role, 'corroborating');
  assert.deepEqual(
    store
      .listReferences(vera.id, page.id)
      .map((r) => r.role)
      .sort(),
    ['authority', 'authority', 'corroborating'],
  );
});

test('authority: a corroborating reference requires an authority to corroborate', () => {
  const { store, dana, marc, collection } = setup();
  const claims = makeSource(store, dana.id, collection.id, 'Claims', 'claims', { deductible: { 'PLAN-7': 1200 } });
  const benefits = makeSource(store, dana.id, collection.id, 'Benefits Admin', 'benefits', {
    deductible: { 'PLAN-7': 1500 },
  });
  const page = ownedPage(store, marc.id, collection.id, 'Benefits policy', marc.id);

  const refused = expectCode(
    () =>
      store.addReference(marc.id, page.id, {
        sourceId: claims.id,
        selector: 'deductible',
        key: 'PLAN-7',
        role: 'corroborating',
      }),
    'workflow',
  );
  assert.match(refused.message, /requires an authority to corroborate/);
  assert.match(refused.message, /this page names none for deductible\/PLAN-7/);

  // Name the authority, and the same call now succeeds.
  store.addReference(marc.id, page.id, { sourceId: benefits.id, selector: 'deductible', key: 'PLAN-7' });
  const corroborating = store.addReference(marc.id, page.id, {
    sourceId: claims.id,
    selector: 'deductible',
    key: 'PLAN-7',
    role: 'corroborating',
  });
  assert.equal(corroborating.role, 'corroborating');

  // An unknown role is refused rather than coerced to a default.
  expectCode(
    () =>
      store.addReference(marc.id, page.id, {
        sourceId: claims.id,
        selector: 'deductible',
        key: 'PLAN-9',
        role: 'preferred' as unknown as 'authority',
      }),
    'invalid',
  );
});

test('authority: removing the authority while copies of it remain is refused', () => {
  const { store, marc, authorityRef, otherRef } = twoSystems();
  const refused = expectCode(() => store.removeReference(marc.id, authorityRef.id), 'conflict');
  assert.match(refused.message, /corroborating reference\(s\) on this page answer deductible\/PLAN-7/);
  assert.equal(refused.details.corroborating, 1);

  // Remove the copy first, and the authority goes.
  store.removeReference(marc.id, otherRef.id);
  store.removeReference(marc.id, authorityRef.id);
  assert.deepEqual(store.listReferences(marc.id, authorityRef.pageId), []);
});

// ---- what displays -----------------------------------------------------

test('display: the authority’s value displays while a corroborating source disagrees', async () => {
  const { store, marc, state, page, authorityRef, otherRef, benefits, claims } = twoSystems();
  state.other = 1200;

  const resolved = await store.resolveReferences(marc.id, page.id);
  const authority = resolved.find((r) => r.referenceId === authorityRef.id)!;
  const other = resolved.find((r) => r.referenceId === otherRef.id)!;

  // The authority is untouched: its own source's value, its own timestamp.
  assert.equal(authority.value, 1500, 'a corroborating source never replaces the authority’s value');
  assert.equal(authority.role, 'authority');
  assert.equal(authority.sourceId, benefits.id);
  assert.equal(authority.error, undefined);
  // The corroborating source is shown for what it is, beside it — not merged,
  // not averaged, not hidden.
  assert.equal(other.value, 1200);
  assert.equal(other.role, 'corroborating');
  assert.equal(other.sourceId, claims.id);

  // Both sides carry the marker, so the page can render the disagreement
  // without a second call.
  assert.equal(other.divergence!.side, 'corroborating');
  assert.equal(other.divergence!.open.length, 1);
  assert.equal(authority.divergence!.side, 'authority');
  assert.equal(authority.divergence!.open.length, 1);
  const marker = other.divergence!.open[0]!;
  assert.equal(marker.referenceId, otherRef.id);
  assert.equal(marker.pageId, page.id);
  assert.equal(marker.authoritySourceId, benefits.id);
  assert.equal(marker.authorityValue, 1500);
  assert.equal(marker.otherSourceId, claims.id);
  assert.equal(marker.otherValue, 1200);
  assert.equal(marker.state, 'open');
  assert.ok(marker.observedAt);
  assert.equal(marker.closedBy, undefined, 'an open divergence carries no empty decision');
  assert.equal(marker.reason, undefined);
});

test('display: freshness is not authority — a stale authority still displays, and opens nothing', async () => {
  const { store, marc, state, page, authorityRef, otherRef } = twoSystems();

  // Both agree first, so the authority has something cached to fall back on.
  await store.resolveReferences(marc.id, page.id);
  assert.deepEqual(store.listPageDivergences(marc.id, page.id), []);

  // Now the system that OWNS the fact goes down, and the copy moves on.
  state.authorityDown = true;
  state.other = 1200;
  const resolved = await store.resolveReferences(marc.id, page.id);
  const authority = resolved.find((r) => r.referenceId === authorityRef.id)!;
  const other = resolved.find((r) => r.referenceId === otherRef.id)!;

  assert.equal(authority.value, 1500, 'the last known authoritative value still displays');
  assert.equal(authority.stale, true);
  assert.ok(authority.error, 'and it is labelled with why it could not be refreshed');
  assert.equal(other.value, 1200);
  assert.equal(other.stale, false);

  // "A stale answer from the system that owns a fact still beats a fresh one
  // from a system that does not." The fresh copy does not win, and — because
  // one side is stale — it does not even count as a disagreement.
  assert.deepEqual(store.listPageDivergences(marc.id, page.id), []);
  assert.equal(authority.divergence, undefined);
  assert.equal(other.divergence, undefined);
});

// ---- detection ---------------------------------------------------------

test('divergence: opened once, then updated rather than duplicated', async () => {
  const { store, marc, state, page, otherRef } = twoSystems();
  state.other = 1200;

  await store.resolveReferences(marc.id, page.id);
  const first = store.listPageDivergences(marc.id, page.id);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.otherValue, 1200);
  const id = first[0]!.id;
  const firstObservedAt = first[0]!.observedAt;

  // A page read a thousand times must not write a thousand rows.
  for (let i = 0; i < 5; i += 1) await store.resolveReferences(marc.id, page.id);
  const again = store.listPageDivergences(marc.id, page.id);
  assert.equal(again.length, 1, 'one row per disagreeing pair');
  assert.equal(again[0]!.id, id, 'and it is the same row');

  // The row carries the LATEST observation.
  state.other = 1100;
  await store.resolveReferences(marc.id, page.id);
  const latest = store.listPageDivergences(marc.id, page.id);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.id, id);
  assert.equal(latest[0]!.otherValue, 1100);
  assert.ok(latest[0]!.observedAt >= firstObservedAt);

  // One `divergence.open` for the whole sequence: the event is the opening,
  // and it happened once.
  assert.equal(store.queryAudit(marc.id, { action: 'divergence.open' }).length, 1);
});

test('divergence: nothing is opened when a side failed to resolve', async () => {
  const { store, marc, state, page, otherRef } = twoSystems();
  state.other = 1200;
  state.otherDown = true; // down from the start: no value, and nothing cached

  const resolved = await store.resolveReferences(marc.id, page.id);
  const other = resolved.find((r) => r.referenceId === otherRef.id)!;
  assert.equal(other.value, null);
  assert.ok(other.error);
  assert.deepEqual(
    store.listPageDivergences(marc.id, page.id),
    [],
    'an unknown value is not a disagreeing value: a source outage is not a contradiction',
  );

  // The authority alone is likewise no contradiction.
  state.authorityDown = true;
  await store.resolveReferences(marc.id, page.id);
  assert.deepEqual(store.listPageDivergences(marc.id, page.id), []);
});

test('divergence: values that agree again do NOT close the open record', async () => {
  const { store, marc, state, page } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);
  const opened = store.listPageDivergences(marc.id, page.id);
  assert.equal(opened.length, 1);

  // The systems drift back into agreement. §7: "No silent closure of a
  // divergence because two systems drifted back into agreement."
  state.other = 1500;
  await store.resolveReferences(marc.id, page.id);
  const after = store.listPageDivergences(marc.id, page.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, opened[0]!.id);
  assert.equal(after[0]!.state, 'open', 'only a person closes a divergence');
  assert.equal(after[0]!.otherValue, 1200, 'and it still says what was actually observed');
  assert.equal(store.queryAudit(marc.id, { action: 'divergence.close' }).length, 0);
});

// ---- what counts as the same fact --------------------------------------

test('divergence: 1500, "1500" and 1500.0 are one fact; "1,500" and "$1500" are not', () => {
  // The rule, stated as a table. Numbers are normalised across the wire
  // formats they cross; nothing else is, because everything else discards
  // meaning that might BE the disagreement.
  assert.equal(sameFact(1500, '1500'), true);
  assert.equal(sameFact(1500, 1500.0), true);
  assert.equal(sameFact('1500.00', 1500), true);
  assert.equal(sameFact(' 1500 ', 1500), true, 'surrounding whitespace is not a fact');
  assert.equal(sameFact('1.5e3', 1500), true);
  assert.equal(sameFact(0, -0), true);

  assert.equal(sameFact(1500, 1200), false);
  assert.equal(sameFact('1,500', 1500), false, 'a thousands separator is a decimal point in half of Europe');
  assert.equal(sameFact('$1500', 1500), false, 'the unit is part of the fact');
  assert.equal(sameFact('1500 USD', 1500), false);
  assert.equal(sameFact('about 1500', 1500), false);
  assert.equal(sameFact(true, 'true'), false);
  assert.equal(sameFact('Active', 'active'), false, 'case is not folded: it may be two codes');
  assert.equal(sameFact('', 0), false);
  assert.equal(sameFact(null, 0), false);
  assert.equal(sameFact(Number.NaN, Number.NaN), false, 'a non-finite number is not a value to compare');

  // Structures: key order is not meaning, array order is.
  assert.equal(sameFact({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameFact({ a: 1, b: '2' }, { a: 1, b: 2 }), false, 'no normalisation reaches inside a structure');
  assert.equal(sameFact([1, 2], [2, 1]), false);
  assert.equal(sameFact([1, 2], [1, 2]), true);
});

test('divergence: the same number spelled two ways is not a contradiction', async () => {
  const { store, marc, state, page } = twoSystems();

  // The claims system exports strings; the benefits system answers JSON
  // numbers. That is a wire format, not a disagreement.
  state.other = '1500';
  await store.resolveReferences(marc.id, page.id);
  assert.deepEqual(store.listPageDivergences(marc.id, page.id), []);

  state.other = '1500.0';
  await store.resolveReferences(marc.id, page.id);
  assert.deepEqual(store.listPageDivergences(marc.id, page.id), []);

  // But a formatted string is a different answer, and Canon says so rather
  // than stripping the comma and hoping.
  state.other = '1,500';
  await store.resolveReferences(marc.id, page.id);
  const divergences = store.listPageDivergences(marc.id, page.id);
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0]!.otherValue, '1,500');
  assert.equal(divergences[0]!.authorityValue, 1500);
});

// ---- the outbox --------------------------------------------------------

test('divergence: the page’s owner is notified once, through the existing outbox', async () => {
  const sent: Notification[] = [];
  const capture: NotificationTransport = {
    deliver(notification) {
      sent.push(notification);
    },
  };
  const { store, marc, vera, state, page } = twoSystems(capture);
  state.other = 1200;

  // Vera (view only) reads the page: it is her read that notices, and it is
  // MARC — the owner, the person accountable for the page being true — who is
  // told. The reader is nobody's business.
  await store.resolveReferences(vera.id, page.id);
  const first = sent.filter((n) => n.kind === 'divergence_opened');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.recipientId, marc.id);
  assert.match(first[0]!.subject, /Sources disagree on "Benefits policy"/);
  assert.match(first[0]!.body, /Benefits Admin is the authority for deductible\/PLAN-7 and says 1500/);
  assert.match(first[0]!.body, /Claims says 1200/);
  assert.match(first[0]!.body, /Canon does not choose between them/);
  assert.match(first[0]!.link, new RegExp(`^/pages/${page.id}#divergence-`));

  // Read the page five more times, including by the owner himself: one
  // divergence, one notification. The outbox is not a firehose.
  for (let i = 0; i < 3; i += 1) await store.resolveReferences(vera.id, page.id);
  await store.resolveReferences(marc.id, page.id);
  assert.equal(sent.filter((n) => n.kind === 'divergence_opened').length, 1);
  assert.equal(store.listNotifications(marc.id).filter((n) => n.kind === 'divergence_opened').length, 1);
});

// ---- closing: a decision the record keeps ------------------------------

test('divergence: closing requires a reason, and records who closed it and when', async () => {
  const { store, marc, vera, state, page } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);
  const [open] = store.listPageDivergences(marc.id, page.id);
  assert.ok(open);

  // No reason, no closure: "a decision the record keeps, not a flag that
  // silently clears".
  const bare = expectCode(() => store.closeDivergence(marc.id, open.id, {}), 'invalid');
  assert.match(bare.message, /requires a reason/);
  expectCode(() => store.closeDivergence(marc.id, open.id, { reason: '   ' }), 'invalid');

  // Reading is `view`; closing is a judgement about the page and takes `edit`.
  expectCode(() => store.closeDivergence(vera.id, open.id, { reason: 'The copy was wrong' }), 'forbidden');
  assert.equal(store.listPageDivergences(vera.id, page.id).length, 1, 'but Vera may read it');

  const closed = store.closeDivergence(marc.id, open.id, {
    reason: 'The claims system was caching a figure the benefits administrator owns; corrected upstream.',
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedBy, marc.id);
  assert.ok(closed.closedAt);
  assert.match(closed.reason!, /caching a figure the benefits administrator owns/);
  // The observation itself is untouched by the decision about it.
  assert.equal(closed.authorityValue, 1500);
  assert.equal(closed.otherValue, 1200);

  // Closed is closed.
  const twice = expectCode(
    () => store.closeDivergence(marc.id, open.id, { reason: 'again' }),
    'workflow',
  );
  assert.match(twice.message, /already closed/);
});

test('divergence: a closed pair that diverges again opens a NEW one, with the old one intact', async () => {
  const { store, marc, state, page } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);
  const [first] = store.listPageDivergences(marc.id, page.id);
  assert.ok(first);
  store.closeDivergence(marc.id, first.id, { reason: 'Definitions differed; the copy has been retired.' });

  // Agreement for a while: nothing new, and nothing reopened.
  state.other = 1500;
  await store.resolveReferences(marc.id, page.id);
  assert.equal(store.listPageDivergences(marc.id, page.id).length, 1);

  // And then the same pair drifts again. That is a NEW divergence.
  state.other = 900;
  const resolved = await store.resolveReferences(marc.id, page.id);
  const all = store.listPageDivergences(marc.id, page.id);
  assert.equal(all.length, 2, 'the old one stays as history; the new one is its own record');
  const open = store.listPageDivergences(marc.id, page.id, { state: 'open' });
  const shut = store.listPageDivergences(marc.id, page.id, { state: 'closed' });
  assert.equal(open.length, 1);
  assert.equal(shut.length, 1);
  assert.notEqual(open[0]!.id, first.id);
  assert.equal(open[0]!.otherValue, 900);
  assert.equal(open[0]!.state, 'open');
  assert.equal(open[0]!.closedBy, undefined);
  // The closed one is exactly as it was left: same values, same reason, same
  // closer. A later disagreement does not revise an earlier judgement.
  assert.equal(shut[0]!.id, first.id);
  assert.equal(shut[0]!.otherValue, 1200);
  assert.equal(shut[0]!.closedBy, marc.id);
  assert.match(shut[0]!.reason!, /Definitions differed/);

  // The live marker shows only what is open.
  const corroborating = resolved.find((r) => r.role === 'corroborating')!;
  assert.equal(corroborating.divergence!.open.length, 1);
  assert.equal(corroborating.divergence!.open[0]!.id, open[0]!.id);
});

test('divergence: only a person may close one', async () => {
  const { store, dana, marc, collection, state, page } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);
  const [open] = store.listPageDivergences(marc.id, page.id);
  assert.ok(open);

  // An agent actor with Canon's own `edit` role — the widest Canon grant
  // there is for this act — is still refused. This is the dev-mode check,
  // which holds where no passport is presented at all; agentauth.ts refuses
  // the route a second time for a passport-bearing agent (see the HTTP test).
  const bot = store.createActor({ kind: 'agent', name: 'Reconciler', registryRef: 'passport:recon-1' });
  store.setMember(dana.id, collection.id, bot.id, 'edit');
  const refused = expectCode(() => store.closeDivergence(bot.id, open.id, { reason: 'The copy drifted' }), 'forbidden');
  assert.match(refused.message, /Only a person can close a divergence/);
  assert.equal(refused.details.reason, 'closing_is_a_persons_act');
  assert.equal(store.listPageDivergences(marc.id, page.id)[0]!.state, 'open');
});

// ---- the log -----------------------------------------------------------

test('divergence: opening and closing are both audited', async () => {
  const { store, marc, collection, state, page, authorityRef, otherRef, benefits, claims } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);
  const [divergence] = store.listPageDivergences(marc.id, page.id);
  assert.ok(divergence);

  const opened = store.queryAudit(marc.id, { action: 'divergence.open' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.actorId, marc.id);
  assert.equal(opened[0]!.pageId, page.id);
  assert.equal(opened[0]!.collectionId, collection.id);
  assert.equal(opened[0]!.details.divergenceId, divergence.id);
  assert.equal(opened[0]!.details.referenceId, otherRef.id);
  assert.equal(opened[0]!.details.selector, 'deductible');
  assert.equal(opened[0]!.details.key, 'PLAN-7');
  assert.equal(opened[0]!.details.authoritySourceId, benefits.id);
  assert.equal(opened[0]!.details.authoritySourceName, 'Benefits Admin');
  assert.equal(opened[0]!.details.authorityValue, 1500);
  assert.equal(opened[0]!.details.otherSourceId, claims.id);
  assert.equal(opened[0]!.details.otherSourceName, 'Claims');
  assert.equal(opened[0]!.details.otherValue, 1200);

  store.closeDivergence(marc.id, divergence.id, { reason: 'The copy was wrong and has been corrected upstream.' });
  const shut = store.queryAudit(marc.id, { action: 'divergence.close' });
  assert.equal(shut.length, 1);
  assert.equal(shut[0]!.actorId, marc.id);
  assert.equal(shut[0]!.pageId, page.id);
  assert.equal(shut[0]!.details.divergenceId, divergence.id);
  assert.match(String(shut[0]!.details.reason), /corrected upstream/);

  // The role is on the reference's own audit event too, so the log says which
  // system was named the authority and when.
  const added = store.queryAudit(marc.id, { action: 'reference.add' });
  assert.equal(added.find((e) => e.details.referenceId === authorityRef.id)!.details.role, 'authority');
  assert.equal(added.find((e) => e.details.referenceId === otherRef.id)!.details.role, 'corroborating');
});

// ---- permissions -------------------------------------------------------

test('divergence: reading takes view on the page’s collection, and the listing spans only your collections', async () => {
  const { store, dana, marc, vera, outsider, collection, state, page } = twoSystems();
  state.other = 1200;
  await store.resolveReferences(marc.id, page.id);

  // A member may read; an outsider with no role reads it as not_found —
  // existence-masking, exactly as they would the page itself (abilities.ts P1),
  // indistinguishable from a nonexistent page.
  assert.equal(store.listPageDivergences(vera.id, page.id).length, 1);
  expectCode(() => store.listPageDivergences(outsider.id, page.id), 'not_found');

  // The record-wide listing is a SPANNING read: filtered, never refused.
  assert.equal(store.listDivergences(vera.id).length, 1);
  assert.deepEqual(store.listDivergences(outsider.id), []);
  assert.equal(store.listDivergences(dana.id, { collectionId: collection.id }).length, 1);
  assert.deepEqual(
    store.listDivergences(dana.id, { collectionId: 'no-such-collection' }),
    [],
    'a collection you cannot see answers as a collection with nothing in it',
  );
  assert.deepEqual(store.listDivergences(dana.id, { state: 'closed' }), []);
  assert.equal(store.listDivergences(dana.id, { state: 'open' }).length, 1);
  expectCode(() => store.listDivergences(dana.id, { state: 'settled' as 'open' }), 'invalid');

  // One divergence by id, on the same terms.
  const [only] = store.listDivergences(marc.id);
  assert.equal(store.getDivergence(vera.id, only!.id).id, only!.id);
  // An outsider's read of a real divergence is byte-identical to a nonexistent
  // one: not_found, naming nothing (abilities.ts P1).
  expectCode(() => store.getDivergence(outsider.id, only!.id), 'not_found');
  expectCode(() => store.getDivergence(marc.id, 'no-such-divergence'), 'not_found');
});

// ---- over HTTP ---------------------------------------------------------

test('API: divergences over HTTP, with the marker on the resolved references', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor-id': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const marc = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Marc' })).json;
    const c = (await call('POST', '/collections', dana.id, { name: 'Benefits' })).json;
    await call('PUT', `/collections/${c.id}/members/${marc.id}`, dana.id, { role: 'edit' });

    staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': 1500 } });
    staticConnectorOf(store.connectors).define('claims', { deductible: { 'PLAN-7': 1200 } });
    const mk = async (name: string, set: string) =>
      (
        await call('POST', '/sources', dana.id, {
          name,
          kind: 'static',
          baseUrl: `static:${set}`,
          authMode: 'service',
          freshnessWindowMs: 0,
          collectionIds: [c.id],
        })
      ).json;
    const benefits = await mk('Benefits Admin', 'benefits');
    const claims = await mk('Claims', 'claims');

    const page = (await call('POST', '/pages', marc.id, { collectionId: c.id, type: 'note', title: 'Benefits' })).json;
    await call('PUT', `/pages/${page.id}/draft`, marc.id, { body: 'See below.', fields: { ownerId: marc.id } });
    await call('POST', `/pages/${page.id}/publish`, marc.id, {});

    await call('POST', `/pages/${page.id}/references`, marc.id, {
      sourceId: benefits.id,
      selector: 'deductible',
      key: 'PLAN-7',
      label: 'Plan deductible',
    });
    // Two authorities is a 409 over the wire, with the sentence that says why.
    const clash = await call('POST', `/pages/${page.id}/references`, marc.id, {
      sourceId: claims.id,
      selector: 'deductible',
      key: 'PLAN-7',
    });
    assert.equal(clash.status, 409);
    assert.match(clash.json.message, /contradiction in the model/);

    const corroborating = (
      await call('POST', `/pages/${page.id}/references`, marc.id, {
        sourceId: claims.id,
        selector: 'deductible',
        key: 'PLAN-7',
        role: 'corroborating',
      })
    ).json;
    assert.equal(corroborating.role, 'corroborating');

    // The descriptors inside the page payload carry the role, so the UI knows
    // which value is the record's before it resolves anything.
    const fetched = (await call('GET', `/pages/${page.id}`, marc.id)).json;
    assert.deepEqual(fetched.references.map((r: any) => r.role), ['authority', 'corroborating']);

    // Resolution: the authority displays, the copy is beside it, both marked.
    const resolved = (await call('GET', `/pages/${page.id}/references`, marc.id)).json;
    assert.equal(resolved.length, 2);
    const authority = resolved.find((r: any) => r.role === 'authority');
    const other = resolved.find((r: any) => r.role === 'corroborating');
    assert.equal(authority.value, 1500);
    assert.equal(other.value, 1200);
    assert.equal(authority.divergence.side, 'authority');
    assert.equal(other.divergence.side, 'corroborating');
    assert.equal(other.divergence.open[0].authorityValue, 1500);
    assert.equal(other.divergence.open[0].otherValue, 1200);

    const onPage = (await call('GET', `/pages/${page.id}/divergences`, marc.id)).json;
    assert.equal(onPage.length, 1);
    const id = onPage[0].id;
    assert.equal((await call('GET', '/divergences?state=open', marc.id)).json.length, 1);
    assert.equal((await call('GET', '/divergences?state=closed', marc.id)).json.length, 0);
    assert.equal((await call('GET', `/divergences?collection=${c.id}`, marc.id)).json.length, 1);
    assert.equal((await call('GET', `/divergences/${id}`, marc.id)).json.pageId, page.id);

    // Closing: the reason is required, and then it is kept.
    const bare = await call('POST', `/divergences/${id}/close`, marc.id, {});
    assert.equal(bare.status, 400);
    assert.match(bare.json.message, /requires a reason/);
    const closed = await call('POST', `/divergences/${id}/close`, marc.id, {
      reason: 'Claims was caching a stale copy; retired.',
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.state, 'closed');
    assert.equal(closed.json.closedBy, marc.id);
    assert.equal((await call('POST', `/divergences/${id}/close`, marc.id, { reason: 'twice' })).status, 422);

    // The closure is kept, and it does not silence the next observation: the
    // two systems still disagree, so the next read opens a NEW divergence and
    // the settled one stays beside it as history. Closing is a decision about
    // what was true, never a mute button.
    const after = (await call('GET', `/pages/${page.id}/references`, marc.id)).json;
    const reopened = after.find((r: any) => r.role === 'corroborating').divergence;
    assert.equal(reopened.open.length, 1);
    assert.notEqual(reopened.open[0].id, id, 'a new record, not the closed one reopened');
    assert.equal((await call('GET', '/divergences?state=closed', marc.id)).json.length, 1);
    assert.equal((await call('GET', '/divergences?state=open', marc.id)).json.length, 1);
    assert.equal((await call('GET', `/pages/${page.id}/divergences`, marc.id)).json.length, 2);
  } finally {
    server.close();
  }
});

test('API: an agent may read a divergence and may not close one', async () => {
  const registry = new RegistryStore();
  const registryServer = createRegistryApi(registry);
  await new Promise<void>((resolve) => registryServer.listen(0, resolve));
  const registryUrl = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;

  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const auth = new AgentAuth({
    db,
    store,
    registry: new RegistryClient({ baseUrl: registryUrl, cacheTtlMs: 0, requestTimeoutMs: 500 }),
  });
  const server = createApi(store, auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, who: { actor?: string; passport?: string }, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(who.actor ? { 'x-actor-id': who.actor } : {}),
        ...(who.passport ? { 'x-agent-passport': who.passport } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = (await call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    // The `agent.denied` event for a refused ROUTE names no collection, and a
    // collection-less event reaches an operator of this Canon (orgrole.ts).
    setHandOrgRole(db, dana.id, 'operator', null);
    const collection = (await call('POST', '/collections', { actor: dana.id }, { name: 'Benefits' })).json;
    const benefits = makeSource(store, dana.id, collection.id, 'Benefits Admin', 'benefits', {
      deductible: { 'PLAN-7': 1500 },
    });
    const claims = makeSource(store, dana.id, collection.id, 'Claims', 'claims', { deductible: { 'PLAN-7': 1200 } });
    const page = ownedPage(store, dana.id, collection.id, 'Benefits policy', dana.id);
    store.addReference(dana.id, page.id, { sourceId: benefits.id, selector: 'deductible', key: 'PLAN-7' });
    store.addReference(dana.id, page.id, {
      sourceId: claims.id,
      selector: 'deductible',
      key: 'PLAN-7',
      role: 'corroborating',
    });

    // An agent permitted the collection but only ONE of the two sources: the
    // corroborating value never arrives, so there is nothing to disagree with
    // and no divergence is opened. An outage of governance is not a
    // contradiction any more than an outage of network is.
    const bot = registry.register({ name: 'Benefits Assistant' });
    registry.certify(bot.agentId);
    registry.setPermissions(bot.agentId, {
      permittedCollections: [collection.id],
      permittedSources: [benefits.id],
      permittedActions: ['read'],
    });
    await call('GET', `/pages/${page.id}`, { passport: bot.passport }); // provisions the actor
    const botActor = store.listActors().find((a) => a.kind === 'agent')!;
    store.setMember(dana.id, collection.id, botActor.id, 'edit');

    const resolved = await call('GET', `/pages/${page.id}/references`, { passport: bot.passport });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.length, 2, 'a refused reference is data, not an omission');
    const refused = resolved.json.find((r: any) => r.sourceId === claims.id);
    assert.equal(refused.value, null);
    assert.ok(refused.error);
    assert.deepEqual(
      store.listPageDivergences(dana.id, page.id),
      [],
      'a value the Registry withheld is unknown, not disagreeing',
    );

    // Now a person reads the same page, both sources answer, and the
    // divergence is opened.
    await store.resolveReferences(dana.id, page.id);
    const [divergence] = store.listPageDivergences(dana.id, page.id);
    assert.ok(divergence);

    // The agent may READ it: it is a fact about a page it may read.
    const read = await call('GET', `/pages/${page.id}/divergences`, { passport: bot.passport });
    assert.equal(read.status, 200);
    assert.equal(read.json.length, 1);
    assert.equal((await call('GET', `/divergences/${divergence.id}`, { passport: bot.passport })).status, 200);
    assert.equal((await call('GET', '/divergences', { passport: bot.passport })).json.length, 1);

    // And may NOT close it: the route is absent from agentauth's table, so the
    // refusal happens at the door and is audited as agent.denied.
    const denied = await call('POST', `/divergences/${divergence.id}/close`, { passport: bot.passport }, {
      reason: 'The copy drifted',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'forbidden');
    assert.equal(denied.json.reason, 'route_not_available_to_agents');
    assert.equal(store.listPageDivergences(dana.id, page.id)[0]!.state, 'open');
    const denials = store.queryAudit(dana.id, { action: 'agent.denied' });
    assert.ok(denials.some((e) => e.details.reason === 'route' && String(e.details.path).includes('/close')));
  } finally {
    server.close();
    registryServer.close();
  }
});
