import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { AUDIT_CSV_COLUMNS, AUDIT_CSV_MAX_ROWS, auditCsv, csvField, csvRow } from '../src/csv.js';
import { openDb } from '../src/db.js';
import type { AuditEvent } from '../src/model.js';
import { AUDIT_PAGE_DEFAULT, CanonStore } from '../src/store.js';

// An independent RFC 4180 reader, so the export is checked against the format
// rather than against the writer that produced it.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test('csv: RFC 4180 escaping of quotes, commas, newlines and edge whitespace', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('with,comma'), '"with,comma"');
  assert.equal(csvField('say "hello"'), '"say ""hello"""');
  assert.equal(csvField('line one\nline two'), '"line one\nline two"');
  assert.equal(csvField('carriage\r\nreturn'), '"carriage\r\nreturn"');
  assert.equal(csvField('  padded  '), '"  padded  "');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(42), '42');
  assert.equal(csvRow(['a', 'b,c']), 'a,"b,c"\r\n', 'records end with CRLF');
});

test('csv: the audit export survives a round trip through a strict reader', () => {
  const events: AuditEvent[] = [
    {
      id: 1,
      at: '2026-07-30T09:00:00.000Z',
      actorId: 'actor-1',
      actorKind: 'person',
      action: 'page.send_back',
      collectionId: 'col-1',
      pageId: 'page-1',
      details: { comment: 'Too vague, and it says "seven years"\nname the milestones, please' },
    },
    {
      id: 2,
      at: '2026-07-30T09:01:00.000Z',
      actorId: 'agent-1',
      actorKind: 'agent',
      action: 'import.page',
      collectionId: null,
      pageId: null,
      details: { file: 'Benefits, Overview_1.html', outcome: 'imported' },
    },
  ];
  const rows = parseCsv(auditCsv(events));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], [...AUDIT_CSV_COLUMNS]);
  assert.deepEqual(rows[1], [
    '1',
    '2026-07-30T09:00:00.000Z',
    'actor-1',
    'person',
    'page.send_back',
    'col-1',
    'page-1',
    JSON.stringify(events[0]!.details),
  ]);
  // The details column holds JSON with a quote and a newline in one field.
  assert.deepEqual(JSON.parse(rows[1]![7]!), events[0]!.details);
  assert.deepEqual(rows[2]!.slice(5, 7), ['', ''], 'a null column is an empty field, not the word null');
  assert.deepEqual(JSON.parse(rows[2]![7]!).file, 'Benefits, Overview_1.html');
});

test('API: GET /audit.csv downloads the filtered log as CSV', async () => {
  const store = new CanonStore(openDb(':memory:'));
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana, "the admin"' });
    const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
    const page = store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: 'Notes, with a comma' });
    store.editDraft(dana.id, page.id, { body: 'line one\nline two' });
    store.publish(dana.id, page.id, { note: 'says "done"' });

    const res = await fetch(`${base}/audit.csv`, { headers: { 'x-actor-id': dana.id } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="canon-audit-.*\.csv"$/);
    assert.equal(res.headers.get('x-canon-row-cap'), String(AUDIT_CSV_MAX_ROWS));
    assert.equal(res.headers.get('x-canon-truncated'), 'false');

    const rows = parseCsv(await res.text());
    assert.deepEqual(rows[0], [...AUDIT_CSV_COLUMNS]);
    const actions = rows.slice(1).map((r) => r[4]);
    assert.ok(actions.includes('page.publish') && actions.includes('collection.create'));

    // The same filters as GET /audit.
    const filtered = parseCsv(
      await (await fetch(`${base}/audit.csv?action=page.publish`, { headers: { 'x-actor-id': dana.id } })).text(),
    );
    assert.equal(filtered.length, 2);
    assert.equal(filtered[1]![4], 'page.publish');
    assert.equal(filtered[1]![6], page.id);

    // `limit` is REFUSED rather than honoured, and refused rather than
    // ignored. An export bounded by a caller's row count is a sample wearing a
    // population's clothes, and silently dropping the parameter would leave
    // the caller believing they had asked for one.
    const limited = await fetch(`${base}/audit.csv?actor=${dana.id}&limit=1`, {
      headers: { 'x-actor-id': dana.id },
    });
    assert.equal(limited.status, 400);
    assert.match((await limited.json()).message, /takes no limit/);

    const unauthenticated = await fetch(`${base}/audit.csv`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    server.close();
  }
});

// USER-TESTING.md T2.2. An export is the whole filtered population or it is
// worthless as evidence: a file holding the most recent N rows of a filter,
// with nothing on it to say so, is a sample presented as a population — and it
// is the artefact that gets attached to a report and read by somebody who was
// not there. So the export takes no `limit` at all, and it walks past the page
// size that bounds the interactive listing.
test('csv: the export carries the whole filtered population, past one page of it', () => {
  const store = new CanonStore(openDb(':memory:'));
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const collection = store.createCollection(dana.id, { name: 'Busy' });
  // Comfortably more events than one page of the interactive listing, cheaply:
  // every page creation writes one.
  for (let i = 0; i < AUDIT_PAGE_DEFAULT + 20; i++) {
    store.createPage(dana.id, { collectionId: collection.id, type: 'note', title: `N${i}` });
  }
  const total = store.auditSummary(dana.id).matching;
  assert.ok(total > AUDIT_PAGE_DEFAULT, `needs more than one page to be a real test, had ${total}`);

  const response = store.auditCsv(dana.id);
  const records = response.body.split('\r\n').filter(Boolean).length - 1; // less the header
  assert.equal(records, total, 'every matching event is in the file');
  assert.equal(response.headers['x-canon-rows'], String(total));
  assert.equal(response.headers['x-canon-truncated'], 'false');
  assert.equal(response.headers['x-canon-row-cap'], String(AUDIT_CSV_MAX_ROWS));

  // A filter narrows the file, and the file is still the WHOLE of what matched.
  const filtered = store.auditCsv(dana.id, { action: 'page.create' });
  assert.equal(
    filtered.body.split('\r\n').filter(Boolean).length - 1,
    store.auditSummary(dana.id, { action: 'page.create' }).matching,
  );
});
