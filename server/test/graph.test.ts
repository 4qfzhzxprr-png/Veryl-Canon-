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
import { GRAPH_EDGE_KINDS, GraphNode, GraphPageNode, GraphSourceNode, KnowledgeGraph } from '../src/graph.js';

// The knowledge map (src/graph.ts): one collection's EXPLICIT graph, with each
// node's provenance. Two properties carry the whole feature and each has its
// own tests below:
//
//   - the edges are only ever the graph people maintain — the tree, the links
//     written in published bodies, and the reference fields pages carry
//     (DATA-BACKBONE.md §5, "no inferred graph");
//   - a page the asker cannot see is absent, and so is the edge that would
//     have reached it — never a placeholder standing in its place.

const quiet: NotificationTransport = { deliver() {} };

// Fixtures live in the source tree; the compiled test's depth below server/
// depends on tsconfig's rootDir, so walk up rather than counting '..'.
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

function setup() {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  return { store, dana, marc, outsider, collection };
}

/** A published Note, which needs no owner or approver, so tests stay short. */
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

function ids(graph: KnowledgeGraph): string[] {
  return graph.nodes.map((n) => n.id);
}

function pageNode(graph: KnowledgeGraph, id: string): GraphPageNode {
  const node = graph.nodes.find((n) => n.id === id);
  assert.ok(node, `no node for page ${id}`);
  assert.equal(node.kind, 'page');
  return node as GraphPageNode;
}

function edgesOf(graph: KnowledgeGraph, kind: string): string[] {
  return graph.edges.filter((e) => e.kind === kind).map((e) => `${e.from}->${e.to}`);
}

// ---- the tree ------------------------------------------------------------

test('map: the page tree becomes child edges, parent before child', () => {
  const { store, marc, collection } = setup();
  const policy = note(store, marc.id, collection.id, 'Retention policy');
  const procedure = note(store, marc.id, collection.id, 'Retention procedure', { parentId: policy });
  const step = note(store, marc.id, collection.id, 'Deleting a record', { parentId: procedure });

  const graph = store.collectionGraph(marc.id, collection.id);

  assert.deepEqual(ids(graph), [policy, procedure, step]);
  assert.deepEqual(edgesOf(graph, 'child'), [`${policy}->${procedure}`, `${procedure}->${step}`]);
  assert.equal(pageNode(graph, step).parentId, procedure);
  assert.equal(pageNode(graph, policy).parentId, null);
  assert.equal(graph.counts.pages, 3);
  assert.equal(graph.truncated, false);
});

test('map: an archived page leaves the map, and takes its edges with it', () => {
  const { store, marc, collection } = setup();
  const parent = note(store, marc.id, collection.id, 'Parent');
  const child = note(store, marc.id, collection.id, 'Child', { parentId: parent });
  const linked = note(store, marc.id, collection.id, 'Linked');
  store.editDraft(marc.id, parent, { body: `See /pages/${linked} for detail.` });
  store.publish(marc.id, parent, {});

  const before = store.collectionGraph(marc.id, collection.id);
  assert.equal(before.nodes.length, 3);
  assert.deepEqual(edgesOf(before, 'link'), [`${parent}->${linked}`]);

  store.archivePage(marc.id, linked);
  const after = store.collectionGraph(marc.id, collection.id);
  assert.equal(after.nodes.some((n) => n.id === linked), false, 'an archived page is not on the map');
  assert.deepEqual(edgesOf(after, 'link'), [], 'the link to it is dropped, not drawn to a placeholder');
  // The child edge that survives proves the archive removed one page, not the tree.
  assert.deepEqual(edgesOf(after, 'child'), [`${parent}->${child}`]);
});

// ---- links, and only the links people wrote -------------------------------

