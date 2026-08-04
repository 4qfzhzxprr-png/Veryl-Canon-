import { CanonError } from './model.js';

// Reading untrusted request bodies.
//
// WHY THIS FILE EXISTS
//
// A body arrives as `JSON.parse` output and is typed `any` from the moment it
// enters api.ts. TypeScript then believes every declared interface — `AskRequest
// { question: string }` — about a value it has never checked. So
// `request.question.trim()` on `{"question": 42}` is a TypeError, and a
// TypeError is a 500 with a correlation id: Canon telling an integrator that
// Canon is broken, when the truth is that their JSON was wrong and they could
// have fixed it in a second. An integrator testing our error handling found
// three of these in the first hour.
//
// The 500 is also the least of it. `{"collectionId": 12}` did not crash — it
// bound a number where a TEXT id belongs, matched nothing, and answered "the
// record is silent on this" with a straight face. That is the exact failure the
// product exists to prevent, produced by a typo.
//
// WHAT A READER DOES AND DOES NOT DO
//
// It checks the type and refuses anything else. It does NOT coerce: `12` does
// not become `"12"` and `"true"` does not become `true`. Coercion is how a
// caller's mistake becomes a caller's silent wrong answer, and a 400 naming the
// field is worth more to them than a guess.
//
// The message always names the field and says what was sent, because the person
// reading it is holding a JSON body and needs to know which line is wrong.

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function refuse(field: string, wanted: string, value: unknown): never {
  throw new CanonError('invalid', `${field} must be ${wanted}, and this request sent ${describe(value)}`, {
    field,
  });
}

/**
 * The body itself, before any field is read. `JSON.parse` happily returns a
 * number, a string, `null` or an array for a well-formed body, and every
 * handler beneath here assumes an object; `body.question` on the string
 * `"hello"` is `undefined`, which reads as "no question was sent" when a
 * question plainly was.
 */
