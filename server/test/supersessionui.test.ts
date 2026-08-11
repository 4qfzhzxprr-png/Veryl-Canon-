// The Superseded chip, run against the browser file that ships.
//
// `public/app.js` cannot be imported — it is an ES module that touches
// `document` at the top level — so the functions under test are lifted out of
// the shipped source, exactly as pageview.test.ts and markdown.test.ts do.
// What runs here is what a reader gets.
//
// The rule this file holds is the half of REMEDIATION-PLAN.md 1.6 that never
// landed: SUPERSESSION BELONGS WHERE A READER CHOOSES A PAGE, not only on the
// page they chose. Both lists somebody arrives through draw it, from one
// function, so the dropdown and the contents table cannot drift; and the chip
// for a replacement the reader may not see says the page is superseded and
// nothing whatever about the page at the far end.

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

/** A top-level `const NAME = { … };` lifted the way the functions are. */
function liftObject(name: string): string {
  const found = new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`).exec(source);
  assert.ok(found, `public/app.js declares ${name}`);
  return found[0];
}

/** The body of one named function, for asserting what it calls. */
function bodyOf(name: string): string {
  return lift(name);
}

const HELPERS = [
  lift('esc'),
  liftObject('STATUS_LABELS'),
  liftObject('STATUS_MEANINGS'),
  liftObject('TYPE_LABELS'),
  lift('badge'),
  // pageBadge now derives its badge through the shared live-standing helpers, so
  // they travel with it: a page past its review date reads the same on every
  // surface pageBadge feeds (search, the tree, the contents table, the header).
  lift('pageStandingOf'),
  lift('isPastReview'),
  lift('displayedStanding'),
  lift('pageBadge'),
  lift('highlightedSnippet'),
  lift('supersededChipHTML'),
].join('\n');

interface Mark {
  withheld?: true;
  pageId?: string;
  title?: string;
  status?: string;
  answerable?: boolean;
}

const supersededChipHTML = new Function(
  `${HELPERS}\nreturn supersededChipHTML;`,
)() as (mark: Mark | null | undefined) => string;

const searchHitHTML = new Function(
  `${HELPERS}\n${lift('searchHitHTML')}\nreturn searchHitHTML;`,
)() as (hit: Record<string, unknown>, options?: { withCollection?: Map<string, string> | null }) => string;

// The contents table leans on three helpers this file is not about — who owns
// a page, when it is due, how deep it sits — so they are stubbed and the
// things under test (the status cell, the chip) are the real shipped code.
const collectionContentsHTML = new Function(
  `${HELPERS}
   ${lift('flattenTree')}
   function fmtDate(iso) { return String(iso); }
   function actorLabel(id) { return String(id); }
   ${lift('collectionContentsHTML')}
   return collectionContentsHTML;`,
)() as (tree: Record<string, unknown>[]) => string;

const REPLACEMENT: Mark = {
  pageId: 'p-incident',
  title: 'Incident management',
  status: 'canonical',
  answerable: true,
};
const UNANSWERABLE: Mark = {
  pageId: 'p-half-built',
  title: 'Incident management',
  status: 'draft',
  answerable: false,
};
const WITHHELD: Mark = { withheld: true };

// ---------------------------------------------------------------------------
// The chip itself

test('superseded chip: a page nothing replaces draws nothing', () => {
  assert.equal(supersededChipHTML(null), '');
  assert.equal(supersededChipHTML(undefined), '');
});

test('superseded chip: a superseded page says so in one word', () => {
  const html = supersededChipHTML(REPLACEMENT);
  assert.match(html, />Superseded</);
  assert.match(html, /class="badge badge-superseded sm"/);
  // The replacement is named where there is room for it, not in the chip's
  // one word.
  assert.match(html, /Incident management/);
});

test('superseded chip: a replacement not in the record yet says what that means', () => {
  const html = supersededChipHTML(UNANSWERABLE);
  assert.match(html, />Superseded</);
  // The banner's sentence, carried to the surface a reader arrives through:
  // nothing has been approved, and THIS page is still what the record serves.
  assert.match(html, /not part of the official record yet/);
  assert.match(html, /still what the record serves/);
});

test('superseded chip: a withheld replacement is existence, never identity', () => {
  const html = supersededChipHTML(WITHHELD);
  assert.match(html, />Superseded</);
  assert.match(html, /do not have access to/);
  // Nothing about the far page — there is nothing to render, and the chip must
  // not invent a name for it either ("another page" is the visible-title
  // fallback and belongs nowhere near this branch).
  assert.ok(!html.includes('another page'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('null'));
});

test('superseded chip: a replacement title is escaped like every other record value', () => {
  const html = supersededChipHTML({ ...REPLACEMENT, title: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});

// ---------------------------------------------------------------------------
// The two surfaces a reader arrives through

test('search hit: a superseded page is not drawn as a plain status chip', () => {
  const hit = {
    pageId: 'p-runbook',
    title: 'On-call runbook',
    status: 'draft',
    type: 'note',
    snippet: 'Who to call at night.',
    supersededBy: REPLACEMENT,
  };
  const html = searchHitHTML(hit);
  // Both, and in that order: a superseded Draft and a superseded Canonical
  // page are different situations, so the standing is not replaced by the
  // chip.
  assert.match(html, />Draft</);
  assert.match(html, />Superseded</);
  assert.ok(html.indexOf('>Draft<') < html.indexOf('>Superseded<'));

  // The reported defect, pinned: the same hit with nothing replacing it is the
  // plain chip, so the difference on screen is the record's, not the render's.
  const plain = searchHitHTML({ ...hit, supersededBy: null });
  assert.match(plain, />Draft</);
  assert.ok(!plain.includes('Superseded'));
});

test('search hit: the withheld case reaches the dropdown intact', () => {
  const html = searchHitHTML({
    pageId: 'p-runbook',
    title: 'On-call runbook',
    status: 'draft',
    type: 'note',
    snippet: 'Who to call at night.',
    supersededBy: WITHHELD,
  });
  assert.match(html, />Superseded</);
  assert.match(html, /do not have access to/);
});

test('collection contents: the status cell carries supersession too', () => {
  const tree = [
    {
      id: 'p-runbook',
      title: 'On-call runbook',
      type: 'note',
      status: 'draft',
      ownerId: 'dana',
      reviewDate: null,
      children: [],
      supersededBy: REPLACEMENT,
    },
    {
      id: 'p-printer',
      title: 'Badge printer instructions',
      type: 'note',
      status: 'draft',
      ownerId: 'dana',
      reviewDate: null,
      children: [],
      supersededBy: null,
    },
  ];
  const html = collectionContentsHTML(tree);
  const rows = html.split('<tr class="doc-row');
  const runbook = rows.find((r) => r.includes('On-call runbook'));
  const printer = rows.find((r) => r.includes('Badge printer'));
  assert.ok(runbook && printer);
  assert.match(runbook, />Superseded</);
  assert.ok(!printer.includes('Superseded'));
});

test('supersession: both surfaces draw it from one function', () => {
  // Two renderings of one fact drift; the reason searchHitHTML serves both the
  // dropdown and the results page is written in its own comment. The contents
  // table now shares the chip for the same reason.
  assert.match(bodyOf('searchHitHTML'), /supersededChipHTML\(/);
  assert.match(bodyOf('collectionContentsHTML'), /supersededChipHTML\(/);
});

// ---------------------------------------------------------------------------
// Page standing vs draft standing, at the surfaces a reader arrives through.
//
// Submitting a revision to a Canonical page overwrites `pages.status` with the
// draft's standing, so the badge read a Canonical page with a pending edit as
// IN REVIEW — unreviewed — while Ask went on drawing the Canonical version. The
// page's own standing (`pageStanding`) now travels beside `status`, and the
// badge shows it WITH the revision noted separately.

const pageBadge = new Function(`${HELPERS}\nreturn pageBadge;`)() as (
  page: Record<string, unknown>,
  size?: string,
) => string;
const badge = new Function(`${HELPERS}\nreturn badge;`)() as (status: string, size?: string) => string;

test('page badge: a revision in review is noted beside the page’s standing, not in place of it', () => {
  const html = pageBadge({ status: 'in_review', pageStanding: 'canonical' });
  // The page's own standing is the badge, and it is Canonical, not In Review.
  assert.match(html, /class="badge badge-canonical[^"]*"[^>]*>Canonical</);
  assert.ok(!/>In Review</.test(html), 'the draft’s standing does not stand in for the page’s');
  // The revision is noted, separately, as an aside and not a second status badge.
  assert.match(html, /· revision in review/);
  assert.ok(!/badge badge-in_review/.test(html), 'the revision is a note, not a rival badge');

  // A past-review-date page carries its overdue standing through the same way.
  assert.match(pageBadge({ status: 'in_review', pageStanding: 'needs_update' }), />Needs Update</);
});

test('page badge: with no pending revision it is exactly the plain status badge', () => {
  // A first draft in review, over no prior mark: pageStanding is null, and the
  // badge is a plain In Review — the page has no other standing to show.
  assert.equal(pageBadge({ status: 'in_review', pageStanding: null }), badge('in_review'));
  assert.equal(pageBadge({ status: 'canonical', pageStanding: null }), badge('canonical'));
});

// The same rule reaches the two list surfaces a reader arrives through, drawn
// from the same helper so the header, the table and search cannot drift.
test('page badge: search and the collection table both show standing with the revision noted', () => {
  const hit = {
    pageId: 'p-policy',
    title: 'Complaint handling',
    type: 'policy',
    status: 'in_review',
    pageStanding: 'canonical',
    snippet: 'A complaint is acknowledged…',
    supersededBy: null,
  };
  const search = searchHitHTML(hit);
  assert.match(search, />Canonical</);
  assert.match(search, /· revision in review/);
  assert.ok(!/>In Review</.test(search));

  const table = collectionContentsHTML([
    { id: 'p-policy', title: 'Complaint handling', type: 'policy', status: 'in_review',
      pageStanding: 'canonical', ownerId: 'dana', reviewDate: null, children: [], supersededBy: null },
  ]);
  assert.match(table, />Canonical</);
  assert.match(table, /· revision in review/);
  assert.ok(!/>In Review</.test(table));

  // One helper, so the surfaces cannot disagree.
  assert.match(bodyOf('searchHitHTML'), /pageBadge\(/);
  assert.match(bodyOf('collectionContentsHTML'), /pageBadge\(/);
});

// The three glanceable surfaces a browser meets BEFORE opening the page — the
// sidebar tree, the collection's own count of itself, and the standing badge at
// the top of a page's history — each read a Canonical-with-pending-revision page
// as a bare In Review, telling a reader the record has no official answer when
// it has one. They draw from the same pageStanding the header and the search hit
// already do, so a page in force reads consistently wherever it is glanced at.

const treeHTML = new Function(
  `${HELPERS}\n${lift('treeHTML')}\nreturn treeHTML;`,
)() as (nodes: Record<string, unknown>[], currentPageId?: string | null) => string;

const versionStanding = new Function(
  `${HELPERS}\n${lift('versionStanding')}\nreturn versionStanding;`,
)() as (page: Record<string, unknown>, isCurrent: boolean) => string;

const pageStandingOf = new Function(
  `${lift('pageStandingOf')}\nreturn pageStandingOf;`,
)() as (page: Record<string, unknown>) => string | null;

test('sidebar tree: a page in force with a revision in review reads Canonical, not In Review', () => {
  const html = treeHTML([
    { id: 'p-policy', title: 'Complaint handling', status: 'in_review', pageStanding: 'canonical', children: [] },
  ]);
  assert.match(html, />Canonical</, 'the tree shows the page’s own standing');
  assert.match(html, /· revision in review/, 'and notes the pending revision beside it');
  assert.ok(!/>In Review</.test(html), 'the draft’s standing does not stand in for the page’s in the tree');
  // Drawn from the same helper as the header and the contents table, so they cannot drift.
  assert.match(bodyOf('treeHTML'), /pageBadge\(/);
});

test('collection tally: a Canonical page with a pending revision counts as Canonical, not In Review', () => {
  // The count the tally is built on: the page's effective standing, not its
  // draft's. A tally reading "1 In Review, 0 Canonical" for a page still in
  // force is the "no official answer" lie the badge was fixed to stop telling.
  assert.equal(pageStandingOf({ status: 'in_review', pageStanding: 'canonical' }), 'canonical');
  assert.equal(pageStandingOf({ status: 'in_review', pageStanding: 'needs_update' }), 'needs_update');
  // No pending revision: the plain status stands, unchanged.
  assert.equal(pageStandingOf({ status: 'in_review', pageStanding: null }), 'in_review');
  assert.equal(pageStandingOf({ status: 'draft', pageStanding: null }), 'draft');
  // And the tally is wired to count by it, so the number matches the badges above it.
  assert.match(source, /for \(const n of flat\)[\s\S]*?pageStandingOf\(n\)/,
    'viewCollection counts each page under pageStandingOf, not its bare status');
});

test('version history: the current version shows the page’s standing, with the revision noted', () => {
  const page = { status: 'in_review', pageStanding: 'canonical' };
  const current = versionStanding(page, true);
  assert.match(current, />Canonical</, 'the current version carries the page’s own standing');
  assert.match(current, /· revision in review/);
  assert.ok(!/>In Review</.test(current), 'not the draft’s standing in place of it');
  // A superseded version keeps its own marking, untouched by this.
  assert.match(versionStanding(page, false), /superseded/);
  // The history header at the top of the view draws from the same helper.
  assert.match(source, /Version history \$\{pageBadge\(page\)\}/);
});

// ---------------------------------------------------------------------------
// Live past-review staleness reaches the GLANCEABLE surfaces, not only the page
// body and Ask.
//
// The sweep is a pass, not a trigger: between a review date lapsing and the next
// hourly sweep — forever, on a deployment whose timer is off — a Canonical page
// is overdue but still stored `canonical`. The page body and Ask already compute
// this window live and call it past review; the collection table, the tree, the
// search hit and the page header drew a plain, reassuring CANONICAL, tooltip and
// all ("…you may rely on it and quote it"), which is FALSE of a page the body
// beside it calls past review. The fix computes displayed standing LIVE in one
// helper (`displayedStanding`, feeding `pageBadge`), so every surface that badges
// a page reads the same overdue verdict — and the reassuring tooltip cannot
// appear on a page past its date.

const RELY = /you may rely on it and quote it/; // the canonical tooltip, false for an overdue page
const PAST = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString().slice(0, 10); // safely overdue
const FUTURE = '2099-01-01'; // comfortably current

test('past review is live on every badge surface: an overdue Canonical page never reads a reassuring CANONICAL', () => {
  const overdue = { status: 'canonical', reviewDate: PAST };

  // The header/tree helper. The badge is Needs Update — the sweep's own word —
  // with "· past review", and the reassuring Canonical tooltip is gone.
  const badgeHtml = pageBadge(overdue);
  assert.match(badgeHtml, />Needs Update</, 'the overdue page reads Needs Update, not Canonical');
  assert.match(badgeHtml, /· past review/, 'and says the demotion is the calendar');
  assert.ok(!RELY.test(badgeHtml), 'the "you may rely on it and quote it" tooltip is suppressed for an overdue page');
  assert.ok(!/class="badge badge-canonical/.test(badgeHtml), 'no bare Canonical badge either');

  // The sidebar tree.
  const tree = treeHTML([{ id: 'p-clin', title: 'Clinical policy', ...overdue, children: [] }]);
  assert.match(tree, />Needs Update</);
  assert.match(tree, /· past review/);
  assert.ok(!RELY.test(tree), 'no reassuring tooltip in the tree');

  // The search hit (the surface a reader most often arrives through) — which is
  // why the server now carries reviewDate on a hit at all.
  const hit = searchHitHTML({ pageId: 'p-clin', title: 'Clinical policy', type: 'policy',
    status: 'canonical', pageStanding: null, reviewDate: PAST, snippet: 'How claims are handled.', supersededBy: null });
  assert.match(hit, />Needs Update</);
  assert.match(hit, /· past review/);
  assert.ok(!RELY.test(hit), 'no reassuring tooltip in search results');

  // The collection contents table.
  const table = collectionContentsHTML([{ id: 'p-clin', title: 'Clinical policy', type: 'policy',
    status: 'canonical', ownerId: 'dana', reviewDate: PAST, children: [], supersededBy: null }]);
  assert.match(table, />Needs Update</);
  assert.ok(!RELY.test(table), 'no reassuring tooltip in the contents table');
});

test('past review is live: a Canonical page still within its review date is unaffected on every surface', () => {
  const current = { status: 'canonical', reviewDate: FUTURE };

  const badgeHtml = pageBadge(current);
  assert.match(badgeHtml, /class="badge badge-canonical[^"]*"[^>]*>Canonical</, 'a current page still reads Canonical');
  assert.ok(!/· past review/.test(badgeHtml), 'and is not marked past review');
  assert.match(badgeHtml, RELY, 'and keeps the reassuring tooltip it has earned');

  const hit = searchHitHTML({ pageId: 'p-clin', title: 'Clinical policy', type: 'policy',
    status: 'canonical', pageStanding: null, reviewDate: FUTURE, snippet: 'How claims are handled.', supersededBy: null });
  assert.match(hit, />Canonical</);
  assert.ok(!/Needs Update/.test(hit), 'a current page is never demoted on the search hit');
  assert.match(hit, RELY);

  const table = collectionContentsHTML([{ id: 'p-clin', title: 'Clinical policy', type: 'policy',
    status: 'canonical', ownerId: 'dana', reviewDate: FUTURE, children: [], supersededBy: null }]);
  assert.match(table, />Canonical</);
  assert.ok(!/Needs Update/.test(table));
});

test('past review is live: every badge surface derives its standing from the one shared helper', () => {
  // Structural, so the fix cannot recur surface-by-surface: the surfaces badge a
  // page through pageBadge, and pageBadge derives the shown standing through
  // displayedStanding — the single place live past-review is computed.
  assert.match(bodyOf('pageBadge'), /displayedStanding\(/);
  assert.match(bodyOf('displayedStanding'), /isPastReview\(/);
  assert.match(bodyOf('searchHitHTML'), /pageBadge\(/);
  assert.match(bodyOf('collectionContentsHTML'), /pageBadge\(/);
  assert.match(bodyOf('treeHTML'), /pageBadge\(/);
  assert.match(source, /doc-title">\$\{esc\(page\.title\)\} \$\{pageBadge\(page\)\}/, 'the page header badges through pageBadge too');
});