test('map: links come from published bodies, in both forms the record understands', () => {
  const { store, marc, collection } = setup();
  const a = note(store, marc.id, collection.id, 'Alpha');
  const b = note(store, marc.id, collection.id, 'Beta');
  const c = note(store, marc.id, collection.id, 'Gamma');
  store.editDraft(marc.id, a, {
    body: `Slash form /pages/${b} and wiki form [[${c}]], plus a self-link /pages/${a} and a dead one /pages/${'x'.repeat(12)}.`,
  });
  store.publish(marc.id, a, {});

  const graph = store.collectionGraph(marc.id, collection.id);
  assert.deepEqual(edgesOf(graph, 'link').sort(), [`${a}->${b}`, `${a}->${c}`].sort());
  assert.equal(
    graph.edges.some((e) => e.from === e.to),
    false,
    'a page never links to itself on the map',
  );
  assert.equal(graph.nodes.length, 3, 'an id that names no page is just text');
});

test('map: a link that exists only in a draft is not yet part of the record', () => {
  const { store, marc, collection } = setup();
  const a = note(store, marc.id, collection.id, 'Alpha');
  const b = note(store, marc.id, collection.id, 'Beta');
  store.editDraft(marc.id, a, { body: `Someday: /pages/${b}` }); // written, not published

  const graph = store.collectionGraph(marc.id, collection.id);
  assert.deepEqual(edgesOf(graph, 'link'), []);
});

test('map: the same link written twice is one edge', () => {
  const { store, marc, collection } = setup();
  const a = note(store, marc.id, collection.id, 'Alpha');
  const b = note(store, marc.id, collection.id, 'Beta');
  store.editDraft(marc.id, a, { body: `/pages/${b} and again [[${b}]] and once more /pages/${b}` });
  store.publish(marc.id, a, {});

  const graph = store.collectionGraph(marc.id, collection.id);
  assert.deepEqual(edgesOf(graph, 'link'), [`${a}->${b}`]);
});

test('map: only the three explicit edge kinds are ever emitted', () => {
  const { store, marc, collection } = setup();
  const a = note(store, marc.id, collection.id, 'Deductibles and coverage');
  note(store, marc.id, collection.id, 'Deductibles and coverage, part two'); // near-identical prose
  const graph = store.collectionGraph(marc.id, collection.id);
  assert.ok(graph.edges.every((e) => (GRAPH_EDGE_KINDS as readonly string[]).includes(e.kind)));
  // Two pages about the same subject, and no edge between them: nothing here
  // infers a relationship the record does not state.
  assert.deepEqual(graph.edges.filter((e) => e.from === a), []);
});

// ---- provenance -----------------------------------------------------------

test('provenance: a page written here is authored', () => {
  const { store, marc, collection } = setup();
  const id = note(store, marc.id, collection.id, 'Written in Canon');
  const node = pageNode(store.collectionGraph(marc.id, collection.id), id);
  assert.equal(node.provenance, 'authored');
  assert.equal(node.origin, null);
  assert.equal(node.references, 0);
});

test('provenance: an imported page names the system and the file it came from', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE,
    collectionId: collection.id,
  });
  const overview = summary.files.find((f) => f.file === 'Benefits+Overview_65601.html');
  assert.ok(overview?.pageId);

  const graph = store.collectionGraph(marc.id, collection.id);
  const node = pageNode(graph, overview.pageId);
  assert.equal(node.provenance, 'imported');
  assert.equal(node.origin?.system, 'confluence');
  assert.equal(node.origin?.file, 'Benefits+Overview_65601.html');
  assert.equal(node.origin?.runId, summary.runId);
  assert.ok(node.origin?.at);

  // The import's own tree survives into the map as child edges: this is the
  // migrated space's shape, visible as a shape.
  const eligibility = summary.files.find((f) => f.file === 'Eligibility+Rules_65602.html');
  assert.ok(eligibility?.pageId);
  assert.ok(edgesOf(graph, 'child').includes(`${overview.pageId}->${eligibility.pageId}`));

  // And every imported page is visible as one set — the migration's unfinished
  // business, in one filter (DATA-BACKBONE.md §6).
  const imported = graph.nodes.filter((n) => n.kind === 'page' && (n as GraphPageNode).origin);
  assert.ok(imported.length >= 5, 'every page the run created carries its origin');
});

