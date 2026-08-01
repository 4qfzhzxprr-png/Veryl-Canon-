import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './db.js';
import { redactUrl, Throttle, type Logger } from './log.js';
import { schemaStatus, type Migration } from './migrate.js';
import { SYSTEM_ACTOR_ID } from './system.js';

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
//                 record answers a real read, the file it lives in is still a
//                 record, its schema is the one this binary was built for, the
//                 audit chain is in place, and every door the deployment
//                 configured actually resolves. A `false` here means "take me
//                 out of the pool", which is a different and much cheaper act
//                 than a restart.
//
// A PROBE THAT LIES IS WORSE THAN NO PROBE (USER-TESTING.md T3.3). An
// administrator corrupted the record underneath a running Canon and got three
// green lights: `/health` 200, `/ready` 200 saying `database ok=true`, and a
// silent log, while every request was refused. The reason is worth writing
// down, because it is a property of SQLite and not a slip: an open connection
// answers out of its own page cache. `SELECT count(*) FROM collections` on a
// warm connection is a read of this process's memory, not of the record. The
// file underneath can be overwritten byte for byte and that query keeps
// returning the same number.
//
// So the record is checked twice, deliberately:
//
//   database     Real rows, read through the connection Canon serves from —
//                one per storage lifecycle (DATA-BACKBONE.md §4), plus the
//                session table a signed-in person's every request goes
//                through. This is the half that catches a closed handle, a
//                locked record, a table a migration did not create, and a
//                working set too large to have stayed in cache.
//   record_file  A short-lived read-only connection opened on the path itself,
//                which by construction has no cache to answer from. This is
//                the half that would have been RED in T3.3. It costs one open
//                and two indexed reads per readiness answer, which is to say
//                nothing, and it is the only way to find out whether the file
//                this process would restart from — and every backup taken of
//                it — is still a database.
//
// Readiness is unauthenticated, exactly as `/health` is, and for the same
// reason: a load balancer has no credential. So it discloses nothing but
// booleans, version numbers, and the host names already in the deployment's own
// configuration — never a record value, never a count of anything, never the
// record's path on disk (SECURITY.md R7), and URLs go through the log redactor
// before they are printed, so a credentialed URL cannot leak through a probe.

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

/**
 * The connection Canon serves from reads the record.
 *
 * Rows, not a count. A count can be answered from an index or from a page this
 * process cached hours ago; a row has to be found and its payload read. One
 * read per storage lifecycle (DATA-BACKBONE.md §4) — the current record, its
 * immutable history — plus two that earn their place:
 *
 *   * the SYSTEM ACTOR row, which `openDb` guarantees exists. It is the only
 *     row in the record whose absence is unambiguously a fault rather than an
 *     empty Canon, so it is the one sentinel here that can be asserted on.
 *   * AUTH_SESSIONS, where the deployment has one. This is the table every
 *     request from a signed-in person passes through, and in T3.3 it is what
 *     stopped answering: no session resolved, so Canon answered 401 to
 *     everybody, correctly and uselessly, while claiming to be ready.
 *
 * Still not a deep check — a probe is not a test. `GET /audit/verify` walks the
 * chain; `PRAGMA integrity_check` reads every page. Neither belongs on a path a
 * load balancer hits every second.
 */
