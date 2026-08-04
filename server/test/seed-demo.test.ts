import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import type { NotificationTransport } from '../src/notify.js';
import type { RecordGraph } from '../src/graph.js';
import { parseArgs, recordHasContent, seedDemo, type SeedReport } from '../scripts/seed-demo.js';

// The demo seeder (scripts/seed-demo.ts, `npm run seed:demo`). It is a
// development tool, and it is tested for one reason above all others: a
// screenshot of the knowledge map is only worth taking if the same command
// produces the same picture tomorrow. So the property under test is
// DETERMINISM — same seed, same corpus — and the rest of these tests check
// that the corpus is the one the map was built to show: several collections,
// trees deep enough to have a shape, every status including the awkward ones,
// material that came from somewhere else, and links that cross collections.

const quiet: NotificationTransport = { deliver() {} };

function freshStore(): CanonStore {
  return new CanonStore(openDb(':memory:'), quiet);
}

/**
 * A stable description of a corpus. Page IDs are UUIDs and timestamps are
 * clock readings, so neither can be compared across runs — everything a
 * screenshot actually shows can be.
 */
function signature(store: CanonStore, report: SeedReport): string[] {
  const graph: RecordGraph = store.recordGraph(report.operatorId);
  const names = new Map(graph.collections.map((c) => [c.id, c.name]));
  const titles = new Map(graph.nodes.map((n) => [n.id, n.title]));
  const nodes = graph.nodes.map((n) =>
    [
      n.kind,
      names.get(n.collectionId ?? '') ?? '-',
      n.title,
      n.type,
      n.status ?? '-',
      n.provenance,
      n.degree,
      titles.get(n.rootId) ?? '-',
    ].join('|'),
  );
  // A `conflicts_with` relation is SYMMETRIC, and relations.ts stores it once
  // with its pair ordered by page id — which is a UUID, so which end is which
  // is not stable across two runs even though the relation is. It is drawn
  // without an arrowhead for exactly that reason, so the picture is identical
  // either way; the signature says so by sorting the ends of a symmetric edge
  // and comparing a directed edge exactly as it is.
  const edges = graph.edges.map((e) => {
    const ends = [titles.get(e.from), titles.get(e.to)];
    if (e.kind === 'conflicts_with') ends.sort();
    return `${e.kind}|${ends.join('|')}`;
  });
  return [...nodes.sort(), ...edges.sort()];
}

test('seeder: the same seed builds the same corpus, node for node and edge for edge', async () => {
  const first = freshStore();
  const second = freshStore();
  const a = await seedDemo(first, { seed: 4242, quiet: true });
  const b = await seedDemo(second, { seed: 4242, quiet: true });

  assert.equal(a.graph.nodes, b.graph.nodes, 'the same number of nodes');
  assert.equal(a.graph.edges, b.graph.edges, 'the same number of edges');
  assert.deepEqual(a.byStatus, b.byStatus);
  assert.deepEqual(a.byType, b.byType);
  assert.deepEqual(a.byProvenance, b.byProvenance);
  assert.deepEqual(a.edges, b.edges);
  assert.equal(a.crossCollectionLinks, b.crossCollectionLinks);
  assert.deepEqual(
    a.collections.map((c) => [c.name, c.pages, c.members]),
    b.collections.map((c) => [c.name, c.pages, c.members]),
  );
  // The counts agreeing is necessary but not sufficient: two corpora can hold
  // the same number of pages and be different corpora. This compares every
  // node and every edge, by everything about them that a picture shows.
  assert.deepEqual(signature(first, a), signature(second, b));
});

test('seeder: a different seed builds a different corpus', async () => {
  const first = freshStore();
  const second = freshStore();
  const a = await seedDemo(first, { seed: 1, quiet: true });
  const b = await seedDemo(second, { seed: 2, quiet: true });
  assert.notDeepEqual(signature(first, a), signature(second, b), 'the seed is doing work');
  // The hand-written skeleton is the same either way; it is the statuses,
  // types, owners, depth-four children and see-also links that move.
  assert.deepEqual(a.collections.map((c) => c.name), b.collections.map((c) => c.name));
});

