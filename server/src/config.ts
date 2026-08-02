import { lookup } from 'node:dns/promises';
import { redactEnvValue } from './log.js';
import { EMBEDDING_MODES } from './embeddingproviders.js';

// Start-up configuration validation.
//
// Canon is configured entirely by environment variables, and several of them
// are only meaningful in combination. A deployment can therefore be *coherent
// in every individual setting and incoherent as a whole*: SSO turned on with no
// key to sign sessions with, the dev door left open beside a real identity
// provider, an allowlist naming a host that does not exist. Every one of those
// starts cleanly today and fails later — at the first sign-in, at the first
// restart behind a load balancer, at the first reference resolution — which is
// to say it fails in front of a partner rather than in front of an operator.
//
// So: the incoherent combinations are refusals, checked before the server
// binds a port, and each names the variable to change. The merely unwise ones
// are warnings, because a deployment that cannot start is worse than one that
// is told twice.
//
// The rule for deciding which is which: a REFUSAL is a configuration whose
// stated intent cannot be satisfied — the deployment asked for something that
// this process cannot do. A WARNING is a configuration that works exactly as
// asked and is probably not what was wanted.

export interface ConfigProblem {
  /** The variable to change. Always one the operator can act on. */
  variable: string;
  message: string;
}

export interface ConfigReport {
  problems: ConfigProblem[];
  warnings: ConfigProblem[];
  ok: boolean;
}

/** Injected so the DNS check is testable and offline tests stay offline. */
export type HostResolver = (hostname: string) => Promise<unknown>;

export interface ValidateOptions {
  resolve?: HostResolver;
  /** Skip the DNS check entirely. `CANON_SKIP_DNS_CHECK=true` sets it. */
  skipDns?: boolean;
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

const NUMERIC_VARS: { name: string; min: number }[] = [
  { name: 'PORT', min: 0 },
  { name: 'CANON_FLUSH_INTERVAL_MS', min: 0 },
  { name: 'CANON_FRESHNESS_INTERVAL_MS', min: 0 },
  { name: 'CANON_REGISTRY_TTL_MS', min: 0 },
  { name: 'CANON_REGISTRY_TIMEOUT_MS', min: 1 },
  { name: 'CANON_SOURCE_TIMEOUT_MS', min: 1 },
  { name: 'CANON_SESSION_TTL_MS', min: 1 },
  { name: 'CANON_SESSION_MAX_LIFETIME_MS', min: 1 },
  { name: 'CANON_OIDC_TIMEOUT_MS', min: 1 },
  { name: 'CANON_OIDC_CLOCK_TOLERANCE_SEC', min: 0 },
  { name: 'CANON_SHUTDOWN_TIMEOUT_MS', min: 0 },
];

/** Hosts in an allowlist entry that a DNS check can meaningfully be run on. */
function resolvableHosts(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // A full URL is accepted by outbound.ts and reduced to its host; do the same.
      const withoutScheme = entry.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
      const host = withoutScheme.split('/')[0] ?? '';
      // `host:port` — but not an IPv6 literal, which is bracketed.
      if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
      const parts = host.split(':');
      return parts.length === 2 && /^\d+$/.test(parts[1] ?? '') ? parts[0]! : host;
    })
    .filter((host) => {
      if (!host) return false;
      if (host.startsWith('*.')) return false; // a wildcard names no one host
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // literal address
      if (/^[0-9a-fA-F:]+$/.test(host) && host.includes(':')) return false; // IPv6 literal
      return true;
    });
}

/**
 * Check a deployment's environment for combinations that cannot mean what they
 * say. Async only because of the DNS check; everything else is local.
 */
