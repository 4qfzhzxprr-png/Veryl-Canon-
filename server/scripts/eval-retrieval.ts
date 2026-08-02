// A measured retrieval quality harness.
//
//   npm run eval:retrieval                        # the report
//   npm run eval:retrieval -- --misses            # every case it got wrong
//   npm run eval:retrieval -- --json base.json    # save this run
//   npm run eval:retrieval -- --compare base.json # and diff a later one at it
//
// HOW TO EVALUATE A CANDIDATE MODEL, which is the same command with a
// different environment — see `buildEvalCorpus`:
//
//   npm run eval:retrieval -- --json shipped.json
//   CANON_EMBEDDINGS=http CANON_EMBEDDINGS_URL=http://localhost:8080/v1/embeddings \
//     CANON_EMBEDDINGS_MODEL=bge-base-en-v1.5 CANON_EMBEDDINGS_DIMENSIONS=768 \
//     npm run eval:retrieval -- --compare shipped.json
//
// The comparison prints the aggregate move, the questions that actually
// changed, the index and query cost of each, and whether the difference is
// large enough on this many questions to mean anything. That last one is not
// decoration: most changes worth making move two or three questions, and two
// or three questions here is p = 0.5.
//
// WHY THIS EXISTS. Retrieval is the one part of this product whose quality
// cannot be asserted by a unit test and cannot be judged by reading the code.
// Every other rule here is a rule — a page in review may not be edited, a
// submitter may not approve their own page — and a test either passes or it
// does not. "Did the right page come back first" is not that kind of question.
// It has a right answer, but the answer lives in a corpus, and the only honest
// way to know whether a change to ranking helped is to ask a fixed set of
// questions before and after and compare the numbers.
//
// Without this, every retrieval change is a guess dressed as an improvement.
// Weighting titles above bodies SOUNDS right. Stemming SOUNDS right. Both are
// judgements about a corpus, and both can be measured against one.
//
// THE CORPUS IS THE DEMO CORPUS, on a fixed seed. That is deliberate: it is
// the only corpus in the repository that looks like a company's — five
// collections, three hundred pages, most of them procedurally assembled from
// real sentences about their own subject, and twelve written out by hand
// carrying the figures (seed-demo.ts, WRITTEN_BODIES). The three hundred are
// not padding. They are the distractors, and they share the vocabulary that
// makes retrieval hard: "policy", "record", "scope", "requires", "review".
// A question set answered against twelve pages alone would measure nothing.
//
// WHAT IS LABELLED, AND BY WHOM. The labels below are mine and they are a
// judgement, so the judgement is written down rather than implied: a page is
// `relevant` to a question when a person who asked it and was handed that page
// would consider it answered — not merely on topic. Several questions have
// more than one right answer, because the record genuinely answers them in
// more than one place (the retention figure is on the schedule AND on the
// class page beneath it), and marking one of those wrong would measure the
// label, not the retrieval. Where one page is clearly the best of them it is
// listed first, and `primary@1` measures that stricter thing separately.
//
// WHAT THE NUMBERS MEAN.
//
//   P@1        the top page answers the question. The one a reader feels.
//   R@3, R@5   an answer is somewhere in the first three, five.
//   MRR        1/rank of the best relevant page, averaged. Rewards rank 1
//              over rank 2 more than rank 7 over rank 8, which is how a
//              reader experiences a list.
//   refused    of the questions the record CANNOT answer, how many Ask
//              refused rather than reaching for the nearest thing. This is
//              a retrieval metric, not a generation one: a change that lifts
//              recall by dragging weak pages into the context will show up
//              here as a fall, and that trade is the whole argument.
//
// A NUMBER HERE IS NOT A TARGET. P@1 of 1.0 on forty questions over one
// corpus would mean the labels were written to match the ranker.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { embeddingProviderFromEnv } from '../src/embeddingproviders.js';
import { localEmbeddingProvider, type EmbeddingProvider } from '../src/embeddings.js';
import { CanonStore } from '../src/store.js';
import type { NotificationTransport } from '../src/notify.js';
import { seedDemo } from './seed-demo.js';

const QUIET: NotificationTransport = { deliver() {} };

/** The seed the labels were written against. Changing it invalidates them. */
export const EVAL_SEED = 20260731;

