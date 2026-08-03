// The page view's own rules, run against the shipped browser file.
//
// public/app.js cannot be imported — it is an ES module that touches
// `document` at the top level — so the functions under test are lifted out of
// the source that ships, the way answers.test.ts lifts `citationBadge` and
// markdown.test.ts lifts the renderer. What runs here is what a reader gets.
//
// What this file holds is one rule, found the hard way by a compliance
// director reading a policy whose central number a colleague had recorded as
// disputed:
//
//   A PAGE'S STANDING BELONGS WHERE A READER MEETS THE PAGE.
//
// "Somebody who reads the top of the page and stops never learns the number is
// contested. 'This is out of date' and 'this number is disputed' belong in the
// same place, and it isn't the basement." The assertion, its author, their
// reasoning and its date were rendered below the body, below the federated
// values, below everything — while "past review" had a banner above the fold.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

const source = readFileSync(findPublicFile('app.js'), 'utf8');

function lift(name: string): string {
  const found = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(found, `public/app.js declares ${name}()`);
  return found[0];
}

/** A top-level `const NAME = [...]` lifted the same way the functions are. */
function liftConst(name: string): string {
  const found = new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`).exec(source);
  assert.ok(found, `public/app.js declares ${name}`);
  return found[0];
}

interface StandingNote {
  kind: string;
  relation?: { reads: string; other: { title: string } };
}
interface StandingPage {
  status: string;
  reviewDate?: string | null;
}

/** `pageStandingNotes`, with the date helper it leans on, run for real. */
const pageStandingNotes = new Function(
  `${lift('isPastReview')}\n${lift('pageStandingNotes')}\nreturn pageStandingNotes;`,
)() as (page: StandingPage, relations: unknown) => StandingNote[];

const conflict = {
  reads: 'conflicts_with',
  note: 'The schedule keeps claims records for seven years; the spec deletes them at twenty-four months.',
  assertedBy: 'dana',
  assertedAt: '2026-03-04T10:00:00.000Z',
  other: { id: 'spec', title: 'Data Retention in the Platform', status: 'canonical' },
};

test('standing: a contested page says so, whichever end of the conflict it is', () => {
  const notes = pageStandingNotes({ status: 'canonical', reviewDate: '2099-01-01' }, [conflict]);
  assert.deepEqual(notes.map((n) => n.kind), ['contested']);
  // The whole assertion travels with the note: the banner states who said it,
  // what they said and when, which is the material that was in the basement.
  assert.equal(notes[0]!.relation!.other.title, 'Data Retention in the Platform');
});

test('standing: "supersedes" is not a caution about the page you are reading', () => {
  // The relation reads the other way at the other end. Saying "superseded" on
  // the page that does the superseding would warn a reader off the page that is
  // fine, so it stays in the register below with the rest of them.
  const supersedes = pageStandingNotes({ status: 'canonical', reviewDate: '2099-01-01' }, [
    { ...conflict, reads: 'supersedes' },
  ]);
  assert.deepEqual(supersedes, []);
  const supersededBy = pageStandingNotes({ status: 'canonical', reviewDate: '2099-01-01' }, [
    { ...conflict, reads: 'superseded_by' },
  ]);
  assert.deepEqual(supersededBy.map((n) => n.kind), ['superseded']);
});

test('standing: stale and contested are the same block, in one place', () => {
  // The director's sentence, as an assertion: both of these facts are notes on
  // the same list, so neither can drift to the bottom of the page without the
  // other going with it.
  const notes = pageStandingNotes({ status: 'needs_update', reviewDate: '2020-01-01' }, [conflict]);
  assert.deepEqual(notes.map((n) => n.kind), ['needs_update', 'contested']);
});

test('standing: a Canonical page past its review date is stale before the sweep reaches it', () => {
  const notes = pageStandingNotes({ status: 'canonical', reviewDate: '2020-01-01' }, []);
  assert.deepEqual(notes.map((n) => n.kind), ['overdue']);
});

test('standing: a read that failed is never rendered as "nothing is wrong"', () => {
  // loadRelations answers null where this Canon serves no relations or the read
  // failed, and null must produce no notes rather than an empty, reassuring one.
  assert.deepEqual(pageStandingNotes({ status: 'canonical', reviewDate: '2099-01-01' }, null), []);
});

// ---------------------------------------------------------------------------
// The Publish dialog, which used to describe itself entirely by what it is not.

/** `publishDialogBodyHTML`, over stubs for the vocabulary it borrows. */
const publishDialogBodyHTML = new Function(
  'badge',
  'esc',
  'STATUS_LABELS',
  'STATUS_MEANINGS',
  `${lift('publishDialogBodyHTML')}\nreturn publishDialogBodyHTML;`,
)(
  (status: string) => `<badge ${status}>`,
  (s: string) => s,
  { canonical: 'Canonical', needs_update: 'Needs Update', draft: 'Draft' },
  { draft: 'Working material. Nobody has approved it and it is not the record.' },
) as (page: { status: string; currentVersion?: number | null }, reviewed: boolean) => string;

test('publish dialog: it says what the page will be, not only what it will not be', () => {
  const html = publishDialogBodyHTML({ status: 'canonical', currentVersion: 3 }, true);
  // The status the page lands in, in the badge a reader already knows.
  assert.match(html, /<badge draft>/, 'the dialog names the status publishing leaves the page in');
  assert.match(html, /Working material\./, 'and carries what that status means, in the words the key uses');
  // The version it writes, so the act is checkable on the History screen after.
  assert.match(html, /v4/, 'the dialog names the version it is about to write');
  // The mark being given up, where there is one.
  assert.match(html, /Canonical today, and\s+publishing gives that up/);
});

test('publish dialog: a page with no mark is not told it is giving one up', () => {
  const html = publishDialogBodyHTML({ status: 'draft', currentVersion: null }, true);
  assert.match(html, /<strong>v1<\/strong>/, 'a page that has never published writes v1');
  assert.doesNotMatch(html, /gives that up/);
});

test('publish dialog: a Note is told there is no review to send it to', () => {
  const html = publishDialogBodyHTML({ status: 'draft', currentVersion: 1 }, false);
  assert.match(html, /never carries the Canonical mark/);
  assert.doesNotMatch(html, /Submit for review/, 'offering a Note a review it can never have is a broken promise');
});

// ---------------------------------------------------------------------------
// What an approval covers, in front of the person approving.

/** `federatedScopeHTML`, over the helpers it borrows from the reference block. */
const federatedScopeHTML = new Function(
  'esc',
  'clip',
  'normalizeReference',
  'referenceLabel',
  `${lift('federatedScopeHTML')}\nreturn federatedScopeHTML;`,
)(
  (s: string) => s,
  (s: string) => s,
  (r: unknown) => r,
  (r: { label?: string; selector?: string }) => r.label ?? r.selector ?? '',
) as (references: unknown[], nextVersion: number) => string;

const headcount = { label: 'headcount (engineering)', sourceName: 'People System', authMode: 'service' };

test('approval scope: an approver is told the federated values are live', () => {
  const html = federatedScopeHTML([headcount], 2);
  assert.match(html, /Your approval covers the text/);
  // The three facts the approver was missing: it is not stored, it is resolved
  // on every read, and it can move afterwards with nothing attributable to him.
  assert.match(html, /asks its source again every\s+time somebody reads the page/);
  assert.match(html, /no new version, no approval/);
  // And which value it is, with the mode that decides who can see it.
  assert.match(html, /headcount \(engineering\)/);
  assert.match(html, /service-resolved/);
});

test('approval scope: a page with no federated value says nothing about them', () => {
  assert.equal(federatedScopeHTML([], 2), '', 'a disclosure about nothing is furniture');
});

test('approval scope: the count reads as one sentence either way', () => {
  assert.match(federatedScopeHTML([headcount], 2), /One value on this page is live/);
  const two = federatedScopeHTML([headcount, { ...headcount, label: 'open appeals' }], 5);
  assert.match(two, /2 values on this page are live/);
  assert.match(two, /They are\s+page-level and live/, 'the plural sentence agrees with itself');
});

test('approval scope: it is stated before the diff, not after it', () => {
  // An approver who has scrolled a hundred lines of side-by-side text has
  // already decided; the extent of what they are deciding has to precede it.
  const panel = source.slice(source.indexOf('function reviewChangeHTML('), source.indexOf('// USER-TESTING.md T4.3'));
  const scope = panel.indexOf('federatedScopeHTML(');
  const body = panel.indexOf('${body}');
  assert.ok(scope !== -1 && body !== -1 && scope < body);
});

// ---------------------------------------------------------------------------
// What is being approved — diffed against the last version to HOLD the mark
// (third round, finding 1), with fields in the diff as well as prose.

interface ChangeSummary {
  hasBaseline: boolean;
  hasPublished: boolean;
  baselineIsMarked: boolean;
  baseVersion: number | null;
  changed: number | null;
  fields: { label: string; from: string | null; to: string }[];
}

/** The change summary and its sentence, over the helpers they lean on. */
const { summarizeChange, changeSentence, changedFieldRows } = new Function(
  'actorLabel',
  'esc',
  'fmtDate',
  [
    lift('diffLines'),
    lift('changedLines'),
    liftConst('REVIEW_FIELDS'),
    lift('flatField'),
    lift('changedFieldRows'),
    lift('summarizeChange'),
    lift('changeSentence'),
    'return { summarizeChange, changeSentence, changedFieldRows };',
  ].join('\n'),
)(
  (id: string) => id,
  (s: string) => s,
  (v: string | null) => v ?? '—',
) as {
  summarizeChange: (page: Record<string, unknown>, draft: Record<string, unknown>) => ChangeSummary;
  changeSentence: (change: ChangeSummary) => string;
  changedFieldRows: (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    hasBase: boolean,
  ) => { label: string; from: string | null; to: string }[];
};

// Lena's page, as the payload hands it over: v1 held the mark, v2 published
// the alias without review, and the draft under review carries the alias too.
const v1 = {
  number: 1,
  title: 'Coordination of benefits',
  body: 'The primary plan pays first.',
  fields: { ownerId: 'priya', approverId: 'lena', aliases: [] },
};
const v2 = {
  number: 2,
  title: 'Coordination of benefits',
  body: 'The primary plan pays first.',
  fields: { ownerId: 'priya', approverId: 'lena', aliases: ['COB', 'dual coverage'] },
};
const pendingDraft = { title: v2.title, body: v2.body, fields: v2.fields };

test('review change: what published between the mark and the submission is IN the diff', () => {
  const change = summarizeChange(
    { title: v2.title, currentVersion: 2, current: v2, lastCanonical: v1, references: [] },
    pendingDraft,
  );
  // Against the published v2 — the old baseline — this submission looks like
  // nothing at all, which is exactly how the alias was signed unseen. Against
  // the marked v1 it is one changed field, named.
  assert.equal(change.baseVersion, 1);
  assert.deepEqual(change.fields.map((f) => f.label), ['Also known as']);
  assert.match(change.fields[0]!.to, /COB, dual coverage/, 'the list renders joined, one line like any field');
  const sentence = changeSentence(change);
  assert.match(sentence, /1 changed field/);
  // The baseline is stated on screen, in words: an unstated baseline is the
  // hole the whole finding fell through.
  assert.match(sentence, /since v1, the last version to hold the Canonical mark/);
});

test('review change: a page that published without ever earning the mark has no baseline', () => {
  const change = summarizeChange(
    { title: v2.title, currentVersion: 2, current: v2, lastCanonical: null, references: [] },
    pendingDraft,
  );
  assert.equal(change.hasBaseline, false);
  assert.equal(change.hasPublished, true);
  // Not "nothing has been published" — something has, and nobody reviewed it,
  // so the whole of it is what the approver must be shown.
  assert.match(changeSentence(change), /No version of this page has ever held the Canonical mark/);
});

test('review change: a server that names no baseline falls back to the published version, and says so', () => {
  const change = summarizeChange(
    { title: v2.title, currentVersion: 2, current: v2, references: [] },
    pendingDraft,
  );
  assert.equal(change.baselineIsMarked, false);
  assert.equal(change.baseVersion, 2);
  // The sentence claims only what this baseline actually is.
  assert.match(changeSentence(change), /against the published v2/);
  assert.doesNotMatch(changeSentence(change), /to hold the Canonical mark/);
});

// ---------------------------------------------------------------------------
// Version compare — fields are part of a version, so they are part of a diff.

test('compare: an alias-only change is a change, not "identical bodies"', () => {
  const rows = changedFieldRows(v1.fields, v2.fields, true);
  assert.deepEqual(rows.map((r) => r.label), ['Also known as']);
  assert.match(rows[0]!.from!, /none/);
  assert.match(rows[0]!.to, /COB, dual coverage/);
});

test('compare: the view never claims identity while fields differ', () => {
  const view = source.slice(source.indexOf('async function viewCompare('), source.indexOf('// Audit view'));
  assert.match(view, /changedFieldRows\(va\.fields \?\? \{\}, vb\.fields \?\? \{\}, true\)/);
  assert.match(view, /The bodies are identical; /, 'identical bodies with changed fields says which half is identical');
  assert.match(view, /identical in body and fields/, 'and full identity claims both halves');
  assert.doesNotMatch(view, /have identical bodies/, 'the old sentence claimed the whole from the half');
});

// ---------------------------------------------------------------------------
// The sidebar on a narrow screen, and the tree that was kept in a box.

const treeToggleLabel = new Function(`${lift('treeToggleLabel')}\nreturn treeToggleLabel;`)() as (
  count: number,
  open: boolean,
) => string;

test('sidebar: the collapsed control says how many pages are behind it', () => {
  // The count is the control's whole job: "Show the pages" says nothing about
  // whether opening it costs a tap or half a minute of scrolling.
  assert.equal(treeToggleLabel(82, false), 'Show the 82 pages in this collection');
  assert.equal(treeToggleLabel(1, false), 'Show the 1 page in this collection');
  assert.equal(treeToggleLabel(82, true), 'Hide the page list');
});

test('sidebar: the collapse control ships hidden, so no-JS keeps the whole tree', () => {
  const html = source.slice(source.indexOf('function sidebarHTML('), source.indexOf('function treeToggleLabel('));
  assert.match(html, /id="tree-toggle"[\s\S]*?hidden/, 'the toggle is revealed by script, at the width that needs it');
  // And the region it controls holds the tree — collapsing anything else would
  // hide navigation the reader did not ask to hide.
  assert.match(html, /id="sidebar-tools"[\s\S]*?class="tree-nav"/);
});

test('sidebar: a tree too tall for a sticky column stops being a scroll box', () => {
  const wire = source.slice(source.indexOf('function wireSidebar('), source.indexOf('function openNewPageModal('));
  assert.match(wire, /aside\.scrollHeight <= window\.innerHeight - 96/);
  assert.match(wire, /classList\.toggle\('is-long', !fits\)/);
});

// ---------------------------------------------------------------------------
// What search covers, said in the dropdown rather than inferred from it.

const searchScopeHTML = new Function(
  'badge',
  `${lift('searchScopeHTML')}\nreturn searchScopeHTML;`,
)((status: string, size: string) => `<badge ${status} ${size}>`) as (empty: boolean) => string;

test('search: the dropdown states the rule that made a draft body unfindable', () => {
  const note = searchScopeHTML(false);
  assert.match(note, /Titles are searched for every page you can see/);
  assert.match(note, /Bodies are searched only where a\s+version has published/);
  // Statuses go through `badge`, so the dropdown says DRAFT in the same
  // vocabulary and the same casing as the tree and the page header. Writing the
  // words out here is how a second casing gets into the product.
  assert.match(note, /<badge draft sm>/);
  assert.match(note, /<badge in_review sm>/);
});

test('search: "nothing matches" carries the likeliest reason there is nothing', () => {
  // The complaint was that one sentence covered two different facts — the
  // record is silent, and you searched a place the index does not reach.
  assert.match(searchScopeHTML(true), /try its title/);
  assert.doesNotMatch(searchScopeHTML(false), /try its title/, 'advice for a miss does not belong under hits');
  const wire = source.slice(source.indexOf('function wireSearch('), source.indexOf('// Router'));
  assert.match(wire, /Nothing in the record matches\.<\/div>\$\{searchScopeHTML\(true\)\}/);
  assert.match(wire, /searchScopeHTML\(false\)/, 'and it is under the hits too, where it explains a page that did not match');
});

test('standing: the notices are drawn above the body, not below it', () => {
  // The defect was a position, so the position is what is pinned. Everything
  // between the page head and the document body is the standing block; the
  // register below it is the detail, and this asserts the order they appear in
  // the one template that draws them.
  const view = source.slice(source.indexOf('async function viewPage('), source.indexOf('// Federated values'));
  const standing = view.indexOf('pageStandingHTML(page, relations)');
  const body = view.indexOf('<article class="doc-body">');
  const register = view.indexOf('id="relations-host"');
  assert.ok(standing !== -1, 'the page view draws the standing block');
  assert.ok(standing < body, 'a page states its standing above the text somebody is about to rely on');
  assert.ok(body < register, 'the conflicts register stays below the body: it is the detail, not the warning');
});
