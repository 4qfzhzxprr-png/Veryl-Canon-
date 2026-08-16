/**
 * Dates, as a reader reads them.
 *
 * Two rules, both learned from the original client rather than invented:
 *
 *   * **the reader's own locale and time zone**, via `Intl` — a record whose
 *     timestamps are all UTC makes everyone outside UTC do arithmetic to
 *     answer "was that today";
 *   * **"3 hours ago" beside the timestamp, never instead of it.** Relative
 *     time is what a person scanning a list actually wants; the absolute time
 *     is what they need the moment the question becomes serious, which on an
 *     audit log is most of the time.
 *
 * Every one of these takes an ISO string that may be empty or malformed,
 * because the server sends null for "never" and the client must not render
 * "Invalid Date" at a reader.
 */

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function formatDate(iso: string | null | undefined, fallback = "—"): string {
  const at = parse(iso);
  return at ? DATE.format(at) : fallback;
}

export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  const at = parse(iso);
  return at ? DATE_TIME.format(at) : fallback;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "4 minutes ago", "in 3 days".
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled table, so it is right in
 * languages where "1 day" and "2 days" are not the same word — which a
 * hand-rolled English table gets wrong silently for everybody else.
 */
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  const at = parse(iso);
  if (!at) return null;
  const delta = at.getTime() - now;
  const abs = Math.abs(delta);
  if (abs < MINUTE) return "just now";
  if (abs < HOUR) return RELATIVE.format(Math.round(delta / MINUTE), "minute");
  if (abs < DAY) return RELATIVE.format(Math.round(delta / HOUR), "hour");
  if (abs < 30 * DAY) return RELATIVE.format(Math.round(delta / DAY), "day");
  return RELATIVE.format(Math.round(delta / (30 * DAY)), "month");
}

/** A count and its noun, agreeing. `plural(1, "page")` → "1 page". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The words the product uses, not the words the database stores. */
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  canonical: "Canonical",
  needs_update: "Needs update",
  archived: "Archived",
  superseded: "Superseded",
};

export const TYPE_LABELS: Record<string, string> = {
  policy: "Policy",
  spec: "Spec",
  plan: "Plan",
  note: "Note",
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  steward: "Steward",
  author: "Author",
  reader: "Reader",
};