export interface EvalCase {
  question: string;
  /**
   * Titles of pages that answer it, best first. Empty means the record does
   * not answer it and the right behaviour is refusal.
   */
  relevant: readonly string[];
  /** A note on what makes the case interesting, where it is not obvious. */
  why?: string;
  /**
   * Something the record's own words contain when this question is answered
   * properly — a period, a figure, a time. Any one of them counts.
   *
   * This labels a different thing from `relevant`, and the difference is the
   * whole reason it exists. `relevant` asks whether Canon found the right PAGE.
   * This asks whether the sentence it QUOTED off that page is the one that
   * answers, which is what a reader actually reads. Canon cited the page saying
   * `claims-purge — nightly, 02:10 UTC` and quoted its paragraph about log
   * scrubbing: right page, useless quotation, and every ranking metric scored
   * it a hit.
   *
   * Only the questions with a checkable answer carry this. "What makes a claim
   * clean?" is answered by a list, and turning that into a substring test would
   * be inventing a right answer to have something to measure.
   */
  answerContains?: readonly string[];
}

// ---------------------------------------------------------------------------
// The question set.
//
// Grouped by what each group is testing, because a flat list of forty
// questions hides the fact that half of them are the same question.

export const EVAL_CASES: readonly EvalCase[] = [
  // --- plain lookup: the question uses the record's own words -------------
  {
    question: 'How long do we keep claims records?',
    answerContains: ['seven years'],
    relevant: ['Retention periods: claims and appeals', 'Records Retention Schedule'],
  },
  {
    question: 'What is the retention period for clinical criteria?',
    answerContains: ['ten years'],
    relevant: ['Retention periods: clinical criteria', 'Records Retention Schedule'],
  },
  {
    question: 'How long are employment records kept?',
    answerContains: ['six years'],
    relevant: ['Retention periods: employment records', 'Records Retention Schedule'],
  },
  {
    question: 'What is the retention period for vendor contracts?',
    answerContains: ['seven years'],
    relevant: ['Retention periods: vendor contracts', 'Records Retention Schedule'],
  },
  {
    question: 'How long is audit evidence kept?',
    answerContains: ['seven years'],
    relevant: ['Records Retention Schedule'],
  },
  {
    question: 'How long do we keep member communications?',
    answerContains: ['three years', 'thirty-six months'],
    relevant: ['Records Retention Schedule', 'Data Retention in the Platform'],
  },
  {
    question: 'What is the deductible for PLAN-7?',
    answerContains: ['1,200'],
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },
  {
    question: 'What is the out-of-pocket maximum on the standard plan?',
    answerContains: ['6,000'],
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },
  {
    question: 'How long does a member have to file a first level appeal?',
    answerContains: ['180 days'],
    relevant: ['Appeals Process'],
  },
  {
    question: 'How many calendar days do we have to decide a clean claim?',
    answerContains: ['thirty calendar days'],
    relevant: ['Claims Processing Standard'],
  },

  // --- the question asked in words the record does not use ----------------
  // This is the group the semantic channel exists for. Each of these avoids
  // the term the page itself uses, on purpose: "urgent" for expedited,
  // "supplier" for vendor, "litigation" for legal hold, "destroyed" for
  // disposed, "purge" for deletion job.
  {
    question: 'How quickly must we decide an urgent claim?',
    answerContains: ['seventy-two hours'],
    relevant: ['Claims Processing Standard'],
    why: 'the record says "expedited", never "urgent"',
  },
  {
    question: 'Do we keep the security questionnaire we sent a supplier?',
    relevant: ['Retention periods: vendor contracts'],
    why: '"supplier" for vendor',
  },
  {
    question: 'What happens to retention when litigation is expected?',
    relevant: ['Retention periods: claims and appeals', 'Records and Retention'],
    why: 'the record says "legal hold", never "litigation"',
  },
  {
    question: 'What proof do we need that a record was destroyed?',
    relevant: ['Records and Retention', 'Secure Disposal of Records'],
    why: '"destroyed" for disposed; the answer is the disposal certificate rule',
  },
  {
    question: 'How long do we keep files about people who have left the company?',
    answerContains: ['six years'],
    relevant: ['Retention periods: employment records'],
    why: 'not one content word of the title appears in the question',
  },
  {
    question: 'Can somebody who is not a doctor turn down a medical claim on appeal?',
    relevant: ['Appeals Process'],
    why: '"doctor" for clinician, "turn down" for uphold a denial',
  },
  {
    question: 'Is having a baby covered from the first day?',
    relevant: ['Standard Plan (PLAN-7)'],
    why: '"having a baby" for maternity care',
  },
  {
    question: 'Does the nightly cleanup respect holds?',
    relevant: ['Retention jobs and their schedule', 'Data Retention in the Platform'],
    why: '"cleanup" for deletion job',
  },

  // --- the answer is a rule, not a figure ---------------------------------
  {
    question: 'Who is allowed to change a retention period?',
    answerContains: ['only function'],
    relevant: ['Records and Retention'],
  },
  {
    question: 'Is it a breach to keep a record for longer than its period?',
    relevant: ['Records and Retention'],
  },
  {
    question: 'When does the retention clock start for a claim?',
    answerContains: ['finally determined'],
    relevant: ['Retention periods: claims and appeals', 'Records Retention Schedule'],
  },
  {
    question: 'What makes a claim clean?',
    relevant: ['Claims Processing Standard', 'Clean claim definition'],
  },
  {
    question: 'What must a decision letter tell the member?',
    relevant: ['Appeals Process'],
  },
  {
    question: 'Who decides a second level appeal?',
    answerContains: ['took no part'],
    relevant: ['Appeals Process'],
  },
  {
    question: 'What happens when a claim is pended for more information?',
    relevant: ['Claims Processing Standard'],
  },
  {
    question: 'Why are clinical criteria kept longer than claims?',
    answerContains: ['challenged'],
    relevant: ['Retention periods: clinical criteria'],
  },
  {
    question: 'Does a vendor keeping our records for less time than we require matter?',
    relevant: ['Retention periods: vendor contracts'],
  },
  {
    question: 'How many network tiers does the standard plan have?',
    answerContains: ['three tiers', 'preferred, standard'],
    relevant: ['Standard Plan (PLAN-7)', 'PLAN-7 network tiers'],
  },
  {
    question: 'What does the standard plan not cover?',
    relevant: ['Standard Plan (PLAN-7)'],
  },
  {
    question: 'What evidence does a deletion run leave behind?',
    answerContains: ['disposal record'],
    relevant: ['Retention jobs and their schedule', 'Data Retention in the Platform'],
  },

  // --- the engineering side of the same subject ---------------------------
  // The corpus's hardest ambiguity: "retention" belongs to two collections
  // that mean different things by it, and the right page depends on whether
  // the asker means the obligation or the machine.
  {
    question: 'Does the platform delete claims data automatically?',
    answerContains: ['twenty-four months'],
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },
  {
    question: 'When does the claims purge job run?',
    answerContains: ['02:10'],
    relevant: ['Retention jobs and their schedule'],
  },
  {
    question: 'How long do backups last before they expire?',
    answerContains: ['ninety days'],
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },
  {
    question: 'When are member identifiers removed from application logs?',
    answerContains: ['ninety days'],
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },
  {
    question: 'Can engineering change the claims deletion job to match the schedule?',
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },

  // --- the disagreement itself --------------------------------------------
  // The corpus's deliberate conflict. A reader asking this must be handed
  // BOTH sides, so both are relevant and R@3 is the metric that matters.
  {
    question: 'How long is a claims record actually kept, seven years or twenty-four months?',
    relevant: [
      'Retention periods: claims and appeals',
      'Data Retention in the Platform',
      'Records Retention Schedule',
    ],
    why: 'the standing conflict; a reader needs both sides, not the nearest one',
  },
  {
    question: 'Where does the record disagree with itself about retention?',
    relevant: [
      'Records Retention Schedule',
      'Data Retention in the Platform',
      'Retention periods: claims and appeals',
    ],
  },
  {
    question: 'Which deductible figure is right, the plan document or the live one?',
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },

  // --- short questions, where there is almost nothing to go on ------------
  {
    question: 'claims retention',
    relevant: ['Retention periods: claims and appeals', 'Records Retention Schedule'],
  },
  {
    question: 'appeal deadlines',
    relevant: ['Appeals Process', 'Second-level and external review'],
  },
  {
    question: 'PLAN-7 deductible',
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },
];

