// The Markdown renderers, both of them.
//
// Canon renders the same safe-subset Markdown in two places, and neither can
// be dropped in favour of the other: `renderMarkdown` in public/app.js draws
// the page, the version view, the editor preview and the Ask answer inside a
// browser with no build step, and `renderMarkdownHtml` in src/html.ts draws
// the body inside an attestation, which is a file that has to open with no
// server, no script and no network in five years' time. Two implementations
// of one grammar is a standing risk of drift, so both are exercised here, in
// one file, over the same cases — and every case that is about the grammar
// rather than about a difference between the two runs against both renderers.
//
// The browser file is not importable: it is an ES module that touches
// `document` at the top level. It is lifted out of the shipped source the way
// answers.test.ts lifts `citationBadge` — the source that runs here is the
// source that ships, not a copy of it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToMarkdown, renderMarkdownHtml } from '../src/html.js';

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

/** The browser renderer, lifted whole out of public/app.js and run for real. */
function liftBrowserRenderer(): (src: string) => string {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const esc = /function esc\(s\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(esc, 'public/app.js escapes through esc()');
  const start = source.indexOf('function renderMarkdown(');
  const end = source.indexOf('// Line diff');
  assert.ok(start !== -1 && end > start, 'public/app.js has a Markdown section ending before the diff');
  const section = source.slice(start, end);
  return new Function(`${esc[0]}\n${section}\nreturn renderMarkdown;`)() as (src: string) => string;
}

const browser = liftBrowserRenderer();

/**
 * Run a case against both renderers. `both` holds for everything the grammar
 * says; where the two documents legitimately differ — a link is an anchor in
 * the browser and inert text in an attestation — the case says which one it
 * is about.
 */
function both(name: string, run: (render: (src: string) => string, which: 'browser' | 'server') => void): void {
  test(`markdown: ${name}`, () => {
    run(browser, 'browser');
    run((src: string) => renderMarkdownHtml(src), 'server');
  });
}

// ---------------------------------------------------------------------------
// Tables — USER-TESTING.md T4.1

const SCHEDULE = [
  '| Record type | Retention | Owner |',
  '| --- | ---: | :---: |',
  '| Client engagement file | 7 years | Legal |',
  '| Payroll | 6 years | People |',
].join('\n');

both('a pipe table becomes a table, not a line of pipes', (render) => {
  const html = render(SCHEDULE);
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Record type<\/th>/);
  assert.match(html, /<td[^>]*>Client engagement file<\/td>/);
  assert.equal(html.match(/<tr>/g)!.length, 3, 'one header row and two body rows');
  // The defect as the reader met it: the pipe syntax surviving into the page.
  assert.doesNotMatch(html, /<p>\| Record type/);
});

both('the alignment row aligns the column and is not itself a row', (render) => {
  const html = render(SCHEDULE);
  assert.match(html, /<t[hd] class="md-right">(7 years|Retention)/);
  assert.match(html, /<t[hd] class="md-center">(Legal|Owner)/);
  assert.doesNotMatch(html, /---/, 'the alignment row is markup, never content');
});

both('a cell may contain a pipe, escaped', (render) => {
  const html = render(
    ['| Region | Rule |', '| --- | --- |', '| EU \\| UK | Retain 7 \\| 10 years |'].join('\n'),
  );
  assert.match(html, /<td[^>]*>EU \| UK<\/td>/);
  assert.match(html, /<td[^>]*>Retain 7 \| 10 years<\/td>/);
  assert.equal(html.match(/<td/g)!.length, 2, 'an escaped pipe is content, not a column break');
});

both('a ragged row keeps every cell it was given', (render) => {
  const html = render(
    [
      '| A | B |',
      '| --- | --- |',
      '| short |',
      '| one | two | three |',
    ].join('\n'),
  );
  // Nothing is truncated: "three" has no header above it and survives anyway,
  // because dropping it would delete content from the record.
  assert.match(html, /three/);
  // And nothing is jagged: every row is padded to the widest row.
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g)!;
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.match(/<t[hd]/g)!.length, 3);
});

