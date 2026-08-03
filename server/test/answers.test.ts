import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { setHandOrgRole } from '../src/orgrole.js';
import { CanonStore } from '../src/store.js';
import {
  AnswerService,
  DISAGREEMENT_LEAD,
  SOURCE_DISAGREEMENT_LEAD,
  SUPERSESSION_LEAD,
  detectDisagreement,
  isOnTopic,
  detectSourceDisagreement,
  detectSupersession,
  extractiveGenerator,
  type AnswerGenerator,
  type AnswerPassage,
  type AssertedConflict,
  type AssertedSupersession,
  type PageDivergence,
} from '../src/answers.js';
import type { RetrievalService } from '../src/retrieval.js';

// A Policy states an effective date before it can publish (USER-TESTING.md
// T1.5). These fixtures are written and published in the same breath, so
// today's date is the honest one: it claims nothing about a time before the
// record, and so needs no basis.
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { db, store, dana, marc, iris, collection };
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

function publishNote(store: CanonStore, actorId: string, collectionId: string, title: string, body: string) {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body });
  return store.publish(actorId, page.id);
}

function publishCanonical(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
  parentId?: string,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title, ...(parentId ? { parentId } : {}) });
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

test('ask: answers cite the Canonical record, verbatim', async () => {
  const { store, marc, iris, collection } = setup();
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Vault access policy',
    'Every access to the vault is logged and reviewed each month.',
  );

  const result = await store.ask(marc.id, { question: 'Is vault access logged?' });
  assert.equal(result.refused, false);
  assert.equal(result.reason, undefined);
  assert.ok(result.answer);
  assert.equal(result.citations.length, 1);
  const [citation] = result.citations;
  assert.equal(citation!.pageId, policy.id);
  assert.equal(citation!.title, 'Vault access policy');
  assert.equal(citation!.version, policy.currentVersion);
  // Nothing is paraphrased: the snippet is the record's own words and the
  // answer is composed from it.
  assert.ok('Every access to the vault is logged and reviewed each month.'.includes(citation!.snippet.replace(/…$/, '')));
  assert.ok(result.answer!.includes(citation!.snippet));
});

test('ask: Canonical pages only — never a Draft, never a Note, never archived', async () => {
  const { store, marc, iris, collection } = setup();
  // A Note says one thing, and never carries the Canonical mark.
  publishNote(store, marc.id, collection.id, 'Pangolin scratch', 'The pangolin retention period is two years, probably.');
  // An unpublished draft says another.
  const drafted = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Pangolin draft' });
  store.editDraft(marc.id, drafted.id, {
    body: 'The pangolin retention period is four years.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  // A page that reached Canonical and was then archived.
  const retired = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Pangolin policy (retired)',
    'The pangolin retention period was one year.',
  );
  store.archivePage(marc.id, retired.id);
  // And the official record.
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Pangolin retention policy',
    'The pangolin retention period is seven years.',
  );

  const result = await store.ask(marc.id, { question: 'What is the pangolin retention period?' });
  assert.equal(result.refused, false);
  assert.deepEqual(result.citations.map((c) => c.pageId), [policy.id]);
  assert.ok(result.answer!.includes('seven years'));
  for (const wrong of ['probably', 'four years', 'one year']) {
    assert.ok(!result.answer!.includes(wrong), `non-Canonical material never reaches the answer: ${wrong}`);
  }

  // Re-publishing a Canonical page drops the mark, and with it the answer.
  store.editDraft(marc.id, policy.id, {
    body: 'The pangolin retention period is seven years.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.publish(marc.id, policy.id);
  const after = await store.ask(marc.id, { question: 'What is the pangolin retention period?' });
  assert.equal(after.refused, true);
  assert.deepEqual(after.citations, []);
});

test('ask: refusal is the honest answer to a silent record', async () => {
  const { store, marc, iris, collection } = setup();
  publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');

  const result = await store.ask(marc.id, { question: 'What is the parental leave allowance?' });
  assert.equal(result.refused, true);
  assert.equal(result.answer, null);
  assert.deepEqual(result.citations, []);
  assert.equal(result.reason, 'no_canonical_match');

  // An entirely empty record refuses too, rather than inventing.
  const empty = setup();
  const nothing = await empty.store.ask(empty.marc.id, { question: 'Is vault access logged?' });
  assert.equal(nothing.refused, true);
  assert.equal(nothing.reason, 'no_canonical_match');
});

test('ask: an answer without citations cannot be constructed', async () => {
  const { store, marc, iris, collection } = setup();
  publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');
  publishCanonical(store, marc.id, iris.id, collection.id, 'Badger policy', 'Badgers are counted each spring.');
  publishNote(store, marc.id, collection.id, 'Chatter', 'Musings about vaults and badgers.');

  for (const question of [
    'Is vault access logged?',
    'How often are badgers counted?',
    'What about the vault and the badgers?',
    'Who owns the moon?',
  ]) {
    const result = await store.ask(marc.id, { question });
    // The invariant, both ways round: an answer implies citations, and a
    // refusal implies none.
    if (result.refused) {
      assert.equal(result.answer, null);
      assert.deepEqual(result.citations, []);
    } else {
      assert.ok(result.citations.length >= 1, `"${question}" answered without a citation`);
      assert.ok(result.answer);
      for (const citation of result.citations) assert.ok(result.answer.includes(citation.snippet));
    }
  }

  // The generator is the seam a model plugs into, and it cannot invent a
  // citation: a page it was never offered is dropped, leaving a refusal.
  assert.equal(extractiveGenerator.generate({ question: 'anything', passages: [] }), null);
  const invented = extractiveGenerator.generate({
    question: 'anything',
    passages: [{ pageId: 'p1', title: 'T', version: 1, text: 'The record says so.' }],
  });
  assert.deepEqual(invented?.citedPageIds, ['p1']);
  assert.ok(invented?.answer.includes('The record says so.'));
});

test('ask: answers are permission-filtered per asker', async () => {
  const { store, dana, marc, iris, collection } = setup();
  publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');

  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const denied = await store.ask(outsider.id, { question: 'Is vault access logged?' });
  assert.equal(denied.refused, true);
  assert.deepEqual(denied.citations, []); // sees nothing, learns nothing

  // Permissions are data, evaluated at read time: granting view is enough,
  // and it takes effect on the next call.
  store.setMember(dana.id, collection.id, outsider.id, 'view');
  const granted = await store.ask(outsider.id, { question: 'Is vault access logged?' });
  assert.equal(granted.refused, false);
  assert.equal(granted.citations.length, 1);

  // And a revocation takes effect just as immediately.
  store.removeMember(dana.id, collection.id, outsider.id);
  assert.equal((await store.ask(outsider.id, { question: 'Is vault access logged?' })).refused, true);
});

test('ask: a multi-hop answer reaches the child procedure through the tree', async () => {
  const { store, marc, iris, collection } = setup();
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Contractor access policy',
    'Contractors may enter the building only with an escort.',
  );
  const procedure = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Contractor escort procedure',
    'Step one: the duty officer countersigns the escort register. Step two: the escort stays for the whole visit.',
    policy.id,
  );

  const result = await store.ask(marc.id, { question: 'Which contractors may enter the building?' });
  assert.equal(result.refused, false);
  const cited = result.citations.map((c) => c.pageId);
  assert.ok(cited.includes(policy.id), 'the policy states the rule');
  assert.ok(cited.includes(procedure.id), 'its child procedure states the steps');
});

test('ask: every ask is on the audit record, refusals included', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const policy = publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');

  await store.ask(marc.id, { question: 'Is vault access logged?', collectionId: collection.id });
  await store.ask(marc.id, { question: 'What is the parental leave allowance?' });

  const events = store.queryAudit(marc.id, { action: 'answer.ask' });
  assert.equal(events.length, 2);
  const [refused, answered] = events; // newest first
  assert.equal(answered!.actorId, marc.id);
  assert.equal(answered!.actorKind, 'person');
  assert.equal(answered!.collectionId, collection.id);
  assert.equal(answered!.details.question, 'Is vault access logged?');
  assert.equal(answered!.details.refused, false);
  assert.deepEqual(answered!.details.citedPageIds, [policy.id]);

  assert.equal(refused!.details.question, 'What is the parental leave allowance?');
  assert.equal(refused!.details.refused, true);
  assert.deepEqual(refused!.details.citedPageIds, []);

  // An agent asks the same way, and is recorded as an agent.
  const agent = store.createActor({ kind: 'agent', name: 'Answer Agent', registryRef: 'passport:answers-1' });
  store.setMember(dana.id, collection.id, agent.id, 'view');
  await store.ask(agent.id, { question: 'Is vault access logged?' });
  // Read as Dana, who runs this Canon: an ask that names no collection is an
  // OPERATOR's event (SECURITY.md R5, now asked through the org-level role in
  // orgrole.ts rather than through "admin on some collection"). It carries the
  // question text and belongs to the asker plus operators, nobody else.
  store.bootstrapAdministrator(dana.id);
  const byAgent = store.queryAudit(dana.id, { action: 'answer.ask', actorId: agent.id });
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0]!.actorKind, 'agent');
});

