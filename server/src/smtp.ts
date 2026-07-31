import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { CanonError } from './model.js';

// A minimal SMTP submission client written directly on node:net and node:tls,
// because Canon ships with no runtime dependencies (README: "Node 22+, no
// runtime dependencies"). It speaks the subset of RFC 5321 a product needs to
// hand a notification to a relay: greeting, EHLO (with HELO fallback),
// STARTTLS or direct TLS, AUTH PLAIN and AUTH LOGIN, MAIL FROM / RCPT TO /
// DATA with dot-stuffing, and QUIT.
//
// Failures are typed by what an operator should do about them:
//   * SmtpPermanentError (5xx, unusable address, refused credentials) — the
//     message will never be accepted as-is, so the outbox marks it dead.
//   * SmtpTransientError (4xx, connection trouble, timeouts) — the relay may
//     take it later, so the outbox keeps the row and retries with backoff.
// Both carry `permanent: boolean`, which is the only thing notify.ts looks at:
// the outbox stays decoupled from this module.

export type StartTlsMode = 'required' | 'opportunistic' | 'off';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // wrap the connection in TLS immediately (submissions, port 465)
  starttls: StartTlsMode; // upgrade an initially plain connection
  user: string | null;
  pass: string | null;
  timeoutMs: number;
  rejectUnauthorized: boolean; // false only for self-signed internal relays
  clientName: string; // the name given in EHLO
}

export interface MailEnvelope {
  from: string; // return path; the bounce address, not necessarily the From: header
  to: string[];
  message: string; // a complete RFC 5322 message; line endings are normalised here
}

export interface SmtpDelivery {
  code: number; // the reply code for the accepted DATA
  response: string;
  secure: boolean; // did the message travel over TLS
  auth: 'PLAIN' | 'LOGIN' | null;
}

// ---- typed errors ------------------------------------------------------

export abstract class SmtpError extends Error {
  abstract readonly permanent: boolean;
  readonly replyCode: number | null;
  readonly command: string | null;

  constructor(message: string, replyCode: number | null = null, command: string | null = null) {
    super(message);
    this.name = new.target.name;
    this.replyCode = replyCode;
    this.command = command;
  }
}

// 5xx and anything else that will fail identically on every retry.
export class SmtpPermanentError extends SmtpError {
  readonly permanent = true;
}

// 4xx, dropped connections, timeouts: worth trying again later.
export class SmtpTransientError extends SmtpError {
  readonly permanent = false;
}

// ---- configuration -----------------------------------------------------

export const SMTP_TIMEOUT_MS = 20_000;

// CANON_SMTP_URL, e.g. smtp://user:pass@relay.internal:587
//   smtp://   plain connection, upgraded with STARTTLS (required once
//             credentials are present, so a password never crosses in clear)
//   smtps://  TLS from the first byte (port 465)
// Query flags, all optional: ?starttls=required|opportunistic|off
//                            ?insecure=true   accept a self-signed relay cert
//                            ?name=<ehlo name>&timeout=<ms>
export function parseSmtpUrl(raw: string): SmtpConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value is not echoed. CANON_SMTP_URL routinely carries the relay
    // password, and this error is thrown at start-up where it lands in the
    // console, in a crash report, or — if a caller ever parses one at request
    // time — in an HTTP body. A secret in an error message is a secret Canon
    // has published, so the message says what is wrong and nothing else.
    throw new CanonError('invalid', 'CANON_SMTP_URL is not a URL');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'smtp' && scheme !== 'smtps') {
    throw new CanonError('invalid', `CANON_SMTP_URL must be smtp:// or smtps://, not ${scheme}://`);
  }
  if (!url.hostname) throw new CanonError('invalid', 'CANON_SMTP_URL names no host');
  const secure = scheme === 'smtps';
  const user = url.username ? decodeURIComponent(url.username) : null;
  const pass = url.password ? decodeURIComponent(url.password) : null;
  const starttlsParam = url.searchParams.get('starttls');
  if (starttlsParam && !['required', 'opportunistic', 'off'].includes(starttlsParam)) {
    throw new CanonError('invalid', `CANON_SMTP_URL starttls must be required, opportunistic, or off`);
  }
  const timeoutParam = url.searchParams.get('timeout');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    starttls: (starttlsParam as StartTlsMode | null) ?? (secure ? 'off' : user ? 'required' : 'opportunistic'),
    user,
    pass,
    timeoutMs: timeoutParam ? Number(timeoutParam) : SMTP_TIMEOUT_MS,
    rejectUnauthorized: url.searchParams.get('insecure') !== 'true',
    clientName: url.searchParams.get('name') ?? 'canon',
  };
}

// ---- wire helpers ------------------------------------------------------

const CRLF = '\r\n';

// Every line ending on the wire is CRLF, whatever the composer produced.
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF);
}

