// R9: revocation parity for people (server/src/auth.ts `confirm`).
//
// SECURITY.md R9 read: "The agent door re-asks the Registry at least once a
// minute, which is what makes 'revoking an agent cuts its access within a
// minute' true. The people door does not." It does now, and these tests are the
// people-facing twin of `agentauth.test.ts`'s "revocation in the Registry cuts
// access well inside the one-minute guarantee".
//
// Everything runs against the real idp-stub, which really does refuse a
// disabled person's refresh token — the refusal is not simulated at Canon's
// side of the wire.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON_REVOCATION_GUARANTEE_MS, PersonAuth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { CanonStore } from '../src/store.js';
import { authRig, Jar, SESSION_COOKIE } from './authrig.js';

// ---------------------------------------------------------------------------
// The window

test('confirm: the window is clamped to the guarantee, exactly as the Registry client clamps its TTL', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, { deliver() {} });
  const build = (ms: number | undefined) =>
    new PersonAuth({ db, store, devAuth: false, oidc: null, confirmWindowMs: ms }).confirmWindowMs;

  assert.equal(build(undefined), PERSON_REVOCATION_GUARANTEE_MS, 'the default is the guarantee');
  assert.equal(build(5_000), 5_000, 'a shorter window is honoured');
  assert.equal(build(0), 0, 'zero confirms on every request');
  assert.equal(build(-1), 0);
  assert.equal(
    build(24 * 60 * 60 * 1000),
    PERSON_REVOCATION_GUARANTEE_MS,
    'a longer one is clamped: the ceiling is the guarantee, not a tuning knob',
  );
});

test('confirm: inside the window the provider is not asked again; past it, it is', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    const afterSignIn = r.idpRequests();

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    }
    assert.equal(r.idpRequests(), afterSignIn, 'a session inside its window costs no provider round-trip');

    // Age the session past the window, the way the clock would.
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200, 'and it is still served');
    assert.ok(r.idpRequests() > afterSignIn, 'because the provider was asked first');

    // The confirmation moved the clock, so the next request rides it.
    const afterConfirm = r.idpRequests();
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    assert.equal(r.idpRequests(), afterConfirm);
  } finally {
    r.close();
  }
});

test('confirm: a burst past the window asks the provider once, not once per request', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    const before = r.idpRequests();

    // Eight requests at once. Without single-flight this is eight refreshes,
    // and with a provider that rotates refresh tokens — as real ones do, and
    // as the stub does — seven of them would fail and sign the person out.
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => r.call('GET', '/collections', { jar })),
    );
    assert.ok(
      answers.every((a) => a.status === 200),
      `every request must be served: ${JSON.stringify(answers.map((a) => a.status))}`,
    );
    const spent = r.idpRequests() - before;
    assert.ok(spent <= 3, `one confirmation, not eight (the provider served ${spent} requests)`);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The provider says no

test('confirm: disabling someone at the identity provider cuts their session at the window', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200);
    const dana = r.store.listActors()[0]!;

    // Switched off in Entra ID, Okta, or — here — the stub. Nothing about
    // Canon's own session has changed yet.
    r.idp.updateUser('dana', { disabled: true });
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200, 'inside the window, still served');

    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    const cut = await r.call('GET', '/collections', { jar });
    assert.equal(cut.status, 401);
    assert.equal(cut.json.reason, 'revoked_at_idp');

    // Every session that person holds is gone, not just the one that asked:
    // the provider said the person is gone, and the others are the same person.
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE actor_id = ?').get(dana.id) as {
      n: number;
    };
    assert.equal(Number(rows.n), 0);
    assert.ok(
      r.store.queryAudit(dana.id, { action: 'person.revoked_at_idp' }).length > 0,
      'and the record says why the session ended',
    );
  } finally {
    r.close();
  }
});

test('confirm: two sessions, and disabling the person ends both within the window', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const laptop = (await r.signIn('dana')).jar;
    const phone = (await r.signIn('dana')).jar;
    r.idp.updateUser('dana', { disabled: true });
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());

    assert.equal((await r.call('GET', '/collections', { jar: laptop })).status, 401);
    assert.equal(
      (await r.call('GET', '/collections', { jar: phone })).status,
      401,
      'the second session does not have to wait for its own window',
    );
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// The provider cannot be reached

test('confirm: an unreachable provider refuses the request and keeps the session', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());

    // The provider goes away. Fail closed: 503, not "serve it anyway".
    await new Promise<void>((resolve) => r.idpServer.close(() => resolve()));
    const refused = await r.call('GET', '/collections', { jar });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.reason, 'idp_unreachable');

    // Nothing was deleted. An outage must not sign an organisation out, and it
    // must not serve them either — the same rule the Registry client keeps by
    // never caching "no answer" (REGISTRY-CONTRACT.md §5).
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number };
    assert.equal(Number(rows.n), 1);
    assert.equal(jar.has(SESSION_COOKIE), true, 'and the cookie is not cleared');
  } finally {
    r.close();
  }
});

