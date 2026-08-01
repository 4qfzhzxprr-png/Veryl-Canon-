// Structured, leveled logging to stdout.
//
// Three rules, and the third is the one that matters.
//
//   1. STDOUT, one event per line. A container's log is whatever the process
//      writes to stdout; a deployment that has to configure a file path, rotate
//      it, and ship it is a deployment with a second failure mode. Errors go to
//      stderr, which is the one distinction a supervisor actually reads.
//
//   2. LEVELED, and the level is a level, not a prefix. `CANON_LOG_LEVEL`
//      (debug|info|warn|error) decides what is emitted at all.
//
//   3. NO SECRETS, EVER, AND NOT BY CONVENTION. A URL with credentials in it —
//      `smtp://canon:hunter2@relay.internal:587` — is the single most likely
//      secret to end up in a log line, because it is *configuration* and
//      configuration is what a start-up banner prints. So this module redacts
//      rather than trusting the caller to: every string value that goes through
//      it is scrubbed of userinfo and of anything that looks like a bearer
//      token or a passport, and the known-secret environment variables have
//      their values replaced with `[redacted]` by name. SECURITY.md F7 fixed
//      one instance of this by hand; this makes the next one impossible to
//      write by accident.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Variables whose *value* is a secret. Named rather than pattern-matched, so
 * adding a secret to the configuration is a decision that shows up here.
 * CONFIGURATION.md marks each of these "secret".
 */
export const SECRET_ENV_VARS: readonly string[] = [
  'CANON_SESSION_SECRET',
  'CANON_OIDC_CLIENT_SECRET',
  'CANON_SMTP_URL', // carries relay credentials in its userinfo
];

const REDACTED = '[redacted]';

/**
 * Strip credentials out of a URL, keeping enough to be useful: scheme, host,
 * port and path survive; the user and password do not. A string that is not a
 * URL comes back with any `scheme://user:pass@` run scrubbed anyway, because a
 * log line is usually a sentence with a URL in the middle of it.
 */
export function redactUrl(value: string): string {
  return value.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]*)@/g, (_m, scheme: string, userinfo: string) => {
    const user = userinfo.split(':')[0] ?? '';
    return user ? `${scheme}${user}:${REDACTED}@` : `${scheme}${REDACTED}@`;
  });
}

/**
 * Everything a log line goes through. Credentials in URLs, `Bearer …` tokens,
 * anything spelled like a passport or a secret in a `key=value` pair.
 */