test('provenance: a page carrying a reference is federated, and the source is a node', () => {
  const { store, dana, marc, collection } = setup();
  staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': 1500 } });
  const source = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 60_000,
    collectionIds: [collection.id],
  });
  const page = note(store, marc.id, collection.id, 'Benefits policy');
  const other = note(store, marc.id, collection.id, 'Claims runbook');
  store.addReference(marc.id, page, { sourceId: source.id, selector: 'deductible', key: 'PLAN-7' });
  store.addReference(marc.id, page, { sourceId: source.id, selector: 'deductible', key: 'PLAN-9' });
  store.addReference(marc.id, other, { sourceId: source.id, selector: 'deductible', key: 'PLAN-8' });

  const graph = store.collectionGraph(marc.id, collection.id);
  const node = pageNode(graph, page);
  assert.equal(node.provenance, 'federated');
  assert.equal(node.references, 2);

  const sourceNode = graph.nodes.find((n) => n.id === source.id) as GraphSourceNode | undefined;
  assert.ok(sourceNode, 'the source is drawn as a node of its own kind');
  assert.equal(sourceNode.kind, 'source');
  assert.equal(sourceNode.name, 'Benefits Admin');
  assert.equal(sourceNode.type, 'static');
  assert.equal(sourceNode.authMode, 'service');
  assert.equal(sourceNode.status, null, 'a source has no standing in the record');
  assert.equal(sourceNode.provenance, 'federated');

  // "Which pages depend on the benefits system" is answerable by looking: one
  // edge per page, however many reference fields that page carries.
  assert.deepEqual(edgesOf(graph, 'reference').sort(), [`${page}->${source.id}`, `${other}->${source.id}`].sort());
  assert.equal(sourceNode.references, 2);
  assert.equal(graph.counts.sources, 1);
});

test('provenance: imported AND federated reads as federated, with the origin still named', () => {
  const { store, dana, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE,
    collectionId: collection.id,
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
    collectionIds: [collection.id],
  });
  store.addReference(marc.id, overview.pageId, { sourceId: source.id, selector: 'deductible', key: 'PLAN-7' });

  const node = pageNode(store.collectionGraph(marc.id, collection.id), overview.pageId);
  assert.equal(node.provenance, 'federated', 'the live dependency is the stronger statement');
  assert.equal(node.origin?.system, 'confluence', 'and the migration origin is not lost');
  assert.equal(node.origin?.file, 'Benefits+Overview_65601.html');
});

// ---- permissions ----------------------------------------------------------

test('permissions: a linked page in a collection the viewer cannot see is absent, and so is its edge', () => {
  const { store, dana, marc, collection } = setup();
  // A second collection Dana can see and Marc cannot.
  const restricted = store.createCollection(dana.id, { name: 'Board' });
  const secret = note(store, dana.id, restricted.id, 'Board minutes');
  const visible = note(store, marc.id, collection.id, 'Handbook');
  store.editDraft(marc.id, visible, { body: `Background: /pages/${secret}` });
  store.publish(marc.id, visible, {});

  // Dana is a member of both, so for her the neighbour is a real node with a
  // real edge — the map follows links out of the collection deliberately.
  const danas = store.collectionGraph(dana.id, collection.id);
  const neighbour = pageNode(danas, secret);
  assert.equal(neighbour.external, true);
  assert.equal(neighbour.collectionId, restricted.id);
  assert.deepEqual(edgesOf(danas, 'link'), [`${visible}->${secret}`]);
  assert.equal(danas.counts.external, 1);

  // Marc sees the same collection with the neighbour simply not there.
  const marcs = store.collectionGraph(marc.id, collection.id);
  assert.equal(marcs.nodes.some((n) => n.id === secret), false, 'never a node');
  assert.deepEqual(edgesOf(marcs, 'link'), [], 'and never an edge to one');
  assert.equal(marcs.counts.external, 0);
  assert.equal(
    JSON.stringify(marcs).includes('Board minutes'),
    false,
    'not even the title of a page he may not see',
  );
});

