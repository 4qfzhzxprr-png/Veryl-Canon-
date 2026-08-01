// Page relations (DATA-BACKBONE.md §7, "Two pages contradict each other"):
// the explicit `conflicts with` / `supersedes` edge between two pages that
// makes contradiction something the knowledge map draws rather than something
// discovered during an audit.
//
// The invariants these tests exist to hold:
//   * asserting takes `edit` on BOTH pages' collections — a relation is a
//     statement about two pages, and standing over one of them is not enough;
//   * `conflicts_with` without a note is not an assertion anybody can settle;
//   * `conflicts_with` is ONE row, canonically ordered, readable from either
//     end and un-assertable twice in either direction;
//   * an agent may not assert one — refused at the door and again in the
//     service — and the loop it does have is the proposal loop;
//   * the map draws both kinds, permission-filtered like every other edge,
//     with an edge to an invisible page dropped rather than drawn;
//   * both acts are on the record: `relation.assert`, `relation.remove`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { GRAPH_EDGE_KINDS } from '../src/graph.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { RegistryClient } from '../src/registry.js';
import { RELATION_KINDS, relationPair } from '../src/relations.js';
import { CanonStore } from '../src/store.js';

const quiet: NotificationTransport = { deliver() {} };

function setup() {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const bot = store.createActor({ kind: 'agent', name: 'Freshness Agent', registryRef: 'passport:fresh-1' });
  // Two collections, because the interesting relation crosses one.
  const compliance = store.createCollection(dana.id, { name: 'Compliance' });
  const engineering = store.createCollection(dana.id, { name: 'Engineering' });
  store.setMember(dana.id, compliance.id, marc.id, 'edit');
  store.setMember(dana.id, compliance.id, vera.id, 'view');
  store.setMember(dana.id, compliance.id, bot.id, 'edit');
  store.setMember(dana.id, engineering.id, vera.id, 'view');
  return { store, dana, marc, vera, bot, compliance, engineering };
}

/** A published Note, which needs no owner or approver, so tests stay short. */
function note(store: CanonStore, actorId: string, collectionId: string, title: string, body = 'Body.'): string {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body });
  store.publish(actorId, page.id, {});
  return page.id;
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

function auditActions(store: CanonStore, actorId: string): string[] {
  return store.queryAudit(actorId, { limit: 500 }).map((e) => e.action);
}

// ---------------------------------------------------------------------------
// The shape

test('a relation is one of exactly two kinds, between two different pages', () => {
  const { store, dana, compliance } = setup();
  const a = note(store, dana.id, compliance.id, 'Retention schedule');
  const b = note(store, dana.id, compliance.id, 'Retention in the platform');

  assert.deepEqual([...RELATION_KINDS], ['conflicts_with', 'supersedes']);
  expectCode(() => store.assertRelation(dana.id, a, { toPageId: b, kind: 'related_to' as never }), 'invalid');
  expectCode(() => store.assertRelation(dana.id, a, { toPageId: a, kind: 'supersedes' }), 'invalid');
  expectCode(() => store.assertRelation(dana.id, a, { toPageId: '', kind: 'supersedes' }), 'invalid');
  expectCode(() => store.assertRelation(dana.id, a, { toPageId: 'nope', kind: 'supersedes' }), 'not_found');
});

test('conflicts_with requires a note; supersedes does not', () => {
  const { store, dana, compliance } = setup();
  const a = note(store, dana.id, compliance.id, 'A');
  const b = note(store, dana.id, compliance.id, 'B');
  const c = note(store, dana.id, compliance.id, 'C');

  // An unexplained assertion that two policies conflict is not much use to
  // whoever has to settle it.
  const err = expectCode(() => store.assertRelation(dana.id, a, { toPageId: b, kind: 'conflicts_with' }), 'invalid');
  assert.match(err.message, /note/i);
  expectCode(
    () => store.assertRelation(dana.id, a, { toPageId: b, kind: 'conflicts_with', note: '   ' }),
    'invalid',
  );

  const conflict = store.assertRelation(dana.id, a, {
    toPageId: b,
    kind: 'conflicts_with',
    note: 'One says seven years, the other twenty-four months.',
  });
  assert.equal(conflict.note, 'One says seven years, the other twenty-four months.');

  // The claim "this replaced that" explains itself.
  const supersede = store.assertRelation(dana.id, a, { toPageId: c, kind: 'supersedes' });
  assert.equal(supersede.note, null);
  assert.equal(supersede.reads, 'supersedes');
});

