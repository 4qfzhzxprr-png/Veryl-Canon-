// Every route a reader can reach, walked in a real browser, twice: once as
// somebody who administers everything and once as somebody who may read one
// collection and nothing else.
//
// What this file holds is not any one screen's behaviour — the surfaces proof
// next door does that — but the two properties that have to be true of ALL of
// them, and that are invisible to a unit test:
//
//   1. NOTHING THE APP MARKS HIDDEN IS ON SCREEN. `label { display: block }`
//      outranked the user agent's `[hidden] { display: none }` and every label
//      the client hid from script stayed painted, on real screens, twice.
//      Nothing threw, the DOM was exactly as the code intended, and only a
//      computed style could tell. So it is a rule here, applied to every route
//      for every reader, rather than a check on the one element that was
//      reported.
//   2. NO PAGE ERRORS. An uncaught exception in a single-page app stops the
//      view where it stood — often with the loading placeholder still on
//      screen — and the server never hears about it.
//
// Both readers walk the same list, because half of Canon's defects only exist
// for the reader who cannot see everything.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startCanon } from '../lib/server.mjs';
import { buildRecord } from '../lib/record.mjs';
import {
  describeOffenders,
  goto,
  hiddenButVisible,
  hiddenCount,
  launch,
  openAs,
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

/** Every route the router answers, named the way the product names them. */
function routesFor(f) {
  return [
    ['collections', '#/'],
    ['the queue', '#/queue'],
    ['the audit log', '#/audit'],
    ['gaps', '#/gaps'],
    ['sources', '#/sources'],
    ['imports', '#/imports'],
    ['one import run', `#/imports/${f.importRunId}`],
    ['search results', '#/search?q=incident'],
    ['search that finds nothing', '#/search?q=zzzznothing'],
    ['ask', '#/ask'],
    ['the whole-record map', '#/map'],
    ['one collection', `#/collections/${f.collections.operations}`],
    ['a collection map', `#/collections/${f.collections.operations}/map`],
    ['a collection’s members', `#/collections/${f.collections.operations}/members`],
    ['a canonical page', `#/pages/${f.pages.incidentPolicy}`],
    ['a superseded page', `#/pages/${f.pages.runbook}`],
    ['a page in review', `#/pages/${f.pages.inReview}`],
    ['the editor', `#/pages/${f.pages.printerNote}/edit`],
    ['version history', `#/pages/${f.pages.incidentPolicy}/history`],
    ['one version', `#/pages/${f.pages.incidentPolicy}/versions/1`],
    ['a page in another collection', `#/pages/${f.pages.kestrel}`],
    ['a page that does not exist', '#/pages/00000000-0000-4000-8000-000000000000'],
    ['a route nobody defined', '#/nowhere'],
  ];
}

for (const who of ['dana', 'vera']) {
  describe(`every route, as ${who}`, () => {
    test(`${who}: no route paints anything it marked hidden, and none throws`, async () => {
      const f = canon.fixture;
      const { context, page, watch } = await openAs(browser, canon.baseUrl, f.actors[who]);
      try {
        let hiddenSeen = 0;
        const screens = new Set();
        for (const [name, route] of routesFor(f)) {
          await goto(page, route);

          // The walk really walked: the router is on the route that was asked
          // for. (`#/inbox` and friends rewrite themselves, so this is an
          // equality on what was requested, not on what the app settled at —
          // none of the routes below is an alias.)
          assert.equal(
            new URL(page.url()).hash,
            route,
            `${name} did not end up on the route it asked for`,
          );

          const offenders = await hiddenButVisible(page);
          assert.equal(
            offenders.length,
            0,
            `${route} (${name}) paints elements it marked hidden:\n${describeOffenders(offenders)}`,
          );
          hiddenSeen += await hiddenCount(page);

          // A screen a person can read something on. A route that renders an
          // empty main is a route that failed quietly.
          const text = await visibleText(page, '#app');
          assert.ok(text.length > 0, `${route} (${name}) drew nothing a reader can read`);
          screens.add(text);

          assert.deepEqual(
            watch.pageErrors,
            [],
            `${route} (${name}) threw in the browser: ${watch.pageErrors.join(' | ')}`,
          );
          assert.deepEqual(
            watch.serverErrors,
            [],
            `${route} (${name}) got a 5xx: ${watch.serverErrors.join(' | ')}`,
          );
          assert.deepEqual(
            watch.unexplainedConsoleErrors(),
            [],
            `${route} (${name}) logged an error: ${watch.unexplainedConsoleErrors().join(' | ')}`,
          );
        }

        // The guard must have had something to guard. A run where nothing was
        // ever hidden would pass rule 1 by having no subjects, which is the
        // way a rule like this quietly stops meaning anything.
        assert.ok(hiddenSeen > 0, 'no route hid anything, so the hidden-visibility rule proved nothing');

        // And the routes were really different screens rather than one screen
        // walked past twenty-three times, which is the way a sweep like this
        // quietly stops sweeping. A few genuinely coincide — a page that does
        // not exist and a route nobody defined both land somewhere ordinary —
        // so the floor is most of them, not all.
        assert.ok(
          screens.size >= routesFor(f).length - 4,
          `only ${screens.size} distinct screens across ${routesFor(f).length} routes`,
        );
      } finally {
        await context.close();
      }
    });
  });
}

// The rule above is worth exactly as much as its ability to fail. This is the
// reported defect, reproduced: an author `display` rule on an element the app
// has hidden. If `hiddenButVisible` cannot see this, it cannot see the next
// one either.
test('the hidden-visibility rule catches the defect it exists for', async () => {
  const { context, page } = await openAs(browser, canon.baseUrl, canon.fixture.actors.dana);
  try {
    await goto(page, '#/');
    assert.deepEqual(await hiddenButVisible(page), [], 'the record starts clean');

    // The shape of the defect exactly: one author rule that says `display`,
    // on an element the app has hidden. That is all it ever took — an author
    // rule outranks the user agent's `[hidden] { display: none }` whatever it
    // is attached to. (A `label` will not do as the victim any more, because
    // the product now carries `label[hidden] { display: none }` and that rule
    // is more specific — which is the fix working, not the guard failing.)
    await page.addStyleTag({ content: '.proof-victim { display: block; }' });
    await page.evaluate(() => {
      const victim = document.createElement('div');
      victim.className = 'proof-victim';
      victim.hidden = true;
      victim.textContent = 'Registry reference (Agent Passport)';
      document.getElementById('app').appendChild(victim);
    });

    const offenders = await hiddenButVisible(page);
    assert.equal(offenders.length, 1, 'the rule did not see a hidden element that is painted');
    assert.equal(offenders[0].display, 'block');
    assert.match(describeOffenders(offenders), /Registry reference/);
  } finally {
    await context.close();
  }
});
