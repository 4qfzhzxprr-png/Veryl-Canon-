import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import { CanonStore } from '../src/store.js';
import type { NotificationTransport } from '../src/notify.js';
import { ConnectorRegistry, ResolveRequest, staticConnectorOf } from '../src/connectors.js';

// Federation (DATA-BACKBONE.md §6): sources, reference fields, resolution.
// Everything here runs through the hermetic static connector, so the suite
// makes no external call — the same bargain the local embedding provider makes.

const quiet: NotificationTransport = { deliver() {} };

function setup() {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const vera = store.createActor({ kind: 'person', name: 'Vera', email: 'vera@example.com' });
  const outsider = store.createActor({ kind: 'person', name: 'Outsider' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, vera.id, 'view');
  return { store, dana, marc, vera, outsider, collection };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

async function expectCodeAsync(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

// A source that answers from a fixture set, plus the plumbing for a page that
// references it. `freshnessWindowMs` is per source, never a global default.
function federated(
  store: CanonStore,
  opts: {
    admin: string;
    editor: string;
    collectionId: string;
    authMode?: 'service' | 'per_asker';
    freshnessWindowMs?: number;
    fixtures: Record<string, Record<string, unknown>>;
    selector?: string;
    key?: string;
    kind?: string;
  },
) {
  staticConnectorOf(store.connectors).define('benefits', opts.fixtures);
  const source = store.createSource(opts.admin, {
    name: 'Benefits Admin',
    kind: opts.kind ?? 'static',
    baseUrl: 'static:benefits',
    authMode: opts.authMode ?? 'service',
    freshnessWindowMs: opts.freshnessWindowMs ?? 60_000,
    collectionIds: [opts.collectionId],
  });
  const page = store.createPage(opts.editor, {
    collectionId: opts.collectionId,
    type: 'policy',
    title: 'Benefits policy',
  });
  const reference = store.addReference(opts.editor, page.id, {
    sourceId: source.id,
    selector: opts.selector ?? 'deductible',
    key: opts.key ?? 'PLAN-7',
    label: 'Plan deductible',
  });
  return { source, page, reference };
}

// ---- sources ----------------------------------------------------------

test('sources: registering one requires admin on the collections it is scoped to', () => {
  const { store, dana, marc, collection } = setup();

  // edit is not enough: a source changes what the record can reach.
  expectCode(
    () =>
      store.createSource(marc.id, {
        name: 'Benefits Admin',
        kind: 'static',
        baseUrl: 'static:benefits',
        authMode: 'service',
        freshnessWindowMs: 60_000,
        collectionIds: [collection.id],
      }),
    'forbidden',
  );

  const source = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 300_000,
    collectionIds: [collection.id],
  });
  assert.equal(source.name, 'Benefits Admin');
  assert.equal(source.authMode, 'service');
  assert.equal(source.freshnessWindowMs, 300_000);
  assert.deepEqual(source.collectionIds, [collection.id]);
  assert.equal(source.createdBy, dana.id);
  // Canon stores no secret material for a source: there is no credential to carry.
  assert.equal((source as unknown as Record<string, unknown>).credential, undefined);

  const events = store.queryAudit(dana.id, { action: 'source.create' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorId, dana.id);
  assert.equal(events[0]!.details.sourceId, source.id);
  assert.equal(events[0]!.details.authMode, 'service');
  assert.deepEqual(events[0]!.details.collectionIds, [collection.id]);
});

test('sources: a Canon-wide source (no scope) requires admin somewhere', () => {
  const { store, dana, vera } = setup();
  const input = {
    name: 'HRIS',
    kind: 'static',
    baseUrl: 'static:hris',
    authMode: 'per_asker' as const,
    freshnessWindowMs: 1000,
  };
  // Vera holds view on one collection and admin on none.
  expectCode(() => store.createSource(vera.id, input), 'forbidden');

  const source = store.createSource(dana.id, input);
  assert.deepEqual(source.collectionIds, []); // empty scope = referenceable Canon-wide
  assert.equal(store.getSource(vera.id, source.id).id, source.id); // and visible to any actor
});

test('sources: validation refuses a bad mode, a missing freshness window, and an unknown collection', () => {
  const { store, dana, collection } = setup();
  const base = {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service' as const,
    freshnessWindowMs: 1000,
    collectionIds: [collection.id],
  };
  expectCode(() => store.createSource(dana.id, { ...base, name: '  ' }), 'invalid');
  expectCode(() => store.createSource(dana.id, { ...base, kind: '' }), 'invalid');
  expectCode(() => store.createSource(dana.id, { ...base, authMode: 'shared' as never }), 'invalid');
  // Never one global default: the window is stated per source.
  expectCode(() => store.createSource(dana.id, { ...base, freshnessWindowMs: undefined as never }), 'invalid');
  expectCode(() => store.createSource(dana.id, { ...base, freshnessWindowMs: -1 }), 'invalid');
  expectCode(() => store.createSource(dana.id, { ...base, collectionIds: ['no-such-collection'] }), 'not_found');
  expectCode(() => store.getSource(dana.id, 'no-such-source'), 'not_found');
});

test('sources: update and delete are admin-gated and audited; delete refuses while pages reference it', () => {
  const { store, dana, marc, collection } = setup();
  const { source, reference } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    fixtures: { deductible: { 'PLAN-7': 1500 } },
  });

  expectCode(() => store.updateSource(marc.id, source.id, { freshnessWindowMs: 10 }), 'forbidden');
  const updated = store.updateSource(dana.id, source.id, { name: 'Benefits Administrator', freshnessWindowMs: 10 });
  assert.equal(updated.name, 'Benefits Administrator');
  assert.equal(updated.freshnessWindowMs, 10);
  const updates = store.queryAudit(dana.id, { action: 'source.update' });
  assert.equal(updates.length, 1);
  assert.deepEqual(new Set(updates[0]!.details.changed as string[]), new Set(['name', 'freshnessWindowMs']));

  expectCode(() => store.deleteSource(marc.id, source.id), 'forbidden');
  expectCode(() => store.deleteSource(dana.id, source.id), 'conflict'); // still referenced

  store.removeReference(marc.id, reference.id);
  store.deleteSource(dana.id, source.id);
  expectCode(() => store.getSource(dana.id, source.id), 'not_found');
  const deletes = store.queryAudit(dana.id, { action: 'source.delete' });
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.details.sourceId, source.id);
});

