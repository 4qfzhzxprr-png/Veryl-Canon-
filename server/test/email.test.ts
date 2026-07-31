import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  absoluteLink,
  composeMessage,
  encodeQuotedPrintable,
  encodeWord,
  formatAddress,
  formatDate,
  parseAddress,
  renderNotificationEmail,
  smtpTransportFromEnv,
} from '../src/email.js';
import { CanonError, type Actor } from '../src/model.js';
import type { Notification, NotificationKind } from '../src/notify.js';
import { decodeQuotedPrintable, parseMail } from './fake-smtp.js';

const iris: Actor = {
  id: 'iris-1',
  kind: 'person',
  name: 'Iris Okonjo',
  email: 'iris@example.com',
  registryRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function notification(kind: NotificationKind, over: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    recipientId: iris.id,
    kind,
    subject: 'Review requested: Access policy',
    body: 'Marc submitted "Access policy" for review.',
    link: '/pages/page-1',
    createdAt: '2026-07-30T09:00:00.000Z',
    sentAt: null,
    attempts: 0,
    lastError: null,
    deadAt: null,
    ...over,
  };
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

test('email: quoted-printable keeps lines short and text recoverable', () => {
  assert.equal(encodeQuotedPrintable('7 years = seven'), '7 years =3D seven');
  assert.equal(encodeQuotedPrintable('trailing space '), 'trailing space=20');
  assert.equal(encodeQuotedPrintable('café'), 'caf=C3=A9'); // UTF-8, byte by byte
  assert.equal(encodeQuotedPrintable('. a leading dot'), '. a leading dot'); // untouched here; SMTP stuffs it

  // A paragraph far longer than a line is soft-broken, and every encoded line
  // stays inside the 76-character limit RFC 2045 sets.
  const long = `Retention applies to every record system named in the appendix. ${'word '.repeat(60)}end`;
  const encoded = encodeQuotedPrintable(long);
  for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`);
  assert.equal(decodeQuotedPrintable(encoded), long);

  // Multi-byte characters are never torn across a soft break.
  const accented = 'été '.repeat(40).trim();
  assert.equal(decodeQuotedPrintable(encodeQuotedPrintable(accented)), accented);
});

test('email: headers use RFC 2047 encoded-words only where they must', () => {
  assert.equal(encodeWord('Review requested: Access policy'), 'Review requested: Access policy');
  const encoded = encodeWord('Sent back: Rétention des données');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(
    Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(encoded)![1]!, 'base64').toString('utf8').slice(0, 10),
    'Sent back:',
  );
  for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 76);

  assert.equal(formatAddress({ name: null, address: 'canon@veryl.test' }), 'canon@veryl.test');
  assert.equal(formatAddress({ name: 'Veryl Canon', address: 'canon@veryl.test' }), 'Veryl Canon <canon@veryl.test>');
  assert.equal(
    formatAddress({ name: 'Okonjo, Iris', address: 'iris@example.com' }),
    '"Okonjo, Iris" <iris@example.com>',
  );
  assert.match(formatDate(new Date('2026-07-30T09:05:01Z')), /^Thu, 30 Jul 2026 09:05:01 \+0000$/);

  assert.deepEqual(parseAddress('Veryl Canon <canon@veryl.test>'), { name: 'Veryl Canon', address: 'canon@veryl.test' });
  assert.deepEqual(parseAddress('canon@veryl.test'), { name: null, address: 'canon@veryl.test' });
  expectCode(() => parseAddress('not-an-address'), 'invalid');
});

test('email: a composed message is a well-formed multipart/alternative', () => {
  const { raw, messageId, boundary } = composeMessage({
    from: { name: 'Veryl Canon', address: 'canon@veryl.test' },
    to: { name: 'Iris Okonjo', address: 'iris@example.com' },
    subject: 'Sent back: Access policy',
    text: 'plain words\nsecond line',
    html: '<p>plain words</p>',
    date: new Date('2026-07-30T09:05:01Z'),
    headers: { 'X-Canon-Notification': 'n-1' },
  });

  // CRLF everywhere: not one bare newline anywhere in the message.
  assert.equal(raw.split('\n').length - 1, raw.split('\r\n').length - 1);
  assert.ok(!/[^\r]\n/.test(raw));

  const mail = parseMail(raw);
  assert.equal(mail.headers['from'], 'Veryl Canon <canon@veryl.test>');
  assert.equal(mail.headers['to'], 'Iris Okonjo <iris@example.com>');
  assert.equal(mail.headers['subject'], 'Sent back: Access policy');
  assert.equal(mail.headers['date'], 'Thu, 30 Jul 2026 09:05:01 +0000');
  assert.equal(mail.headers['message-id'], messageId);
  assert.match(messageId, /^<[0-9a-f-]{36}@veryl\.test>$/);
  assert.equal(mail.headers['mime-version'], '1.0');
  assert.equal(mail.headers['auto-submitted'], 'auto-generated');
  assert.equal(mail.headers['x-canon-notification'], 'n-1');
  assert.equal(mail.headers['content-type'], `multipart/alternative; boundary="${boundary}"`);

  assert.equal(mail.text, 'plain words\r\nsecond line');
  assert.equal(mail.html, '<p>plain words</p>');
  assert.ok(raw.includes('Content-Transfer-Encoding: quoted-printable'));
  assert.ok(raw.endsWith(`--${boundary}--\r\n`));
});

test('email: every notification kind names the page, what happened, and where to go', () => {
  const cases: [NotificationKind, Partial<Notification>, RegExp][] = [
    [
      'review_requested',
      {},
      /Marc submitted "Access policy" for review\./,
    ],
    [
      'draft_approved',
      { subject: 'Approved as Canonical: Access policy', body: 'Iris approved "Access policy" as Canonical.' },
      /approved "Access policy" as Canonical\./,
    ],
    [
      'draft_sent_back',
      {
        subject: 'Sent back: Access policy',
        body: 'Iris sent "Access policy" back: Name the systems in scope.',
      },
      /Iris sent "Access policy" back\./,
    ],
    [
      'mention',
      {
        subject: 'Rosa mentioned you on "Access policy"',
        body: 'Is the Q2 figure current, @iris-1?',
        link: '/pages/page-1#comment-c1',
      },
      /Rosa mentioned you on "Access policy"\./,
    ],
  ];

  for (const [kind, over, lead] of cases) {
    const n = notification(kind, over);
    const mail = renderNotificationEmail(n, iris, { baseUrl: 'https://canon.example.com/' });
    assert.equal(mail.subject, n.subject); // the subject names the page and what happened
    assert.match(mail.text, /^Hello Iris Okonjo,/);
    assert.match(mail.text, lead);
    // The deep link is prominent, absolute, and in both parts.
    const url = `https://canon.example.com${n.link}`;
    assert.ok(mail.text.includes(url), `plain text is missing ${url}`);
    assert.ok(mail.html.includes(`href="${url}"`), `html is missing a link to ${url}`);
    assert.match(mail.text, /You are receiving this because/);
    assert.match(mail.text, /replies to it are not read/);
  }

  // The reviewer's own words are quoted, not paraphrased away.
  const back = renderNotificationEmail(
    notification('draft_sent_back', {
      subject: 'Sent back: Access policy',
      body: 'Iris sent "Access policy" back: Name the systems in scope.',
    }),
    iris,
    { baseUrl: 'https://canon.example.com' },
  );
  assert.match(back.text, /^ {2}> Name the systems in scope\.$/m);
  assert.match(back.html, /<blockquote[^>]*>Name the systems in scope\.<\/blockquote>/);

  // A mention carries the comment itself.
  const mention = renderNotificationEmail(
    notification('mention', { subject: 'Rosa mentioned you on "Access policy"', body: 'Is the Q2 figure current?' }),
    iris,
    { baseUrl: 'https://canon.example.com' },
  );
  assert.match(mention.text, /^ {2}> Is the Q2 figure current\?$/m);
  assert.match(mention.text, /Open the comment:/);
});

