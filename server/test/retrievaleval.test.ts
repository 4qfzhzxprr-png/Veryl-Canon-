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
  assert.ok(report.answered >= 0.88, `answered fell to ${report.answered.toFixed(3)}${summary}`);
  assert.ok(report.direct >= 0.87, `direct fell to ${report.direct.toFixed(3)}${summary}`);
  assert.ok(report.citedRelevant >= 0.78, `cited-relevant fell to ${report.citedRelevant.toFixed(3)}${summary}`);

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
  // cannot answer may be answered under "The record says". That is the
  // confident non-answer this product exists to avoid, and no gain anywhere
  // else on this page is worth one of them.
  const confident = report.overreach.filter((o) => o.grounding === 'direct');
  assert.deepEqual(confident, [], `answered a question the record is silent on, confidently${summary}`);

  // A hedged answer to such a question is a different thing: it opens with
  // "Nothing in the record answers this directly. The closest it comes:", which
  // is a disclaimer in the first sentence rather than a claim. It is allowed,
  // and it is bounded, because "here is the nearest page" stops being helpful
  // if it happens to everything. One of the fifteen does this today — the
  // canteen's opening hours, against a page about claims timeframes, because
  // the only word of that question the record has never seen is the subject.
  assert.ok(
    report.overreach.length <= 2,
    `too much reaching for the nearest page on questions the record cannot answer${summary}`,
  );
});