test('sources: a scoped source is listed and visible only to members of its collections', () => {
  const { store, dana, vera, outsider, collection } = setup();
  const scoped = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 1000,
    collectionIds: [collection.id],
  });
  const canonWide = store.createSource(dana.id, {
    name: 'HRIS',
    kind: 'static',
    baseUrl: 'static:hris',
    authMode: 'service',
    freshnessWindowMs: 1000,
  });

  assert.deepEqual(new Set(store.listSources(vera.id).map((s) => s.id)), new Set([scoped.id, canonWide.id]));
  assert.deepEqual(store.listSources(outsider.id).map((s) => s.id), [canonWide.id]);
  expectCode(() => store.getSource(outsider.id, scoped.id), 'forbidden');
});

test('references: adding one requires edit, and the source must be in scope for the page', () => {
  const { store, dana, marc, vera, collection } = setup();
  const other = store.createCollection(dana.id, { name: 'Engineering' });
  staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': 1500 } });
  const source = store.createSource(dana.id, {
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits',
    authMode: 'service',
    freshnessWindowMs: 1000,
    collectionIds: [collection.id],
  });
  const page = store.createPage(marc.id, { collectionId: collection.id, type: 'policy', title: 'Benefits' });
  const elsewhere = store.createPage(dana.id, { collectionId: other.id, type: 'spec', title: 'Elsewhere' });

  expectCode(() => store.addReference(vera.id, page.id, { sourceId: source.id, selector: 'd', key: 'k' }), 'forbidden');
  expectCode(
    () => store.addReference(dana.id, elsewhere.id, { sourceId: source.id, selector: 'd', key: 'k' }),
    'forbidden',
  );
  expectCode(() => store.addReference(marc.id, page.id, { sourceId: source.id, selector: ' ', key: 'k' }), 'invalid');
  expectCode(() => store.addReference(marc.id, page.id, { sourceId: 'nope', selector: 'd', key: 'k' }), 'not_found');

  const reference = store.addReference(marc.id, page.id, {
    sourceId: source.id,
    selector: 'deductible',
    key: 'PLAN-7',
    label: 'Plan deductible',
  });
  // The descriptor is data on the page, never parsed from its body.
  assert.deepEqual(store.listReferences(vera.id, page.id), [reference]);
  assert.equal(reference.sourceName, 'Benefits Admin');
  assert.equal(reference.authMode, 'service');
  assert.equal(reference.key, 'PLAN-7');
  // The same reference twice is a conflict, not a duplicate row.
  expectCode(
    () => store.addReference(marc.id, page.id, { sourceId: source.id, selector: 'deductible', key: 'PLAN-7' }),
    'conflict',
  );

  const added = store.queryAudit(marc.id, { action: 'reference.add' });
  assert.equal(added.length, 1);
  assert.equal(added[0]!.pageId, page.id);
  assert.equal(added[0]!.details.selector, 'deductible');
});

