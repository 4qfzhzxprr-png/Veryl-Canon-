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

/** Same walk as findPublicFile, for a file under server/src — the tests run
 *  from dist, so nothing under src is at a fixed offset from them. */
function findSourceFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'src', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/src/${name} not found above the compiled test file`);
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

test('review change: the approver handoff is named, not counted (fourth round, Lena)', () => {
  // Alias change plus a new approver used to read "2 changed fields" here
  // while the version compare said "1 field changed" — the compare reads
  // published versions and the handoff lives in the draft, so both were
  // right and the pair read as a contradiction. The banner now says what the
  // second change is; the field row below still names the person.
  const handedOver = { ...pendingDraft, fields: { ...v2.fields, approverId: 'omar' } };
  const change = summarizeChange(
    { title: v2.title, currentVersion: 2, current: v2, lastCanonical: v1, references: [] },
    handedOver,
  );
  assert.deepEqual(change.fields.map((f) => f.label), ['Approver', 'Also known as'], 'the row list keeps both');
  const sentence = changeSentence(change);
  assert.match(sentence, /1 changed field, and a new approver/);
  assert.doesNotMatch(sentence, /2 changed fields/);
  // A handoff with nothing else changed says only that.
  const handoffOnly = summarizeChange(
    { title: v1.title, currentVersion: 1, current: v1, lastCanonical: v1, references: [] },
    { title: v1.title, body: v1.body, fields: { ...v1.fields, approverId: 'omar' } },
  );
  assert.match(changeSentence(handoffOnly), /No change to the body, and a new approver/);
});

test('approve dialog: the typed note survives "Show me the changes" (fourth round, Lena)', () => {
  // The diff button closes the dialog on purpose — the diff is the page
  // behind it — but closing used to discard the typed note, so reading the
  // changes cost a re-type. The note is stashed as it is typed and handed
  // back into the reopened dialog's input.
  const handler = source.slice(
    source.indexOf('let approveNoteDraft'),
    source.indexOf("app.querySelector('#act-sendback')"),
  );
  assert.match(handler, /value="\$\{esc\(approveNoteDraft\)\}"/, 'the reopened dialog starts from the stash');
  assert.match(handler, /addEventListener\('input', \(\) => \{ approveNoteDraft = modal\.form\.note\.value; \}\)/,
    'stashed as typed, so every way out of the dialog keeps it');
  assert.match(handler, /approveNoteDraft = ''; \/\/ consumed/, 'and the approval that uses it clears it');
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
// Submitting for review is confirmed, with the approver in the confirmation
// (third round, finding 9): the one fact the click commits to is who signs.

const approverOptionsHTML = new Function(
  'state',
  'esc',
  `${lift('approverOptionsHTML')}\nreturn approverOptionsHTML;`,
)(
  {
    actors: [
      { id: 'lena', name: 'Lena Sørensen' },
      { id: 'omar', name: 'Omar Haddad' },
      { id: 'priya', name: 'Priya Nair' },
    ],
  },
  (s: string) => s,
) as (approvers: { actorId: string }[] | null, selected: string | null) => string;

const submitDialogBodyHTML = new Function(
  `${lift('submitDialogBodyHTML')}\nreturn submitDialogBodyHTML;`,
)() as (namesApprover: boolean, optionsHTML: string) => string;

test('submit dialog: the named approver is shown, changeable, and approve-holders only', () => {
  const options = approverOptionsHTML([{ actorId: 'lena' }, { actorId: 'omar' }], 'lena');
  const html = submitDialogBodyHTML(true, options);
  assert.match(html, /<select name="approverId" required>/, 'the choice is explicit, never implied');
  assert.match(html, /value="lena" selected/, 'the draft’s current approver is what the dialog opens on');
  assert.match(html, /Omar Haddad/, 'and the alternatives are on offer where the click is');
  assert.doesNotMatch(html, /Priya Nair/, 'somebody without the approve role is not an alternative');
  // The consequence of the name, said where the name is chosen.
  assert.match(html, /Nobody else can\s+accept it/);
});

test('submit dialog: a type that names no approver confirms without inventing a field', () => {
  const html = submitDialogBodyHTML(false, '');
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /any of them may accept it or send it back/);
});

test('submit dialog: a named approver who lost the role is kept, and says so', () => {
  const options = approverOptionsHTML([{ actorId: 'omar' }], 'lena');
  assert.match(options, /Lena Sørensen \(no longer holds approve\)/);
});

test('submit: both roads go through the dialog, and the corrected name lands in the draft first', () => {
  // The dialog writes the chosen approver into the draft BEFORE submitting, so
  // the reviewState the server publishes can only name the person the dialog
  // showed. Order of the two calls is the property.
  const dialog = source.slice(
    source.indexOf('async function openSubmitReviewDialog('),
    source.indexOf('async function viewEditor('),
  );
  const put = dialog.indexOf("api('PUT', `/pages/${page.id}/draft`");
  const post = dialog.indexOf("api('POST', `/pages/${page.id}/submit`");
  assert.ok(put !== -1 && post !== -1 && put < post);

  // Neither Submit button posts directly any more: one unconfirmed click was
  // the defect, so its absence is what is pinned.
  const pageButton = source.slice(source.indexOf("app.querySelector('#act-submit')"), source.indexOf("app.querySelector('#act-approve')"));
  assert.match(pageButton, /openSubmitReviewDialog\(/);
  assert.doesNotMatch(pageButton, /api\('POST'/);
  const editorButton = source.slice(source.indexOf("app.querySelector('#ed-submit')"), source.indexOf("app.querySelector('#ed-discard')"));
  assert.match(editorButton, /openSubmitReviewDialog\(/);
  assert.doesNotMatch(editorButton, /api\('POST'/);
  assert.ok(editorButton.indexOf('await save()') < editorButton.indexOf('openSubmitReviewDialog('), 'the dialog reads the saved draft, not the stale form');
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
  // Scoped to the reader, not to the record: the result set was already
  // narrowed to their collections, so "nothing in the record" was a claim the
  // search could not make. It deliberately does NOT report a hidden-match
  // count — search takes an arbitrary term, and a count would be an oracle.
  assert.match(wire, /Nothing you can see matches\.<\/div>\$\{searchScopeHTML\(true\)\}/);
  assert.doesNotMatch(wire, /Nothing in the record matches/);
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

// ---------------------------------------------------------------------------
// The editor when a save fails (USER-TESTING.md, third round, finding 7).
//
// The server refuses an out-of-bounds alias list atomically and correctly; the
// defect was the editor's account of it. The only trace was a toast, so a save
// that failed looked exactly like a save that happened — "Draft saved 14:02"
// stood over work the server had thrown away, and navigating off lost it. What
// is pinned here: the failure leaves a persistent, assistive-technology-visible
// trace; the save-state line is corrected in place; and the alias field warns
// about the server's bounds while they are still being typed.

const aliasFieldNotice = new Function(
  'ALIAS_MAX_NAMES', 'ALIAS_MAX_LENGTH', 'ALIAS_COUNTER_FROM',
  `${lift('aliasFieldNotice')}\nreturn aliasFieldNotice;`,
)(20, 64, 15) as (value: string) => { counter: string; problems: string[] };

test('editor: the alias field stays quiet while the list is unremarkable', () => {
  const { counter, problems } = aliasFieldNotice('urgent claims, COB, dual coverage');
  assert.equal(counter, '');
  assert.deepEqual(problems, []);
});

test('editor: the counter appears as the list approaches the ceiling', () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => `name ${i}`).join(', ');
  assert.equal(aliasFieldNotice(fifteen).counter, '15 of 20 names');
  const fourteen = Array.from({ length: 14 }, (_, i) => `name ${i}`).join(', ');
  assert.equal(aliasFieldNotice(fourteen).counter, '', 'a short list is not decorated with arithmetic');
});

test('editor: a name past 64 characters is named as the save-sinker it will be, before the save', () => {
  const long = 'x'.repeat(65);
  const { problems } = aliasFieldNotice(`COB, ${long}`);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /65 characters/);
  assert.match(problems[0]!, /at most 64/, 'the limit itself is in the sentence');
  assert.match(problems[0]!, /Saving will fail/, 'and so is the consequence');
});

test('editor: a list past 20 names warns with the limit, before the save', () => {
  const many = Array.from({ length: 21 }, (_, i) => `name ${i}`).join(', ');
  const { problems } = aliasFieldNotice(many);
  assert.ok(problems.some((p) => /at most 20/.test(p) && /Saving will fail/.test(p)));
});

const editorSaveFailure = new Function(`${lift('editorSaveFailure')}\nreturn editorSaveFailure;`)() as (
  err: { status?: number; message?: string; details?: { editorName?: string } },
) => { alert: string; saveState: string };

test('editor: a failed save says NOT saved with the server’s sentence, and corrects the save-state line', () => {
  const failure = editorSaveFailure({ status: 400, message: 'A page carries at most 20 aliases' });
  assert.match(failure.alert, /NOT saved/);
  assert.match(failure.alert, /A page carries at most 20 aliases/, 'the server’s own sentence, not a paraphrase');
  assert.match(failure.saveState, /Saving failed/);
  assert.doesNotMatch(failure.saveState, /Draft saved/, 'the line that vouched for lost work never survives a failure');
  // The lock case still names the other editor.
  const locked = editorSaveFailure({ status: 423, details: { editorName: 'Priya Nair' } });
  assert.match(locked.alert, /Priya Nair/);
});

test('editor: the failure trace is persistent and assistive-technology visible, and success clears it', () => {
  const editor = source.slice(source.indexOf('async function viewEditor('), source.indexOf('async function renderEditorReferences('));
  // The region exists, announces itself, and starts empty.
  assert.match(editor, /id="editor-alert"[^>]*role="alert"[^>]*aria-live="assertive"[^>]*hidden/);
  // Every failure path fills it (markSaveFailed is what handleEditError and the
  // publish dialog share), and only a successful save empties it.
  assert.match(editor, /function markSaveFailed\(err\)/);
  assert.match(editor, /markSaveFailed\(err\); throw err;/, 'the publish dialog’s save failure marks the editor behind it too');
  const save = editor.slice(editor.indexOf('const save = async'), editor.indexOf('form.addEventListener'));
  assert.match(save, /editorAlert\.hidden = true/, 'the alert outlives everything except an actual save');
  assert.match(save, /Draft saved/, 'and only that path writes "Draft saved"');
  assert.equal((editor.match(/Draft saved \$\{/g) ?? []).length, 1, 'no other line can claim a save happened');
  // The alias field is wired to the validator as it is typed.
  assert.match(editor, /form\.aliases\.addEventListener\('input', syncAliasNotice\)/);
  assert.match(editor, /aria-live="polite"/, 'the live counter is announced without stealing focus');
});

// ---------------------------------------------------------------------------
// Alias collisions (third round, Priya): the save's warnings, rendered where
// the field is and kept there.

const aliasWarningsHTML = new Function(
  'esc',
  `${lift('aliasWarningsHTML')}\nreturn aliasWarningsHTML;`,
)((x: string) => String(x).replace(/[<>]/g, '')) as (warnings: string[] | undefined) => string;

test('editor: collision warnings render under the alias field, and none renders nothing', () => {
  const html = aliasWarningsHTML(['The name “COB” is also carried by “Coordination of benefits” in this collection.']);
  assert.match(html, /also carried by “Coordination of benefits”/);
  assert.match(html, /steers search and Ask toward both pages/, 'the consequence is stated, not just the fact');
  assert.equal(aliasWarningsHTML([]), '');
  assert.equal(aliasWarningsHTML(undefined), '', 'an older server that sends no warnings breaks nothing');

  // Wired to both moments a warning can arrive: the lock-acquiring load and
  // every subsequent save — replaced wholesale, so a resolved collision stops
  // being claimed.
  const editor = source.slice(source.indexOf('async function viewEditor('), source.indexOf('async function renderEditorReferences('));
  assert.match(editor, /id="alias-warnings"/);
  assert.equal((editor.match(/#alias-warnings'\)\.innerHTML = aliasWarningsHTML\(/g) ?? []).length, 2);
});

test('editor: the alias field speaks to every collection, not just claims', () => {
  // Ada read "e.g. urgent claims, COB" in an HR collection and concluded the
  // field was not for her. The examples were the finding: a placeholder that
  // names one domain excludes the rest, so the copy names what the field IS
  // and the help line says what it does.
  const editor = source.slice(source.indexOf('async function viewEditor('), source.indexOf('async function renderEditorReferences('));
  assert.doesNotMatch(editor, /placeholder="e\.g\. urgent claims, COB"/);
  assert.match(editor, /placeholder="other names people use for this subject"/);
  assert.match(editor, /Searchable names people actually use/);
});

test('editor: the alias caption says when a name starts working, truthfully', () => {
  // "They steer search and Ask … once approved" was wrong in the half that
  // matters: a published alias steers search AT ONCE, badged with the page's
  // standing so nothing passes as official, and only Ask's official answers
  // wait for the Canonical mark (fourth round, Ruth and Priya). The caption
  // now states both moments, and the false one is pinned out.
  const editor = source.slice(source.indexOf('async function viewEditor('), source.indexOf('async function renderEditorReferences('));
  assert.doesNotMatch(editor, /once approved/);
  assert.match(editor, /steer search to this page as soon as they publish/);
  assert.match(editor, /badged with the page's standing/);
  assert.match(editor, /official answers use them only while the page holds the Canonical mark/);
});

// ---------------------------------------------------------------------------
// A body links to a page the reader may not open (3.9)
//
// A body is prose, and prose names things. A page written by somebody with
// wider access can say "superseded by [Q3 Workforce Reduction Plan](/pages/…)"
// and Canon shows that sentence verbatim to every reader of THIS page. The
// title of a page they were refused, handed to them in the body of one they
// were granted.
//
// The link is the findable half — it carries a page id, so the id can be tested
// against the reader like any other read. These pin the renderer's side of that:
// the label goes with the link, both link forms are covered, and the editor's
// own preview is never touched.

test('body links: a withheld link loses its label and its href', () => {
  const fn = source.slice(source.indexOf('function mdInline('), source.indexOf('function diffLines('));
  // The label is the leak — it is where the author typed the title.
  assert.match(fn, /withheldLinkIds\.has\(linked\[1\]\)/);
  assert.match(fn, /return WITHHELD_LINK_HTML/);
  // And the wiki form, which carries the bare id.
  assert.match(fn, /\\\[\\\[/);
});

test('body links: the withheld phrase names no page and offers no link', () => {
  const html = source.slice(source.indexOf('const WITHHELD_LINK_HTML'), source.indexOf('function mdInline('));
  assert.match(html, /a page you do not have access to/);
  // Not an anchor, and nothing to click through to.
  assert.doesNotMatch(html, /<a\s/);
  assert.doesNotMatch(html, /href=/);
});

test('body links: the renderer and the server agree on what a link is', () => {
  // The server decides which ids are withheld using retrieval.ts PAGE_LINK; the
  // renderer matches hrefs with PAGE_LINK_HREF. If they disagree, the renderer
  // either redacts something never checked or misses one that was — so the id
  // shape is pinned to the same floor in both.
  const client = source.slice(source.indexOf('const PAGE_LINK_HREF'), source.indexOf('const WITHHELD_LINK_HTML'));
  assert.match(client, /A-Za-z0-9_-\]\{5,\}/);
  const retrieval = readFileSync(findSourceFile('retrieval.ts'), 'utf8');
  assert.match(retrieval, /A-Za-z0-9_-\]\{5,\}/);
});

test('body links: the editor preview renders what the author typed', () => {
  // withWithheldLinks is scoped and set only around a SERVED body. An author
  // editing their own page sees their own text — redacting a draft in the
  // preview would show them a hole where their link is and invite them to
  // "fix" it.
  const preview = source.slice(source.indexOf('const preview ='), source.indexOf('const preview =') + 2000);
  assert.doesNotMatch(preview, /withWithheldLinks/);
});

// ---------------------------------------------------------------------------
// The comment loop's client half (Phase 4)
//
// The mention machinery was complete and had no usable address: `@<actorId>`
// was the only form the server accepted, an actor id is a UUID, and the
// composer was a bare textarea that said nothing about any of it.

test('comments: the composer says who can be mentioned, and inserting one works', () => {
  const hint = source.slice(source.indexOf('function mentionHintHTML('), source.indexOf('async function mentionableIn('));
  assert.match(hint, /Mention someone with/);
  // A hint you cannot act on is a smaller version of the same problem.
  assert.match(hint, /data-mention=/);
  assert.match(hint, /setSelectionRange/);
});

test('comments: the names offered are the collection members, not the directory', () => {
  // The server resolves a name against the collection's members only — so
  // offering anybody else would be a promise the server then breaks, and would
  // make the directory probeable one chip at a time.
  const fn = source.slice(source.indexOf('async function mentionableIn('), source.indexOf('async function renderCommentsPanel('));
  assert.match(fn, /\/collections\/\$\{collectionId\}\/members/);
  // And never yourself: an author is never notified about their own comment.
  assert.match(fn, /state\.actor\?\.id/);
});

test('comments: a failed member lookup costs the hint, never the comment box', () => {
  const fn = source.slice(source.indexOf('async function mentionableIn('), source.indexOf('async function renderCommentsPanel('));
  assert.match(fn, /catch \{\s*return \[\];/);
});

// ---------------------------------------------------------------------------
// Resolving a comment (Phase 4)
//
// `POST /comments/:id/resolve` and `/reopen` have existed since resolve was
// written, and `resolved_at`/`resolved_by` are stored — but nothing rendered a
// button, so the send-back banner's promise that a comment "can be replied to
// and resolved" was half true. A conversation that cannot be closed stays open
// on the page forever.

test('comments: resolve and reopen are reachable, and gated on the comment role', () => {
  const fn = source.slice(source.indexOf('function commentResolutionHTML('), source.indexOf('/**\n * Who this reader can mention'));
  assert.match(fn, /data-resolve=/);
  assert.match(fn, /data-reopen=/);
  // A reader who cannot comment sees the state and no buttons — the same gate
  // the server applies, so the UI never offers what the server will refuse.
  assert.match(fn, /if \(!canComment\)/);
});

test('comments: a resolved comment says who closed it and when', () => {
  // The server has carried both since resolve was written; the client dropped
  // them, so "resolved" was a conversation closed by nobody at no time.
  const norm = source.slice(source.indexOf('function normalizeComment('), source.indexOf('async function renderCommentsPanel('));
  assert.match(norm, /resolvedAt: c\.resolvedAt/);
  assert.match(norm, /resolvedBy: c\.resolvedBy/);
  const fn = source.slice(source.indexOf('function commentResolutionHTML('), source.indexOf('/**\n * Who this reader can mention'));
  assert.match(fn, /Resolved\$\{who/);
});

test('comments: a Canon without the resolve routes says so once', () => {
  const wire = source.slice(source.indexOf("data-resolve], [data-reopen]"), source.indexOf("#comment-form')?.addEventListener"));
  assert.match(wire, /404 \|\| err\.status === 405/);
  assert.match(wire, /not available on this Canon yet/);
});

// ---------------------------------------------------------------------------
// An agent's byline says "agent" (Phase 9)
//
// Round seven measured it precisely: the `agent` tag is on Owner, on Approver,
// on comments and on every audit row — everywhere an auditor looks — and
// absent from every line a busy reader passes on the way to the text. Four
// sites rendered `esc(actorName(id))` where the rest of the product renders
// `actorLabel(id)`, and the difference is exactly the tag.
//
// system.ts makes the same claim from the other side: "every surface that
// already renders `agent` beside an actor now has a third case to render,
// which is the point: it shows up everywhere." These four were not showing it
// anywhere, and Canon's own maintenance actor writes into the record.

test('bylines: who wrote a version is drawn with its actor kind, not as a bare name', () => {
  // The page header's Version line.
  const header = source.slice(source.indexOf('<dt>Version</dt>'), source.indexOf('<dt>Version</dt>') + 260);
  assert.match(header, /by \$\{actorLabel\(current\.authorId\)\}/);
  assert.doesNotMatch(header, /actorName\(current\.authorId\)/);

  // The version view's own banner.
  const version = source.slice(source.indexOf('Viewing <strong>v${n}</strong>'), source.indexOf('<h1 class="doc-title">${esc(version.title)}'));
  assert.match(version, /by \$\{actorLabel\(version\.authorId\)\}/);

  // Both column headers of a version-to-version compare.
  const compare = source.slice(source.indexOf('${diffTableHTML(\n        rows,'), source.indexOf('${diffTableHTML(\n        rows,') + 260);
  assert.match(compare, /\$\{actorLabel\(va\.authorId\)\}/);
  assert.match(compare, /\$\{actorLabel\(vb\.authorId\)\}/);

  // And "Submitted by", which is the line an approver reads before deciding.
  const review = source.slice(source.indexOf('function reviewBannerHTML('), source.indexOf('async function viewPage('));
  assert.match(review, /Submitted by \$\{actorLabel\(review\.submittedById\)\}/);
});
