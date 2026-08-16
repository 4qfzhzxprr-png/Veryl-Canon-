// The phone tab bar's decisions, tested where they are decisions.
//
// Canon's nav is not a fixed list: Ask, Sources, Map, Gaps and Imports each
// appear only once this reader has a reason for them, so the bar is derived
// from whatever the top nav is currently showing rather than declared beside
// it. That makes the interesting part a pure function — which destinations make
// the cut, what takes the raised centre, and what happens to the rest — and
// none of it is worth discovering on a phone.
//
// Lifted out of app.js and run, the way this codebase tests its other client
// helpers.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

const client = readFileSync(findPublicFile('app.js'), 'utf8');
const css = readFileSync(findPublicFile('styles.css'), 'utf8');
const html = readFileSync(findPublicFile('index.html'), 'utf8');

const lifted = /const TAB_MAX = [\s\S]*?\n\}\n/.exec(client);
assert.ok(lifted, 'planTabBar could not be lifted out of app.js');
const planTabBar = new Function(`${lifted[0]}\nreturn planTabBar;`)() as (
  entries: { section: string }[],
) => {
  left: { section: string }[];
  center: { section: string } | null;
  right: { section: string }[];
  overflow: boolean;
};

const entry = (section: string) => ({ section });
const sections = (list: { section: string }[]) => list.map((e) => e.section);

test('tabbar: Ask takes the raised centre when it is available', () => {
  // The one place you put a question TO the record rather than navigate it —
  // the role the Chief of Staff plays in the Registry's bar.
  const plan = planTabBar([entry('home'), entry('queue'), entry('ask'), entry('audit')]);
  assert.equal(plan.center?.section, 'ask');
  assert.ok(!sections(plan.left).includes('ask'));
  assert.ok(!sections(plan.right).includes('ask'));
});

test('tabbar: without Ask the remaining tabs simply fill the width', () => {
  const plan = planTabBar([entry('home'), entry('queue'), entry('audit')]);
  assert.equal(plan.center, null);
  assert.deepEqual([...sections(plan.left), ...sections(plan.right)], ['home', 'queue', 'audit']);
});

test('tabbar: it shows only what the nav is showing', () => {
  // A signed-out reader, or one without the roles: the bar cannot offer a
  // destination the nav itself is withholding.
  const plan = planTabBar([entry('home')]);
  assert.deepEqual(sections(plan.left), ['home']);
  assert.deepEqual(sections(plan.right), []);
  assert.equal(plan.overflow, false);
});

test('tabbar: a long tail becomes More rather than being dropped', () => {
  // Canon has eight nav entries at full permission. A bar that silently lost
  // "Audit" would be worse than one that admits there is more.
  const all = ['home', 'queue', 'ask', 'sources', 'map', 'gaps', 'imports', 'audit'].map(entry);
  const plan = planTabBar(all);
  assert.equal(plan.overflow, true);
  const shown = [...sections(plan.left), ...sections(plan.right)];
  // Three destinations plus the centre plus More — four slots either side of
  // the raised button is already past what a phone holds legibly.
  assert.equal(shown.length, 3);
  assert.deepEqual(shown, ['home', 'queue', 'sources']);
  assert.equal(plan.center?.section, 'ask');
});

test('tabbar: exactly four destinations need no disclosure', () => {
  const plan = planTabBar(['home', 'queue', 'sources', 'audit'].map(entry));
  assert.equal(plan.overflow, false);
  assert.equal([...sections(plan.left), ...sections(plan.right)].length, 4);
});

test('tabbar: the tabs are balanced around the centre', () => {
  const plan = planTabBar(['home', 'queue', 'ask', 'sources', 'audit'].map(entry));
  assert.deepEqual(sections(plan.left), ['home', 'queue']);
  assert.deepEqual(sections(plan.right), ['sources', 'audit']);
});

// --------------------------------------------------------------------------- //
// The physical properties, which are the ones a phone punishes
// --------------------------------------------------------------------------- //
test('tabbar: it exists, is a nav, and is labelled', () => {
  assert.match(html, /<nav class="tabbar" id="tabbar" aria-label="Primary" hidden><\/nav>/);
});

test('tabbar: it clears the home indicator and the tap-target floor', () => {
  const block = css.slice(css.indexOf('.tabbar:not([hidden])'));
  assert.match(block, /padding-bottom:\s*env\(safe-area-inset-bottom\)/,
    'the last row of tabs would sit under the home indicator');
  assert.match(block, /min-height:\s*56px/,
    'a tab must clear the 44px tap-target floor with room for its label');
});

test('tabbar: content is padded so the bar never covers the last row', () => {
  assert.match(css, /body\.has-tabbar \.app \{[^}]*padding-bottom/,
    'the last card of every list would sit permanently under the bar');
});

test('tabbar: it is a phone affordance only', () => {
  // Desktop keeps the inline top nav; two primary navigations on one screen is
  // a question the reader has to answer before every click.
  assert.match(css, /\.tabbar \{ display: none; \}/);
  assert.ok(css.indexOf('.tabbar:not([hidden])') > css.indexOf('@media (max-width: 640px)'));
});

test('tabbar: every nav section has an icon of its own', () => {
  // An unknown section falls back to a dot, which is legible and anonymous —
  // fine as a backstop, not as the actual answer for a shipped destination.
  const navSections = [...html.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(navSections.length >= 7, 'expected Canon\'s full nav in index.html');
  const icons = /const TAB_ICONS = \{([\s\S]*?)\n\};/.exec(client)?.[1] ?? '';
  for (const section of navSections) {
    assert.match(icons, new RegExp(`\\b${section}:`), `${section} has no icon`);
  }
});
