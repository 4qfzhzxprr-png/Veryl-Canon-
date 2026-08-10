import { CanonError } from './model.js';
import { isIsoDate, today } from './freshness.js';

// The effective date, and the one thing Canon can honestly say about it.
//
// USER-TESTING.md T1.5. An auditor set a canonical clinical policy's effective
// date to 2019-01-01 — seven years before the page existed — pushed it to
// Canonical, and got no warning. The attestation printed her date beside a
// creation date of 2026-08-01 and reconciled the two nowhere. Across the same
// collection, ten Canonical policies carried an effective date preceding their
// own first publication and six carried none at all. Her verdict is the one
// that matters: "my falsified entry is indistinguishable from the legitimate
// ones."
//
// THE NAIVE FIX IS WRONG. Refusing every effective date earlier than first
// publication would break the ordinary case. A policy that genuinely took
// effect in 2019 and was migrated into Canon in 2026 is what every company
// adopting this product has, and `import.ts` exists to bring exactly that
// material in. Refusing it would teach people to type today's date and move on,
// which destroys the field's meaning more thoroughly than the current laxity
// does: a field everyone fills in with a lie is worse than a field some people
// leave blank.
//
// SO THE COMPLAINT IS NOT "IT IS NOT VALIDATED". It is "the forgery and the
// migration look the same". That is the thing this file fixes, and it fixes it
// the only way a database can: not by adjudicating a claim about 2019 — Canon
// cannot and will never be able to do that — but by making the claim SAY
// SOMETHING. Three rules, in increasing order of how much they ask of a person:
//
//   1. A DATE IS A DATE. An effective date is a real ISO calendar date inside a
//      window a document-control system can mean. `isIsoDate` already existed
//      and was simply never called on this field.
//
//   2. A CLAIM ABOUT THE PAST IS DECLARED. Where the effective date precedes
//      the page's own first publication, the record cannot corroborate it from
//      anything it holds, so the person asserting it must say where it comes
//      from — a committee minute, a prior document-control system, an import
//      run. The basis is a structured field like every other, so it is
//      versioned, attributed to its author, carried in the field history, and
//      printed in the attestation beside the creation date it contradicts.
//      A genuine migration writes a sentence. A keystroke cannot.
//
//   3. THE EXCEPTION IS NAMED, NEVER SILENT. Whether or not a basis is given,
//      a backdated effective date is surfaced: in the attestation bundle, and
//      in `collectionHealth` as a count an auditor can sample with a query.
//      Attestations naming their exclusions is the habit every tester praised;
//      this extends it to the field a regulator asks about first.
//
// What this file deliberately does NOT do is decide that a backdated date is
// wrong. It is usually right. It is simply never provable from inside the
// record, and a record that prints an unprovable claim without saying so is
// making the claim on its own authority. See EFFECTIVE_DATE_LIMITS below,
// which travels in every attestation bundle.

/**
 * The earliest date Canon will accept. Not a judgement about how old a policy
 * may be — it is the line below which a value stops being a date and starts
 * being a typo. `0219-01-01` for `2019-01-01` parses cleanly, is a real ISO
 * date, and is not a document-control fact about anything; nothing legitimate
 * is lost by refusing it, and a slipped digit is caught at the keyboard rather
 * than in a register five years later.
 */
export const MIN_EFFECTIVE_DATE = '1900-01-01';

/**
 * How far ahead an effective date may be set: ten years.
 *
 * A future effective date is ordinary and useful — a policy approved in March
 * to take effect in July is exactly what the field is for, and Canon marks such
 * a page "not yet in force" rather than complaining about it. "Effective from
 * 2099" is a different animal. It is not a claim about the past that outside
 * evidence might corroborate; it is a commitment nobody in the building will be
 * alive to keep, and it has no migration story behind it, because a document
 * that takes effect in 2099 can be entered in 2098. It also quietly breaks
 * freshness: the review date will pass, the page will flip to Needs Update, and
 * it will never once have been in force.
 *
 * Ten years is a judgement, not a derivation, and it is stated here rather than
 * buried so it can be argued with. It is long enough for any real forward
 * commitment Canon has been shown, and short enough that a mistyped century is
 * refused at the keyboard.
 */
export const MAX_EFFECTIVE_DATE_HORIZON_DAYS = 3650;

/** The basis is a sentence, not an essay, and not a body in disguise. */
export const MAX_EFFECTIVE_DATE_BASIS = 500;

