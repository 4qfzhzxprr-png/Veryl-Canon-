import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CONFLUENCE_MIXED = join(FIXTURES, 'confluence-mixed');
const GOOGLE = join(FIXTURES, 'google-docs');

function setup() {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Member Benefits' });
  // Running an import takes `admin`, not `edit` (SECURITY.md R6): it names a
  // server-side path and lands hundreds of pages in one call, which is
  // administration rather than authoring. Marc is the importing actor
  // throughout this suite, so Marc administers the collection.
  store.setMember(dana.id, collection.id, marc.id, 'admin');
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
    const draft = store.getDraft(marc.id, page.id)!;
    assert.ok(draft.body.length > 0, 'the imported body waits in the draft');
    assert.equal(draft.fields.ownerId, marc.id, 'the importer is the initial owner');
    // And the page says so too. The importer has always named itself as the
    // initial owner in the draft; a page created by hand now does the same on
    // the page itself (see `createPage`), so the two agree.
    assert.equal(page.ownerId, marc.id);
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

// Round seven, tester 25, whose one failed import was discoverable only
// through the audit log and, when found, said this:
//
//   "no readable content: the file parsed to an empty document"
//
// True, and pointing at the wrong thing. The file has plenty of content; it
// ends inside an unclosed HTML comment, so `parseHtml` — correctly — swallows
// everything from the last `<!--` to the end of the file. An operator told
// "empty document" goes back to the source system looking for a page that is
// not empty. An operator told the file stops mid-comment re-exports it.
test('import: a truncated export is named as truncated, not as an empty page', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE, collectionId: collection.id });
  const broken = byFile(summary, 'Broken+Export_65607.html');

  assert.match(broken.reason ?? '', /stops inside a comment that is never closed/, 'the cause, not the symptom');
  assert.match(broken.reason ?? '', /looks truncated/);
  assert.match(broken.reason ?? '', /re-export this page/, 'and what to do about it');
  // Still a failure, still not fatal to the run, and still nothing invented:
  // guessing where a truncated file was meant to end would put made-up
  // structure into the record.
  assert.equal(broken.outcome, 'failed');
  assert.equal(broken.pageId, null);

  // The operator meets this sentence in the audit log, which is where the one
  // failed import was findable at all.
  const events = store.queryAudit(marc.id, { action: 'import.page' });
  const logged = events.find((e) => e.details.file === 'Broken+Export_65607.html')!;
  assert.equal(logged.details.reason, broken.reason);
});

