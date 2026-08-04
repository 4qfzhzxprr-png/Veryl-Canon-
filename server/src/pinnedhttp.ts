import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { sameAddress } from './outbound.js';

// The outbound socket, pinned to the address the policy checked.
//
// WHY THIS EXISTS. `outbound.ts` resolves a source's hostname and refuses if
// any address it resolves to is one Canon must not reach. Under the global
// `fetch` that check was advisory: fetch resolves the name again, on its own,
// microseconds later, and there is no supported hook for telling it which
// address to use. A hostile-but-allowlisted host can therefore answer with a
// public address when Canon checks and a private one when Canon connects —
// DNS rebinding — and the request lands inside the network anyway. That was
// finding F1's residual gap in SECURITY.md.
//
// WHAT THIS DOES. `node:http` and `node:https` accept a per-request `lookup`.
// This module supplies one that ignores its argument and returns exactly the
// single address the caller already validated. The socket therefore connects
// to that address and to no other; no second DNS answer is ever consulted,
// so there is no window for a second answer to differ from the first.
//
// TLS IS STILL CHECKED AGAINST THE NAME. Pinning an address must not become a
// way to accept a certificate for the wrong host — that would close an SSRF
// hole by opening a man-in-the-middle one. Only `lookup` is overridden: the
// request still carries the real hostname, so SNI (`servername`) and Node's
// default `checkServerIdentity` both see the name the operator allowlisted,
// and a certificate that does not match it fails the handshake exactly as it
// would have under fetch. The address decides where the packets go; the name
// decides whose certificate is acceptable. An IP-literal baseUrl sends no SNI
// and is checked against the address, which is also what fetch does.

/** How much of a source's answer Canon will read. A federated value is a scalar. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** One request, already judged: where to go, whose certificate to accept. */
export interface OutboundRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The hostname: Host header, SNI, and the name the certificate must match. */
  readonly host: string;
  readonly port: number;
  /** The one address the socket may connect to. */
  readonly address: string;
  readonly family: number;
  /**
   * A request body, for the callers that have one. Absent means no body is
   * written and the request is exactly what it was before this existed — which
   * is every federated lookup, all of which are GETs.
   */
  readonly body?: string;
  /**
   * How much of the answer to read, where the default is wrong for the caller.
   * Absent means `MAX_RESPONSE_BYTES`, the size of a federated scalar.
   *
   * The embedding endpoint is the caller that needs this: a batch of vectors is
   * legitimately megabytes of JSON, and a ceiling sized for "one field from a
   * benefits system" would refuse a correct answer. It is still a ceiling, and
   * the caller states it rather than the transport growing one for everybody.
   */
  readonly maxBytes?: number;
}

export interface OutboundResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** The address the socket actually connected to, as the socket reports it. */
  readonly peerAddress: string | null;
}

/**
 * The transport seam. The default is `pinnedHttpRequest`; a test substitutes
 * its own to observe a request or to answer without a network. Note what the
 * seam does NOT carry: a hostname to resolve. By the time a transport is
 * called the destination is already an address, so no implementation of this
 * interface can reintroduce a second lookup.
 */
export type OutboundTransport = (request: OutboundRequest) => Promise<OutboundResponse>;

/** The source was too slow. Named `TimeoutError` to match what fetch threw. */
export class OutboundTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The source answered with more than Canon will read for one scalar. */
export class OutboundTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundTooLarge';
  }
}

/**
 * The socket ended up somewhere other than the pinned address. This should be
 * unreachable — the whole point of `lookup` is that it cannot happen — and it
 * is asserted rather than assumed, because "should be unreachable" is how a
 * pin quietly stops pinning.
 */
export class OutboundNotPinned extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundNotPinned';
  }
}

/**
 * Failures where trying the host's next address is legitimate: nothing was
 * spoken to, so nothing was learned. A TLS failure, a protocol failure or a
 * timeout is NOT in this set — those are answers of a kind, and retrying them
 * against another address would be a way to shop for a friendlier one.
 */
const CONNECT_FAILURES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'ENETDOWN',
]);

export function isConnectFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && CONNECT_FAILURES.has(code);
}

/**
 * Make the request, to the pinned address, with the certificate still checked
 * against the hostname. Rejects with `OutboundTimeout`, `OutboundTooLarge`,
 * `OutboundNotPinned`, or whatever `node:http`/`node:https` raised. Never
 * follows a redirect: the caller re-applies the whole policy per hop.
 */
export function pinnedHttpRequest(request: OutboundRequest): Promise<OutboundResponse> {
  return new Promise<OutboundResponse>((resolve, reject) => {
    const scheme = request.url.protocol.toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') {
      reject(new Error(`Canon's outbound transport speaks http and https, not ${scheme}`));
      return;
    }
    const secure = scheme === 'https:';

    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      act();
    };

    // THE PIN. Node calls this instead of DNS for this request's connection,
    // and it answers with the one address already judged — whatever the name
    // would resolve to now.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: request.address, family: request.family }]);
      else callback(null, request.address, request.family);
    };

    const options: RequestOptions = {
      protocol: scheme,
      // The name, not the address: this is what fills the Host header, what is
      // sent as SNI, and what checkServerIdentity compares the certificate to.
      host: request.host,
      hostname: request.host,
      port: request.port,
      path: `${request.url.pathname}${request.url.search}`,
      method: request.method,
      headers: { ...request.headers },
      lookup,
      // A pooled socket would be a connection this request never checked, and
      // the agent's pool key does not include the pinned address. One socket,
      // this request's, closed after it.
      agent: false,
    };
    if (secure) {
      // No SNI for a literal address — a certificate cannot carry one, and
      // Node checks the address against the certificate's IP SANs instead.
      options.servername = isIP(request.host) ? undefined : request.host;
      // Stated rather than relied upon: a source's certificate must verify.
      options.rejectUnauthorized = true;
    }

    const send = secure ? httpsRequest : httpRequest;
    const client = send(options, (res) => {
      const peerAddress = res.socket?.remoteAddress ?? null;
      // Belt and braces on the guarantee this file exists to make.
      if (peerAddress && !sameAddress(peerAddress, request.address)) {
        res.destroy();
        client.destroy();
        finish(() =>
          reject(
            new OutboundNotPinned(
              `the connection landed on ${peerAddress}, not the checked address ${request.address}`,
            ),
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const ceiling = request.maxBytes ?? MAX_RESPONSE_BYTES;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > ceiling) {
          res.destroy();
          client.destroy();
          finish(() => reject(new OutboundTooLarge(`answer exceeded ${ceiling} bytes`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => finish(() => reject(err)));
      res.on('end', () =>
        finish(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            peerAddress,
          }),
        ),
      );
    });

    client.on('error', (err) => finish(() => reject(err)));

    // One deadline over the whole exchange — connect, handshake, headers and
    // body — because a source that dribbles a body forever is as much "no
    // answer" as one that never accepts the connection.
    timer = setTimeout(() => {
      const err = new OutboundTimeout(`no answer within ${request.timeoutMs}ms`);
      client.destroy(err);
      finish(() => reject(err));
    }, Math.max(1, request.timeoutMs));

    if (request.body !== undefined) client.write(request.body);
    client.end();
  });
}