test('conflicts_with is stored once, canonically ordered, and reads from both ends', () => {
  const { store, dana, compliance } = setup();
  const a = note(store, dana.id, compliance.id, 'A');
  const b = note(store, dana.id, compliance.id, 'B');
  const [low, high] = relationPair('conflicts_with', a, b);
  assert.ok(low < high || low === high);

  // Asserted from B, stored in the canonical order — a symmetric fact is one
  // fact, so it is one row whichever end asserts it.
  const asserted = store.assertRelation(dana.id, b, {
    toPageId: a,
    kind: 'conflicts_with',
    note: 'They give different numbers for the same thing.',
  });
  assert.equal(asserted.fromPageId, low);
  assert.equal(asserted.toPageId, high);
  // ...and it reads correctly from the page it was asserted from.
  assert.equal(asserted.pageId, b);
  assert.equal(asserted.other.id, a);
  assert.equal(asserted.reads, 'conflicts_with');

  // Both ends list it, once, naming the other page.
  const fromA = store.listRelations(dana.id, a);
  const fromB = store.listRelations(dana.id, b);
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.equal(fromA[0]!.id, fromB[0]!.id);
  assert.equal(fromA[0]!.other.id, b);
  assert.equal(fromB[0]!.other.id, a);
  assert.equal(fromA[0]!.other.title, 'B');

  // And it cannot be asserted twice, in either direction: the canonical order
  // is exactly what lets the UNIQUE constraint see the second one.
  expectCode(
    () => store.assertRelation(dana.id, a, { toPageId: b, kind: 'conflicts_with', note: 'again' }),
    'conflict',
  );
  expectCode(
    () => store.assertRelation(dana.id, b, { toPageId: a, kind: 'conflicts_with', note: 'again' }),
    'conflict',
  );
  assert.equal(store.listRelations(dana.id, a).length, 1);
});

test('supersedes is directed: it reads as superseded by from the other end, and the inverse is refused', () => {
  const { store, dana, compliance } = setup();
  const newer = note(store, dana.id, compliance.id, 'Incident Management');
  const older = note(store, dana.id, compliance.id, 'On-call Runbook');

  const relation = store.assertRelation(dana.id, newer, {
    toPageId: older,
    kind: 'supersedes',
    note: 'Escalation moved into the reviewed spec.',
  });
  assert.equal(relation.fromPageId, newer);
  assert.equal(relation.toPageId, older);

  assert.equal(store.listRelations(dana.id, newer)[0]!.reads, 'supersedes');
  assert.equal(store.listRelations(dana.id, older)[0]!.reads, 'superseded_by');
  assert.equal(store.listRelations(dana.id, older)[0]!.other.title, 'Incident Management');

  // B cannot supersede A while A supersedes B. Canon refuses the second rather
  // than picking one; the person withdraws the first if the record changed its
  // mind. Asserting it again in the same direction is an ordinary duplicate.
  expectCode(() => store.assertRelation(dana.id, older, { toPageId: newer, kind: 'supersedes' }), 'conflict');
  expectCode(() => store.assertRelation(dana.id, newer, { toPageId: older, kind: 'supersedes' }), 'conflict');

  // Superseding changes nothing about the superseded page: Canon surfaces
  // contradiction, it does not resolve it. (A published Note is Draft — the
  // Canonical mark is for reviewed types — and it stays exactly that.)
  assert.equal(store.getPage(dana.id, older).status, 'draft');
  assert.equal(store.getPage(dana.id, older).currentVersion, 1);
});

test('an archived page is read-only at either end of a relation', () => {
  const { store, dana, compliance } = setup();
  const live = note(store, dana.id, compliance.id, 'Live');
  const gone = note(store, dana.id, compliance.id, 'Gone');
  store.archivePage(dana.id, gone);
  expectCode(() => store.assertRelation(dana.id, live, { toPageId: gone, kind: 'supersedes' }), 'workflow');
  expectCode(() => store.assertRelation(dana.id, gone, { toPageId: live, kind: 'supersedes' }), 'workflow');
});

// ---------------------------------------------------------------------------
// Permissions, on both ends

