import type { IncomingMessage, Server, ServerResponse } from 'node:http';

// Metrics, in the Prometheus text exposition format, with no dependency.
//
// The production-readiness review found Canon ran in production blind: health
// and readiness say whether it is up, but nothing said how much traffic it is
// serving, how fast, how often it refuses, or how big the record has grown.
// This is the smallest honest answer to that — a handful of counters, one
// latency histogram, and a few gauges read at scrape time — exposed at
// `/metrics` when a deployment turns it on.
//
// WHAT IS AND IS NOT HERE. No PII, no query strings, no page ids: request
// routes are NORMALISED to their shape (`/pages/:id`, not `/pages/<uuid>`), so
// a label set stays bounded and a metric never carries the identifier the
// redacting logger works to keep out of a log (log.ts). No secrets. It is
// aggregate operational data and nothing else, which is why it can be served
// without authentication — but it still reveals traffic shape, so it is
// OFF BY DEFAULT and a deployment that turns it on should let only its own
// scraper reach `/metrics` (CONFIGURATION.md).
//
// Deliberately small. No pull-in of a client library, no exemplars, no
// push-gateway: one process, one file, scraped where it stands.

export function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CANON_METRICS ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

// The histogram buckets, in SECONDS. The Prometheus default ladder, which spans
// the range a JSON API's latency actually lives in — a few milliseconds to a
// few seconds — with the model-backed answer path (several seconds) landing in
// the last real bucket rather than the overflow.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramState {
  counts: number[]; // one per bucket, cumulative computed at render
  sum: number;
  count: number;
}

/** A gauge whose value is read at scrape time, so it is never stale. */
interface GaugeProvider {
  help: string;
  read: () => Iterable<{ labels?: Record<string, string>; value: number }>;
}

// A request's route, reduced to its SHAPE so a label set cannot grow without
// bound. Every segment that looks like an identifier — a UUID, a long opaque
// token, a number — becomes a placeholder, so `/pages/8f14…/versions/3`
// counts under `/pages/:id/versions/:n` rather than minting a new series per
// page. An over-long path is cut, the same guard requestPath uses.
export function normaliseRoute(path: string): string {
  const cut = path.length > 128 ? path.slice(0, 128) : path;
  const segments = cut.split('/').map((seg) => {
    if (seg === '') return seg;
    if (/^\d+$/.test(seg)) return ':n';
    // A UUID, or any long opaque id token (hex, base64url, mixed) — anything a
    // record hands out as a key rather than a person types as a word.
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}$/.test(seg)) return ':id';
    if (/^[A-Za-z0-9_-]{16,}$/.test(seg)) return ':id';
    return seg;
  });
  const route = segments.join('/');
  return route.length > 0 ? route : '/';
}

export class Metrics {
  private readonly requestCounts = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly gauges = new Map<string, GaugeProvider>();

  /** Record one finished HTTP request: its method, normalised route, status, and duration. */
  recordRequest(method: string, route: string, status: number, ms: number): void {
    const key = `${method}|${route}|${status}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);

    const hkey = `${method}|${route}`;
    let h = this.histograms.get(hkey);
    if (!h) {
      h = { counts: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(hkey, h);
    }
    const seconds = ms / 1000;
    h.sum += seconds;
    h.count += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      if (seconds <= DURATION_BUCKETS[i]!) h.counts[i]! += 1;
    }
  }

  /**
   * Register a gauge read at scrape time. The reader returns zero or more
   * samples, so one registration can carry labelled series (build info) or a
   * single value (uptime). Read lazily so a gauge is never a cached lie.
   */
  registerGauge(name: string, help: string, read: GaugeProvider['read']): void {
    this.gauges.set(name, { help, read });
  }

  /** The whole registry as Prometheus text exposition. */
  render(): string {
    const out: string[] = [];

    out.push('# HELP canon_http_requests_total Total HTTP requests, by method, route and status.');
    out.push('# TYPE canon_http_requests_total counter');
    for (const [key, value] of [...this.requestCounts.entries()].sort()) {
      const [method, route, status] = key.split('|') as [string, string, string];
      out.push(`canon_http_requests_total{method=${q(method)},route=${q(route)},status=${q(status)}} ${value}`);
    }

    out.push('# HELP canon_http_request_duration_seconds HTTP request latency, by method and route.');
    out.push('# TYPE canon_http_request_duration_seconds histogram');
    for (const [key, h] of [...this.histograms.entries()].sort()) {
      const [method, route] = key.split('|') as [string, string];
      const base = `method=${q(method)},route=${q(route)}`;
      let cumulative = 0;
      for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
        cumulative = h.counts[i]!; // counts are already "<= bucket", i.e. cumulative
        out.push(`canon_http_request_duration_seconds_bucket{${base},le=${q(String(DURATION_BUCKETS[i]))}} ${cumulative}`);
      }
      out.push(`canon_http_request_duration_seconds_bucket{${base},le="+Inf"} ${h.count}`);
      out.push(`canon_http_request_duration_seconds_sum{${base}} ${h.sum}`);
      out.push(`canon_http_request_duration_seconds_count{${base}} ${h.count}`);
    }

    for (const [name, gauge] of [...this.gauges.entries()].sort()) {
      out.push(`# HELP ${name} ${gauge.help}`);
      out.push(`# TYPE ${name} gauge`);
      let samples: { labels?: Record<string, string>; value: number }[] = [];
      try {
        samples = [...gauge.read()];
      } catch {
        // A gauge that cannot be read (the record went unreadable mid-scrape)
        // is omitted rather than crashing the whole exposition. The readiness
        // gauge below is exactly how a scraper learns that anyway.
        samples = [];
      }
      for (const s of samples) {
        const labels = s.labels && Object.keys(s.labels).length
          ? `{${Object.entries(s.labels).map(([k, v]) => `${k}=${q(v)}`).join(',')}}`
          : '';
        out.push(`${name}${labels} ${s.value}`);
      }
    }

    return out.join('\n') + '\n';
  }
}

/** Escape and quote a Prometheus label value. */
function q(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Wrap a server so it records every request and, when enabled, answers
 * `GET /metrics`. The same seam attachReadiness and attachStatic use, applied
 * where they are so a metrics scrape is measured like any other request.
 *
 * Recording happens only when metrics are enabled: with the endpoint off there
 * is nothing to read the counters, so keeping them would be work for no reader.
 */
export function attachMetrics(server: Server, metrics: Metrics, enabled: boolean): Server {
  if (!enabled) return server;
  const inner = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Serve the scrape itself, before the record's routes, and do not count it
    // under a page route — it is GET /metrics and nothing else.
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/metrics') {
      const body = metrics.render();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      // Count the scrape too, so a silent scraper failure is visible.
      metrics.recordRequest('GET', '/metrics', 200, 0);
      return;
    }
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const route = normaliseRoute(path);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      metrics.recordRequest(method, route, res.statusCode, Date.now() - started);
    };
    res.on('finish', finish);
    res.on('close', finish);
    for (const listener of inner) listener.call(server, req, res);
  });
  return server;
}
