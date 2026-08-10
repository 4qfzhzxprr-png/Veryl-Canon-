// The record the proof drives.
//
// Small on purpose. `scripts/seed-demo.ts` builds several hundred pages, five
// collections and a run of imports, which is the right corpus for a screenshot
// and the wrong one for a proof: every assertion here has to name the thing it
// is about, and a page chosen by a seeded PRNG cannot be named. So this is
// twelve pages, written to be exactly the situations Canon's defects have
// actually lived in.
//
// Everyone here is invented, exactly as the demo seeder's people are.
//
//   Dana    — administers both collections. Sees everything.
//   Iris    — approves in Operations: the queue has work for her.
//   Marc    — edits in Operations. His draft is waiting on Iris.
//   Vera    — VIEW in Operations and nothing at all in Compliance. She is the
//             reader the refusal walls and the withheld disclosures are for.
//   Quinn   — VIEW in Operations and nothing else, ever. Nobody asks her for
//             anything and she asks for nothing, so her queue is the empty one
//             — kept apart from Vera's because Vera ASKS for access in this
//             proof, and a queue that empties depending on which test ran
//             first is a flake waiting to happen.
//
// Two collections, because the interesting cases cross one: a supersession
// whose replacement is in Compliance is withheld from Vera, and a supersession
// inside Operations is not.

const TODAY = new Date().toISOString().slice(0, 10);

/** A published Note: no owner, no approver, and never Canonical. */
function note(store, actorId, collectionId, title, body) {
  const page = store.createPage(actorId, { collectionId, type: 'note', title });
  store.editDraft(actorId, page.id, { body });
  store.publish(actorId, page.id, {});
  return page.id;
}

/** A Policy taken all the way to Canonical — what Ask may draw on. */
function canonical(store, editorId, approverId, collectionId, title, body) {
  const page = store.createPage(editorId, { collectionId, type: 'policy', title });
  store.editDraft(editorId, page.id, {
    body,
    fields: { ownerId: editorId, approverId, reviewDate: '2099-01-01', effectiveDate: TODAY },
  });
  store.submitForReview(editorId, page.id);
  store.approve(approverId, page.id);
  return page.id;
}

export function buildRecord(store, { serverDir }) {
  const dana = store.createActor({ kind: 'person', name: 'Dana Whitfield', email: 'dana@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris Bell', email: 'iris@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc Oyelaran', email: 'marc@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera Lindqvist', email: 'vera@example.com' });
  const quinn = store.createActor({ kind: 'person', name: 'Quinn Adeyemi', email: 'quinn@example.com' });

  const operations = store.createCollection(dana.id, { name: 'Operations' });
  const compliance = store.createCollection(dana.id, { name: 'Compliance' });
  store.setMember(dana.id, operations.id, iris.id, 'approve');
  store.setMember(dana.id, operations.id, marc.id, 'edit');
  store.setMember(dana.id, operations.id, vera.id, 'view');
  store.setMember(dana.id, operations.id, quinn.id, 'view');
  store.setMember(dana.id, compliance.id, iris.id, 'approve');

  // The record's official answer, and something plainly not official beside
  // it, so a status chip has something to be different from.
  const incidentPolicy = canonical(
    store,
    marc.id,
    iris.id,
    operations.id,
    'Incident escalation policy',
    'An incident is escalated to the duty manager within fifteen minutes of detection.',
  );
  const printerNote = note(
    store,
    marc.id,
    operations.id,
    'Badge printer instructions',
    'The badge printer is on the second floor. Load the blue stock.',
  );

  // 1.6, the whole point of the other half of this branch: a page the record
  // has moved on from, reached through search and through the contents table.
  const runbook = note(
    store,
    marc.id,
    operations.id,
    'On-call runbook',
    'Who to call at night, and in what order. Superseded by the escalation policy.',
  );
  store.assertRelation(dana.id, incidentPolicy, { toPageId: runbook, kind: 'supersedes' });

  // And the same fact where the replacement is a page Vera cannot open:
  // existence is disclosed, identity is not.
  const kestrel = canonical(
    store,
    dana.id,
    iris.id,
    compliance.id,
    'Kestrel incident protocol',
    'The protocol for a Kestrel-class incident, and who may declare one.',
  );
  const oldKestrel = note(
    store,
    marc.id,
    operations.id,
    'Severe incident notes',
    'Working notes on severe incidents, kept while the protocol was written.',
  );
  store.assertRelation(dana.id, kestrel, { toPageId: oldKestrel, kind: 'supersedes' });

  // Iris's queue: a draft in review, named to her.
  const inReview = store.createPage(marc.id, {
    collectionId: operations.id,
    type: 'spec',
    title: 'Paging rota specification',
  });
  store.editDraft(marc.id, inReview.id, {
    body: 'The rota rotates weekly at 09:00 on Monday.',
    fields: { ownerId: marc.id, approverId: iris.id, reviewDate: '2099-01-01' },
  });
  store.submitForReview(marc.id, inReview.id);

  // A contradiction asserted against a page Dana owns, so the queue's
  // "Contradicted" strand has something in it.
  const contested = canonical(
    store,
    dana.id,
    iris.id,
    operations.id,
    'Retention schedule',
    'Operational records are kept for seven years and then destroyed.',
  );
  const contradicts = note(
    store,
    marc.id,
    operations.id,
    'Storage cleanup plan',
    'Operational records are cleared from storage after twenty-four months.',
  );
  store.assertRelation(marc.id, contradicts, {
    toPageId: contested,
    kind: 'conflicts_with',
    note: 'The schedule keeps records for seven years; this plan clears them at twenty-four months.',
  });

  // An import run, so the import screens have a real run to draw — the same
  // Confluence export fixture the server suite imports.
  const importRun = store.runImport(dana.id, {
    source: 'confluence',
    path: `${serverDir}/test/fixtures/confluence-space`,
    collectionId: operations.id,
  });

  return {
    actors: {
      dana: { id: dana.id, name: dana.name, kind: 'person' },
      iris: { id: iris.id, name: iris.name, kind: 'person' },
      marc: { id: marc.id, name: marc.name, kind: 'person' },
      vera: { id: vera.id, name: vera.name, kind: 'person' },
      quinn: { id: quinn.id, name: quinn.name, kind: 'person' },
    },
    collections: { operations: operations.id, compliance: compliance.id },
    pages: {
      incidentPolicy,
      printerNote,
      runbook,
      kestrel,
      oldKestrel,
      inReview: inReview.id,
      contested,
      contradicts,
    },
    importRunId: importRun.runId,
  };
}