/**
 * Questions the record does not answer. Every one is chosen so that no page in
 * the corpus is about it, in any collection, at any status — a subject, not a
 * synonym. What is measured is that Ask REFUSES: says the record is silent
 * rather than handing back the nearest page that shares a word.
 *
 * These are the metric a recall-chasing change gets caught by. It is easy to
 * lift recall by loosening what counts as a match, and a system that will
 * answer anything answers these too.
 */
export const UNANSWERABLE: readonly string[] = [
  'What is the dress code in the office?',
  'What is the company carbon reduction target?',
  'Do we accept payment in cryptocurrency?',
  'How do I reset my password?',
  'Which airline should I book for business travel?',
  'What is our policy on submarine procurement?',
  'How many parking spaces does the office have?',
  'What is the warranty on company laptops?',
  'Who is the chief executive?',
  'What are the opening hours of the canteen?',
  'How do I order business cards?',
  'Which charities does the company donate to?',
  'What is the fire evacuation procedure?',
  'How do I book a meeting room?',
  'What is the policy on office pets?',
];

// ---------------------------------------------------------------------------
// Metrics

/** A ranked list of page titles for one question. */
export type Retriever = (question: string) => Promise<string[]>;

export interface CaseResult {
  question: string;
  relevant: readonly string[];
  ranked: readonly string[];
  /** 1-based rank of the best relevant page; 0 when none was returned. */
  rank: number;
  /** 1-based rank of `relevant[0]` specifically; 0 when absent. */
  primaryRank: number;
}