test('asserting takes edit on BOTH pages collections, and so does withdrawing', () => {
  const { store, dana, marc, vera, compliance, engineering } = setup();
  const policy = note(store, dana.id, compliance.id, 'Records Retention Schedule');
  const spec = note(store, dana.id, engineering.id, 'Data Retention in the Platform');

  // Marc edits Compliance and is not a member of Engineering at all: he may
  // not write a claim onto a page he has no standing over.
  const far = expectCode(
    () =>
      store.assertRelation(marc.id, policy, {
        toPageId: spec,
        kind: 'conflicts_with',
        note: 'Seven years against twenty-four months.',
      }),
    'forbidden',
  );
  assert.equal(far.details.collectionId, engineering.id);
  assert.equal(far.details.needed, 'edit');

  // And the near end is checked too: view is not edit.
  store.setMember(dana.id, engineering.id, marc.id, 'edit');
  store.setMember(dana.id, compliance.id, marc.id, 'view');
  const near = expectCode(
    () =>
      store.assertRelation(marc.id, policy, {
        toPageId: spec,
        kind: 'conflicts_with',
        note: 'Seven years against twenty-four months.',
      }),
    'forbidden',
  );
  assert.equal(near.details.collectionId, compliance.id);

  // Vera views both and may assert nothing.
  expectCode(() => store.assertRelation(vera.id, policy, { toPageId: spec, kind: 'supersedes' }), 'forbidden');

  const relation = store.assertRelation(dana.id, policy, {
    toPageId: spec,
    kind: 'conflicts_with',
    note: 'Seven years against twenty-four months.',
  });
  // Withdrawing takes the same standing making it took, on both ends.
  expectCode(() => store.removeRelation(vera.id, relation.id), 'forbidden');
  store.setMember(dana.id, compliance.id, marc.id, 'edit'); // Marc now edits both
  store.removeRelation(marc.id, relation.id);
  assert.equal(store.listRelations(dana.id, policy).length, 0);
});

test('a relation whose other end the asker cannot see is absent, never a placeholder', () => {
  const { store, dana, marc, compliance, engineering } = setup();
  const policy = note(store, dana.id, compliance.id, 'Records Retention Schedule');
  const spec = note(store, dana.id, engineering.id, 'Data Retention in the Platform');
  const sibling = note(store, dana.id, compliance.id, 'Retention periods');
  store.assertRelation(dana.id, policy, {
    toPageId: spec,
    kind: 'conflicts_with',
    note: 'Seven years against twenty-four months.',
  });
  store.assertRelation(dana.id, policy, {
    toPageId: sibling,
    kind: 'conflicts_with',
    note: 'The table and the schedule disagree.',
  });

  // Dana sees both collections and therefore both relations.
  assert.equal(store.listRelations(dana.id, policy).length, 2);

  // Marc is not a member of Engineering: the relation reaching it is not in
  // his answer at all — no id, no title, no marker that something is hidden.
  const marcSees = store.listRelations(marc.id, policy);
  assert.equal(marcSees.length, 1);
  assert.equal(marcSees[0]!.other.id, sibling);
  assert.equal(JSON.stringify(marcSees).includes(spec), false);

  // Reading the far page itself is refused outright, as it always was.
  expectCode(() => store.listRelations(marc.id, spec), 'forbidden');
});

// ---------------------------------------------------------------------------
// Agents

test('an agent may not assert or withdraw a relation, whatever Canon grants it', () => {
  const { store, dana, bot, compliance } = setup();
  const a = note(store, dana.id, compliance.id, 'A');
  const b = note(store, dana.id, compliance.id, 'B');

  // The agent holds `edit` on this collection — the same grant that lets it
  // propose — and it still cannot assert that two pages contradict.
  const refused = expectCode(
    () => store.assertRelation(bot.id, a, { toPageId: b, kind: 'conflicts_with', note: 'They differ.' }),
    'forbidden',
  );
  assert.equal(refused.details.reason, 'relation_is_a_persons_act');
  assert.match(refused.message, /proposes/);

  const relation = store.assertRelation(dana.id, a, { toPageId: b, kind: 'conflicts_with', note: 'They differ.' });
  expectCode(() => store.removeRelation(bot.id, relation.id), 'forbidden');

  // Reading is an ordinary read of the record, and an agent that may read the
  // page may see that the record holds this about it — which is what makes it
  // able to raise the proposal a person then settles.
  assert.equal(store.listRelations(bot.id, a).length, 1);
});

// ---------------------------------------------------------------------------
// The map

