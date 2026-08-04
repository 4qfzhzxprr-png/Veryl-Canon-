import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVAL_CASES,
  UNANSWERABLE,
  buildEvalCorpus,
  evaluate,
  formatMisses,
  formatReport,
  runRetrievalEval,
  askRetriever,
  formatComparison,
  mcnemarP,
  EVAL_SEED,
  type EvalSnapshot,
  type QuestionOutcome,
} from '../scripts/eval-retrieval.js';

/** A snapshot with only the fields a comparison reads, so a case stays legible. */
function snapshotOf(perQuestion: QuestionOutcome[]): EvalSnapshot {
  return {
    provider: 'test',
    pages: 290,
    seed: EVAL_SEED,
    indexSeconds: 0,
    meanQueryMs: 0,
    metrics: { answered: perQuestion.filter((o) => o.answered).length / (perQuestion.length || 1) },
    perQuestion,
  };
}

// The retrieval quality harness (scripts/eval-retrieval.ts, `npm run
// eval:retrieval`).
//
// Two different things are tested here and it is worth being clear about
// which is which.
//
// THE ARITHMETIC is tested against a stub retriever whose answers are written
// by hand, because a metric that is quietly wrong is worse than no metric: it
// would make every future retrieval change look like whatever the bug says.
// P@1 counting rank 2 as a hit, or MRR averaging over the wrong denominator,
// would not show up as a failure anywhere else in this repository.
//
// THE FLOORS are a regression guard on retrieval itself, run against the demo
// corpus. They are deliberately set BELOW the numbers the harness currently
// produces, and they are not targets — a floor exists to catch a change that
// makes retrieval materially worse, not to certify that it is good. Raise one
// only when a change earns it and the new number holds.

// ---------------------------------------------------------------------------
// The arithmetic

test('eval: the metrics count what they say they count', async () => {
  // Four questions, one relevant page each, at ranks 1, 2, 3 and nowhere.
  const answers = new Map<string, string[]>([
    ['first', ['A', 'x', 'y']],
    ['second', ['x', 'A', 'y']],
    ['third', ['x', 'y', 'A']],
    ['missing', ['x', 'y', 'z']],
  ]);
  const report = await runRetrievalEval(
    async (q) => answers.get(q) ?? [],
    [
      { question: 'first', relevant: ['A'] },
      { question: 'second', relevant: ['A'] },
      { question: 'third', relevant: ['A'] },
      { question: 'missing', relevant: ['A'] },
    ],
  );

  assert.equal(report.cases, 4);
  assert.equal(report.precisionAt1, 0.25, 'one of four was ranked first');
  assert.equal(report.recallAt3, 0.75, 'three of four had it within three');
  assert.equal(report.recallAt5, 0.75, 'the fourth never appears, so a wider window changes nothing');
  // 1/1 + 1/2 + 1/3 + 0, over four.
  assert.ok(Math.abs(report.mrr - (1 + 0.5 + 1 / 3) / 4) < 1e-12);
  assert.deepEqual(
    report.misses.map((m) => m.question),
    ['missing'],
    'a miss is a case with no relevant page anywhere in the list, not a case ranked low',
  );
});

test('eval: any relevant page counts for recall, but primary@1 means the best one', async () => {
  // The case the labels rely on: a question the record answers in two places.
  // Returning the second-best one first is a hit for P@1 and not for
  // primary@1, and conflating the two would hide a real ranking change.
  const report = await runRetrievalEval(async () => ['Schedule', 'Class page'], [
    { question: 'how long', relevant: ['Class page', 'Schedule'] },
  ]);
  assert.equal(report.precisionAt1, 1, 'the top page does answer the question');
  assert.equal(report.primaryAt1, 0, 'but it is not the best of the two');
  assert.equal(report.results[0]?.rank, 1);
  assert.equal(report.results[0]?.primaryRank, 2);
});

test('eval: a retriever that returns nothing scores zero rather than dividing by it', async () => {
  const report = await runRetrievalEval(async () => [], [
    { question: 'a', relevant: ['A'] },
    { question: 'b', relevant: ['B'] },
  ]);
  assert.equal(report.precisionAt1, 0);
  assert.equal(report.mrr, 0);
  assert.equal(report.misses.length, 2);
});

// ---------------------------------------------------------------------------
// The question set itself

