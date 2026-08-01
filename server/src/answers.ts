import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, PageStatus } from './model.js';
import { STOPWORDS } from './embeddings.js';
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
//
// Every ask lands in the audit log, refusals included.

export interface Citation {
  pageId: string;
  title: string;
  version: number;
  snippet: string;
}

export type RefusalReason = 'no_canonical_match';

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
 */
export interface Disagreement {
  pageIds: string[];
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
   * Set when the cited passages disagree with each other. Computed by this
   * module from the passages themselves — never by the generator, and never
   * removable by it. See `detectDisagreement`.
   */
  disagreement?: Disagreement;
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
export interface AnswerGenerator {
  readonly name: string;
  generate(input: {
    question: string;
    passages: AnswerPassage[];
    /** Advisory. Detected outside this seam; ignoring it changes nothing. */
    disagreement?: Disagreement | null;
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
}

function label(p: AnswerPassage): string {
  return `${p.title} (version ${p.version})`;
}

/**
 * The whole point of this module: given the passages an answer is about to be
 * composed from, does the record give more than one answer?
 *
 * Pure, deterministic, and free of any dependency on the generator — it takes
 * passages and returns a `Disagreement` or null, so it can be exercised
 * directly and so nothing downstream can influence it.
 */
export function detectDisagreement(passages: readonly AnswerPassage[]): Disagreement | null {
  if (passages.length < 2) return null; // a single passage cannot disagree with itself
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

  if (conflicts.length === 0) return null;

  // Page order follows the order the passages were offered, so the note, the
  // citations and the field all read the same way round.
  const involved = new Set(conflicts.flatMap((c) => c.pageIds));
  const pageIds = passages.map((p) => p.pageId).filter((id, at, all) => involved.has(id) && all.indexOf(id) === at);
  const details = [...new Set(conflicts.map((c) => c.detail))].slice(0, 2);
  const more = conflicts.length > details.length ? ' The record differs in more than one place here.' : '';
  return { pageIds, note: `${DISAGREEMENT_LEAD} ${details.join(' ')}${more} ${DISAGREEMENT_TAIL}` };
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
  ) {}

  async ask(actorId: string, request: AskRequest): Promise<AnswerResponse> {
    const actor = this.host.getActor(actorId);
    const question = request.question?.trim();
    if (!question) throw new CanonError('invalid', 'An answer requires a question');

    const candidates = await this.retrieval.retrieve(actorId, {
      question,
      collectionId: request.collectionId,
      limit: request.limit,
      canonicalOnly: true, // Canonical pages only, enforced in the candidate SQL
      expand: true, // multi-hop: the policy states the rule, its child procedure the steps
      alsoVisibleTo: request.alsoVisibleTo,
      collectionIds: request.collectionIds,
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
    const disagreement = detectDisagreement(passages);

    const generated =
      passages.length > 0 ? this.generator.generate({ question, passages, disagreement }) : null;

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
      });
    }

    if (!generated || !generated.answer.trim() || citations.length === 0) {
      this.audit(actor, question, request.collectionId ?? null, true, []);
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
        });
      }
      if (!answer.includes(disagreement.note)) {
        answer = `${disagreementNotice(disagreement, passages)}\n\n${answer}`;
      }
    }

    this.audit(
      actor,
      question,
      request.collectionId ?? null,
      false,
      citations.map((c) => c.pageId),
      disagreement,
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
    };
  }

  // Answers are agent-facing as well as person-facing, so every ask is on the
  // record: who asked, what they asked, whether the record answered, exactly
  // which pages were cited, and — when the record disagreed with itself —
  // which pages disagreed. An answer that carried a disagreement is a fact
  // about the record worth being able to query for later.
  private audit(
    actor: Actor,
    question: string,
    collectionId: string | null,
    refused: boolean,
    citedPageIds: string[],
    disagreement?: Disagreement | null,
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
        }),
      );
  }
}
