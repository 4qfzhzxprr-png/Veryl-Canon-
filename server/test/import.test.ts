import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import type { ImportSummary } from '../src/import.js';

// Fixtures live in the source tree; the tests run from compiled output whose
// depth below server/ depends on tsconfig's rootDir — which has already moved
// once, silently breaking a fixed number of '..' segments. Walk up instead.
function findFixtures(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'test', 'fixtures');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('test fixtures not found above the compiled test file');
}

const FIXTURES = findFixtures();
const CONFLUENCE = join(FIXTURES, 'confluence-space');
const CONFLUENCE_FLAT = join(FIXTURES, 'confluence-flat');
const GOOGLE = join(FIXTURES, 'google-docs');

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Member Benefits' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  return { store, dana, marc, collection };
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

function byFile(summary: ImportSummary, file: string) {
  const result = summary.files.find((f) => f.file === file);
  assert.ok(result, `no outcome recorded for ${file}`);
  return result;
}

test('import: a Confluence export arrives with its page tree intact', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });

  assert.equal(summary.source, 'confluence');
  assert.equal(summary.hierarchy, 'tree');
  assert.equal(summary.counts.imported, 6);
  assert.equal(summary.counts.failed, 1, 'the truncated file is reported, not imported');

  const tree = store.tree(marc.id, collection.id);
  const roots = tree.map((n) => n.title).sort();
  assert.deepEqual(roots, ['Benefits Overview', 'Messy Legacy Page']);

  const overview = tree.find((n) => n.title === 'Benefits Overview')!;
  assert.deepEqual(
    overview.children.map((c) => c.title).sort(),
    ['Claims Runbook', 'Eligibility Rules', 'Orphan Note'],
    'children come from the export index, and from breadcrumbs for pages the index never listed',
  );
  const eligibility = overview.children.find((c) => c.title === 'Eligibility Rules')!;
  assert.deepEqual(eligibility.children.map((c) => c.title), ['Appeals Process'], 'the tree nests three deep');
});