/** One question's outcome, in the terms two runs can be compared on. */
export interface QuestionOutcome {
  question: string;
  /** 1-based rank of the best relevant page; 0 when it never appeared. */
  rank: number;
  answered: boolean;
  grounding: string | null;
  citedRelevant: boolean;
  /** null when this question has no checkable answer to look for. */
  quotedAnswer: boolean | null;
}

export interface EvalReport {
  cases: number;
  precisionAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt8: number;
  primaryAt1: number;
  mrr: number;
  /** Of UNANSWERABLE, the fraction Ask refused. */
  refused: number;
  refusalCases: number;
  /**
   * What Ask did with the questions the record DOES answer.
   *
   * Retrieval getting the right page to the top is worth nothing if the answer
   * path then declines to use it, and for a long time it did: the right page
   * came back first and Ask refused, or answered under "Nothing in the record
   * answers this directly". Only the retrieval half was measured, so only the
   * retrieval half improved.
   *
   * These are the two failures that are symmetric to `refused` above and just
   * as bad — refusing what the record answers, and hedging an answer the record
   * states plainly. A change that lifts `refused` by refusing more of
   * everything shows up here immediately.
   */
  answered: number;
  /** Of the answered, the fraction that said "the record says" rather than hedging. */
  direct: number;
  /** The fraction whose citations included a page the labels call relevant. */
  citedRelevant: number;
  /**
   * Of the labelled questions with a checkable answer, the fraction whose
   * QUOTATION contains it — the sentence a reader is shown, not the page it
   * came from. The two come apart more often than they sound like they would.
   */
  quotedAnswer: number;
  quotableCases: number;
  /** The ones that cited a page and quoted the wrong part of it. */
  misquoted: readonly { question: string; want: readonly string[]; quoted: string }[];
  /** The answerable questions Ask refused, named. */
  wrongfulRefusals: readonly string[];
  /** Every question's outcome, for comparing two runs question by question. */
  perQuestion: readonly QuestionOutcome[];
  /** Which embedding provider built the index, and what it cost to build. */
  provider: string;
  indexSeconds: number;
  meanQueryMs: number;
  results: readonly CaseResult[];
  /** The cases with no relevant page in the whole returned list. */
  misses: readonly CaseResult[];
  /**
   * Unanswerable questions that were answered anyway, with what was cited and
   * how confidently.
   *
   * THESE ARE TWO DIFFERENT FAILURES AND ONLY ONE OF THEM IS SERIOUS. A
   * `direct` answer to a question the record cannot answer is the confident
   * non-answer this product exists to avoid — a page presented under "The
   * record says". A `thin` one opens with "Nothing in the record answers this
   * directly. The closest it comes:", which is a disclaimer, on screen, in the
   * first sentence. Counting them together made a hedge look like a lie.
   */
  overreach: readonly { question: string; cited: readonly string[]; grounding?: string }[];
}