test('the map draws both relation kinds, in the collection view and the record view', () => {
  const { store, dana, compliance, engineering } = setup();
  const policy = note(store, dana.id, compliance.id, 'Records Retention Schedule');
  const sibling = note(store, dana.id, compliance.id, 'Retention periods');
  const spec = note(store, dana.id, engineering.id, 'Data Retention in the Platform');

  assert.deepEqual([...GRAPH_EDGE_KINDS], ['child', 'link', 'reference', 'conflicts_with', 'supersedes']);

  store.assertRelation(dana.id, policy, {
    toPageId: sibling,
    kind: 'conflicts_with',
    note: 'The table and the schedule disagree.',
  });
  store.assertRelation(dana.id, policy, { toPageId: spec, kind: 'supersedes' });

  const map = store.collectionGraph(dana.id, compliance.id);
  const conflict = map.edges.find((e) => e.kind === 'conflicts_with');
  const supersedes = map.edges.find((e) => e.kind === 'supersedes');
  assert.ok(conflict, 'the conflict is on the map');
  assert.ok(supersedes, 'the supersession is on the map');
  // The far end of the cross-collection relation is pulled onto the map as an
  // external node, exactly as a link's target is: a contradiction that crosses
  // a boundary is the one most worth drawing.
  assert.equal(supersedes!.to, spec);
  const external = map.nodes.find((n) => n.id === spec);
  assert.ok(external && external.kind === 'page' && external.external);

  // The record view draws them too, between the same two pages.
  const record = store.recordGraph(dana.id);
  assert.equal(record.edges.filter((e) => e.kind === 'conflicts_with').length, 1);
  assert.equal(record.edges.filter((e) => e.kind === 'supersedes').length, 1);
  // A relation counts towards how connected a page is, because it is an edge
  // of the record like any other.
  const node = record.nodes.find((n) => n.id === policy)!;
  assert.equal(node.degree, 2);
});

test('a relation edge to a page the viewer cannot see is dropped, not drawn to a placeholder', () => {
  const { store, dana, marc, compliance, engineering } = setup();
  const policy = note(store, dana.id, compliance.id, 'Records Retention Schedule');
  const spec = note(store, dana.id, engineering.id, 'Data Retention in the Platform');
  store.assertRelation(dana.id, policy, {
    toPageId: spec,
    kind: 'conflicts_with',
    note: 'Seven years against twenty-four months.',
  });

  // Dana sees both ends, so the edge is drawn.
  assert.equal(store.collectionGraph(dana.id, compliance.id).edges.some((e) => e.kind === 'conflicts_with'), true);

  // Marc is not in Engineering. The far page is not a node, so the edge cannot
  // exist — and nothing stands in for it.
  const marcMap = store.collectionGraph(marc.id, compliance.id);
  assert.equal(marcMap.nodes.some((n) => n.id === spec), false);
  assert.equal(marcMap.edges.some((e) => e.kind === 'conflicts_with'), false);
  assert.equal(marcMap.edges.some((e) => e.to === spec || e.from === spec), false);

  const marcRecord = store.recordGraph(marc.id);
  assert.equal(marcRecord.edges.some((e) => e.kind === 'conflicts_with'), false);
  assert.equal(marcRecord.nodes.some((n) => n.id === spec), false);
});

test('an archived page leaves the map, and its relations leave with it', () => {
  const { store, dana, compliance } = setup();
  const a = note(store, dana.id, compliance.id, 'A');
  const b = note(store, dana.id, compliance.id, 'B');
  store.assertRelation(dana.id, a, { toPageId: b, kind: 'conflicts_with', note: 'They differ.' });
  assert.equal(store.collectionGraph(dana.id, compliance.id).edges.filter((e) => e.kind === 'conflicts_with').length, 1);
  store.archivePage(dana.id, b);
  const map = store.collectionGraph(dana.id, compliance.id);
  assert.equal(map.nodes.some((n) => n.id === b), false);
  assert.equal(map.edges.some((e) => e.kind === 'conflicts_with'), false);
  // The relation is still in the record, and the page that remains still says so.
  assert.equal(store.listRelations(dana.id, a).length, 1);
});

// ---------------------------------------------------------------------------
// The audit log

