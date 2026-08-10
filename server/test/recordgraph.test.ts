import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRegistryApi } from '../../registry-stub/src/api.js';
import { RegistryStore } from '../../registry-stub/src/store.js';
import { AgentAuth } from '../src/agentauth.js';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { RegistryClient } from '../src/registry.js';
import { CanonStore } from '../src/store.js';
import { staticConnectorOf } from '../src/connectors.js';
import type { NotificationTransport } from '../src/notify.js';
import { KnowledgeGraph, MAX_RECORD_GRAPH_NODES, RecordGraph, RecordGraphNode } from '../src/graph.js';

// The whole-record map (GET /graph): the same explicit graph as
// src/graph.ts's per-collection view, drawn across every collection the asker
// may see. Three properties carry it, and each has its own tests below:
//
//   - a CROSS-COLLECTION LINK is the thing this view exists for, and it is
//     drawn only when the asker may see BOTH of its ends;
//   - `degree` and `rootId` describe the FILTERED graph — the nodes that
//     survived permission and the cap — so hiding a collection makes a degree
//     fall rather than leaving a number about a graph nobody can see;
//   - the cap is reported. A quietly short map is a picture of a record with
//     pages missing and no sign that any are.

const quiet: NotificationTransport = { deliver() {} };

function findFixtures(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'test', 'fixtures');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('test fixtures not found above the compiled test file');
}
const CONFLUENCE = join(findFixtures(), 'confluence-space');

/** Dana sees everything; Marc is kept out of one collection on purpose. */
function setup() {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const compliance = store.createCollection(dana.id, { name: 'Compliance' });
  const product = store.createCollection(dana.id, { name: 'Product' });
  const board = store.createCollection(dana.id, { name: 'Board' });
  store.setMember(dana.id, compliance.id, marc.id, 'admin');
  store.setMember(dana.id, product.id, marc.id, 'edit');
  // Marc is deliberately NOT a member of Board.
  return { store, dana, marc, outsider, compliance, product, board };
}

function note(
  store: CanonStore,
  actorId: string,
  collectionId: string,
  title: string,
  opts: { parentId?: string | null; body?: string } = {},
): string {
  const page = store.createPage(actorId, {
    collectionId,
    parentId: opts.parentId ?? null,
    type: 'note',
    title,
  });
  store.editDraft(actorId, page.id, { body: opts.body ?? `${title} body.` });
  store.publish(actorId, page.id, {});
  return page.id;
}

function nodeFor(graph: RecordGraph, id: string): RecordGraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  assert.ok(node, `no node for ${id}`);
  return node;
}

function edgesOf(graph: RecordGraph, kind: string): string[] {
  return graph.edges.filter((e) => e.kind === kind).map((e) => `${e.from}->${e.to}`);
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

// ---- the record, several collections at once ------------------------------

test('record: every collection the asker may view, drawn together', () => {
  const { store, dana, compliance, product, board } = setup();
  const policy = note(store, dana.id, compliance.id, 'Retention policy');
  const procedure = note(store, dana.id, compliance.id, 'Retention procedure', { parentId: policy });
  const spec = note(store, dana.id, product.id, 'Export API');
  const minutes = note(store, dana.id, board.id, 'Board minutes');

  const graph = store.recordGraph(dana.id);

  assert.deepEqual(
    graph.collections.map((c) => c.name),
    ['Board', 'Compliance', 'Product'],
    'collections are named, and in a stable order',
  );
  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    [policy, procedure, spec, minutes].sort(),
    'every page of every visible collection is a node',
  );
  assert.deepEqual(edgesOf(graph, 'child'), [`${policy}->${procedure}`]);
  assert.equal(nodeFor(graph, spec).collectionId, product.id);
  assert.equal(graph.truncated, undefined, 'nothing was cut, so nothing is claimed to have been');
});

test('record: `?collection=` narrows the record view to the collections named', () => {
  const { store, dana, compliance, product } = setup();
  const policy = note(store, dana.id, compliance.id, 'Retention policy');
  note(store, dana.id, product.id, 'Export API');

  const graph = store.recordGraph(dana.id, { collectionIds: [compliance.id] });
  assert.deepEqual(graph.collections.map((c) => c.id), [compliance.id]);
  assert.deepEqual(graph.nodes.map((n) => n.id), [policy]);
});

