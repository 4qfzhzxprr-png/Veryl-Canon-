import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveFieldNotice, LIVE_FIELD_LEAD, type Citation } from '../src/answers.js';

// Finding 6 (Marcus, rounds three and six): the live federated value reached a
// reader only by opening the page — the answer's prose showed the stale figure
// the policy was written with, while the service-resolved value rode the
// citation as metadata a reader who takes the prose never sees. `liveFieldNotice`
// is the footer that puts the live value into the answer's own words. These
// cover the wording across fresh, stale, and unreadable, and that an ordinary
// answer with no fields gains nothing.

function citation(fields: Citation['fields']): Citation {
  return { pageId: 'p1', title: 'Standard plan deductible', version: 1, snippet: 'x', fields };
}

test('liveFieldNotice: nothing to say when no cited page carries a field', () => {
  assert.equal(liveFieldNotice([citation(undefined)]), null);
  assert.equal(liveFieldNotice([citation([])]), null);
  assert.equal(liveFieldNotice([]), null);
});

test('liveFieldNotice: a fresh value is stated with its source and resolution time', () => {
  const notice = liveFieldNotice([
    citation([
      {
        label: 'Deductible (individual)',
        value: 1500,
        sourceName: 'Benefits Admin',
        role: 'authority',
        resolvedAt: '2026-08-04T00:00:00.000Z',
        stale: false,
      },
    ]),
  ]);
  assert.ok(notice, 'a field produces a notice');
  assert.ok(notice!.startsWith(LIVE_FIELD_LEAD));
  assert.match(notice!, /Deductible \(individual\): 1500, from Benefits Admin, current as of 2026-08-04T00:00:00\.000Z\./);
  // The live value, not a restatement of any prose figure, and not $-formatted:
  // the record holds a number, and inventing units would be Canon speaking.
  assert.ok(!notice!.includes('$'), 'the raw value is shown as the record holds it');
});

test('liveFieldNotice: a stale value is shown AND marked possibly out of date', () => {
  const notice = liveFieldNotice([
    citation([
      {
        label: 'Deductible (individual)',
        value: 1200,
        sourceName: 'Benefits Admin',
        role: 'authority',
        resolvedAt: '2026-07-01T00:00:00.000Z',
        stale: true,
        error: 'connect ETIMEDOUT',
      },
    ]),
  ]);
  assert.match(notice!, /1200, from Benefits Admin, last read 2026-07-01/);
  assert.match(notice!, /not refreshed since \(connect ETIMEDOUT\)/);
  assert.match(notice!, /possibly out of date/);
});

test('liveFieldNotice: a value that could not be read is never guessed', () => {
  const notice = liveFieldNotice([
    citation([
      {
        label: 'Deductible (individual)',
        value: null,
        sourceName: 'Benefits Admin',
        role: 'authority',
        resolvedAt: null,
        stale: false,
        error: 'no cached value',
      },
    ]),
  ]);
  assert.match(notice!, /could not be read from Benefits Admin \(no cached value\), and no earlier value is held\./);
  // Never a zero, never a default.
  assert.ok(!/: 0,/.test(notice!), notice!);
});

test('liveFieldNotice: a corroborating source says so', () => {
  const notice = liveFieldNotice([
    citation([
      {
        label: 'Deductible (individual)',
        value: 1500,
        sourceName: 'Claims System',
        role: 'corroboration',
        resolvedAt: '2026-08-04T00:00:00.000Z',
        stale: false,
      },
    ]),
  ]);
  assert.match(notice!, /from Claims System \(corroborating\)/);
});