test('ask: the question and the asker are validated', async () => {
  const { store, marc } = setup();
  await expectCodeAsync(() => store.ask(marc.id, { question: '  ' }), 'invalid');
  await expectCodeAsync(() => store.ask('no-such-actor', { question: 'anything' }), 'not_found');
});

test('API: POST /ask and GET /pages/:id/related over HTTP', async () => {
  const store = new CanonStore(openDb(':memory:'), { deliver() {} });
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'x-actor-id': actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const iris = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Iris' })).json;
    const c = (await call('POST', '/collections', dana.id, { name: 'Compliance' })).json;
    await call('PUT', `/collections/${c.id}/members/${iris.id}`, dana.id, { role: 'approve' });

    const publish = async (title: string, body: string, parentId?: string) => {
      const page = (await call('POST', '/pages', dana.id, { collectionId: c.id, type: 'policy', title, parentId })).json;
      await call('PUT', `/pages/${page.id}/draft`, dana.id, { body, fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2099-01-01', effectiveDate: TODAY } });
      await call('POST', `/pages/${page.id}/submit`, dana.id);
      return (await call('POST', `/pages/${page.id}/approve`, iris.id)).json;
    };
    const policy = await publish('Vault access policy', 'Every access to the vault is logged and reviewed monthly.');
    const procedure = await publish('Vault access procedure', 'Request vault access from the duty desk.', policy.id);

    const unauthenticated = await call('POST', '/ask', undefined, { question: 'Is vault access logged?' });
    assert.equal(unauthenticated.status, 401);

    const invalid = await call('POST', '/ask', dana.id, {});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, 'invalid');

    const answered = await call('POST', '/ask', dana.id, { question: 'Is vault access logged?' });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.refused, false);
    assert.ok(answered.json.answer.includes('logged'));
    assert.ok(answered.json.citations.length >= 1);
    // The wire shape, over HTTP, key for key: `status` joined it so a caller
    // never has to assume the standing of a page it is being asked to trust.
    assert.deepEqual(Object.keys(answered.json.citations[0]).sort(), ['pageId', 'snippet', 'status', 'title', 'version']);
    assert.equal(answered.json.citations[0].status, 'canonical');
    assert.equal(answered.json.reason, undefined);

    const refused = await call('POST', '/ask', dana.id, { question: 'What is the parental leave allowance?' });
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.json, { answer: null, citations: [], refused: true, reason: 'no_canonical_match' });

    // An asker with no membership gets the same honest refusal.
    const outsider = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Outsider' })).json;
    const denied = await call('POST', '/ask', outsider.id, { question: 'Is vault access logged?' });
    assert.equal(denied.json.refused, true);
    assert.deepEqual(denied.json.citations, []);

    const related = await call('GET', `/pages/${policy.id}/related?canonical=true`, dana.id);
    assert.equal(related.status, 200);
    assert.deepEqual(related.json.map((r: any) => r.pageId), [procedure.id]);
    assert.deepEqual(related.json[0].via, { fromPageId: policy.id, edge: 'child' });
    assert.equal((await call('GET', `/pages/${policy.id}/related`, outsider.id)).status, 404);
  } finally {
    server.close();
  }
});

// Regression: retrieval ranks the best of what exists, which for an unrelated
// question is still something. Answering from it produced a confident, cited,
// wrong answer — caught end to end against a live server, fixed by the topical
// gate in answers.ts. These tests are the gate's contract.

test('ask: refuses a question the record does not cover, however well it ranks', async () => {
  const { store, marc, iris, collection } = setup();
  publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );

  // Shares exactly one content word with the record ("policy"), which is
  // enough to be retrieved and nowhere near enough to be cited.
  const result = await store.ask(marc.id, { question: 'What is our policy on submarine procurement?' });
  assert.equal(result.refused, true, 'an unrelated question must refuse, not cite the nearest page');
  assert.equal(result.answer, null);
  assert.deepEqual(result.citations, []);
  assert.equal(result.reason, 'no_canonical_match');

  // The same record still answers the question it actually covers.
  const covered = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(covered.refused, false);
  assert.equal(covered.citations.length, 1);
});

test('ask: a refusal on an off-topic question is audited like any other', async () => {
  const { store, marc, iris, collection } = setup();
  publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');

  await store.ask(marc.id, { question: 'What is our policy on submarine procurement?' });
  const events = store.queryAudit(marc.id, { action: 'answer.ask' });
  assert.equal(events[0]!.details.refused, true);
  assert.deepEqual(events[0]!.details.citedPageIds ?? [], []);
});

test('ask: graph-expanded neighbours ride on their anchor, not on their own wording', async () => {
  const { store, marc, iris, collection } = setup();
  const policy = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Vault access policy',
    'Every access to the vault is logged and reviewed each month.',
  );
  // A child whose text shares almost nothing with the question: it earns its
  // place through its parent, which is exactly what expansion is for.
  publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Monthly review steps',
    'Pull the ledger, confirm each entry against the badge system, then sign off.',
    policy.id,
  );

  const result = await store.ask(marc.id, { question: 'Is vault access logged and reviewed?' });
  assert.equal(result.refused, false);
  assert.ok(
    result.citations.some((c) => c.pageId === policy.id),
    'the anchor page must be cited',
  );
});

test('ask: a neighbour of an anchor is cited whether or not the question also finds it', async () => {
  // THE BUG THIS IS HERE FOR: whether a child procedure was cited depended on
  // whether the question's own words happened to reach it. Miss it, and it
  // rode into the answer on its parent. Hit it, and it became a candidate in
  // its own right, failed the topical gate on its own two words, and fell out
  // of the answer altogether — so making the search index better at finding it
  // made the answer worse. The edge to its parent was in the record the whole
  // time and is what decides now.
  //
  // Two runs over identical records. The only difference is one word in the
  // child's title, which decides whether the question reaches it directly.
  const run = async (childTitle: string) => {
    const { store, marc, iris, collection } = setup();
    const policy = publishCanonical(
      store,
      marc.id,
      iris.id,
      collection.id,
      'Contractor access policy',
      'Contractors may enter the building only with an escort.',
    );
    const child = publishCanonical(
      store,
      marc.id,
      iris.id,
      collection.id,
      childTitle,
      'Step one: the duty officer countersigns the escort register. Step two: the escort stays for the whole visit.',
      policy.id,
    );
    await store.embeddings.ready();
    const answer = await store.ask(marc.id, { question: 'Which contractors may enter the building?' });
    const candidates = await store.retrieve(marc.id, {
      question: 'Which contractors may enter the building?',
      canonicalOnly: true,
    });
    return {
      cited: answer.citations.map((c) => c.pageId),
      policyId: policy.id,
      childId: child.id,
      childVia: candidates.find((c) => c.pageId === child.id)?.via ?? null,
    };
  };

  // Out of reach of the question: it arrives through the edge.
  const unreachable = await run('Escort register countersigning');
  assert.equal(unreachable.childVia?.edge, 'child', 'this one really did arrive through the tree');
  assert.ok(unreachable.cited.includes(unreachable.childId));

  // In reach of the question: it arrives on its own, and is cited all the same.
  const reachable = await run('Contractor escort procedure');
  assert.equal(reachable.childVia, null, 'this one was found directly');
  assert.ok(
    reachable.cited.includes(reachable.childId),
    'being easier to find must not take a page out of the answer',
  );
});