test('seeder: the corpus is a company’s record rather than eleven pages', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });

  assert.equal(report.collections.length, 5);
  assert.ok(report.pages >= 250, `expected a few hundred pages, got ${report.pages}`);
  assert.equal(report.maxDepth, 4, 'trees three and four deep');

  // Every status, including the two that only exist because the record has a
  // workflow and a clock.
  for (const status of ['draft', 'in_review', 'canonical', 'needs_update']) {
    assert.ok((report.byStatus[status] ?? 0) > 0, `no page is ${status}`);
  }
  // All four Core document types.
  for (const type of ['policy', 'spec', 'plan', 'note']) {
    assert.ok((report.byType[type] ?? 0) > 0, `no page is a ${type}`);
  }
  // And all three provenances (DATA-BACKBONE.md §6), which is what makes the
  // map worth drawing at all.
  for (const provenance of ['authored', 'imported', 'federated']) {
    assert.ok((report.byProvenance[provenance] ?? 0) > 0, `nothing is ${provenance}`);
  }

  assert.ok(report.imports.length >= 1, 'at least one import run, so imported provenance exists');
  assert.ok(report.sources >= 2, 'a couple of sources');
  assert.ok(report.references >= 5);
  assert.ok(report.archived >= 1, 'and some material that has left the map without leaving the record');
});

// ---- the corpus can answer its own obvious question ----------------------
//
// USER-TESTING.md T4.8. The page called "Records Retention Schedule" contained
// no retention period, and neither did "Retention periods: claims and
// appeals" — so the first question a new contributor naturally asks a health
// plan's knowledge base could not be answered by the demo that exists to show
// it being answered. These tests are the guard on that, and on the conflict
// the corpus deliberately holds, which is the harder thing to keep: it would
// be very easy to "fix" the demo by making the two pages agree, and the
// disagreement is the product's best feature.

test('seeder: the retention pages state retention periods, and disagree on one', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });
  const graph = store.recordGraph(report.operatorId);
  const find = (title: string) => {
    const node = graph.nodes.find((n) => n.kind === 'page' && n.title === title);
    assert.ok(node, `the corpus has no page called "${title}"`);
    return store.getPage(report.operatorId, node.id);
  };
  const bodyOf = (title: string): string => {
    const page = find(title);
    assert.ok(page.currentVersion, `"${title}" has published nothing`);
    return store.getVersion(report.operatorId, page.id, page.currentVersion).body;
  };

  // The schedule, and the leaf beneath it, both carry the figure — in words,
  // because that is how a policy states a period.
  for (const title of ['Records Retention Schedule', 'Retention periods: claims and appeals']) {
    const body = bodyOf(title);
    assert.match(body, /seven years/i, `"${title}" states no retention period for claims`);
    assert.match(body, /claims/i);
  }
  // And the other three classes are real periods too, not headings.
  assert.match(bodyOf('Retention periods: clinical criteria'), /ten years/i);
  assert.match(bodyOf('Retention periods: employment records'), /six years/i);
  assert.match(bodyOf('Retention periods: vendor contracts'), /seven years/i);

  // The conflict, on both sides, in the record's own words.
  const platform = bodyOf('Data Retention in the Platform');
  assert.match(platform, /twenty-four months/i, 'the platform spec must state the period it actually implements');
  assert.match(platform, /seven years/i, 'and must name the figure it disagrees with');
  assert.match(bodyOf('Records Retention Schedule'), /twenty-four months/i);

  // Both ends Canonical, so the conflict is between two official pages rather
  // than between the record and somebody's draft — and both cited, which is
  // what lets an answer report it.
  assert.equal(find('Records Retention Schedule').status, 'canonical');
  assert.equal(find('Data Retention in the Platform').status, 'canonical');
  const conflicts = graph.edges.filter((e) => e.kind === 'conflicts_with');
  const titles = new Map(graph.nodes.map((n) => [n.id, n.title]));
  assert.ok(
    conflicts.some((e) => {
      const ends = [titles.get(e.from), titles.get(e.to)].sort();
      return ends[0] === 'Data Retention in the Platform' && ends[1] === 'Records Retention Schedule';
    }),
    'the seven-years-against-twenty-four-months conflict must be asserted, not merely implied by the prose',
  );
});

