// A measured retrieval quality harness.
//
//   npm run eval:retrieval            # the report
//   npm run eval:retrieval -- --misses  # and every case it got wrong
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

import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
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
    relevant: ['Retention periods: claims and appeals', 'Records Retention Schedule'],
  },
  {
    question: 'What is the retention period for clinical criteria?',
    relevant: ['Retention periods: clinical criteria', 'Records Retention Schedule'],
  },
  {
    question: 'How long are employment records kept?',
    relevant: ['Retention periods: employment records', 'Records Retention Schedule'],
  },
  {
    question: 'What is the retention period for vendor contracts?',
    relevant: ['Retention periods: vendor contracts', 'Records Retention Schedule'],
  },
  {
    question: 'How long is audit evidence kept?',
    relevant: ['Records Retention Schedule'],
  },
  {
    question: 'How long do we keep member communications?',
    relevant: ['Records Retention Schedule', 'Data Retention in the Platform'],
  },
  {
    question: 'What is the deductible for PLAN-7?',
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },
  {
    question: 'What is the out-of-pocket maximum on the standard plan?',
    relevant: ['PLAN-7 deductible and out-of-pocket maximum', 'Standard Plan (PLAN-7)'],
  },
  {
    question: 'How long does a member have to file a first level appeal?',
    relevant: ['Appeals Process'],
  },
  {
    question: 'How many calendar days do we have to decide a clean claim?',
    relevant: ['Claims Processing Standard'],
  },

  // --- the question asked in words the record does not use ----------------
  // This is the group the semantic channel exists for. Each of these avoids
  // the term the page itself uses, on purpose: "urgent" for expedited,
  // "supplier" for vendor, "litigation" for legal hold, "destroyed" for
  // disposed, "purge" for deletion job.
  {
    question: 'How quickly must we decide an urgent claim?',
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
    relevant: ['Records and Retention'],
  },
  {
    question: 'Is it a breach to keep a record for longer than its period?',
    relevant: ['Records and Retention'],
  },
  {
    question: 'When does the retention clock start for a claim?',
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
    relevant: ['Appeals Process'],
  },
  {
    question: 'What happens when a claim is pended for more information?',
    relevant: ['Claims Processing Standard'],
  },
  {
    question: 'Why are clinical criteria kept longer than claims?',
    relevant: ['Retention periods: clinical criteria'],
  },
  {
    question: 'Does a vendor keeping our records for less time than we require matter?',
    relevant: ['Retention periods: vendor contracts'],
  },
  {
    question: 'How many network tiers does the standard plan have?',
    relevant: ['Standard Plan (PLAN-7)', 'PLAN-7 network tiers'],
  },
  {
    question: 'What does the standard plan not cover?',
    relevant: ['Standard Plan (PLAN-7)'],
  },
  {
    question: 'What evidence does a deletion run leave behind?',
    relevant: ['Retention jobs and their schedule', 'Data Retention in the Platform'],
  },

  // --- the engineering side of the same subject ---------------------------
  // The corpus's hardest ambiguity: "retention" belongs to two collections
  // that mean different things by it, and the right page depends on whether
  // the asker means the obligation or the machine.
  {
    question: 'Does the platform delete claims data automatically?',
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },
  {
    question: 'When does the claims purge job run?',
    relevant: ['Retention jobs and their schedule'],
  },
  {
    question: 'How long do backups last before they expire?',
    relevant: ['Data Retention in the Platform', 'Retention jobs and their schedule'],
  },
  {
    question: 'When are member identifiers removed from application logs?',
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
  results: readonly CaseResult[];
  /** The cases with no relevant page in the whole returned list. */
  misses: readonly CaseResult[];
  /** Unanswerable questions that were answered anyway, with what was cited. */
  overreach: readonly { question: string; cited: readonly string[] }[];
}

export async function runRetrievalEval(
  retrieve: Retriever,
  cases: readonly EvalCase[] = EVAL_CASES,
): Promise<Omit<EvalReport, 'refused' | 'refusalCases' | 'overreach'>> {
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
}

export async function buildEvalCorpus(seed = EVAL_SEED): Promise<EvalCorpus> {
  const store = new CanonStore(openDb(':memory:'), QUIET);
  const report = await seedDemo(store, { seed, quiet: true });
  await store.embeddings.ready();
  return { store, actorId: report.operatorId, pages: report.pages };
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

  const overreach: { question: string; cited: readonly string[] }[] = [];
  for (const question of UNANSWERABLE) {
    const answer = await corpus.store.ask(corpus.actorId, { question });
    if (!answer.refused) {
      overreach.push({ question, cited: answer.citations.map((c) => c.title) });
    }
  }
  return {
    ...ranking,
    refusalCases: UNANSWERABLE.length,
    refused: (UNANSWERABLE.length - overreach.length) / (UNANSWERABLE.length || 1),
    overreach,
  };
}

// ---------------------------------------------------------------------------
// The report

export function formatReport(report: EvalReport, pages: number): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`.padStart(6);
  const lines = [
    `corpus            ${pages} pages, seed ${EVAL_SEED}`,
    `questions         ${report.cases} answerable, ${report.refusalCases} unanswerable`,
    '',
    `P@1               ${pct(report.precisionAt1)}   the top page answers it`,
    `primary@1         ${pct(report.primaryAt1)}   the top page is the single best one`,
    `R@3               ${pct(report.recallAt3)}`,
    `R@5               ${pct(report.recallAt5)}`,
    `R@8               ${pct(report.recallAt8)}`,
    `MRR               ${report.mrr.toFixed(3).padStart(6)}`,
    `refused           ${pct(report.refused)}   of questions the record cannot answer`,
  ];
  if (report.overreach.length) {
    lines.push('', 'ANSWERED WHAT IT SHOULD HAVE REFUSED');
    for (const miss of report.overreach) {
      lines.push(`  ${miss.question}`, `    cited: ${miss.cited.join(' | ') || '(nothing)'}`);
    }
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

async function main(): Promise<void> {
  const corpus = await buildEvalCorpus();
  const report = await evaluate(corpus);
  console.log(formatReport(report, corpus.pages));
  if (process.argv.includes('--misses')) {
    console.log('');
    console.log('EVERY CASE NOT RANKED FIRST');
    console.log(formatMisses(report));
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