both('a table interrupts the paragraph above it', (render) => {
  const html = render(['Schedule:', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
  assert.match(html, /<p>Schedule:<\/p>/);
  assert.match(html, /<th[^>]*>A<\/th>/);
});

both('a table cell carries inline markup, escaped', (render) => {
  const html = render(['| Rule |', '| --- |', '| **Keep** <script>x</script> |'].join('\n'));
  assert.match(html, /<strong>Keep<\/strong>/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});

both('a lone rule under a line of prose is a rule, not a one-column table', (render) => {
  const html = render(['Some prose', '---', 'A footer line'].join('\n'));
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<hr>/);
});

both('an outer pipe is optional', (render) => {
  const html = render(['A | B', '--- | ---', '1 | 2'].join('\n'));
  assert.match(html, /<th[^>]*>A<\/th>/);
  assert.match(html, /<td[^>]*>2<\/td>/);
});

both('a table with a header and no rows still renders', (render) => {
  const html = render(['| A | B |', '| --- | --- |'].join('\n'));
  assert.match(html, /<th[^>]*>A<\/th>/);
  assert.doesNotMatch(html, /<td/);
});

both('a header row alone, with no alignment row, is prose', (render) => {
  const html = render('| A | B |');
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /\| A \| B \|/);
});

// ---------------------------------------------------------------------------
// The round trip
//
// The writer and the readers are two halves of one promise: a Confluence
// export arrives as HTML, is written out as Markdown, and is read back on a
// page. Each half is tested on its own; this is the join, because the join is
// where a schedule imported from the system Canon is replacing either survives
// or turns into a line of pipes.

both('a table imported from HTML is still a table when it is read back', (render) => {
  const md = htmlToMarkdown(
    '<table><tr><th>Region</th><th>Retention</th></tr>' +
      '<tr><td>EU | UK</td><td>7 years</td></tr>' +
      '<tr><td>US</td><td>10 years</td></tr></table>',
  );
  // The writer escapes the pipe inside a cell so the column count holds...
  assert.match(md, /EU \\\| UK/);
  // ...and the reader puts it back, as a pipe, in one cell.
  const html = render(md);
  assert.match(html, /<th[^>]*>Region<\/th>/);
  assert.match(html, /<td[^>]*>EU \| UK<\/td>/);
  assert.equal(html.match(/<tr>/g)!.length, 3);
});

both('an imported footer is a rule and a paragraph, not two paragraphs', (render) => {
  const md = htmlToMarkdown(
    '<p>The policy ends here.</p><hr><footer>Confidential — internal use only.</footer>',
  );
  const html = render(md);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>Confidential — internal use only\.<\/p>/);
  assert.doesNotMatch(html, /<p>---<\/p>/, 'the rule was drawn, not printed');
});

both('an imported nested list keeps the shape it was imported with', (render) => {
  const md = htmlToMarkdown(
    '<ol><li>A hold is raised.<ul><li>Including backups.</li><li>Including processors.</li></ul></li><li>Legal releases it.</li></ol>',
  );
  const html = render(md);
  assert.match(html, /<ol><li>A hold is raised\.<ul><li>Including backups\.<\/li>/);
  assert.match(html, /<li>Legal releases it\.<\/li><\/ol>/);
});

// ---------------------------------------------------------------------------
// The rest of the subset

both('a thematic break is a rule', (render) => {
  for (const rule of ['---', '***', '___', '- - -']) {
    const html = render(`Above\n\n${rule}\n\nBelow`);
    assert.match(html, /<hr>/, `${rule} is a thematic break`);
    assert.doesNotMatch(html, /<li>/, `${rule} is not a list`);
  }
});

both('a nested list keeps its nesting', (render) => {
  const html = render(['- one', '  - one a', '  - one b', '- two'].join('\n'));
  assert.match(html, /<ul><li>one<ul><li>one a<\/li><li>one b<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
});

both('an indented continuation belongs to the item above it', (render) => {
  const html = render(['- one', '  more of one', '- two'].join('\n'));
  assert.match(html, /<li>one more of one<\/li>/);
});

both('headings, quotes, code and emphasis still work', (render) => {
  const html = render(
    ['## Scope', '', 'This is **bold** and *italic* with `code`.', '', '> A quote', '', '```', 'raw <b>', '```'].join('\n'),
  );
  assert.match(html, /<h2>Scope<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<blockquote>A quote<\/blockquote>/);
  assert.match(html, /raw &lt;b&gt;/);
});

both('nothing from a body reaches the page as markup', (render) => {
  const hostile = '<img src=x onerror=alert(1)>';
  const html = render(`| ${hostile} |\n| --- |\n| ${hostile} |\n\n${hostile}`);
  assert.doesNotMatch(html, /<img/i);
  assert.ok(!html.includes(hostile));
});

// ---------------------------------------------------------------------------
// The editor's toolbar
//
// The toolbar's one rule is that it offers nothing the renderer cannot draw:
// a button whose output arrives on the page as literal punctuation is a
// promise broken in front of whoever the page was published to. That is
// checked here by pressing every button on an empty document and rendering
// what it wrote — no DOM, the shipped source, the shipped renderer.

interface FakeTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focus(): void;
  setRangeText(text: string, start: number, end: number, mode: string): void;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(event: unknown): boolean;
}