test('isOnTopic: no single word of a question decides it', () => {
  // IDF IS INVERTED FOR THE WAY PEOPLE ASK. In a policy corpus the words
  // somebody types are rare and the words the record answers with are common,
  // so weighing purely by rarity weighs a question's phrasing above its
  // subject. These are the real figures from the demo corpus.
  const stats = {
    total: 290,
    df: new Map([
      ['decision', 143], // w 0.71
      ['letter', 34], //   w 2.14
      ['member', 127], //  w 0.83
      ['tell', 3], //      w 4.57 — outweighs the other three together
    ]),
  };
  const question = 'What must a decision letter tell the member?';
  const page = 'Appeals and Grievances. Every decision letter states the reason and names the next level of appeal to the member.';

  assert.equal(
    isOnTopic(question, page, stats),
    true,
    'three of four words, on a page that plainly addresses the question',
  );

  // The cap does not turn the gate off. A question mostly made of words this
  // record does not use is still refused — every term is capped, so capping
  // alone cannot change the ratio between what was covered and what was asked.
  const offTopic = {
    total: 290,
    df: new Map([['polici', 240], ['submarin', 0], ['procur', 0]]),
  };
  assert.equal(
    isOnTopic('What is our policy on submarine procurement?', 'A policy about retention.', offTopic),
    false,
  );
});

test('isOnTopic: the corpus statistic is used where it says something and counted where it does not', () => {
  const question = 'How long are client records retained?';
  const text = 'Client data retention policy. Client records are retained for ten years.';

  // A record of two pages, both about exactly this. Every word the question
  // uses that the record knows is on both pages, so every one of them weighs
  // nothing; "long" is on neither, so it weighs everything. Judged by weight
  // alone this question — answered by the record twice over — scores zero.
  const uniform = { total: 2, df: new Map([['client', 2], ['record', 2], ['retain', 2], ['long', 0]]) };
  assert.equal(isOnTopic(question, text, uniform), true, 'when nothing can be told apart, count');

  // The same shape of question against a corpus that CAN tell its words apart:
  // the weighting is back on, and a question made mostly of words this record
  // does not use is refused even though it covers two of them.
  const informative = {
    total: 400,
    df: new Map([['polici', 380], ['approv', 40], ['submarin', 0], ['procur', 0]]),
  };
  assert.equal(
    isOnTopic('What is our policy on submarine procurement?', 'A policy about approvals.', informative),
    false,
    'two of the commonest words in the corpus is not a topic match',
  );
});

test('refusal: points at the nearest pages without quoting them', async () => {
  const { store, marc, iris, collection } = setup();
  // The labelled failure this exists for: the page says "expedited", the asker
  // says "urgent", the gate refuses — and the page was the top candidate all
  // along. The refusal now says where to look.
  const page = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Claims Processing Standard',
    'An expedited claim, where delay would jeopardise the member’s health, is decided within seventy-two hours of receipt of the claim.',
  );
  // Enough neighbours for the corpus statistic to mean something: with one
  // page the gate falls back to counting words and the question squeaks
  // through, which is right for a tiny record and not the case under test.
  publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Claims intake register',
    'Every claim received is entered in the intake register on the day it arrives.',
  );
  publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Office plant care',
    'Plants are watered on Fridays by whoever is on the rota.',
  );
  await store.embeddings.ready();

  const refusal = await store.ask(marc.id, { question: 'How quickly must we decide an urgent claim?' });
  assert.equal(refusal.refused, true);
  assert.deepEqual(refusal.citations, [], 'a refusal still cites nothing');
  assert.ok(refusal.nearest && refusal.nearest.length >= 1, 'and now says where to look');
  assert.ok(refusal.nearest.length <= 3, 'suggestions, not results');
  const pointer = refusal.nearest.find((n) => n.pageId === page.id);
  assert.ok(pointer, 'the page that came closest is named');
  assert.equal(pointer.title, 'Claims Processing Standard');
  assert.equal(pointer.status, 'canonical');
  assert.ok(!('snippet' in pointer), 'a pointer carries no quotation — that would dress a refusal as an answer');

  // A successful answer carries no nearest: the citations are the pointers.
  const answered = await store.ask(marc.id, { question: 'How quickly is an expedited claim decided?' });
  assert.equal(answered.refused, false);
  assert.equal(answered.nearest, undefined);
});

test('refusal: nearest pages obey the asker’s permissions like everything else', async () => {
  const { store, dana, marc, iris, collection } = setup();
  publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Visible expedited claims',
    'An expedited claim is decided within seventy-two hours.',
  );
  // A better-matching page in a collection the asker cannot see.
  const secret = store.createCollection(dana.id, { name: 'Leadership only' });
  const hiddenPage = store.createPage(dana.id, { collectionId: secret.id, type: 'note', title: 'Urgent claims desk note' });
  store.editDraft(dana.id, hiddenPage.id, { body: 'Urgent claim decisions and the urgent claims rota.' });
  store.publish(dana.id, hiddenPage.id);
  await store.embeddings.ready();

  const refusal = await store.ask(marc.id, { question: 'Who staffs the urgent claims rota on weekends?' });
  assert.equal(refusal.refused, true);
  for (const pointer of refusal.nearest ?? []) {
    assert.notEqual(pointer.pageId, hiddenPage.id, 'a refusal must not leak titles the asker cannot open');
  }
});

// ---------------------------------------------------------------------------
// Contradiction awareness — DATA-BACKBONE.md §7, "Answers must never smooth a
// contradiction". An answer that reads two disagreeing passages into one
// fluent sentence has done the thing the whole document exists to prevent,
// invisibly, with citations attached that make it look verified.

function passage(pageId: string, title: string, text: string): AnswerPassage {
  return { pageId, title, version: 1, text };
}

test('ask: two Canonical pages that disagree are both cited, and the answer says they differ', async () => {
  const { store, marc, iris, collection } = setup();
  const seven = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );
  const ten = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
  );

  const result = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(result.refused, false, 'refusal is not the right answer here — two cited answers are');

  // The response carries the disagreement, naming both pages.
  assert.ok(result.disagreement, 'the record gives two answers, so the response must say so');
  assert.deepEqual([...result.disagreement!.pageIds].sort(), [seven.id, ten.id].sort());
  assert.ok(result.disagreement!.note.startsWith(DISAGREEMENT_LEAD));
  assert.ok(result.disagreement!.note.includes('seven years'));
  assert.ok(result.disagreement!.note.includes('ten years'));

  // Both are cited. Canon does not choose.
  assert.deepEqual(result.citations.map((c) => c.pageId).sort(), [seven.id, ten.id].sort());
  // And the citation invariant is unchanged: every cited snippet is in the text.
  for (const citation of result.citations) assert.ok(result.answer!.includes(citation.snippet));
  // The warning lives in the prose too, not only in a field a caller might drop.
  assert.ok(result.answer!.includes(DISAGREEMENT_LEAD));
});

test('disagreement: the shapes Canon claims to detect, it detects', () => {
  const conflicting: [string, AnswerPassage[]][] = [
    ['a retention period stated two ways', [
      passage('a', 'Records retention policy', 'Client records are retained for seven years from the end of the engagement.'),
      passage('b', 'Client data policy', 'Client records are retained for ten years after the engagement closes.'),
    ]],
    ['a currency amount', [
      passage('a', 'Travel policy', 'The meal allowance for travelling staff is $1,500 for each trip.'),
      passage('b', 'Expense policy', 'The meal allowance for travelling staff is $1,200 for each trip.'),
    ]],
    ['a percentage', [
      passage('a', 'Sampling policy', 'Reviewers must sample 80 percent of closed client files each quarter.'),
      passage('b', 'Quality policy', 'Reviewers sample 50 percent of closed client files each quarter.'),
    ]],
    ['a deadline in days', [
      passage('a', 'Breach policy', 'A personal data breach is reported to the regulator within 5 business days.'),
      passage('b', 'Breach procedure', 'A personal data breach is reported to the regulator within 10 business days.'),
    ]],
    ['a figure buried among agreeing ones', [
      passage('a', 'Retention policy', 'Client records are retained for seven years from the end of the engagement. Audit logs are retained for ten years.'),
      passage('b', 'Data policy', 'Client records are retained for ten years from the end of the engagement.'),
    ]],
    ['an explicit negation of the same claim', [
      passage('a', 'Vault access policy', 'Approval from the duty officer is required before any vault access is granted.'),
      passage('b', 'Vault exception page', 'Approval from the duty officer is not required for vault access.'),
    ]],
  ];

  for (const [name, passages] of conflicting) {
    const found = detectDisagreement(passages);
    assert.ok(found, `undetected disagreement: ${name}`);
    assert.deepEqual(found!.pageIds, ['a', 'b'], name);
    assert.ok(found!.note.startsWith(DISAGREEMENT_LEAD), name);
    // The note quotes the record rather than paraphrasing it, and names both pages.
    for (const p of passages) assert.ok(found!.note.includes(p.title), `${name} must name ${p.title}`);
  }
});