export function redact(value: string): string {
  return redactUrl(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(passport|secret|password|client_secret|api[_-]?key|token)(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
      (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`,
    );
}

/** The value of an environment variable, safe to print. */
export function redactEnvValue(name: string, value: string | undefined): string {
  if (value === undefined) return '(unset)';
  if (SECRET_ENV_VARS.includes(name)) return value ? REDACTED : '(empty)';
  return redact(value);
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return depth > 4 ? '[…]' : value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_ENV_VARS.includes(key) || /secret|password|passport|token/i.test(key)
        ? REDACTED
        : scrub(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogEvent {
  at: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** `json` for a log collector, `text` for a person reading a terminal. */
  format?: 'json' | 'text';
  /** Where a line goes. The default writes to stdout, errors to stderr. */
  sink?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export class Logger {
  private readonly threshold: number;
  private readonly format: 'json' | 'text';
  private readonly sink: (line: string, level: LogLevel) => void;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.threshold = ORDER[options.level ?? 'info'];
    this.format = options.format ?? 'json';
    this.sink = options.sink ?? defaultSink;
    this.now = options.now ?? (() => new Date());
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < this.threshold) return;
    const event: LogEvent = {
      at: this.now().toISOString(),
      level,
      msg: redact(msg),
      ...(scrub(fields) as Record<string, unknown>),
    };
    this.sink(this.format === 'json' ? JSON.stringify(event) : formatText(event), level);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
}

function formatText(event: LogEvent): string {
  const { at, level, msg, ...rest } = event;
  const tail = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `${at} ${level.toUpperCase().padEnd(5)} ${msg}${tail ? ' ' + tail : ''}`;
}

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

/** The process logger, built from the environment once. */
export function loggerFromEnv(env: NodeJS.ProcessEnv = process.env): Logger {
  const format = (env.CANON_LOG_FORMAT ?? '').trim().toLowerCase() === 'text' ? 'text' : 'json';
  return new Logger({ level: parseLevel(env.CANON_LOG_LEVEL), format });
}

// ---------------------------------------------------------------------------
// Saying the same thing over and over
// ---------------------------------------------------------------------------

/**
 * One line per window per key, and a count of what was held back.
 *
 * A failure that repeats on a timer is the failure most worth logging and the
 * one most able to fill a disk: a record that cannot be read fails every check,
 * every few seconds, for as long as nobody is looking. Silence would hide it and
 * a line per failure would bury it, so the first failure speaks immediately, the
 * rest are counted, and the next line past the window says how many there were.
 */
export class Throttle {
  private readonly last = new Map<string, { at: number; held: number }>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * `null` to stay quiet. Otherwise how many were suppressed since this key
   * last spoke — `0` the first time, so a caller can say "and 41 more like it".
   */
  allow(key: string): { suppressed: number } | null {
    const seen = this.last.get(key);
    const at = this.now();
    if (seen && at - seen.at < this.windowMs) {
      seen.held += 1;
      return null;
    }
    this.last.set(key, { at, held: 0 });
    return { suppressed: seen?.held ?? 0 };
  }

  /** Forget a key, so the next occurrence speaks immediately. */
  reset(key: string): void {
    this.last.delete(key);
  }
}

// ---------------------------------------------------------------------------
// One line per request
// ---------------------------------------------------------------------------
//
// USER-TESTING.md T3.4: there was nothing at all between "the server started"
// and "an unhandled error occurred", so an operator could not answer "is this
// thing serving traffic?" from the log. Now every request writes one line.
//
// WHAT IS IN IT, AND WHY THAT AND NOT MORE. The method, the path, the status,
// how long it took, the actor if one was resolved, and the correlation id a
// `500` handed to the caller — so a bug report quoting that id joins to the one
// line that describes the request that produced it.
//
// WHAT IS DELIBERATELY NOT IN IT:
//
//   * THE QUERY STRING, all of it, always. This is the whole of the privacy
//     decision and it is not a close call. `/search?q=…` and `/audit.csv?…`
//     carry what somebody typed, and SECURITY.md F2 already names a typed
//     question — an `answer.ask` event's text — as "often the most sensitive
//     sentence anybody types into Canon". `/auth/callback?code=…` carries a
//     live OpenID Connect authorization code. A rule of "log the query string
//     except where it is sensitive" is a rule somebody has to re-apply every
//     time a route gains a parameter, and the next parameter is the one that
//     gets it wrong. The path itself stays: every path parameter in Canon's
//     route table is an opaque id or a version number, which identifies a page
//     without disclosing a word of it.
//   * HEADERS. No cookie, no `X-Agent-Passport`, no `Authorization`. Nothing
//     here reads them, so none of them can arrive by accident.
//   * BODIES, in either direction. A request body is the draft somebody is
//     writing; a response body is the record.
//   * NAMES AND EMAIL ADDRESSES. The actor is its id, which is what the audit
//     log joins on anyway.
//
// Everything that is written still goes through `redact` on its way out, so
// even a path that somehow carried a token would not print one.

const REQUEST_NOTE = Symbol.for('veryl.canon.request-note');

/** What the layers underneath learn about a request that the wrapper cannot. */
export interface RequestNote {
  /** The actor the request resolved to. An id, never a name and never an email. */
  actor?: string;
  /** True when the actor arrived on an Agent Passport rather than as a person. */
  agent?: boolean;
  /** The correlation id handed to the caller with a `500`. */
  errorId?: string;
}

/**
 * Tell the request log something only the handler knows. Called from api.ts
 * once identity is settled, and again when a bug is caught. Merges, so two
 * calls do not lose each other.
 */
export function noteRequest(res: ServerResponse, note: RequestNote): void {
  const carrier = res as ServerResponse & { [REQUEST_NOTE]?: RequestNote };
  carrier[REQUEST_NOTE] = { ...carrier[REQUEST_NOTE], ...note };
}

export function requestNote(res: ServerResponse): RequestNote {
  return (res as ServerResponse & { [REQUEST_NOTE]?: RequestNote })[REQUEST_NOTE] ?? {};
}

export interface RequestLogOptions {
  /**
   * Paths logged at `debug` rather than `info`. The probes: a load balancer
   * asks every second, and an operator who turned request logging on to find
   * out whether Canon is serving people does not want to read a wall of
   * `GET /ready`.
   */
  quiet?: readonly string[];
  now?: () => number;
}

/** The pathname, with the query string cut off and the length bounded. */
export function requestPath(raw: string | undefined): string {
  const url = raw ?? '/';
  const cut = url.indexOf('?');
  const path = cut === -1 ? url : url.slice(0, cut);
  return path.length > 256 ? path.slice(0, 256) + '…' : path;
}

/**
 * `CANON_REQUEST_LOG=off` turns the request line off entirely, for a deployment
 * whose reverse proxy already writes one. The level is the other dial:
 * `CANON_LOG_LEVEL=warn` keeps the `5xx` lines and drops the rest.
 */
export function requestLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CANON_REQUEST_LOG ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Wrap a server so every request it answers writes one line. The same seam
 * `attachStatic` and `attachReadiness` use, and applied OUTSIDE both of them, so
 * a static file and a readiness probe are logged exactly as an API call is.
 */
export function attachRequestLog(server: Server, log: Logger, options: RequestLogOptions = {}): Server {
  const quiet = new Set(options.quiet ?? ['/health', '/ready']);
  const now = options.now ?? (() => Date.now());

  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    const method = (req.method ?? 'GET').toUpperCase();
    const path = requestPath(req.url);
    let written = false;
    const write = (aborted: boolean): void => {
      if (written) return;
      written = true;
      const note = requestNote(res);
      const status = res.statusCode;
      // A probe is a probe whatever it answers, and a `/ready` that has gone
      // 503 must not become a `warn` a second for as long as the fault lasts —
      // readiness has its own voice for that, and it is rate limited (ready.ts,
      // `startRecordWatch`). Everything else: a `5xx` is the deployment's
      // problem and belongs above the noise floor; the rest is the answer to
      // "is this thing serving traffic?".
      const level: LogLevel = quiet.has(path) ? 'debug' : status >= 500 ? 'warn' : 'info';
      log.log(level, 'request', {
        method,
        path,
        status,
        ms: now() - started,
        ...(note.actor ? { actor: note.actor } : {}),
        ...(note.agent ? { agent: true } : {}),
        ...(note.errorId ? { errorId: note.errorId } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
    };
    // `finish` is the answer having been written; `close` covers the caller who
    // hung up first, which is a request that happened and would otherwise be a
    // request that left no trace.
    res.on('finish', () => write(false));
    res.on('close', () => write(!res.writableFinished));
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}