export async function validateConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateOptions = {},
): Promise<ConfigReport> {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const refuse = (variable: string, message: string): void => void problems.push({ variable, message });
  const warn = (variable: string, message: string): void => void warnings.push({ variable, message });

  const issuer = trimmed(env, 'CANON_OIDC_ISSUER');
  const devAuth = (env.CANON_DEV_AUTH ?? '').trim().toLowerCase() === 'true';
  const registry = trimmed(env, 'CANON_REGISTRY_URL');
  const sessionSecret = trimmed(env, 'CANON_SESSION_SECRET');
  const baseUrl = trimmed(env, 'CANON_BASE_URL');

  // --- the doors ---------------------------------------------------------

  // SSO with no key to sign sessions with. The server currently warns and
  // invents a per-process key: survivable on one instance, and silently broken
  // behind a load balancer, where half the requests do not recognise the cookie
  // the other half issued. A deployment that has configured an identity
  // provider is not a development machine, so this is a refusal.
  if (issuer && !sessionSecret) {
    refuse(
      'CANON_SESSION_SECRET',
      'CANON_OIDC_ISSUER is set, so single sign-on is live, but no session secret is configured. ' +
        'Sessions would be signed with a key invented at start-up: every restart signs everybody out, ' +
        'and a second instance cannot read this one’s cookies. Set CANON_SESSION_SECRET to a long random string.',
    );
  }

  // The dev door beside a real one. SECURITY.md §5 assumption 1 says the one
  // thing a deployment must get right is not setting CANON_DEV_AUTH; a
  // deployment that has gone to the trouble of configuring an identity provider
  // and *also* left the unverified header on has not made a choice, it has made
  // a mistake, and every authorization control in Canon is downstream of it.
  if (devAuth && issuer) {
    refuse(
      'CANON_DEV_AUTH',
      'CANON_DEV_AUTH=true together with CANON_OIDC_ISSUER: an identity provider is configured, and the ' +
        'unverified X-Actor-Id header is accepted alongside it, so anyone who can reach the port is any ' +
        'actor they name. Unset CANON_DEV_AUTH (see SECURITY.md §5, assumption 1).',
    );
  }
  if (devAuth && registry) {
    warn(
      'CANON_DEV_AUTH',
      'CANON_DEV_AUTH=true together with CANON_REGISTRY_URL: a real Agent Registry is configured, and ' +
        'X-Actor-Id is still believed without verification. This is the demo stack’s shape; it is not a deployment’s.',
    );
  }
  if (issuer) {
    if (!trimmed(env, 'CANON_OIDC_CLIENT_ID')) {
      refuse('CANON_OIDC_CLIENT_ID', 'CANON_OIDC_ISSUER is set, so a client id is required.');
    }
    if (!trimmed(env, 'CANON_OIDC_CLIENT_SECRET')) {
      refuse('CANON_OIDC_CLIENT_SECRET', 'CANON_OIDC_ISSUER is set, so a client secret is required.');
    }
    if (!baseUrl && !trimmed(env, 'CANON_OIDC_REDIRECT_URI')) {
      refuse(
        'CANON_BASE_URL',
        'CANON_OIDC_ISSUER is set but neither CANON_BASE_URL nor CANON_OIDC_REDIRECT_URI is: the redirect ' +
          'URI would default to http://localhost:3000/auth/callback, which no provider outside this machine ' +
          'can send a person back to.',
      );
    }
  }
  if (sessionSecret && sessionSecret.length < 16) {
    warn(
      'CANON_SESSION_SECRET',
      `the session secret is ${sessionSecret.length} characters; use at least 32 random ones. ` +
        'It is an HMAC key, and a short one is guessable.',
    );
  }
  if (!issuer && !devAuth && !registry) {
    warn(
      'CANON_OIDC_ISSUER',
      'no door is open: set CANON_OIDC_ISSUER (people), CANON_REGISTRY_URL (agents) or CANON_DEV_AUTH ' +
        '(development), or nobody can do anything.',
    );
  }

  // --- URLs --------------------------------------------------------------

  for (const name of ['CANON_BASE_URL', 'CANON_OIDC_ISSUER', 'CANON_OIDC_REDIRECT_URI', 'CANON_REGISTRY_URL']) {
    const value = trimmed(env, name);
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        refuse(name, `${name}=${redactEnvValue(name, value)} is not an http(s) URL.`);
      }
    } catch {
      refuse(name, `${name}=${redactEnvValue(name, value)} is not a URL.`);
    }
  }
  if (baseUrl && baseUrl.startsWith('http://') && issuer) {
    warn(
      'CANON_BASE_URL',
      'CANON_BASE_URL is plain http and single sign-on is live: the session cookie will not carry Secure, ' +
        'so it crosses the network in clear. Terminate TLS in front of Canon and set an https base URL.',
    );
  }

  // --- email -------------------------------------------------------------

  if (trimmed(env, 'CANON_SMTP_URL') && !trimmed(env, 'CANON_MAIL_FROM')) {
    refuse(
      'CANON_MAIL_FROM',
      'CANON_SMTP_URL is set, so notifications go out by email, but no sender address is configured. ' +
        'An email needs a From.',
    );
  }
  if (trimmed(env, 'CANON_SMTP_URL') && !baseUrl) {
    warn(
      'CANON_BASE_URL',
      'CANON_SMTP_URL is set but CANON_BASE_URL is not: every deep link in every notification email will ' +
        'point at http://localhost:3000.',
    );
  }
  if (trimmed(env, 'CANON_SMTP_URL') && Number(env.CANON_FLUSH_INTERVAL_MS ?? '') === 0 && env.CANON_FLUSH_INTERVAL_MS) {
    warn(
      'CANON_FLUSH_INTERVAL_MS',
      'the outbox timer is off: nothing is delivered until something calls POST /notifications/flush. ' +
        'That is a supported arrangement, and it means your scheduler now owns notification delivery.',
    );
  }

  // --- numbers -----------------------------------------------------------

  for (const { name, min } of NUMERIC_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
      refuse(name, `${name}=${raw} is not a number ${min > 0 ? `of at least ${min}` : 'of zero or more'}.`);
    }
  }

  // --- maintenance -------------------------------------------------------

  // The sweep now runs by default, as Canon's own system actor, so an UNSET
  // maintenance actor is the recommended arrangement and warns about nothing.
  // The two things worth saying are the reverse of what this used to say.
  if (trimmed(env, 'CANON_MAINTENANCE_ACTOR_ID')) {
    warn(
      'CANON_MAINTENANCE_ACTOR_ID',
      'a maintenance actor is named, so every freshness flip will be attributed to it rather than to Canon’s ' +
        'own system actor. If it names a person, the audit log will say that person marked pages past review on ' +
        'days they did nothing of the kind. Unset it unless you deliberately want a service account’s name on ' +
        'this work.',
    );
  }
  if (Number(env.CANON_FRESHNESS_INTERVAL_MS ?? '') === 0 && env.CANON_FRESHNESS_INTERVAL_MS) {
    warn(
      'CANON_FRESHNESS_INTERVAL_MS',
      'the freshness timer is off: no review date flips anything until your scheduler calls ' +
        'POST /maintenance/freshness. That is a supported arrangement, and until that scheduler exists, ' +
        '"stale knowledge announces itself" is not true of this deployment.',
    );
  }

  // --- federation --------------------------------------------------------

  const allowed = trimmed(env, 'CANON_SOURCE_ALLOWED_HOSTS');
  if ((env.CANON_SOURCE_ALLOW_PRIVATE ?? '').trim().toLowerCase() === 'true' && issuer) {
    warn(
      'CANON_SOURCE_ALLOW_PRIVATE',
      'private, loopback and link-local addresses are reachable from a deployment with a real identity ' +
        'provider configured. That includes the cloud metadata address. This is a development setting ' +
        '(SECURITY.md F1).',
    );
  }
  if (allowed && !options.skipDns) {
    // An allowlist entry that does not resolve is a federation that cannot
    // work, and the failure would otherwise surface as a source resolving to an
    // error weeks later. Wildcards and literal addresses are skipped: there is
    // nothing to look up.
    const resolver = options.resolve ?? ((hostname: string) => lookup(hostname));
    for (const host of resolvableHosts(allowed)) {
      try {
        await resolver(host);
      } catch (err) {
        refuse(
          'CANON_SOURCE_ALLOWED_HOSTS',
          `${host} does not resolve (${(err as Error).message}). Canon would allow federation with a host ` +
            'it cannot reach, and every reference through it would fail at read time. Fix the name or remove it.',
        );
      }
    }
  }

  // --- semantic retrieval ------------------------------------------------
  //
  // The refusals here are the ones that would otherwise show up as an index
  // that is quietly empty: a page never embedded is a page the semantic channel
  // cannot reach, retrieval degrades to lexical without complaining, and
  // nothing on any screen says why answers got worse.

  const embeddings = (env.CANON_EMBEDDINGS ?? '').trim().toLowerCase();
  if (embeddings && embeddings !== 'local') {
    if (!EMBEDDING_MODES.includes(embeddings as (typeof EMBEDDING_MODES)[number])) {
      refuse('CANON_EMBEDDINGS', `"${embeddings}" is not a mode; it must be one of ${EMBEDDING_MODES.join(', ')}.`);
    }
    if (!trimmed(env, 'CANON_EMBEDDINGS_MODEL')) {
      refuse('CANON_EMBEDDINGS_MODEL', 'CANON_EMBEDDINGS names a real provider, so the model must be named.');
    }
    const width = Number(env.CANON_EMBEDDINGS_DIMENSIONS ?? '');
    if (!Number.isInteger(width) || width < 1) {
      refuse(
        'CANON_EMBEDDINGS_DIMENSIONS',
        'the width of the model’s vectors must be stated, and it must match what the model actually ' +
          'returns. Canon checks every answer against it rather than storing vectors of mixed width.',
      );
    }
    if (embeddings === 'http') {
      const url = trimmed(env, 'CANON_EMBEDDINGS_URL');
      if (!url) {
        refuse('CANON_EMBEDDINGS_URL', 'CANON_EMBEDDINGS=http, so the endpoint must be given.');
      } else {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          refuse('CANON_EMBEDDINGS_URL', `${url} is not a URL.`);
        }
        // The whole of the record's published text goes through this endpoint,
        // a page at a time, for ever. Over plain http it goes in the clear.
        if (parsed && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
          warn(
            'CANON_EMBEDDINGS_URL',
            'the embedding endpoint is plain http and is not on this machine. Every published page in the ' +
              'record is sent to it, so every published page crosses the network in the clear. Use https, ' +
              'or run the model on this host.',
          );
        }
      }
    }
  }

  return { problems, warnings, ok: problems.length === 0 };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Thrown when a deployment's configuration cannot mean what it says. */
export class ConfigError extends Error {
  constructor(readonly problems: ConfigProblem[]) {
    super(
      'Veryl Canon refused to start: the configuration is incoherent.\n\n' +
        problems.map((p) => `  ${p.variable}\n    ${p.message}`).join('\n\n') +
        '\n\nSee CONFIGURATION.md for every variable, and OPERATIONS.md for a first-hour checklist.',
    );
    this.name = 'ConfigError';
  }
}

/** Validate, or refuse to boot. Warnings are returned for the caller to log. */
export async function assertConfigValid(
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateOptions = {},
): Promise<ConfigProblem[]> {
  const skipDns = options.skipDns ?? (env.CANON_SKIP_DNS_CHECK ?? '').trim().toLowerCase() === 'true';
  const report = await validateConfig(env, { ...options, skipDns });
  if (!report.ok) throw new ConfigError(report.problems);
  return report.warnings;
}