export function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonError('invalid', `A request body must be a JSON object, and this request sent ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') refuse(field, 'a string', value);
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') refuse(field, 'a string', value);
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') refuse(field, 'a boolean', value);
  return value;
}

/**
 * A count: a whole number, one or more. Everything this project calls a `limit`
 * is one of these, and every one of them ends up in a SQL LIMIT — where `NaN`
 * from a `Number("abc")` binds as null and quietly returns nothing.
 */
export function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    if (typeof value !== 'number') refuse(field, 'a whole number of at least 1', value);
    throw new CanonError('invalid', `${field} must be a whole number of at least 1, and this request sent ${value}`, {
      field,
    });
  }
  return value;
}

export function requiredCount(value: unknown, field: string): number {
  const count = optionalCount(value, field);
  if (count === undefined) throw new CanonError('invalid', `${field} is required`, { field });
  return count;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) refuse(field, 'an array of strings', value);
  value.forEach((item, at) => {
    if (typeof item !== 'string') refuse(`${field}[${at}]`, 'a string', item);
  });
  return value as string[];
}

/**
 * A query-string count. Separate from `optionalCount` because a query string
 * carries only text: `?limit=50` is the string "50" and must be read as 50,
 * while `?limit=abc` must be refused rather than become the `NaN` that
 * `Number()` returns and SQLite binds as null.
 */
export function countParam(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CanonError('invalid', `${field} must be a whole number of at least 1, and this request sent "${raw}"`, {
      field,
    });
  }
  return parsed;
}

/**
 * A query-string identifier: a page id, a collection id, an actor id. The only
 * thing being checked is that something was actually sent, because
 * `?collectionId=` — a parameter typed and then left empty — arrives as the
 * empty string, and an empty string that flows on as "no filter" is the exact
 * shape of the defect this file exists to stop: a caller who asked to narrow,
 * and got the unfiltered answer back looking narrowed.
 *
 * The id is not checked against the record here. A filter naming a collection
 * that does not exist, or one the asker holds no role in, correctly returns
 * nothing; that is a true answer, not a malformed request.
 */
export function idParam(raw: string | null, field: string): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CanonError('invalid', `${field} was sent empty. Leave it off to mean "no filter on ${field}"`, { field });
  }
  return trimmed;
}

// A date, or a date and a time. Both are accepted from a query string because
// both are what people type: an auditor scoping a sample writes `2026-07-01`,
// and a tool paging a window writes the full instant it read off the last row.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

function refuseInstant(field: string, raw: string): never {
  throw new CanonError(
    'invalid',
    `${field} must be a date (2026-07-01) or an instant (2026-07-01T09:30:00Z), and this request sent "${raw}"`,
    { field },
  );
}

/**
 * A point in time from a query string, as one end of a range.
 *
 * WHY THIS IS NOT `new Date(raw).toISOString()` AND NOTHING ELSE
 *
 * The columns these bounds are compared against hold ISO-8601 UTC strings, and
 * the comparison SQLite performs on them is a STRING comparison. That works —
 * ISO-8601 UTC sorts lexicographically in time order, which is why the format
 * was chosen — but only while both sides are in the same shape. Two ways it
 * silently is not, both of which a person will hit on their first afternoon:
 *
 *   * A BARE DATE AS THE UPPER BOUND. `to=2026-07-01` compared as text against
 *     `2026-07-01T09:30:00.000Z` is *smaller*, so an auditor asking for
 *     "through the first of July" is handed a range that stops at midnight and
 *     excludes the whole of the day they named. Nothing errors; the sample is
 *     just quietly short. So a bare date is expanded to the edge of the day it
 *     names — the start of it for a lower bound, the last millisecond of it for
 *     an upper one — and which end it is has to be stated by the caller, which
 *     is why `edge` is a required argument rather than a default.
 *
 *   * AN OFFSET. `2026-07-01T09:30:00+02:00` is a real instant and a real
 *     ISO-8601 string, and comparing its text against a `Z` string is
 *     meaningless. It is converted to UTC instead of being refused, because
 *     the caller said exactly what they meant.
 *
 * A timestamp with NO zone at all is read as UTC. That is a guess, and it is
 * the one this project can defend: every `at` in the record is UTC, so a naive
 * timestamp read as local time would mean a filter whose results changed with
 * the server's timezone. The UI states which it is sending.
 *
 * Anything else is refused rather than coerced — `?from=last%20tuesday` and
 * `?from=1751364000` both become `Invalid Date`, and an `Invalid Date` bound
 * that becomes the string "Invalid Date" in a WHERE clause matches nothing and
 * reports it as an empty log.
 */
export function instantParam(raw: string | null, field: string, edge: 'start' | 'end'): string | undefined {
  if (raw === null || raw === '') return undefined;
  const text = raw.trim();
  if (DATE_ONLY.test(text)) {
    // `2026-02-30` matches the shape and is not a day; Date rolls it forward to
    // March 2 rather than refusing, so the round trip is what catches it.
    const day = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) refuseInstant(field, raw);
    return edge === 'start' ? `${text}T00:00:00.000Z` : `${text}T23:59:59.999Z`;
  }
  if (!TIMESTAMP.test(text)) refuseInstant(field, raw);
  const at = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`);
  if (Number.isNaN(at.getTime())) refuseInstant(field, raw);
  return at.toISOString();
}

/**
 * Refuse a query parameter the endpoint does not read.
 *
 * WHY AN ENDPOINT WOULD BOTHER
 *
 * An external auditor reviewing this product filtered the audit log with
 * `?collectionId=…`, got a full unfiltered log back, and reported it as the
 * most serious thing she found — not because the filter was missing, but
 * because it *looked* applied. Her words: silently ignoring a parameter is
 * worse than rejecting it, because rejection costs a person thirty seconds and
 * a silent ignore costs them a conclusion. A typo in a parameter name is the
 * same failure with a smaller cause: `?pagId=…` is not a filter, it is an
 * unfiltered log with a filtered-looking URL over the top of it.
 *
 * This is opt-in per endpoint rather than global. A route that has been
 * published for a while may have callers sending parameters it has always
 * ignored, and breaking them to make a point is not a trade worth taking; the
 * audit surface is where an ignored parameter changes what a person believes
 * about a population, so that is where the strictness earns its keep.
 *
 * `hint` is a sentence appended to the refusal — the place to name the
 * endpoint that DOES do what the caller was evidently reaching for.
 */
export function knownParams(query: URLSearchParams, allowed: readonly string[], hint = ''): void {
  for (const name of query.keys()) {
    if (allowed.includes(name)) continue;
    throw new CanonError(
      'invalid',
      `This endpoint does not read the query parameter "${name}", so applying it would be a filter you were told ` +
        `about and did not get. It reads: ${allowed.join(', ')}.${hint ? ` ${hint}` : ''}`,
      { field: name, accepted: [...allowed] },
    );
  }
}
