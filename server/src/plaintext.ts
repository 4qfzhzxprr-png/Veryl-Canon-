// A page body, as words.
//
// Two callers need the same thing and used to have only one of them. A
// CITATION quotes the record and must quote its words rather than its
// punctuation-for-machines (retrieval.ts, `passageFor`). The SEARCH INDEX must
// be built from those same words, for a reason that turns out to be the same
// reason: a URL is not something a policy says, so it should not be findable
// as though it were, and it should not count towards how long the page is.
//
// This module owns that one decision so both get it, and get it identically.

// What "verbatim" means when the source is structured.
//
// A page body is Markdown, and `collapse` used to flatten it to one line by
// replacing every run of whitespace with a space. That is right for the
// whitespace and wrong for everything else: the newline was the only thing
// separating a heading from the paragraph beneath it, so `\n## Scope\n` became
// ` ## Scope ` sitting inside the middle of a quotation. Two testers reported
// the result — one saw `## Scope` printed as part of what "the record says",
// the other saw a page footer and a raw `/pages/<uuid>` link quoted as though
// they were policy. Both looked like rendering bugs and neither was: no
// renderer can reach a mark that is already mid-line inside a `“…”`.
//
// The decision this makes, since there is one to make: a quotation is the
// record's WORDS, not its punctuation-for-machines. So the marks that exist to
// tell a renderer what to draw are removed, and the words they were wrapped
// around are kept exactly. Nothing is paraphrased, reordered, or summarised —
// remove the marks from any line below and the words that remain are the words
// on the page, in the order they were written.
//
// Two consequences worth stating rather than discovering later:
//
//   * A LINK KEEPS ITS TEXT AND LOSES ITS TARGET. `[the schedule](…/pages/8f14)`
//     quotes as "the schedule". A URL is an instruction to a browser, not
//     something a policy says, and it was the concrete thing one tester was
//     shown as the record's own words.
//   * A TABLE IS QUOTED AS A ROW OF CELLS joined by en-dashes, which is lossy
//     and is the honest best available: a quotation is one passage of running
//     text, and a table is not. The page itself renders it as a table, and the
//     citation points there.
//
// Block boundaries become sentence boundaries, because that is what they are
// when the structure is taken away — otherwise a heading runs into the
// paragraph under it and produces a sentence nobody wrote.
export function quotableText(markdown: string): string {
  return collapse(quotableLines(markdown).join(' '));
}

/**
 * The same words, one line per block, before they are run together.
 *
 * The search index wants this rather than `quotableText` because block
 * structure is real: a heading and the paragraph under it are two things, and
 * a chunker or a snippet reads better when it can still tell.
 */
export function quotableLines(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Inside a fenced block the content is kept as written: it is somebody's
    // example, and mangling it would be its own falsehood.
    if (inFence) {
      if (line) out.push(line);
      continue;
    }
    if (!line) continue;
    // A rule separates; it says nothing. This is the page footer that was
    // being quoted as one more clause of the policy.
    if (/^([-*_])\s*(\1\s*){2,}$/.test(line)) continue;
    // A table's alignment row is pure syntax.
    if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')) continue;

    let text = line;
    if (/^\|.*\|?$/.test(text) && text.includes('|')) {
      text = text
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.replace(/\\\|/g, '|').trim())
        .filter(Boolean)
        .join(' — ');
    }
    text = text
      .replace(/^#{1,6}\s+/, '') // heading
      .replace(/^>\s?/, '') // blockquote
      .replace(/^([-*+]|\d+[.)])\s+/, ''); // list item
    text = inlineWords(text);
    if (text) out.push(endsSentence(text) ? text : `${text}.`);
  }
  return out;
}

/**
 * What the search index and the semantic chunker are built from.
 *
 * THE SAME WORDS A CITATION WOULD QUOTE, and specifically not the raw
 * Markdown, which is what was indexed before. Three things follow, and the
 * third is the one that was doing quiet damage:
 *
 *   * A LINK'S TARGET LEAVES THE INDEX. A body carrying
 *     `[Appeals Process](#/pages/8f14e45f-…)` was indexed with that UUID in
 *     it, so a page was findable by an identifier nobody can read and that
 *     appears nowhere on screen.
 *   * THE MARKS LEAVE THE INDEX, so a snippet drawn from it is prose rather
 *     than `## Scope` and `**seven years**` with the marks still attached.
 *   * DOCUMENT LENGTH BECOMES THE LENGTH OF THE PROSE. BM25 divides by how
 *     long a document is, to stop a long page outscoring a short one merely by
 *     containing more words. Counting a dozen hex tokens per outgoing link
 *     towards that length made every well-linked page look longer than it
 *     reads, and pushed it down for every query. The pages with the most
 *     outgoing links are the hub pages — the ones a question most often wants.
 *
 * Blocks are separated by a blank line rather than a space, so a chunker can
 * still see where one ends.
 */
export function indexableText(markdown: string): string {
  return quotableLines(markdown).join('\n\n');
}

/** Inline marks removed, the words they wrapped kept exactly. */
function inlineWords(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image: its alt text, never its src
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // link: its text, never its target
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])(\*|_)(?!\s)([^*_]+?)(?<!\s)\1(?![\w*])/g, '$2');
}

function endsSentence(text: string): boolean {
  return /[.!?:;,—-]$/.test(text);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