test('asserting and withdrawing are both on the record, with both ends and the note', () => {
  const { store, dana, compliance, engineering } = setup();
  const policy = note(store, dana.id, compliance.id, 'Records Retention Schedule');
  const spec = note(store, dana.id, engineering.id, 'Data Retention in the Platform');
  const relation = store.assertRelation(dana.id, policy, {
    toPageId: spec,
    kind: 'conflicts_with',
    note: 'Seven years against twenty-four months.',
  });

  const asserted = store.queryAudit(dana.id, { action: 'relation.assert', limit: 10 });
  assert.equal(asserted.length, 1);
  assert.equal(asserted[0]!.actorId, dana.id);
  assert.equal(asserted[0]!.pageId, policy);
  assert.equal(asserted[0]!.collectionId, compliance.id);
  assert.equal(asserted[0]!.details.relationId, relation.id);
  assert.equal(asserted[0]!.details.kind, 'conflicts_with');
  assert.equal(asserted[0]!.details.note, 'Seven years against twenty-four months.');
  assert.equal(asserted[0]!.details.toCollectionId, engineering.id);
  assert.deepEqual(
    [asserted[0]!.details.fromPageId, asserted[0]!.details.toPageId].sort(),
    [policy, spec].sort(),
  );

  store.removeRelation(dana.id, relation.id);
  const removed = store.queryAudit(dana.id, { action: 'relation.remove', limit: 10 });
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.details.relationId, relation.id);
  assert.equal(removed[0]!.details.assertedBy, dana.id);
  assert.ok(auditActions(store, dana.id).includes('relation.assert'));
});

// ---------------------------------------------------------------------------
// Over HTTP, including the agent door

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

test('API: relations round-trip, and an agent is refused at the door', async () => {
  const r = await rig();
  try {
    const dana = (await r.call('POST', '/actors', {}, { kind: 'person', name: 'Dana' })).json;
    r.store.bootstrapAdministrator(dana.id);
    const collection = (await r.call('POST', '/collections', { actor: dana.id }, { name: 'Compliance' })).json;
    const mk = async (title: string) => {
      const page = (
        await r.call('POST', '/pages', { actor: dana.id }, { collectionId: collection.id, type: 'note', title })
      ).json;
      await r.call('PUT', `/pages/${page.id}/draft`, { actor: dana.id }, { body: `${title} body.` });
      await r.call('POST', `/pages/${page.id}/publish`, { actor: dana.id }, {});
      return page.id as string;
    };
    const a = await mk('Records Retention Schedule');
    const b = await mk('Data Retention in the Platform');

    // The note is required over HTTP too.
    const unexplained = await r.call(
      'POST',
      `/pages/${a}/relations`,
      { actor: dana.id },
      { toPageId: b, kind: 'conflicts_with' },
    );
    assert.equal(unexplained.status, 400);

    const created = await r.call(
      'POST',
      `/pages/${a}/relations`,
      { actor: dana.id },
      { toPageId: b, kind: 'conflicts_with', note: 'Seven years against twenty-four months.' },
    );
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.kind, 'conflicts_with');
    assert.equal(created.json.other.id, b);

    const listed = await r.call('GET', `/pages/${b}/relations`, { actor: dana.id });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.length, 1);
    assert.equal(listed.json[0].other.id, a);
    assert.equal(listed.json[0].reads, 'conflicts_with');

    // The agent door. The Registry grants everything it can grant; the routes
    // are still not in agentauth's table, so they are not available at all.
    const bot = r.registry.register({
      name: 'Freshness Agent',
      permittedCollections: ['*'],
      permittedActions: ['read', 'comment', 'write'],
    });
    r.registry.certify(bot.agentId);
    await r.call('GET', '/collections', { passport: bot.passport });
    const agent = ((await r.call('GET', '/actors', { actor: dana.id })).json as any[]).find(
      (x) => x.kind === 'agent',
    );
    await r.call('PUT', `/collections/${collection.id}/members/${agent.id}`, { actor: dana.id }, { role: 'admin' });

    const botAssert = await r.call(
      'POST',
      `/pages/${a}/relations`,
      { passport: bot.passport },
      { toPageId: b, kind: 'supersedes' },
    );
    assert.equal(botAssert.status, 403);
    assert.equal(botAssert.json.reason, 'route_not_available_to_agents');

    const botRemove = await r.call('DELETE', `/relations/${created.json.id}`, { passport: bot.passport });
    assert.equal(botRemove.status, 403);
    assert.equal(botRemove.json.reason, 'route_not_available_to_agents');

    // Reading them is `read`, and is available.
    const botRead = await r.call('GET', `/pages/${a}/relations`, { passport: bot.passport });
    assert.equal(botRead.status, 200);
    assert.equal(botRead.json.length, 1);

    // The refusals are on the record as denials.
    const denied = r.store.queryAudit(dana.id, { action: 'agent.denied', limit: 20 });
    assert.equal(denied.filter((e) => e.details.reason === 'route').length, 2);

    const gone = await r.call('DELETE', `/relations/${created.json.id}`, { actor: dana.id });
    assert.equal(gone.status, 200);
    assert.equal((await r.call('GET', `/pages/${a}/relations`, { actor: dana.id })).json.length, 0);
  } finally {
    r.close();
  }
});
