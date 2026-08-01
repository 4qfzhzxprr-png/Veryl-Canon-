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