test('import: the body arrives as structured text, never as HTML', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });

  const find = (title: string) => {
    const file = summary.files.find((f) => f.title === title);
    assert.ok(file?.pageId, `imported page not found: ${title}`);
    return store.getVersion(marc.id, file.pageId, 1);
  };

  const eligibility = find('Eligibility Rules');
  assert.match(eligibility.body, /\| Relationship \| Eligible \| Evidence required \|/, 'the table survives');
  assert.match(eligibility.body, /^> Eligibility is not enrolment/m, 'the blockquote survives');
  assert.match(eligibility.body, /\*\*first day of the month\*\*/, 'bold survives');

  const runbook = find('Claims Runbook');
  assert.match(runbook.body, /```python\ndef route\(claim\):\n    if claim\["amount"\] > 5000:/, 'the code block survives');
  assert.match(runbook.body, /`--resume`/, 'inline code survives');

  const messy = find('Messy Legacy Page');
  assert.match(messy.body, /AT&T and R&D/, 'bare ampersands survive');
  assert.match(messy.body, /\*\*Bold by inline style\*\*/, 'emphasis carried in a style attribute survives');
  assert.ok(!messy.body.includes('this must never reach a page body'), 'script content never lands in the record');
  assert.ok(!messy.body.includes('Hidden text'), 'display:none content never lands in the record');

  for (const title of ['Benefits Overview', 'Eligibility Rules', 'Claims Runbook', 'Messy Legacy Page']) {
    assert.ok(!/<[a-z/]/i.test(find(title).body), `raw HTML leaked into ${title}`);
  }
});

test('import: every page arrives as a Draft, created by the importing actor', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });

  for (const file of summary.files.filter((f) => f.pageId)) {
    const page = store.getPage(marc.id, file.pageId!);
    assert.equal(page.status, 'draft', `${file.file} did not arrive as a draft`);
    assert.notEqual(page.status, 'canonical');
    assert.equal(page.createdBy, marc.id, `${file.file} was not attributed to the importer`);
    const version = store.getVersion(marc.id, page.id, 1);
    assert.equal(version.authorId, marc.id, 'the imported version is authored by the importer');
    assert.match(version.note ?? '', /^Imported from confluence: /);
  }
});

test('import: a reviewed type keeps its body in the draft rather than publishing unreviewed', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
    type: 'policy',
  });
  const imported = summary.files.filter((f) => f.outcome === 'imported');
  assert.equal(imported.length, 2);
  for (const file of imported) {
    assert.equal(file.published, false);
    assert.match(file.reason ?? '', /needs a named approver/);
    const page = store.getPage(marc.id, file.pageId!);
    assert.equal(page.status, 'draft');
    assert.equal(page.currentVersion, null, 'nothing is published without the fields its type requires');
    assert.equal(page.ownerId, null);
    const draft = store.getDraft(marc.id, page.id)!;
    assert.ok(draft.body.length > 0, 'the imported body waits in the draft');
    assert.equal(draft.fields.ownerId, marc.id, 'the importer is the initial owner');
  }
});

test('import: each run writes start, per-page, and finish events to the audit log', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });

  const start = store.queryAudit(marc.id, { action: 'import.start' });
  assert.equal(start.length, 1);
  assert.equal(start[0]!.actorId, marc.id);
  assert.equal(start[0]!.details.runId, summary.runId);
  assert.equal(start[0]!.details.source, 'confluence');
  assert.equal(start[0]!.details.path, CONFLUENCE);

  const pages = store.queryAudit(marc.id, { action: 'import.page' });
  assert.equal(pages.length, summary.files.length);
  const overview = pages.find((e) => e.details.file === 'Benefits+Overview_65601.html')!;
  assert.equal(overview.details.source, 'confluence');
  assert.equal(overview.details.outcome, 'imported');
  assert.equal(overview.details.pageId, byFile(summary, 'Benefits+Overview_65601.html').pageId);
  assert.equal(overview.pageId, overview.details.pageId, 'the event is attached to the page it created');
  const broken = pages.find((e) => e.details.file === 'Broken+Export_65607.html')!;
  assert.equal(broken.details.outcome, 'failed');

  const finish = store.queryAudit(marc.id, { action: 'import.finish' });
  assert.equal(finish.length, 1);
  assert.deepEqual(finish[0]!.details.counts, summary.counts);
});

test('import: a file that fails to parse is reported and the run carries on', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });

  const broken = byFile(summary, 'Broken+Export_65607.html');
  assert.equal(broken.outcome, 'failed');
  assert.equal(broken.pageId, null);
  assert.match(broken.reason ?? '', /no readable content/);
  assert.equal(summary.counts.imported, 6, 'every other page in the export still arrived');
});

test('import: re-running a run id is idempotent, and changed files become new versions', () => {
  const { store, marc, collection } = setup();
  const scratch = mkdtempSync(join(tmpdir(), 'canon-import-'));
  try {
    cpSync(CONFLUENCE_FLAT, scratch, { recursive: true });
    const first = store.runImport(marc.id, { source: 'confluence', path: scratch, collectionId: collection.id });
    assert.equal(first.counts.imported, 2);
    const pageId = byFile(first, 'Formulary+Tiers_9001.html').pageId!;

    // Same run id, nothing changed on disk: no new pages, no new versions.
    const again = store.runImport(marc.id, {
      source: 'confluence',
      path: scratch,
      collectionId: collection.id,
      runId: first.runId,
    });
    assert.equal(again.counts.imported, 0);
    assert.equal(again.counts.skipped, 2);
    assert.match(byFile(again, 'Formulary+Tiers_9001.html').reason ?? '', /unchanged/);
    assert.equal(store.tree(marc.id, collection.id).length, 2, 'no page was duplicated');
    assert.equal(store.listVersions(marc.id, pageId).length, 1);

    // Same run id, one file edited: a new version on the same page.
    const file = join(scratch, 'Formulary+Tiers_9001.html');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Speciality', 'Speciality and biosimilars'));
    const third = store.runImport(marc.id, {
      source: 'confluence',
      path: scratch,
      collectionId: collection.id,
      runId: first.runId,
    });
    assert.equal(third.counts.updated, 1);
    assert.equal(third.counts.skipped, 1);
    assert.equal(byFile(third, 'Formulary+Tiers_9001.html').pageId, pageId, 'the same page, not a second one');
    assert.equal(store.tree(marc.id, collection.id).length, 2);
    const versions = store.listVersions(marc.id, pageId);
    assert.equal(versions.length, 2);
    assert.match(versions[1]!.body, /Speciality and biosimilars/);

    // A fresh run id is a fresh import, by design: it makes new pages.
    const fresh = store.runImport(marc.id, { source: 'confluence', path: scratch, collectionId: collection.id });
    assert.equal(fresh.counts.imported, 2);
    assert.equal(store.tree(marc.id, collection.id).length, 4);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('import: a Google Docs export arrives flat, with the emphasis its style sheet encodes', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'google-docs', path: GOOGLE, collectionId: collection.id });

  assert.equal(summary.hierarchy, 'flat');
  assert.equal(summary.counts.imported, 3);
  assert.equal(summary.counts.failed, 1);
  assert.equal(byFile(summary, 'Truncated Download.html').outcome, 'failed');

  const tree = store.tree(marc.id, collection.id);
  assert.equal(tree.length, 3, 'Google Docs has no tree: everything lands at the root');
  assert.ok(tree.every((node) => node.children.length === 0));
  assert.deepEqual(
    tree.map((n) => n.title).sort(),
    ['Benefits Enrolment Guide', 'Claims Handling Runbook', 'Formulary Changes 2026'],
    'a nested Drive folder is walked, and the document title is the page title',
  );

  const guide = store.getVersion(marc.id, byFile(summary, 'Benefits Enrolment Guide.html').pageId!, 1);
  assert.match(guide.body, /closes at midnight on \*\*30 November\*\*/, 'bold lives only in a CSS class here');
  assert.match(guide.body, /does \*not\* save/, 'italics likewise');
  assert.match(guide.body, /`ENR-2026-000000`/, 'a monospace run becomes inline code');
  assert.match(
    guide.body,
    /\[the benefits site\]\(https:\/\/benefits\.example\.com\/compare-2026\)/,
    "Google's redirect wrapper is unwrapped",
  );
  assert.match(guide.body, /\[Image: Screenshot of the enrolment confirmation screen\]\(images\/image1\.png\)/);
  assert.ok(!guide.body.startsWith('Benefits Enrolment Guide'), 'the repeated title line is dropped');

  const runbook = store.getVersion(marc.id, byFile(summary, 'Claims Handling Runbook.html').pageId!, 1);
  assert.match(runbook.body, /\| Batch failed twice \| Claims platform on-call \| 15 minutes \|/);
  assert.match(runbook.body, /`claims-batch --date 2026-03-14 --resume --dry-run`/);
});

test('import: an export with no index and no breadcrumbs falls back to a flat import', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
  });
  assert.equal(summary.hierarchy, 'flat');
  assert.equal(summary.counts.imported, 2);
  const tree = store.tree(marc.id, collection.id);
  assert.equal(tree.length, 2);
  assert.deepEqual(tree.map((n) => n.title).sort(), ['Formulary Tiers', 'Prior Authorisation']);
});

test('import: bad input is refused with a CanonError, before anything is written', () => {
  const { store, dana, marc, collection } = setup();
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });

  expectCode(() => store.runImport(marc.id, { source: 'sharepoint' as never, path: CONFLUENCE, collectionId: collection.id }), 'invalid');
  expectCode(() => store.runImport(marc.id, { source: 'confluence', path: '', collectionId: collection.id }), 'invalid');
  expectCode(
    () => store.runImport(marc.id, { source: 'confluence', path: join(CONFLUENCE, 'index.html'), collectionId: collection.id }),
    'invalid',
  );
  expectCode(
    () => store.runImport(marc.id, { source: 'confluence', path: join(FIXTURES, 'nope'), collectionId: collection.id }),
    'not_found',
  );
  expectCode(
    () => store.runImport(outsider.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id }),
    'forbidden',
  );
  expectCode(
    () => store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id, type: 'memo' as never }),
    'invalid',
  );

  // A run id already used for a different export is a conflict, not a merge.
  const run = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE_FLAT, collectionId: collection.id });
  expectCode(
    () => store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id, runId: run.runId }),
    'conflict',
  );
  assert.equal(store.queryAudit(dana.id, { action: 'import.start' }).length, 1, 'a refused import writes nothing');
});

test('API: POST /imports returns the run summary and GET /imports/:id recalls it', async () => {
  const store = new CanonStore(openDb(':memory:'));
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
    const collection = (await call('POST', '/collections', dana.id, { name: 'Member Benefits' })).json;

    const posted = await call('POST', '/imports', dana.id, {
      source: 'google-docs',
      path: GOOGLE,
      collectionId: collection.id,
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.counts.imported, 3);
    assert.equal(posted.json.counts.failed, 1);
    assert.equal(posted.json.hierarchy, 'flat');

    const recalled = await call('GET', `/imports/${posted.json.runId}`, dana.id);
    assert.equal(recalled.status, 200);
    assert.equal(recalled.json.source, 'google-docs');
    assert.deepEqual(recalled.json.counts, posted.json.counts);
    assert.equal(recalled.json.items.length, 4, 'every file has an outcome on the record');

    const listed = await call('GET', '/imports', dana.id);
    assert.equal(listed.json.length, 1);
    assert.equal(listed.json[0].runId, posted.json.runId);

    const missing = await call('GET', '/imports/nope', dana.id);
    assert.equal(missing.status, 404);

    const outsider = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Outsider' })).json;
    const denied = await call('GET', `/imports/${posted.json.runId}`, outsider.id);
    assert.equal(denied.status, 403);

    const badSource = await call('POST', '/imports', dana.id, {
      source: 'notion',
      path: GOOGLE,
      collectionId: collection.id,
    });
    assert.equal(badSource.status, 400);
    assert.equal(badSource.json.error, 'invalid');
  } finally {
    server.close();
  }
});
