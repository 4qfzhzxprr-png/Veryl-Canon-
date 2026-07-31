import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './db.js';
import { redactUrl } from './log.js';
import { schemaStatus, type Migration } from './migrate.js';

// Liveness and readiness are different questions, and answering both with
// `GET /health` is how a rolling deploy sends traffic to a process that is up
// and cannot serve.
//
//   GET /health   LIVENESS. The process is running and its event loop turns.
//                 Answers 200 while Canon is starting, while the database is
//                 locked, while the Registry is down. A `false` here means
//                 "restart me"; it must never mean "my dependency is unwell",
//                 because restarting Canon does not fix somebody else's outage.
//
//   GET /ready    READINESS. This process can serve a request right now: the
//                 record is reachable, its schema is the one this binary was
//                 built for, and every door the deployment configured actually
//                 resolves. A `false` here means "take me out of the pool",
//                 which is a different and much cheaper act than a restart.
//
// Readiness is unauthenticated, exactly as `/health` is, and for the same
// reason: a load balancer has no credential. So it discloses nothing but
// booleans, version numbers, and the host names already in the deployment's own
// configuration — never a record value, never a count of anything, and URLs go
// through the log redactor before they are printed, so a credentialed URL
// cannot leak through a probe.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessCheck {
  name: string;
  /**
   * `false` fails readiness. `optional` checks are reported and never fail it —
   * used for a dependency whose absence degrades Canon rather than stopping it.
   */
  optional?: boolean;
  run(): Promise<CheckResult> | CheckResult;
}

export interface ReadinessReport {
  ready: boolean;
  at: string;
  checks: CheckResult[];
}

/** The record is there and answers. Not a deep check: a probe is not a test. */
export function databaseCheck(db: DatabaseSync): ReadinessCheck {
  return {
    name: 'database',
    run(): CheckResult {
      try {
        const row = db.prepare('SELECT count(*) AS n FROM collections').get() as { n: number };
        return { name: 'database', ok: true, detail: `reachable, ${row.n} collection(s)` };
      } catch (err) {
        return { name: 'database', ok: false, detail: `unreadable: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * The schema this binary expects is the schema the record has. A process whose
 * migrations have not run — because it lost the race to another instance, or
 * because someone pointed it at the wrong file — will read columns that are not
 * there. It is up; it cannot serve.
 */
export function schemaCheck(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): ReadinessCheck {
  return {
    name: 'schema',
    run(): CheckResult {
      const status = schemaStatus(db, migrations);
      return {
        name: 'schema',
        ok: status.ok,
        detail: `version ${status.current}, expected ${status.expected}: ${status.detail}`,
      };
    },
  };
}

/**
 * A configured door that answers. `GET`s one URL with a short deadline; a door
 * Canon was told to use and cannot reach is a door people will bounce off.
 */
export function doorCheck(
  name: string,
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; optional?: boolean } = {},
): ReadinessCheck {
  const timeoutMs = options.timeoutMs ?? 2000;
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name,
    optional: options.optional,
    async run(): Promise<CheckResult> {
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        // Any HTTP answer means the door is there. A 401 from a Registry's
        // health face is still a Registry; a connection refused is not.
        return {
          name,
          ok: response.status < 500,
          detail: `${redactUrl(url)} answered ${response.status}`,
        };
      } catch (err) {
        return { name, ok: false, detail: `${redactUrl(url)} unreachable: ${redactUrl((err as Error).message)}` };
      }
    },
  };
}

/**
 * Build the checks a deployment's configuration implies: always the record and
 * its schema; the identity provider's discovery document when SSO is
 * configured; the Registry when agents are.
 */
export function readinessChecksFromEnv(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch; migrations?: readonly Migration[] } = {},
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [databaseCheck(db), schemaCheck(db, options.migrations ?? MIGRATIONS)];
  const issuer = env.CANON_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  if (issuer) {
    checks.push(
      doorCheck('identity_provider', `${issuer}/.well-known/openid-configuration`, {
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  const registry = env.CANON_REGISTRY_URL?.trim().replace(/\/+$/, '');
  if (registry) {
    checks.push(doorCheck('agent_registry', `${registry}/health`, { fetchImpl: options.fetchImpl }));
  }
  return checks;
}

export async function runReadiness(checks: readonly ReadinessCheck[]): Promise<ReadinessReport> {
  const results = await Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      try {
        return await check.run();
      } catch (err) {
        return { name: check.name, ok: false, detail: `check threw: ${(err as Error).message}` };
      }
    }),
  );
  const ready = results.every((result, i) => result.ok || checks[i]!.optional === true);
  return { ready, at: new Date().toISOString(), checks: results };
}

export interface ReadinessOptions {
  path?: string;
  /**
   * How long an answer may be reused. A probe every second must not become a
   * request to the identity provider every second; a few seconds of staleness
   * on a readiness answer costs nothing and a hammered IdP costs a lot.
   */
  cacheMs?: number;
  now?: () => number;
}

/**
 * Wrap a server so `GET /ready` is answered before anything else sees it — the
 * same seam `attachStatic` uses, and deliberately outside `api.ts`'s route
 * table: readiness is a property of the *process*, not a route of the record,
 * and an unclassified route is refused to every agent by the rule that already
 * refuses every unclassified route.
 */
export function attachReadiness(
  server: Server,
  checks: readonly ReadinessCheck[],
  options: ReadinessOptions = {},
): Server {
  const path = options.path ?? '/ready';
  const cacheMs = options.cacheMs ?? 3000;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; report: ReadinessReport } | null = null;

  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://canon').pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === path) {
      void (async () => {
        if (!cached || now() - cached.at > cacheMs) {
          cached = { at: now(), report: await runReadiness(checks) };
        }
        const body = JSON.stringify(cached.report);
        res.writeHead(cached.report.ready ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      })();
      return;
    }
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}