test('email: html is escaped and deep links survive a base URL with a path', () => {
  const mail = renderNotificationEmail(
    notification('mention', { subject: 'Rosa mentioned you', body: 'careful: <script>alert(1)</script> & co' }),
    iris,
    { baseUrl: 'https://intranet.example.com/canon/' },
  );
  assert.ok(!mail.html.includes('<script>'));
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.html, /&amp; co/);
  assert.equal(absoluteLink('https://intranet.example.com/canon/', '/pages/p1'), 'https://intranet.example.com/canon/pages/p1');
  assert.ok(mail.text.includes('https://intranet.example.com/canon/pages/page-1'));
});

test('email: no CANON_SMTP_URL means no email transport, and a sender is required', () => {
  assert.equal(smtpTransportFromEnv({}), null);
  assert.equal(smtpTransportFromEnv({ CANON_MAIL_FROM: 'canon@veryl.test' }), null);
  expectCode(() => smtpTransportFromEnv({ CANON_SMTP_URL: 'smtp://relay.internal:587' }), 'invalid');
  expectCode(
    () => smtpTransportFromEnv({ CANON_SMTP_URL: 'http://relay.internal', CANON_MAIL_FROM: 'canon@veryl.test' }),
    'invalid',
  );

  const transport = smtpTransportFromEnv({
    CANON_SMTP_URL: 'smtp://relay.internal:587',
    CANON_MAIL_FROM: 'Veryl Canon <canon@veryl.test>',
    CANON_BASE_URL: 'https://canon.example.com',
  });
  assert.ok(transport);
  const { envelope, content } = transport.compose(notification('review_requested'), iris);
  assert.equal(envelope.from, 'canon@veryl.test');
  assert.deepEqual(envelope.to, ['iris@example.com']);
  assert.equal(content.subject, 'Review requested: Access policy');
  assert.ok(parseMail(envelope.message).text.includes('https://canon.example.com/pages/page-1'));

  // A recipient with no address on record is a permanent failure, not a retry.
  const noEmail: Actor = { ...iris, email: null };
  assert.throws(
    () => transport.compose(notification('review_requested'), noEmail),
    (err: Error & { permanent?: boolean }) => err.permanent === true,
  );
});
