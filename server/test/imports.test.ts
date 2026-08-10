// The import screen, asserted against the files that ship.
//
// Round seven, tester 25: "There is no import UI at all — verified as both
// member and administrator." The server was finished. `POST /imports`,
// `POST /imports/upload`, `GET /imports` and `GET /imports/:id` were wired over
// a complete importer, and `public/app.js` contained ZERO occurrences of the
// word `imports`. The one failed file in that corpus was reachable only by
// filtering the audit log to `import.page` and reading a details blob.
//
// That is this remediation's recurring class — a mechanism that reads
// correctly and cannot run — so what is pinned here is mostly REACHABILITY:
// the route exists, the nav entry the chrome hides and shows is the one the
// markup declares, the re-run sends the run's own id, and the picker is drawn
// from the ability that mirrors the server's check rather than from membership.
// A renderer that draws beautifully from a screen nobody can open is the defect.
//
// `public/app.js` cannot be imported — it is an ES module that touches
// `document` at the top level — so the pure functions are lifted out of the
// source that ships, exactly as pageview.test.ts and accessibility.test.ts do.

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

function lift(name: string): string {
  const found = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(client);
  assert.ok(found, `public/app.js declares ${name}()`);
  return found[0];
}

/** A top-level object constant, written on one line or over several. */
function liftConst(name: string): string {
  const oneLine = new RegExp(`const ${name} = \\{[^\\n]*\\};`).exec(client);
  const found = oneLine ?? new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`).exec(client);
  assert.ok(found, `public/app.js declares ${name}`);
  return found[0];
}

/** The lifted renderers, over a directory the test controls. */
function renderers(people: { id: string; name: string }[] = []) {
  const source = `
    ${liftConst('TYPE_LABELS')}
    ${liftConst('TYPE_FIELDS')}
    ${liftConst('IMPORT_SOURCE_LABELS')}
    ${liftConst('IMPORT_OUTCOME_LABELS')}
    ${liftConst('IMPORT_HIERARCHY_NOTES')}
    const PEOPLE = ${JSON.stringify(people)};
    const SYSTEM_ACTOR_ID = 'system:canon';
    const SYSTEM_ACTOR_NAME = 'Canon';
    ${lift('esc')}
    ${lift('fmtDate')}
    function actorById(id) { return PEOPLE.find((a) => a.id === id) ?? null; }
    ${lift('actorName')}
    ${lift('importOutcomeHTML')}
    ${lift('importCountsHTML')}
    ${lift('importFieldsHTML')}
    ${lift('importRefusalWhy')}
    return { importOutcomeHTML, importCountsHTML, importFieldsHTML, importRefusalWhy };
  `;
  return new Function(source)() as {
    importOutcomeHTML: (outcome: string) => string;
    importCountsHTML: (counts: Record<string, number>) => string;
    importFieldsHTML: (run: unknown) => string;
    importRefusalWhy: (collections: unknown[]) => string;
  };
}

test('imports: the screen exists and is reachable — a route, a nav entry, and one id between them', () => {
  // The whole defect, stated as a test: the client used to hold no reference
  // to the endpoint at all.
  assert.ok(/'\/imports'/.test(client), 'app.js calls GET /imports');
  assert.ok(/\/imports\/upload\?/.test(client), 'app.js can post an uploaded archive');

  // The router reaches both screens, and the run screen takes the id from the
  // hash rather than from a click — so a run is a LINK somebody can paste.
  assert.match(client, /parts\[0\] === 'imports'/, 'the router has an imports route');
  assert.match(client, /parts\[1\] \? viewImportRun\(parts\[1\]\) : viewImports\(\)/);

  // The nav entry the chrome hides and shows is the one the markup declares.
  // A mismatch here is silent: getElementById returns null, the entry stays
  // hidden forever, and the screen exists with no way in.
  assert.match(html, /id="nav-imports"/);
  assert.match(html, /href="#\/imports"/);
  assert.match(html, /data-nav="imports"/);
  assert.match(client, /getElementById\('nav-imports'\)/);
  assert.match(client, /parts\[0\] === 'imports' \? 'imports'/, 'the nav entry is marked current on its own route');

  // And the chrome actually probes for it on sign-in, beside the other
  // optional surfaces. Without this call the entry is never unhidden.
  assert.match(client, /detectSources\(\);\s*\n\s*detectGaps\(\);\s*\n\s*detectImports\(\);/);
});

test('imports: the collection picker is drawn from the ability that mirrors the server’s check', () => {
  // `runImport` is `admin` on the collection and nothing else (import.ts,
  // "ADMIN, NOT EDIT"). Drawing the picker from membership — or from
  // `addMember`, which an org administrator also satisfies — would offer a
  // form the server throws a whole corpus away over.
  assert.match(client, /abilities\?\.runImport\?\.can === true/);
  assert.ok(
    !/abilities\?\.addMember[\s\S]{0,80}import/i.test(client),
    'the import screen must not borrow the membership ability',
  );
});

test('imports: a re-run sends the run’s own id, which is what makes it a retry', () => {
  // The retry three testers asked for needs no new server anything: the same
  // run id skips files whose content has not changed and tries the failed ones
  // again. A re-run that minted a NEW id would import the whole corpus twice.
  const rerun = lift('confirmRerun');
  assert.match(rerun, /runId: run\.runId/);
  assert.match(rerun, /fields: run\.fields/, 'a re-run repeats the ownership the run recorded');
  assert.match(rerun, /'POST', '\/imports'/);
});

test('imports: an outcome is rendered as itself, and only counts that happened are shown', () => {
  const { importOutcomeHTML, importCountsHTML } = renderers();

  assert.match(importOutcomeHTML('failed'), /import-outcome-failed/);
  assert.match(importOutcomeHTML('failed'), />Failed</);
  assert.match(importOutcomeHTML('imported'), />Imported</);

  const line = importCountsHTML({ found: 7, imported: 6, updated: 0, skipped: 0, failed: 1 });
  assert.match(line, /6 imported/);
  assert.match(line, /1 failed/);
  // "0 failed" beside "6 imported" reads as a claim that nothing failed, on a
  // screen whose whole job is to say what did.
  assert.doesNotMatch(line, /0 /);
  assert.match(importCountsHTML({ found: 0, imported: 0, updated: 0, skipped: 0, failed: 0 }), /nothing to import/);
});

test('imports: the run says who owns what it landed, and says so when nobody was named', () => {
  const { importFieldsHTML } = renderers([{ id: 'a1', name: 'Dana Whitfield' }]);

  const named = importFieldsHTML({ type: 'spec', fields: { ownerId: 'a1', approverId: null, reviewDate: '2099-03-01' } });
  assert.match(named, /Dana Whitfield/);
  assert.match(named, /Owner/);
  // The finding was "Owner —, Approver —, Review due —" across nine pages. An
  // empty cell is what let that pass unread; the words are what make it a
  // thing somebody fixes.
  assert.match(named, /nobody named/, 'an approver nobody set says so');

  // A Note carries none of the three (TYPE_RULES), so the screen states that
  // rather than drawing three empty rows that read as an omission.
  const note = importFieldsHTML({ type: 'note', fields: { ownerId: null, approverId: null, reviewDate: null } });
  assert.match(note, /never holds the Canonical mark/);
  assert.doesNotMatch(note, /nobody named/);
});

test('imports: the refusal describes the listing, never the record', () => {
  const { importRefusalWhy } = renderers();

  // One collection: the server's own sentence, verbatim. Two vocabularies for
  // one refusal is the thing abilities.ts exists to prevent.
  const one = importRefusalWhy([
    { abilities: { runImport: { can: false, why: 'Importing needs the admin role on Compliance; you hold view there. Dana holds it.' } } },
  ]);
  assert.equal(one, 'Importing needs the admin role on Compliance; you hold view there. Dana holds it.');

  // Several: there is no single server sentence, so what is said describes the
  // collections this reader belongs to and claims nothing about any other.
  const many = importRefusalWhy([{ abilities: {} }, { abilities: {} }, { abilities: {} }]);
  assert.match(many, /none of the 3 collections you belong to/);
  const none = importRefusalWhy([]);
  assert.match(none, /you belong to no collection yet/);
});

test('imports: the outcome palette and the touch floor come from the record’s own tokens', () => {
  assert.match(css, /\.import-outcome-failed \{[^}]*var\(--danger\)/);
  assert.match(css, /\.import-outcome-imported \{[^}]*var\(--accent\)/);
  // The iOS zoom guard: a text input under 16px zooms the whole dialog on
  // focus, and this dialog is full of them.
  assert.match(css, /\[data-where\] input \{ font-size: max\(16px/);
});

test('a label the script hides is actually hidden', () => {
  // The third instance of a trap this stylesheet already documents twice
  // (`.topnav[hidden]`, `.tree-toggle[hidden]`): an author `display` rule
  // outranks the UA's `[hidden] { display: none }`, so `label { display:
  // block }` kept every script-hidden label on screen. Found by driving the
  // identity screen in a browser — "Registry reference (Agent Passport)" is
  // set `hidden` for a person and was visible to everybody — and the import
  // dialog's owner, approver, review-date and where-is-it rows all depend on
  // it. Source-only, like every other assertion in this file, but the rule it
  // pins is what makes four hidden rows in one dialog actually hide.
  assert.match(css, /label\[hidden\] \{ display: none; \}/);
  assert.match(client, /<label id="registry-ref-row" hidden>/, 'the identity screen hides that row by attribute');
  assert.match(client, /#registry-ref-row'\)\.hidden = /, 'and toggles it from script');
});
