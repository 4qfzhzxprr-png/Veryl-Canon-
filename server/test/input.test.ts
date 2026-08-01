import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { RateLimiter } from '../src/ratelimit.js';
import { CanonStore } from '../src/store.js';

// Malformed input is a 400 that names the field, never a 500 and never a
// silent wrong answer. Every case below was found by an integrator driving the
// real API rather than by a test: three of them crashed the request handler,
// and the fourth — a numeric `collectionId` — did something worse, answering
// "the record is silent on this" for a filter that could never match. See
// input.ts.

async function rig() {
  const store = new CanonStore(openDb(':memory:'), { deliver() {} });
  // A limiter with the ask bucket switched off: this file sends more malformed
  // asks in one test than a person sends questions in a minute, and the point
  // under test is the 400, not the 429.
  const server = createApi(store, null, new RateLimiter({}));
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
  const dana = (await call('POST', '/actors', undefined, { kind: 'person', name: 'Dana' })).json;
  const collection = (await call('POST', '/collections', dana.id, { name: 'Compliance' })).json;
  return { server, call, dana, collection };
}

test('input: a wrongly typed ask field is refused by name, not answered and not crashed', async () => {
  const { server, call, dana, collection } = await rig();
  try {
    for (const [body, field] of [
      [{ question: 42 }, 'question'],
      [{ question: { $ne: null } }, 'question'],
      [{ question: ['a', 'b'] }, 'question'],
      [{ question: 'ok', collectionId: 12 }, 'collectionId'],
      [{ question: 'ok', collectionId: [collection.id] }, 'collectionId'],
      [{ question: 'ok', collectionIds: 'not-an-array' }, 'collectionIds'],
      [{ question: 'ok', collectionIds: [collection.id, 7] }, 'collectionIds[1]'],
      [{ question: 'ok', limit: 'ten' }, 'limit'],
      [{ question: 'ok', limit: 0 }, 'limit'],
      [{ question: 'ok', limit: 2.5 }, 'limit'],
      [{ question: 'ok', alsoVisibleTo: true }, 'alsoVisibleTo'],
    ] as [unknown, string][]) {
      const res = await call('POST', '/ask', dana.id, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be a 400, was ${res.status}`);
      assert.equal(res.json.error, 'invalid');
      assert.equal(res.json.field, field);
    }

    // Absent, null and blank all still mean "no question was asked", which is
    // its own sentence and not a type complaint.
    for (const body of [{}, { question: null }, { question: '   ' }]) {
      const res = await call('POST', '/ask', dana.id, body);
      assert.equal(res.status, 400);
      assert.match(res.json.message, /requires a question/);
    }
  } finally {
    server.close();
  }
});

test('input: a body that is not a JSON object is refused', async () => {
  const { server, call, dana } = await rig();
  try {
    for (const body of [42, 'hello', ['a'], true]) {
      const res = await call('POST', '/ask', dana.id, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be a 400, was ${res.status}`);
      assert.match(res.json.message, /must be a JSON object/);
    }
    // `null` is the one JSON scalar that reads as "nothing was sent", and an
    // empty body already means that, so it is treated the same way.
    const empty = await call('POST', '/ask', dana.id, null);
    assert.equal(empty.status, 400);
    assert.match(empty.json.message, /requires a question/);
  } finally {
    server.close();
  }
});

test('input: a limit in the query string is a number or a refusal, never NaN', async () => {
  const { server, call, dana } = await rig();
  try {
    for (const path of ['/audit?limit=abc', '/audit?limit=-1', '/audit?limit=1.5', '/search?q=x&limit=abc']) {
      const res = await call('GET', path, dana.id);
      assert.equal(res.status, 400, `${path} should be a 400, was ${res.status}`);
      assert.equal(res.json.error, 'invalid');
    }
    // An absent or empty limit is not a mistake; it means "the default".
    assert.equal((await call('GET', '/audit', dana.id)).status, 200);
    assert.equal((await call('GET', '/audit?limit=', dana.id)).status, 200);
    assert.equal((await call('GET', '/audit?limit=5', dana.id)).status, 200);
  } finally {
    server.close();
  }
});