test('disagreement: agreeing passages are never accused of contradicting each other', () => {
  // The failure that would make this feature unusable is the false positive: a
  // confident, cited claim that the record contradicts itself when it does
  // not. Every set below is a set of passages that AGREE, or that are simply
  // about different things, and several of them share a number on purpose.
  const agreeing: [string, AnswerPassage[]][] = [
    ['the same period said twice', [
      passage('a', 'Records retention policy', 'Client records are retained for seven years from the end of the engagement.'),
      passage('b', 'Client data policy', 'Client records must be retained for seven years, then destroyed.'),
    ]],
    ['the same period in exactly convertible units', [
      passage('a', 'Records retention policy', 'Client records are retained for one year from the end of the engagement.'),
      passage('b', 'Client data policy', 'Client records are retained for twelve months after the engagement closes.'),
    ]],
    ['units that do not convert exactly are not compared at all', [
      passage('a', 'Breach policy', 'A personal data breach is reported to the regulator within 30 days.'),
      passage('b', 'Breach procedure', 'A personal data breach is reported to the regulator within 1 month.'),
    ]],
    ['version numbers that differ', [
      passage('a', 'Handbook', 'This handbook, version 3, sets out the escalation ladder for security incidents.'),
      passage('b', 'Escalation policy', 'Version 4 of the escalation ladder applies to all security incidents.'),
    ]],
    ['dates that differ', [
      passage('a', 'Vault policy', 'This vault access policy took effect on 2024-01-01 and applies to all staff.'),
      passage('b', 'Vault procedure', 'The vault access procedure was last rewritten on 2025-06-30 for all staff.'),
    ]],
    ['the same unit, different subjects', [
      passage('a', 'Records retention policy', 'Client records are retained for seven years from the end of the engagement.'),
      passage('b', 'Badge policy', 'Contractor badges expire three years after they are issued.'),
    ]],
    ['a cap and a threshold, both in dollars', [
      passage('a', 'Expense policy', 'Meal expenses are capped at $75 for each day of travel.'),
      passage('b', 'Approval policy', 'Travel expenses over $500 require the approval of a partner.'),
    ]],
    ['a percentage and its stated exemption', [
      passage('a', 'Sampling policy', 'Reviewers must sample 80 percent of closed client files each quarter.'),
      passage('b', 'Sampling exemptions', 'Some 20 percent of closed client files are exempt from quarterly sampling.'),
    ]],
    ['a range against a point inside it', [
      passage('a', 'Incident policy', 'Security incidents are triaged between thirty and sixty days of being raised.'),
      passage('b', 'Incident procedure', 'Security incidents are triaged within thirty days of being raised.'),
    ]],
    ['the same rule written positively and negatively', [
      passage('a', 'Contractor policy', 'Contractors must be escorted at all times inside the building.'),
      passage('b', 'Contractor procedure', 'Contractors are not permitted to enter the building without an escort.'),
    ]],
    ['a negation about a different subject', [
      passage('a', 'Badge policy', 'Badge renewal is required every year for permanent staff.'),
      passage('b', 'Visitor policy', 'A badge is not required for visitors attending an open day.'),
    ]],
    ['a negation about something else entirely', [
      passage('a', 'Vault access policy', 'Every access to the vault is logged and reviewed each month.'),
      passage('b', 'Vault review procedure', 'Reviewers do not sign the ledger until every entry has been checked.'),
    ]],
    ['a policy and the child procedure that implements it', [
      passage('a', 'Contractor access policy', 'Contractors may enter the building only with an escort.'),
      passage('b', 'Contractor escort procedure', 'Step one: the duty officer countersigns the escort register. Step two: the escort stays for the whole visit.'),
    ]],
    ['bare counts, which are not quantities Canon compares', [
      passage('a', 'Review policy', 'Two reviewers sign off every client file before it is closed.'),
      passage('b', 'Sign-off procedure', 'Three reviewers sign off every client file before it is closed.'),
    ]],
  ];

  for (const [name, passages] of agreeing) {
    assert.equal(detectDisagreement(passages), null, `false positive: ${name}`);
  }
});

test('disagreement: a single passage never disagrees with itself', () => {
  // One passage, several figures in it, and no second page to disagree with.
  assert.equal(
    detectDisagreement([
      passage('a', 'Retention policy', 'Client records are retained for seven years, and audit logs are retained for ten years.'),
    ]),
    null,
  );
  // Two passages that are the same page — the shape graph expansion could in
  // principle produce — are never played off against each other either.
  assert.equal(
    detectDisagreement([
      passage('same', 'Retention policy', 'Client records are retained for seven years.'),
      passage('same', 'Retention policy', 'Client records are retained for ten years.'),
    ]),
    null,
  );
  assert.equal(detectDisagreement([]), null);
});

test('ask: a generator that smooths the conflict cannot suppress it', async () => {
  const { db, store, marc, iris, collection } = setup();
  const seven = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );
  const ten = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
  );

  // Exactly what a real language model does when handed two passages that
  // disagree: one confident sentence, one citation, no mention of the
  // conflict. This is the failure mode §7 exists to prevent.
  const smoothing: AnswerGenerator = {
    name: 'fluent-smoother',
    generate({ passages }) {
      return {
        answer: 'Client records are retained for seven years from the end of the engagement.',
        citedPageIds: [passages[0]!.pageId],
      };
    },
  };
  const retrieval = (store as unknown as { retrieval: RetrievalService }).retrieval;
  const service = new AnswerService(db, store, retrieval, smoothing);

  const result = await service.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(result.refused, false);
  // The field is computed outside the generator, so it survives the smoothing.
  assert.ok(result.disagreement, 'a generator must not be able to make a disagreement vanish');
  assert.deepEqual([...result.disagreement!.pageIds].sort(), [seven.id, ten.id].sort());
  // The page the generator dropped is cited anyway — citing one side of a
  // contradiction and quietly dropping the other IS the smoothing.
  assert.deepEqual(result.citations.map((c) => c.pageId).sort(), [seven.id, ten.id].sort());
  // And the prose says so: Canon writes the notice itself, in front of
  // whatever the generator wrote, quoting both sides verbatim.
  assert.ok(result.answer!.includes(DISAGREEMENT_LEAD));
  assert.ok(result.answer!.includes('seven years'));
  assert.ok(result.answer!.includes('ten years'));
  for (const citation of result.citations) assert.ok(result.answer!.includes(citation.snippet));
  // The generator's own sentence is still there — Canon adds, it does not censor.
  assert.ok(result.answer!.includes('Client records are retained for seven years from the end of the engagement.'));
});

test('ask: the disagreement is filtered by permission like everything else', async () => {
  const { store, dana, marc, iris, collection } = setup();
  const seven = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );
  // The contradicting page lives in a collection Marc is not a member of.
  const restricted = store.createCollection(dana.id, { name: 'Legal' });
  store.setMember(dana.id, restricted.id, iris.id, 'approve');
  const ten = publishCanonical(
    store,
    dana.id,
    iris.id,
    restricted.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
  );

  // Marc cannot see it, so for him the record does not disagree — and it does
  // not leak the existence of the page it disagrees with.
  const marcSees = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(marcSees.refused, false);
  assert.equal(marcSees.disagreement, undefined);
  assert.deepEqual(marcSees.citations.map((c) => c.pageId), [seven.id]);
  assert.ok(!marcSees.answer!.includes('ten years'));

  // Dana can see both, and for her the record disagrees with itself.
  const danaSees = await store.ask(dana.id, { question: 'How long are client records retained?' });
  assert.ok(danaSees.disagreement);
  assert.deepEqual([...danaSees.disagreement!.pageIds].sort(), [seven.id, ten.id].sort());
});

test('ask: the topical gate still refuses, disagreement or not', async () => {
  const { store, marc, iris, collection } = setup();
  publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );
  publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
  );

  // A contradiction in the record is not a reason to answer a question the
  // record does not cover. Refusal comes first; there is nothing to disagree
  // about when nothing is cited.
  const result = await store.ask(marc.id, { question: 'What is our policy on submarine procurement?' });
  assert.equal(result.refused, true);
  assert.equal(result.answer, null);
  assert.deepEqual(result.citations, []);
  assert.equal(result.disagreement, undefined);
});