// RFC 5321 §4.5.2: a line starting with '.' gets a second '.', so that only
// the terminating ".\r\n" ends the message. Without this a body line reading
// "." would truncate the mail.
export function dotStuff(message: string): string {
  return toCrlf(message).replace(/^\./gm, '..');
}

function assertAddress(address: string, what: string): string {
  const trimmed = address.trim();
  if (!trimmed || /[\r\n<>]/.test(trimmed) || !trimmed.includes('@')) {
    throw new SmtpPermanentError(`${what} is not a usable email address: ${JSON.stringify(address)}`);
  }
  return trimmed;
}

interface Reply {
  code: number;
  lines: string[]; // reply text, one entry per line, codes stripped
  text: string;
}

// One SMTP conversation. Replies are read strictly in order; a socket error,
// an unexpected close, or a timeout fails the pending read and every read
// after it, so no command can hang forever.
class Session {
  private socket: Socket | TLSSocket;
  private buf = '';
  private partial: string[] = [];
  private ready: Reply[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (err: Error) => void } | null = null;
  private failure: Error | null = null;
  private finished = false;

  constructor(socket: Socket | TLSSocket, private readonly timeoutMs: number) {
    this.socket = socket;
    this.bind(socket);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('utf8');
    let index = this.buf.indexOf('\n');
    while (index !== -1) {
      const line = this.buf.slice(0, index).replace(/\r$/, '');
      this.buf = this.buf.slice(index + 1);
      this.onLine(line);
      index = this.buf.indexOf('\n');
    }
  };

  private onLine(line: string): void {
    const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!match) {
      this.fail(new SmtpTransientError(`Unparsable SMTP reply: ${JSON.stringify(line)}`));
      return;
    }
    const [, code, sep, text] = match as unknown as [string, string, string, string];
    this.partial.push(text);
    if (sep === '-') return; // continuation; the reply is not complete yet
    const reply: Reply = { code: Number(code), lines: this.partial, text: this.partial.join(' ') };
    this.partial = [];
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(reply);
    } else {
      this.ready.push(reply);
    }
  }

  private readonly onError = (err: Error): void => {
    this.fail(new SmtpTransientError(`SMTP connection error: ${err.message}`));
  };

  private readonly onClose = (): void => {
    if (!this.finished) this.fail(new SmtpTransientError('The SMTP server closed the connection'));
  };

  private readonly onTimeout = (): void => {
    this.fail(new SmtpTransientError(`The SMTP server went quiet for ${this.timeoutMs}ms`));
    this.socket.destroy();
  };

  private bind(socket: Socket | TLSSocket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.setTimeout(this.timeoutMs);
    socket.on('timeout', this.onTimeout);
  }

  private unbind(socket: Socket | TLSSocket): void {
    socket.removeListener('data', this.onData);
    socket.removeListener('error', this.onError);
    socket.removeListener('close', this.onClose);
    socket.removeListener('timeout', this.onTimeout);
    socket.setTimeout(0);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  read(): Promise<Reply> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  write(line: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(line + CRLF);
  }

  writeRaw(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  // Send one command and hold the reply against what the RFC allows there.
  async command(line: string, accept: (code: number) => boolean, label = line.split(' ')[0]!): Promise<Reply> {
    this.write(line);
    return this.expect(accept, label);
  }

  async expect(accept: (code: number) => boolean, label: string): Promise<Reply> {
    const reply = await this.read();
    if (accept(reply.code)) return reply;
    const message = `SMTP ${label} was refused: ${reply.code} ${reply.text}`;
    throw reply.code >= 500
      ? new SmtpPermanentError(message, reply.code, label)
      : new SmtpTransientError(message, reply.code, label);
  }

  // STARTTLS: hand the negotiated plain socket to node:tls and keep talking.
  async upgrade(config: SmtpConfig): Promise<TLSSocket> {
    const plain = this.socket;
    this.unbind(plain);
    const secured = tlsConnect({
      socket: plain,
      servername: config.host,
      rejectUnauthorized: config.rejectUnauthorized,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) =>
        reject(new SmtpTransientError(`STARTTLS handshake with ${config.host} failed: ${err.message}`));
      secured.once('error', onError);
      secured.once('secureConnect', () => {
        secured.removeListener('error', onError);
        resolve();
      });
    });
    this.socket = secured;
    this.bind(secured);
    return secured;
  }

  // Called once the conversation is over so a close is not read as a fault.
  finish(): void {
    this.finished = true;
    this.socket.end();
  }

  destroy(): void {
    this.finished = true;
    this.socket.destroy();
  }
}

function openSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({
          host: config.host,
          port: config.port,
          servername: config.host,
          rejectUnauthorized: config.rejectUnauthorized,
        })
      : netConnect({ host: config.host, port: config.port });
    const settle = (err?: Error): void => {
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onError = (err: Error): void =>
      settle(new SmtpTransientError(`Cannot reach the SMTP server at ${config.host}:${config.port}: ${err.message}`));
    const onTimeout = (): void =>
      settle(new SmtpTransientError(`Timed out connecting to ${config.host}:${config.port}`));
    socket.once('error', onError);
    socket.setTimeout(config.timeoutMs);
    socket.once('timeout', onTimeout);
    socket.once(config.secure ? 'secureConnect' : 'connect', () => settle());
  });
}