test('eval: every labelled question is distinct and names at least one page', () => {
  const questions = new Set<string>();
  for (const evalCase of EVAL_CASES) {
    assert.ok(evalCase.question.trim().length > 0, 'a question is a question');
    assert.ok(!questions.has(evalCase.question), `asked twice: ${evalCase.question}`);
    questions.add(evalCase.question);
    assert.ok(evalCase.relevant.length > 0, `no expected page for: ${evalCase.question}`);
    assert.equal(
      new Set(evalCase.relevant).size,
      evalCase.relevant.length,
      `a page listed twice for: ${evalCase.question}`,
    );
  }
  assert.ok(EVAL_CASES.length >= 40, 'the set is meant to be broad enough to move slowly');
  assert.ok(UNANSWERABLE.length >= 5, 'and to include questions the record cannot answer');
});

// ---------------------------------------------------------------------------
// The floors

test('eval: retrieval over the demo corpus has not regressed', async () => {
  const corpus = await buildEvalCorpus();
  const report = await evaluate(corpus);

  // Printed on failure and on success alike: when this test fails, the number
  // is the whole diagnosis, and hunting for it in a rerun wastes the run.
  const summary = `\n${formatReport(report, corpus.pages)}\n\n${formatMisses(report)}\n`;

  assert.ok(report.precisionAt1 >= 0.87, `P@1 fell to ${report.precisionAt1.toFixed(3)}${summary}`);
  assert.ok(report.primaryAt1 >= 0.75, `primary@1 fell to ${report.primaryAt1.toFixed(3)}${summary}`);
  assert.ok(report.recallAt3 >= 0.9, `R@3 fell to ${report.recallAt3.toFixed(3)}${summary}`);
  assert.ok(report.recallAt5 >= 0.95, `R@5 fell to ${report.recallAt5.toFixed(3)}${summary}`);
  assert.ok(report.mrr >= 0.9, `MRR fell to ${report.mrr.toFixed(3)}${summary}`);

  // The other half, and the half that was unguarded while it was the worse of
  // the two. Retrieval was putting a right page first 90% of the time while Ask
  // refused twelve of these forty-one questions outright and hedged fifteen
  // more — so the measured half improved and the half a reader actually
  // experiences did not. A floor on ranking alone would have let all of that
  // through, and did.
  //
  // THE FLOORS BELOW WERE RE-BASED TWICE, DELIBERATELY, and in opposite
  // directions. First DOWN, when the hedge stopped counting as an answer:
  // "Nothing in the record answers this directly. The closest it comes:"
  // carried refused:false, and the fourth persona round showed what that
  // bought — a screen "answering" with irrelevant pages, an audit log
  // disagreeing with the screen it describes, and a gaps probe annotating
  // gaps as answerable that a re-ask refused. Thin now refuses, and
  // `answered` fell from 0.907 to 0.814 by definition, not by regression.
  //
  // Then UP, the honest way: the demo corpus now ships as a tended record —
  // SEEDED_ALIASES carries the vocabulary its own gaps loop produced live
  // during testing ("urgent claims", "PTO", "nightly cleanup") — and
  // `answered` came back to 0.884 through the same gate that refused it,
  // with refused still at 1.0 and not a ranking metric moved. That is the
  // product's whole claim measured end to end: wrongful refusals are a
  // vocabulary problem, and vocabulary is an editorial surface, not a model.
  // Run the harness with --bare-vocabulary for the untended number.
  assert.ok(report.answered >= 0.86, `answered fell to ${report.answered.toFixed(3)}${summary}`);
  // Direct is an equality now, not a floor: an answer below the grounding bar
  // is refused before generation, so an answered case that is not `direct`
  // means the hedge came back.
  assert.equal(report.direct, 1, `an answer below the grounding bar was returned${summary}`);
  assert.ok(report.citedRelevant >= 0.78, `cited-relevant fell to ${report.citedRelevant.toFixed(3)}${summary}`);
  // A refusal that names a relevant page is a refusal the reader can act on —
  // and for the four re-based cases above it is the honest version of what
  // the hedge used to do. Measured 0.875 (seven of eight) when set.
  assert.ok(
    report.refusalPointedRight >= 0.7,
    `refusals stopped pointing at the right page: ${report.refusalPointedRight.toFixed(3)}${summary}`,
  );

  // The same record answers the same question the same way. Two corpora built
  // from one seed hold the same pages with the same words and different page
  // ids, and every ranking they produce must be identical.
  //
  // This was not true, and nothing said so. Equally-scoring pages came back in
  // whichever order the join against a UUID primary key produced, and the
  // whole pipeline inherited it — so this harness's own numbers moved by
  // twelve points between runs of the same code, and no tuning decision taken
  // against them meant anything. It is asserted here rather than in a unit
  // test because it is a property of the whole pipeline, and because this is
  // the file whose conclusions depend on it.
  const second = await buildEvalCorpus();
  const rerun = await runRetrievalEval(askRetriever(second));
  assert.deepEqual(
    rerun.results.map((r) => r.ranked),
    report.results.map((r) => r.ranked),
    'two records with the same content ranked the same question differently',
  );

  // The quotation, which is the sentence a reader actually reads. Cited the
  // right page and quoted the wrong part of it is a failure every ranking
  // metric here scores as a hit.
  assert.ok(report.quotedAnswer >= 0.68, `quoted-answer fell to ${report.quotedAnswer.toFixed(3)}${summary}`);

  // AN EQUALITY, AND THE ONE THAT MATTERS MOST. Not one question the record
  // cannot answer may be answered at all. This used to be two assertions —
  // confident overreach empty, hedged overreach bounded at two — because the
  // hedge was a permitted middle state: a disclaimer in the first sentence,
  // "allowed, and bounded". The hedge is gone (thin refuses, see the re-based
  // floors above), so the middle state is gone with it: every answer asserts
  // "The record says", and an unanswerable question that gets one is the
  // confident non-answer this product exists to avoid. The canteen's opening
  // hours and the three-days-a-week question — the two hedges this bound used
  // to admit — now refuse.
  assert.deepEqual(report.overreach, [], `answered a question the record is silent on${summary}`);
});

