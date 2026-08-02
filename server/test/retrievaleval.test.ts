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
} from '../scripts/eval-retrieval.js';

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

  assert.ok(report.precisionAt1 >= 0.78, `P@1 fell to ${report.precisionAt1.toFixed(3)}${summary}`);
  assert.ok(report.primaryAt1 >= 0.62, `primary@1 fell to ${report.primaryAt1.toFixed(3)}${summary}`);
  assert.ok(report.recallAt3 >= 0.88, `R@3 fell to ${report.recallAt3.toFixed(3)}${summary}`);
  assert.ok(report.recallAt5 >= 0.93, `R@5 fell to ${report.recallAt5.toFixed(3)}${summary}`);
  assert.ok(report.mrr >= 0.84, `MRR fell to ${report.mrr.toFixed(3)}${summary}`);

  // No floor on this one, an equality. Refusing what the record cannot answer
  // is the product's central claim, and a change that trades one refusal for
  // a point of recall has not improved retrieval — it has changed what the
  // product is. The overreach list names the question and what it reached for.
  assert.equal(
    report.overreach.length,
    0,
    `answered a question the record is silent on${summary}`,
  );
});
