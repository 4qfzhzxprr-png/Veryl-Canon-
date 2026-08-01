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

// USER-TESTING.md T1.3, over HTTP, in the order the auditor hit it: a page in
// review must report the approver it will accept, and a brand-new page must
// report one at all. Before this, `GET /pages/:id` answered both questions
// with `approverId` from the page row — the approver of the PUBLISHED version,
// which is null before a first publish and somebody else after a hand-over.
test('API: the approver a page in review reports is the approver the API accepts', async () => {
  const store = new CanonStore(openDb(':memory:'));
  const server = createApi(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, actor?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor-id': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
    const grace = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Grace Abara' })).json;
    const nadia = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Nadia Haddad' })).json;
    const c = (await call('POST', '/collections', dana.id, { name: 'Compliance' })).json;
    await call('PUT', `/collections/${c.id}/members/${grace.id}`, dana.id, { role: 'approve' });
    await call('PUT', `/collections/${c.id}/members/${nadia.id}`, dana.id, { role: 'approve' });

    const page = (
      await call('POST', '/pages', dana.id, { collectionId: c.id, type: 'policy', title: 'Access policy' })
    ).json;
    await call('PUT', `/pages/${page.id}/draft`, dana.id, {
      body: 'All access is logged.',
      fields: { ownerId: dana.id, approverId: grace.id, effectiveDate: '2026-01-01', reviewDate: '2099-01-01' },
    });
    await call('POST', `/pages/${page.id}/submit`, dana.id);

    // A brand-new page: nothing published, so the page row is empty of all
    // four fields — and the payload still carries them, from the draft under
    // review, rather than leaving a screen with four dashes on it.
    const first = (await call('GET', `/pages/${page.id}`, dana.id)).json;
    assert.equal(first.currentVersion, null);
    assert.equal(first.approverId, null);
    assert.equal(first.review.approverId, grace.id);
    assert.equal(first.review.fields.ownerId, dana.id);
    assert.equal(first.review.fields.effectiveDate, '2026-01-01');
    assert.equal(first.review.fields.reviewDate, '2099-01-01');
    assert.equal(first.review.submittedById, dana.id);
    // The author submitted it, so the author can take it back; the approver
    // cannot, because Send back is hers and it costs her a comment.
    assert.equal(first.review.canWithdraw, true);
    assert.equal((await call('GET', `/pages/${page.id}`, grace.id)).json.review.canWithdraw, false);

    // The name reported is the name accepted, and nobody else's.
    assert.equal((await call('POST', `/pages/${page.id}/approve`, nadia.id)).status, 403);
    assert.equal((await call('POST', `/pages/${page.id}/approve`, grace.id)).json.status, 'canonical');

    // An edit drops the mark on publish; the next revision hands the approval
    // to Nadia and goes back into review. The page row now names Grace —
    // truthfully, she approved what is published — and the pending answer
    // names Nadia.
    await call('PUT', `/pages/${page.id}/draft`, dana.id, { body: 'All access is logged and reviewed.' });
    await call('POST', `/pages/${page.id}/publish`, dana.id, {});
    await call('PUT', `/pages/${page.id}/draft`, dana.id, { fields: { approverId: nadia.id } });
    await call('POST', `/pages/${page.id}/submit`, dana.id);
    const second = (await call('GET', `/pages/${page.id}`, dana.id)).json;
    assert.equal(second.approverId, grace.id); // history, and still historical
    assert.equal(second.review.approverId, nadia.id);
    assert.equal((await call('POST', `/pages/${page.id}/approve`, grace.id)).status, 403);

    // The author changes their mind instead (T4.5). The page comes back to
    // Draft, the editor unlocks, and the withdrawal is on the audit record.
    const withdrawn = (await call('POST', `/pages/${page.id}/withdraw`, dana.id, { reason: 'One more pass' })).json;
    assert.equal(withdrawn.status, 'draft');
    assert.equal((await call('GET', `/pages/${page.id}`, dana.id)).json.review, null);
    assert.equal((await call('PUT', `/pages/${page.id}/draft`, dana.id, { body: 'Revised.' })).status, 200);
    const audit = (await call('GET', '/audit?action=page.withdraw', dana.id)).json;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorId, dana.id);
    assert.equal(audit[0].details.reason, 'One more pass');

    // And the invariant as a screen applies it: take whoever this payload
    // names as the approver of a page in review, and press Approve as them.
    // Against the code this test was written for, the payload's only answer
    // was `approverId` from the page row — Grace — and this call was the 403
    // the auditor hit. The named person is the accepted person, or this fails.
    await call('POST', `/pages/${page.id}/submit`, dana.id);
    const pending = (await call('GET', `/pages/${page.id}`, dana.id)).json;
    const named = pending.review ? pending.review.approverId : pending.approverId;
    assert.equal((await call('POST', `/pages/${page.id}/approve`, named)).json.status, 'canonical');
  } finally {
    server.close();
  }
});
