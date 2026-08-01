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
  detectDisagreement,
  extractiveGenerator,
  type AnswerGenerator,
  type AnswerPassage,
} from '../src/answers.js';
import type { RetrievalService } from '../src/retrieval.js';

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
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01' } });
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
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01' },
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
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01' },
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
      await call('PUT', `/pages/${page.id}/draft`, dana.id, { body, fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2099-01-01' } });
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
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId, reviewDate } });
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
