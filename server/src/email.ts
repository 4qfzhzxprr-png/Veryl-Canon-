import { randomUUID } from 'node:crypto';
import { Actor, CanonError } from './model.js';
import type { Notification, NotificationKind, NotificationTransport } from './notify.js';
import { MailEnvelope, SmtpConfig, SmtpPermanentError, parseSmtpUrl, sendMail } from './smtp.js';

// Composing the notification email (CORE-PLAN.md Epic C, and section 7's
// review-friction risk: "email deep links straight into review"). The email is
// the thing that pulls a reviewer back into the record, so it says four things
// and stops: who did what, to which page, the reviewer's words where there are
// any, and one link that lands on the page or its review.
//
// Encoding: both body parts are quoted-printable. Quoted-printable keeps the
// message readable in a raw mailbox — a compliance lead who opens the source
// still sees English — while making every line safely under the RFC 5321
// 1000-octet limit and carrying UTF-8 without relying on 8BITMIME. Headers use
// RFC 2047 base64 encoded-words when they are not plain ASCII.

const CRLF = '\r\n';

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// ---- encodings ---------------------------------------------------------

function hex(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

function encodeQpLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  const tokens: string[] = [];
  bytes.forEach((byte, i) => {
    const trailing = i === bytes.length - 1;
    if (byte === 9 || byte === 32) {
      // Trailing whitespace would be eaten in transit, so it is encoded.
      tokens.push(trailing ? hex(byte) : String.fromCharCode(byte));
    } else if (byte >= 33 && byte <= 126 && byte !== 61) {
      tokens.push(String.fromCharCode(byte));
    } else {
      tokens.push(hex(byte));
    }
  });
  const out: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length + token.length > 75) {
      // A soft line break must not follow whitespace, or the decoder loses it.
      if (current.endsWith(' ') || current.endsWith('\t')) {
        current = current.slice(0, -1) + hex(current.charCodeAt(current.length - 1));
      }
      out.push(current + '=');
      current = '';
    }
    current += token;
  }
  out.push(current);
  return out.join(CRLF);
}

// RFC 2045 §6.7. Long lines are folded with soft breaks ("=" at end of line),
// so no encoded line exceeds 76 characters.
export function encodeQuotedPrintable(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map(encodeQpLine)
    .join(CRLF);
}

// RFC 2047 encoded-word for header text that is not plain ASCII. Split on
// character boundaries so no multi-byte character is torn in half.
export function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 42) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

// RFC 5322 §3.3, always in UTC so the record reads the same everywhere.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