test('ask: an answer that carried a disagreement says so in the audit log', async () => {
  const { store, marc, iris, collection } = setup();
  const seven = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
  );
  const ten = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
  );
  publishCanonical(store, marc.id, iris.id, collection.id, 'Vault policy', 'Every access to the vault is logged.');

  await store.ask(marc.id, { question: 'How long are client records retained?' });
  await store.ask(marc.id, { question: 'Is vault access logged?' });

  const events = store.queryAudit(marc.id, { action: 'answer.ask' });
  assert.equal(events.length, 2);
  const [plain, contradicted] = events; // newest first
  assert.ok(Array.isArray(contradicted!.details.disagreement));
  assert.deepEqual([...(contradicted!.details.disagreement as string[])].sort(), [seven.id, ten.id].sort());
  // An ordinary answer carries no such claim.
  assert.equal(plain!.details.disagreement, undefined);
  assert.equal(plain!.details.refused, false);
});

test('extractive: conflicting passages are set against each other, not listed', () => {
  const passages = [
    passage('a', 'Records retention policy', 'Client records are retained for seven years.'),
    passage('b', 'Client data retention policy', 'Client records are retained for ten years.'),
    passage('c', 'Destruction procedure', 'Records are shredded on site once the retention period ends.'),
  ];
  const disagreement = detectDisagreement(passages);
  assert.ok(disagreement);

  const generated = extractiveGenerator.generate({ question: 'How long are records retained?', passages, disagreement });
  assert.ok(generated);
  // The disagreement leads, before any quotation, so the reader meets the
  // warning before they meet either answer.
  assert.ok(generated!.answer.startsWith(DISAGREEMENT_LEAD));
  // The conflicting pair is quoted together, above everything else.
  const conflictingEnds = generated!.answer.indexOf('Client records are retained for ten years.');
  const unrelatedAt = generated!.answer.indexOf('Records are shredded on site');
  assert.ok(conflictingEnds !== -1 && unrelatedAt !== -1 && conflictingEnds < unrelatedAt);
  assert.ok(generated!.answer.includes('On the rest of it, the record says'));
  assert.deepEqual(generated!.citedPageIds, ['a', 'b', 'c']);

  // Without a disagreement the extractive default is exactly what it was.
  const plain = extractiveGenerator.generate({ question: 'How long are records retained?', passages: [passages[2]!] });
  assert.ok(plain!.answer.startsWith('The record says:'));
});

// ---------------------------------------------------------------------------
// The standing of a cited page, carried to whoever renders the citation.
//
// USER-TESTING.md T1.1: the Ask view's source cards printed a green CANONICAL
// pill on every card, because `Citation` carried no status and the client
// defaulted the missing one to `canonical`. Two testers hit it independently —
// one watched a card read CANONICAL beside an answer whose own prose said that
// page was past review. These tests hold both halves shut: the server sends
// the standing it knows, and the client draws no badge it was not given.

// Canonical, with a review date the caller picks, so the freshness sweep has
// something to flip.
function publishCanonicalDue(
  store: CanonStore,
  editorId: string,
  approverId: string,
  collectionId: string,
  title: string,
  body: string,
  reviewDate: string,
) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate, effectiveDate: TODAY } });
  store.submitForReview(editorId, page.id);
  return store.approve(approverId, page.id);
}

test('ask: a citation carries the standing of the page it quotes', async () => {
  const { db, store, dana, marc, iris, collection } = setup();
  setHandOrgRole(db, dana.id, 'operator', null); // the sweep is an operator's act
  const policy = publishCanonicalDue(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records and retention',
    'Client records are retained for seven years from the end of the engagement.',
    '2026-01-01',
  );

  const current = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(current.citations.length, 1);
  assert.equal(current.citations[0]!.status, 'canonical');

  store.sweepFreshness(dana.id, { on: '2026-06-01' });

  const stale = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.equal(stale.refused, false, "a Needs Update page is still the record's own answer");
  assert.deepEqual(stale.citations.map((c) => c.pageId), [policy.id]);
  // The heart of T1.1: the citation says what the page now is. A renderer left
  // to guess will guess Canonical, and be wrong here.
  assert.equal(stale.citations[0]!.status, 'needs_update');
  // The three ways the same fact reaches a caller agree with each other: the
  // status on the citation, the pastReview list, and the prose.
  assert.deepEqual(stale.pastReview, [{ pageId: policy.id, title: 'Records and retention' }]);
  assert.match(stale.answer!, /past review/);
});

test('ask: a page named only by a disagreement is cited with its standing too', async () => {
  const { db, store, dana, marc, iris, collection } = setup();
  setHandOrgRole(db, dana.id, 'operator', null);
  const seven = publishCanonicalDue(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Records retention policy',
    'Client records are retained for seven years from the end of the engagement.',
    '2026-01-01',
  );
  const ten = publishCanonicalDue(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client data retention policy',
    'Client records are retained for ten years after the engagement closes.',
    '2099-01-01',
  );
  store.sweepFreshness(dana.id, { on: '2026-06-01' });

  const result = await store.ask(marc.id, { question: 'How long are client records retained?' });
  assert.ok(result.disagreement, 'the two policies contradict each other');
  // Citations added to keep a disagreement whole go through the same door, so
  // neither side of a contradiction is the one drawn without its standing.
  const byId = new Map(result.citations.map((c) => [c.pageId, c]));
  assert.equal(byId.get(seven.id)!.status, 'needs_update');
  assert.equal(byId.get(ten.id)!.status, 'canonical');
});

// The compiled test's depth below server/ depends on tsconfig's rootDir, so
// walk up to the browser code rather than counting '..'.
function findPublicFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'public', name);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`server/public/${name} not found above the compiled test file`);
}