type RankingReport = Omit<
  EvalReport,
  | 'refused'
  | 'refusalCases'
  | 'overreach'
  | 'answered'
  | 'direct'
  | 'citedRelevant'
  | 'quotedAnswer'
  | 'quotableCases'
  | 'misquoted'
  | 'wrongfulRefusals'
  | 'perQuestion'
  | 'provider'
  | 'indexSeconds'
  | 'meanQueryMs'
>;

export async function runRetrievalEval(
  retrieve: Retriever,
  cases: readonly EvalCase[] = EVAL_CASES,
): Promise<RankingReport> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const ranked = await retrieve(evalCase.question);
    const relevant = new Set(evalCase.relevant);
    const rank = ranked.findIndex((title) => relevant.has(title)) + 1;
    const primaryRank = evalCase.relevant[0] ? ranked.indexOf(evalCase.relevant[0]) + 1 : 0;
    results.push({ question: evalCase.question, relevant: evalCase.relevant, ranked, rank, primaryRank });
  }
  const n = results.length || 1;
  const within = (k: number): number => results.filter((r) => r.rank >= 1 && r.rank <= k).length / n;
  return {
    cases: results.length,
    precisionAt1: within(1),
    recallAt3: within(3),
    recallAt5: within(5),
    recallAt8: within(8),
    primaryAt1: results.filter((r) => r.primaryRank === 1).length / n,
    mrr: results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n,
    results,
    misses: results.filter((r) => r.rank === 0),
  };
}

// ---------------------------------------------------------------------------
// The corpus, and the two things measured against it

export interface EvalCorpus {
  store: CanonStore;
  /** The operator, who can see every collection — so the metric is retrieval, not permissions. */
  actorId: string;
  pages: number;
  /** Which embedding provider built the vector index this run measured. */
  provider: string;
  /** Seconds to seed the corpus and embed all of it. A model's real cost. */
  indexSeconds: number;
}

/**
 * The corpus, built with whichever embedding provider is configured.
 *
 * `CANON_EMBEDDINGS` and its companions (CONFIGURATION.md) select the provider
 * here exactly as they do for a running server, so measuring a candidate model
 * is the same command with a different environment, and nothing has to be
 * written to try one:
 *
 *   npm run eval:retrieval
 *   CANON_EMBEDDINGS=http CANON_EMBEDDINGS_URL=... CANON_EMBEDDINGS_MODEL=... \
 *     CANON_EMBEDDINGS_DIMENSIONS=768 npm run eval:retrieval -- --json bge.json
 *
 * Before this, trying a model meant hand-writing a script that rebuilt half of
 * this file — which is how a model gets evaluated once, by whoever wrote the
 * script, and never again.
 */
export async function buildEvalCorpus(
  seed = EVAL_SEED,
  provider: EmbeddingProvider | null = embeddingProviderFromEnv(),
): Promise<EvalCorpus> {
  const started = Date.now();
  const store = new CanonStore(openDb(':memory:'), QUIET, provider ?? undefined);
  const report = await seedDemo(store, { seed, quiet: true });
  await store.embeddings.ready();
  return {
    store,
    actorId: report.operatorId,
    pages: report.pages,
    provider: (provider ?? localEmbeddingProvider).name,
    indexSeconds: (Date.now() - started) / 1000,
  };
}

/** Retrieval as Ask uses it: the official record only, graph expansion on. */
export function askRetriever(corpus: EvalCorpus, limit = 8): Retriever {
  return async (question: string) => {
    const candidates = await corpus.store.retrieve(corpus.actorId, {
      question,
      canonicalOnly: true,
      limit,
    });
    return candidates.map((c) => c.title);
  };
}

