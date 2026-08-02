import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, PageStatus } from './model.js';
import { STOPWORDS } from './embeddings.js';
import { objectBody, optionalCount, optionalString, optionalStringArray } from './input.js';
import { ANSWERABLE_STATUSES, type RetrievalService } from './retrieval.js';

// Grounded answers: step 4 of DATA-BACKBONE.md §5, and the Epic D promise in
// CORE-PLAN.md. Generation happens under the record's rules, and the rules are
// enforced here rather than trusted to whatever generates the prose:
//
//   * Canonical pages only. Never a Draft, never a Note, never an archived
//     page. Retrieval is asked for Canonical material and the result is
//     checked again before anything is cited.
//   * Permission-filtered per asker, in the SQL of every candidate query, so
//     material the asker cannot see never influences the answer.
//   * Every answer carries at least one citation. Not "should": an answer
//     with no citations cannot be constructed, because the answer text is
//     composed from cited passages and nothing else.
//   * Refusal is a correct answer. When the filtered, expanded context does
//     not answer the question, the response is refused with an empty citation
//     list — the response we would rather ship than a plausible guess.
//   * An answer never smooths a contradiction. When the passages an answer is
//     about to be composed from disagree with each other, the answer says so,
//     cites all of them, and does not choose (DATA-BACKBONE.md §7). Detection
//     runs HERE, outside the generator — see `detectDisagreement` below.
//   * An answer consults what the record already KNOWS about the pages it is
//     citing, and does not rely on its own reading of their prose. A
//     contradiction can exist in the record three ways: inferred from two
//     passages' text (this module), asserted by a person as a `conflicts_with`
//     relation (relations.ts), or observed between an authority and a
//     corroborating source (divergence.ts). Only the first is a guess. Reading
//     prose to find a conflict while ignoring one a person wrote down as data
//     is DATA-BACKBONE.md §2 principle 2 — structure over prose — run
//     backwards, so the answer path reads all three. See `AnswerRecord`.
//
// Every ask lands in the audit log, refusals included.

export interface Citation {
  pageId: string;
  title: string;
  version: number;
  snippet: string;
  /**
   * The standing of the cited page — `canonical` or `needs_update`, the only
   * two statuses an answer may draw on. It is carried because a reader deciding
   * whether to act on a quotation needs to know whether the page behind it is
   * current, and a caller that has to fetch each cited page to find out will
   * either guess or not bother. The answer prose says the same thing in words;
   * this is the machine-readable half.
   *
   * Optional because `AnswerPassage.status` is optional — a generator can be
   * exercised without one — and because the field is an addition to a published
   * contract (STUDIO-CONTRACT.md §"POST /knowledge/ask"). Absent means "this
   * response cannot say", NOT "canonical": a caller that defaults a missing
   * status to the most trust-bearing value it knows is asserting something the
   * record never told it. Render nothing instead.
   */
  status?: PageStatus;
}

/**
 * Why an answer was refused.
 *
 * `no_canonical_match` is this module's own and the only one it ever writes:
 * the filtered, expanded context did not answer the question. It says nothing
 * about permissions, and that is deliberate — see DATA-BACKBONE.md §5 and the
 * long note in knowledge.ts's `ask` on why an open question is never told that
 * material it may not see exists.
 *
 * `nothing_readable` is written by the Knowledge API alone (knowledge.ts), and
 * only where the (app, person) pair asking holds no readable collection at
 * all. It is a statement about the caller's own standing rather than about the
 * record — the same fact `GET /knowledge/whoami` hands that caller in full —
 * and it exists because "the record does not say" is a false statement about
 * the record when the truth is that the asker was never given anything to read
 * (USER-TESTING.md T3.7). It is not reachable from Canon's own `POST /ask`,
 * where the asker is a person whose permissions are their own and whose empty
 * intersection is a question for their administrator rather than for this API.
 */
export type RefusalReason = 'no_canonical_match' | 'nothing_readable';

/**
 * A `conflicts_with` relation standing between two of the pages this answer is
 * about to cite: a person wrote down, IN THE RECORD, that these two pages
 * disagree, and said how (relations.ts). Read, never inferred — nothing in
 * this module decides that a relation ought to exist.
 *
 * This is the strongest contradiction signal Canon holds, and the reason is
 * not subtle: a human being with `edit` on both collections put their name and
 * the date to it, and relations.ts made them explain themselves before it
 * would take the assertion. Text inference is Canon guessing; this is the
 * record stating.
 */
export interface AssertedConflict {
  fromPageId: string;
  toPageId: string;
  /** The asserter's own words. `conflicts_with` requires one, so never empty. */
  note: string;
  assertedBy: string;
  /** The asserter's name, so the answer can attribute the claim to a person. */
  assertedByName: string;
  assertedAt: string;
}

/**
 * The record disagreeing with itself, in the shape DATA-BACKBONE.md §7 fixes:
 * `disagreement?: { pageIds: [...], note }`.
 *
 * `pageIds` names every page whose passage took part in a detected conflict —
 * always at least two, always a subset of the pages this answer cites, in the
 * order the passages were offered. `note` is one reader-facing paragraph
 * naming the pages and quoting the parts that differ; it is also embedded
 * verbatim in the answer text, so a caller that renders only the prose still
 * shows the warning and a caller that renders only this field still shows it
 * too. Present only when a conflict was detected; absent otherwise, so the
 * shape every existing caller reads is unchanged.
 *
 * A disagreement now has TWO possible origins, and the note says which: a
 * conflict Canon inferred from the two passages' text, and a conflict a person
 * asserted as a `conflicts_with` relation. They land in one field because they
 * are one claim about the record — *two pages this answer draws on give
 * different answers, and nobody has settled which governs* — and a reader who
 * has to check two fields to learn that is a reader who will miss it. Which
 * one it was is never blurred: `asserted` carries the relations verbatim when
 * a person is behind any of it, and the note names that person.
 */
export interface Disagreement {
  pageIds: string[];
  note: string;
  /**
   * ADDITIVE, and absent unless a person asserted at least one of the
   * conflicts in this disagreement — so `{ pageIds, note }` is exactly what it
   * always was for every existing caller. Present, it is the evidence: who
   * said these pages conflict, when, and in what words. A UI that wants to
   * show "asserted by Dana Whitfield" rather than "Canon noticed" reads this.
   */
  asserted?: AssertedConflict[];
}

/**
 * A `supersedes` relation between two pages this answer cites. Directed: a
 * person recorded that one page replaced the other, and relations.ts stores it
 * exactly as asserted because which replaced which IS the claim.
 */
export interface AssertedSupersession {
  supersededPageId: string;
  supersededByPageId: string;
  /** Optional for `supersedes` — the claim explains itself — so often null. */
  note: string | null;
  assertedBy: string;
  assertedByName: string;
  assertedAt: string;
}

/**
 * Set when this answer quotes a page the record says has been REPLACED, beside
 * the page that replaced it. A sibling of `disagreement` rather than part of
 * it, because it is a different problem with a different remedy:
 *
 *   * a `conflicts_with` is unsettled — two pages disagree and nobody has said
 *     which governs, which is why Canon must not choose;
 *   * a `supersedes` is SETTLED, by a person, in the record. There is nothing
 *     for the reader to adjudicate; there is something for them to know, which
 *     is that one of these quotations is the old rule.
 *
 * Folding the second into `disagreement` would tell a reader two pages are in
 * unresolved conflict when the record plainly says they are not, which is its
 * own confident wrong answer.
 *
 * WHY THE SUPERSEDED PAGE IS STILL CITED. §7 is explicit that asserting
 * `supersedes` "does not archive the superseded page, does not change its
 * status, and does not stop it being cited", and relations.ts implements
 * exactly that. Silently dropping the citation would be Canon deciding — worse,
 * deciding invisibly, removing the evidence rather than the problem, and
 * leaving the reader unable to see what changed. So both are quoted and the
 * relation is stated.
 */
export interface Supersession {
  /**
   * Every cited page taking part, in the order the passages were offered —
   * both ends of every pair, so always at least two.
   */
  pageIds: string[];
  /** What the record says replaced what, and who recorded it. */
  asserted: AssertedSupersession[];
  /** One reader-facing paragraph, also embedded verbatim in the answer text. */
  note: string;
}

/**
 * One open Divergence over a cited page: the page's authoritative source and a
 * corroborating source answered the same fact differently, and no one has
 * closed it (divergence.ts). Source names rather than ids, because this is
 * read by a person.
 */