test('ask view: a citation badge is drawn only from a status the server sent', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');

  // The defect itself, in the form it took: any default that turns a missing
  // status into the mark meaning "approved and current". It is worth pinning
  // as text because the damage was done at the call site, not in `badge`.
  assert.doesNotMatch(
    source,
    /(\?\?|\|\|)\s*['"]canonical['"]/,
    'a missing status must render nothing — defaulting it to canonical asserts the most trust-bearing value in the product on no evidence',
  );

  // And the behaviour, run for real. `citationBadge` is lifted out of the
  // browser file with a stub `badge` beneath it: no DOM, no bundler, and the
  // assertion is about the shipped source rather than a copy of it.
  const lifted = /function citationBadge\(c\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(lifted, 'the Ask view draws citation statuses through citationBadge');
  const citationBadge = new Function('badge', `${lifted[0]}\nreturn citationBadge;`)(
    (status: string, size: string) => `<badge ${status} ${size}>`,
  ) as (c: { status: string | null }) => string;

  assert.equal(citationBadge({ status: 'needs_update' }), '<badge needs_update sm>');
  assert.equal(citationBadge({ status: 'canonical' }), '<badge canonical sm>');
  assert.equal(citationBadge({ status: null }), '', 'no status, no badge');
});

test('ask view: a refusal renders nearest pages as links, never as quotations', () => {
  const source = readFileSync(findPublicFile('app.js'), 'utf8');
  const lifted = /function refusalHTML\(result, question, collection\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(lifted, 'the refusal view is drawn by refusalHTML');
  const refusalHTML = new Function(
    'esc', 'citationBadge', 'state', 'badge',
    `${lifted[0]}\nreturn refusalHTML;`,
  )(
    (x: string) => String(x),
    (n: { status?: string }) => (n.status ? `[${n.status}]` : ''),
    { features: { search: false } },
    () => '',
  ) as (result: unknown, question: string, collection: unknown) => string;

  const html = refusalHTML(
    {
      refused: true,
      reason: 'no_canonical_match',
      nearest: [
        { pageId: 'p-1', title: 'Claims Processing Standard', status: 'canonical' },
        { pageId: 'p-2', title: 'Appeals Process', status: 'needs_update' },
      ],
    },
    'urgent claims',
    null,
  );
  assert.ok(html.includes('#/pages/p-1') && html.includes('Claims Processing Standard'));
  assert.ok(html.includes('[canonical]') && html.includes('[needs_update]'), 'standing is shown on each pointer');
  assert.ok(html.includes('places to look'), 'and the framing says what these are not');
  assert.ok(!html.includes('The record says'), 'a refusal never wears an answer’s clothes');

  // Without nearest pages the section is simply absent.
  const bare = refusalHTML({ refused: true, reason: 'no_canonical_match' }, 'q', null);
  assert.ok(!bare.includes('nearest'), 'no pointers, no section');
});

// ---------------------------------------------------------------------------
// What the RECORD states, not what Canon reads off the prose
// (USER-TESTING.md T1.2, DATA-BACKBONE.md §7).
//
// A contradiction exists in the record three ways: inferred from two passages'
// text, asserted by a person as a `conflicts_with` relation, or observed
// between an authority and a corroborating source. The answer path used to
// know only the first — the weakest, and the only one that is a guess — which
// is DATA-BACKBONE.md §2's "structure over prose" run exactly backwards. These
// tests hold the other two.

/** A `conflicts_with` relation, as the `AnswerRecord` seam hands one over. */
function asserted(fromPageId: string, toPageId: string, note: string): AssertedConflict {
  return {
    fromPageId,
    toPageId,
    note,
    assertedBy: 'actor-nadia',
    assertedByName: 'Nadia Haddad',
    assertedAt: '2026-03-04T09:15:00.000Z',
  };
}

test('disagreement: a conflict a person asserted is reported though the text gives the detector nothing', () => {
  // Neither passage carries a quantity, a negation, or anything else the
  // lexical checks can compare. This is the demo corpus's real case in
  // miniature: a schedule and a platform spec whose prose does not visibly
  // disagree, joined by a relation that says one of them is wrong.
  const passages = [
    passage('schedule', 'Records Retention Schedule', 'This policy states the retention period for every record class the company holds.'),
    passage('platform', 'Data Retention in the Platform', 'This specification covers how the retention schedule is implemented in storage, backups, and logs.'),
  ];
  // Canon reading the prose finds nothing, and is right not to invent one.
  assert.equal(detectDisagreement(passages), null);

  const note =
    'The schedule keeps claims records for seven years; the platform spec describes a deletion job that runs at ' +
    'twenty-four months. One of the two is wrong, and Compliance owns which.';
  const found = detectDisagreement(passages, [asserted('schedule', 'platform', note)]);
  assert.ok(found, 'a conflict a person recorded must be reported whatever the text does');
  assert.deepEqual(found!.pageIds, ['schedule', 'platform']);
  // The note names both pages...
  assert.ok(found!.note.includes('Records Retention Schedule'));
  assert.ok(found!.note.includes('Data Retention in the Platform'));
  // ...and carries the asserter's own words verbatim, because they are what
  // the next person has to settle it from.
  assert.ok(found!.note.includes(note));
  assert.ok(found!.note.startsWith(DISAGREEMENT_LEAD));
});

test('disagreement: a person’s assertion is attributed as an assertion, not as something Canon inferred', () => {
  const passages = [
    passage('a', 'Records Retention Schedule', 'This policy states the retention period for every record class.'),
    passage('b', 'Data Retention in the Platform', 'This specification covers how the retention schedule is implemented.'),
  ];
  const found = detectDisagreement(passages, [
    asserted('a', 'b', 'One of the two is wrong, and Compliance owns which.'),
  ]);
  assert.ok(found);
  // A person, by name, on a date, in their own words. A reader must be able to
  // tell "a colleague wrote this down" from "a lexical check fired", because
  // the two carry very different weight.
  assert.ok(found!.note.includes('Nadia Haddad'), 'the asserter is named');
  assert.ok(found!.note.includes('asserted'), 'and it reads as an assertion, not as a finding');
  assert.ok(found!.note.includes('2026-03-04'), 'and it is dated');
  // The machine-readable half says the same thing, so a UI need not parse prose.
  assert.equal(found!.asserted?.length, 1);
  assert.equal(found!.asserted![0]!.assertedBy, 'actor-nadia');

  // And a disagreement Canon inferred claims no such thing: the field is
  // absent, so `{ pageIds, note }` is exactly what it always was.
  const inferred = detectDisagreement([
    passage('a', 'Records retention policy', 'Client records are retained for seven years from the end of the engagement.'),
    passage('b', 'Client data policy', 'Client records are retained for ten years after the engagement closes.'),
  ]);
  assert.ok(inferred);
  assert.equal(inferred!.asserted, undefined);
  assert.ok(!inferred!.note.includes('asserted'));
});

test('disagreement: an asserted conflict leads, and a relation reaching outside the answer is ignored', () => {
  const passages = [
    passage('a', 'Records retention policy', 'Client records are retained for seven years from the end of the engagement.'),
    passage('b', 'Client data policy', 'Client records are retained for ten years after the engagement closes.'),
  ];
  // Both halves fire over the same pair. The note has room for two details and
  // the person's assertion goes first: it outranks Canon's reading of a
  // sentence, every time.
  const found = detectDisagreement(passages, [
    asserted('a', 'b', 'These two were written by different teams in the same week.'),
  ]);
  assert.ok(found);
  const assertedAt = found!.note.indexOf('Nadia Haddad');
  const inferredAt = found!.note.indexOf('“seven years”');
  assert.ok(assertedAt !== -1 && inferredAt !== -1 && assertedAt < inferredAt);

  // A relation whose other end is not a passage of this answer names nothing:
  // it may be a page this asker cannot see, and Canon cannot quote a page it
  // never retrieved. Silence, not a rumour.
  const elsewhere = detectDisagreement(
    [passage('a', 'Records retention policy', 'Client records are kept as the schedule requires.')],
    [asserted('a', 'somewhere-else', 'These conflict.')],
  );
  assert.equal(elsewhere, null);
});

test('ask: two pages a person recorded as conflicting are flagged, though their prose gives the detector nothing', async () => {
  const { store, marc, iris, collection } = setup();
  // Deliberately bland: no quantity in comparable units, no negation, nothing
  // for the lexical checks to catch. Only a person knows these two disagree.
  const schedule = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup retention rule',
    'The retention rule for client backups is stated here, and every team follows this rule.',
  );
  const platform = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup deletion in the platform',
    'The platform implements the retention rule for client backups with a scheduled deletion job.',
  );

  const question = 'What is the retention rule for client backups?';
  // Before anybody says so, Canon is honestly silent: the prose does not
  // disagree in any way this module can see, and it does not pretend otherwise.
  const before = await store.ask(marc.id, { question });
  assert.equal(before.refused, false);
  assert.deepEqual(before.citations.map((c) => c.pageId).sort(), [schedule.id, platform.id].sort());
  assert.equal(before.disagreement, undefined);

  // A person writes the conflict into the record, which is the whole point of
  // relations.ts: contradiction as data rather than as something an auditor
  // discovers later.
  const note =
    'The rule keeps client backups for seven years; the platform deletes them at twenty-four months. ' +
    'One of the two is wrong, and Compliance owns which.';
  store.assertRelation(marc.id, schedule.id, { toPageId: platform.id, kind: 'conflicts_with', note });

  const after = await store.ask(marc.id, { question });
  assert.equal(after.refused, false);
  assert.ok(after.disagreement, 'the record states this conflict; the answer must not be blind to it');
  assert.deepEqual([...after.disagreement!.pageIds].sort(), [schedule.id, platform.id].sort());
  // Both sides cited, as §7 requires, and neither dropped.
  const citedIds = after.citations.map((c) => c.pageId);
  assert.ok(citedIds.includes(schedule.id) && citedIds.includes(platform.id));
  // The note names the pages and the person, and quotes what they wrote.
  assert.ok(after.disagreement!.note.includes('Client backup retention rule'));
  assert.ok(after.disagreement!.note.includes('Client backup deletion in the platform'));
  assert.ok(after.disagreement!.note.includes('Marc'), 'the person who asserted it is named');
  assert.ok(after.disagreement!.note.includes(note));
  assert.equal(after.disagreement!.asserted?.length, 1);
  // And the prose carries the warning, not just a field a caller might drop.
  assert.ok(after.answer!.includes(DISAGREEMENT_LEAD));
  assert.ok(after.answer!.includes(note));
});

test('ask: an asserted conflict survives a generator that cites only one side', async () => {
  const { db, store, marc, iris, collection } = setup();
  const schedule = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup retention rule',
    'The retention rule for client backups is stated here, and every team follows this rule.',
  );
  const platform = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup deletion in the platform',
    'The platform implements the retention rule for client backups with a scheduled deletion job.',
  );
  store.assertRelation(marc.id, schedule.id, {
    toPageId: platform.id,
    kind: 'conflicts_with',
    note: 'One of the two is wrong, and Compliance owns which.',
  });

  // The failure mode, now over a conflict a person asserted rather than one
  // Canon inferred: one confident sentence, one citation, no mention of it.
  // The generator has no channel through which to withdraw either kind.
  const smoothing: AnswerGenerator = {
    name: 'fluent-smoother',
    generate({ passages }) {
      return {
        answer: 'Client backups are kept for as long as the retention rule requires.',
        citedPageIds: [passages[0]!.pageId],
      };
    },
  };
  const retrieval = (store as unknown as { retrieval: RetrievalService }).retrieval;
  const service = new AnswerService(db, store, retrieval, smoothing);

  const result = await service.ask(marc.id, { question: 'What is the retention rule for client backups?' });
  assert.ok(result.disagreement);
  assert.deepEqual([...result.disagreement!.pageIds].sort(), [schedule.id, platform.id].sort());
  assert.deepEqual(result.citations.map((c) => c.pageId).sort(), [schedule.id, platform.id].sort());
  assert.ok(result.answer!.includes(DISAGREEMENT_LEAD));
  for (const citation of result.citations) assert.ok(result.answer!.includes(citation.snippet));
  // Canon adds; it does not censor.
  assert.ok(result.answer!.includes('Client backups are kept for as long as the retention rule requires.'));
});

