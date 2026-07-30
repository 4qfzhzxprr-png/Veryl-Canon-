import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import { extractiveGenerator } from '../src/answers.js';

function setup() {
  const store = new CanonStore(openDb(':memory:'), { deliver() {} });
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  return { store, dana, marc, iris, collection };
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
  store.editDraft(editorId, page.id, { body, fields: { ownerId: editorId, approverId } });
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
    fields: { ownerId: marc.id, approverId: iris.id },
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
    fields: { ownerId: marc.id, approverId: iris.id },
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
  const byAgent = store.queryAudit(marc.id, { action: 'answer.ask', actorId: agent.id });
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
      await call('PUT', `/pages/${page.id}/draft`, dana.id, { body, fields: { ownerId: dana.id, approverId: iris.id } });
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
    assert.deepEqual(Object.keys(answered.json.citations[0]).sort(), ['pageId', 'snippet', 'title', 'version']);
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