export interface PageDivergence {
  id: string;
  pageId: string;
  authoritySourceName: string;
  authorityValue: unknown;
  otherSourceName: string;
  otherValue: unknown;
  observedAt: string;
}

/**
 * Set when a page this answer cites carries an open divergence.
 *
 * WHY THIS IS A SIBLING FIELD AND NOT PART OF `disagreement`. This is the
 * judgement call the T1.2 finding asked to be written down, so here it is.
 *
 * `disagreement` is a claim about TWO PAGES: the record holds two answers to
 * the reader's question and they differ. Its `pageIds` are always at least two
 * and they are the two sides; the extractive generator sets them against each
 * other; §7's remedy is that the pages' owners settle which governs.
 *
 * A divergence is none of that. It is ONE page, and the two disagreeing
 * parties are external systems — an authority and a corroborating source —
 * arguing about a value the page displays, not about anything the page's prose
 * says. Its `pageIds` would be a list of one. There is no "other side" to
 * quote, because the other side is not a passage. Its remedy is different too:
 * a person closes it with a reason (divergence.ts), and until they do the
 * authority's value keeps displaying, because "a corroborating source's
 * disagreement is a signal about the systems, never a vote about the value".
 *
 * Putting the two in one field would force a reader to guess which of the two
 * quite different things they were being warned about, and would break the
 * "always at least two pages, and they are the sides" invariant that everything
 * downstream of `disagreement` relies on. So: two fields, each honest about
 * what it is, and each saying so in its own note.
 */
export interface SourceDisagreement {
  /** The cited pages carrying at least one open divergence, in passage order. */
  pageIds: string[];
  /** The open divergences themselves, so a UI can link straight to them. */
  open: PageDivergence[];
  /** One reader-facing paragraph, also embedded verbatim in the answer text. */
  note: string;
}

// The answer contract from DATA-BACKBONE.md §5, used by Canon's own question
// box, by agents, and — when it lands — by Studio apps through the Knowledge
// API. One shape, one set of rules.
export interface AnswerResponse {
  answer: string | null;
  citations: Citation[];
  refused: boolean;
  reason?: RefusalReason;
  /**
   * The cited pages that are past their review date (status Needs Update).
   * Present only when there is at least one, so an answer drawn entirely from
   * current pages carries no extra noise — and so the shape every existing
   * caller reads is unchanged. The answer text says the same thing in words;
   * this is the machine-readable half, for a UI that wants to flag it.
   */
  pastReview?: { pageId: string; title: string }[];
  /**
   * Set when the cited pages disagree with each other — because their
   * passages' text says so, or because a person asserted that they do.
   * Computed by this module from the passages and from the record — never by
   * the generator, and never removable by it. See `detectDisagreement`.
   */
  disagreement?: Disagreement;
  /**
   * Set when this answer quotes a page the record says was replaced, beside
   * the page that replaced it. Additive and absent otherwise; a caller that
   * has never heard of it reads exactly the shape it always read. See
   * `Supersession` on why this is not folded into `disagreement`.
   */
  supersession?: Supersession;
  /**
   * Set when a cited page carries an open divergence between its authoritative
   * source and a corroborating one. Additive and absent otherwise. See
   * `SourceDisagreement` on why this is its own field.
   */
  sourceDisagreement?: SourceDisagreement;
}

export interface AskRequest {
  question: string;
  collectionId?: string;
  limit?: number;
  // Veryl Studio's Knowledge API asks on behalf of a person, so the candidates
  // an answer may draw on are narrowed by that person's permissions and by the
  // app's Registry collection limit as well as by the asking actor's own
  // permissions (STUDIO-CONTRACT.md §4). Both are optional, both only ever
  // narrow, and both are applied to the candidate set BEFORE generation —
  // filtering citations afterwards cannot un-leak what the text already merged
  // (DATA-BACKBONE.md §5, "permission filtering before ranking, not after").
  alsoVisibleTo?: string;
  collectionIds?: string[];
}

// A passage handed to the generator: verbatim text from one published,
// Canonical version, with the identity a citation needs.
export interface AnswerPassage {
  pageId: string;
  title: string;
  version: number;
  text: string;
  /**
   * The standing of the page the passage came from. Optional so a generator can
   * be exercised without one; when it says `needs_update`, the page is past its
   * review date and the generator is expected to say so rather than quietly
   * present it as current.
   */
  status?: PageStatus;
}

export interface GeneratedAnswer {
  answer: string;
  citedPageIds: string[]; // must be a subset of the passages offered
}

// The seam a real model plugs into later. A generator receives the question
// and the permitted, Canonical passages, and returns prose plus the pages it
// actually used — or null when the passages do not answer the question. It
// never receives anything the asker may not see, and anything it cites that
// was not offered is dropped by the caller.
//
// WHY `disagreement` IS AN INPUT AND NEVER AN OUTPUT.
//
// A model handed three passages will reconcile them; that is what fluent
// writing is for, and it is exactly what DATA-BACKBONE.md §7 forbids. So the
// conflict is detected before this seam is reached, passed IN as an advisory
// so a generator can present it well, and re-asserted by the caller
// afterwards whatever comes back. A generator has no channel through which to
// report, deny, or withdraw a disagreement: there is no field for it on
// `GeneratedAnswer`, and `AnswerService.ask` does not read the prose to decide
// whether one exists. The strongest thing a generator can do is state the
// disagreement in Canon's own words — and if it does not, Canon states it
// itself, in front of whatever the generator wrote. See `ask` below.
//
// The same holds, word for word, for `supersession` and `sourceDisagreement`.
// They are advisories on the way in and re-asserted by the caller on the way
// out; there is no field on `GeneratedAnswer` through which a generator could
// report that a page is not really superseded or that two systems have stopped
// disagreeing, and there never should be. What a person asserted and what two
// systems were observed to say are facts the record holds. They are not the
// generator's to revise.
export interface AnswerGenerator {
  readonly name: string;
  generate(input: {
    question: string;
    passages: AnswerPassage[];
    /** Advisory. Detected outside this seam; ignoring it changes nothing. */
    disagreement?: Disagreement | null;
    /** Advisory, same rules: what the record says was replaced by what. */
    supersession?: Supersession | null;
    /** Advisory, same rules: where a cited page's own sources disagree. */
    sourceDisagreement?: SourceDisagreement | null;
  }): GeneratedAnswer | null;
}

// How many passages an answer may draw on.
export const MAX_CITED_PASSAGES = 3;

// The default generator is extractive and honest about it: it quotes the most
// relevant passages verbatim and attributes each one. It invents nothing, it
// paraphrases nothing, and it makes no external call — so it is not a
// stand-in for a language model and does not pretend to be one. It exists so
// that the whole answer path — retrieval, permissions, citation, refusal,
// audit — is real and testable before any model is wired in, and so that the
// invariant "no claim without a citation" is structural rather than a prompt
// instruction.
export const extractiveGenerator: AnswerGenerator = {
  name: 'extractive-v1',
  generate({ passages, disagreement }) {
    const usable = passages.filter((p) => p.text.trim().length > 0);
    if (usable.length === 0) return null;
    // A passage from a page past its review date is attributed as such, in the
    // answer itself. The reader is told what the record is and how old the
    // promise behind it is, in the same sentence — which is the whole point of
    // citing a Needs Update page rather than hiding it.
    const stale = usable.filter((p) => p.status === 'needs_update');
    const notice = stale.length
      ? `\n\nNote: ${stale.length === 1 ? 'one of these pages is' : `${stale.length} of these pages are`} past ` +
        'the review date its owner set, and marked Needs Update. It is still the official record; it has not been re-approved recently.'
      : '';
    const citedPageIds = usable.map((p) => p.pageId);

    // The conflicting passages are not listed alongside the rest, because a
    // list reads as a sequence of agreeing facts. They are pulled to the front
    // under the disagreement note, set against each other, and everything that
    // is not part of the conflict follows separately.
    if (disagreement) {
      const inConflict = (p: AnswerPassage): boolean => disagreement.pageIds.includes(p.pageId);
      const conflicting = usable.filter(inConflict).map(attribute);
      const rest = usable.filter((p) => !inConflict(p)).map(attribute);
      const tail = rest.length ? `\n\nOn the rest of it, the record says:\n\n${rest.join('\n\n')}` : '';
      return {
        answer: `${disagreement.note}\n\n${conflicting.join('\n\n')}${tail}${notice}`,
        citedPageIds,
      };
    }

    return {
      answer: `The record says:\n\n${usable.map(attribute).join('\n\n')}${notice}`,
      citedPageIds,
    };
  },
};

