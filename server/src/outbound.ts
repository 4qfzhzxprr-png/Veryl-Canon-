import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// Outbound reach policy: the one place that decides whether Canon is allowed
// to dial a URL at all.
//
// WHY THIS EXISTS. Federation (DATA-BACKBONE.md §6) lets an administrator
// register a Source with a `baseUrl`, and the HTTP connector fetches that URL
// server-side when a page's reference resolves. Without a policy, a collection
// admin — or an agent the Registry granted `"*"` over sources — can point a
// Source at `http://169.254.169.254/latest/meta-data/`, at `http://localhost:PORT`,
// or at any host inside the deployment's network, and read the response back
// out through a page's reference value. That is server-side request forgery,
// and it turns Canon into a proxy into the private network: the exact opposite
// of the governed connection §6 asks for.
//
// WHAT THE POLICY IS. A deployment states, in configuration, the hosts Canon
// may reach. Nothing else is reachable. The empty policy means "no outbound
// federation", never "anything":
//
//   CANON_SOURCE_ALLOWED_HOSTS   comma- or space-separated allowlist. Each
//                                entry is `host`, `host:port`, or `*.domain`
//                                (any subdomain, not the apex). A host entry
//                                with no port permits any port on that host.
//                                UNSET OR EMPTY = no outbound federation.
//   CANON_SOURCE_ALLOWED_SCHEMES comma-separated; default `https,http`.
//                                Anything else — file:, ftp:, gopher:, data: —
//                                is refused whatever the allowlist says.
//   CANON_SOURCE_ALLOW_PRIVATE   `true` permits loopback, link-local, and
//                                private address ranges. FOR DEVELOPMENT ONLY;
//                                it is what lets the test suite reach a stub on
//                                127.0.0.1. Off by default, in every deployment
//                                that does not say otherwise.
//
// WHAT IT STOPS, AND WHAT IT DOES NOT. Stated plainly because a half-honest
// security control is worse than none:
//
//   * It stops a registered baseUrl naming an unlisted host, a non-HTTP(S)
//     scheme, embedded credentials, or a literal address in a loopback,
//     link-local, private, CGNAT, multicast or reserved range.
//   * It stops a redirect being followed to any host the original request
//     could not have reached (httpconnector.ts drives redirects by hand).
//   * At resolution time it also resolves the hostname and refuses if ANY
//     address it resolves to is blocked. That closes the ordinary
//     "allowlisted-name-that-points-at-169.254.169.254" case.
//   * It does NOT pin the address Canon then connects to. Node's global fetch
//     offers no supported hook for supplying the resolved socket address, so
//     between the check and the connection a DNS answer can change: a
//     deliberate rebinding attack, from an operator-allowlisted host, can still
//     land on an internal address. The allowlist is what makes that
//     uninteresting in practice — the attacker must already control a name the
//     operator chose to trust — but the window is real and is not closed here.
//     Closing it needs a connect-time hook (a custom dispatcher, or a plain
//     node:http request with a fixed `lookup`), which is a larger change than a
//     security review should make on its own.

export type OutboundRefusalCode =
  | 'not_configured' // the deployment permits no outbound federation
  | 'scheme' // not an allowed scheme
  | 'credentials' // user:password embedded in the URL
  | 'not_allowlisted' // host is not in CANON_SOURCE_ALLOWED_HOSTS
  | 'blocked_address'; // loopback / link-local / private / reserved

export class OutboundRefused extends Error {
  readonly code: OutboundRefusalCode;
  readonly host: string;

  constructor(code: OutboundRefusalCode, message: string, host = '') {
    super(message);
    this.name = 'OutboundRefused';
    this.code = code;
    this.host = host;
  }
}

interface AllowEntry {
  /** Lowercased host, or the suffix (with leading dot) for a `*.domain` entry. */
  host: string;
  wildcard: boolean;
  /** Null means any port on that host. */
  port: number | null;
}

export interface OutboundPolicy {
  readonly allow: readonly AllowEntry[];
  readonly schemes: readonly string[];
  readonly allowPrivate: boolean;
  /** True when nothing is allowlisted: no outbound federation at all. */
  readonly empty: boolean;
}

const DEFAULT_SCHEMES = ['https', 'http'];