// ---- resolution -------------------------------------------------------

test('references: a value resolves through the hermetic connector, timestamped and not stale', async () => {
  const { store, dana, marc, collection } = setup();
  const { source, page, reference } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    fixtures: { deductible: { 'PLAN-7': 1500 } },
  });

  const resolved = await store.resolveReferences(dana.id, page.id);
  assert.equal(resolved.length, 1);
  const first = resolved[0]!;
  assert.equal(first.referenceId, reference.id);
  assert.equal(first.value, 1500);
  assert.equal(first.sourceId, source.id);
  assert.equal(first.sourceName, 'Benefits Admin');
  assert.equal(first.selector, 'deductible');
  assert.equal(first.key, 'PLAN-7');
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(first.error, undefined);
  assert.ok(first.resolvedAt && !Number.isNaN(Date.parse(first.resolvedAt)));
});

test('references: inside the freshness window the cache answers and the source is never asked', async () => {
  const { store, dana, marc, collection } = setup();
  let calls = 0;
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    freshnessWindowMs: 60_000,
    fixtures: {
      deductible: {
        'PLAN-7': () => {
          calls += 1;
          return 1500;
        },
      },
    },
  });

  const first = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(calls, 1);
  assert.equal(first.fromCache, false);

  const second = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(calls, 1); // still one: the window had not passed
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(second.value, 1500);
  assert.equal(second.resolvedAt, first.resolvedAt); // the fetch time, not the read time
});

test('references: past the window the source is asked again; when it is down the cached value comes back stale', async () => {
  const { store, dana, marc, collection } = setup();
  let calls = 0;
  const fixtures = staticConnectorOf(store.connectors);
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    freshnessWindowMs: 0, // always ask the source
    fixtures: {
      deductible: {
        'PLAN-7': () => {
          calls += 1;
          return 1500;
        },
      },
    },
  });

  const first = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(first.value, 1500);
  assert.equal(first.fromCache, false);

  // Past the window, the source is asked again rather than the cache trusted.
  const second = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(calls, 2);
  assert.equal(second.fromCache, false);
  assert.equal(second.stale, false);

  // Now the source is down. The page still renders: the last value comes back
  // labelled, timestamped, marked stale, and carrying the reason.
  fixtures.define('benefits', {
    deductible: {
      'PLAN-7': () => {
        throw new Error('benefits admin is down');
      },
    },
  });
  const third = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(third.value, 1500);
  assert.equal(third.fromCache, true);
  assert.equal(third.stale, true);
  assert.match(third.error ?? '', /benefits admin is down/);
  assert.equal(third.resolvedAt, second.resolvedAt); // the time it was last true

  const events = store.queryAudit(dana.id, { action: 'reference.resolve' });
  assert.equal(events.length, 3);
  assert.equal(events[0]!.details.stale, true); // newest first
  assert.equal(events[0]!.details.origin, 'cache');
  assert.match(String(events[0]!.details.error), /down/);
});

