// What the shipped browser files owe somebody who is not using a mouse.
//
// Round seven measured this against the running app rather than reading the
// source, and the findings were all of a kind: things that work perfectly if
// you can see the screen and point at it, and are simply absent otherwise.
//
//   * `document.title` was set once in index.html and never reassigned. Nine
//     routes, one title. The DOM swap under a hash router fires nothing, so a
//     screen-reader user had no signal that the page had changed at all.
//   * Focus never moved to the new heading, and no live region said anything.
//   * No `aria-current` in the nav — the current page was a colour.
//   * The focus ring was --accent-soft, 1.08:1 against white. WCAG SC 1.4.11
//     asks for 3:1. On the Ask screen it was `outline: none`.
//   * The modal claimed `aria-modal="true"` and had no focus trap, no Escape,
//     and no focus restore.
//   * 85 tab stops to the main column, no skip link, and an <a> nested inside
//     a <summary>, which is invalid markup.
//
// These are asserted against the files that ship, the way markdown.test.ts and
// pageview.test.ts do, because there is no DOM here to drive.

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

const client = readFileSync(findPublicFile('app.js'), 'utf8');
const html = readFileSync(findPublicFile('index.html'), 'utf8');
const css = readFileSync(findPublicFile('styles.css'), 'utf8');

// ---------------------------------------------------------------------------
// Route changes

