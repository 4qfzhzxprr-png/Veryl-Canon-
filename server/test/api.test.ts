import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';

test('API smoke: a policy travels draft -> in review -> canonical over HTTP', async () => {
  const store = new CanonStore(openDb(':memory:'));
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
    const health = await call('GET', '/health');
    assert.equal(health.json.product, 'Veryl Canon');

    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const iris = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Iris' })).json;

    const unauthenticated = await call('GET', '/collections');
    assert.equal(unauthenticated.status, 401);

    const c = (await call('POST', '/collections', dana.id, { name: 'Compliance', restricted: true })).json;
    await call('PUT', `/collections/${c.id}/members/${iris.id}`, dana.id, { role: 'approve' });

    const page = (
      await call('POST', '/pages', dana.id, { collectionId: c.id, type: 'policy', title: 'Access policy' })
    ).json;
    await call('PUT', `/pages/${page.id}/draft`, dana.id, {
      body: 'All access is logged.',
      fields: { ownerId: dana.id, approverId: iris.id, reviewDate: '2099-01-01' },
    });

    const submitted = (await call('POST', `/pages/${page.id}/submit`, dana.id)).json;
    assert.equal(submitted.status, 'in_review');

    const denied = await call('POST', `/pages/${page.id}/approve`, dana.id);
    assert.equal(denied.status, 403);

    const canonical = (await call('POST', `/pages/${page.id}/approve`, iris.id)).json;
    assert.equal(canonical.status, 'canonical');

    const fetched = (await call('GET', `/pages/${page.id}`, dana.id)).json;
    assert.equal(fetched.current.body, 'All access is logged.');

    const audit = (await call('GET', `/audit?action=page.approve`, dana.id)).json;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorId, iris.id);
  } finally {
    server.close();
  }
});