// One passage, quoted verbatim and attributed. Shared by the extractive
// generator and by the disagreement notice Canon writes itself, so a quotation
// looks the same wherever the reader meets it.
function attribute(p: AnswerPassage): string {
  return `“${p.text.trim()}” — ${p.title} (version ${p.version}${p.status === 'needs_update' ? ', past review' : ''})`;
}

// Retrieval always returns its best candidates, because ranking has no notion
// of "good enough" — a question sharing one common word with a page ("what is
// our policy on submarine procurement" against a retention *policy*) still
// ranks that page first, since it is the best of what exists. Answering from
// it would be the confident wrong answer CORE-PLAN §7 names as costing more
// than many right ones earn.
//
// So being retrieved is not sufficient to be cited. At least one directly
// retrieved page must also be *about* the question, measured as overlap with
// the question's content terms. Pages pulled in by graph expansion are exempt:
// a child procedure legitimately answers in words the question never used, and
// it earns its place through the anchor that reached it, not on its own.
//
// The gate is deliberately blunt and deliberately strict. It costs recall on
// oddly-worded questions, and buys refusal instead of invention — the trade
// DATA-BACKBONE.md §5 asks for.
export const MIN_TOPICAL_OVERLAP = 0.5;

// Enough of a stemmer to survive plurals and tense: records/record,
// policies/policy, retained/retain. Not linguistics — just the difference
// between a gate that works on real questions and one that refuses everything.
function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (term.length > suffix.length + 3 && term.endsWith(suffix)) return term.slice(0, -suffix.length);
  }
  return term;
}

function contentTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    seen.add(stem(raw));
  }
  return [...seen];
}

function termsCovered(questionTerms: string[], text: string): number {
  const found = new Set(contentTerms(text));
  let covered = 0;
  for (const term of questionTerms) {
    if (found.has(term)) {
      covered += 1;
      continue;
    }
    // Prefix match catches the pairs the stemmer misses (retention/retained)
    // without matching on two or three shared letters.
    for (const candidate of found) {
      const shorter = term.length <= candidate.length ? term : candidate;
      const longer = term.length <= candidate.length ? candidate : term;
      if (shorter.length >= 5 && longer.startsWith(shorter)) {
        covered += 1;
        break;
      }
    }
  }
  return covered;
}

// Is this candidate actually about the question? Coverage of at least half the
// question's content terms, and never on the strength of a single shared word
// unless the question itself was a single word.
export function isOnTopic(question: string, text: string): boolean {
  const questionTerms = contentTerms(question);
  if (questionTerms.length === 0) return false;
  const covered = termsCovered(questionTerms, text);
  const minimum = questionTerms.length === 1 ? 1 : 2;
  return covered >= minimum && covered / questionTerms.length >= MIN_TOPICAL_OVERLAP;
}

// ---------------------------------------------------------------------------
// Contradiction awareness — DATA-BACKBONE.md §7, "Answers must never smooth a
// contradiction", which that section calls its sharpest rule.
//
// THERE ARE THREE WAYS A CONTRADICTION EXISTS IN THE RECORD, AND THIS IS THE
// WEAKEST OF THEM.
//
// What follows is the TEXT INFERENCE half: Canon reading two passages and
// working out, lexically, that they give different answers. It is a guess. It
// is a careful, deterministic, deliberately narrow guess, but a guess.
//
// The other two are not guesses, and the answer path consults both:
//
//   * a `conflicts_with` PAGE RELATION (relations.ts) — a person with `edit` on
//     both collections wrote down that these two pages disagree, and had to
//     explain how before the record would take it. That is data, not prose,
//     and DATA-BACKBONE.md §2 principle 2 is "structure over prose". An
//     answer that infers a conflict from a sentence while ignoring one a
//     colleague recorded as a row is the principle exactly inverted, which is
//     the defect this section was rewritten to fix.
//   * an open DIVERGENCE (divergence.ts) — an authority and a corroborating
//     source were OBSERVED to answer the same fact differently, and nobody has
//     closed it. Also data, also not a guess, and about the page's own facts
//     rather than about two pages.
//
// Those two arrive through the `AnswerRecord` seam below. They never pass
// through the lexical machinery in this section, are never scored against it,
// and are never overruled by it: a conflict a person asserted is reported
// whether or not the passages' text trips a single one of the checks here.
// Reporting it is the whole point. The record said so.
//
// BE HONEST ABOUT WHAT THIS IS. There is no entailment model here, and there
// must not be a pretend one: a false claim of contradiction is its own kind of
// confident wrong answer, and it is worse than the one it is guarding against
// because it accuses the record of an incoherence it does not have. What runs
// is a lexical, deterministic check over the exact passages an answer is about
// to be composed from, aimed at the two shapes that are cheap to spot and
// expensive to miss in a policy record.
//
// WHAT IT DETECTS
//
//  1. QUANTITY CONFLICT — the high-value case and the tractable one. Two
//     passages, from two different pages, give different values in comparable
//     units for what reads as the same subject: "retained for seven years"
//     against "retained for ten years", "$1,500" against "$1,200", "80
//     percent" against "50 percent". A number counts as a quantity only if it
//     carries a unit this module understands (a duration, a currency, a
//     percentage), which is what keeps version numbers, dates, section
//     numbers, page counts and step numbers out of the comparison entirely —
//     "version 3" and "version 4" are not two answers to anything.
//
//  2. EXPLICIT POLARITY CONFLICT — narrow on purpose. One passage asserts in
//     so many words what another denies in so many words: "approval is
//     required" against "approval is not required". The denial has to be a
//     literal negation cue (not / n't / never / cannot) standing directly in
//     front of a word the other passage also uses, with the two sentences
//     otherwise talking about the same things. Anything looser than that
//     misfires on the ordinary shape of policy prose, where "contractors must
//     be escorted" and "contractors are not admitted unescorted" are the same
//     rule written twice.
//
// WHAT IT DELIBERATELY DOES NOT DETECT
//
//   * General semantic contradiction. Two passages that conflict in meaning
//     but share no number and no negated word are invisible here, and that is
//     the correct failure: silence is honest, invention is not.
//   * Quantities in units this module cannot compare exactly. Days against
//     months, weeks against years — a month is not exactly thirty days, so
//     Canon does not claim "30 days" and "1 month" disagree, nor that they
//     agree. Years, quarters and months compare with each other; weeks, days,
//     hours and minutes compare with each other; currencies compare only
//     within the same currency.
//   * Bounded and excepted quantities: "at least seven years", "expenses over
//     $500", "20 percent are exempt". A bound or an exception is not a claim
//     about the value, so those quantities are dropped rather than compared.
//     This costs real conflicts ("at least seven" against "at least ten") and
//     buys the false-positive rate that makes the feature usable.
//   * A page against itself. Conflict is only ever reported between passages
//     from two different pages, so a single passage can never disagree with
//     itself, and a page that states a range or lists several figures in one
//     sentence has those figures dropped rather than played off each other.

/** The sentence every disagreement note opens with; the reader-facing lead. */
export const DISAGREEMENT_LEAD = 'The record gives more than one answer here, and they differ.';

/** How the note closes: Canon surfaces contradiction, it does not resolve it. */
const DISAGREEMENT_TAIL =
  'Canon does not choose between them: both pages carry the Canonical mark, and ' +
  'settling which one governs is a decision for their owners, not for this answer.';

/** Two quantities are compared only when their subjects plainly line up. */
export const MIN_SHARED_SUBJECT_TERMS = 2;
export const MIN_SUBJECT_CONTAINMENT = 0.5;
/** Polarity is held to a stricter bar, because it is the easier one to get wrong. */
export const MIN_SHARED_POLARITY_TERMS = 3;
export const MIN_POLARITY_CONTAINMENT = 0.6;

// Spelled-out numbers, because policy prose writes "seven years" far more
// often than "7 years". Nothing above a hundred, and nothing fractional: this
// is a lookup table, not a parser.
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