function fakeTextarea(value = ''): FakeTextarea {
  const ta: FakeTextarea = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    focus() {},
    setRangeText(text, start, end) {
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
      ta.selectionStart = start + text.length;
      ta.selectionEnd = ta.selectionStart;
    },
    setSelectionRange(start, end) {
      ta.selectionStart = start;
      ta.selectionEnd = end;
    },
    dispatchEvent() {
      return true;
    },
  };
  return ta;
}

/** The toolbar, lifted out of public/app.js the same way the renderer is. */
function liftToolbar(): {
  tools: { key: string; label: string }[];
  make: (ta: FakeTextarea) => Record<string, () => void>;
} {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const start = source.indexOf('const MD_TOOLS = [');
  const end = source.indexOf('async function viewEditor(');
  assert.ok(start !== -1 && end > start, 'the editor declares its toolbar above viewEditor');
  const section = source.slice(start, end);
  // execCommand is absent here, which exercises the fallback write path.
  const lifted = new Function(
    'document',
    'Event',
    `${section}\nreturn { MD_TOOLS, mdEditorTools };`,
  )({ execCommand: () => false }, class {}) as {
    MD_TOOLS: { key: string; label: string }[];
    mdEditorTools: (ta: FakeTextarea) => Record<string, () => void>;
  };
  return { tools: lifted.MD_TOOLS, make: lifted.mdEditorTools };
}

test('editor toolbar: every button writes something the renderer draws', () => {
  const { tools, make } = liftToolbar();
  const draws: Record<string, RegExp> = {
    h2: /<h2>/,
    bold: /<strong>/,
    italic: /<em>/,
    ul: /<ul>/,
    ol: /<ol>/,
    table: /<table/,
    link: /<a href="https:\/\/"/,
    quote: /<blockquote>/,
    code: /<code>/,
    rule: /<hr>/,
  };
  assert.deepEqual(
    tools.map((t) => t.key).sort(),
    Object.keys(draws).sort(),
    'a button was added or removed without saying what it draws',
  );
  for (const tool of tools) {
    const ta = fakeTextarea('');
    const handlers = make(ta);
    const run = handlers[tool.key];
    assert.ok(run, `the ${tool.label} button has a handler`);
    run();
    assert.ok(ta.value.trim().length > 0, `${tool.label} wrote something`);
    assert.match(browser(ta.value), draws[tool.key]!, `${tool.label} is drawn by the renderer`);
  }
});

test('editor toolbar: the Table button writes a table a reader will see as one', () => {
  const { make } = liftToolbar();
  const ta = fakeTextarea('Retention schedule follows.');
  make(ta).table!();

  // A blank line before it, so it is a block and not the tail of the sentence.
  assert.match(ta.value, /follows\.\n\n\| Column 1 /);
  const html = browser(ta.value);
  assert.match(html, /<p>Retention schedule follows\.<\/p>/);
  assert.equal(html.match(/<tr>/g)!.length, 3, 'a header row and two rows to fill in');
  // The caret is left on the first header cell, so typing replaces it.
  assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), 'Column 1');
});

test('editor toolbar: a list button prefixes every line the writer selected', () => {
  const { make } = liftToolbar();
  const ta = fakeTextarea('Alpha\nBeta\nGamma');
  ta.selectionStart = 0;
  ta.selectionEnd = ta.value.length;
  make(ta).ol!();
  assert.equal(ta.value, '1. Alpha\n2. Beta\n3. Gamma');
  assert.match(browser(ta.value), /<ol><li>Alpha<\/li><li>Beta<\/li><li>Gamma<\/li><\/ol>/);
});

test('markdown: the browser renderer links, and an attestation does not', () => {
  const md = 'See [the policy](https://example.test/p) and [bad](javascript:alert(1)).';

  const page = browser(md);
  assert.match(page, /<a href="https:\/\/example.test\/p" target="_blank" rel="noopener noreferrer">the policy<\/a>/);
  assert.doesNotMatch(page, /javascript:/i, 'only benign schemes become links');

  // An attestation is opened years later, from a file, possibly by a regulator.
  // It carries no reference that could reach the network — so a link keeps its
  // text and its target, as text, and nothing in the document is clickable.
  const sheet = renderMarkdownHtml(md);
  assert.doesNotMatch(sheet, /<a /);
  assert.doesNotMatch(sheet, /href=/);
  assert.match(sheet, /the policy \(https:\/\/example.test\/p\)/);
});