export async function evaluate(corpus: EvalCorpus): Promise<EvalReport> {
  const ranking = await runRetrievalEval(askRetriever(corpus));

  const overreach: { question: string; cited: readonly string[]; grounding?: string }[] = [];
  for (const question of UNANSWERABLE) {
    const answer = await corpus.store.ask(corpus.actorId, { question });
    if (!answer.refused) {
      overreach.push({
        question,
        cited: answer.citations.map((c) => c.title),
        grounding: answer.grounding,
      });
    }
  }

  // The other half: what Ask does with the questions the record answers.
  const wrongfulRefusals: string[] = [];
  const misquoted: { question: string; want: readonly string[]; quoted: string }[] = [];
  let direct = 0;
  let citedRelevant = 0;
  let quotable = 0;
  let quotedAnswer = 0;
  const perQuestion: QuestionOutcome[] = [];
  const rankOf = new Map(ranking.results.map((r) => [r.question, r.rank]));
  let askMs = 0;
  for (const evalCase of EVAL_CASES) {
    const started = Date.now();
    const answer = await corpus.store.ask(corpus.actorId, { question: evalCase.question });
    askMs += Date.now() - started;
    const outcome: QuestionOutcome = {
      question: evalCase.question,
      rank: rankOf.get(evalCase.question) ?? 0,
      answered: !answer.refused,
      grounding: answer.grounding ?? null,
      citedRelevant: answer.citations.some((c) => evalCase.relevant.includes(c.title)),
      quotedAnswer: null,
    };
    perQuestion.push(outcome);
    if (answer.refused) {
      wrongfulRefusals.push(evalCase.question);
      continue;
    }
    if (answer.grounding === 'direct') direct += 1;
    if (answer.citations.some((c) => evalCase.relevant.includes(c.title))) citedRelevant += 1;
    if (evalCase.answerContains?.length) {
      quotable += 1;
      const quoted = answer.citations.map((c) => c.snippet).join(' ').toLowerCase();
      outcome.quotedAnswer = evalCase.answerContains.some((want) => quoted.includes(want.toLowerCase()));
      if (outcome.quotedAnswer) {
        quotedAnswer += 1;
      } else {
        misquoted.push({
          question: evalCase.question,
          want: evalCase.answerContains,
          quoted: answer.citations[0]?.snippet.slice(0, 120) ?? '(nothing)',
        });
      }
    }
  }
  const total = EVAL_CASES.length || 1;
  const answeredCount = EVAL_CASES.length - wrongfulRefusals.length;

  return {
    ...ranking,
    refusalCases: UNANSWERABLE.length,
    refused: (UNANSWERABLE.length - overreach.length) / (UNANSWERABLE.length || 1),
    overreach,
    answered: answeredCount / total,
    direct: direct / (answeredCount || 1),
    citedRelevant: citedRelevant / total,
    quotedAnswer: quotedAnswer / (quotable || 1),
    quotableCases: quotable,
    misquoted,
    wrongfulRefusals,
    perQuestion,
    provider: corpus.provider,
    indexSeconds: corpus.indexSeconds,
    meanQueryMs: askMs / (EVAL_CASES.length || 1),
  };
}

// ---------------------------------------------------------------------------
// The report