test('record: the map is deterministic — the same record draws the same way twice', () => {
  const { store, dana, compliance, product } = setup();
  const a = note(store, dana.id, compliance.id, 'Alpha');
  const b = note(store, dana.id, compliance.id, 'Beta', { parentId: a });
  note(store, dana.id, product.id, 'Gamma', { body: `See /pages/${b}` });
  assert.deepEqual(store.recordGraph(dana.id), store.recordGraph(dana.id));
});

test('record: an empty record is an empty graph, not an error', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const solo = store.createActor({ kind: 'person', name: 'Solo' });
  const graph = store.recordGraph(solo.id);
  assert.deepEqual(graph, { collections: [], nodes: [], edges: [] });
});

test('record: an unknown asker is not found, and a spanning read is never refused', () => {
  const { store, outsider, board } = setup();
  expectCode(() => store.recordGraph('no-such-actor'), 'not_found');
  // The outsider is a member of nothing. The answer is an empty record, not a
  // 403: this is a read across whatever the asker may see, and what they may
  // see is nothing.
  assert.deepEqual(store.recordGraph(outsider.id).nodes, []);
  // And naming a collection they cannot see narrows the answer rather than
  // refusing it (REGISTRY-CONTRACT.md §4.2's rule, applied to people too).
  assert.deepEqual(store.recordGraph(outsider.id, { collectionIds: [board.id] }).collections, []);
});

// ---- permissions ----------------------------------------------------------

test('record: a collection the asker cannot see contributes neither nodes nor edges', () => {
  const { store, dana, marc, compliance, board } = setup();
  const handbook = note(store, dana.id, compliance.id, 'Handbook');
  const secret = note(store, dana.id, board.id, 'Board minutes');
  note(store, dana.id, board.id, 'Board pack', { parentId: secret });

  const danas = store.recordGraph(dana.id);
  assert.equal(danas.collections.length, 3);
  assert.equal(danas.nodes.length, 3);

  const marcs = store.recordGraph(marc.id);
  assert.deepEqual(marcs.collections.map((c) => c.name), ['Compliance', 'Product']);
  assert.deepEqual(marcs.nodes.map((n) => n.id), [handbook]);
  assert.deepEqual(marcs.edges, [], 'the Board tree’s own child edge is not drawn either');
  assert.equal(
    JSON.stringify(marcs).includes('Board minutes'),
    false,
    'not even the title of a page he may not see',
  );
});

test('record: a cross-collection link is drawn when both ends are visible, and dropped when one is not', () => {
  const { store, dana, marc, compliance, board } = setup();
  const secret = note(store, dana.id, board.id, 'Board minutes');
  const handbook = store.createPage(marc.id, { collectionId: compliance.id, type: 'note', title: 'Handbook' });
  store.editDraft(marc.id, handbook.id, { body: `Background: /pages/${secret}` });
  store.publish(marc.id, handbook.id, {});

  // Dana sees both ends, so the edge crosses the collection boundary — which
  // is the whole reason this view exists.
  const danas = store.recordGraph(dana.id);
  assert.deepEqual(edgesOf(danas, 'link'), [`${handbook.id}->${secret}`]);
  assert.notEqual(
    nodeFor(danas, handbook.id).collectionId,
    nodeFor(danas, secret).collectionId,
    'the two ends really are in different collections',
  );

  // Marc sees the page that wrote the link, and no edge at all: the far end is
  // absent, so the edge is dropped rather than drawn to a placeholder.
  const marcs = store.recordGraph(marc.id);
  assert.ok(marcs.nodes.some((n) => n.id === handbook.id));
  assert.deepEqual(edgesOf(marcs, 'link'), []);
});

test('record: a link out of the SELECTED set is dropped, even when the asker can see both', () => {
  const { store, dana, compliance, product } = setup();
  const target = note(store, dana.id, product.id, 'Export API');
  const source = note(store, dana.id, compliance.id, 'Handbook', { body: `See /pages/${target}` });

  assert.deepEqual(edgesOf(store.recordGraph(dana.id), 'link'), [`${source}->${target}`]);
  const narrowed = store.recordGraph(dana.id, { collectionIds: [compliance.id] });
  assert.deepEqual(edgesOf(narrowed, 'link'), [], 'the record view never draws an edge to what it is not drawing');
});

// ---- degree, over the visible graph ---------------------------------------

