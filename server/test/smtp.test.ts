import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../src/api.js';
import { openDb } from '../src/db.js';
import { smtpTransport } from '../src/email.js';
import { CanonError } from '../src/model.js';
import { notifierFor, type Notification, type NotificationTransport } from '../src/notify.js';
import { parseSmtpUrl, sendMail } from '../src/smtp.js';
import { CanonStore } from '../src/store.js';
import { parseMail, startFakeSmtp, type FakeSmtp, type FakeSmtpOptions } from './fake-smtp.js';

// Delivery tests run against an in-process fake SMTP server (test/fake-smtp.ts).
// Nothing here opens a connection to any host outside this process.

const FROM = { name: 'Veryl Canon', address: 'canon@veryl.test' };
const BASE = 'https://canon.example.com';

function transportFor(fake: FakeSmtp) {
  return smtpTransport({ smtp: fake.config(), from: FROM, baseUrl: BASE });
}

function setup(transport?: NotificationTransport) {
  const store = new CanonStore(openDb(':memory:'), transport);
  const dana = store.createActor({ kind: 'person', name: 'Dana', email: 'dana@example.com' });
  const marc = store.createActor({ kind: 'person', name: 'Marc', email: 'marc@example.com' });
  const iris = store.createActor({ kind: 'person', name: 'Iris', email: 'iris@example.com' });
  const rosa = store.createActor({ kind: 'person', name: 'Rosa', email: 'rosa@example.com' });
  const collection = store.createCollection(dana.id, { name: 'Compliance', restricted: true });
  store.setMember(dana.id, collection.id, marc.id, 'edit');
  store.setMember(dana.id, collection.id, iris.id, 'approve');
  store.setMember(dana.id, collection.id, rosa.id, 'comment');
  return { store, dana, marc, iris, rosa, collection };
}

// Marc puts a policy in front of Iris: the notification Canon most needs to
// turn into an email, per CORE-PLAN.md section 7 (review friction).
function submitForReview(env: ReturnType<typeof setup>, title = 'Access policy') {
  const page = env.store.createPage(env.marc.id, { collectionId: env.collection.id, type: 'policy', title });
  env.store.editDraft(env.marc.id, page.id, {
    body: 'All access is logged.',
    fields: { ownerId: env.marc.id, approverId: env.iris.id, reviewDate: '2099-01-01' },
  });
  env.store.submitForReview(env.marc.id, page.id);
  return page;
}

function outbox(store: CanonStore) {
  const notifier = notifierFor(store);
  assert.ok(notifier, 'the store has a notification outbox');
  return notifier;
}

