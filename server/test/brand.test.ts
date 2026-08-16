// One brand, asserted rather than assumed.
//
// Canon and the Agent Registry are separate repositories with separate
// stylesheets, so nothing mechanical keeps them looking like one company. What
// carries the family resemblance is three things — the mark, the typeface, and
// the accent — and each has a specific way of silently drifting:
//
//   * the mark gets recoloured to "fit" a page and stops being the mark;
//   * the typeface fails to load and the page falls back to the system stack,
//     which looks fine and looks like somebody else;
//   * the accent gets nudged toward whatever a component needed that day.
//
// These are cheap to check and expensive to notice by eye, months later, on
// somebody else's screen.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Walks up rather than assuming a depth: these tests run both from source and
// from dist/, which sit at different distances from server/public. Same helper
// the accessibility suite uses, for the same reason.
function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

const css = readFileSync(findPublicFile('styles.css'), 'utf8');
const html = readFileSync(findPublicFile('index.html'), 'utf8');

// The suite's action blue, from agent-studio/apps/web/src/styles/tokens.css.
const ACTION_LIGHT = '#2060FF';
const ACTION_DARK = '#6B95FF';
// The mark's tile. Fixed by BRAND.md and never theme-tinted.
const MARK_TILE = '#2D6BFF';

test('brand: the accent is the suite action blue, in both themes', () => {
  const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing'));

  assert.match(light, new RegExp(`--accent:\\s*${ACTION_LIGHT}`, 'i'),
    'the light accent has drifted away from the suite blue');
  assert.match(dark, new RegExp(`--accent:\\s*${ACTION_DARK}`, 'i'),
    'the dark accent has drifted; note it is LIGHTER than light mode, which is ' +
    'correct — a value darkened for contrast on white fails on a dark surface');
});

test('brand: the mark is present and is never recoloured', () => {
  assert.match(html, new RegExp(MARK_TILE, 'i'), 'the brand mark is missing from the header');
  // Not painted from a token, and not tinted by the theme: it is a fixed
  // artefact, not a glyph that inherits.
  assert.doesNotMatch(css, /\.brand-mark[^}]*(fill|color)\s*:/,
    'the mark is being recoloured by the stylesheet');
});

test('brand: the typeface is declared, self-hosted, and actually shipped', () => {
  assert.match(css, /font-family:\s*"Geist"/, 'the brand sans is not declared');
  assert.match(css, /--sans:\s*"Geist"/, 'the brand sans is declared but not used');

  // A @font-face pointing at a file that is not there fails silently: the page
  // renders in the system stack and looks like a different company.
  for (const file of [...css.matchAll(/url\((\/[^)]+\.woff2)\)/g)].map((m) => m[1]!)) {
    const name = file.slice(1);
    assert.doesNotMatch(name, /[/\\]/,
      `${file}: Canon serves only plain names directly inside public/, so a ` +
      'font in a subdirectory is never served');
    assert.ok(readFileSync(findPublicFile(name)).byteLength > 0, `${file} is missing`);
  }
});

test('brand: nothing still refers to the retired green accent', () => {
  // Canon's accent was #2e6e5c. A stray literal would repaint one control in
  // the old brand and read as a bug nobody can place.
  //
  // Comments are stripped first: the token block explains what the accent USED
  // to be, and naming a retired value in prose is the opposite of still using
  // it. A test that cannot tell those apart makes documenting a change costly.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(declarations, /#2e6e5c/i);
  assert.doesNotMatch(declarations, /#4f9a84/i);
});

test('brand: corners come from the shared scale, not from history', () => {
  // Canon had eight radii in use — 3, 4, 5, 6, 8, 10, 12, 14 — which is not a
  // scale, it is an archaeological record. Two products whose corners disagree
  // read as two products however well their colours match.
  //
  // Pills are exempt: a fully round end is a shape, not a step on a scale.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const raw = [...declarations.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((m) => m[1]!.trim())
    .filter((v) => !/^9{2,3}px$/.test(v))
    .filter((v) => /\d+px/.test(v));
  assert.deepEqual(raw, [], `these corners bypass the scale: ${raw.join(', ')}`);
});

test('brand: the header lockup matches the Registry to the pixel', () => {
  const brand = /\.brand \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(brand, /font-size:\s*17px/, 'the wordmark is a different size');
  assert.match(brand, /font-weight:\s*700/, 'the wordmark is a different weight');
  // Tracked TIGHT, not loose. The old +0.01em pulled the wordmark apart while
  // the Registry's pulled it together, and the two read as different companies
  // at a glance even before the colours were fixed.
  assert.match(brand, /letter-spacing:\s*-0\.01em/, 'the wordmark is tracked the wrong way');
  assert.match(html, /class="brand-mark" width="28" height="28"/, 'the mark is a different size');
});

test('brand: the sticky header pads for the notch', () => {
  // An installed iOS web app tucks a sticky bar under the status bar without
  // this. The Registry has always padded for it; Canon never did, which is the
  // kind of difference a customer feels without being able to name.
  const topbar = /\.topbar \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(topbar, /env\(safe-area-inset-top\)/);
});

test('brand: every translucent surface has an opaque fallback before it', () => {
  // A browser without color-mix drops the whole declaration, so a sticky bar
  // declared ONLY in color-mix has no background at all — content scrolls
  // through the header and through the tab bar. Solid is worse-looking and
  // readable; transparent is neither.
  //
  // Checked structurally rather than by eye: this is invisible on the machine
  // of whoever writes it, and only shows up on somebody else's older browser.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of declarations.split('}')) {
    if (!rule.includes('color-mix')) continue;
    const backgrounds = [...rule.matchAll(/background:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    const mixIndex = backgrounds.findIndex((v) => v.includes('color-mix'));
    assert.ok(
      mixIndex > 0 && !backgrounds[mixIndex - 1]!.includes('color-mix'),
      `a color-mix background with no opaque fallback before it:\n${rule.trim().slice(0, 200)}`,
    );
  }
});
