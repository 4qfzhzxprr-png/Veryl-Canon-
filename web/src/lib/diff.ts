/**
 * A line diff, for comparing two versions of a page.
 *
 * **Correctness matters more here than anywhere else in this client.** A
 * comparison is the screen somebody opens to answer "what changed in our policy
 * between March and now", and they act on the answer. A diff that drops a
 * removed line, or shows a moved paragraph as an unrelated deletion and
 * addition, is not a cosmetic bug — it is a wrong answer about the record.
 *
 * So this is a real longest-common-subsequence diff rather than a line-by-line
 * walk. The cheap version (compare line 1 to line 1, line 2 to line 2) reports
 * every line after a single inserted paragraph as changed, which on a page of
 * forty lines means the reader is shown thirty-nine false changes and has to
 * find the real one themselves.
 */
export type Op = "same" | "added" | "removed";

export interface DiffLine {
  op: Op;
  text: string;
  /** 1-based line number in the older version, where it exists there. */
  before: number | null;
  /** 1-based line number in the newer version, where it exists there. */
  after: number | null;
}

/**
 * Bounded on purpose. LCS is O(n·m) in both time and memory, and two 5,000-line
 * versions would allocate twenty-five million cells in the browser — a frozen
 * tab, on the screen somebody opened because they were in a hurry.
 *
 * Past the ceiling the caller is told, and says so, rather than being handed a
 * silently degraded diff.
 */
export const DIFF_LINE_CEILING = 2_000;

export interface DiffResult {
  lines: DiffLine[];
  /** True when the pair was too large to compare properly. `lines` is empty. */
  tooLarge: boolean;
  added: number;
  removed: number;
}

export function diffLines(before: string, after: string): DiffResult {
  // Trailing-newline handling: "a\n" and "a" are the same text to a reader, and
  // splitting naively makes the first a two-line document whose second line is
  // empty — reported as one removed blank line on every comparison.
  const a = split(before);
  const b = split(after);

  if (a.length > DIFF_LINE_CEILING || b.length > DIFF_LINE_CEILING) {
    return { lines: [], tooLarge: true, added: 0, removed: 0 };
  }

  // Classic LCS table. `lcs[i][j]` is the length of the longest common
  // subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: "same", text: a[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ op: "removed", text: a[i]!, before: i + 1, after: null });
      removed += 1;
      i += 1;
    } else {
      lines.push({ op: "added", text: b[j]!, before: null, after: j + 1 });
      added += 1;
      j += 1;
    }
  }
  // Whatever is left is entirely one-sided. Both loops are needed: dropping
  // either silently truncates the end of the comparison, which is the failure
  // mode nobody notices because the diff still looks plausible.
  while (i < a.length) {
    lines.push({ op: "removed", text: a[i]!, before: i + 1, after: null });
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    lines.push({ op: "added", text: b[j]!, before: null, after: j + 1 });
    added += 1;
    j += 1;
  }

  return { lines, tooLarge: false, added, removed };
}

function split(text: string): string[] {
  // An empty document is ZERO lines, not one empty one. `"".split("\n")` gives
  // `[""]`, and taking that literally makes every comparison against an empty
  // version report a phantom removed blank line — a change the reader is told
  // about that never happened.
  if (text === "") return [];
  const normalised = text.replace(/\r\n?/g, "\n");
  const lines = normalised.split("\n");
  // One trailing empty line is the document's final newline, not a blank line
  // somebody wrote.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Collapse long stretches of unchanged text, keeping `context` lines either
 * side of every change.
 *
 * A comparison of two forty-page policies that differ in one sentence is
 * unreadable in full, and scrolling for the highlighted line is exactly the
 * work this screen exists to save.
 */
export interface Hunk {
  lines: DiffLine[];
  /** Unchanged lines hidden before this hunk. */
  skipped: number;
}

export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const interesting = lines.map((line) => line.op !== "same");
  const keep = lines.map((_, index) =>
    interesting.slice(Math.max(0, index - context), index + context + 1).some(Boolean),
  );

  const hunks: Hunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      current.push(lines[index]!);
    } else if (current.length) {
      hunks.push({ lines: current, skipped });
      current = [];
      skipped = 1;
    } else {
      skipped += 1;
    }
  }
  if (current.length) hunks.push({ lines: current, skipped });
  return hunks;
}