test('seeder: page bodies carry their subject and not the demo’s furniture', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });
  const graph = store.recordGraph(report.operatorId);

  let checked = 0;
  for (const node of graph.nodes) {
    if (node.kind !== 'page') continue;
    const page = store.getPage(report.operatorId, node.id);
    if (!page.currentVersion) continue;
    const body = store.getVersion(report.operatorId, page.id, page.currentVersion).body;
    checked += 1;
    // The owner footer restated a structured field as prose, and prose is what
    // an extractive answer quotes: Ask cited page footers as what the record
    // says (T4.8). The owner is a field, and the page header shows it.
    assert.doesNotMatch(body, /^Owner: .+, .+\.$/m, `"${page.title}" carries an owner footer`);
    // A raw /pages/<uuid> in a body reads as a UUID when it is quoted. Links
    // are still links, and still the graph's `link` edges; they are written as
    // markdown, so the visible words are the target page's title and the
    // address sits behind them. Strip the link targets and nothing that looks
    // like a page address may be left.
    const prose = body.replace(/\]\(#\/pages\/[0-9a-f-]+\)/g, ']');
    assert.doesNotMatch(prose, /\/pages\//, `"${page.title}" writes a raw page URL into its prose`);
    // Applying lowerFirst to an identifier produced "pLAN-7", which a reviewer
    // read as a typo in the record.
    assert.doesNotMatch(body, /\bpLAN-\d/, `"${page.title}" lower-cased an identifier`);
  }
  assert.ok(checked > 100, `expected the whole corpus to be checked, saw ${checked} published pages`);
});

test('seeder: no two pages in the record share a title', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });
  const graph = store.recordGraph(report.operatorId);
  const seen = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== 'page') continue;
    seen.set(node.title, (seen.get(node.title) ?? 0) + 1);
  }
  const shared = [...seen.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(shared, [], 'two pages with one title is a demo telling a reviewer it was assembled carelessly');
  // And nothing is named after the defect it was built to exercise. Those are
  // the test fixtures' job; the demo ships its own migration material.
  for (const placeholder of ['Orphan Note', 'Messy Legacy Page', 'Truncated Download', 'Broken Export']) {
    assert.equal(seen.has(placeholder), false, `"${placeholder}" is a fixture name, not a company's page`);
  }
});

test('seeder: no collection’s Canonical mark is granted by one person alone', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });

  // An external auditor read sixteen Canonical clinical policies all approved
  // by the same person and could not tell a fixture artefact from a real
  // concentration of duty (T4.8). She was right not to be able to: it looked
  // exactly like one. Every collection now names two approvers and both of
  // them actually approve.
  const byCollection = new Map<string, { approver: string; pages: number }[]>();
  for (const row of report.approvals) {
    byCollection.set(row.collection, [...(byCollection.get(row.collection) ?? []), row]);
  }
  assert.equal(byCollection.size, report.collections.length, 'every collection reports its approvals');
  for (const [collection, rows] of byCollection) {
    assert.ok(rows.length >= 2, `${collection} names only one approver`);
    const working = rows.filter((r) => r.pages > 0);
    assert.ok(
      working.length >= 2,
      `${collection}: the Canonical mark was granted by ${working.length} person(s) — ` +
        `${rows.map((r) => `${r.approver} ${r.pages}`).join(', ')}`,
    );
  }
});