test('references: a failure with nothing cached returns an error and no value — never a guess', async () => {
  const { store, dana, marc, collection } = setup();
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    fixtures: { deductible: {} }, // the source knows nothing about this key
  });

  const only = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(only.value, null);
  assert.equal(only.resolvedAt, null);
  assert.equal(only.fromCache, false);
  assert.match(only.error ?? '', /no value for deductible\/PLAN-7/);

  const events = store.queryAudit(dana.id, { action: 'reference.resolve' });
  assert.equal(events[0]!.details.origin, 'none');
  assert.match(String(events[0]!.details.error), /no value/);
});

test('references: a source kind with no connector fails visibly rather than silently', async () => {
  const { store, dana, marc, collection } = setup();
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    kind: 'benefits-admin-v1', // nothing registers this kind
    fixtures: { deductible: { 'PLAN-7': 1500 } },
  });

  const only = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(only.value, null);
  assert.match(only.error ?? '', /No connector is registered for source kind 'benefits-admin-v1'/);
});

test('references: resolution requires view on the page collection before anything is asked', async () => {
  const { store, dana, marc, outsider, collection } = setup();
  let calls = 0;
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    fixtures: {
      deductible: {
        'PLAN-7': () => {
          calls += 1;
          return 1500;
        },
      },
    },
  });

  await expectCodeAsync(store.resolveReferences(outsider.id, page.id), 'forbidden');
  expectCode(() => store.listReferences(outsider.id, page.id), 'forbidden');
  assert.equal(calls, 0); // the source was never asked on their behalf
  await expectCodeAsync(store.resolveReferences(dana.id, 'no-such-page'), 'not_found');
});

test('references: a service source resolves once and its value is visible to everyone who can view', async () => {
  const { store, dana, marc, vera, collection } = setup();
  let calls = 0;
  const askers: (string | null)[] = [];
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    authMode: 'service',
    freshnessWindowMs: 60_000,
    fixtures: {
      deductible: {
        'PLAN-7': (request: ResolveRequest) => {
          calls += 1;
          askers.push(request.asker === null ? null : request.asker.actorId);
          return 1500;
        },
      },
    },
  });

  const mine = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(mine.value, 1500);
  assert.equal(mine.authMode, 'service');
  // Vera, holding only view, sees the same value: an administrator choosing
  // service mode is choosing to publish it to the collection.
  const theirs = (await store.resolveReferences(vera.id, page.id))[0]!;
  assert.equal(theirs.value, 1500);
  assert.equal(theirs.fromCache, true);
  assert.equal(calls, 1); // resolved once, for the collection
  assert.deepEqual(askers, [null]); // no asker travels to a service source
});

test('references: a per_asker source carries the asker through, and caches per asker', async () => {
  const { store, dana, marc, vera, collection } = setup();
  const seen: string[] = [];
  const { page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    authMode: 'per_asker',
    freshnessWindowMs: 60_000,
    fixtures: {
      deductible: {
        'PLAN-7': (request: ResolveRequest) => {
          assert.ok(request.asker, 'a per_asker source must be given the asker');
          seen.push(request.asker.actorId);
          return `${request.asker.name}: 1500`;
        },
      },
    },
  });

  const mine = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(mine.value, 'Dana: 1500');
  assert.equal(mine.authMode, 'per_asker');
  assert.equal(mine.fromCache, false);

  // Vera's resolution asks the source again with HER identity: a per-asker
  // value is never served out of another actor's cache entry.
  const theirs = (await store.resolveReferences(vera.id, page.id))[0]!;
  assert.equal(theirs.value, 'Vera: 1500');
  assert.equal(theirs.fromCache, false);
  assert.deepEqual(seen, [dana.id, vera.id]);

  // Dana's own second read is a cache hit, and still Dana's value.
  const again = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(again.value, 'Dana: 1500');
  assert.equal(again.fromCache, true);
  assert.deepEqual(seen, [dana.id, vera.id]);
});

