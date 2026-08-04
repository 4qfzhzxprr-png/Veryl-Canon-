import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../src/api.js';
import { PersonAuth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { CanonError } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { setHandOrgRole } from '../src/orgrole.js';
import { CanonStore } from '../src/store.js';
import { ensureSystemActorKind, SYSTEM_ACTOR_ID, SYSTEM_ACTOR_NAME } from '../src/system.js';

// Canon's own actor (src/system.ts). It exists so that work Canon does on its
// own clock is attributed to Canon rather than to whichever person a deployment
// happened to name — the demo corpus used to claim nineteen times that a real
// employee had personally marked nineteen pages past review.
//
// The whole design rests on it being unmistakable and unusable: it must appear
// as itself everywhere an actor appears, and it must be impossible to sign in
// as, to create a second of, or to hand a role to. These tests hold both.

const quiet: NotificationTransport = { deliver() {} };

function expectCode(fn: () => unknown, code: string): CanonError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonError, `expected CanonError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code} error, but the call succeeded`);
}

test('system actor: openDb writes exactly one, and it is not a person', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);

  const actor = store.getActor(SYSTEM_ACTOR_ID);
  assert.equal(actor.kind, 'system');
  assert.equal(actor.name, SYSTEM_ACTOR_NAME);
  assert.equal(actor.email, null, 'it is not a recipient of anything');
  assert.equal(actor.registryRef, null, 'and it is not an agent, so no passport can name it');

  // Not a UUID, deliberately: recognisable on sight in a raw audit row, a CSV
  // export, or a database somebody is reading with sqlite3.
  assert.equal(SYSTEM_ACTOR_ID, 'system:canon');
  assert.doesNotMatch(SYSTEM_ACTOR_ID, /^[0-9a-f]{8}-/);

  const rows = db.prepare("SELECT COUNT(*) AS n FROM actors WHERE kind = 'system'").get() as { n: number };
  assert.equal(rows.n, 1);
});

test('system actor: it is not in the directory, because it is nobody you can name', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const marc = store.createActor({ kind: 'person', name: 'Marc' });

  // `listActors` answers "who can I name as an owner, an approver, a member?"
  // and the answer is never Canon: it owns nothing and approves nothing, so
  // offering it in those pickers would offer a choice that refuses.
  assert.deepEqual(store.listActors().map((a) => a.id), [marc.id]);

  // It stays legible without being there: the id is a readable string and every
  // event it writes carries actorKind 'system' beside it. See the audit
  // assertions in freshness.test.ts.
  assert.equal(store.getActor(SYSTEM_ACTOR_ID).name, SYSTEM_ACTOR_NAME);
});

test('system actor: no second one can be created', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  const refused = expectCode(
    () => store.createActor({ kind: 'system', name: 'Canon' } as never),
    'invalid',
  );
  assert.match(refused.message, /already exists/);
  assert.equal(store.listActors().length, 0);
});

test('system actor: it holds no role, and nobody can give it one', () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  store.bootstrapAdministrator(dana.id);
  const collection = store.createCollection(dana.id, { name: 'Compliance' });

  // It holds nothing to begin with, and the org-role reader says so plainly.
  assert.equal(store.isOperator(SYSTEM_ACTOR_ID), false);
  assert.equal(store.isAdministrator(SYSTEM_ACTOR_ID), false);
  assert.equal(store.roleOf(SYSTEM_ACTOR_ID, collection.id), null);

  // And an administrator cannot change that. Its authority to run maintenance
  // is what it is; a grant would make it a thing somebody could widen.
  expectCode(() => store.setMember(dana.id, collection.id, SYSTEM_ACTOR_ID, 'admin'), 'forbidden');
  expectCode(() => store.setOrgRole(dana.id, SYSTEM_ACTOR_ID, 'administrator'), 'forbidden');
  assert.equal(store.roleOf(SYSTEM_ACTOR_ID, collection.id), null);
  assert.equal(store.isOperator(SYSTEM_ACTOR_ID), false);
});

test('system actor: it cannot bootstrap itself as the first administrator', () => {
  const store = new CanonStore(openDb(':memory:'), quiet);
  expectCode(() => store.bootstrapAdministrator(SYSTEM_ACTOR_ID), 'forbidden');
  // And the window it would have closed is still open for a person.
  const dana = store.createActor({ kind: 'person', name: 'Dana' });
  assert.equal(store.bootstrapAdministrator(dana.id), 'administrator');
});

