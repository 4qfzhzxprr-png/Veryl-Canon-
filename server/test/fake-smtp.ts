import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import type { SmtpConfig } from '../src/smtp.js';

// An in-process SMTP server that speaks enough of RFC 5321 to accept (or
// refuse) a message. It exists so the delivery tests exercise the real client
// over a real socket without ever touching a host outside this process.

// A throwaway self-signed certificate for 127.0.0.1, generated for these tests
// alone. It guards nothing: the tests connect with rejectUnauthorized false.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsKtKQXeCiwMbf
r9RbJ/1wvfi1RmHQKzqSpWszZ+n564fyClTKM7qAKwYd/I3LtIN99t1kilWlb4Rb
ZZwrUnkHJhCD1+kO/n5f8sevq4FxAR4YPWAZqun+HHEFBycWSLlvz0z0+GO5FXCO
iC9Ny4FhZ+poccHrMqYqRFg1xZdzCkFd1rY8D1gzYK3qeeRIjk/+wv+4oL5gfcT4
7cRiyAhBltZYAYxGizfhBvDuBKknwCJtqX7Amx3IPWv//mYSiXDMr967o/Pps14J
S5OfbyudllgwsHgZHvdjquVekCM/yhr3t8bve8zZ/sK4PGN7lbsys/lsBwBTBAw6
VJOJm8u7AgMBAAECggEAKq5nCwEq6k4uP1AAriSI0QVXfeEX6Jp+59H4dIMDX0DD
r/5drM8MIjAIUTDGGkUDABxOIFmnB99QibPz9k140YvfNkA1d9EhlTnDxUoYSeKE
CnBUvahAYA2++wcd6olW52AV7PkTB9RH1h3u1DNqPLKdSw1AjMU+qmXNFG+Kryro
kG4L7hoA3pAECpe42NERyaSXT3mD18JHdZHXu7u3JCcGBgDRz9VWJYo3N6kN4cfG
TYMOfvsUkzIjdeEX52TOp3K8Dar8AufO8CEqLlwp2FVbX0Wx7l36pVl0ZSKtm4rQ
mRgXa8Kz0YJOOkM6tfaW3BkwQiAhpPIBRzZkn2vkGQKBgQDW/Ft1VaiRxvw138i7
s/eubVN5hvQqjaYlcdse67xwKqqzmonud3nfFm+5fRQa1vJdw3PeVOxexjEP6MX7
hzmn8GKKJYjzQtdeAeDpBIskLG9FoYnZVTElS0PgpDfUf+5Bfcdy1VFFjQbX92tq
LmXWvi6BEmmbOQ15VPpqsAL5fQKBgQDNA0MfTeST1damCrouIlJdA9bnrhebqoja
COtkORUpEcyCVf6/0UFv0F4iOAGYn4eqRI6W0v2VjDE4Xq8tovucfEo//GXSF6Ig
xcGzrDO1LxTUsDEUV13JuSrAvnTQzV8V14XmN4jnAPzGNE5d05ptNoSM9HdQgZHC
Mbr4v16flwKBgQCiYo86e28OXXzXvKbEkNU+nTl2C+eV1NRwaCWYn3sARloVu18A
DqKxTSMquj1bYIxFIoL8pqy7kXwxhiM1MBjurvXfXyaoiA5g5Y5as6Hduup5b+DN
ljm+77Dfl2rMSa1PLpBePp5aqIFI04wA8fbeU1yRBbVbF6cDxJo5x6UXiQKBgGcr
ARg7xo9uyPn94/tbYj9Us00bmt3HT98JJgvlffSQ9G2SgQRedaOjI/vsW0FG5qqU
nXzg6KPdTNelLlq07hGtql/Q0ByNsBT176hPPCYtbzopAEnQPW5KNG2Sao65CuSe
9M8Jm2dEY/AKWnV1Cv1ytfmI/JIS4hrrk7+h7ig5AoGAVbpnmNAjA8aO6GMooIux
z+lw1m4HVBBSgEeJG0ab0L+kk//j3RwO0fJ2NWRgpbb/2OlmrFjudVrgCZIcptRb
jzJv7aGsxbw5MPXon1k8Hi1JRRT1xfyZCe/llLZJoLM2vqB2YtnY9UxamptTz3YN
hA31uNHAPACZLRnXBav+RhI=
-----END PRIVATE KEY-----
`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUQhBFS4ovebEu8DZ5erRdBwLWBjEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDczMDIzNDg1OFoYDzIxMjYw
NzA2MjM0ODU4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCsKtKQXeCiwMbfr9RbJ/1wvfi1RmHQKzqSpWszZ+n5
64fyClTKM7qAKwYd/I3LtIN99t1kilWlb4RbZZwrUnkHJhCD1+kO/n5f8sevq4Fx
AR4YPWAZqun+HHEFBycWSLlvz0z0+GO5FXCOiC9Ny4FhZ+poccHrMqYqRFg1xZdz
CkFd1rY8D1gzYK3qeeRIjk/+wv+4oL5gfcT47cRiyAhBltZYAYxGizfhBvDuBKkn
wCJtqX7Amx3IPWv//mYSiXDMr967o/Pps14JS5OfbyudllgwsHgZHvdjquVekCM/
yhr3t8bve8zZ/sK4PGN7lbsys/lsBwBTBAw6VJOJm8u7AgMBAAGjbzBtMB0GA1Ud
DgQWBBSuzs2JFVtNBWHPH/AYwkB2uxxKtTAfBgNVHSMEGDAWgBSuzs2JFVtNBWHP
H/AYwkB2uxxKtTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAW6neLBsibCRl+mj8OeSloz6mby4D
fj6CJsnCslL7GzrBU43Jjx+JypIJfulqGsb52tyF7B3iGM/+wjCfgd1cLyab+l8C
ZdfIhRy3fo3rhoQjeHkF2OebweTzAmgbWA+YlgTQ7OqOOsv+BB6yzisiynMssr7h
OCyFSc6EcFDayhwMCK1gYVbcwGFHdB4WFslBCw2M22mcNNnnuUx5dbbrTp79datF
Rw3POwFnAKkDnAj8nMTAp6jc02bV3bZW/h2Fji1ZEYM4yMCemFRQlW1cFBFcx/vF
jdqOMYmFbMnoPrLwJPN2VIne3UD2aBeSAt/Vf/dOB9nyYXrQrKCu/wUsAQ==
-----END CERTIFICATE-----
`;