function only(store: CanonStore, actorId: string): Notification {
  const all = store.listNotifications(actorId);
  assert.equal(all.length, 1, `expected exactly one notification, got ${all.length}`);
  return all[0]!;
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

test('smtp: the URL says how to reach the relay and how much TLS to insist on', () => {
  const plain = parseSmtpUrl('smtp://relay.internal');
  assert.equal(plain.host, 'relay.internal');
  assert.equal(plain.port, 587);
  assert.equal(plain.secure, false);
  assert.equal(plain.starttls, 'opportunistic'); // nothing to protect without credentials
  assert.equal(plain.rejectUnauthorized, true);

  const creds = parseSmtpUrl('smtp://canon%40veryl.test:p%40ss%20word@relay.internal:2525');
  assert.equal(creds.user, 'canon@veryl.test');
  assert.equal(creds.pass, 'p@ss word');
  assert.equal(creds.port, 2525);
  assert.equal(creds.starttls, 'required'); // a password never crosses in clear

  const direct = parseSmtpUrl('smtps://relay.internal');
  assert.equal(direct.port, 465);
  assert.equal(direct.secure, true);
  assert.equal(direct.starttls, 'off');

  const flagged = parseSmtpUrl('smtp://relay.internal?starttls=off&insecure=true&name=canon-1&timeout=1234');
  assert.equal(flagged.starttls, 'off');
  assert.equal(flagged.rejectUnauthorized, false);
  assert.equal(flagged.clientName, 'canon-1');
  assert.equal(flagged.timeoutMs, 1234);

  expectCode(() => parseSmtpUrl('imap://relay.internal'), 'invalid');
  expectCode(() => parseSmtpUrl('relay.internal:587'), 'invalid');
  expectCode(() => parseSmtpUrl('smtp://relay.internal?starttls=maybe'), 'invalid');
});

test('smtp: a review request travels from the store to a real message', async () => {
  const fake = await startFakeSmtp();
  try {
    const env = setup(transportFor(fake));
    const page = submitForReview(env);

    // Real email cannot block the write, so the row is queued, not sent.
    const queued = only(env.store, env.iris.id);
    assert.equal(queued.sentAt, null);
    assert.equal(queued.attempts, 0);
    assert.equal(fake.messages.length, 0);

    const result = await outbox(env.store).flushPending();
    assert.deepEqual(result, { attempted: 1, delivered: 1, failed: 0, dead: 0, pending: 0 });
    assert.equal(fake.messages.length, 1);

    const captured = fake.messages[0]!;
    assert.equal(captured.from, 'canon@veryl.test'); // envelope sender
    assert.deepEqual(captured.to, ['iris@example.com']);
    assert.equal(captured.crlf, true); // every line ended CRLF on the wire
    assert.equal(captured.auth, null); // this relay asked for none

    const mail = parseMail(captured.data);
    assert.equal(mail.headers['from'], 'Veryl Canon <canon@veryl.test>');
    assert.equal(mail.headers['to'], 'Iris <iris@example.com>');
    assert.equal(mail.headers['subject'], 'Review requested: Access policy');
    assert.match(mail.headers['message-id'] ?? '', /^<[0-9a-f-]{36}@veryl\.test>$/);
    assert.match(mail.headers['date'] ?? '', /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    assert.equal(mail.headers['x-canon-notification'], queued.id);
    assert.match(mail.headers['content-type'] ?? '', /^multipart\/alternative; boundary="/);

    assert.match(mail.text, /^Hello Iris,/);
    assert.match(mail.text, /Marc submitted "Access policy" for review\./);
    assert.ok(mail.text.includes(`${BASE}/pages/${page.id}`), 'the deep link lands on the page under review');
    assert.ok(mail.html.includes(`href="${BASE}/pages/${page.id}"`));
    assert.match(mail.html, /Open the review/);

    // The row is marked sent, once.
    const sent = only(env.store, env.iris.id);
    assert.ok(sent.sentAt);
    assert.equal(sent.deadAt, null);
    assert.equal(sent.lastError, null);
  } finally {
    await fake.close();
  }
});

test('smtp: AUTH PLAIN, and refused credentials are permanent', async () => {
  const fake = await startFakeSmtp({ auth: { user: 'canon', pass: 's3cret' }, mechanisms: ['PLAIN'] });
  try {
    await sendMail(fake.config(), {
      from: 'canon@veryl.test',
      to: ['iris@example.com'],
      message: 'Subject: hello\r\n\r\nbody',
    });
    assert.equal(fake.messages.length, 1);
    assert.equal(fake.messages[0]!.auth, 'PLAIN');

    await assert.rejects(
      sendMail(fake.config({ pass: 'wrong' }), {
        from: 'canon@veryl.test',
        to: ['iris@example.com'],
        message: 'Subject: hello\r\n\r\nbody',
      }),
      (err: Error & { permanent?: boolean; replyCode?: number }) => {
        assert.equal(err.permanent, true); // 535: retrying will not help
        assert.equal(err.replyCode, 535);
        return true;
      },
    );
    assert.equal(fake.messages.length, 1); // nothing was delivered on the refused attempt
  } finally {
    await fake.close();
  }
});

test('smtp: AUTH LOGIN when that is all the relay offers', async () => {
  const fake = await startFakeSmtp({ auth: { user: 'canon', pass: 's3cret' }, mechanisms: ['LOGIN'] });
  try {
    await sendMail(fake.config(), {
      from: 'canon@veryl.test',
      to: ['iris@example.com'],
      message: 'Subject: hello\r\n\r\nbody',
    });
    assert.equal(fake.messages[0]!.auth, 'LOGIN');
  } finally {
    await fake.close();
  }
});

test('smtp: a body line beginning with a dot is stuffed and arrives whole', async () => {
  const fake = await startFakeSmtp();
  try {
    const message = ['Subject: dotted', '', 'before', '.', '.hidden', '..already', 'after'].join('\r\n');
    await sendMail(fake.config(), { from: 'canon@veryl.test', to: ['iris@example.com'], message });
    const captured = fake.messages[0]!;
    // On the wire each leading dot was doubled, so none of them ended the mail.
    assert.ok(captured.raw.includes('\r\n..\r\n'));
    assert.ok(captured.raw.includes('\r\n..hidden\r\n'));
    assert.ok(captured.raw.includes('\r\n...already\r\n'));
    // And the receiver, undoing the stuffing, has exactly what was sent.
    assert.equal(captured.data, message);
    assert.equal(captured.crlf, true);
  } finally {
    await fake.close();
  }
});

test('smtp: a comment beginning with a dot survives the whole notification path', async () => {
  const fake = await startFakeSmtp();
  try {
    const env = setup(transportFor(fake));
    const page = env.store.createPage(env.marc.id, {
      collectionId: env.collection.id,
      type: 'note',
      title: 'Figures',
    });
    const body = `@${env.iris.id} check the list:\n. first\n.. second`;
    env.store.createComment(env.rosa.id, page.id, { body });

    await outbox(env.store).flushPending();
    const mail = parseMail(fake.messages[0]!.data);
    assert.ok(mail.text.includes('  > . first'), mail.text);
    assert.ok(mail.text.includes('  > .. second'), mail.text);
    assert.ok(mail.text.includes(`${BASE}/pages/${page.id}#comment-`), 'the link lands on the comment');
  } finally {
    await fake.close();
  }
});

test('smtp: STARTTLS upgrades the connection, and a relay without it is a transient failure', async () => {
  const upgrading = await startFakeSmtp({ tls: 'starttls', auth: { user: 'canon', pass: 's3cret' } });
  try {
    await sendMail(upgrading.config(), {
      from: 'canon@veryl.test',
      to: ['iris@example.com'],
      message: 'Subject: over tls\r\n\r\nbody',
    });
    const captured = upgrading.messages[0]!;
    assert.equal(captured.secure, true); // the message travelled inside TLS
    assert.equal(captured.auth, 'PLAIN'); // and only then did the password go
  } finally {
    await upgrading.close();
  }

  const plain = await startFakeSmtp({ tls: 'none' });
  try {
    await assert.rejects(
      sendMail(plain.config({ starttls: 'required' }), {
        from: 'canon@veryl.test',
        to: ['iris@example.com'],
        message: 'Subject: no tls\r\n\r\nbody',
      }),
      (err: Error & { permanent?: boolean }) => {
        // Transient on purpose: an operator can fix the relay and the queued
        // notifications are still there to send.
        assert.equal(err.permanent, false);
        assert.match(err.message, /offers no STARTTLS/);
        return true;
      },
    );
    assert.equal(plain.messages.length, 0);
  } finally {
    await plain.close();
  }
});

test('smtp: direct TLS on the submissions port', async () => {
  const fake = await startFakeSmtp({ tls: 'direct', auth: { user: 'canon', pass: 's3cret' } });
  try {
    const config = parseSmtpUrl(fake.url());
    assert.equal(config.secure, true);
    await sendMail({ ...config, timeoutMs: 4000 }, {
      from: 'canon@veryl.test',
      to: ['iris@example.com'],
      message: 'Subject: smtps\r\n\r\nbody',
    });
    assert.equal(fake.messages[0]!.secure, true);
    assert.equal(fake.messages[0]!.auth, 'PLAIN');
  } finally {
    await fake.close();
  }
});

test('outbox: a 4xx leaves the row queued, waiting, and it goes out on a later flush', async () => {
  const options: FakeSmtpOptions = { dataReply: '451 4.3.0 mailbox busy, try later' };
  const fake = await startFakeSmtp(options);
  try {
    const env = setup(transportFor(fake));
    submitForReview(env);

    const first = await outbox(env.store).flushPending();
    assert.deepEqual(first, { attempted: 1, delivered: 0, failed: 1, dead: 0, pending: 1 });
    const queued = only(env.store, env.iris.id);
    assert.equal(queued.sentAt, null);
    assert.equal(queued.attempts, 1);
    assert.equal(queued.deadAt, null); // still retriable
    assert.match(queued.lastError ?? '', /^transient: SMTP the message body was refused: 451/);

    // Backoff holds it back from the very next pass.
    const held = await outbox(env.store).flushPending();
    assert.equal(held.attempted, 0);
    assert.equal(held.pending, 1);

    // The relay recovers; the notification is delivered with no work from the
    // person who triggered it.
    options.dataReply = undefined;
    const later = await outbox(env.store).flushPending(25, { ignoreBackoff: true });
    assert.deepEqual(later, { attempted: 1, delivered: 1, failed: 0, dead: 0, pending: 0 });
    assert.equal(fake.messages.length, 1);
    const sent = only(env.store, env.iris.id);
    assert.ok(sent.sentAt);
    assert.equal(sent.attempts, 1); // the failed attempt is still on the record
    assert.equal(sent.lastError, null);
  } finally {
    await fake.close();
  }
});

test('outbox: a 5xx marks the row dead and it is never tried again', async () => {
  const options: FakeSmtpOptions = { dataReply: '550 5.7.1 message refused by policy' };
  const fake = await startFakeSmtp(options);
  try {
    const env = setup(transportFor(fake));
    submitForReview(env);

    const first = await outbox(env.store).flushPending();
    assert.deepEqual(first, { attempted: 1, delivered: 0, failed: 0, dead: 1, pending: 0 });
    const dead = only(env.store, env.iris.id);
    assert.equal(dead.sentAt, null);
    assert.equal(dead.attempts, 1);
    assert.ok(dead.deadAt);
    assert.match(dead.lastError ?? '', /^permanent: SMTP the message body was refused: 550/);

    // Even with the relay healthy again, a dead row is not resurrected.
    options.dataReply = undefined;
    const again = await outbox(env.store).flushPending(25, { ignoreBackoff: true });
    assert.deepEqual(again, { attempted: 0, delivered: 0, failed: 0, dead: 0, pending: 0 });
    assert.equal(fake.messages.length, 0);
  } finally {
    await fake.close();
  }
});

test('outbox: a recipient with no address on record is a permanent failure', async () => {
  const fake = await startFakeSmtp();
  try {
    const env = setup(transportFor(fake));
    const nomail = env.store.createActor({ kind: 'person', name: 'Nomail' });
    env.store.setMember(env.dana.id, env.collection.id, nomail.id, 'comment');
    const page = env.store.createPage(env.marc.id, {
      collectionId: env.collection.id,
      type: 'note',
      title: 'Figures',
    });
    env.store.createComment(env.rosa.id, page.id, { body: `over to you @${nomail.id}` });

    const result = await outbox(env.store).flushPending();
    assert.equal(result.dead, 1);
    assert.equal(fake.messages.length, 0);
    const row = only(env.store, nomail.id);
    assert.ok(row.deadAt);
    assert.match(row.lastError ?? '', /permanent: Nomail has no email address on record/);
  } finally {
    await fake.close();
  }
});

test('outbox: flushPending works through a backlog in bounded passes and never sends twice', async () => {
  const fake = await startFakeSmtp();
  try {
    const env = setup(transportFor(fake));
    const page = env.store.createPage(env.marc.id, {
      collectionId: env.collection.id,
      type: 'note',
      title: 'Figures',
    });
    for (let i = 0; i < 5; i += 1) {
      env.store.createComment(env.rosa.id, page.id, { body: `question ${i} for @${env.iris.id}` });
    }
    assert.equal(outbox(env.store).pending().length, 5);

    const firstPass = await outbox(env.store).flushPending(2);
    assert.deepEqual(firstPass, { attempted: 2, delivered: 2, failed: 0, dead: 0, pending: 3 });

    const secondPass = await outbox(env.store).flushPending(25);
    assert.equal(secondPass.delivered, 3);
    assert.equal(secondPass.pending, 0);

    // A flush over an empty outbox is a no-op: five notifications, five mails.
    const thirdPass = await outbox(env.store).flushPending(25, { ignoreBackoff: true });
    assert.deepEqual(thirdPass, { attempted: 0, delivered: 0, failed: 0, dead: 0, pending: 0 });
    assert.equal(fake.messages.length, 5);
    assert.equal(new Set(fake.messages.map((m) => parseMail(m.data).headers['message-id'])).size, 5);
    assert.equal(env.store.listNotifications(env.iris.id).filter((n) => n.sentAt).length, 5);

    // Two flushes racing over the same backlog still deliver each row once.
    for (let i = 0; i < 4; i += 1) {
      env.store.createComment(env.rosa.id, page.id, { body: `later ${i} for @${env.iris.id}` });
    }
    const [a, b] = await Promise.all([
      outbox(env.store).flushPending(25),
      outbox(env.store).flushPending(25),
    ]);
    assert.equal(a.delivered + b.delivered, 4);
    assert.equal(fake.messages.length, 9);
  } finally {
    await fake.close();
  }
});

test('outbox: with no SMTP configured, everything behaves exactly as before', async () => {
  const captured: Notification[] = [];
  const env = setup({ deliver: (n) => void captured.push(n) });
  submitForReview(env);

  // Delivered inline by the synchronous transport, and marked sent there and then.
  const sent = only(env.store, env.iris.id);
  assert.ok(sent.sentAt);
  assert.equal(sent.attempts, 0);
  assert.equal(sent.lastError, null);
  assert.equal(sent.deadAt, null);
  assert.equal(captured.length, 1);

  // Nothing is left for a flush to do, and flushing is harmless.
  assert.deepEqual(outbox(env.store).pending(), []);
  assert.deepEqual(await outbox(env.store).flushPending(), {
    attempted: 0,
    delivered: 0,
    failed: 0,
    dead: 0,
    pending: 0,
  });

  // A synchronous transport that fails still leaves the row queued — and the
  // flush path can now pick it up.
  let up = false;
  const flaky = setup({
    deliver: () => {
      if (!up) throw new Error('smtp down');
    },
  });
  submitForReview(flaky);
  assert.equal(only(flaky.store, flaky.iris.id).sentAt, null);
  up = true;
  assert.equal((await outbox(flaky.store).flushPending()).delivered, 1);
  assert.ok(only(flaky.store, flaky.iris.id).sentAt);
});

test('outbox: a database written before delivery tracking existed is brought forward', async () => {
  const file = join(tmpdir(), `canon-outbox-${randomUUID()}.db`);
  try {
    // The notifications table exactly as the first outbox shipped it.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
                           registry_ref TEXT, created_at TEXT NOT NULL);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES actors(id), kind TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, link TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);
      INSERT INTO actors VALUES ('iris-1', 'person', 'Iris', 'iris@example.com', NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO notifications VALUES ('n-old', 'iris-1', 'review_requested', 'Review requested: Access policy',
        'Marc submitted "Access policy" for review.', '/pages/p1', '2026-01-01T00:00:00.000Z', NULL);
    `);
    old.close();

    const fake = await startFakeSmtp();
    try {
      // Opening the record adds the delivery columns; nothing else changes.
      const store = new CanonStore(openDb(file), transportFor(fake));
      const carried = only(store, 'iris-1');
      assert.equal(carried.id, 'n-old');
      assert.deepEqual(
        { attempts: carried.attempts, lastError: carried.lastError, deadAt: carried.deadAt },
        { attempts: 0, lastError: null, deadAt: null },
      );
      assert.equal((await outbox(store).flushPending()).delivered, 1);
      assert.equal(fake.messages.length, 1);
      assert.ok(only(store, 'iris-1').sentAt);
    } finally {
      await fake.close();
    }
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});

test('API: POST /notifications/flush is admin-ish and delivers the outbox', async () => {
  const fake = await startFakeSmtp();
  const env = setup(transportFor(fake));
  const page = submitForReview(env);
  const server = createApi(env.store);
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
    assert.equal((await call('POST', '/notifications/flush')).status, 401);
    assert.equal((await call('POST', '/notifications/flush', env.marc.id)).status, 403); // edit is not enough
    assert.equal(fake.messages.length, 0);

    const flushed = await call('POST', '/notifications/flush', env.dana.id, { limit: 10 });
    assert.equal(flushed.status, 200);
    assert.equal(flushed.json.delivered, 1);
    assert.equal(flushed.json.pending, 0);
    assert.equal(fake.messages.length, 1);
    assert.ok(parseMail(fake.messages[0]!.data).text.includes(`${BASE}/pages/${page.id}`));

    // Running it again on a timer costs nothing and sends nothing twice.
    const idle = await call('POST', '/notifications/flush', env.dana.id);
    assert.equal(idle.json.attempted, 0);
    assert.equal(fake.messages.length, 1);
  } finally {
    server.close();
    await fake.close();
  }
});