test('system actor: nobody signs in as it, over any door', async () => {
  const db = openDb(':memory:');
  const store = new CanonStore(db, quiet);
  // A real PersonAuth with the dev door open, because that is the door this
  // refusal has to hold: `X-Actor-Id` is believed without verification.
  const personAuth = new PersonAuth({ db, store, devAuth: true, oidc: null, secureCookies: false });
  const server = createApi(store, undefined, undefined, personAuth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const dana = store.createActor({ kind: 'person', name: 'Dana' });
    setHandOrgRole(db, dana.id, 'operator', null);
    const collection = store.createCollection(dana.id, { name: 'Compliance' });

    // The dev door: X-Actor-Id is believed without verification, which is
    // exactly why this refusal has to be here. Without it, anyone who can reach
    // the port could run maintenance as Canon and be past `requireOrgRole`,
    // which the sweep skips for the system actor.
    const asCanon = await fetch(`${base}/collections`, { headers: { 'x-actor-id': SYSTEM_ACTOR_ID } });
    assert.equal(asCanon.status, 401);
    const body = (await asCanon.json()) as { error: string; reason?: string; message: string };
    assert.equal(body.error, 'unauthenticated');
    assert.match(body.message, /not an identity/);

    // Including on the one route it is allowed to perform internally.
    const sweep = await fetch(`${base}/maintenance/freshness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': SYSTEM_ACTOR_ID },
      body: '{}',
    });
    assert.equal(sweep.status, 401);

    // And `POST /actors` cannot mint one to sign in as either.
    const created = await fetch(`${base}/actors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'system', name: 'Canon' }),
    });
    assert.equal(created.status, 400);

    // The dev identity picker never offers it, because picking it would fail.
    const picker = (await (await fetch(`${base}/auth/dev/actors`)).json()) as { id: string }[];
    assert.equal(picker.some((a) => a.id === SYSTEM_ACTOR_ID), false);
    assert.ok(picker.some((a) => a.id === dana.id));

    // A member of the collection reading the directory does not see it either.
    const directory = (await (
      await fetch(`${base}/actors?collection=${collection.id}`, { headers: { 'x-actor-id': dana.id } })
    ).json()) as { id: string }[];
    assert.equal(directory.some((a) => a.id === SYSTEM_ACTOR_ID), false);
  } finally {
    server.close();
  }
});

test('system actor: a record written before the third actor kind is brought forward', () => {
  // The pre-system actors table, verbatim from the schema of that build: a CHECK
  // that admits two kinds, and a row of each.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE actors (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
      name         TEXT NOT NULL,
      email        TEXT,
      registry_ref TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE pages (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT REFERENCES actors(id),
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO actors VALUES (?, ?, ?, ?, ?, ?)').run(
    'a1', 'person', 'Marc', 'marc@example.com', null, '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO actors VALUES (?, ?, ?, ?, ?, ?)').run(
    'a2', 'agent', 'Helper', null, 'passport:acme/helper-1', '2026-01-02T00:00:00.000Z',
  );
  db.prepare('INSERT INTO pages VALUES (?, ?, ?)').run('p1', 'a1', '2026-01-03T00:00:00.000Z');

  // Before the migration the old CHECK refuses the new kind outright.
  assert.throws(() =>
    db.prepare("INSERT INTO actors VALUES ('system:canon', 'system', 'Canon', NULL, NULL, '1970-01-01T00:00:00.000Z')").run(),
  );

  ensureSystemActorKind(db);

  // Both rows survived the rebuild intact, with everything they carried.
  const marc = db.prepare('SELECT * FROM actors WHERE id = ?').get('a1') as Record<string, unknown>;
  assert.equal(marc.name, 'Marc');
  assert.equal(marc.email, 'marc@example.com');
  const helper = db.prepare('SELECT * FROM actors WHERE id = ?').get('a2') as Record<string, unknown>;
  assert.equal(helper.registry_ref, 'passport:acme/helper-1');
  // The foreign key from another table still resolves after the drop-and-rename.
  const joined = db
    .prepare('SELECT a.name AS n FROM pages p JOIN actors a ON a.id = p.owner_id WHERE p.id = ?')
    .get('p1') as { n: string };
  assert.equal(joined.n, 'Marc');

  // And the new kind is now admissible.
  db.prepare(
    "INSERT INTO actors VALUES ('system:canon', 'system', 'Canon', NULL, NULL, '1970-01-01T00:00:00.000Z')",
  ).run();
  // Idempotent: running it again on the migrated database changes nothing.
  ensureSystemActorKind(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n, 3);
});
