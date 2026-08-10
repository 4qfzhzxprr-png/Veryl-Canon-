// The surfaces where this product's defects have actually lived, driven the
// way a person drives them.
//
// Every assertion here is on what is PAINTED — `innerText`, computed
// visibility, a button a person can press — rather than on a string a function
// returned. Canon's unit suites are large and they were all green while a
// hidden label sat on screen and while a superseded page wore a plain Draft
// chip in the only list anybody reaches it through. Those are not gaps in the
// unit tests; they are things a unit test cannot see.
//
// The surfaces, and why each one:
//
//   the refusal wall   — the screen a refused reader lands on, and the one
//                        place the product must not leak what it refused
//   request access     — the loop that starts at that wall and ends in
//                        somebody else's queue
//   the import screens — shipped complete and unreachable once already
//   the queue          — the surface built because nobody was told there was
//                        work waiting for them
//   search             — the dropdown and the results page, one renderer, and
//                        the place a superseded page is met
//   the identity screen— the door

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startCanon } from '../lib/server.mjs';
import { buildRecord } from '../lib/record.mjs';
import {
  describeOffenders,
  goto,
  hiddenButVisible,
  launch,
  openAs,
  transition,
  visibleText,
} from '../lib/browser.mjs';

let canon;
let browser;

before(async () => {
  canon = await startCanon((store, ctx) => buildRecord(store, ctx));
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await canon?.stop();
});