test('supersession: citing a replaced page beside the page that replaced it says so, and drops neither', async () => {
  const { store, marc, iris, collection } = setup();
  const runbook = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'On-call escalation runbook',
    'The on-call escalation runbook describes how a paging escalation is handled out of hours.',
  );
  const spec = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Incident management escalation',
    'This spec sets out incident management, including how a paging escalation is handled out of hours.',
  );
  store.assertRelation(marc.id, spec.id, {
    toPageId: runbook.id,
    kind: 'supersedes',
    note: 'Paging and escalation were folded into this spec when it was reviewed.',
  });

  const result = await store.ask(marc.id, { question: 'How is a paging escalation handled out of hours?' });
  assert.equal(result.refused, false);
  const citedIds = result.citations.map((c) => c.pageId);
  assert.ok(citedIds.includes(runbook.id) && citedIds.includes(spec.id), 'both were retrieved, so both are cited');

  assert.ok(result.supersession, 'the record says one of these replaced the other, and the answer must say so');
  assert.deepEqual([...result.supersession!.pageIds].sort(), [runbook.id, spec.id].sort());
  assert.equal(result.supersession!.asserted.length, 1);
  assert.equal(result.supersession!.asserted[0]!.supersededPageId, runbook.id);
  assert.equal(result.supersession!.asserted[0]!.supersededByPageId, spec.id);
  assert.ok(result.supersession!.note.includes('Marc'));
  assert.ok(result.answer!.includes(SUPERSESSION_LEAD));
  // A supersession is NOT an unsettled conflict and is never reported as one:
  // a person already recorded which governs, so there is nothing for Canon to
  // refuse to choose between.
  assert.equal(result.disagreement, undefined);
  // The superseded page is still quoted. §7: asserting `supersedes` does not
  // archive it, does not change its status, and does not stop it being cited.
  for (const citation of result.citations) assert.ok(result.answer!.includes(citation.snippet));
});

test('supersession: an answer that quotes only the current page has nothing to warn about', () => {
  const relation: AssertedSupersession = {
    supersededPageId: 'runbook',
    supersededByPageId: 'spec',
    note: null,
    assertedBy: 'actor-marc',
    assertedByName: 'Marc',
    assertedAt: '2026-03-04T09:15:00.000Z',
  };
  const both = detectSupersession(
    [passage('spec', 'Incident management', 'The spec.'), passage('runbook', 'On-call runbook', 'The runbook.')],
    [relation],
  );
  assert.ok(both);
  assert.deepEqual(both!.pageIds, ['spec', 'runbook']);
  // Only the superseding page cited: no stale quotation, so no warning.
  // Warning anyway would teach readers to ignore the warning.
  assert.equal(detectSupersession([passage('spec', 'Incident management', 'The spec.')], [relation]), null);
});

test('sourceDisagreement: an open divergence on a cited page is reported, and as its own thing', async () => {
  const { db, store, marc, iris, collection } = setup();
  const page = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Standard plan deductible',
    'The standard plan deductible is set by Benefits Admin and shown on this page for every member.',
  );

  // The divergence is written directly rather than driven through a source and
  // a reference, because what is under test is the ANSWER path: given that the
  // record holds an open divergence on a cited page, does the answer say so?
  // divergence.test.ts owns the question of how one comes to be written.
  const source = (id: string, name: string): string => {
    db.prepare(
      `INSERT INTO sources (id, name, kind, base_url, auth_mode, freshness_window_ms, created_by, created_at)
       VALUES (?, ?, 'http', '', 'service', 60000, ?, ?)`,
    ).run(id, name, marc.id, new Date().toISOString());
    return id;
  };
  const authority = source('src-benefits-admin', 'Benefits Admin');
  const other = source('src-claims-platform', 'Claims Platform');
  db.prepare(
    `INSERT INTO divergences (id, reference_id, page_id, authority_source_id, authority_value,
                              other_source_id, other_value, observed_at, state)
     VALUES ('div-1', 'ref-1', ?, ?, '1500', ?, '1200', '2026-03-04T09:15:00.000Z', 'open')`,
  ).run(page.id, authority, other);

  const result = await store.ask(marc.id, { question: 'What is the standard plan deductible?' });
  assert.equal(result.refused, false);
  assert.deepEqual(result.citations.map((c) => c.pageId), [page.id]);

  assert.ok(result.sourceDisagreement, 'the page’s own sources disagree, and the answer must not hide it');
  assert.deepEqual(result.sourceDisagreement!.pageIds, [page.id]);
  assert.deepEqual(result.sourceDisagreement!.open.map((d) => d.id), ['div-1']);
  // Sources by name, values as the systems gave them, and which one is the
  // authority — because the authority's is the value the page displays.
  assert.ok(result.sourceDisagreement!.note.includes('Benefits Admin'));
  assert.ok(result.sourceDisagreement!.note.includes('Claims Platform'));
  assert.ok(result.sourceDisagreement!.note.includes('1500'));
  assert.ok(result.sourceDisagreement!.note.includes('1200'));
  // And it is told apart from a page-to-page conflict, in so many words.
  assert.ok(result.sourceDisagreement!.note.includes('not the same thing as two pages'));
  assert.equal(result.disagreement, undefined, 'one page’s sources disagreeing is not two pages contradicting');
  assert.ok(result.answer!.includes(SOURCE_DISAGREEMENT_LEAD));

  // A closed divergence is history and belongs on the divergence endpoints,
  // not on a live answer.
  db.prepare("UPDATE divergences SET state = 'closed' WHERE id = 'div-1'").run();
  const settled = await store.ask(marc.id, { question: 'What is the standard plan deductible?' });
  assert.equal(settled.sourceDisagreement, undefined);
});

test('sourceDisagreement: a divergence on a page this answer does not cite is not this answer’s business', () => {
  const divergence: PageDivergence = {
    id: 'div-1',
    pageId: 'somewhere-else',
    authoritySourceName: 'Benefits Admin',
    authorityValue: 1500,
    otherSourceName: 'Claims Platform',
    otherValue: 1200,
    observedAt: '2026-03-04T09:15:00.000Z',
  };
  assert.equal(detectSourceDisagreement([passage('a', 'Deductibles', 'Text.')], [divergence]), null);
  assert.ok(detectSourceDisagreement([passage('somewhere-else', 'Deductibles', 'Text.')], [divergence]));
});

test('ask: what the record stated is on the audit log, an asserted conflict marked as asserted', async () => {
  const { store, marc, iris, collection } = setup();
  const schedule = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup retention rule',
    'The retention rule for client backups is stated here, and every team follows this rule.',
  );
  const platform = publishCanonical(
    store,
    marc.id,
    iris.id,
    collection.id,
    'Client backup deletion in the platform',
    'The platform implements the retention rule for client backups with a scheduled deletion job.',
  );
  store.assertRelation(marc.id, schedule.id, {
    toPageId: platform.id,
    kind: 'conflicts_with',
    note: 'One of the two is wrong, and Compliance owns which.',
  });

  await store.ask(marc.id, { question: 'What is the retention rule for client backups?' });
  const [event] = store.queryAudit(marc.id, { action: 'answer.ask' });
  assert.deepEqual([...(event!.details.disagreement as string[])].sort(), [schedule.id, platform.id].sort());
  // "Was this flagged because somebody said so?" is the first question anybody
  // asks of one of these events six months later, so the log answers it.
  assert.deepEqual(event!.details.disagreementAsserted, [marc.id]);
});