test('confirm: a session with nothing to confirm with is ended, not served', async () => {
  // A provider that will not issue a refresh token — no `offline_access`, or
  // policy. The session cannot be confirmed, so it is outside the guarantee,
  // so it does not survive its first window. The person signs in again.
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    r.idp.setQuirk('no_refresh_token');
    const { jar } = await r.signIn('dana');
    assert.equal((await r.call('GET', '/collections', { jar })).status, 200, 'inside the window it works');

    const session = await r.call('GET', '/auth/session', { jar });
    assert.equal(session.json.authenticated, true);

    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    const dead = await r.call('GET', '/collections', { jar });
    assert.equal(dead.status, 401);
    assert.equal(dead.json.reason, 'session_unconfirmable');
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number };
    assert.equal(Number(rows.n), 0);
  } finally {
    r.close();
  }
});

test('confirm: a refreshed token that does not verify ends the session', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    // The provider starts signing with a key it does not publish. Everything
    // the ID-token validator refuses at sign-in it must refuse here too — the
    // confirmation is not a lighter check because the session already exists.
    r.idp.setQuirk('bad_signature');
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());

    const refused = await r.call('GET', '/collections', { jar });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.reason, 'bad_signature');
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number };
    assert.equal(Number(rows.n), 0);
  } finally {
    r.close();
  }
});

test('confirm: the refresh token is never served, logged, or stored in the clear', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    const stored = r.db.prepare('SELECT refresh_token FROM auth_sessions').get() as { refresh_token: string };
    assert.ok(stored.refresh_token, 'a session carries one');
    assert.equal(stored.refresh_token.startsWith('rt-'), false, 'sealed, not the provider’s token verbatim');
    assert.equal(stored.refresh_token.split('.').length, 3, 'iv.tag.ciphertext');

    const session = await r.call('GET', '/auth/session', { jar });
    assert.equal(JSON.stringify(session.json).includes(stored.refresh_token), false);
    const audit = r.db.prepare('SELECT details_json FROM audit_events').all() as { details_json: string }[];
    const blob = JSON.stringify(audit);
    assert.equal(blob.includes('rt-'), false, 'no refresh token reaches the audit log');
    assert.equal(blob.includes(stored.refresh_token), false);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------
// Explicit revocation — the route R9 asked for

test('revocation: an operator ends a person’s sessions immediately', async () => {
  const r = await authRig({
    users: [
      { sub: 'dana', name: 'Dana Whitfield', email: 'dana@example.com' },
      { sub: 'iris', name: 'Iris Okonkwo', email: 'iris@example.com' },
    ],
    bootstrapSubjects: ['dana'],
    confirmWindowMs: 60_000,
  });
  try {
    const operator = (await r.signIn('dana')).jar;
    const laptop = (await r.signIn('iris')).jar;
    const phone = (await r.signIn('iris')).jar;
    const iris = r.store.listActors().find((a) => a.name === 'Iris Okonkwo')!;
    assert.equal((await r.call('GET', '/collections', { jar: laptop })).status, 200);

    // A member cannot end anybody's sessions, including an operator's.
    const dana = r.store.listActors().find((a) => a.name === 'Dana Whitfield')!;
    assert.equal((await r.write('DELETE', `/auth/sessions/${dana.id}`, laptop)).status, 403);

    const revoked = await r.write('DELETE', `/auth/sessions/${iris.id}`, operator);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.revoked, 2);

    // Immediately: no window, no cache, nothing to wait for.
    assert.equal((await r.call('GET', '/collections', { jar: laptop })).status, 401);
    assert.equal((await r.call('GET', '/collections', { jar: phone })).status, 401);
    assert.ok(r.store.queryAudit(dana.id, { action: 'person.sessions_revoked' }).length > 0);

    // The operator's own session is untouched.
    assert.equal((await r.call('GET', '/collections', { jar: operator })).status, 200);
  } finally {
    r.close();
  }
});

test('revocation: revoking is not the same as disabling — the person can sign in again', async () => {
  const r = await authRig({ bootstrapSubjects: ['dana'], confirmWindowMs: 60_000 });
  try {
    const jar = (await r.signIn('dana')).jar;
    const dana = r.store.listActors()[0]!;
    await r.write('DELETE', `/auth/sessions/${dana.id}`, jar);
    assert.equal((await r.call('GET', '/collections', { jar })).status, 401);

    // Ending sessions is not a ban: the provider still knows them, so signing
    // in again works and lands on the SAME actor.
    const again = await r.signIn('dana', new Jar());
    assert.equal(again.status, 302);
    assert.equal(r.store.listActors().length, 1);
    assert.equal((await r.call('GET', '/collections', { jar: again.jar })).status, 200);
  } finally {
    r.close();
  }
});

test('revocation: logging out works even when the provider cannot be reached', async () => {
  const r = await authRig({ confirmWindowMs: 10_000 });
  try {
    const { jar } = await r.signIn('dana');
    const csrf = await r.csrfFor(jar);

    // The provider is down and the session is past its window, so every
    // ordinary request is refused (above). Signing out must still work: a
    // confirmation failure that left somebody unable to end their own session
    // would be a strange kind of security.
    r.db.prepare('UPDATE auth_sessions SET confirmed_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    await new Promise<void>((resolve) => r.idpServer.close(() => resolve()));
    assert.equal((await r.call('GET', '/collections', { jar })).status, 503);

    const out = await r.call('POST', '/auth/logout', { jar, csrf, origin: r.canonBase });
    assert.equal(out.status, 200);
    const rows = r.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number };
    assert.equal(Number(rows.n), 0, 'the row is deleted, not merely expired');
  } finally {
    r.close();
  }
});
