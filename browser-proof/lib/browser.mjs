// Driving the shipped client, and watching it for the things unit tests
// cannot see.
//
// Two of Canon's last defects were found by a person with a browser open and
// could not have been found any other way:
//
//   * `label { display: block }` outranked the user agent's
//     `[hidden] { display: none }`, so every label the client hid from script
//     stayed on screen. `querySelector('[hidden]')` finds that element and
//     reports it hidden; only a computed style disagrees. Hence
//     `hiddenButVisible` below, applied as a RULE on every route rather than
//     as a check on the one label that was reported.
//   * Copy defects on surfaces whose unit tests all passed, because a unit
//     test asserts the string a function returns and a reader reads the screen.
//     Hence `visibleText`, which reads what is painted.
//
// Everything here waits on a CONDITION, never on a clock. A proof that flakes
// gets ignored, and an ignored proof is worse than none.

import { chromium } from 'playwright';

export const NAV_TIMEOUT = 15_000;

export async function launch() {
  return await chromium.launch();
}

/**
 * A reader, signed in.
 *
 * The client stores the chosen actor in `localStorage` under `canon.actor`
 * (public/app.js, `readStoredActor`), so identity is planted before the first
 * script runs rather than clicked through on every test. The identity SCREEN
 * is itself driven, once, in the surfaces proof — planting the key is a
 * shortcut around a flow that is proved elsewhere, not around one that is not.
 */
export async function openAs(browser, baseUrl, actor) {
  const context = await browser.newContext({ baseURL: baseUrl });
  if (actor) {
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ['canon.actor', JSON.stringify({ id: actor.id, name: actor.name, kind: actor.kind ?? 'person' })],
    );
  }
  const page = await context.newPage();
  const watch = watchFor(page);
  return { context, page, watch };
}

/**
 * Everything that went wrong while a page was open, collected as it happens.
 *
 * `pageerror` is an uncaught exception in the client and is never acceptable:
 * whatever the reader was doing stopped there. Console errors are collected
 * too but judged separately — the browser writes one for every 4xx a fetch
 * gets, and Canon's client probes optional routes on purpose (`detectAsk`,
 * `detectSources`, `detectImports`), so a 404 in the console is the product
 * working. A 5xx is not, and every response is checked for one.
 */
export function watchFor(page) {
  const pageErrors = [];
  const consoleErrors = [];
  const serverErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    consoleErrors.push(msg.text());
  });
  page.on('response', (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });
  return {
    pageErrors,
    consoleErrors,
    serverErrors,
    /** Console errors that are not the browser reporting a refused fetch. */
    unexplainedConsoleErrors() {
      return consoleErrors.filter((text) => !/Failed to load resource/i.test(text));
    },
    reset() {
      pageErrors.length = 0;
      consoleErrors.length = 0;
      serverErrors.length = 0;
    },
  };
}

/**
 * Go to a hash route and wait until THIS route's view has drawn.
 *
 * Waiting for "not loading any more" is not enough: between asking for a new
 * route and the client starting to render it, the previous view is still on
 * screen and satisfies every such condition. So a marker is planted in `#app`
 * first. `render()` replaces the whole of `#app` with its loading placeholder
 * before it awaits the view (public/app.js), which takes the marker with it —
 * so "the marker is gone AND nothing is loading AND there is content" is the
 * new view and cannot be the old one. No clock anywhere.
 */
const MARKER = 'proof-stale-marker';

async function plant(page) {
  await page.evaluate((id) => {
    const app = document.getElementById('app');
    const mark = document.createElement('span');
    mark.id = id;
    app?.appendChild(mark);
  }, MARKER);
}

/**
 * Do something that makes the app draw a new view, and wait for THAT view.
 *
 * Every route change in this client goes through `render()`, whether it was a
 * link, the Enter key in the search box or an identity being picked — so the
 * marker discipline belongs here rather than only in `goto`. Waiting without
 * it looks like it works and quietly asserts against the previous screen,
 * which is how a suite starts passing for the wrong reason.
 */
export async function transition(page, act) {
  if (page.url() !== 'about:blank') await plant(page);
  await act();
  await settled(page);
}

export async function goto(page, route) {
  await transition(page, () => page.goto(route, { waitUntil: 'commit', timeout: NAV_TIMEOUT }));
}

/** The current view has drawn: no marker, no placeholder, and something to read. */
export async function settled(page) {
  await page.waitForFunction(
    (id) => {
      const app = document.getElementById('app');
      if (!app) return false;
      if (document.getElementById(id)) return false;
      if (app.querySelector('.loading')) return false;
      return app.textContent.trim().length > 0;
    },
    MARKER,
    { timeout: NAV_TIMEOUT },
  );
}

/** What a person can actually read on this screen, whitespace-collapsed. */
export async function visibleText(page, selector = 'body') {
  return await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    return root ? root.innerText.replace(/\s+/g, ' ').trim() : '';
  }, selector);
}

/**
 * THE RULE: nothing the app marks `hidden` may be on screen.
 *
 * `[hidden]` is the client's own statement that an element is not part of this
 * screen — it is how the nav, the search slot, the tree toggle, the editor's
 * two panes, the refusal list and every conditional form row are turned off.
 * A stylesheet rule with a `display` in it outranks the user agent's
 * `[hidden] { display: none }`, and when that happens nothing throws, nothing
 * looks wrong in the DOM, and the element is simply THERE. That is exactly
 * what happened to `label`, twice, on real screens.
 *
 * `checkVisibility` is the browser's own answer to "would a person see this",
 * so it accounts for an ancestor being hidden, `visibility`, `opacity` and
 * `content-visibility` — not just this element's `display`. The bounding box
 * is checked as well, because an element can be visible by style and collapsed
 * to nothing, and it is the pair that makes "on screen" a fact rather than an
 * inference.
 */
export async function hiddenButVisible(page) {
  return await page.evaluate(() => {
    const offenders = [];
    for (const el of document.querySelectorAll('[hidden]')) {
      const visible = el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
      if (!visible) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const style = getComputedStyle(el);
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: typeof el.className === 'string' ? el.className : null,
        display: style.display,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      });
    }
    return offenders;
  });
}

/** How many elements this screen is hiding, so the guard can prove it has subjects. */
export async function hiddenCount(page) {
  return await page.evaluate(() => document.querySelectorAll('[hidden]').length);
}

/** A description of an offender, for a failure message somebody has to act on. */
export function describeOffenders(offenders) {
  return offenders
    .map((o) => `<${o.tag}${o.id ? ` id="${o.id}"` : ''}${o.className ? ` class="${o.className}"` : ''}> ` +
      `is [hidden] and painted (display: ${o.display}) — "${o.text}"`)
    .join('\n');
}
