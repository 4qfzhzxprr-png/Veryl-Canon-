import { describe, expect, it } from "vitest";
import { diffLines, toHunks, DIFF_LINE_CEILING } from "./diff";

/**
 * The comparison is the screen somebody opens to answer "what changed in our
 * policy between March and now", and they act on the answer. Every test here is
 * a way a diff can be plausibly, quietly wrong.
 */

const text = (...lines: string[]) => lines.join("\n");
const shown = (result: ReturnType<typeof diffLines>) =>
  result.lines.map((l) => `${l.op === "same" ? " " : l.op === "added" ? "+" : "-"}${l.text}`);

describe("diffLines", () => {
  it("reports nothing changed when nothing changed", () => {
    const result = diffLines(text("a", "b", "c"), text("a", "b", "c"));
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines.every((l) => l.op === "same")).toBe(true);
  });

  it("treats a trailing newline as the same document", () => {
    // "a\n" and "a" read identically. A naive split makes the first a two-line
    // document whose second line is empty, and reports a removed blank line on
    // every single comparison.
    const result = diffLines("a\nb\n", "a\nb");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("does not report every following line as changed after one insertion", () => {
    // THE REASON THIS IS AN LCS AND NOT A LINE-BY-LINE WALK. The cheap version
    // reports lines 2..n as changed, so on a forty-line page the reader is
    // shown thirty-nine false changes and has to find the real one themselves.
    const before = text("one", "two", "three", "four");
    const after = text("one", "INSERTED", "two", "three", "four");
    const result = diffLines(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(shown(result)).toEqual([" one", "+INSERTED", " two", " three", " four"]);
  });

  it("keeps a deletion at the very end", () => {
    // The tail loops are easy to leave out and the diff still looks plausible
    // without them — it is just missing the end.
    const result = diffLines(text("a", "b", "c"), text("a"));
    expect(result.removed).toBe(2);
    expect(shown(result)).toEqual([" a", "-b", "-c"]);
  });

  it("keeps an addition at the very end", () => {
    const result = diffLines(text("a"), text("a", "b", "c"));
    expect(result.added).toBe(2);
    expect(shown(result)).toEqual([" a", "+b", "+c"]);
  });

  it("treats an empty version as no lines, not one blank one", () => {
    // `"".split("\n")` is `[""]`. Taken literally, every comparison against an
    // empty version reports a removed blank line that never existed.
    const added = diffLines("", text("a", "b"));
    expect(added.added).toBe(2);
    expect(added.removed).toBe(0);

    const removed = diffLines(text("a", "b"), "");
    expect(removed.removed).toBe(2);
    expect(removed.added).toBe(0);

    expect(diffLines("", "").lines).toEqual([]);
  });

  it("shows a changed line as one removal and one addition, in that order", () => {
    const result = diffLines(text("keep", "old", "keep2"), text("keep", "new", "keep2"));
    expect(shown(result)).toEqual([" keep", "-old", "+new", " keep2"]);
  });

  it("numbers lines against the version each one belongs to", () => {
    // A removed line has no line number in the newer version and vice versa.
    // Reporting a number for both is how a reader is sent to the wrong line.
    const result = diffLines(text("a", "gone", "b"), text("a", "b"));
    const removedLine = result.lines.find((l) => l.op === "removed")!;
    expect(removedLine).toMatchObject({ before: 2, after: null });
    const lastSame = result.lines[result.lines.length - 1]!;
    expect(lastSame).toMatchObject({ op: "same", before: 3, after: 2 });
  });

  it("does not lose a duplicated line", () => {
    // Repeated identical lines are where a naive matcher pairs the wrong ones.
    const result = diffLines(text("x", "x", "x"), text("x", "x"));
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
  });

  it("normalises Windows line endings rather than reporting every line changed", () => {
    const result = diffLines("a\r\nb\r\nc", "a\nb\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("refuses a pair too large to compare, rather than freezing the tab", () => {
    // O(n·m): two 5,000-line versions is twenty-five million cells, on the
    // screen somebody opened because they were in a hurry.
    const huge = Array.from({ length: DIFF_LINE_CEILING + 1 }, (_, i) => `line ${i}`).join("\n");
    const result = diffLines(huge, huge);
    expect(result.tooLarge).toBe(true);
    expect(result.lines).toEqual([]);
  });
});

describe("toHunks", () => {
  it("keeps context either side of a change and collapses the rest", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line fifteen");
    const hunks = toHunks(diffLines(before, after).lines, 2);

    expect(hunks).toHaveLength(1);
    // Two lines of context, the removal, the addition, two more of context.
    expect(hunks[0]!.lines).toHaveLength(6);
    expect(hunks[0]!.skipped).toBeGreaterThan(0);
  });

  it("returns nothing to show when nothing changed", () => {
    const same = text("a", "b", "c");
    expect(toHunks(diffLines(same, same).lines)).toEqual([]);
  });

  it("keeps two distant changes in separate hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 2", "CHANGED").replace("line 35", "ALSO");
    const hunks = toHunks(diffLines(before, after).lines, 2);
    expect(hunks).toHaveLength(2);
  });
});