test('references: every resolution is an audit event naming actor, source, page, selector and origin', async () => {
  const { store, dana, marc, collection } = setup();
  const { source, page, reference } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    freshnessWindowMs: 60_000,
    fixtures: { deductible: { 'PLAN-7': 1500 } },
  });

  await store.resolveReferences(dana.id, page.id);
  await store.resolveReferences(dana.id, page.id);

  const events = store.queryAudit(dana.id, { action: 'reference.resolve' });
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.actorId, dana.id);
    assert.equal(event.actorKind, 'person');
    assert.equal(event.pageId, page.id);
    assert.equal(event.collectionId, collection.id);
    assert.equal(event.details.referenceId, reference.id);
    assert.equal(event.details.sourceId, source.id);
    assert.equal(event.details.sourceName, 'Benefits Admin');
    assert.equal(event.details.selector, 'deductible');
    assert.equal(event.details.key, 'PLAN-7');
    assert.equal(event.details.authMode, 'service');
  }
  // Newest first: the second read came from the cache, the first from the source.
  assert.equal(events[0]!.details.origin, 'cache');
  assert.equal(events[0]!.details.fromCache, true);
  assert.equal(events[1]!.details.origin, 'source');
  assert.equal(events[1]!.details.fromCache, false);
});

test('references: a source removed from the collection stops resolving there, visibly', async () => {
  const { store, dana, marc, collection } = setup();
  const other = store.createCollection(dana.id, { name: 'Engineering' });
  const { source, page } = federated(store, {
    admin: dana.id,
    editor: marc.id,
    collectionId: collection.id,
    fixtures: { deductible: { 'PLAN-7': 1500 } },
  });
  await store.resolveReferences(dana.id, page.id);

  store.updateSource(dana.id, source.id, { collectionIds: [other.id] });
  const after = (await store.resolveReferences(dana.id, page.id))[0]!;
  assert.equal(after.value, null); // not the cached value, and not a guess
  assert.match(after.error ?? '', /no longer permitted in this collection/);
});

test('connectors: the registry keys on source kind, and an agent asker keeps its Registry reference', async () => {
  const registry = new ConnectorRegistry();
  assert.deepEqual(registry.kinds(), []);
  assert.equal(registry.has('static'), false);
  expectCode(() => registry.get('static'), 'unavailable');

  const store = new CanonStore(openDb(':memory:'), quiet); // default registry: static only
  assert.deepEqual(store.connectors.kinds(), ['static']);

  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  const agent = store.createActor({ kind: 'agent', name: 'Benefits Agent', registryRef: 'passport:ben-1' });
  const collection = store.createCollection(dana.id, { name: 'Benefits' });
  store.setMember(dana.id, collection.id, agent.id, 'view');

  const askers: { name: string; kind: string; registryRef: string | null }[] = [];
  const { page } = federated(store, {
    admin: dana.id,
    editor: dana.id,
    collectionId: collection.id,
    authMode: 'per_asker',
    fixtures: {
      deductible: {
        'PLAN-7': (request: ResolveRequest) => {
          askers.push({
            name: request.asker!.name,
            kind: request.asker!.kind,
            registryRef: request.asker!.registryRef,
          });
          return 1500;
        },
      },
    },
  });

  const resolved = (await store.resolveReferences(agent.id, page.id))[0]!;
  assert.equal(resolved.value, 1500);
  assert.deepEqual(askers, [{ name: 'Benefits Agent', kind: 'agent', registryRef: 'passport:ben-1' }]);
  const events = store.queryAudit(dana.id, { action: 'reference.resolve' });
  assert.equal(events[0]!.actorKind, 'agent'); // agent activity is agent-marked in the log
});

