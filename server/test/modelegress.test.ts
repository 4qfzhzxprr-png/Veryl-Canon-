import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import { AnswerService, type AnswerGenerator } from '../src/answers.js';

// Per-collection model-egress control. The production-readiness review found
// that CANON_GENERATOR=anthropic sent gate-admitted page bodies (and the
// question) to a hosted API with no per-collection lever. A collection marked
// `restricted` — the flag that already means "watch every read of this" — must
// not have its content leave to a third party unless the deployment says so.
//
// The generator here is a SPY that egresses: it records whether it was called
// at all. Not being called is the proof that nothing left the process.

const TODAY = new Date().toISOString().slice(0, 10);

function spyGenerator(): { gen: AnswerGenerator; calls: () => number } {
  let calls = 0;
  const gen: AnswerGenerator = {
    name: 'spy-egress',
    egresses: true,
    generate(input) {
      calls += 1;
      const first = input.passages[0];
      if (!first) return null;
      return { answer: `spy composed: ${first.title}`, citedPageIds: input.passages.map((p) => p.pageId) };
    },
  };
  return { gen, calls: () => calls };
}

function publishCanonical(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
): string {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body,
    fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(editorId, page.id);
  store.approve(approverId, page.id);
  return page.id;
}

const RETENTION_BODY =
  'This policy covers the retention of claims records across the company. ' +
  'Claims records are retained for seven years from final determination. ' +
  'Disposal at the end of the period is evidenced by a certificate.';

interface Fixture {
  store: CanonStore;
  db: DatabaseSync;
  marc: { id: string };
  spyCalls: () => number;
}

/** A store whose AnswerService runs the egressing spy, with a chosen egress policy. */
async function fixture(opts: { restricted: boolean; allowRestrictedEgress: boolean }): Promise<Fixture> {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const { gen, calls } = spyGenerator();
  (store as unknown as { answers: AnswerService }).answers = new AnswerService(
    db,
    store as never,
    (store as unknown as { retrieval: ConstructorParameters<typeof AnswerService>[2] }).retrieval,
    gen,
    undefined,
    opts.allowRestrictedEgress,
  );
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: opts.restricted });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  publishCanonical(store, marc.id, iris.id, collection.id, 'Retention of claims records', RETENTION_BODY);
  await store.embeddings.ready();
  return { store, db, marc, spyCalls: calls };
}

function lastAnswerAudit(db: DatabaseSync): Record<string, unknown> {
  const row = db
    .prepare("SELECT details_json FROM audit_events WHERE action = 'answer.ask' ORDER BY id DESC LIMIT 1")
    .get() as { details_json: string } | undefined;
  return row ? JSON.parse(row.details_json) : {};
}

test('a restricted collection is composed locally: the egressing generator is never called', async () => {
  const { store, db, marc, spyCalls } = await fixture({ restricted: true, allowRestrictedEgress: false });
  const result = await store.ask(marc.id, { question: 'How long are claims records retained?' });
  assert.equal(result.refused, false, 'the answer still lands');
  assert.equal(spyCalls(), 0, 'the egressing generator was never reached, so nothing left the process');
  // The extractive generator composed it, verbatim from the page.
  assert.match(result.answer ?? '', /The record says:/);
  // The audit event is honest about what wrote it, and that egress was withheld.
  const audit = lastAnswerAudit(db);
  assert.equal(audit.generator, 'extractive-v1');
  assert.equal(audit.restrictedEgressWithheld, true);
});

test('an unrestricted collection still reaches the model generator', async () => {
  const { store, db, marc, spyCalls } = await fixture({ restricted: false, allowRestrictedEgress: false });
  const result = await store.ask(marc.id, { question: 'How long are claims records retained?' });
  assert.equal(result.refused, false);
  assert.equal(spyCalls(), 1, 'a non-restricted answer may use the configured generator');
  assert.match(result.answer ?? '', /spy composed:/);
  const audit = lastAnswerAudit(db);
  assert.equal(audit.generator, 'spy-egress');
  assert.equal(audit.restrictedEgressWithheld, undefined, 'nothing was withheld, so the flag is absent');
});

test('CANON_GENERATOR_ALLOW_RESTRICTED opts a deployment back in', async () => {
  const { store, marc, spyCalls } = await fixture({ restricted: true, allowRestrictedEgress: true });
  const result = await store.ask(marc.id, { question: 'How long are claims records retained?' });
  assert.equal(result.refused, false);
  assert.equal(spyCalls(), 1, 'with a data-processing agreement declared, restricted content may egress');
  assert.match(result.answer ?? '', /spy composed:/);
});