// ---------------------------------------------------------------------------
// Comparing two runs
//
// The same argument as the metrics above: a significance test that is quietly
// wrong is worse than none, because it would put a number of authority on
// whatever the bug says. These are the exact binomial tails and can be checked
// by hand.

test('eval: the significance test is the exact binomial tail', () => {
  assert.equal(mcnemarP(0, 0), 1, 'nothing moved, so nothing is known');
  assert.equal(mcnemarP(1, 0), 1);
  assert.equal(mcnemarP(2, 0), 0.5);
  assert.equal(mcnemarP(3, 0), 0.25);
  assert.equal(mcnemarP(4, 0), 0.125);
  assert.equal(mcnemarP(5, 0), 0.0625, 'five clean gains is still p > 0.05');
  assert.equal(mcnemarP(6, 0), 0.03125, 'six is the first that clears it');
  assert.equal(mcnemarP(0, 6), 0.03125, 'and it is two-sided');
  assert.equal(mcnemarP(2, 2), 1, 'questions that moved both ways cancel');

  // The thing this exists to stop: reading a two-question move as progress.
  assert.ok(mcnemarP(2, 0) > 0.05, 'two questions on a set this size is not evidence');
});

test('eval: a comparison names the questions that moved and only those', () => {
  const outcome = (question: string, answered: boolean): QuestionOutcome => ({
    question,
    rank: 1,
    answered,
    grounding: answered ? 'direct' : null,
    citedRelevant: answered,
    quotedAnswer: null,
  });
  const base = snapshotOf([outcome('a', true), outcome('b', false), outcome('c', true)]);
  const next = snapshotOf([outcome('a', true), outcome('b', true), outcome('c', false)]);

  const text = formatComparison(base, next);
  assert.match(text, /answered at all: 1 gained, 1 lost/);
  assert.ok(text.includes('+ b'), 'the question that started being answered is named');
  assert.ok(text.includes('- c'), 'and so is the one that stopped');
  assert.ok(!text.includes('+ a') && !text.includes('- a'), 'a question that did not move is not named');
  // Questions with nothing to check are not counted as agreeing or disagreeing.
  assert.match(text, /quoted the answer: no question changed/);
});

test('eval: comparing runs over different corpora says so rather than subtracting them', () => {
  const one = snapshotOf([]);
  const other = { ...snapshotOf([]), pages: 12 };
  assert.match(formatComparison(one, other), /DIFFERENT CORPUS/);
});