/** Add days to an ISO date, in UTC, and return an ISO date. */
function plusDays(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The date the record's own history starts for this page: the day its first
 * version was published, or — before anything is published — the day the page
 * was created, which is the only anchor that exists yet.
 *
 * First publication rather than creation because that is the question the
 * auditor asked, and because it is the moment the record can first evidence
 * anything about the content. Both are carried into the attestation so a reader
 * can see which was used and check the other themselves.
 */
export function recordAnchorDate(createdAt: string, firstPublishedAt: string | null): string {
  return (firstPublishedAt ?? createdAt).slice(0, 10);
}

/**
 * Does this effective date precede the record's own history? This is the whole
 * of the "backdated" test: a comparison of two dates the record already holds.
 * It is derived on every read rather than stored, so it cannot drift away from
 * the history it describes (the same reason attestation.ts reconstructs rather
 * than snapshots).
 */
export function isBackdated(effectiveDate: string | null | undefined, anchor: string): boolean {
  return Boolean(effectiveDate) && effectiveDate! < anchor;
}

/** Is this page dated to take effect on some day still ahead of us? */
export function isNotYetInForce(effectiveDate: string | null | undefined, on: string = today()): boolean {
  return Boolean(effectiveDate) && effectiveDate! > on;
}

/**
 * THE FIELD, AS THE PERSON FILLING IT IN SEES IT.
 *
 * Every refusal about a backdated date named the field `effectiveDateBasis`,
 * which is not a thing that exists anywhere a person can see: the editor's
 * label reads "Where the effective date comes from", and a policy owner who
 * had just been refused a save was being told to go and fill in a field by a
 * name that appears on no screen (round seven). It is the standing
 * non-technical-voice rule applied where it had been missed — refusal copy is
 * user-facing copy, and this refusal is one a person meets on an ordinary day.
 *
 * The machine-readable half is untouched: these errors still carry
 * `{ needs: 'effectiveDateBasis' }` in their details, because an API caller
 * needs the field's real name and a structured field is not prose. The label
 * below and the editor's <label> are the same words on purpose; if one moves,
 * the other must.
 */
const BASIS_LABEL = 'Where the effective date comes from';

/**
 * The shape rules: a real ISO date inside the window. Throws `invalid` with the
 * offending value in the message, in the style input.ts settled on — name the
 * field, quote what arrived, never coerce.
 */
export function validateEffectiveDateShape(value: string, on: string = today()): void {
  if (!isIsoDate(value)) {
    throw new CanonError('invalid', `An effective date is an ISO date (YYYY-MM-DD), not '${value}'`);
  }
  if (value < MIN_EFFECTIVE_DATE) {
    throw new CanonError(
      'invalid',
      `An effective date before ${MIN_EFFECTIVE_DATE} is a typo, not a date: '${value}'`,
      { field: 'effectiveDate', earliest: MIN_EFFECTIVE_DATE },
    );
  }
  const horizon = plusDays(on, MAX_EFFECTIVE_DATE_HORIZON_DAYS);
  if (value > horizon) {
    throw new CanonError(
      'invalid',
      `An effective date more than ${MAX_EFFECTIVE_DATE_HORIZON_DAYS} days ahead is not a commitment anyone can ` +
        `keep: '${value}' is past ${horizon}. A date in the past is allowed — fill in "${BASIS_LABEL}" — ` +
        'but a date this far ahead is refused.',
      { field: 'effectiveDate', latest: horizon },
    );
  }
}

/**
 * Normalise a basis: trimmed, bounded, and empty-means-absent. A basis of
 * whitespace is not a basis, and storing one would let the requirement below be
 * satisfied by pressing the space bar.
 */
export function normalizeBasis(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new CanonError('invalid', `"${BASIS_LABEL}" is a sentence of text`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_EFFECTIVE_DATE_BASIS) {
    throw new CanonError(
      'invalid',
      `An effective date basis is a sentence, not a document: ${trimmed.length} characters, limit ` +
        `${MAX_EFFECTIVE_DATE_BASIS}. Put the detail on the page and cite it here.`,
    );
  }
  return trimmed;
}

/**
 * The declaration rule itself, written once and applied by both paths that can
 * set the field: the draft path in store.ts and the proposal path in
 * proposals.ts. An agent proposing a backdated date is asked the same question
 * a person is, at proposal time rather than at acceptance, when somebody is
 * waiting.
 *
 * It fires only when the date CHANGES. That is what makes it migration-safe: a
 * page that already carries a backdated date with nothing said about it — the
 * ten the auditor found — keeps publishing, keeps being cited, and is surfaced
 * by record health instead. The question is asked of the person setting a date,
 * who is the only person who can answer it.
 */
export function requireBasisForBackdating(input: {
  next: string | null;
  previous: string | null;
  basis: string | null;
  anchor: string;
}): void {
  if (!input.next || input.next === input.previous) return;
  if (!isBackdated(input.next, input.anchor)) return;
  if (!input.basis) throw backdatedWithoutBasisError(input.next, input.anchor);
}

/** The refusal a person sees when they backdate without saying why. */
export function backdatedWithoutBasisError(effectiveDate: string, anchor: string): CanonError {
  return new CanonError(
    'invalid',
    `This effective date (${effectiveDate}) is earlier than anything Canon holds about this page, whose record ` +
      `starts ${anchor}. That is usually legitimate — a policy adopted before Canon existed and migrated into it ` +
      'keeps its real date — but the record cannot corroborate it, so it must not be printed as though the record ' +
      `could. Fill in "${BASIS_LABEL}" — a committee minute, the prior system, the import run — and it will be ` +
      'carried in the page history and in every attestation beside this date.',
    { field: 'effectiveDate', effectiveDate, recordStarts: anchor, needs: 'effectiveDateBasis' },
  );
}

/**
 * One page's effective date, judged against that page's own history. Derived,
 * never stored: `attestation.ts` puts this in the bundle and `queries.ts`
 * counts it in record health, and both compute it from the same two dates.
 */
export interface EffectiveDateStanding {
  effectiveDate: string | null;
  /** What the person who set a backdated date said it rests on. */
  basis: string | null;
  /** When the page was created in Canon. */
  createdAt: string;
  /** When its first version was published, or null if nothing ever was. */
  firstPublishedAt: string | null;
  /** The date the backdating test was made against: first publication, else creation. */
  recordStarts: string;
  /** The effective date precedes `recordStarts`. */
  backdated: boolean;
  /** Backdated, and nobody said where the date came from. The auditor's exception. */
  unexplained: boolean;
  /** Dated to take effect on a day still ahead of the instant asked about. */
  notYetInForce: boolean;
  /** Plain English for a reader. Never switched on by code. */
  note: string;
}

export function effectiveDateStanding(input: {
  effectiveDate: string | null;
  basis: string | null;
  createdAt: string;
  firstPublishedAt: string | null;
  on?: string;
}): EffectiveDateStanding {
  const on = input.on ?? today();
  const recordStarts = recordAnchorDate(input.createdAt, input.firstPublishedAt);
  const backdated = isBackdated(input.effectiveDate, recordStarts);
  const notYetInForce = isNotYetInForce(input.effectiveDate, on);
  const unexplained = backdated && !input.basis;

  let note: string;
  if (!input.effectiveDate) {
    note =
      'This page states no effective date. Nothing in the record says when what it says began to apply, and ' +
      'Canon will not guess one.';
  } else if (backdated) {
    note =
      `This page states that it took effect on ${input.effectiveDate}, which is before the record's own history ` +
      `of it begins (${recordStarts}${input.firstPublishedAt ? ', its first publication' : ', its creation, as nothing has been published'}). ` +
      (input.basis
        ? `The person who set that date gave this basis: "${input.basis}". Canon records the basis; it cannot ` +
          'verify it. Corroborate it against the source named there.'
        : 'No basis was recorded for the earlier date. Canon holds nothing that supports it, and this bundle ' +
          'does not assert it. Treat it as unevidenced until the source is produced.');
  } else if (notYetInForce) {
    note =
      `This page is dated to take effect on ${input.effectiveDate}, which has not yet arrived as at ${on}. ` +
      'It may hold the Canonical mark and still not be in force.';
  } else {
    note =
      `This page took effect on ${input.effectiveDate}, on or after the day the record's own history of it ` +
      `begins (${recordStarts}). Canon's own history is consistent with the date; that is the most it can say.`;
  }

  return {
    effectiveDate: input.effectiveDate,
    basis: input.basis,
    createdAt: input.createdAt,
    firstPublishedAt: input.firstPublishedAt,
    recordStarts,
    backdated,
    unexplained,
    notYetInForce,
    note,
  };
}

/**
 * What Canon can and cannot say about an effective date, in the words that
 * travel in every attestation bundle. Written here, beside the rules, so the
 * claim and the caveat cannot drift apart.
 */
export const EFFECTIVE_DATE_LIMITS =
  'An effective date is an ASSERTION by the person who set it, not an observation by Canon. Where it precedes ' +
  'the page\'s own first publication, Canon requires that person to state a basis and records it, attributed and ' +
  'versioned, beside the date — but it cannot check that basis, and a genuine migration and a date typed by hand ' +
  'are identical to a database. What the record can do, and does, is refuse to let a pre-dating claim pass ' +
  'unremarked: it is named here beside the creation date it contradicts, it is attributed in the field history to ' +
  'whoever set it, and it is counted in record health as an exception to be sampled. Corroborate a backdated ' +
  'effective date outside Canon.';