// A unit family is a set of units that convert into each other EXACTLY. Two
// quantities are comparable only inside one family, which is why days and
// months never meet: 1 month is not 30 days, and pretending otherwise would
// manufacture disagreements out of rounding.
interface UnitSpec {
  family: string;
  scale: number;
}
const UNITS: Readonly<Record<string, UnitSpec>> = {
  year: { family: 'duration/months', scale: 12 },
  years: { family: 'duration/months', scale: 12 },
  quarter: { family: 'duration/months', scale: 3 },
  quarters: { family: 'duration/months', scale: 3 },
  month: { family: 'duration/months', scale: 1 },
  months: { family: 'duration/months', scale: 1 },
  week: { family: 'duration/minutes', scale: 10080 },
  weeks: { family: 'duration/minutes', scale: 10080 },
  day: { family: 'duration/minutes', scale: 1440 },
  days: { family: 'duration/minutes', scale: 1440 },
  hour: { family: 'duration/minutes', scale: 60 },
  hours: { family: 'duration/minutes', scale: 60 },
  minute: { family: 'duration/minutes', scale: 1 },
  minutes: { family: 'duration/minutes', scale: 1 },
  '%': { family: 'percent', scale: 1 },
  percent: { family: 'percent', scale: 1 },
  'per cent': { family: 'percent', scale: 1 },
  dollar: { family: 'currency/usd', scale: 1 },
  dollars: { family: 'currency/usd', scale: 1 },
  usd: { family: 'currency/usd', scale: 1 },
  pound: { family: 'currency/gbp', scale: 1 },
  pounds: { family: 'currency/gbp', scale: 1 },
  gbp: { family: 'currency/gbp', scale: 1 },
  euro: { family: 'currency/eur', scale: 1 },
  euros: { family: 'currency/eur', scale: 1 },
  eur: { family: 'currency/eur', scale: 1 },
};
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'currency/usd',
  '£': 'currency/gbp',
  '€': 'currency/eur',
};

const UNIT_ALTERNATION =
  'per cent|percent|%|years?|quarters?|months?|weeks?|days?|hours?|minutes?|dollars?|usd|pounds?|gbp|euros?|eur';
// "5 business days", "10 working days" — one optional counting adjective
// between the number and its unit, from a closed list.
const COUNTING_ADJECTIVE = '(?:business|calendar|working|consecutive|full|clear)\\s+';
const QUANTITY_RE = new RegExp(
  `([$£€])\\s?([0-9][0-9,]*(?:\\.[0-9]+)?)` +
    `|\\b((?:[0-9][0-9,]*(?:\\.[0-9]+)?)|[a-z]+(?:-[a-z]+)?)[\\s-]*(?:${COUNTING_ADJECTIVE})?(${UNIT_ALTERNATION})(?![a-z])`,
  'gi',
);

// A comparative or an approximation immediately in front of a number means the
// number is a bound, not the answer. Checked over the few tokens before the
// match, so "expenses over $500" is dropped and "for over five years of
// service" is dropped with it, while "retained for seven years" survives.
const BOUND_CUES: ReadonlySet<string> = new Set([
  'least', 'most', 'more', 'less', 'fewer', 'greater', 'over', 'under', 'above', 'below',
  'up', 'minimum', 'maximum', 'min', 'max', 'exceed', 'exceeds', 'exceeding', 'exceeded',
  'approximately', 'roughly', 'nearly', 'almost', 'around', 'about', 'between', 'or',
]);
const HOW_FAR_BACK = 3;

// An exception anywhere in the sentence means the figure is carving something
// out rather than answering the question — "20 percent are exempt" does not
// contradict "80 percent must be reviewed".
const EXCEPTION_CUES: ReadonlySet<string> = new Set([
  'except', 'excepted', 'exception', 'exceptions', 'excluding', 'excluded', 'exempt',
  'exempted', 'exemption', 'unless', 'waiver', 'waived', 'remainder', 'remaining', 'otherwise',
]);

// Unit and number words are the vocabulary of the comparison itself, so they
// are stripped out of a quantity's subject: two passages both saying "years"
// have not thereby agreed on a subject.
const SUBJECT_NOISE: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS),
  ...Object.keys(NUMBER_WORDS),
  'cent', 'per', 'business', 'calendar', 'working', 'consecutive', 'full', 'clear',
]);

interface Quantity {
  family: string;
  value: number;
  /** Verbatim, as the record wrote it: "seven years", "$1,500", "80 percent". */
  text: string;
  /** Stemmed content terms of the sentence it sits in, minus numbers and units. */
  subject: string[];
  sentence: number;
}

interface Negation {
  /** Verbatim negated phrase: "not required", "cannot enter". */
  phrase: string;
  /** The stemmed word the negation lands on. */
  head: string;
  /** Stemmed content terms of the sentence. */
  subject: string[];
}

interface Assertion {
  /** Verbatim word: "required". */
  phrase: string;
  head: string;
  subject: string[];
}

interface PassageClaims {
  quantities: Quantity[];
  negations: Negation[];
  assertions: Assertion[];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.;:!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNumber(raw: string): number | null {
  const token = raw.toLowerCase();
  if (/^[0-9]/.test(token)) {
    const n = Number(token.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token]!;
  // "twenty-five", and only that shape: a tens word plus a units word.
  const parts = token.split('-');
  if (parts.length === 2) {
    const tens = NUMBER_WORDS[parts[0]!];
    const units = NUMBER_WORDS[parts[1]!];
    if (tens !== undefined && units !== undefined && tens >= 20 && tens % 10 === 0 && units < 10) {
      return tens + units;
    }
  }
  return null;
}

function subjectTerms(sentence: string): string[] {
  return contentTerms(sentence).filter((t) => !/^[0-9]+$/.test(t) && !SUBJECT_NOISE.has(t));
}

function precedingTokens(sentence: string, upTo: number): string[] {
  return (sentence.slice(0, upTo).toLowerCase().match(/[a-z]+/g) ?? []).slice(-HOW_FAR_BACK);
}

/** Every comparable quantity in one passage, with the bounded ones dropped. */
function extractQuantities(text: string): Quantity[] {
  const found: Quantity[] = [];
  sentences(text).forEach((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.some((w) => EXCEPTION_CUES.has(w))) return;
    const subject = subjectTerms(sentence);
    QUANTITY_RE.lastIndex = 0;
    for (const match of sentence.matchAll(QUANTITY_RE)) {
      const at = match.index ?? 0;
      if (precedingTokens(sentence, at).some((w) => BOUND_CUES.has(w))) continue;
      const symbol = match[1];
      const raw = symbol ? match[2]! : match[3]!;
      const value = parseNumber(raw);
      if (value === null) continue;
      const family = symbol ? CURRENCY_SYMBOLS[symbol]! : undefined;
      const unit = symbol ? undefined : UNITS[match[4]!.toLowerCase()];
      if (!symbol && !unit) continue;
      found.push({
        family: family ?? unit!.family,
        value: value * (unit?.scale ?? 1),
        text: match[0].trim(),
        subject,
        sentence: index,
      });
    }
  });
  // A sentence that gives two different figures in the same family is stating
  // a range or an enumeration ("between thirty and sixty days", "seven years
  // for records and ten for contracts"). Neither figure is THE answer, so
  // neither is offered for comparison.
  const ranged = new Set<string>();
  for (const q of found) {
    for (const other of found) {
      if (other === q) continue;
      if (other.sentence === q.sentence && other.family === q.family && other.value !== q.value) {
        ranged.add(`${q.sentence}/${q.family}`);
      }
    }
  }
  return found.filter((q) => !ranged.has(`${q.sentence}/${q.family}`));
}

// Words a negation cue steps over on its way to the thing being denied, so
// "is not required" lands on "required" rather than on "is".
const NEGATION_SKIP: ReadonlySet<string> = new Set([
  'be', 'is', 'are', 'was', 'were', 'been', 'being', 'to', 'a', 'an', 'the', 'any', 'all',
  'it', 'they', 'them', 'he', 'she', 'we', 'you', 'i', 'that', 'this', 'these', 'those',
  'have', 'has', 'had', 'do', 'does', 'did', 'yet', 'ever', 'only', 'itself', 'currently',
  'normally', 'generally', 'usually', 'otherwise', 'also', 'then', 'and', 'or', 'of', 'in',
]);

function isNegationCue(token: string): boolean {
  return token === 'not' || token === 'never' || token === 'cannot' || token.endsWith("n't");
}

/** The explicit negations and matching plain assertions in one passage. */
function extractPolarity(text: string): { negations: Negation[]; assertions: Assertion[] } {
  const negations: Negation[] = [];
  const assertions: Assertion[] = [];
  for (const sentence of sentences(text)) {
    const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z']*/g)];
    const subject = contentTerms(sentence);
    const cueAt = tokens.findIndex((t) => isNegationCue(t[0].toLowerCase()));
    if (cueAt === -1) {
      // A sentence with no negation in it is where the other side of a
      // polarity conflict has to come from; every content word is a candidate
      // head, and the head is chosen by the negated sentence, not by this one.
      for (const token of tokens) {
        const word = token[0].toLowerCase();
        if (word.length < 3 || STOPWORDS.has(word) || NEGATION_SKIP.has(word)) continue;
        assertions.push({ phrase: token[0], head: stem(word), subject });
      }
      continue;
    }
    const cue = tokens[cueAt]!;
    const head = tokens
      .slice(cueAt + 1)
      .find((t) => {
        const word = t[0].toLowerCase();
        return word.length >= 3 && !NEGATION_SKIP.has(word) && !STOPWORDS.has(word);
      });
    if (!head) continue;
    // The phrase is quoted verbatim from the cue through the word it lands on,
    // so the note says “not required” in the record's own words.
    negations.push({
      phrase: sentence.slice(cue.index, head.index + head[0].length),
      head: stem(head[0].toLowerCase()),
      subject,
    });
  }
  return { negations, assertions };
}

function claimsOf(text: string): PassageClaims {
  const { negations, assertions } = extractPolarity(text);
  return { quantities: extractQuantities(text), negations, assertions };
}

// Shared terms, using the same prefix tolerance the topical gate uses, so
// retention/retained and require/requires count as the same subject word
// without two- and three-letter coincidences counting as anything.
function sharedTerms(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const term of a) {
    for (const candidate of b) {
      if (term === candidate) {
        out.push(term);
        break;
      }
      const shorter = term.length <= candidate.length ? term : candidate;
      const longer = term.length <= candidate.length ? candidate : term;
      if (shorter.length >= 5 && longer.startsWith(shorter)) {
        out.push(term);
        break;
      }
    }
  }
  return out;
}

