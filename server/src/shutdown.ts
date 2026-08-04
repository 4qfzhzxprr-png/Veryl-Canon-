import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from './log.js';

// Graceful shutdown.
//
// `docker stop` sends SIGTERM and waits ten seconds before SIGKILL. Node
// installs no default handler for SIGTERM when it is PID 1, so an unhandled
// SIGTERM in a container is a process that dies at the ten-second mark, mid
// request, with a WAL it never checkpointed. What that costs Canon specifically:
// a half-written response to somebody publishing a policy, and a database file
// closed by the kernel rather than by SQLite.
//
// So, in order:
//
//   1. STOP ACCEPTING. New connections are refused at the listener; a request
//      that arrives on a connection already open is answered 503 with
//      `Connection: close`, so a load balancer moves on rather than retrying
//      into a closing process.
//   2. FINISH WHAT IS IN FLIGHT. Requests already being served run to
//      completion, up to a deadline (`CANON_SHUTDOWN_TIMEOUT_MS`, default 10s,
//      which sits inside `docker stop`'s own ten seconds on purpose).
//   3. CLEAR THE TIMERS. The outbox flush and the freshness sweep both touch
//      the database; either firing after it closes is an exception at exit.
//   4. CLOSE THE DATABASE. SQLite checkpoints the WAL on the last connection
//      closing. This is the step that makes the next start-up clean.
//
// The whole sequence is a function rather than only a signal handler, because a
// test that has to send itself SIGTERM to check its own shutdown is a test that
// can take the runner down with it.

export interface ShutdownOptions {
  server: Server;
  /** Cleared before the database closes. The flush and freshness timers. */
  timers?: NodeJS.Timeout[];
  /** Closing the database, and anything else that must happen after draining. */
  onDrained?: () => void | Promise<void>;
  /** How long in-flight requests get. Default 10s. */
  timeoutMs?: number;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Overridden by tests, which must not exit the runner. */
  exit?: (code: number) => void;
  /** Signals to listen for. Pass `[]` to install no handlers at all. */
  signals?: NodeJS.Signals[];
}

export interface ShutdownHandle {
  /** Run the sequence. Safe to call twice; the second call awaits the first. */
  shutdown(reason: string): Promise<void>;
  /** How many requests are being served right now. */
  inFlight(): number;
  /** True once shutdown has begun. */
  closing(): boolean;
}

/**
 * Wrap a server's request handling so in-flight requests can be counted and new
 * ones refused once shutdown starts. Same seam `attachStatic` and
 * `attachReadiness` use: the existing listeners are taken off and called by
 * ours, so nothing in `api.ts` changes.
 */
export function installGracefulShutdown(options: ShutdownOptions): ShutdownHandle {
  const { server } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let closing = false;
  let inFlight = 0;
  let drained: (() => void) | null = null;
  let running: Promise<void> | null = null;

  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (closing) {
      // Refused, not queued. A request accepted now would be one more thing to
      // wait for, and the answer to "are you taking work?" is already no.
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'shutting_down', message: 'Canon is shutting down; retry elsewhere' }));
      return;
    }
    inFlight++;
    const done = (): void => {
      inFlight--;
      if (inFlight === 0 && drained) drained();
    };
    let settled = false;
    const once = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    res.on('finish', once);
    res.on('close', once);
    for (const listener of inner) listener.call(server, req, res);
  });

  async function waitForDrain(): Promise<boolean> {
    if (inFlight === 0) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        drained = null;
        resolve(false);
      }, timeoutMs);
      timer.unref();
      drained = () => {
        clearTimeout(timer);
        drained = null;
        resolve(true);
      };
    });
  }

  async function shutdown(reason: string): Promise<void> {
    if (running) return running;
    running = (async () => {
      closing = true;
      log?.info('shutdown: stopping', { reason, inFlight });
      // Stop accepting. `close` waits for existing connections, so idle
      // keep-alive connections are shut immediately or nothing would finish.
      server.close();
      server.closeIdleConnections?.();
      const clean = await waitForDrain();
      if (!clean) {
        log?.warn('shutdown: in-flight requests did not finish in time', { inFlight, timeoutMs });
      }
      for (const timer of options.timers ?? []) clearInterval(timer);
      try {
        await options.onDrained?.();
      } catch (err) {
        log?.error('shutdown: closing the record failed', { error: (err as Error).message });
      }
      // Anything still holding a socket after the deadline is cut here, so the
      // process does not sit waiting on a client that never reads its answer.
      server.closeAllConnections?.();
      log?.info('shutdown: complete', { reason, clean });
      exit(clean ? 0 : 1);
    })();
    return running;
  }

  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  return {
    shutdown,
    inFlight: () => inFlight,
    closing: () => closing,
  };
}