export function formatReport(report: EvalReport, pages: number): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`.padStart(6);
  const lines = [
    `corpus            ${pages} pages, seed ${EVAL_SEED}`,
    `embeddings        ${report.provider}`,
    `cost              ${report.indexSeconds.toFixed(1)}s to index, ${report.meanQueryMs.toFixed(0)}ms per question`,
    `questions         ${report.cases} answerable, ${report.refusalCases} unanswerable`,
    '',
    `P@1               ${pct(report.precisionAt1)}   the top page answers it`,
    `primary@1         ${pct(report.primaryAt1)}   the top page is the single best one`,
    `R@3               ${pct(report.recallAt3)}`,
    `R@5               ${pct(report.recallAt5)}`,
    `R@8               ${pct(report.recallAt8)}`,
    `MRR               ${report.mrr.toFixed(3).padStart(6)}`,
    '',
    'what Ask then does with it',
    `answered          ${pct(report.answered)}   of the questions the record answers`,
    `direct            ${pct(report.direct)}   of those said "the record says", not "the closest it comes"`,
    `cited relevant    ${pct(report.citedRelevant)}   cited a page the labels call relevant`,
    `quoted answer     ${pct(report.quotedAnswer)}   of ${report.quotableCases} with a checkable answer, the quotation contains it`,
    `refused           ${pct(report.refused)}   of questions the record cannot answer`,
  ];
  if (report.overreach.length) {
    lines.push('', 'ANSWERED WHAT IT SHOULD HAVE REFUSED');
    for (const miss of report.overreach) {
      lines.push(
        `  [${miss.grounding ?? '?'}] ${miss.question}`,
        `    cited: ${miss.cited.join(' | ') || '(nothing)'}`,
      );
    }
  }
  if (report.misquoted.length) {
    lines.push('', 'CITED THE RIGHT PAGE AND QUOTED THE WRONG PART OF IT');
    for (const miss of report.misquoted) {
      lines.push(`  ${miss.question}`, `    want: ${miss.want.join(' / ')}`, `    got : ${miss.quoted}`);
    }
  }
  if (report.wrongfulRefusals.length) {
    lines.push('', 'REFUSED WHAT THE RECORD ANSWERS');
    for (const question of report.wrongfulRefusals) lines.push(`  ${question}`);
  }
  return lines.join('\n');
}

export function formatMisses(report: EvalReport): string {
  const lines: string[] = [];
  const worst = [...report.results]
    .filter((r) => r.rank !== 1)
    .sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.question.localeCompare(b.question));
  for (const result of worst) {
    lines.push(`rank ${result.rank || '—'}  ${result.question}`);
    lines.push(`   want: ${result.relevant.join(' | ')}`);
    lines.push(`   got:  ${result.ranked.slice(0, 5).join(' | ') || '(nothing)'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Comparing two runs
//
// A model, or a change to ranking, is judged by running this twice and looking
// at what moved. Doing that by eye across two printed reports is how a
// two-point wobble becomes an improvement in somebody's memory, so it is done
// here instead: aggregates side by side, the questions that actually changed
// named, and — the part that matters most — a statement about whether the
// difference is large enough to mean anything.
//
// HOW BIG A DIFFERENCE COUNTS. Forty-one questions, so one question is 2.4
// points, and the same questions are asked both times. That makes it a paired
// comparison, and the only evidence in it is the questions that DISAGREE
// between the runs — a question both runs get right says nothing about which
// is better. McNemar's exact test on those discordant pairs is the standard
// answer, and on a set this size it is unforgiving:
//
//   1 gained, 0 lost   p = 1.00      4 gained, 0 lost   p = 0.125
//   2 gained, 0 lost   p = 0.50      5 gained, 0 lost   p = 0.0625
//   3 gained, 0 lost   p = 0.25      6 gained, 0 lost   p = 0.031
//
// So it takes SIX questions moving cleanly one way before this set can call a
// difference real, and most changes worth making move two or three.
//
// That is a real limit of this harness and not a reason to distrust it. It
// means the set is big enough to catch a change that breaks retrieval and too
// small to adjudicate a tuning constant, which is exactly how the floors in
// the test are written. The way to move the limit is more labelled questions —
// preferably somebody else's, on their own corpus.

export interface EvalSnapshot {
  provider: string;
  pages: number;
  seed: number;
  indexSeconds: number;
  meanQueryMs: number;
  metrics: Record<string, number>;
  perQuestion: readonly QuestionOutcome[];
}

export function snapshot(report: EvalReport, pages: number): EvalSnapshot {
  return {
    provider: report.provider,
    pages,
    seed: EVAL_SEED,
    indexSeconds: report.indexSeconds,
    meanQueryMs: report.meanQueryMs,
    metrics: {
      precisionAt1: report.precisionAt1,
      primaryAt1: report.primaryAt1,
      recallAt3: report.recallAt3,
      recallAt5: report.recallAt5,
      mrr: report.mrr,
      answered: report.answered,
      direct: report.direct,
      citedRelevant: report.citedRelevant,
      quotedAnswer: report.quotedAnswer,
      refused: report.refused,
    },
    perQuestion: report.perQuestion,
  };
}

/**
 * Two-sided exact McNemar. `gained` is the count of questions the new run gets
 * right and the old one gets wrong; `lost` is the reverse. Questions both runs
 * agree on carry no information and are not counted.
 */
export function mcnemarP(gained: number, lost: number): number {
  const n = gained + lost;
  if (n === 0) return 1;
  const extreme = Math.max(gained, lost);
  // P(X >= extreme) for X ~ Binomial(n, 0.5), doubled for two sides.
  let tail = 0;
  let choose = 1; // C(n, 0)
  for (let k = 0; k <= n; k += 1) {
    if (k >= extreme) tail += choose;
    choose = (choose * (n - k)) / (k + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Which questions a binary outcome changed on, between two runs. */
function movement(
  base: readonly QuestionOutcome[],
  next: readonly QuestionOutcome[],
  of: (o: QuestionOutcome) => boolean | null,
): { gained: string[]; lost: string[] } {
  const before = new Map(base.map((o) => [o.question, o]));
  const gained: string[] = [];
  const lost: string[] = [];
  for (const after of next) {
    const was = before.get(after.question);
    if (!was) continue;
    const a = of(was);
    const b = of(after);
    if (a === null || b === null || a === b) continue;
    (b ? gained : lost).push(after.question);
  }
  return { gained, lost };
}

const COMPARED: { name: string; of: (o: QuestionOutcome) => boolean | null }[] = [
  { name: 'top page answers it', of: (o) => o.rank === 1 },
  { name: 'answered at all', of: (o) => o.answered },
  { name: 'cited a relevant page', of: (o) => o.citedRelevant },
  { name: 'quoted the answer', of: (o) => o.quotedAnswer },
];

export function formatComparison(base: EvalSnapshot, next: EvalSnapshot): string {
  const lines = [
    `baseline   ${base.provider}   ${base.indexSeconds.toFixed(1)}s index, ${base.meanQueryMs.toFixed(0)}ms/question`,
    `this run   ${next.provider}   ${next.indexSeconds.toFixed(1)}s index, ${next.meanQueryMs.toFixed(0)}ms/question`,
    '',
  ];
  if (base.seed !== next.seed || base.pages !== next.pages) {
    lines.push('*** DIFFERENT CORPUS — these two runs are not comparable ***', '');
  }
  for (const [name, value] of Object.entries(next.metrics)) {
    const was = base.metrics[name] ?? 0;
    const delta = value - was;
    const arrow = Math.abs(delta) < 1e-9 ? '  ' : delta > 0 ? '+ ' : '- ';
    lines.push(
      `${name.padEnd(16)} ${(was * 100).toFixed(1).padStart(6)}%  ->  ${(value * 100).toFixed(1).padStart(6)}%   ` +
        `${arrow}${Math.abs(delta * 100).toFixed(1)}`,
    );
  }
  lines.push('', 'WHAT ACTUALLY MOVED, AND WHETHER IT MEANS ANYTHING');
  for (const { name, of } of COMPARED) {
    const { gained, lost } = movement(base.perQuestion, next.perQuestion, of);
    if (gained.length === 0 && lost.length === 0) {
      lines.push(`  ${name}: no question changed`);
      continue;
    }
    const p = mcnemarP(gained.length, lost.length);
    const verdict =
      p < 0.05 ? 'a real difference' : `p = ${p.toFixed(2)} — too few to tell apart from chance`;
    lines.push(`  ${name}: ${gained.length} gained, ${lost.length} lost — ${verdict}`);
    for (const q of gained) lines.push(`      + ${q}`);
    for (const q of lost) lines.push(`      - ${q}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const corpus = await buildEvalCorpus();
  const report = await evaluate(corpus);
  console.log(formatReport(report, corpus.pages));
  if (process.argv.includes('--misses')) {
    console.log('');
    console.log('EVERY CASE NOT RANKED FIRST');
    console.log(formatMisses(report));
  }
  const against = flag('--compare');
  if (against) {
    const base = JSON.parse(readFileSync(against, 'utf8')) as EvalSnapshot;
    console.log('');
    console.log(formatComparison(base, snapshot(report, corpus.pages)));
  }
  const out = flag('--json');
  if (out) {
    writeFileSync(out, `${JSON.stringify(snapshot(report, corpus.pages), null, 2)}\n`);
    console.log(`\nsaved to ${out}`);
  }
}

// Run only when invoked as a program: importing this module (which the test
// does) must never seed three hundred pages as a side effect.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`eval-retrieval failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