test('permissions: a source referenced by a page the viewer cannot see is not on their map', () => {
  const { store, dana, marc, collection } = setup();
  const restricted = store.createCollection(dana.id, { name: 'Board' });
  staticConnectorOf(store.connectors).define('payroll', { salary: { 'BAND-1': 100 } });
  const source = store.createSource(dana.id, {
    name: 'Payroll',
    kind: 'static',
    baseUrl: 'static:payroll',
    authMode: 'service',
    freshnessWindowMs: 60_000,
    collectionIds: [restricted.id],
  });
  const secret = note(store, dana.id, restricted.id, 'Pay bands');
  store.addReference(dana.id, secret, { sourceId: source.id, selector: 'salary', key: 'BAND-1' });
  const visible = note(store, marc.id, collection.id, 'Handbook');
  store.editDraft(marc.id, visible, { body: `See /pages/${secret}` });
  store.publish(marc.id, visible, {});

  const marcs = store.collectionGraph(marc.id, collection.id);
  assert.equal(marcs.counts.sources, 0);
  assert.equal(JSON.stringify(marcs).includes('Payroll'), false);

  // Dana, who may see the page, sees what it depends on.
  const danas = store.collectionGraph(dana.id, collection.id);
  assert.equal(danas.counts.sources, 1);
  assert.deepEqual(edgesOf(danas, 'reference'), [`${secret}->${source.id}`]);
});

test('permissions: a non-member is refused, and an unknown collection or actor is not found', () => {
  const { store, marc, outsider, collection } = setup();
  note(store, marc.id, collection.id, 'Handbook');
  expectCode(() => store.collectionGraph(outsider.id, collection.id), 'forbidden');
  expectCode(() => store.collectionGraph(marc.id, 'no-such-collection'), 'not_found');
  expectCode(() => store.collectionGraph('no-such-actor', collection.id), 'not_found');
});

test('permissions: `view` is enough — the map is a read, never an edit', () => {
  const { store, dana, marc, collection } = setup();
  const reader = store.createActor({ kind: 'person', name: 'Reader' });
  store.setMember(dana.id, collection.id, reader.id, 'view');
  note(store, marc.id, collection.id, 'Handbook');
  const graph = store.collectionGraph(reader.id, collection.id);
  assert.equal(graph.counts.pages, 1);
});

// ---- status, and the shape of the payload ---------------------------------

test('map: every page node carries its status, in the record’s own vocabulary', () => {
  const { store, dana, marc, collection } = setup();
  const draft = store.createPage(marc.id, { collectionId: collection.id, type: 'note', title: 'Working note' });
  const published = note(store, marc.id, collection.id, 'Published note');
  const policy = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Retention' });
  store.editDraft(marc.id, policy.id, {
    body: 'Records are kept for seven years.',
    fields: { ownerId: marc.id, approverId: dana.id, effectiveDate: '2030-01-01', reviewDate: '2030-01-01' },
  });
  store.submitForReview(marc.id, policy.id);

  const graph = store.collectionGraph(marc.id, collection.id);
  assert.equal(pageNode(graph, draft.id).status, 'draft');
  assert.equal(pageNode(graph, published).status, 'draft'); // a Note never reaches Canonical
  assert.equal(pageNode(graph, policy.id).status, 'in_review');
  assert.equal(pageNode(graph, policy.id).type, 'policy');
  assert.equal(pageNode(graph, published).version, 1);
  assert.equal(pageNode(graph, draft.id).version, null);
});