// Round-seven's truncation was caught only because NOTHING survived the
// unclosed comment: the file parsed to an empty body and tripped the
// empty-document branch. A file with readable content BEFORE the unclosed
// comment parses to a non-empty body — `parseHtml` swallows only from the last
// `<!--` to EOF — so it slipped past that branch entirely and imported as a
// clean page with its tail silently dropped. A page that is missing its end,
// presented as whole, is the worst outcome an importer can have.
test('import: a file truncated after some surviving content is failed, not imported clean', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-trunc-'));
  // A paragraph that survives, then an unclosed comment, then a paragraph that
  // is dropped. The title comes from the content, so the body is non-empty and
  // the empty-document branch never sees this file.
  writeFileSync(
    join(root, 'Retention.html'),
    [
      '<html><head><title>Retention Policy</title></head><body>',
      '<p>Records are kept for seven years.</p>',
      '<!--',
      '<p>Destroy after the retention window closes; escalate exceptions to Legal.</p>',
      '</body></html>',
    ].join('\n'),
  );
  try {
    const summary = store.runImport(marc.id, { source: 'google-docs', path: root, collectionId: collection.id });
    const result = byFile(summary, 'Retention.html');

    assert.equal(result.outcome, 'failed', 'a truncated file must not import as a clean page');
    assert.equal(result.pageId, null, 'and no page is written for it');
    assert.equal(summary.counts.imported, 0);
    assert.equal(summary.counts.failed, 1);
    // The cause, in the operator's words, and what to do about it.
    assert.match(result.reason ?? '', /stops inside a comment that is never closed/);
    assert.match(result.reason ?? '', /re-export this page/);
    // The dropped tail is nowhere in the record: nothing was imported.
    assert.equal(store.tree(marc.id, collection.id).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The other direction: a whole file that merely ENDS with a dangling comment
// opener and nothing after it lost nothing, and must still import cleanly — the
// truncation guard keys on content actually dropped, not on the bare presence
// of an unclosed marker.
test('import: a file ending in an empty dangling comment still imports, nothing was lost', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-whole-'));
  writeFileSync(
    join(root, 'Whole.html'),
    '<html><head><title>Whole Page</title></head><body><p>All of the content is here.</p></body></html>\n<!--',
  );
  try {
    const summary = store.runImport(marc.id, { source: 'google-docs', path: root, collectionId: collection.id });
    const result = byFile(summary, 'Whole.html');
    assert.equal(result.outcome, 'imported', 'nothing was dropped, so the page is whole');
    assert.ok(result.pageId);
    assert.equal(summary.counts.imported, 1);
    assert.equal(summary.counts.failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// A migration lead has to trust the receipt: every file they put in the zip has
// to show up somewhere. A non-HTML file the importer will not turn into a page
// used to be dropped with a bare `continue` — not imported, not failed, not
// skipped, so a six-file zip read "Files: 5" and the sixth simply vanished.
test('import: a non-HTML file is reported as skipped, not silently dropped', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE_MIXED, collectionId: collection.id });

  // The .txt the exporter swept in is accounted for, with a reason a human reads.
  const notes = byFile(summary, 'loose-notes.txt');
  assert.equal(notes.outcome, 'skipped', 'a non-HTML file is skipped, never dropped');
  assert.equal(notes.pageId, null, 'and it makes no page');
  assert.match(notes.reason ?? '', /not an HTML page/i);

  // The real HTML page still imports.
  assert.equal(byFile(summary, 'Runbook_100.html').outcome, 'imported');

  // The index is the tree, not a content file: it is neither imported nor
  // reported as a dropped file.
  assert.equal(summary.files.some((f) => f.file.toLowerCase() === 'index.html'), false);

  // Every content file the user included (index.html aside) is accounted for:
  // the handled counts add up to the real file count, nothing vanishes.
  const { imported, updated, skipped, failed } = summary.counts;
  assert.equal(imported + updated + skipped + failed, 2, 'both content files are accounted for');
  assert.equal(imported, 1);
  assert.equal(skipped, 1);
});

// The in-memory summary above is not what the receipt view renders — that is
// read back from the import_items table via getRun. A discovery skip that only
// bumped the tally but never wrote a row was COUNTED ("1 skipped") yet appeared
// nowhere in the "Every file" table, and `found` excluded it, so the header read
// "1 imported · 1 skipped — 1 document found" (2 ≠ 1). A migration lead could not
// reconcile the receipt, and one file lived nowhere. The read-back must show the
// skip as a row with its reason, and the counts must reconcile.
test('import: a discovery skip is a persisted receipt row, and the counts reconcile', () => {
  const { store, marc, collection } = setup();
  const summary = store.runImport(marc.id, { source: 'confluence', path: CONFLUENCE_MIXED, collectionId: collection.id });

  // Read the run back through the same path the receipt view uses: import_items.
  const run = store.getImportRun(marc.id, summary.runId);

  // The non-HTML file has an actual ROW in the receipt, with a human reason —
  // not merely a number in the header.
  const notes = run.items.find((i) => i.file === 'loose-notes.txt');
  assert.ok(notes, 'the skipped non-HTML file has a row in the read-back receipt');
  assert.equal(notes.outcome, 'skipped');
  assert.equal(notes.pageId, null);
  assert.match(notes.reason ?? '', /not an HTML page/i);

  // The imported page is a row too, so the table is the whole story.
  const runbook = run.items.find((i) => i.file === 'Runbook_100.html');
  assert.equal(runbook?.outcome, 'imported');

  // The header reconciles: found is the full input total, and no file is an
  // anonymous "+N" — found == imported + updated + skipped + failed.
  const { found, imported, updated, skipped, failed } = run.counts;
  assert.equal(found, imported + updated + skipped + failed, 'the receipt header reconciles: nothing is orphaned');
  assert.equal(found, 2, 'both content files the user put in are counted in the total');
  assert.equal(imported, 1);
  assert.equal(skipped, 1);
});

// A binary file (a PDF or image renamed `.html`, or any blob discovery picks up)
// decodes to non-empty junk and slips past the empty-document guard, importing
// as a "clean" page. It must be reported instead — a page nobody can read is not
// a page.
test('import: a binary file named like a page is reported, not imported as junk', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-binary-'));
  try {
    // A page that reads fine, so the failure is the blob's alone.
    writeFileSync(
      join(root, 'Good.html'),
      '<html><head><title>Good Page</title></head><body><p>Readable content.</p></body></html>',
    );
    // 512 bytes of binary content, NUL bytes and all, wearing an .html name.
    const blob = Buffer.alloc(512);
    for (let i = 0; i < blob.length; i += 1) blob[i] = i % 256;
    writeFileSync(join(root, 'Scan_200.html'), blob);

    const summary = store.runImport(marc.id, { source: 'google-docs', path: root, collectionId: collection.id });

    const scan = byFile(summary, 'Scan_200.html');
    assert.equal(scan.outcome, 'failed', 'a binary blob must not import as a clean page');
    assert.equal(scan.pageId, null, 'and no page is written for it');
    assert.match(scan.reason ?? '', /not readable as text|binary/i);

    assert.equal(byFile(summary, 'Good.html').outcome, 'imported');
    assert.equal(summary.counts.imported, 1);
    assert.equal(summary.counts.failed, 1);
    // The blob left no page in the tree.
    assert.equal(store.tree(marc.id, collection.id).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A Confluence discovery walked only the top level: an HTML page a records
// manager had zipped into a subfolder was never enumerated, never counted, and
// never recorded as skipped — it VANISHED, and because `found` is computed after
// dropping it the header ("1 imported · 1 document found") could not even
// contradict itself. Every HTML file the user handed in must be either imported
// or a skipped row with a reason — with NO directory-name exceptions. HTML in
// attachments/ is not imported as a page, but it still gets a skipped row;
// non-HTML in any subfolder (real assets/attachments) stays silent.
test('import: HTML pages in subfolders are recorded as skipped rows, not silently dropped', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-nested-'));
  try {
    const page = (title: string) =>
      `<html><head><title>${title}</title></head><body><p>Readable content for ${title}.</p></body></html>`;
    // One page at the top level: the only thing a real Confluence export lands.
    writeFileSync(join(root, 'Top+Page_100.html'), page('Top Page'));
    // Two HTML pages buried in NON-attachment subfolders (one nested two deep).
    mkdirSync(join(root, 'subteam'));
    writeFileSync(join(root, 'subteam', 'Nested+One_200.html'), page('Nested One'));
    mkdirSync(join(root, 'archive', 'deep'), { recursive: true });
    writeFileSync(join(root, 'archive', 'deep', 'Nested+Two_300.html'), page('Nested Two'));
    // Real attachment dir: an HTML file here is legitimately an attachment, so it
    // is NOT imported as a page — but it must still be accounted for as a skipped
    // row, never vanished. The loose .txt attachment stays silent.
    mkdirSync(join(root, 'attachments'));
    writeFileSync(join(root, 'attachments', 'template_9.html'), page('Attachment Fragment'));
    writeFileSync(join(root, 'attachments', 'notes.txt'), 'loose attachment notes');
    mkdirSync(join(root, 'images'));
    writeFileSync(join(root, 'images', 'diagram.png'), 'not really a png');

    const summary = store.runImport(marc.id, { source: 'confluence', path: root, collectionId: collection.id });

    // Read the run back through the receipt path the view renders from.
    const run = store.getImportRun(marc.id, summary.runId);
    const item = (file: string) => run.items.find((i) => i.file === file);

    // Each nested page is a skipped row with a human reason and no page — not
    // imported (Confluence keeps pages flat), but never vanished either.
    for (const file of ['subteam/Nested+One_200.html', 'archive/deep/Nested+Two_300.html']) {
      const nested = item(file);
      assert.ok(nested, `the nested page ${file} has a row in the read-back receipt`);
      assert.equal(nested.outcome, 'skipped', `${file} is skipped, never dropped`);
      assert.equal(nested.pageId, null, `${file} makes no page`);
      assert.match(nested.reason ?? '', /subfolder/i, `${file} explains it sat in a subfolder`);
    }

    // The one real top-level page still imports.
    assert.equal(item('Top+Page_100.html')?.outcome, 'imported');

    // The HTML file in attachments/ is now a skipped row — NOT imported as a page
    // (its content is unchanged: no page lands), but never silently vanished.
    const attachmentHtml = item('attachments/template_9.html');
    assert.ok(attachmentHtml, 'the attachment HTML has a row in the read-back receipt');
    assert.equal(attachmentHtml.outcome, 'skipped', 'attachment HTML is skipped, not imported');
    assert.equal(attachmentHtml.pageId, null, 'the attachment HTML makes no page');

    // Non-HTML inside subfolders stays silent: the loose .txt attachment and the
    // image are genuine assets, so what actually imports is unchanged.
    assert.equal(item('attachments/notes.txt'), undefined, 'a loose non-HTML attachment stays silent');
    assert.equal(item('images/diagram.png'), undefined, 'a real asset stays silent');

    // The header reconciles: found is the true input total (1 imported + 2 nested
    // skips + 1 attachment HTML skip), and nothing is an anonymous "+N".
    const { found, imported, updated, skipped, failed } = run.counts;
    assert.equal(found, imported + updated + skipped + failed, 'the receipt header reconciles');
    assert.equal(imported, 1);
    assert.equal(skipped, 3, 'both nested pages and the attachment HTML are counted as skipped');
    assert.equal(found, 4, 'every HTML page the user handed in is in the total');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The round-5 scan only reached subfolders that were NOT export-support dirs, so
// an HTML page a records manager zipped into `images/` or `assets/` vanished with
// no receipt row — not imported, not skipped, not counted. An HTML file in a
// rendering-asset folder is not an asset; it is a misfiled page, and the record
// must account for it exactly like any other subfolder page. `attachments/` HTML
// is a genuine attachment: it is not imported as a page, but it too gets a
// skipped row — no directory name is exempt from the account-for-it invariant.
test('import: HTML pages inside asset-named subfolders (images/, assets/) get a skipped row, not silence', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-assetdir-'));
  try {
    const page = (title: string) =>
      `<html><head><title>${title}</title></head><body><p>Readable content for ${title}.</p></body></html>`;
    // One real top-level page.
    writeFileSync(join(root, 'Top+Page_100.html'), page('Top Page'));
    // HTML pages zipped into export-support (asset) folders: these used to vanish.
    mkdirSync(join(root, 'images'));
    writeFileSync(join(root, 'images', 'Zipped+In+Images_200.html'), page('Zipped In Images'));
    writeFileSync(join(root, 'images', 'diagram.png'), 'not really a png'); // a real asset: stays silent
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'Zipped+In+Assets_300.html'), page('Zipped In Assets'));
    // attachments/: an HTML file here is a genuine attachment — not imported as a
    // page, but still recorded as a skipped row so it can never vanish.
    mkdirSync(join(root, 'attachments'));
    writeFileSync(join(root, 'attachments', 'template_9.html'), page('Attachment Fragment'));

    const summary = store.runImport(marc.id, { source: 'confluence', path: root, collectionId: collection.id });
    const run = store.getImportRun(marc.id, summary.runId);
    const item = (file: string) => run.items.find((i) => i.file === file);

    // Each asset-folder HTML page is now a persisted skipped row — never dropped.
    for (const file of ['images/Zipped+In+Images_200.html', 'assets/Zipped+In+Assets_300.html']) {
      const row = item(file);
      assert.ok(row, `the asset-folder page ${file} has a row in the read-back receipt`);
      assert.equal(row.outcome, 'skipped', `${file} is skipped, never dropped`);
      assert.equal(row.pageId, null, `${file} makes no page`);
      // The app.js flat-hierarchy note keys on a "subfolder" HTML skip reason, so
      // the receipt row and the note stay in step.
      assert.match(row.reason ?? '', /subfolder/i, `${file} explains it sat in a subfolder`);
    }

    // The one real top-level page still imports.
    assert.equal(item('Top+Page_100.html')?.outcome, 'imported');

    // The real asset (the PNG) stays silent: it is not HTML, so importing nothing
    // from it changes nothing.
    assert.equal(item('images/diagram.png'), undefined, 'a real asset stays silent');

    // The attachment HTML is NOT imported as a page, but it is recorded as a
    // skipped row (no directory-name exception) so it can never vanish.
    const attachmentHtml = item('attachments/template_9.html');
    assert.ok(attachmentHtml, 'attachments/ HTML has a row in the read-back receipt');
    assert.equal(attachmentHtml.outcome, 'skipped', 'attachment HTML is skipped, not imported');
    assert.equal(attachmentHtml.pageId, null, 'the attachment HTML makes no page');

    // Every HTML page reconciles: 1 imported + 2 asset-folder skips + 1 attachment
    // HTML skip = 4 found.
    const { found, imported, updated, skipped, failed } = run.counts;
    assert.equal(found, imported + updated + skipped + failed, 'the receipt header reconciles');
    assert.equal(imported, 1);
    assert.equal(skipped, 3, 'both asset-folder HTML pages and the attachment HTML are skipped');
    assert.equal(found, 4, 'no HTML page is an anonymous "+N"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Round 6 of the recurring bug: HTML zipped into `attachments/` vanished from the
// receipt with no row, because that one directory name was special-cased to be
// scanned in silence. The structural fix removes ALL directory-name exceptions:
// an HTML file in attachments/ is still not imported as a page (importing it would
// change what actually lands), but it is now accounted for as a skipped row so it
// can never disappear. A real non-HTML attachment beside it stays silent.
test('import: HTML inside attachments/ is a skipped row (not imported, not vanished); a real attachment stays silent', () => {
  const { store, marc, collection } = setup();
  const root = mkdtempSync(join(tmpdir(), 'canon-import-attachments-'));
  try {
    const page = (title: string) =>
      `<html><head><title>${title}</title></head><body><p>Readable content for ${title}.</p></body></html>`;
    // One real top-level page.
    writeFileSync(join(root, 'Top+Page_100.html'), page('Top Page'));
    // attachments/: one HTML file (the round-6 vanisher) plus a genuine non-HTML
    // attachment. The HTML must surface as a skipped row; the PDF must stay silent.
    mkdirSync(join(root, 'attachments'));
    writeFileSync(join(root, 'attachments', 'Attached+Doc_9.html'), page('Attached Doc'));
    writeFileSync(join(root, 'attachments', 'contract.pdf'), '%PDF-1.4 not really a pdf');

    const summary = store.runImport(marc.id, { source: 'confluence', path: root, collectionId: collection.id });
    const run = store.getImportRun(marc.id, summary.runId);
    const item = (file: string) => run.items.find((i) => i.file === file);

    // The HTML attachment is a persisted skipped row with a reason and NO page —
    // it is not imported (what actually lands is unchanged) but never vanishes.
    const attachmentHtml = item('attachments/Attached+Doc_9.html');
    assert.ok(attachmentHtml, 'the attachment HTML has a row in the read-back receipt');
    assert.equal(attachmentHtml.outcome, 'skipped', 'the attachment HTML is skipped, never dropped');
    assert.equal(attachmentHtml.pageId, null, 'the attachment HTML makes no page');
    assert.ok((attachmentHtml.reason ?? '').length > 0, 'the skip carries a human reason');
    assert.match(attachmentHtml.reason ?? '', /attach/i, 'the reason names it as an attachment');

    // The one real top-level page still imports.
    assert.equal(item('Top+Page_100.html')?.outcome, 'imported');

    // The genuine non-HTML attachment stays silent: no row, nothing changes.
    assert.equal(item('attachments/contract.pdf'), undefined, 'a real non-HTML attachment stays silent');

    // The header reconciles against the TRUE HTML count: 1 imported + 1 attachment
    // HTML skip = 2 found, and nothing is an anonymous "+N".
    const { found, imported, updated, skipped, failed } = run.counts;
    assert.equal(found, imported + updated + skipped + failed, 'the receipt header reconciles');
    assert.equal(imported, 1);
    assert.equal(skipped, 1, 'the attachment HTML is the one skipped row');
    assert.equal(found, 2, 'every HTML file the user handed in is in the total');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

    // 404, not 403: a run id is caller-supplied and therefore guessable, so a
    // run in a collection the asker holds no role in answers exactly as a run
    // that does not exist (SECURITY.md R4).
    const outsider = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Outsider' })).json;
    const denied = await call('GET', `/imports/${posted.json.runId}`, outsider.id);
    assert.equal(denied.status, 404);
    assert.equal(denied.json.error, missing.json.error);

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

// ---------------------------------------------------------------------------
// The carry-in: who owns what an import lands (USER-TESTING-ROUND-7.md,
// "Migration"). "All 9 imported pages landed with Owner —, Approver —, Review
// due — in nobody's queue. A migration silently produces unowned content,
// which is how a source of record decays."
//
// The answer is a per-RUN question asked once, and the half a run may not
// answer — an effective date, which is a fact about each document — left blank
// and NAMED per file, rather than filled in with a plausible guess.

test('import: a run names an owner, an approver and a review date once, and every page carries them', () => {
  const { store, dana, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
    type: 'spec',
    fields: { ownerId: dana.id, approverId: marc.id, reviewDate: '2099-03-01' },
  });

  assert.deepEqual(summary.fields, { ownerId: dana.id, approverId: marc.id, reviewDate: '2099-03-01' });
  const imported = summary.files.filter((f) => f.outcome === 'imported');
  assert.equal(imported.length, 2);
  for (const file of imported) {
    // A Spec needs an owner and a named approver and nothing else, so a run
    // that supplies both PUBLISHES — which is the behaviour the old
    // `requiresApprover` shortcut could never reach, whatever it was told.
    assert.equal(file.published, true, `${file.file} should have published`);
    assert.equal(file.reason, null);
    const page = store.getPage(marc.id, file.pageId!);
    assert.equal(page.status, 'draft', 'an import never grants the Canonical mark');
    assert.equal(page.ownerId, dana.id, 'the owner the run named, not the importer');
    assert.equal(page.approverId, marc.id);
    assert.equal(page.reviewDate, '2099-03-01');
  }
});

test('import: a policy run says which field is still missing, and keeps the body in the draft', () => {
  const { store, dana, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
    type: 'policy',
    fields: { ownerId: dana.id, approverId: marc.id, reviewDate: '2099-03-01' },
  });

  const imported = summary.files.filter((f) => f.outcome === 'imported');
  assert.equal(imported.length, 2);
  for (const file of imported) {
    assert.equal(file.published, false);
    // Named, and only the one that is actually absent. The effective date is
    // the day a policy began to apply — a fact about the document, which no
    // run may state for two hundred of them at once.
    assert.match(file.reason ?? '', /needs an effective date before it can publish/);
    assert.doesNotMatch(file.reason ?? '', /named approver/, 'the run supplied one; it must not be reported missing');
    const page = store.getPage(marc.id, file.pageId!);
    assert.equal(page.currentVersion, null);
    const draft = store.getDraft(marc.id, page.id)!;
    assert.equal(draft.fields.ownerId, dana.id);
    assert.equal(draft.fields.approverId, marc.id);
    assert.equal(draft.fields.reviewDate, '2099-03-01');
    assert.ok(draft.body.length > 0, 'the body waits in the draft where a person can finish it');
  }
});

test('import: a run cannot name a field the type does not carry', () => {
  const { store, dana, marc, collection } = setup();
  const note = expectCode(
    () =>
      store.runImport(marc.id, {
        source: 'confluence',
        path: CONFLUENCE_FLAT,
        collectionId: collection.id,
        type: 'note',
        fields: { ownerId: dana.id },
      }),
    'invalid',
  );
  assert.match(note.message, /A note carries no owner/);

  const approver = expectCode(
    () =>
      store.runImport(marc.id, {
        source: 'confluence',
        path: CONFLUENCE_FLAT,
        collectionId: collection.id,
        type: 'plan',
        fields: { approverId: dana.id },
      }),
    'invalid',
  );
  assert.match(approver.message, /A plan names no approver/);

  const shape = expectCode(
    () =>
      store.runImport(marc.id, {
        source: 'confluence',
        path: CONFLUENCE_FLAT,
        collectionId: collection.id,
        type: 'spec',
        fields: { reviewDate: 'next March' },
      }),
    'invalid',
  );
  assert.match(shape.message, /ISO date/);
});

test('import: an owner who does not exist refuses the run before a single page is created', () => {
  const { store, marc, collection } = setup();
  expectCode(
    () =>
      store.runImport(marc.id, {
        source: 'confluence',
        path: CONFLUENCE_FLAT,
        collectionId: collection.id,
        type: 'spec',
        fields: { ownerId: 'nobody-at-all' },
      }),
    'not_found',
  );
  // Nothing landed, and no run record was opened: a mistyped id costs the
  // operator a retry, not two hundred half-imported pages.
  assert.equal(store.tree(marc.id, collection.id).length, 0);
  assert.equal(store.listImportRuns(marc.id).length, 0);
});

test('import: the run record keeps the fields it applied, so a re-run can repeat them', () => {
  const { store, dana, marc, collection } = setup();
  const summary = store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
    type: 'spec',
    fields: { ownerId: dana.id, approverId: marc.id, reviewDate: '2099-03-01' },
  });

  const recalled = store.getImportRun(marc.id, summary.runId);
  assert.deepEqual(recalled.fields, summary.fields);
  const listed = store.listImportRuns(marc.id).find((r) => r.runId === summary.runId)!;
  assert.deepEqual(listed.fields, summary.fields);
});

test('import: the run’s ownership decision is on the audit log, once, before the work', () => {
  const { store, dana, marc, collection } = setup();
  store.runImport(marc.id, {
    source: 'confluence',
    path: CONFLUENCE_FLAT,
    collectionId: collection.id,
    type: 'spec',
    fields: { ownerId: dana.id, approverId: marc.id, reviewDate: '2099-03-01' },
  });
  const start = store.queryAudit(marc.id, { action: 'import.start' });
  assert.equal(start.length, 1);
  assert.equal(start[0]!.details.ownerId, dana.id);
  assert.equal(start[0]!.details.approverId, marc.id);
  assert.equal(start[0]!.details.reviewDate, '2099-03-01');
});

test('abilities: aiming an import is `admin` on the collection, and the screen is told so', () => {
  const { store, dana, marc, collection } = setup();
  // Marc administers this collection (see `setup`), Dana created it.
  assert.equal(store.collectionAbilities(marc.id, collection.id).runImport.can, true);

  const kit = store.createActor({ kind: 'person', name: 'Kit', email: 'kit@example.com' });
  store.setMember(dana.id, collection.id, kit.id, 'edit');
  const hers = store.collectionAbilities(kit.id, collection.id).runImport;
  assert.equal(hers.can, false, 'edit is not enough to aim an import');
  assert.match(hers.why!, /Importing needs the admin role on Member Benefits/);
  assert.match(hers.why!, /you hold edit there/);

  // A mirror, not a second rule: what it reports refused, the server refuses,
  // in the same words.
  const refused = expectCode(
    () => store.runImport(kit.id, { source: 'confluence', path: CONFLUENCE_FLAT, collectionId: collection.id }),
    'forbidden',
  );
  assert.equal(refused.message, hers.why);

  // And an org administrator holding no role here is refused too — the ability
  // must not borrow `addMember`'s break-glass, which the importer does not have.
  const ade = store.createActor({ kind: 'person', name: 'Ade', email: 'ade@example.com' });
  store.setMember(dana.id, collection.id, ade.id, 'view');
  store.bootstrapAdministrator(ade.id);
  const theirs = store.collectionAbilities(ade.id, collection.id);
  assert.equal(theirs.addMember.can, true, 'the break-glass path for membership is unchanged');
  assert.equal(theirs.runImport.can, false);
  expectCode(
    () => store.runImport(ade.id, { source: 'confluence', path: CONFLUENCE_FLAT, collectionId: collection.id }),
    'forbidden',
  );
});
