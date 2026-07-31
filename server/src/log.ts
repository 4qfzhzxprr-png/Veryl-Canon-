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