test('a11y: every route change renames the document', () => {
  assert.match(client, /function announceRoute\(\)/);
  const fn = /function announceRoute\(\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(fn, /document\.title = name \? `\$\{name\} · Veryl Canon` : 'Veryl Canon';/);
  // From the view's own <h1>, not a hand-kept table of route names that would
  // drift the first time a screen was renamed.
  assert.match(fn, /app\.querySelector\('h1'\)/);
  // And it is the render path that calls it, so it cannot be forgotten by a
  // route added later.
  const render = /async function render\(view\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(render, /announceRoute\(\);/);
});

test('a11y: a route change moves focus to the heading and says so out loud', () => {
  const fn = /function announceRoute\(\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(fn, /heading\.setAttribute\('tabindex', '-1'\)/);
  assert.match(fn, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(fn, /getElementById\('route-announcer'\)/);
  assert.match(html, /id="route-announcer"[^>]*aria-live="polite"/);
  // Its own region, not the toast queue: a save confirmation and a navigation
  // arriving together must not swallow one another.
  assert.ok(html.indexOf('route-announcer') !== html.indexOf('id="toasts"'));
});

test('a11y: an in-page refresh does not steal focus — only navigation does', () => {
  // The boundary that makes the focus move tolerable. viewGaps re-renders
  // itself directly after closing a gap; if that went through render() the
  // reader would be thrown back to the heading every time they resolved a row.
  assert.match(client, /await viewGaps\(query\);/);
  assert.doesNotMatch(client, /render\(\(\) => viewGaps\(query\)\)/);
});

// ---------------------------------------------------------------------------
// Nav

test('a11y: the current nav entry says it is current, not just looks it', () => {
  const fn = /function markNav\(section\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(fn, /setAttribute\('aria-current', 'page'\)/);
  assert.match(fn, /removeAttribute\('aria-current'\)/);
  // One place. There were three call sites toggling the class by hand, which
  // is how a state gets set in two of them and not the third.
  const byHand = client.match(/#topnav a'\)\.forEach/g) ?? [];
  assert.equal(byHand.length, 1, 'only markNav touches the nav links');
});

// ---------------------------------------------------------------------------
// Focus visibility — measured, not asserted by eye

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

/** Read a custom property out of a block of the stylesheet. */
function token(block: string, name: string): string {
  const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(found, `--${name} is defined as a hex colour in this block`);
  return found[1]!.toLowerCase();
}

test('a11y: the focus ring clears 3:1 against every surface it is drawn on, in both themes', () => {
  // The finding was a measurement (1.08:1), so the fix is pinned by the same
  // measurement rather than by "we changed the token". A future palette edit
  // that quietly darkens a surface reddens this.
  const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing'));
  for (const [name, block] of [['light', light], ['dark', dark]] as const) {
    const ring = token(block, 'focus-ring');
    for (const surface of ['bg', 'surface', 'surface-2']) {
      const ratio = contrast(ring, token(block, surface));
      assert.ok(
        ratio >= 3,
        `${name}: the focus ring is ${ratio.toFixed(2)}:1 against --${surface}; SC 1.4.11 needs 3:1`,
      );
    }
  }
});

test('a11y: nothing draws a focus ring out of --accent-soft any more', () => {
  // The 1.08:1 value, as its absence. --accent-soft is a fill, not an
  // indicator, and it was doing both jobs.
  assert.doesNotMatch(css, /outline:\s*[^;]*var\(--accent-soft\)/);
  // Every control gets one, including the many that had no rule at all and
  // took whatever the engine drew.
  assert.match(css, /^:focus-visible \{\n\s*outline: 2px solid var\(--focus-ring\);/m);
});

test('a11y: the Ask question box has a focus indicator again', () => {
  // It was the one control in Canon with `outline: none` and nothing in its
  // place. The ring is drawn on its container, which is a borderless field
  // inside a card — but it is drawn.
  const form = /\.ask-form:focus-within \{[\s\S]*?\}/.exec(css)![0];
  assert.match(form, /outline: 2px solid var\(--focus-ring\)/);
});

// ---------------------------------------------------------------------------
// The modal

test('a11y: the modal that claims aria-modal behaves like one', () => {
  const modal = client.slice(client.indexOf('function openModal('), client.indexOf('function renderMarkdown('));
  assert.match(modal, /e\.key === 'Escape'/, 'Escape closes it');
  assert.match(modal, /if \(e\.key !== 'Tab'\) return;/, 'Tab is trapped');
  assert.match(modal, /shiftKey && active === first/, 'and it cycles both ways');
  assert.match(modal, /const opener = document\.activeElement;/);
  assert.match(modal, /opener\.isConnected\) opener\.focus\(\)/, 'focus goes back to whoever opened it');
  // Captured on the document, because a field inside the dialog that handles
  // its own keys would otherwise be a hole in the trap.
  assert.match(modal, /document\.addEventListener\('keydown', onKeydown, true\)/);
  assert.match(modal, /document\.removeEventListener\('keydown', onKeydown, true\)/);
  // A disabled control is not a stop. The submit button disables itself while
  // a save is in flight; cycling onto it would strand the reader.
  assert.match(client, /const FOCUSABLE = [\s\S]*?button:not\(\[disabled\]\)/);
});

test('a11y: Escape closes the dialog without acting on it', () => {
  const modal = client.slice(client.indexOf('function openModal('), client.indexOf('function renderMarkdown('));
  const escape = modal.slice(modal.indexOf("if (e.key === 'Escape')"), modal.indexOf("if (e.key !== 'Tab')"));
  assert.match(escape, /close\(\);/);
  assert.doesNotMatch(escape, /onSubmit|requestSubmit/, 'a reflex key may not commit a change');
});

// ---------------------------------------------------------------------------
// Getting to the content

test('a11y: there is a way past the navigation, and it is first in the document', () => {
  assert.match(html, /<a class="skip-link" href="#main" id="skip-to-main">/);
  assert.ok(html.indexOf('skip-to-main') < html.indexOf('class="topbar"'), 'before the chrome it skips');
  assert.match(html, /<main id="app" class="app" tabindex="-1">/);
  // And it cannot be an ordinary anchor: location.hash IS the router here, so
  // an unhandled href="#main" navigates to a route called "main".
  const fn = /function wireSkipLink\(\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(fn, /e\.preventDefault\(\)/);
  assert.match(fn, /heading\.focus\(\)/);
  assert.match(client, /wireSkipLink\(\);/);
});

test('a11y: no interactive control is nested inside another one in the tree', () => {
  // `<summary><a …></summary>` is invalid: <summary> has an implicit button
  // role and may not contain interactive content. It rendered, which is why it
  // lasted, but it handed assistive technology one control doing two jobs.
  assert.doesNotMatch(client, /<summary>\$\{link\}<\/summary>/);
  assert.doesNotMatch(client, /summary a\.tree-link/);
  const fn = /function treeHTML\(nodes, currentPageId\)[\s\S]*?\n\}\n/.exec(client)![0];
  assert.match(fn, /class="tree-branch-toggle" aria-expanded="true"/);
  assert.match(fn, /aria-controls="\$\{kids\}"/);
  assert.match(fn, /aria-label="Pages under \$\{esc\(n\.title\)\}"/, 'the toggle names what it collapses');
});