function subjectsLineUp(a: readonly string[], b: readonly string[], minShared: number, minContainment: number): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const shared = sharedTerms(a, b);
  if (shared.length < minShared) return false;
  return shared.length / Math.min(a.length, b.length) >= minContainment;
}

interface Conflict {
  pageIds: [string, string];
  detail: string;
  /**
   * The relation a person asserted, when this conflict is one of those.
   * Absent when Canon inferred the conflict from the passages' text — and the
   * two are never blurred, because "somebody wrote this down" and "we read it
   * off two sentences" are not the same claim and must not read alike.
   */
  asserted?: AssertedConflict;
}

function label(p: AnswerPassage): string {
  return `${p.title} (version ${p.version})`;
}

/** An ISO timestamp as the day it happened; the time of day is not the point. */
function day(at: string): string {
  return at.slice(0, 10);
}

/**
 * The conflicts a person ASSERTED over these passages, as `conflicts_with`
 * relations (relations.ts), turned into the same `Conflict` shape the text
 * inference produces so both travel through one note builder.
 *
 * BOTH ENDS MUST BE PASSAGES THIS ANSWER HOLDS, and that is a rule with two
 * separate reasons behind it.
 *
 * The first is permission. Passages have already been through retrieval's
 * per-asker SQL filter, so a relation whose two ends are both passages is a
 * relation between two pages this asker may read. A relation reaching a page
 * that is NOT a passage might be reaching a page they may not see, and naming
 * it — even to say "this conflicts with something" — would leak that the page
 * exists. relations.ts drops the far end of an unreadable relation for exactly
 * this reason; the answer path does not get to be looser.
 *
 * The second is that Canon quotes what it warns about. §7's rule is that the
 * answer "says so, cites both, and does not choose", and an answer cannot cite
 * a page it never retrieved a passage from. A warning about a page the reader
 * cannot see the text of is a rumour, not a citation.
 *
 * The cost is real and is the right cost: a cited page that conflicts with a
 * page this answer did not draw on goes unmentioned here. That conflict is on
 * the page itself, on the map, and in the relation listing — it is not
 * invisible, it is just not this answer's business.
 */
function assertedConflicts(
  passages: readonly AnswerPassage[],
  asserted: readonly AssertedConflict[],
): Conflict[] {
  const byPage = new Map<string, AnswerPassage>();
  for (const passage of passages) if (!byPage.has(passage.pageId)) byPage.set(passage.pageId, passage);
  const conflicts: Conflict[] = [];
  for (const relation of asserted) {
    const a = byPage.get(relation.fromPageId);
    const b = byPage.get(relation.toPageId);
    if (!a || !b || a.pageId === b.pageId) continue;
    conflicts.push({
      pageIds: [a.pageId, b.pageId],
      // Attributed as an assertion, in the asserter's own words. The reader is
      // told a PERSON said this — not that Canon worked it out — because the
      // two carry very different weight and the difference is theirs to use.
      detail:
        `${label(a)} and ${label(b)} are recorded as conflicting. ` +
        `${relation.assertedByName} asserted that on ${day(relation.assertedAt)}, and wrote: “${relation.note}”`,
      asserted: relation,
    });
  }
  return conflicts;
}