function parseEntry(raw: string): AllowEntry | null {
  let text = raw.trim().toLowerCase();
  if (!text) return null;
  // Tolerate an entry written as a URL — `https://benefits.internal` — because
  // that is what an operator copies out of the source's own documentation.
  const asUrl = /^[a-z][a-z0-9+.-]*:\/\//.exec(text);
  if (asUrl) {
    try {
      const url = new URL(text);
      text = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
      return null;
    }
  }
  let host = text;
  let port: number | null = null;
  // `[::1]:3000` and `[::1]`; a bare IPv6 literal has no port form.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2] ? Number(bracketed[2]) : null;
  } else {
    const lastColon = text.lastIndexOf(':');
    if (lastColon > 0 && /^\d+$/.test(text.slice(lastColon + 1)) && isIP(text) === 0) {
      host = text.slice(0, lastColon);
      port = Number(text.slice(lastColon + 1));
    }
  }
  if (!host) return null;
  if (host.startsWith('*.')) return { host: host.slice(1), wildcard: true, port };
  return { host, wildcard: false, port };
}

/** Read a policy out of an environment. Absent configuration means no reach. */
export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const allow = (env.CANON_SOURCE_ALLOWED_HOSTS ?? '')
    .split(/[,\s]+/)
    .map(parseEntry)
    .filter((e): e is AllowEntry => e !== null);
  const schemes = (env.CANON_SOURCE_ALLOWED_SCHEMES ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/:$/, ''))
    .filter(Boolean);
  return {
    allow,
    schemes: schemes.length ? schemes : DEFAULT_SCHEMES,
    allowPrivate: (env.CANON_SOURCE_ALLOW_PRIVATE ?? '').trim().toLowerCase() === 'true',
    empty: allow.length === 0,
  };
}

// The policy every caller gets when none is supplied. Read once, so a process
// has one answer to "what may Canon reach"; tests build their own with
// outboundPolicyFromEnv().
let cached: OutboundPolicy | null = null;

export function defaultOutboundPolicy(): OutboundPolicy {
  cached ??= outboundPolicyFromEnv();
  return cached;
}

/** Test seam: forget the process-wide policy so a later read sees new env. */
export function resetDefaultOutboundPolicy(): void {
  cached = null;
}

// ---- address classification ---------------------------------------------