// A page's standing must not depend on how the question was phrased.
//
// A compliance director asked one question three ways. Two phrasings pulled
// both sides of an asserted conflict into the answer and he was warned; the
// third — "the one I would actually use" — cited one side only and said
// nothing, while the record held a written assertion that the number was
// disputed. `disagreement` needs both sides so it can quote both; `disputed`
// is the standing itself, and it is true whenever the page is cited.
test('ask: a contested page says so even when only its own side is cited', async () => {
  const { store, marc, iris, collection } = setup();
  const schedule = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Records Retention Schedule',
    'Claims and appeals records are kept for seven years from final determination.',
  );
  const platform = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Data Retention in the Platform',
    'A scheduled job in the claims platform deletes stored artefacts at twenty-four months.',
  );
  store.assertRelation(marc.id, schedule.id, {
    toPageId: platform.id,
    kind: 'conflicts_with',
    note: 'Seven years on the schedule against twenty-four months in the platform. One is wrong.',
  });

  // A question that reaches only the schedule.
  const oneSided = await store.ask(marc.id, { question: 'final determination claims appeals kept' });
  assert.equal(oneSided.refused, false);
  const cited = oneSided.citations.find((c) => c.pageId === schedule.id);
  assert.ok(cited, `the schedule should be cited: ${oneSided.citations.map((c) => c.title).join(', ')}`);
  assert.ok(cited!.disputed, 'a contested page carries its standing however the question was phrased');
  assert.equal(cited!.disputed!.assertedByName, 'Marc');
  assert.match(cited!.disputed!.note, /twenty-four months/);
  assert.deepEqual(cited!.disputed!.withTitles, ['Data Retention in the Platform']);
  // And the prose says it too, for a reader who takes the words and leaves the
  // cards behind.
  assert.match(oneSided.answer!, /contested in the record/);

  // The two-sided panel is unchanged and still the stronger form.
  const bothSides = await store.ask(marc.id, { question: 'how long are claims records retained' });
  if (bothSides.disagreement) {
    assert.ok(bothSides.disagreement.pageIds.includes(schedule.id));
    assert.ok(bothSides.disagreement.pageIds.includes(platform.id));
  }
});

test('ask: a conflict with a page the asker cannot see is disclosed without naming it', async () => {
  const { db, store, dana, marc, iris, collection } = setup();
  const visible = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Retention in this collection',
    'Claims records are kept for seven years from final determination here.',
  );
  // A collection Marc holds no role in. Iris admins it and Dana writes there,
  // because the approver may not submit their own draft.
  const secret = store.createCollection(iris.id, { name: 'Restricted' });
  store.setMember(iris.id, secret.id, dana.id, 'edit');
  const hidden = publishCanonical(store, dana.id, iris.id, secret.id, 'Hidden rule', 'A different period applies.');
  store.assertRelation(iris.id, hidden.id, {
    toPageId: visible.id,
    kind: 'conflicts_with',
    note: 'These disagree about the claims period.',
  });
  assert.ok(db);

  const answer = await store.ask(marc.id, { question: 'final determination claims kept seven' });
  const cited = answer.citations.find((c) => c.pageId === visible.id);
  assert.ok(cited?.disputed, 'the page Marc can see still declares that it is contested');
  assert.deepEqual(cited!.disputed!.withTitles, [], 'the page he cannot see is not named');
  assert.equal(cited!.disputed!.someWithheld, true);
  assert.ok(!JSON.stringify(answer).includes('Hidden rule'), 'nothing discloses the withheld page');
});

// The relevance gate weighs a term by how much it distinguishes a page.
//
// It used to count them and treat them alike: half the question's content
// terms, minimum two. So "Who approves a change to a Policy?" was satisfied by
// any page carrying "change" and "policy" — two of the commonest words in a
// policy corpus — and a compliance director was handed three unrelated pages
// under "ANSWER … The record says:".
test('isOnTopic: common words do not add up to relevance', () => {
  const stats = {
    total: 300,
    // "policy" and "change" are everywhere; "indemnity" is on one page.
    df: new Map([['policy', 200], ['change', 150], ['indemnity', 1]]),
  };
  const question = 'what indemnity applies to a policy change';
  const commonOnly = 'This policy covers a change to the working week and nothing else.';
  const theRealOne = 'Indemnity under this policy is limited, and any change requires sign-off.';

  // Unweighted, the near-miss passes: two of three terms covered.
  assert.equal(isOnTopic(question, commonOnly), true, 'the old behaviour, kept as the fallback');
  // Weighted, it does not: it missed the only term that distinguishes anything.
  assert.equal(isOnTopic(question, commonOnly, stats), false);
  assert.equal(isOnTopic(question, theRealOne, stats), true);
});

test('isOnTopic: a term the record has never used counts against a match', () => {
  // Every term the gate weighs is looked up, so the map carries all three.
  // "submarine" is the one the record has never used.
  const stats = { total: 300, df: new Map([['policy', 200], ['procurement', 40], ['submarine', 0]]) };
  // A page about procurement policy must not answer a question about submarine
  // procurement: it misses the only word that made the question specific, and
  // that word carries the most weight precisely because nothing here uses it.
  assert.equal(isOnTopic('submarine procurement policy', 'This policy covers procurement.', stats), false);
  // The same page does answer the question without that word in it.
  assert.equal(isOnTopic('procurement policy', 'This policy covers procurement.', stats), true);
});

// An answer says how well grounded it is, and the extractive generator opens
// differently when it is thin. "The record says:" over one weak match and its
// graph neighbours is an assertion the evidence does not support.
test('ask: grounding is how squarely the record answers, not how many pages did', async () => {
  const question = 'who approves a learning budget request';
  const { store, marc, iris, collection } = setup();

  // A page that shares the question's subject without addressing it: over the
  // bar to anchor an answer, nowhere near answering it. Plus a neighbour that
  // rides in on the tree and answers nothing either. This is what "thin" is
  // for, and the answer says so.
  const near = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Team spending',
    'Requests for team spending are recorded against a budget line in the finance system.',
  );
  publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Booking a course',
    'Courses are booked through the supplier portal once funds are confirmed.',
    near.id,
  );

  const thin = await store.ask(marc.id, { question });
  assert.equal(thin.refused, false);
  assert.equal(thin.grounding, 'thin');
  assert.match(thin.answer!, /^Nothing in the record answers this directly/);

  // ONE page that squarely answers it is direct, on its own.
  //
  // This is the rule that changed and the reason it had to. Grounding was a
  // headcount — two anchors or it was thin — so a question answered plainly, on
  // one Canonical page, by the person who owns that subject, was reported as
  // "Nothing in the record answers this directly". A well-kept record answers a
  // question on ONE page; that is what Canonical means, and the old rule was
  // hedging exactly the record-keeping the product asks people to do. Over the
  // labelled question set it fired on fifteen of forty-one.
  publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Learning budget',
    'The team lead approves a learning budget request up to five hundred pounds.',
  );
  const direct = await store.ask(marc.id, { question });
  assert.equal(direct.grounding, 'direct');
  assert.match(direct.answer!, /^The record says:/);
});

test('ask: the page decides whether it is on topic, not the sentence chosen to quote', async () => {
  // THE BUG: the topical gate read `title + passage`, and the passage is the
  // CITATION — a short window centred on wherever the first matching term
  // landed. A page that answers the question in a later section was refused,
  // because the window chosen for quoting was somewhere else on it.
  //
  // The body below is built to reproduce exactly that: the opening is long,
  // shares the question's first term, and says nothing; the answer is at the
  // end. Seven of twelve wrongful refusals over the labelled set were this.
  const { store, marc, iris, collection } = setup();
  const question = 'when does the claims purge job run';
  // One paragraph, under a chunk in length, so there is exactly one chunk and
  // the window is its opening: several sentences of on-subject filler, and the
  // answer in the last line where the window cannot reach it.
  const filler = Array.from(
    { length: 5 },
    (_, i) => `The claims register for class ${i} is maintained by the committee and reviewed each quarter.`,
  ).join(' ');
  const page = publishCanonical(
    store, marc.id, iris.id, collection.id,
    'Retention jobs and their schedule',
    `${filler} The claims-purge job runs nightly at 02:10 UTC.`,
  );
  await store.embeddings.ready();

  // The precondition, asserted rather than assumed: the window really does miss
  // the answer. If that ever stops being true this test should say so instead
  // of passing for a reason it was not written for.
  const candidates = await store.retrieve(marc.id, { question, canonicalOnly: true });
  const candidate = candidates.find((c) => c.pageId === page.id);
  assert.ok(candidate, 'the page is retrieved');
  assert.ok(!candidate.passage.includes('02:10'), 'the quoted window falls on the filler, not on the answer');

  // And the answer comes anyway, because the PAGE is about the question.
  const answer = await store.ask(marc.id, { question });
  assert.equal(answer.refused, false, 'the page states the answer; the window merely did not contain it');
  assert.deepEqual(answer.citations.map((c) => c.pageId), [page.id]);
});