// The receiving half of quoted-printable and of MIME, so the tests can read a
// captured message the way a mail client would rather than asserting against
// encoded text.
export function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const char = joined[i]!;
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(char, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface ParsedMail {
  headers: Record<string, string>;
  text: string;
  html: string;
  raw: string;
}

function splitHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  // Unfold: a continuation line starts with whitespace.
  for (const line of block.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

export function parseMail(raw: string): ParsedMail {
  const split = raw.indexOf('\r\n\r\n');
  const headers = splitHeaders(raw.slice(0, split));
  const body = raw.slice(split + 4);
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'] ?? '')?.[1];
  const parts: Record<string, string> = {};
  if (boundary) {
    for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
      const inner = chunk.replace(/^\r\n/, '');
      const at = inner.indexOf('\r\n\r\n');
      const partHeaders = splitHeaders(inner.slice(0, at));
      const type = (partHeaders['content-type'] ?? '').split(';')[0]!.trim();
      parts[type] = decodeQuotedPrintable(inner.slice(at + 4)).trimEnd();
    }
  }
  return { headers, text: parts['text/plain'] ?? '', html: parts['text/html'] ?? '', raw };
}

export interface CapturedMessage {
  from: string; // envelope sender, as given in MAIL FROM
  to: string[]; // envelope recipients
  data: string; // the message as the server received it, dots un-stuffed
  raw: string; // the DATA payload exactly as it arrived, still dot-stuffed
  auth: string | null; // 'PLAIN' or 'LOGIN' when the client authenticated
  secure: boolean; // did it arrive over TLS
  crlf: boolean; // every line of the message ended CRLF, as RFC 5321 requires
}

export interface FakeSmtpOptions {
  auth?: { user: string; pass: string };
  mechanisms?: ('PLAIN' | 'LOGIN')[]; // what EHLO advertises; default both
  tls?: 'none' | 'starttls' | 'direct';
  dataReply?: string; // reply to the end of DATA, e.g. '451 4.3.0 mailbox busy'
  mailFromReply?: string;
}

export interface FakeSmtp {
  port: number;
  messages: CapturedMessage[];
  config(overrides?: Partial<SmtpConfig>): SmtpConfig;
  url(extra?: string): string;
  close(): Promise<void>;
}

interface Conn {
  socket: Socket | TLSSocket;
  secure: boolean;
  buffer: string;
  mode: 'command' | 'data';
  lines: string[];
  raw: string[];
  from: string | null;
  to: string[];
  auth: string | null;
  login: { step: 'user' | 'pass'; user: string } | null;
  bareLf: boolean; // a message line arrived without its carriage return
}

export function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: CapturedMessage[] = [];
  const sockets = new Set<Socket | TLSSocket>();
  const mechanisms = options.mechanisms ?? ['PLAIN', 'LOGIN'];
  const tlsMode = options.tls ?? 'none';

  const say = (conn: Conn, line: string): void => {
    conn.socket.write(line + '\r\n');
  };

  const ehlo = (conn: Conn): void => {
    const lines = ['fake ESMTP at your service', 'SIZE 10485760', '8BITMIME'];
    if (tlsMode === 'starttls' && !conn.secure) lines.push('STARTTLS');
    if (options.auth) lines.push(`AUTH ${mechanisms.join(' ')}`);
    lines.forEach((line, i) => say(conn, `250${i === lines.length - 1 ? ' ' : '-'}${line}`));
  };

  const checkAuth = (conn: Conn, user: string, pass: string, mech: string): void => {
    if (options.auth && user === options.auth.user && pass === options.auth.pass) {
      conn.auth = mech;
      say(conn, '235 2.7.0 Authentication succeeded');
    } else {
      say(conn, '535 5.7.8 Authentication credentials invalid');
    }
  };

  const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

  const onCommand = (conn: Conn, line: string): void => {
    if (conn.login) {
      const step = conn.login;
      if (step.step === 'user') {
        conn.login = { step: 'pass', user: decode(line) };
        say(conn, '334 UGFzc3dvcmQ6');
      } else {
        conn.login = null;
        checkAuth(conn, step.user, decode(line), 'LOGIN');
      }
      return;
    }
    const [verbRaw, ...rest] = line.split(' ');
    const verb = (verbRaw ?? '').toUpperCase();
    const argument = rest.join(' ');
    switch (verb) {
      case 'EHLO':
        ehlo(conn);
        return;
      case 'HELO':
        say(conn, '250 fake');
        return;
      case 'STARTTLS': {
        if (tlsMode !== 'starttls' || conn.secure) {
          say(conn, '502 5.5.1 STARTTLS not available');
          return;
        }
        const plain = conn.socket;
        // Upgrade only once the 220 is on the wire, so no plaintext byte is
        // left behind for the TLS layer to trip over.
        plain.write('220 2.0.0 Ready to start TLS\r\n', () => {
          plain.removeAllListeners('data');
          const secured = new TLSSocket(plain as Socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
          sockets.add(secured);
          conn.socket = secured;
          conn.secure = true;
          secured.on('data', (chunk: Buffer) => onData(conn, chunk));
          secured.on('error', () => secured.destroy());
        });
        return;
      }
      case 'AUTH': {
        const [mechRaw, initial] = argument.split(' ');
        const mech = (mechRaw ?? '').toUpperCase();
        if (!options.auth || !mechanisms.includes(mech as 'PLAIN' | 'LOGIN')) {
          say(conn, '504 5.5.4 Unrecognized authentication type');
          return;
        }
        if (mech === 'PLAIN') {
          const [, user, pass] = decode(initial ?? '').split('\0');
          checkAuth(conn, user ?? '', pass ?? '', 'PLAIN');
          return;
        }
        conn.login = { step: 'user', user: '' };
        say(conn, '334 VXNlcm5hbWU6');
        return;
      }
      case 'MAIL': {
        if (options.mailFromReply) {
          say(conn, options.mailFromReply);
          return;
        }
        conn.from = /<([^>]*)>/.exec(argument)?.[1] ?? '';
        conn.to = [];
        say(conn, '250 2.1.0 Sender OK');
        return;
      }
      case 'RCPT':
        conn.to.push(/<([^>]*)>/.exec(argument)?.[1] ?? '');
        say(conn, '250 2.1.5 Recipient OK');
        return;
      case 'DATA':
        conn.mode = 'data';
        conn.lines = [];
        conn.raw = [];
        conn.bareLf = false;
        say(conn, '354 End data with <CR><LF>.<CR><LF>');
        return;
      case 'RSET':
        conn.from = null;
        conn.to = [];
        say(conn, '250 2.0.0 Reset');
        return;
      case 'NOOP':
        say(conn, '250 2.0.0 OK');
        return;
      case 'QUIT':
        say(conn, '221 2.0.0 Bye');
        conn.socket.end();
        return;
      default:
        say(conn, '500 5.5.2 Command unrecognized');
    }
  };

  const onDataLine = (conn: Conn, line: string): void => {
    if (line === '.') {
      conn.mode = 'command';
      const reply = options.dataReply ?? '250 2.0.0 Message accepted';
      if (reply.startsWith('2')) {
        messages.push({
          from: conn.from ?? '',
          to: [...conn.to],
          data: conn.lines.join('\r\n'),
          raw: conn.raw.join('\r\n'),
          auth: conn.auth,
          secure: conn.secure,
          crlf: !conn.bareLf,
        });
      }
      say(conn, reply);
      return;
    }
    conn.raw.push(line);
    // RFC 5321 §4.5.2, the receiving half of dot-stuffing.
    conn.lines.push(line.startsWith('..') ? line.slice(1) : line);
  };

  const onData = (conn: Conn, chunk: Buffer): void => {
    conn.buffer += chunk.toString('utf8');
    let index = conn.buffer.indexOf('\n');
    while (index !== -1) {
      const withEnding = conn.buffer.slice(0, index);
      const line = withEnding.replace(/\r$/, '');
      conn.buffer = conn.buffer.slice(index + 1);
      if (conn.mode === 'data') {
        if (line === withEnding) conn.bareLf = true; // no CR before the LF
        onDataLine(conn, line);
      } else {
        onCommand(conn, line);
      }
      index = conn.buffer.indexOf('\n');
    }
  };

  const connection = (socket: Socket | TLSSocket): void => {
    sockets.add(socket);
    const conn: Conn = {
      socket,
      secure: tlsMode === 'direct',
      buffer: '',
      mode: 'command',
      lines: [],
      raw: [],
      from: null,
      to: [],
      auth: null,
      login: null,
      bareLf: false,
    };
    socket.on('data', (chunk: Buffer) => onData(conn, chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    say(conn, '220 fake.canon.invalid ESMTP ready');
  };

  const server: Server =
    tlsMode === 'direct'
      ? createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => connection(socket))
      : createNetServer((socket) => connection(socket));

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        messages,
        config: (overrides = {}) => ({
          host: '127.0.0.1',
          port,
          secure: tlsMode === 'direct',
          starttls: tlsMode === 'starttls' ? 'required' : 'off',
          user: options.auth ? options.auth.user : null,
          pass: options.auth ? options.auth.pass : null,
          timeoutMs: 4000,
          rejectUnauthorized: false,
          clientName: 'canon.test',
          ...overrides,
        }),
        url: (extra = '') =>
          `${tlsMode === 'direct' ? 'smtps' : 'smtp'}://` +
          `${options.auth ? `${encodeURIComponent(options.auth.user)}:${encodeURIComponent(options.auth.pass)}@` : ''}` +
          `127.0.0.1:${port}/?insecure=true&starttls=${tlsMode === 'starttls' ? 'required' : 'off'}${extra}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
