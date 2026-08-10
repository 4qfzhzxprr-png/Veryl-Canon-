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
   ${lift('isPastReview')}
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