/** Open as somebody, run the body, and always close the context. */
async function as(who, body) {
  const actor = who === null ? null : canon.fixture.actors[who];
  const { context, page, watch } = await openAs(browser, canon.baseUrl, actor);
  try {
    await body({ page, watch, f: canon.fixture });
    // Nothing in this file is allowed to leave an exception behind it either.
    assert.deepEqual(watch.pageErrors, [], `the client threw: ${watch.pageErrors.join(' | ')}`);
    assert.deepEqual(watch.serverErrors, [], `a request 5xx'd: ${watch.serverErrors.join(' | ')}`);
    const offenders = await hiddenButVisible(page);
    assert.equal(offenders.length, 0, `hidden and painted:\n${describeOffenders(offenders)}`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// The door

test('the identity screen signs somebody in, for real', async () => {
  await as(null, async ({ page, f }) => {
    await goto(page, '#/');
    // Nobody is signed in, so every route is the door.
    assert.match(await visibleText(page, '#app'), /Who are you\?/);
    assert.match(await visibleText(page, '#app'), /nothing about it is verified/i);

    await transition(page, () => page.click(`[data-pick="${f.actors.vera.id}"]`));
    // And she is somewhere, as herself.
    assert.match(await visibleText(page, '.actor-chip'), /Vera/);
    assert.match(await visibleText(page, '#app'), /Operations/);
    // The collection she holds nothing in is not on her collections screen.
    assert.ok(!(await visibleText(page, '#app')).includes('Compliance'));
  });
});

// ---------------------------------------------------------------------------
// The refusal wall

test('a refused reader lands on a wall that names no page', async () => {
  await as('vera', async ({ page, f }) => {
    await goto(page, `#/pages/${f.pages.kestrel}`);
    const text = await visibleText(page, '#app');

    // The wall itself.
    assert.match(text, /No access/);
    // The refusal says what is missing and where to go with it — the whole
    // reason it is a screen and not a toast.
    assert.match(text, /you hold none there/i);
    assert.match(text, /An administrator of this collection can grant it/);
    // And it hands over nothing it just refused: not the page's title, and not
    // the NAMES of the people in a collection she holds nothing in. Where she
    // holds something the product does name them — the next test walks that
    // wall — so this is the disclosure rule, not a missing feature.
    assert.ok(!text.includes('Kestrel incident protocol'), 'the wall named the page it refused');
    for (const name of ['Dana Whitfield', 'Iris Bell', 'Marc Oyelaran']) {
      assert.ok(!text.includes(name), `the wall named ${name} in a collection she holds nothing in`);
    }

    // Nothing to ask with: she holds no role in that collection, so there is
    // no ground for a request and the product does not offer a box to type an
    // id into (access.ts).
    assert.equal(await page.locator('[data-ask-access]').count(), 0);
    // The way out is a way out, not a dead end.
    assert.equal(await page.locator('a.btn', { hasText: 'Back to collections' }).count(), 1);
  });
});

test('a wall a reader has standing at offers the ask, and it reaches an administrator', async () => {
  await as('vera', async ({ page, f }) => {
    // She may READ Operations and may not write in it: the refusal she can do
    // something about.
    await goto(page, `#/pages/${f.pages.printerNote}/edit`);
    const text = await visibleText(page, '#app');
    assert.match(text, /No access/);
    assert.match(text, /you hold view there/i);
    // She holds something here, so the refusal names who can widen it.
    assert.match(text, /Dana Whitfield/);

    const ask = page.locator('[data-ask-access]');
    assert.equal(await ask.count(), 1, 'the refusal she has standing at offers the ask');
    await ask.click();

    const dialog = page.locator('.modal[role="dialog"]');
    await dialog.waitFor({ state: 'visible' });
    const dialogText = await visibleText(page, '.modal');
    assert.match(dialogText, /Ask for access/);
    assert.match(dialogText, /This goes to the administrators/);
    assert.match(dialogText, /You hold view here now/);

    await page.selectOption('.modal select[name="role"]', 'edit');
    await page.fill('.modal textarea[name="note"]', 'I keep the badge printer notes up to date.');
    await page.click('.modal button[type="submit"]');

    // The receipt, and it is on screen rather than in a console.
    await page.locator('.toasts').getByText(/Asked\./).waitFor({ state: 'visible' });
    await dialog.waitFor({ state: 'detached' });
  });

  // And it landed somewhere a person will see it: the administrator's queue.
  await as('dana', async ({ page }) => {
    await goto(page, '#/queue');
    const text = await visibleText(page, '#app');
    assert.match(text, /Vera Lindqvist/);
    assert.match(text, /badge printer notes/);
    assert.match(text, /edit/);
    // With something to do about it, not just a notification of it.
    assert.ok(
      (await page.locator('button', { hasText: /Grant/i }).count()) > 0,
      'the administrator can act on the request from here',
    );
  });

  // And the person who acted can see that she did: the loop that reports back.
  await as('vera', async ({ page }) => {
    await goto(page, '#/queue');
    const text = await visibleText(page, '#app');
    assert.match(text, /Access you have asked for/);
    assert.match(text, /You asked for the edit role on Operations/);
  });
});

// ---------------------------------------------------------------------------
// The import screens

test('the import screens show a run, and what became of every file', async () => {
  await as('dana', async ({ page, f }) => {
    await goto(page, '#/imports');
    let text = await visibleText(page, '#app');
    assert.match(text, /Imports/);
    assert.match(text, /Confluence/i);
    assert.match(text, /Operations/);
    // The claim the screen exists to make: nothing an import lands is canonical.
    assert.match(text, /arrive as drafts/i);
    // A run somebody ran is a link to what it did.
    assert.equal(await page.locator(`a[href="#/imports/${f.importRunId}"]`).count(), 1);

    await goto(page, `#/imports/${f.importRunId}`);
    text = await visibleText(page, '#app');
    // Every file, with an outcome — including the one that could not be read,
    // which says WHY in words the person holding the export can act on.
    assert.match(text, /Benefits\+Overview_65601\.html/);
    assert.match(text, /Broken\+Export_65607\.html/);
    assert.match(text, /FAILED/);
    assert.match(text, /the export looks truncated, so re-export this page/);
    // And what the run landed, said where the run is read: nothing canonical.
    assert.match(text, /never holds the Canonical mark/);
  });
});

test('somebody who cannot import is told why, on the screen that offers it', async () => {
  await as('vera', async ({ page }) => {
    await goto(page, '#/imports');
    const refused = page.locator('button.is-refused');
    assert.equal(await refused.count(), 1, 'the control is offered and refused, not silently missing');
    assert.equal(await refused.getAttribute('aria-disabled'), 'true');
    // A refusal with a reason in it, on screen — not only in a title attribute.
    const text = await visibleText(page, '#app');
    assert.match(text, /admin role/i);
    assert.match(text, /Operations/);
  });
});

// ---------------------------------------------------------------------------
// The queue

test('the queue shows an approver the work that is actually theirs', async () => {
  await as('iris', async ({ page }) => {
    await goto(page, '#/queue');
    const text = await visibleText(page, '#app');
    assert.match(text, /Waiting for your approval/);
    assert.match(text, /Paging rota specification/);
    // The count that is the whole reason the nav entry exists.
    const badge = page.locator('#nav-queue-count');
    assert.ok(await badge.isVisible(), 'the queue count is on screen when there is something in it');
    assert.match((await badge.innerText()).trim(), /^[1-9]/);
  });
});

test('an empty queue says so, and shows no confident zero', async () => {
  // Quinn, not Vera: Vera asks for access in this file, and a queue that is
  // empty depending on which test ran first proves nothing twice.
  await as('quinn', async ({ page }) => {
    await goto(page, '#/queue');
    const text = await visibleText(page, '#app');
    assert.match(text, /Nothing is waiting on you/);
    assert.match(text, /No approvals, no pages of yours past review/);
    // The defect this proof found on its first run: `.nav-count` carried an
    // author `display` rule, so the badge the stylesheet promises to hide at
    // zero was painted, reading "0", for every reader with an empty queue.
    const badge = page.locator('#nav-queue-count');
    assert.equal(await badge.getAttribute('hidden'), '', 'the client hides the count at zero');
    assert.equal(await badge.isVisible(), false, 'and the stylesheet must not paint it anyway');
  });
});

// ---------------------------------------------------------------------------
// Search, and the page the record has moved on from

test('search answers in the dropdown and on the results page, from one renderer', async () => {
  await as('vera', async ({ page }) => {
    await goto(page, '#/');
    await page.fill('#search-input', 'incident');
    const dropdown = page.locator('#search-results');
    await dropdown.locator('.search-hit').first().waitFor({ state: 'visible' });
    const dropdownText = await visibleText(page, '#search-results');
    assert.match(dropdownText, /Incident escalation policy/);
    // The boundary, stated where somebody is searching.
    assert.match(dropdownText, /Bodies are searched only where a version has published/);

    // Enter is a route change like any other, and the wait has to be for the
    // view it produces rather than for "something is on screen" — which the
    // collections page it was leaving would have satisfied.
    await transition(page, () => page.press('#search-input', 'Enter'));
    const pageText = await visibleText(page, '#app');
    assert.match(pageText, /Incident escalation policy/);
    assert.match(pageText, /result/);
  });
});

test('search over a term nobody can see claims nothing about the record', async () => {
  await as('vera', async ({ page }) => {
    await goto(page, '#/search?q=kestrel');
    const text = await visibleText(page, '#app');
    // Scoped, not absolute: the result set was already narrowed to her
    // collections, so the screen must not read as a fact about the record
    // (policy question 1).
    assert.match(text, /Nothing you can see matches/);
    assert.ok(!/Nothing in the record matches/i.test(text));
    assert.ok(!text.includes('Kestrel incident protocol'), 'an empty search named the page it could not show');
  });
});

test('a superseded page says so where a reader meets it', async () => {
  await as('vera', async ({ page, f }) => {
    // The search results page.
    await goto(page, '#/search?q=runbook');
    const hit = page.locator('.search-hit', { hasText: 'On-call runbook' });
    await hit.waitFor({ state: 'visible' });
    // `innerText` is what is painted, and the badges are uppercased by the
    // stylesheet — so this reads what a person reads.
    const hitText = (await hit.innerText()).replace(/\s+/g, ' ');
    assert.match(hitText, /SUPERSEDED/i, 'a superseded page wore a plain status chip in search');
    // Beside the standing, not instead of it.
    assert.match(hitText, /DRAFT/i);
    const chip = hit.locator('.badge-superseded');
    assert.ok(await chip.isVisible());
    assert.match(await chip.getAttribute('title'), /Incident escalation policy/);

    // The dropdown, which is the same renderer and must therefore agree.
    await goto(page, '#/');
    await page.fill('#search-input', 'runbook');
    const dropHit = page.locator('#search-results .search-hit', { hasText: 'On-call runbook' });
    await dropHit.waitFor({ state: 'visible' });
    assert.match((await dropHit.innerText()).replace(/\s+/g, ' '), /SUPERSEDED/i);

    // And the collection's contents table, which is where somebody chooses.
    await goto(page, `#/collections/${f.collections.operations}`);
    const row = page.locator('tr.doc-row', { hasText: 'On-call runbook' });
    await row.waitFor({ state: 'visible' });
    assert.match((await row.innerText()).replace(/\s+/g, ' '), /SUPERSEDED/i);
    const plain = page.locator('tr.doc-row', { hasText: 'Badge printer instructions' });
    assert.ok(!/SUPERSEDED/i.test(await plain.innerText()), 'a page nothing replaces is not marked');
  });
});

test('a superseded page whose replacement is withheld discloses existence, never identity', async () => {
  await as('vera', async ({ page, f }) => {
    await goto(page, `#/collections/${f.collections.operations}`);
    const row = page.locator('tr.doc-row', { hasText: 'Severe incident notes' });
    await row.waitFor({ state: 'visible' });
    const chip = row.locator('.badge-superseded');
    assert.ok(await chip.isVisible(), 'the record states this about a page she holds, so it is disclosed');
    const title = await chip.getAttribute('title');
    assert.match(title, /do not have access to/);
    assert.ok(!title.includes('Kestrel'), 'the chip named the page that was withheld');

    // Nothing anywhere on the screen names it — not the row, not the chip, not
    // a stray attribute.
    const html = await page.content();
    assert.ok(!html.includes('Kestrel'), 'the withheld replacement is named in the page source');
    assert.ok(!html.includes(f.pages.kestrel), 'the withheld replacement’s id travelled to the browser');
  });

  // And the reader who may see both gets the name, because there is nothing to
  // withhold from her.
  await as('dana', async ({ page, f }) => {
    await goto(page, `#/collections/${f.collections.operations}`);
    const row = page.locator('tr.doc-row', { hasText: 'Severe incident notes' });
    await row.waitFor({ state: 'visible' });
    assert.match(await row.locator('.badge-superseded').getAttribute('title'), /Kestrel incident protocol/);
  });
});