test('API smoke: sources and references over HTTP, with references inside the page payload', async () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  staticConnectorOf(store.connectors).define('benefits', { deductible: { 'PLAN-7': 1500 } });
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
    const marc = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Marc' })).json;
    const c = (await call('POST', '/collections', dana.id, { name: 'Benefits' })).json;
    await call('PUT', `/collections/${c.id}/members/${marc.id}`, dana.id, { role: 'edit' });

    const denied = await call('POST', '/sources', marc.id, {
      name: 'Benefits Admin',
      kind: 'static',
      baseUrl: 'static:benefits',
      authMode: 'service',
      freshnessWindowMs: 60000,
      collectionIds: [c.id],
    });
    assert.equal(denied.status, 403); // edit is not admin

    const created = await call('POST', '/sources', dana.id, {
      name: 'Benefits Admin',
      kind: 'static',
      baseUrl: 'static:benefits',
      authMode: 'service',
      freshnessWindowMs: 60000,
      collectionIds: [c.id],
    });
    assert.equal(created.status, 200);
    const source = created.json;
    assert.equal(source.authMode, 'service');
    assert.equal(source.credential, undefined);

    assert.deepEqual((await call('GET', '/sources', marc.id)).json.map((s: any) => s.id), [source.id]);
    assert.equal((await call('GET', `/sources/${source.id}`, marc.id)).json.name, 'Benefits Admin');

    const updated = await call('PUT', `/sources/${source.id}`, dana.id, { freshnessWindowMs: 120000 });
    assert.equal(updated.json.freshnessWindowMs, 120000);

    const page = (await call('POST', '/pages', marc.id, { collectionId: c.id, type: 'policy', title: 'Benefits' }))
      .json;
    const reference = (
      await call('POST', `/pages/${page.id}/references`, marc.id, {
        sourceId: source.id,
        selector: 'deductible',
        key: 'PLAN-7',
        label: 'Plan deductible',
      })
    ).json;
    assert.equal(reference.sourceName, 'Benefits Admin');

    // The page payload carries the unresolved descriptors, so the UI renders
    // the page without a second call and without reaching outside Canon.
    const fetched = (await call('GET', `/pages/${page.id}`, marc.id)).json;
    assert.equal(fetched.references.length, 1);
    assert.equal(fetched.references[0].key, 'PLAN-7');
    assert.equal(fetched.references[0].value, undefined); // unresolved by design

    const resolved = (await call('GET', `/pages/${page.id}/references`, marc.id)).json;
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].value, 1500);
    assert.equal(resolved[0].fromCache, false);
    assert.equal(resolved[0].stale, false);
    assert.equal(resolved[0].sourceName, 'Benefits Admin');
    assert.ok(resolved[0].resolvedAt);

    const cached = (await call('GET', `/pages/${page.id}/references`, dana.id)).json;
    assert.equal(cached[0].fromCache, true); // service-resolved: one value for the collection

    const audit = (await call('GET', '/audit?action=reference.resolve', dana.id)).json;
    assert.equal(audit.length, 2);
    assert.equal(audit[0].pageId, page.id);

    assert.equal((await call('DELETE', `/sources/${source.id}`, dana.id)).status, 409); // still referenced
    assert.equal((await call('DELETE', `/references/${reference.id}`, marc.id)).status, 200);
    assert.equal((await call('DELETE', `/sources/${source.id}`, dana.id)).status, 200);
    assert.equal((await call('GET', `/sources/${source.id}`, dana.id)).status, 404);
  } finally {
    server.close();
  }
});