test('record: `degree` counts the edges in THIS payload, so hiding a collection makes it fall', () => {
  const { store, dana, marc, compliance, product, board } = setup();
  const hub = store.createPage(marc.id, { collectionId: compliance.id, type: 'note', title: 'Hub' });
  const child = note(store, marc.id, compliance.id, 'Child', { parentId: hub.id });
  const sibling = note(store, marc.id, product.id, 'Product note');
  const secret = note(store, dana.id, board.id, 'Board minutes');
  store.editDraft(marc.id, hub.id, { body: `/pages/${child} /pages/${sibling} /pages/${secret}` });
  store.publish(marc.id, hub.id, {});

  // Dana: one child edge and three links (one of them to the child as well,
  // which is a second edge of a different kind between the same two pages).
  const danas = store.recordGraph(dana.id);
  assert.equal(nodeFor(danas, hub.id).degree, 4);
  assert.equal(nodeFor(danas, secret).degree, 1);

  // Marc cannot see Board, so the edge into it is not in his payload — and his
  // copy of the hub says so in its degree rather than reporting Dana's number.
  const marcs = store.recordGraph(marc.id);
  assert.equal(nodeFor(marcs, hub.id).degree, 3, 'the withheld neighbour is not counted');
  assert.equal(marcs.nodes.some((n) => n.id === secret), false);

  // And narrowing by hand does the same thing, for the same reason.
  const onlyCompliance = store.recordGraph(dana.id, { collectionIds: [compliance.id] });
  assert.equal(nodeFor(onlyCompliance, hub.id).degree, 2, 'one child edge and one link, both inside the selection');
});

// ---- rootId ---------------------------------------------------------------

test('record: `rootId` is the top-most ancestor, for a page three deep', () => {
  const { store, dana, compliance } = setup();
  const policy = note(store, dana.id, compliance.id, 'Retention policy');
  const procedure = note(store, dana.id, compliance.id, 'Retention procedure', { parentId: policy });
  const step = note(store, dana.id, compliance.id, 'Deleting a record', { parentId: procedure });
  const deeper = note(store, dana.id, compliance.id, 'Worked example', { parentId: step });

  const graph = store.recordGraph(dana.id);
  assert.equal(nodeFor(graph, policy).rootId, policy, 'a root is its own root');
  assert.equal(nodeFor(graph, procedure).rootId, policy);
  assert.equal(nodeFor(graph, step).rootId, policy);
  assert.equal(nodeFor(graph, deeper).rootId, policy, 'four deep still clusters onto the same root');
});

test('record: a page whose parent left the map is a root of it, exactly as it is of the tree', () => {
  const { store, dana, compliance } = setup();
  const policy = note(store, dana.id, compliance.id, 'Retention policy');
  const procedure = note(store, dana.id, compliance.id, 'Retention procedure', { parentId: policy });
  const step = note(store, dana.id, compliance.id, 'Deleting a record', { parentId: procedure });
  store.archivePage(dana.id, procedure);

  const graph = store.recordGraph(dana.id);
  assert.equal(graph.nodes.some((n) => n.id === procedure), false);
  assert.equal(nodeFor(graph, step).rootId, step, 'the highest VISIBLE ancestor is the page itself');
  assert.deepEqual(edgesOf(graph, 'child'), []);
});

// ---- provenance -----------------------------------------------------------

test('record: provenance is the same classification the per-collection map makes', () => {
  const { store, dana, marc, compliance } = setup();
  const authored = note(store, marc.id, compliance.id, 'Written in Canon');
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE,
    collectionId: compliance.id,
  });
  const overview = summary.files.find((f) => f.file === 'Benefits+Overview_65601.html');
  assert.ok(overview?.pageId);

  staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': 1500 } });
  const source = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 60_000,
    collectionIds: [compliance.id],
  });
  store.addReference(marc.id, authored, { sourceId: source.id, selector: 'deductible', key: 'PLAN-7' });

  const graph = store.recordGraph(dana.id);
  const imported = nodeFor(graph, overview.pageId);
  assert.equal(imported.provenance, 'imported');
  assert.equal(imported.importSource, 'confluence');
  assert.equal(imported.importFile, 'Benefits+Overview_65601.html');

  const federated = nodeFor(graph, authored);
  assert.equal(federated.provenance, 'federated');
  assert.equal(federated.importSource, undefined, 'a page written here names no import');

  const sourceNode = nodeFor(graph, source.id);
  assert.equal(sourceNode.kind, 'source');
  assert.equal(sourceNode.title, 'Benefits Admin');
  assert.equal(sourceNode.type, 'static');
  assert.equal(sourceNode.status, null, 'a source has no standing in the record');
  assert.equal(sourceNode.collectionId, null, 'and belongs to no one collection');
  assert.equal(sourceNode.rootId, source.id, 'so it clusters as itself');
  assert.deepEqual(edgesOf(graph, 'reference'), [`${authored}->${source.id}`]);
  assert.equal(sourceNode.degree, 1);

  // The two views agree, because they call the same classifier.
  const perCollection = store.collectionGraph(dana.id, compliance.id);
  const same = perCollection.nodes.find((n) => n.id === overview.pageId);
  assert.equal(same?.provenance, 'imported');
});