export function databaseCheck(db: DatabaseSync): ReadinessCheck {
  return {
    name: 'database',
    run(): CheckResult {
      try {
        const actor = db.prepare('SELECT id, kind, name FROM actors WHERE id = ?').get(SYSTEM_ACTOR_ID) as
          | { id: string }
          | undefined;
        if (!actor) {
          return {
            name: 'database',
            ok: false,
            detail: `unreadable: the record holds no ${SYSTEM_ACTOR_ID} row, which every open creates`,
          };
        }
        db.prepare('SELECT id, name, created_at FROM collections ORDER BY id LIMIT 1').get();
        db.prepare('SELECT id, action, at FROM audit_events ORDER BY id DESC LIMIT 1').get();
        if (hasTable(db, 'auth_sessions')) db.prepare('SELECT id, actor_id FROM auth_sessions LIMIT 1').get();
        return { name: 'database', ok: true, detail: 'the open connection reads the record' };
      } catch (err) {
        return { name: 'database', ok: false, detail: `unreadable: ${(err as Error).message}` };
      }
    },
  };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

/** `:memory:` and the anonymous temporary database have no file to read. */
function isMemoryRecord(path: string): boolean {
  const trimmed = path.trim();
  return trimmed === '' || trimmed === ':memory:' || trimmed.startsWith('file::memory:');
}

/**
 * The record ON DISK opens and answers, read through a connection that has
 * never cached a page of it.
 *
 * This is the check T3.3 was missing. `sqlite_master` first, because it is the
 * record's own table of contents and a file whose schema will not parse is not
 * a record whatever else it may still contain; then the sentinel actor and a
 * collection, so the read reaches past page one into the data.
 *
 * Read-only, opened and closed inside the check. WAL takes any number of
 * readers, so this cannot block the writer, and nothing it holds outlives it.
 */
export function recordFileCheck(path: string): ReadinessCheck {
  return {
    name: 'record_file',
    run(): CheckResult {
      if (isMemoryRecord(path)) {
        return { name: 'record_file', ok: true, detail: 'the record is in memory: there is no file to read' };
      }
      let reader: DatabaseSync | null = null;
      try {
        reader = new DatabaseSync(path, { readOnly: true });
        // A checkpoint takes a brief exclusive lock, and a readiness probe that
        // flaps to 503 every time a backup runs is a probe an operator learns
        // to ignore. Half a second of patience; a record that is merely busy is
        // not a record that is unreadable.
        reader.exec('PRAGMA busy_timeout = 500');
        const tables = reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as
          | { n: number }
          | undefined;
        if (!tables || tables.n === 0) {
          return { name: 'record_file', ok: false, detail: 'the record file is unreadable: it holds no tables' };
        }
        reader.prepare('SELECT id FROM actors WHERE id = ?').get(SYSTEM_ACTOR_ID);
        reader.prepare('SELECT id FROM collections ORDER BY id LIMIT 1').get();
        return { name: 'record_file', ok: true, detail: 'the record file opens and answers' };
      } catch (err) {
        // Never the path: a readiness probe is unauthenticated, and an absolute
        // server filesystem path is exactly what SECURITY.md R7 took out of the
        // answers callers get.
        return {
          name: 'record_file',
          ok: false,
          detail: `the record file is unreadable: ${withoutPath((err as Error).message, path)}`,
        };
      } finally {
        try {
          reader?.close();
        } catch {
          // A connection that will not close is not news; the failure above is.
        }
      }
    },
  };
}

function withoutPath(message: string, path: string): string {
  return redactUrl(message.split(path).join('the record file'));
}

/**
 * The audit chain is in place, so an event written now would be chained.
 *
 * Not a verification — that is `GET /audit/verify`, and it walks the whole log.
 * This asks the cheap question that a probe can answer: is the metadata row
 * there, and is the AFTER INSERT trigger that writes a link still attached? A
 * Canon serving requests without them appends unchained events, and the gap it
 * leaves in a tamper-evident log cannot be filled in afterwards (auditchain.ts
 * says why at length). That is a process that must not be in the pool.
 */
export function auditChainCheck(db: DatabaseSync): ReadinessCheck {
  return {
    name: 'audit_chain',
    run(): CheckResult {
      try {
        const meta = db.prepare('SELECT format, algorithm FROM audit_chain_meta WHERE id = 1').get() as
          | { format: string; algorithm: string }
          | undefined;
        if (!meta) {
          return { name: 'audit_chain', ok: false, detail: 'no chain metadata: events would be appended unchained' };
        }
        const trigger = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_chain_link'")
          .get() as { name: string } | undefined;
        if (!trigger) {
          return {
            name: 'audit_chain',
            ok: false,
            detail: 'the audit_chain_link trigger is gone: events would be appended unchained',
          };
        }
        db.prepare('SELECT event_id FROM audit_chain ORDER BY event_id DESC LIMIT 1').get();
        return { name: 'audit_chain', ok: true, detail: `${meta.format}/${meta.algorithm}, link trigger in place` };
      } catch (err) {
        return { name: 'audit_chain', ok: false, detail: `unreadable: ${(err as Error).message}` };
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
 * The checks that are about the record itself, and are therefore local, cheap
 * and safe to run on a timer. Split out from the doors on purpose: the record
 * watch below runs these every few seconds, and asking somebody else's identity
 * provider that often would be rude at best.
 */
export function recordChecks(
  db: DatabaseSync,
  options: { path?: string; migrations?: readonly Migration[] } = {},
): ReadinessCheck[] {
  return [
    databaseCheck(db),
    recordFileCheck(options.path ?? ':memory:'),
    schemaCheck(db, options.migrations ?? MIGRATIONS),
    auditChainCheck(db),
  ];
}

/**
 * Build the checks a deployment's configuration implies: always the record, its
 * file, its schema and its audit chain; the identity provider's discovery
 * document when SSO is configured; the Registry when agents are.
 */
export function readinessChecksFromEnv(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch; migrations?: readonly Migration[]; path?: string } = {},
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = recordChecks(db, {
    path: options.path ?? env.CANON_DB ?? 'canon.db',
    migrations: options.migrations,
  });
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

// ---------------------------------------------------------------------------
// Finding out
// ---------------------------------------------------------------------------
//
// A readiness answer is only ever as loud as somebody asking for it. In T3.3
// nobody was: the orchestrator was pointed at `/health`, so a Canon that could
// not read its own record went on accepting connections and refusing every one
// of them, for as long as anybody cared to leave it running, and wrote nothing
// down. `/ready` being honest fixes the orchestrator's half. This fixes the
// operator's half — Canon asks itself the same question on a timer and says so
// out loud when the answer is no.
//
// WHAT IT DOES NOT DO IS EXIT, and that is a decision rather than an omission.
// Three candidate behaviours, and why this one:
//
//   REFUSE READINESS. Yes, and it is the load-bearing half: an orchestrator
//   takes the process out of the pool within a probe interval, which is the
//   act that actually stops traffic reaching a Canon that cannot serve it.
//
//   LOG AN ERROR PER FAILURE, RATE LIMITED. Yes. Every failure is a line the
//   first time and once a minute thereafter, carrying how many were held back,
//   so the disk cannot be filled by a fault that repeats every ten seconds —
//   and filling the disk of a machine whose database is already broken would
//   take away the operator's last tool.
//
//   EXIT. No. Restarting does not repair a corrupt file, so exiting buys a
//   crash loop: the record stays broken, `/ready` stops being answerable, the
//   log the operator needs scrolls away in a restart storm, and a container
//   platform's backoff turns a five-minute diagnosis into an hour. Canon's own
//   rule at the top of this file says a liveness failure means "restart me" and
//   must never mean "something I depend on is unwell"; the record is the thing
//   Canon depends on most. So the process stays up, keeps answering `/health`
//   (it is alive — that is all liveness ever claimed), answers `/ready` 503 with
//   the failing check named, and repeats the reason in the log until somebody
//   comes. A deployment that would rather have the process die can act on the
//   503, which is a decision it gets to make and Canon does not.

export interface RecordWatchOptions {
  /** How often to ask. Default 10s; `0` turns the timer off. */
  intervalMs?: number;
  /** How often the same failing check may repeat itself in the log. Default 60s. */
  repeatAfterMs?: number;
  log: Logger;
  now?: () => number;
}

export interface RecordWatch {
  /** Held so shutdown can clear it; `null` when the watch is turned off. */
  timer: NodeJS.Timeout | null;
  /** One pass, now. Runs at start-up and on every tick; exported for tests. */
  pass(): Promise<ReadinessReport>;
  stop(): void;
}

/**
 * Ask the record's own checks on a timer, and say so when the answer is no.
 *
 * The first failure of a check is logged immediately, at `error`, so it reaches
 * stderr and whatever an operator alerts on. Repeats are counted and folded
 * into the next line past the window. A check that starts passing again says
 * so once, at `info`, because "it came back at 14:02" is the other half of the
 * story and an operator reading only errors would never get it.
 */
export function startRecordWatch(checks: readonly ReadinessCheck[], options: RecordWatchOptions): RecordWatch {
  const intervalMs = options.intervalMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const throttle = new Throttle(options.repeatAfterMs ?? 60_000, now);
  const log = options.log;
  const failing = new Map<string, number>(); // check name -> consecutive failures

  async function pass(): Promise<ReadinessReport> {
    const report = await runReadiness(checks);
    for (const result of report.checks) {
      if (result.ok) {
        const consecutive = failing.get(result.name);
        if (consecutive !== undefined) {
          failing.delete(result.name);
          throttle.reset(result.name);
          log.info('the record reads again', { check: result.name, afterFailures: consecutive });
        }
        continue;
      }
      const consecutive = (failing.get(result.name) ?? 0) + 1;
      failing.set(result.name, consecutive);
      const speak = throttle.allow(result.name);
      if (!speak) continue;
      log.error('the record cannot be read', {
        check: result.name,
        detail: result.detail,
        consecutive,
        ...(speak.suppressed ? { suppressed: speak.suppressed } : {}),
        ready: false,
        // Said in the line rather than left to be looked up: whoever is reading
        // this at three in the morning is reading it out of an alert.
        note: 'GET /ready is answering 503 and this process is refusing traffic. Restarting will not repair a record; see OPERATIONS.md.',
      });
    }
    return report;
  }

  // The first pass is immediate, on the same argument as the freshness sweep's:
  // a Canon that has been broken since before it started must not have to wait
  // out an interval to say so.
  void pass();

  const timer = intervalMs > 0 ? setInterval(() => void pass(), intervalMs) : null;
  timer?.unref(); // never hold the process open on the watch alone
  return {
    timer,
    pass,
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
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