test('seeder: the record view of the corpus really does cross collections', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });
  const graph = store.recordGraph(report.operatorId);

  assert.equal(graph.collections.length, 5);
  assert.equal(graph.truncated, undefined, 'and it fits under the cap, so nothing is cut');
  const collectionOf = new Map(graph.nodes.map((n) => [n.id, n.collectionId]));
  const crossing = graph.edges.filter(
    (e) => e.kind === 'link' && collectionOf.get(e.from) !== collectionOf.get(e.to),
  );
  assert.ok(crossing.length >= 10, `expected the demo to show cross-collection links, got ${crossing.length}`);
  assert.equal(crossing.length, report.crossCollectionLinks);

  // Sources are drawn, each carrying the shape the record view gives them.
  const sources = graph.nodes.filter((n) => n.kind === 'source');
  assert.ok(sources.length >= 2);
  for (const source of sources) {
    assert.equal(source.collectionId, null);
    assert.equal(source.rootId, source.id);
    assert.equal(source.provenance, 'federated');
    assert.ok(source.degree > 0, 'a source with nothing referencing it would not be on the map at all');
  }

  // Imported pages name where they came from, which is §6's "unfinished
  // business" list and is meant to be short.
  const imported = graph.nodes.filter((n) => n.importSource);
  assert.ok(imported.length >= 5);
  for (const node of imported) assert.ok(node.importFile, 'an imported page names its file');
});

test('seeder: a member of one collection sees one collection of the corpus', async () => {
  const store = freshStore();
  const report = await seedDemo(store, { quiet: true });
  const compliance = report.collections.find((c) => c.name === 'Compliance')!;
  const visitor = store.createActor({ kind: 'person', name: 'Visitor' });
  store.setMember(report.operatorId, compliance.id, visitor.id, 'view');

  const graph = store.recordGraph(visitor.id);
  assert.deepEqual(graph.collections.map((c) => c.name), ['Compliance']);
  assert.ok(graph.nodes.length > 0);
  assert.equal(
    graph.nodes.every((n) => n.kind === 'source' || n.collectionId === compliance.id),
    true,
    'nothing from a collection they are not a member of',
  );
  // The demo's cross-collection links all point out of what this visitor can
  // see, so none of them are drawn — which is the permission rule doing its
  // work on a corpus big enough to notice.
  const collectionOf = new Map(graph.nodes.map((n) => [n.id, n.collectionId]));
  assert.equal(
    graph.edges.some((e) => e.kind === 'link' && collectionOf.get(e.from) !== collectionOf.get(e.to)),
    false,
  );
});

// ---- the guard rails ------------------------------------------------------

test('seeder: it can tell an empty record from a full one', async () => {
  const db = openDb(':memory:');
  assert.deepEqual(recordHasContent(db), { collections: 0, pages: 0, actors: 0 });
  const store = new CanonStore(db, quiet);
  await seedDemo(store, { quiet: true });
  const after = recordHasContent(db);
  assert.ok(after.actors > 0 && after.collections > 0 && after.pages > 0);
});

test('seeder: the command line says what it means', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.force, false, 'refusing a populated record is the DEFAULT, never the opt-in');
  assert.equal(defaults.help, false);
  assert.equal(typeof defaults.seed, 'number');

  assert.equal(parseArgs(['--force']).force, true);
  assert.equal(parseArgs(['--db', 'demo.db']).db, 'demo.db');
  assert.equal(parseArgs(['--db=demo.db']).db, 'demo.db');
  assert.equal(parseArgs(['--seed', '7']).seed, 7);
  assert.equal(parseArgs(['--seed=7']).seed, 7);
  assert.throws(() => parseArgs(['--wipe']), /Unknown argument/);
  assert.throws(() => parseArgs(['--seed', 'soon']), /--seed takes a number/);
});