test('record: a source referenced only by a page the asker cannot see is not on their map', () => {
  const { store, dana, marc, board } = setup();
  staticConnectorOf(store.connectors).define('payroll', { salary: { 'BAND-1': 100 } });
  const source = store.createSource(dana.id, {
    name: 'Payroll',
    kind: 'static',
    baseUrl: 'static:payroll',
    authMode: 'service',
    freshnessWindowMs: 60_000,
    collectionIds: [board.id],
  });
  const secret = note(store, dana.id, board.id, 'Pay bands');
  store.addReference(dana.id, secret, { sourceId: source.id, selector: 'salary', key: 'BAND-1' });

  assert.equal(store.recordGraph(dana.id).nodes.some((n) => n.kind === 'source'), true);
  const marcs = store.recordGraph(marc.id);
  assert.equal(marcs.nodes.some((n) => n.kind === 'source'), false);
  assert.equal(JSON.stringify(marcs).includes('Payroll'), false);
});

// ---- the cap --------------------------------------------------------------

test('record: the cap is reported honestly, with the limit and the true total', () => {
  const { store, dana, compliance, product } = setup();
  for (let i = 0; i < 4; i += 1) note(store, dana.id, compliance.id, `Compliance page ${i}`);
  for (let i = 0; i < 3; i += 1) note(store, dana.id, product.id, `Product page ${i}`);

  const full = store.recordGraph(dana.id);
  assert.equal(full.nodes.length, 7);
  assert.equal(full.truncated, undefined);

  const capped = store.recordGraph(dana.id, { limit: 5 });
  assert.equal(capped.nodes.filter((n) => n.kind === 'page').length, 5);
  assert.deepEqual(capped.truncated, { limit: 5, total: 7 }, 'the total is the record’s, not the payload’s');
  assert.ok(MAX_RECORD_GRAPH_NODES > 5, 'and the default cap is far above anything a map is readable at');
});

// ---- the per-collection view is untouched ---------------------------------

test('record: GET /collections/:id/graph is unchanged — same payload, same rules', () => {
  const { store, dana, marc, compliance, board } = setup();
  const secret = note(store, dana.id, board.id, 'Board minutes');
  const handbook = note(store, marc.id, compliance.id, 'Handbook', { body: `See /pages/${secret}` });

  const perCollection: KnowledgeGraph = store.collectionGraph(dana.id, compliance.id);
  assert.equal(perCollection.collectionId, compliance.id);
  assert.equal(perCollection.counts.pages, 1);
  assert.equal(perCollection.counts.external, 1, 'it still follows the link OUT of the collection');
  assert.equal(perCollection.truncated, false);
  const neighbour = perCollection.nodes.find((n) => n.id === secret);
  assert.ok(neighbour && neighbour.kind === 'page');
  assert.equal(neighbour.external, true, 'and still marks the neighbour as external');
  assert.ok(perCollection.generatedAt);
  // A non-member is still refused there, which is the difference between a map
  // OF a collection and a map of the record. Holding no role, the refusal is a
  // not_found — the collection's identity is not disclosed by refusing it.
  expectCode(() => store.collectionGraph(marc.id, board.id), 'not_found');
  assert.ok(handbook);
});

// ---- the HTTP surface -----------------------------------------------------