/** The conflicts Canon INFERS from the passages' text: the lexical half. */
function inferredConflicts(passages: readonly AnswerPassage[]): Conflict[] {
  const claims = passages.map((p) => claimsOf(p.text));
  const conflicts: Conflict[] = [];

  for (let i = 0; i < passages.length; i += 1) {
    for (let j = i + 1; j < passages.length; j += 1) {
      const a = passages[i]!;
      const b = passages[j]!;
      if (a.pageId === b.pageId) continue; // never a page against itself
      const ca = claims[i]!;
      const cb = claims[j]!;

      // 1. Quantity conflict.
      for (const qa of ca.quantities) {
        for (const qb of cb.quantities) {
          if (qa.family !== qb.family) continue;
          if (Math.abs(qa.value - qb.value) < 1e-9) continue;
          if (!subjectsLineUp(qa.subject, qb.subject, MIN_SHARED_SUBJECT_TERMS, MIN_SUBJECT_CONTAINMENT)) continue;
          conflicts.push({
            pageIds: [a.pageId, b.pageId],
            detail: `${label(a)} says “${qa.text}” where ${label(b)} says “${qb.text}”.`,
          });
        }
      }

      // 2. Explicit polarity conflict, in both directions.
      for (const [neg, pos, negPage, posPage] of [
        [ca.negations, cb.assertions, a, b] as const,
        [cb.negations, ca.assertions, b, a] as const,
      ]) {
        for (const n of neg) {
          for (const p of pos) {
            if (sharedTerms([n.head], [p.head]).length === 0) continue;
            if (!subjectsLineUp(n.subject, p.subject, MIN_SHARED_POLARITY_TERMS, MIN_POLARITY_CONTAINMENT)) continue;
            conflicts.push({
              pageIds: [posPage.pageId, negPage.pageId],
              detail: `${label(posPage)} says “${p.phrase}” where ${label(negPage)} says “${n.phrase}”.`,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * One note, one field, from however many conflicts were found — whoever found
 * them. Asserted conflicts are listed FIRST, because the note only has room
 * for two details and a person's recorded assertion outranks Canon's reading
 * of a sentence every time.
 */
function toDisagreement(passages: readonly AnswerPassage[], conflicts: readonly Conflict[]): Disagreement | null {
  if (conflicts.length === 0) return null;

  const ordered = [...conflicts].sort((a, b) => Number(Boolean(b.asserted)) - Number(Boolean(a.asserted)));
  // Page order follows the order the passages were offered, so the note, the
  // citations and the field all read the same way round.
  const involved = new Set(ordered.flatMap((c) => c.pageIds));
  const pageIds = passages.map((p) => p.pageId).filter((id, at, all) => involved.has(id) && all.indexOf(id) === at);
  const details = [...new Set(ordered.map((c) => c.detail))].slice(0, 2);
  const more = ordered.length > details.length ? ' The record differs in more than one place here.' : '';
  const asserted = ordered.flatMap((c) => (c.asserted ? [c.asserted] : []));
  return {
    pageIds,
    note: `${DISAGREEMENT_LEAD} ${details.join(' ')}${more} ${DISAGREEMENT_TAIL}`,
    // Absent unless a person is behind at least one of these, so a caller that
    // reads only `{ pageIds, note }` sees exactly what it always saw.
    ...(asserted.length ? { asserted } : {}),
  };
}

/**
 * The whole point of this module: given the passages an answer is about to be
 * composed from, does the record give more than one answer?
 *
 * Pure, deterministic, and free of any dependency on the generator or on the
 * database — it takes passages plus whatever the record already STATES about
 * them, and returns a `Disagreement` or null. So it can be exercised directly,
 * nothing downstream can influence it, and the two halves can be tested apart:
 * call it with one argument for the text inference alone, with the second for
 * the whole picture. The lookup that produces that second argument is a
 * separate seam (`AnswerRecord`) precisely so this stays a pure function.
 *
 * `asserted` is NOT a hint that makes the lexical checks more willing. It is
 * an independent finding: a conflict a person recorded is reported even when
 * the two passages share no number, no negation, and no subject at all. That
 * is the case USER-TESTING.md T1.2 caught in the demo corpus — a retention
 * schedule and a platform spec whose prose gives the quantity detector nothing
 * to compare, joined by a relation that says in so many words that one of them
 * is wrong.
 */
export function detectDisagreement(
  passages: readonly AnswerPassage[],
  asserted: readonly AssertedConflict[] = [],
): Disagreement | null {
  if (passages.length < 2) return null; // a single passage cannot disagree with itself
  return toDisagreement(passages, [...assertedConflicts(passages, asserted), ...inferredConflicts(passages)]);
}

/** How the supersession note opens. */
export const SUPERSESSION_LEAD = 'This answer quotes a page the record says has been replaced.';

/**
 * Is this answer citing both a superseded page and the page that superseded
 * it? Pure, like `detectDisagreement`, and for the same reasons.
 *
 * Only pairs where BOTH ends are passages count, on the same two grounds as an
 * asserted conflict: a relation to a page outside this answer might be a
 * relation to a page this asker may not see, and a page quoting only the
 * current rule has no problem to warn about. Quoting the superseded page ALONE
 * is not handled here either — that is a different and harder question (does
 * the answer path prefer the superseding page? §7 says Canon does not decide,
 * and the honest answer is that a person's supersession does not make the old
 * page's status change, so it remains citable), and inventing a rule for it
 * inside a bug fix would be the silent widening this was asked not to do.
 */
export function detectSupersession(
  passages: readonly AnswerPassage[],
  asserted: readonly AssertedSupersession[],
): Supersession | null {
  if (passages.length < 2) return null;
  const byPage = new Map<string, AnswerPassage>();
  for (const passage of passages) if (!byPage.has(passage.pageId)) byPage.set(passage.pageId, passage);

  const pairs: AssertedSupersession[] = [];
  const details: string[] = [];
  for (const relation of asserted) {
    const older = byPage.get(relation.supersededPageId);
    const newer = byPage.get(relation.supersededByPageId);
    if (!older || !newer || older.pageId === newer.pageId) continue;
    pairs.push(relation);
    details.push(
      `${relation.assertedByName} recorded on ${day(relation.assertedAt)} that ${label(newer)} supersedes ` +
        `${label(older)}${relation.note ? `, and wrote: “${relation.note}”` : '.'}`,
    );
  }
  if (pairs.length === 0) return null;

  const involved = new Set(pairs.flatMap((p) => [p.supersededPageId, p.supersededByPageId]));
  const pageIds = passages.map((p) => p.pageId).filter((id, at, all) => involved.has(id) && all.indexOf(id) === at);
  const shown = details.slice(0, 2);
  const more = details.length > shown.length ? ' More than one page quoted here has been replaced.' : '';
  return {
    pageIds,
    asserted: pairs,
    note:
      `${SUPERSESSION_LEAD} ${shown.join(' ')}${more} ` +
      'Both are quoted above and both are cited: a supersession does not archive the older page, does not change ' +
      'its status, and does not stop it being cited, so dropping that quotation would hide the change instead of ' +
      'showing it. Canon is relaying what a person recorded, not deciding between the two.',
  };
}

/** How the source-disagreement note opens. */
export const SOURCE_DISAGREEMENT_LEAD =
  'A page cited here is carrying an open disagreement between the systems its values come from.';

/**
 * Are any of the cited pages carrying an open divergence? Pure, like the two
 * above; the lookup lives in `AnswerRecord`.
 *
 * This is a weaker claim than `disagreement` and the note is careful to say
 * so: nothing here asserts that the answer's PROSE is wrong. It says that a
 * value this page displays is one two systems do not agree about, and that
 * nobody has yet settled which was right.
 */
export function detectSourceDisagreement(
  passages: readonly AnswerPassage[],
  divergences: readonly PageDivergence[],
): SourceDisagreement | null {
  const byPage = new Map<string, AnswerPassage>();
  for (const passage of passages) if (!byPage.has(passage.pageId)) byPage.set(passage.pageId, passage);

  const open: PageDivergence[] = [];
  const details: string[] = [];
  for (const divergence of divergences) {
    const passage = byPage.get(divergence.pageId);
    if (!passage) continue;
    open.push(divergence);
    details.push(
      `On ${label(passage)}, ${divergence.authoritySourceName} is the authority for a field this page shows and ` +
        `answered ${displayValue(divergence.authorityValue)}, while ${divergence.otherSourceName} answered ` +
        `${displayValue(divergence.otherValue)} (observed ${day(divergence.observedAt)}).`,
    );
  }
  if (open.length === 0) return null;

  const involved = new Set(open.map((d) => d.pageId));
  const pageIds = passages.map((p) => p.pageId).filter((id, at, all) => involved.has(id) && all.indexOf(id) === at);
  const shown = details.slice(0, 2);
  const more = details.length > shown.length ? ' There is more than one open divergence here.' : '';
  return {
    pageIds,
    open,
    note:
      `${SOURCE_DISAGREEMENT_LEAD} ${shown.join(' ')}${more} ` +
      'The page displays the authoritative value, because a corroborating source that disagrees is a signal about ' +
      'the systems and never a vote about the value — so a federated figure quoted above is the authority’s, not ' +
      'one the two systems agree on. The divergence is open, which means nobody has settled yet what happened. ' +
      'This is two systems disagreeing about one page’s facts, which is not the same thing as two pages ' +
      'contradicting each other.',
  };
}

/**
 * A resolved value, for the note. Mirrors the `display` in divergence.ts and
 * for the same reason: a number reads as itself, a string in quotes, anything
 * else as its JSON — and all of it capped, because a source that answers with
 * a whole document should not put a whole document in an answer.
 */
function displayValue(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null) ?? 'null';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * The disagreement stated in Canon's own words, with both sides quoted
 * verbatim. This is what goes in front of a generator's prose when the prose
 * did not carry the note itself — so the warning is never merely a field, and
 * every page the disagreement names is quoted in the answer that cites it.
 */
function disagreementNotice(disagreement: Disagreement, passages: readonly AnswerPassage[]): string {
  const quoted = passages.filter((p) => disagreement.pageIds.includes(p.pageId)).map(attribute);
  return `${disagreement.note}\n\n${quoted.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// The record lookup seam
//
// Everything above this line is a pure function of passages and plain data,
// and it stays that way. What the record STATES about a set of pages has to
// come out of the database, and this is the one place it does.
//
// WHY A SEAM AND NOT A COUPLE OF QUERIES INSIDE `ask`. Two reasons, and the
// first is the one that matters. `detectDisagreement` is the function this
// module is really about, it is directly testable, and it must stay that way:
// a test that has to stand up a store, two collections, four pages and a
// person to check that "seven years" contradicts "ten years" is a test nobody
// will extend. Keeping the lookup behind an interface means the detection
// functions take data, the tests hand them data, and the SQL is exercised
// separately — through `ask`, which is where it actually runs. The second is
// that a deployment which one day holds relations somewhere other than this
// database has one class to replace rather than a rewrite of `ask`.
//
// WHY THIS DOES NOT GO THROUGH RelationService AND DivergenceService. Both of
// those take an actor and re-check permissions, and both are about a page at a
// time. The answer path is past that gate: every passage has already been
// through retrieval's per-asker SQL, so the pages named here are pages this
// asker may read, and asking again would be a second, differently-worded
// permission check that could drift from the first. Reading the two tables
// directly is what this file already does for `audit_events`, and the filter
// that keeps it safe — both ends must be passages — is enforced in the pure
// functions above, where it can be tested.

/** Everything the record already states about the pages an answer is citing. */
export interface StatedContradictions {
  /** `conflicts_with` relations with both ends among the pages asked about. */
  conflicts: AssertedConflict[];
  /** `supersedes` relations, likewise. */
  supersessions: AssertedSupersession[];
  /** Open divergences on any of those pages. */
  divergences: PageDivergence[];
}

/**
 * The seam. One call, so an answer costs two queries however many pages it
 * cites, and a test can supply the whole thing as a literal.
 */
export interface AnswerRecord {
  statedOver(pageIds: readonly string[]): StatedContradictions;
}

/**
 * The real one, over Canon's own tables.
 *
 * IT DOES NOT SWALLOW ITS ERRORS, and that is deliberate and the opposite of
 * the choice divergence.ts makes when observing. There, a failure to record a
 * divergence must not cost the reader the page, because the page is still true
 * and the divergence surfaces elsewhere. Here, a failure to read what the
 * record states would produce a fluent, cited answer drawn from two pages a
 * person has recorded as contradicting each other, with no warning attached —
 * which is precisely the failure §7 calls the worst thing the system could do,
 * and it would be invisible. An ask that fails loudly is recoverable. An ask
 * that quietly answers while blind to the record is not.
 */
export class StoredAnswerRecord implements AnswerRecord {
  constructor(private readonly db: DatabaseSync) {}

  statedOver(pageIds: readonly string[]): StatedContradictions {
    const unique = [...new Set(pageIds)];
    const empty: StatedContradictions = { conflicts: [], supersessions: [], divergences: [] };
    // Fewer than two pages cannot hold a relation between two of them, but one
    // page can still carry a divergence, so only the relation query is skipped.
    if (unique.length === 0) return empty;
    const holes = unique.map(() => '?').join(', ');

    const divergences = (
      this.db
        .prepare(
          // `sources` is LEFT JOINed and the id is the fallback, because
          // divergence.ts deliberately carries no foreign key to it: a
          // divergence outlives the source that produced it, and a
          // deregistered source must not make the disagreement unreadable.
          `SELECT d.id, d.page_id, d.authority_value, d.other_value, d.observed_at,
                  COALESCE(sa.name, d.authority_source_id) AS authority_name,
                  COALESCE(so.name, d.other_source_id) AS other_name
             FROM divergences d
             LEFT JOIN sources sa ON sa.id = d.authority_source_id
             LEFT JOIN sources so ON so.id = d.other_source_id
            WHERE d.state = 'open' AND d.page_id IN (${holes})
            ORDER BY d.observed_at, d.rowid`,
        )
        .all(...unique) as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as string,
      pageId: row.page_id as string,
      authoritySourceName: row.authority_name as string,
      authorityValue: parseValue(row.authority_value),
      otherSourceName: row.other_name as string,
      otherValue: parseValue(row.other_value),
      observedAt: row.observed_at as string,
    }));

    if (unique.length < 2) return { ...empty, divergences };

    const rows = this.db
      .prepare(
        // Both ends inside the set, which is the filter that makes this safe
        // to run without a per-asker permission check: every page named came
        // back through retrieval's own filter for this asker.
        `SELECT r.from_page_id, r.to_page_id, r.kind, r.note, r.asserted_by, r.asserted_at,
                a.name AS asserted_by_name
           FROM page_relations r
           JOIN actors a ON a.id = r.asserted_by
          WHERE r.from_page_id IN (${holes}) AND r.to_page_id IN (${holes})
          ORDER BY r.asserted_at, r.rowid`,
      )
      .all(...unique, ...unique) as Record<string, unknown>[];

    const conflicts: AssertedConflict[] = [];
    const supersessions: AssertedSupersession[] = [];
    for (const row of rows) {
      const assertedBy = row.asserted_by as string;
      const assertedByName = row.asserted_by_name as string;
      const assertedAt = row.asserted_at as string;
      const from = row.from_page_id as string;
      const to = row.to_page_id as string;
      if (row.kind === 'conflicts_with') {
        conflicts.push({
          fromPageId: from,
          toPageId: to,
          // relations.ts requires a note on this kind, so this is a fallback
          // against a row written before that rule rather than a real case.
          note: ((row.note as string) ?? '').trim() || 'These two pages conflict.',
          assertedBy,
          assertedByName,
          assertedAt,
        });
      } else {
        // `supersedes` is stored as asserted and is directed: the FROM page is
        // the one that replaced the TO page (relations.ts, `relationPair`).
        supersessions.push({
          supersededPageId: to,
          supersededByPageId: from,
          note: ((row.note as string) ?? '').trim() || null,
          assertedBy,
          assertedByName,
          assertedAt,
        });
      }
    }
    return { conflicts, supersessions, divergences };
  }
}

/** Divergence values are stored as JSON; a row we cannot parse is not a value. */
function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface AnswerHost {
  getActor(id: string): Actor;
}

function now(): string {
  return new Date().toISOString();
}

export class AnswerService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: AnswerHost,
    private readonly retrieval: RetrievalService,
    private readonly generator: AnswerGenerator = extractiveGenerator,
    // The lookup seam, defaulted to the real tables. Injectable so a test can
    // state what the record says without writing it, exactly as the generator
    // is injectable so a test can state what a model returns.
    private readonly record: AnswerRecord = new StoredAnswerRecord(db),
  ) {}

  async ask(actorId: string, request: AskRequest): Promise<AnswerResponse> {
    const actor = this.host.getActor(actorId);
    // `AskRequest` is what the type system believes; this value came from
    // `JSON.parse` and is whatever the caller sent. Both doors to an answer —
    // POST /ask and Studio's Knowledge API — arrive here, so the check belongs
    // here and not in either of them. See input.ts on why nothing is coerced.
    const sent = objectBody(request);
    const question = (optionalString(sent.question, 'question') ?? '').trim();
    if (!question) throw new CanonError('invalid', 'An answer requires a question');
    const collectionId = optionalString(sent.collectionId, 'collectionId');
    const limit = optionalCount(sent.limit, 'limit');
    const alsoVisibleTo = optionalString(sent.alsoVisibleTo, 'alsoVisibleTo');
    const collectionIds = optionalStringArray(sent.collectionIds, 'collectionIds');

    const candidates = await this.retrieval.retrieve(actorId, {
      question,
      collectionId,
      limit,
      canonicalOnly: true, // Canonical pages only, enforced in the candidate SQL
      expand: true, // multi-hop: the policy states the rule, its child procedure the steps
      alsoVisibleTo,
      collectionIds,
    });

    // Belt and braces over the SQL filter: nothing outside the answerable
    // statuses, and nothing that is a Note, can reach the generator, whatever
    // retrieval returns.
    //
    // MAY A GROUNDED ANSWER CITE A NEEDS UPDATE PAGE? Yes, and it must say so.
    //
    // The case against is the obvious one: Canonical is the boundary of what the
    // suite will act on (DATA-BACKBONE.md §4), and a page past its review date
    // has, by the record's own admission, not been checked lately.
    //
    // The case for, which wins:
    //
    // 1. Nothing has replaced it. A Needs Update page is a page that WAS
    //    approved, still has an owner, and is still the only official answer the
    //    record holds. Dropping it does not give the asker a better answer; it
    //    gives them "the record is silent" about a policy that plainly exists.
    //    That is not caution, it is a false statement about the record.
    // 2. Refusing would make the feature punish honesty. Setting a review date
    //    is a voluntary promise to re-read a page. If the reward for making that
    //    promise is that the page vanishes from answers the day it comes due,
    //    the rational move is never to set a review date — and freshness dies of
    //    its own incentives. The whole point of FEATURES.md §3 is that stale
    //    knowledge ANNOUNCES itself; announcing is not the same as disappearing.
    // 3. The honest thing is available and cheap. The answer can carry the page
    //    AND its standing: the generator marks the passage "past review", the
    //    response carries `pastReview`, and the reader decides. CORE-PLAN.md §7
    //    warns against the confident wrong answer — a cited, dated, flagged
    //    quotation is the opposite of one.
    //
    // Two limits keep this from widening: an archived page is still gone (it
    // left the record deliberately), and a Draft or a Note still cannot be cited
    // at all. Needs Update is the only addition, and only because it is the one
    // status that means "Canonical, and overdue" rather than "not Canonical".
    const eligible = candidates.filter(
      (c) => ANSWERABLE_STATUSES.includes(c.status) && c.type !== 'note' && c.passage.trim().length > 0,
    );

    // The topical gate. A directly retrieved candidate must be about the
    // question to anchor an answer; expanded neighbours ride on the anchor
    // that reached them, and are dropped when their anchor does not clear.
    const anchors = eligible.filter((c) => c.via === null && isOnTopic(question, `${c.title} ${c.passage}`));
    const anchored = new Set(anchors.map((c) => c.pageId));
    const passages: AnswerPassage[] = (
      anchors.length === 0 ? [] : eligible.filter((c) => c.via === null ? anchored.has(c.pageId) : anchored.has(c.via.fromPageId))
    )
      .slice(0, MAX_CITED_PASSAGES)
      .map((c) => ({ pageId: c.pageId, title: c.title, version: c.version, text: c.passage, status: c.status }));

    // Contradiction awareness, DATA-BACKBONE.md §7. Detection runs over the
    // passages this answer is about to be composed from, and it runs HERE —
    // before the generator is called, on the same array the generator gets,
    // outside the seam a real model will one day occupy. The generator is told
    // (so a good one can present the conflict well) and is not believed (so a
    // bad one cannot make the conflict go away).
    //
    // First, what the record already STATES about these pages: the conflicts
    // and supersessions a person asserted, and the divergences observed
    // between the sources those pages read from. This is not a second opinion
    // on the text inference below — it is the record speaking, and it is
    // consulted first because it is the stronger of the two by a distance.
    const stated = this.record.statedOver(passages.map((p) => p.pageId));
    const disagreement = detectDisagreement(passages, stated.conflicts);
    const supersession = detectSupersession(passages, stated.supersessions);
    const sourceDisagreement = detectSourceDisagreement(passages, stated.divergences);

    const generated =
      passages.length > 0
        ? this.generator.generate({ question, passages, disagreement, supersession, sourceDisagreement })
        : null;

    // Citations are built from the passages the generator was given, matched
    // by page id — a generator cannot cite a page it was not offered, and an
    // answer that cites nothing is refused rather than returned.
    const citations: Citation[] = [];
    for (const pageId of generated?.citedPageIds ?? []) {
      const passage = passages.find((p) => p.pageId === pageId);
      if (!passage || citations.some((c) => c.pageId === pageId)) continue;
      citations.push({
        pageId: passage.pageId,
        title: passage.title,
        version: passage.version,
        snippet: passage.text,
        ...(passage.status ? { status: passage.status } : {}),
      });
    }

    if (!generated || !generated.answer.trim() || citations.length === 0) {
      this.audit(actor, question, collectionId ?? null, true, []);
      return { answer: null, citations: [], refused: true, reason: 'no_canonical_match' };
    }

    // ---- the disagreement survives the generator ------------------------
    //
    // This is the part that has to hold when a real model arrives, so it is
    // deliberately not a request made of the generator. Three things happen
    // here, all of them outside the seam:
    //
    //   1. EVERY page named in the disagreement is cited, whether or not the
    //      generator cited it. Citing one side of a contradiction and quietly
    //      dropping the other is precisely the smoothing §7 forbids, and it
    //      does not become acceptable because a model chose it. The invariant
    //      still holds in the direction that matters — these pages were all
    //      offered as passages, so nothing is cited that was not permitted,
    //      Canonical, and read by the asker's own permissions.
    //   2. The answer TEXT says so. If the prose does not already carry the
    //      note verbatim, Canon writes the notice itself and puts it in front
    //      of whatever the generator wrote, quoting both sides. The only way a
    //      generator can avoid the prepended block is to have stated the
    //      disagreement in Canon's own words, which is not suppression.
    //   3. The `disagreement` field is set from detection, never from the
    //      generator's output, and is never cleared by it. A generator has no
    //      way to report that it "resolved" a conflict, because there is no
    //      such thing to report.
    let answer = generated.answer;
    if (disagreement) {
      for (const pageId of disagreement.pageIds) {
        if (citations.some((c) => c.pageId === pageId)) continue;
        const passage = passages.find((p) => p.pageId === pageId);
        if (!passage) continue;
        citations.push({
          pageId: passage.pageId,
          title: passage.title,
          version: passage.version,
          snippet: passage.text,
          ...(passage.status ? { status: passage.status } : {}),
        });
      }
    }

    // ---- and so do the other two things the record states ----------------
    //
    // Recomputed over the pages that were ACTUALLY CITED, rather than reported
    // from the advisory computed over the passages, and the difference is not
    // pedantry:
    //
    //   * a supersession is only a problem when both ends are quoted. An
    //     answer that cited the superseding page and left the old one alone
    //     has nothing to warn about, and warning anyway would train readers to
    //     ignore the warning. So it is reported only when both were cited —
    //     and when it is reported, the superseded citation STAYS. §7 is
    //     explicit that a supersession does not stop a page being cited, and
    //     dropping it here would be Canon deciding, silently, with the
    //     evidence removed rather than the problem.
    //   * a source divergence belongs to one page, so it is reported only if
    //     that page ended up cited.
    //
    // Neither adds a citation, unlike a disagreement: there is no second side
    // that must be quoted for the warning to be honest. The pages they name
    // are pages already in the answer.
    const cited = passages.filter((p) => citations.some((c) => c.pageId === p.pageId));
    const citedSupersession = detectSupersession(cited, stated.supersessions);
    const citedSourceDisagreement = detectSourceDisagreement(cited, stated.divergences);

    // In front of the generator's prose, in the order a reader needs them, and
    // only when the prose does not already carry the note verbatim — the same
    // rule the disagreement notice follows, for the same reason: a generator
    // that stated it in Canon's own words has not suppressed anything.
    const preamble: string[] = [];
    for (const notice of [citedSupersession, citedSourceDisagreement]) {
      if (notice && !answer.includes(notice.note)) preamble.push(notice.note);
    }
    if (preamble.length) answer = `${preamble.join('\n\n')}\n\n${answer}`;
    // The disagreement goes on last so it reads first. It is the sharpest of
    // the three: the other two describe the standing of what is quoted, this
    // one says the record gives two answers and Canon will not choose.
    if (disagreement && !answer.includes(disagreement.note)) {
      answer = `${disagreementNotice(disagreement, passages)}\n\n${answer}`;
    }

    this.audit(
      actor,
      question,
      collectionId ?? null,
      false,
      citations.map((c) => c.pageId),
      disagreement,
      citedSupersession,
      citedSourceDisagreement,
    );
    // Which of the cited pages are past review, named so a caller does not have
    // to parse the prose. Omitted entirely when none are.
    const pastReview = passages
      .filter((p) => p.status === 'needs_update' && citations.some((c) => c.pageId === p.pageId))
      .map((p) => ({ pageId: p.pageId, title: p.title }));
    return {
      answer,
      citations,
      refused: false,
      ...(pastReview.length ? { pastReview } : {}),
      ...(disagreement ? { disagreement } : {}),
      ...(citedSupersession ? { supersession: citedSupersession } : {}),
      ...(citedSourceDisagreement ? { sourceDisagreement: citedSourceDisagreement } : {}),
    };
  }

  // Answers are agent-facing as well as person-facing, so every ask is on the
  // record: who asked, what they asked, whether the record answered, exactly
  // which pages were cited, and — when the record disagreed with itself —
  // which pages disagreed, whether one of them had been superseded, and
  // whether a cited page's sources were at odds. An answer that carried any of
  // those is a fact about the record worth being able to query for later:
  // "which answers went out while that conflict was open" is a question an
  // auditor asks after the conflict is settled, and only the log can answer it.
  private audit(
    actor: Actor,
    question: string,
    collectionId: string | null,
    refused: boolean,
    citedPageIds: string[],
    disagreement?: Disagreement | null,
    supersession?: Supersession | null,
    sourceDisagreement?: SourceDisagreement | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, 'answer.ask', ?, NULL, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        collectionId,
        JSON.stringify({
          question,
          refused,
          citedPageIds,
          generator: this.generator.name,
          ...(disagreement ? { disagreement: disagreement.pageIds } : {}),
          // Whether a person asserted it, or Canon read it off the passages.
          // Six months later, "was this flagged because somebody said so?" is
          // the first question anybody asks of one of these events.
          ...(disagreement?.asserted
            ? { disagreementAsserted: disagreement.asserted.map((a) => a.assertedBy) }
            : {}),
          ...(supersession ? { supersession: supersession.pageIds } : {}),
          ...(sourceDisagreement
            ? { sourceDisagreement: sourceDisagreement.open.map((d) => d.id) }
            : {}),
        }),
      );
  }
}