test('map: the same record maps the same way twice — the payload is deterministic', () => {
  const { store, marc, collection } = setup();
  const a = note(store, marc.id, collection.id, 'Alpha');
  const b = note(store, marc.id, collection.id, 'Beta', { parentId: a });
  note(store, marc.id, collection.id, 'Gamma', { parentId: b });
  const first = store.collectionGraph(marc.id, collection.id);
  const second = store.collectionGraph(marc.id, collection.id);
  assert.deepEqual(
    { ...first, generatedAt: '' },
    { ...second, generatedAt: '' },
    'a client may lay this out deterministically because the server orders it deterministically',
  );
});

test('map: an empty collection maps to an empty graph rather than an error', () => {
  const { store, marc, collection } = setup();
  const graph = store.collectionGraph(marc.id, collection.id);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.counts, { pages: 0, external: 0, sources: 0, edges: 0 });
});

// ---- the HTTP surface -----------------------------------------------------

test('API: GET /collections/:id/graph serves the map, and refuses a non-member', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  const parent = note(store, dana.id, collection.id, 'Handbook');
  note(store, dana.id, collection.id, 'Onboarding', { parentId: parent });

  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/collections/${collection.id}/graph`, {
      headers: { 'x-actor-id': dana.id },
    });
    assert.equal(res.status, 200);
    const graph = (await res.json()) as KnowledgeGraph;
    assert.equal(graph.collectionId, collection.id);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.kind, 'child');

    const refused = await fetch(`${base}/collections/${collection.id}/graph`, {
      headers: { 'x-actor-id': outsider.id },
    });
    assert.equal(refused.status, 403);

    const missing = await fetch(`${base}/collections/nope/graph`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(missing.status, 404);

    const anonymous = await fetch(`${base}/collections/${collection.id}/graph`);
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
  }
});

test('agents: the map is classified `read`, scoped to the collection in the path', async () => {
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
  const call = (path: string, passport: string) =>
    fetch(base + path, { headers: { 'x-agent-passport': passport } });

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    const mapped = store.createCollection(dana.id, { name: 'Compliance' });
    const barred = store.createCollection(dana.id, { name: 'Board' });
    note(store, dana.id, mapped.id, 'Handbook');

    const reader = registry.register({
      name: 'MapBot',
      permittedCollections: [mapped.id],
      permittedActions: ['read'],
    });
    registry.certify(reader.agentId);
    // First call provisions the agent actor; Canon's half is granted after.
    await call(`/collections/${mapped.id}/graph`, reader.passport);
    const agent = store.listActors().find((a) => a.kind === 'agent');
    assert.ok(agent);
    store.setMember(dana.id, mapped.id, agent.id, 'view');
    store.setMember(dana.id, barred.id, agent.id, 'view');

    const permitted = await call(`/collections/${mapped.id}/graph`, reader.passport);
    assert.equal(permitted.status, 200);
    assert.equal(((await permitted.json()) as KnowledgeGraph).counts.pages, 1);

    // Canon grants view on the second collection; the Registry does not, and
    // the intersection is what decides. Classified, so the refusal is the
    // Registry's — an UNclassified route would refuse this too, but it would
    // refuse the permitted call above as well.
    const refused = await call(`/collections/${barred.id}/graph`, reader.passport);
    assert.equal(refused.status, 403);

    // `read` is the action: a passport with no read action cannot map at all.
    const writer = registry.register({
      name: 'WriteBot',
      permittedCollections: ['*'],
      permittedActions: ['write'],
    });
    registry.certify(writer.agentId);
    const wrongAction = await call(`/collections/${mapped.id}/graph`, writer.passport);
    assert.equal(wrongAction.status, 403);
  } finally {
    canon.close();
    registryServer.close();
  }
});

// A compile-time reminder rather than an assertion: the two node kinds are a
// discriminated union, so a client that switches on `kind` is exhaustive.
test('map: nodes discriminate on `kind`', () => {
  const { store, marc, collection } = setup();
  note(store, marc.id, collection.id, 'Handbook');
  for (const node of store.collectionGraph(marc.id, collection.id).nodes as GraphNode[]) {
    if (node.kind === 'page') assert.equal(typeof node.title, 'string');
    else assert.equal(typeof node.name, 'string');
  }
});