test('API: GET /graph serves the record view, filters by ?collection, and needs an identity', async () => {
  const { store, dana, marc, compliance, product, board } = setup();
  const policy = note(store, dana.id, compliance.id, 'Retention policy');
  note(store, dana.id, compliance.id, 'Retention procedure', { parentId: policy });
  note(store, dana.id, product.id, 'Export API');
  note(store, dana.id, board.id, 'Board minutes');

  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/graph`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(res.status, 200);
    const graph = (await res.json()) as RecordGraph;
    assert.equal(graph.collections.length, 3);
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.kind, 'child');
    for (const node of graph.nodes) {
      assert.equal(typeof node.degree, 'number');
      assert.equal(typeof node.rootId, 'string');
    }

    const filtered = await fetch(`${base}/graph?collection=${compliance.id}&collection=${product.id}`, {
      headers: { 'x-actor-id': dana.id },
    });
    const two = (await filtered.json()) as RecordGraph;
    assert.deepEqual(two.collections.map((c) => c.name), ['Compliance', 'Product']);
    assert.equal(two.nodes.length, 3);

    // A member of two of the three sees two of the three, with no refusal.
    const marcs = await fetch(`${base}/graph`, { headers: { 'x-actor-id': marc.id } });
    assert.equal(marcs.status, 200);
    assert.equal(((await marcs.json()) as RecordGraph).collections.length, 2);

    const anonymous = await fetch(`${base}/graph`);
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
  }
});

test('agents: GET /graph is `read`, and a spanning read is NARROWED, never refused', async () => {
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
  const canon: Server = createApi(store, auth);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;
  const call = (path: string, passport: string) => fetch(base + path, { headers: { 'x-agent-passport': passport } });

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const mapped = store.createCollection(dana.id, { name: 'Compliance' });
    const barred = store.createCollection(dana.id, { name: 'Board' });
    const secret = note(store, dana.id, barred.id, 'Board minutes');
    const handbook = note(store, dana.id, mapped.id, 'Handbook', { body: `Background: /pages/${secret}` });

    const reader = registry.register({
      name: 'MapBot',
      permittedCollections: [mapped.id],
      permittedActions: ['read'],
    });
    registry.certify(reader.agentId);
    await call('/graph', reader.passport); // provisions the agent actor
    const agent = store.listActors().find((a) => a.kind === 'agent');
    assert.ok(agent);
    // Canon grants the agent BOTH collections; the Registry grants one. The
    // intersection is what the map draws.
    store.setMember(dana.id, mapped.id, agent.id, 'view');
    store.setMember(dana.id, barred.id, agent.id, 'view');

    const res = await call('/graph', reader.passport);
    assert.equal(res.status, 200, 'a spanning read is narrowed, not refused (REGISTRY-CONTRACT.md §4.2)');
    const graph = (await res.json()) as RecordGraph;
    assert.deepEqual(graph.collections.map((c) => c.id), [mapped.id]);
    assert.deepEqual(graph.nodes.map((n) => n.id), [handbook]);
    assert.deepEqual(graph.edges, [], 'the link into the withheld collection went with it');
    assert.equal(graph.nodes[0]?.degree, 0, 'and the degree it left behind was recomputed');
    assert.equal(JSON.stringify(graph).includes('Board minutes'), false);

    // A person holding the same Canon membership sees both, which proves the
    // narrowing above was the Registry's and not Canon's.
    assert.equal(store.recordGraph(dana.id).collections.length, 2);

    // `read` is still the action, and an unclassified route is still refused.
    const writer = registry.register({
      name: 'WriteBot',
      permittedCollections: ['*'],
      permittedActions: ['write'],
    });
    registry.certify(writer.agentId);
    assert.equal((await call('/graph', writer.passport)).status, 403);
  } finally {
    canon.close();
    registryServer.close();
  }
});

test('agents: a passport for every collection gets the whole record, unnarrowed', async () => {
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
  const canon: Server = createApi(store, auth);
  await new Promise<void>((resolve) => canon.listen(0, resolve));
  const base = `http://127.0.0.1:${(canon.address() as AddressInfo).port}`;

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const one = store.createCollection(dana.id, { name: 'Compliance' });
    const two = store.createCollection(dana.id, { name: 'Product' });
    const target = note(store, dana.id, two.id, 'Export API');
    note(store, dana.id, one.id, 'Handbook', { body: `See /pages/${target}` });

    const everywhere = registry.register({
      name: 'RecordBot',
      permittedCollections: ['*'],
      permittedActions: ['read'],
    });
    registry.certify(everywhere.agentId);
    const provision = () => fetch(`${base}/graph`, { headers: { 'x-agent-passport': everywhere.passport } });
    await provision();
    const agent = store.listActors().find((a) => a.kind === 'agent');
    assert.ok(agent);
    store.setMember(dana.id, one.id, agent.id, 'view');
    store.setMember(dana.id, two.id, agent.id, 'view');

    const graph = (await (await provision()).json()) as RecordGraph;
    assert.equal(graph.collections.length, 2);
    assert.equal(graph.edges.filter((e) => e.kind === 'link').length, 1, 'the cross-collection link survives `*`');
  } finally {
    canon.close();
    registryServer.close();
  }
});