function ipv4Blocked(a: number, b: number, _c: number, d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier NAT
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && _c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  if (a === 255 && b === 255 && _c === 255 && d === 255) return true;
  return false;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expand an IPv6 literal to its eight 16-bit groups; null if unparsable. */
function parseIpv6(text: string): number[] | null {
  let source = text;
  const zone = source.indexOf('%');
  if (zone !== -1) source = source.slice(0, zone);
  let tail: number[] = [];
  // A trailing dotted quad (::ffff:127.0.0.1) contributes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (dotted) {
    const quad = parseIpv4(dotted[1]!);
    if (!quad) return null;
    tail = [(quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!];
    source = source.slice(0, dotted.index);
    if (source.endsWith(':') && !source.endsWith('::')) source = source.slice(0, -1);
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      if (piece === '') continue;
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const known = [...head, ...rest, ...tail];
  if (halves.length === 2) {
    const fill = 8 - known.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...rest, ...tail];
  }
  return known.length === 8 ? known : null;
}

/**
 * Is this literal address one Canon must never reach? Loopback, link-local
 * (including the cloud metadata address), private, carrier-NAT, multicast and
 * reserved ranges, in both families — and the v4 address inside an
 * IPv4-mapped, 6to4 or NAT64 v6 address, because tunnelling through a v6
 * spelling of 127.0.0.1 is still reaching 127.0.0.1.
 */
export function isBlockedAddress(address: string): boolean {
  const text = address.trim().replace(/^\[|\]$/g, '');
  const family = isIP(text);
  if (family === 4) {
    const quad = parseIpv4(text);
    return quad ? ipv4Blocked(quad[0]!, quad[1]!, quad[2]!, quad[3]!) : true;
  }
  if (family === 6) {
    const groups = parseIpv6(text);
    if (!groups) return true;
    const [g0, g1] = [groups[0]!, groups[1]!];
    const embedded = (hi: number, lo: number): boolean =>
      ipv4Blocked((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
    if (groups.every((g) => g === 0)) return true; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    // ::ffff:0:0/96 IPv4-mapped
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return embedded(groups[6]!, groups[7]!);
    }
    // 64:ff9b::/96 NAT64
    if (g0 === 0x0064 && g1 === 0xff9b) return embedded(groups[6]!, groups[7]!);
    // 2002::/16 6to4 carries the v4 address in the next two groups
    if (g0 === 0x2002) return embedded(groups[1]!, groups[2]!);
    return false;
  }
  return false; // not an address at all: a hostname, judged by the allowlist
}

// ---- the checks ----------------------------------------------------------

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0;
}

function allowlisted(policy: OutboundPolicy, url: URL): boolean {
  const host = hostOf(url);
  const port = effectivePort(url);
  return policy.allow.some((entry) => {
    if (entry.port !== null && entry.port !== port) return false;
    return entry.wildcard ? host.endsWith(entry.host) && host.length > entry.host.length : host === entry.host;
  });
}

/**
 * The structural checks: everything decidable from the URL text alone, with
 * no name resolution. Applied when a Source is registered or changed, and
 * again at resolution time and on every redirect hop.
 */
export function assertOutboundAllowed(url: URL, policy: OutboundPolicy = defaultOutboundPolicy()): void {
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!policy.schemes.includes(scheme)) {
    throw new OutboundRefused(
      'scheme',
      `Canon federates over ${policy.schemes.join('/')} only, not ${scheme}:`,
      hostOf(url),
    );
  }
  // Credentials in the URL would be a copied secret in Canon's own store,
  // which sources.ts refuses on principle, and they leak into every log line
  // that ever prints the baseUrl.
  if (url.username || url.password) {
    throw new OutboundRefused(
      'credentials',
      'A source URL may not carry embedded credentials; Canon stores no secret material for a source',
      hostOf(url),
    );
  }
  if (policy.empty) {
    throw new OutboundRefused(
      'not_configured',
      'This deployment permits no outbound federation: set CANON_SOURCE_ALLOWED_HOSTS to the hosts Canon may reach',
      hostOf(url),
    );
  }
  if (!allowlisted(policy, url)) {
    throw new OutboundRefused(
      'not_allowlisted',
      `${hostOf(url)} is not in this deployment's CANON_SOURCE_ALLOWED_HOSTS`,
      hostOf(url),
    );
  }
  if (!policy.allowPrivate && isBlockedAddress(hostOf(url))) {
    throw new OutboundRefused(
      'blocked_address',
      `${hostOf(url)} is a loopback, link-local or private address; set CANON_SOURCE_ALLOW_PRIVATE=true only for development`,
      hostOf(url),
    );
  }
}

/**
 * The structural checks plus name resolution: every address the host resolves
 * to must be reachable too. Used at resolution time, where the extra DNS
 * round trip is affordable and the answer is the current one.
 *
 * A host that will not resolve is refused rather than attempted — the request
 * would fail anyway, and refusing here keeps the failure honest.
 */
export async function assertOutboundAllowedResolved(
  url: URL,
  policy: OutboundPolicy = defaultOutboundPolicy(),
): Promise<void> {
  assertOutboundAllowed(url, policy);
  if (policy.allowPrivate) return;
  const host = hostOf(url);
  if (isIP(host) !== 0) return; // a literal: assertOutboundAllowed already judged it
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new OutboundRefused('blocked_address', `${host} could not be resolved: ${(err as Error).message}`, host);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new OutboundRefused(
        'blocked_address',
        `${host} resolves to ${address}, a loopback, link-local or private address`,
        host,
      );
    }
  }
}

/**
 * The baseUrl of a registered Source, judged at registration time.
 *
 * Not every baseUrl names a network location. The hermetic connector in
 * connectors.ts takes a fixture-set name — `benefits`, or `static:benefits` —
 * and makes no request at all, so a value with no scheme, and the `static:`
 * namespace, are passed through untouched. Everything that does name a
 * location is held to the full policy, and any other scheme is refused
 * outright rather than left for a connector to interpret.
 */
export function assertRegistrableBaseUrl(baseUrl: string, policy: OutboundPolicy = defaultOutboundPolicy()): void {
  const text = (baseUrl ?? '').trim();
  if (!text) return;
  if (/^static:/i.test(text)) return; // the in-process fixture connector; no network
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return; // not an absolute URL: a connector-local name, not a location
  }
  assertOutboundAllowed(url, policy);
}