const SPECIALS = /[()<>@,;:\\".[\]]/;

export function formatAddress(address: MailAddress): string {
  if (!address.name) return address.address;
  const name = encodeWord(address.name);
  const needsQuotes = name === address.name && SPECIALS.test(name);
  return `${needsQuotes ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name} <${address.address}>`;
}

// "Veryl Canon <canon@example.com>" or a bare address.
export function parseAddress(raw: string, what = 'address'): MailAddress {
  const value = raw.trim();
  const angled = /^(.*?)\s*<([^>]+)>$/.exec(value);
  const address = (angled ? angled[2]! : value).trim();
  if (!address.includes('@') || /\s/.test(address)) {
    throw new CanonError('invalid', `Not a usable email ${what}: ${JSON.stringify(raw)}`);
  }
  const name = angled ? angled[1]!.trim().replace(/^"|"$/g, '') : '';
  return { name: name || null, address };
}

// Fold a header onto continuation lines at whitespace, keeping lines short
// enough for every relay. Values already folded (encoded-words) are left be.
function headerLine(name: string, value: string): string {
  const lines: string[] = [];
  for (const segment of value.split(CRLF)) {
    let line = lines.length === 0 ? `${name}: ${segment}` : segment;
    while (line.length > 78) {
      const cut = line.lastIndexOf(' ', 78);
      if (cut <= 0) break;
      lines.push(line.slice(0, cut));
      line = ' ' + line.slice(cut + 1);
    }
    lines.push(line);
  }
  return lines.join(CRLF);
}

// ---- message composition ----------------------------------------------

export interface ComposeInput {
  from: MailAddress;
  to: MailAddress;
  subject: string;
  text: string;
  html: string;
  date?: Date;
  messageId?: string;
  headers?: Record<string, string>;
}

export interface ComposedMessage {
  raw: string;
  messageId: string;
  boundary: string;
}

export function composeMessage(input: ComposeInput): ComposedMessage {
  const domain = input.from.address.split('@')[1] ?? 'canon.invalid';
  const messageId = input.messageId ?? `<${randomUUID()}@${domain}>`;
  const boundary = `--=_canon_${randomUUID().replace(/-/g, '')}`;
  const headers: [string, string][] = [
    ['From', formatAddress(input.from)],
    ['To', formatAddress(input.to)],
    ['Subject', encodeWord(input.subject)],
    ['Date', formatDate(input.date ?? new Date())],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0'],
    // Tells other mailers not to answer with vacation replies or tickets.
    ['Auto-Submitted', 'auto-generated'],
    ...Object.entries(input.headers ?? {}),
    ['Content-Type', `multipart/alternative; boundary="${boundary}"`],
  ];
  const part = (contentType: string, body: string): string =>
    [
      `--${boundary}`,
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(body),
    ].join(CRLF);

  const raw = [
    headers.map(([name, value]) => headerLine(name, value)).join(CRLF),
    '',
    'This is a message in MIME format. Read it in a mail reader that supports MIME.',
    part('text/plain; charset="UTF-8"', input.text),
    part('text/html; charset="UTF-8"', input.html),
    `--${boundary}--`,
    '',
  ].join(CRLF);
  return { raw, messageId, boundary };
}

// ---- what each notification says --------------------------------------

interface KindCopy {
  cta: string;
  why: string;
}

const COPY: Record<NotificationKind, KindCopy> = {
  mention: {
    cta: 'Open the comment',
    why: 'You are receiving this because you were mentioned in a comment.',
  },
  review_requested: {
    cta: 'Open the review',
    why: 'You are receiving this because this page is waiting for your review.',
  },
  draft_approved: {
    cta: 'Open the page',
    why: 'You are receiving this because you wrote or own this page.',
  },
  draft_sent_back: {
    cta: 'Open the draft',
    why: 'You are receiving this because you wrote or own this page.',
  },
};

// A mention carries the comment itself; a send-back carries the approver's
// note after "back:". Both are worth quoting rather than paraphrasing — the
// reviewer's own words are the reason the email is worth opening.
function split(notification: Notification): { lead: string; quote: string | null } {
  if (notification.kind === 'mention') {
    return { lead: notification.subject.replace(/\.?$/, '.'), quote: notification.body };
  }
  if (notification.kind === 'draft_sent_back') {
    const match = /^([\s\S]*?back):\s*([\s\S]+)$/.exec(notification.body);
    if (match) return { lead: `${match[1]!}.`, quote: match[2]!.trim() };
  }
  return { lead: notification.body, quote: null };
}

export function absoluteLink(baseUrl: string, link: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${link.startsWith('/') ? '' : '/'}${link}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RenderOptions {
  baseUrl: string;
  productName?: string;
}

// Plain and calm on purpose: no marketing, no images, no tracking. The same
// words in both parts, so the plain-text reader loses nothing.
export function renderNotificationEmail(
  notification: Notification,
  recipient: Actor,
  options: RenderOptions,
): EmailContent {
  const product = options.productName ?? 'Veryl Canon';
  const copy = COPY[notification.kind];
  const { lead, quote } = split(notification);
  const url = absoluteLink(options.baseUrl, notification.link);
  const greeting = `Hello ${recipient.name},`;

  const text = [
    greeting,
    '',
    lead,
    ...(quote ? ['', quote.split('\n').map((line) => `  > ${line}`).join('\n')] : []),
    '',
    `${copy.cta}:`,
    url,
    '',
    copy.why,
    '',
    '-- ',
    `${product}. This message is automated; replies to it are not read.`,
    '',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f6f7f8;',
    'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1d21;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;',
    'border-radius:6px;padding:24px;">',
    `<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${escapeHtml(lead)}</p>`,
    ...(quote
      ? [
          '<blockquote style="margin:0 0 16px;padding:8px 16px;border-left:3px solid #c9ced6;',
          `color:#41464d;white-space:pre-wrap;">${escapeHtml(quote)}</blockquote>`,
        ]
      : []),
    `<p style="margin:0 0 16px;"><a href="${escapeHtml(url)}" `,
    'style="display:inline-block;padding:10px 16px;background:#1f2933;color:#ffffff;',
    `border-radius:4px;text-decoration:none;">${escapeHtml(copy.cta)}</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#5a6069;">${escapeHtml(url)}</p>`,
    `<p style="margin:0;font-size:13px;color:#5a6069;">${escapeHtml(copy.why)}</p>`,
    '</div>',
    `<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#767c85;">`,
    `${escapeHtml(product)}. This message is automated; replies to it are not read.</p>`,
    '</body></html>',
    '',
  ].join('\n');

  return { subject: notification.subject, text, html };
}

// ---- the transport -----------------------------------------------------

export interface SmtpTransportOptions {
  smtp: SmtpConfig;
  from: MailAddress;
  baseUrl: string;
  productName?: string;
  date?: () => Date;
}

// smtpTransport satisfies NotificationTransport, and adds deliverAsync, which
// is what the outbox actually calls: a real SMTP conversation cannot finish
// inside the synchronous write path that records a notification. See notify.ts
// — a transport with deliverAsync leaves its rows queued for flushPending().
export interface MailTransport extends NotificationTransport {
  deliverAsync(notification: Notification, recipient: Actor): Promise<void>;
  compose(notification: Notification, recipient: Actor): { envelope: MailEnvelope; content: EmailContent };
}

export function smtpTransport(options: SmtpTransportOptions): MailTransport {
  const clock = options.date ?? (() => new Date());
  return {
    deliver(): void {
      throw new Error('smtpTransport delivers through flushPending(); nothing is sent inline');
    },

    compose(notification, recipient) {
      if (!recipient.email) {
        // Nothing to retry against: the actor has no address on record.
        throw new SmtpPermanentError(`${recipient.name} has no email address on record`);
      }
      const content = renderNotificationEmail(notification, recipient, {
        baseUrl: options.baseUrl,
        productName: options.productName,
      });
      const { raw } = composeMessage({
        from: options.from,
        to: { name: recipient.name, address: recipient.email },
        subject: content.subject,
        text: content.text,
        html: content.html,
        date: clock(),
        headers: { 'X-Canon-Notification': notification.id, 'X-Canon-Notification-Kind': notification.kind },
      });
      return { envelope: { from: options.from.address, to: [recipient.email], message: raw }, content };
    },

    async deliverAsync(notification, recipient) {
      const { envelope } = this.compose(notification, recipient);
      await sendMail(options.smtp, envelope);
    },
  };
}

// CANON_SMTP_URL, CANON_MAIL_FROM, CANON_BASE_URL. With no CANON_SMTP_URL this
// returns null and the caller keeps the dev transport: unconfigured Canon
// behaves exactly as it did before email delivery existed.
export function smtpTransportFromEnv(env: NodeJS.ProcessEnv = process.env): MailTransport | null {
  const url = env.CANON_SMTP_URL?.trim();
  if (!url) return null;
  const from = env.CANON_MAIL_FROM?.trim();
  if (!from) {
    throw new CanonError('invalid', 'CANON_SMTP_URL is set but CANON_MAIL_FROM is not: an email needs a sender');
  }
  const baseUrl = env.CANON_BASE_URL?.trim();
  if (!baseUrl) {
    console.warn(
      '[notify] CANON_BASE_URL is not set; notification deep links will point at http://localhost:3000',
    );
  }
  return smtpTransport({
    smtp: parseSmtpUrl(url),
    from: parseAddress(from, 'sender (CANON_MAIL_FROM)'),
    baseUrl: baseUrl || 'http://localhost:3000',
    productName: env.CANON_PRODUCT_NAME?.trim() || undefined,
  });
}
