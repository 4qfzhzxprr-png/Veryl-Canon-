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

// ---------------------------------------------------------------------------
// Round seven, Phase 8: the phone, and the search box on it.

test('mobile: no text field is under the 16px iOS zoom floor', () => {
  // iOS Safari zooms the page in when it focuses a field whose text is under
  // 16px, and does not zoom back out. One tap on the search box left a reader
  // at 1.2× with the right-hand third of every line off screen.
  assert.match(css, /^input, textarea, select \{ font-family: inherit; font-size: 16px; \}$/m);
  // And the two rules that were setting 15px by inheriting the body.
  const searchInput = /\.search-slot input \{[\s\S]*?\}/.exec(css)![0];
  assert.match(searchInput, /font-size: 16px/);
  assert.doesNotMatch(searchInput, /^\s*font: inherit;/m);
  const labelled = /label input, label textarea, label select \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(labelled, /font-size: 16px/);
  assert.doesNotMatch(labelled, /^\s*font: inherit;/m);
});

test('mobile: the sticky header does not keep a third of the screen', () => {
  // Four rows at 375×667 — brand, search, seven nav entries over three lines,
  // identity chip — stuck to the top of every screen in the product. The nav
  // is the bulk of it and it collapses behind one control; nothing is cut.
  assert.match(html, /<button class="nav-toggle" id="nav-toggle" type="button" aria-expanded="false" aria-controls="topnav" hidden>/);
  const phone = css.slice(css.indexOf('/* A STICKY HEADER MAY NOT BE A THIRD OF THE SCREEN.'));
  assert.match(phone, /\.topnav \{ display: none; \}/);
  assert.match(phone, /\.topbar\.is-nav-open \.topnav:not\(\[hidden\]\)/);
  // The reason to open it has to be visible from outside it.
  assert.match(client, /getElementById\('nav-toggle-count'\)/);
  // And it closes on every navigation: a menu standing over the page you just
  // chose from it is a menu you have to dismiss before you can read anything.
  assert.match(client, /function closeNavMenu\(\)/);
  const route = client.slice(client.indexOf('async function route()'), client.indexOf('async function render(view)'));
  assert.match(route, /closeNavMenu\(\);/);
});

test('mobile: the nav is not on screen for somebody who is not signed in', () => {
  // An author `display` rule outranks the UA's `[hidden] { display: none }`,
  // which .tree-toggle[hidden] already documents — and .topnav has
  // `display: flex`, so `nav.hidden = true` was doing nothing at all and a
  // signed-out visitor was offered links that bounce straight back.
  assert.match(css, /\.topnav\[hidden\] \{ display: none; \}/);
});

// ---------------------------------------------------------------------------
// Search as a surface

test('search: Enter goes somewhere, and it is a route somebody can send', () => {
  const wire = client.slice(client.indexOf('function wireSearch()'), client.indexOf('async function viewSearch('));
  assert.match(wire, /if \(e\.key === 'Enter'\)/);
  assert.match(wire, /location\.hash = searchRoute\(q\)/);
  assert.match(client, /function searchRoute\(q\) \{\n\s*return `#\/search\?q=\$\{encodeURIComponent\(q\)\}`;/);
  assert.match(client, /if \(parts\[0\] === 'search'\) return await render\(\(\) => viewSearch\(hashQuery\(\)\)\);/);
});

test('search: the dropdown says it is a dropdown, not the results', () => {
  // Twelve hits were shown and the thirteenth was never mentioned, so a slice
  // was read as the result set.
  const wire = client.slice(client.indexOf('function wireSearch()'), client.indexOf('async function viewSearch('));
  assert.match(wire, /More matches than fit here/);
  assert.match(wire, /items\.slice\(0, SEARCH_DROPDOWN_CAP\)/);
});

test('search: a late answer never lands in a box that has moved on', () => {
  // Two keystrokes, two requests, no ordering guarantee — an earlier slower
  // answer arriving last leaves results for a query the box no longer holds.
  // Same class as the audit log's stale count.
  const wire = client.slice(client.indexOf('function wireSearch()'), client.indexOf('async function viewSearch('));
  assert.match(wire, /const mine = \+\+seq;/);
  assert.match(wire, /if \(mine !== seq\) return;/);
});

test('search: the results page scopes its emptiness to the reader, like every other empty state', () => {
  const view = client.slice(client.indexOf('async function viewSearch('), client.indexOf('function wireSearchPageForm()'));
  assert.match(view, /Nothing you can see matches/);
  assert.doesNotMatch(view, /Nothing in the record matches/);
  // And it never states a total: search takes an arbitrary term, so a
  // hidden-match count is an oracle (policy question 1).
  assert.doesNotMatch(view, /hidden|withheld/);
});

test('search: a suggestion is an offer, never an applied correction', () => {
  const fn = /async function searchSuggestionHTML\(q\)[\s\S]*?\n\}/.exec(client)![0];
  assert.match(fn, /Did you mean <a href/);
  // Nothing re-runs the search with the suggested words behind the reader's
  // back — the results on screen are always the results for what was typed.
  assert.doesNotMatch(fn, /location\.hash/);
});

// Policy question 3, Canon's half, on the client: the author is the only person
// who can judge the prose around a link, so they are the person told.
test('link audience: the warning reaches the author after the act, and waits to be read', () => {
  assert.match(client, /function raiseLinkWarnings\(response\)/);
  assert.match(client, /for \(const w of warnings\) toast\(w, 'warn'\);/);
  // Persistent, like a refusal and unlike good news: the act HAPPENED, so
  // there is nothing to retry, and a 2.5-second life would put it on screen
  // while its reader was three actions further on.
  assert.match(client, /if \(kind === 'error' \|\| kind === 'warn'\) \{/);
  // Both moments an author commits text.
  assert.match(client, /const published = await api\('POST', `\/pages\/\$\{id\}\/publish`/);
  assert.match(client, /raiseLinkWarnings\(published\);/);
  assert.match(client, /raiseLinkWarnings\(submitted\);/);
  // And while they are still writing, in its own block — not appended to the
  // alias collisions, whose explanation is about a different field.
  assert.match(client, /#link-warnings/);
  assert.match(client, /linkWarningsHTML\(d\.linkWarnings\)/);
});