// EHLO capabilities: keyword -> its parameters, both upper-cased.
function parseCapabilities(reply: Reply): Map<string, string[]> {
  const caps = new Map<string, string[]>();
  for (const line of reply.lines.slice(1)) {
    const [keyword, ...params] = line.trim().split(/\s+/);
    if (keyword) caps.set(keyword.toUpperCase(), params.map((p) => p.toUpperCase()));
  }
  return caps;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function greet(session: Session, config: SmtpConfig): Promise<Map<string, string[]>> {
  try {
    const reply = await session.command(`EHLO ${config.clientName}`, (c) => c === 250, 'EHLO');
    return parseCapabilities(reply);
  } catch (err) {
    // A server too old for EHLO answers 5xx; HELO still gets the mail through,
    // with no capabilities to work from.
    if (err instanceof SmtpPermanentError && err.command === 'EHLO') {
      await session.command(`HELO ${config.clientName}`, (c) => c === 250, 'HELO');
      return new Map();
    }
    throw err;
  }
}

async function authenticate(
  session: Session,
  config: SmtpConfig,
  caps: Map<string, string[]>,
): Promise<'PLAIN' | 'LOGIN'> {
  const user = config.user ?? '';
  const pass = config.pass ?? '';
  const offered = caps.get('AUTH') ?? [];
  // With no EHLO capabilities to go on (HELO fallback), PLAIN is the safe try.
  const usePlain = offered.length === 0 || offered.includes('PLAIN');
  if (!usePlain && !offered.includes('LOGIN')) {
    throw new SmtpPermanentError(`The SMTP server offers no AUTH mechanism Canon speaks: ${offered.join(', ')}`);
  }
  if (usePlain) {
    // RFC 4616: authorization identity, NUL, authentication identity, NUL, password.
    await session.command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, (c) => c === 235, 'AUTH PLAIN');
    return 'PLAIN';
  }
  await session.command('AUTH LOGIN', (c) => c === 334, 'AUTH LOGIN');
  await session.command(b64(user), (c) => c === 334, 'AUTH LOGIN (username)');
  await session.command(b64(pass), (c) => c === 235, 'AUTH LOGIN (password)');
  return 'LOGIN';
}

// Deliver one message. Resolves when the relay has taken responsibility for it
// (a 250 to the end of DATA) and rejects with a typed SmtpError otherwise.
export async function sendMail(config: SmtpConfig, envelope: MailEnvelope): Promise<SmtpDelivery> {
  const from = assertAddress(envelope.from, 'The envelope sender');
  const recipients = envelope.to.map((to) => assertAddress(to, 'The recipient'));
  if (recipients.length === 0) throw new SmtpPermanentError('The message names no recipient');

  const session = new Session(await openSocket(config), config.timeoutMs);
  let secure = config.secure;
  try {
    await session.expect((c) => c === 220, 'greeting');
    let caps = await greet(session, config);

    if (!config.secure && config.starttls !== 'off') {
      if (caps.has('STARTTLS')) {
        await session.command('STARTTLS', (c) => c === 220, 'STARTTLS');
        await session.upgrade(config);
        secure = true;
        caps = await greet(session, config); // capabilities are re-read after the upgrade
      } else if (config.starttls === 'required') {
        // Transient on purpose: an operator can fix the relay without the
        // queued notifications having been thrown away in the meantime.
        throw new SmtpTransientError(`${config.host} offers no STARTTLS but CANON_SMTP_URL requires it`);
      }
    }

    const auth = config.user ? await authenticate(session, config, caps) : null;

    await session.command(`MAIL FROM:<${from}>`, (c) => c === 250, 'MAIL FROM');
    for (const to of recipients) {
      await session.command(`RCPT TO:<${to}>`, (c) => c === 250 || c === 251, 'RCPT TO');
    }
    await session.command('DATA', (c) => c === 354, 'DATA');
    const payload = dotStuff(envelope.message);
    // The terminator is a bare "." on its own line; a message that already
    // ends in CRLF must not gain a blank line on the way out.
    session.writeRaw(payload + (payload.endsWith(CRLF) ? '' : CRLF) + '.' + CRLF);
    const accepted = await session.expect((c) => c === 250, 'the message body');

    try {
      await session.command('QUIT', (c) => c === 221, 'QUIT');
    } catch {
      // The mail is already accepted; a rude goodbye is not a delivery failure.
    }
    session.finish();
    return { code: accepted.code, response: accepted.text, secure, auth };
  } catch (err) {
    session.destroy();
    if (err instanceof SmtpError) throw err;
    throw new SmtpTransientError(`SMTP delivery failed: ${(err as Error).message}`);
  }
}
