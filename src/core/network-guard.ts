import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/**
 * Reject outbound network targets that point at private / reserved / loopback /
 * cloud-metadata addresses. Used everywhere a hostname or URL comes from a
 * caller we don't fully trust (LLM agent input, third-party API response,
 * customer-configured IMAP/SMTP server, etc.).
 *
 * IPv4 + IPv6 + IPv4-mapped-IPv6 (`::ffff:7f00:1` style) all covered.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv4-mapped IPv6 — strip the prefix and run the v4 checks.
  // Accepts both dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`) forms;
  // hex is normalised to dotted by parsing the last two colon-separated groups
  // as the high/low 16 bits of the embedded IPv4.
  const lowered = ip.toLowerCase();
  let mapped = lowered.startsWith('::ffff:') ? lowered.slice(7) : lowered;
  if (!mapped.includes('.') && mapped.includes(':') && lowered.startsWith('::ffff:')) {
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const hi = groups[0] ?? '';
      const lo = groups[1] ?? '';
      if (/^[0-9a-f]{1,4}$/.test(hi) && /^[0-9a-f]{1,4}$/.test(lo)) {
        const hiN = parseInt(hi, 16);
        const loN = parseInt(lo, 16);
        mapped = `${String((hiN >> 8) & 0xff)}.${String(hiN & 0xff)}.${String((loN >> 8) & 0xff)}.${String(loN & 0xff)}`;
      }
    }
  }
  const v4Parts = mapped.split('.');
  if (v4Parts.length === 4 && v4Parts.every(p => /^\d{1,3}$/.test(p))) {
    const nums = v4Parts.map(Number);
    if (nums.some(n => n < 0 || n > 255)) return false;
    const [a, b, c] = nums as [number, number, number, number];
    if (a === 127) return true;                              // loopback
    if (a === 10) return true;                               // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;        // RFC1918
    if (a === 192 && b === 168) return true;                 // RFC1918
    if (a === 169 && b === 254) return true;                 // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;    // benchmarking
    if (a === 192 && b === 0 && c === 0) return true;        // IETF protocol assignments
    if (a === 0) return true;                                // "this network"
    if (a >= 224) return true;                               // multicast + reserved
  }
  const normalized = ip.toLowerCase();
  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;   // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;   // unique local
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;      // multicast
  }
  return false;
}

/**
 * Throws if `hostname` is a private/reserved/loopback literal IP or resolves to
 * one. Use before opening any non-HTTP connection (IMAP, SMTP, etc.) where the
 * caller supplied a hostname.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const cleaned = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateIP(cleaned)) {
    throw new Error(`Blocked: private IP address "${cleaned}"`);
  }
  const resolved = await dns.lookup(cleaned, { all: true, verbatim: true }).catch(() => []);
  for (const record of resolved) {
    if (isPrivateIP(record.address)) {
      throw new Error(`Blocked: "${cleaned}" resolves to private IP "${record.address}"`);
    }
  }
}

/**
 * Throws unless `rawUrl` is an http/https URL whose hostname is not private /
 * reserved / loopback. Use before any `fetch()` of a URL that came from a
 * caller we don't fully trust.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  await assertPublicHost(parsed.hostname);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Resolve `hostname` to an IP, validate it is not private/reserved, and return
 * the first allowed record. Throws `Blocked: ...` on any private hit so the
 * caller treats it the same as the legacy assertPublicHost path.
 *
 * Used by fetchPinned() — the validated IP is fed directly into the http(s)
 * Agent.lookup callback so the subsequent socket connect cannot race a second
 * DNS resolution (DNS-rebinding defense). Literal-IP hostnames short-circuit
 * the DNS call.
 */
async function resolveAndValidate(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const cleaned = hostname.replace(/^\[|\]$/g, '');

  // Literal IP — no DNS, validate directly.
  if (cleaned.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(cleaned)) {
    if (isPrivateIP(cleaned)) {
      throw new Error(`Blocked: private IP address "${cleaned}"`);
    }
    const family: 4 | 6 = cleaned.includes(':') ? 6 : 4;
    return { address: cleaned, family };
  }

  // 5s timeout race — restores parity with the legacy http.ts validateUrl
  // (a slow / hung resolver would otherwise stall the whole request until
  // upstream socket timeout). .unref() so the timer doesn't keep the event
  // loop alive past a faster resolution.
  const dnsTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('DNS timeout')), 5_000).unref();
  });
  const resolved = await Promise.race([
    dns.lookup(cleaned, { all: true, verbatim: true }),
    dnsTimeout,
  ]).catch(() => [] as Array<{ address: string; family: number }>);
  if (resolved.length === 0) {
    // No records (or timeout / DNS error) — short-circuit the connect with a
    // Blocked error rather than letting the OS re-resolve (which would reopen
    // the rebind window). Callers see "did not resolve" instead of NXDOMAIN
    // detail — acceptable trade for fail-closed rebind safety.
    throw new Error(`Blocked: hostname "${cleaned}" did not resolve to any IP`);
  }
  for (const record of resolved) {
    if (isPrivateIP(record.address)) {
      throw new Error(`Blocked: "${cleaned}" resolves to private IP "${record.address}"`);
    }
  }
  const first = resolved[0]!;
  const family: 4 | 6 = first.family === 6 ? 6 : 4;
  return { address: first.address, family };
}

/**
 * Build an http(s) Agent whose `lookup` always returns `pinnedIp` — closes the
 * DNS-rebinding window between validation and connect. The Agent is single-use
 * (`keepAlive:false`) so a long-lived process doesn't cache a stale pin.
 */
function pinnedAgent(protocol: 'http:' | 'https:', pinnedIp: string, family: 4 | 6): http.Agent | https.Agent {
  const lookup: (
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => void = (_hostname, _options, callback) => {
    callback(null, pinnedIp, family);
  };
  const opts = { keepAlive: false, lookup };
  return protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
}

/** Convert init.headers (HeadersInit) into a flat Record<string, string>. */
function flattenHeaders(input: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(input)) {
    for (const [k, v] of input) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Materialise init.body into a Buffer (or undefined). Streams are not supported. */
async function materialiseBody(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  // ReadableStream / FormData / URLSearchParams — not used by the SSRF callers.
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  throw new Error('fetchPinned: unsupported body type — only string/Buffer/Uint8Array/Blob/URLSearchParams are accepted');
}

/**
 * Information passed to a fetchPinned transport: the URL parts after policy
 * + DNS validation, plus the pre-resolved IP the connection MUST pin to.
 *
 * The default transport uses node:http(s) with an Agent.lookup override.
 * Tests inject a stub via setPinnedTransportForTests() so they don't need to
 * spin up real servers OR rely on a globalThis.fetch monkey-patch (which
 * would bypass the rebind defense entirely).
 */
export interface PinnedTransportInput {
  url: string;
  hostname: string;        // original (vhost / SNI)
  pinnedIp: string;        // validated address
  family: 4 | 6;
  port: number;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  signal: AbortSignal | undefined;
  protocol: 'http:' | 'https:';
}
export type PinnedTransport = (input: PinnedTransportInput) => Promise<Response>;

const defaultTransport: PinnedTransport = (input) => {
  const agent = pinnedAgent(input.protocol, input.pinnedIp, input.family);

  return new Promise<Response>((resolve, reject) => {
    let aborted = false;
    const requestModule = input.protocol === 'https:' ? https : http;
    const parsedPath = new URL(input.url);
    const req = requestModule.request({
      protocol: input.protocol,
      hostname: input.hostname,   // original — drives Host header AND SNI fallback
      port: input.port,
      method: input.method,
      path: `${parsedPath.pathname}${parsedPath.search}`,
      headers: input.headers,
      agent,
      // Explicit servername preserves SNI in case a future Node release
      // changes the implicit-fallback behaviour. The pinned Agent forces the
      // TCP target to be `pinnedIp` regardless.
      servername: input.protocol === 'https:' ? input.hostname : undefined,
    }, (incoming: IncomingMessage) => {
      try {
        const status = incoming.statusCode ?? 0;
        const statusText = incoming.statusMessage ?? '';
        const respHeaders = new Headers();
        appendIncomingHeaders(respHeaders, incoming.headers);
        const bodyStream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        // Construct Response: 204/304/205 disallow a body per spec.
        const responseBody = (status === 204 || status === 304 || status === 205) ? null : bodyStream;
        const response = new Response(responseBody, { status, statusText, headers: respHeaders });
        resolve(response);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (aborted) return;
      reject(err);
    });

    const signal = input.signal;
    if (signal) {
      const onAbort = () => {
        aborted = true;
        req.destroy(new Error('aborted'));
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
};

let activeTransport: PinnedTransport = defaultTransport;

/**
 * Replace the transport used by fetchPinned. Test-only — production code MUST
 * use the default. Returns a restore handle; call it to reinstate the default.
 *
 * Why this seam exists: the rebind defense LIVES in fetchPinned (DNS resolve +
 * Agent.lookup pinning). If tests mocked the legacy `globalThis.fetch` the
 * defense would be silently bypassed in tests AND the tests wouldn't notice.
 * By making the transport an injection seam, tests get to assert that the
 * pinned IP arrives at the transport unchanged — which IS the contract.
 */
export function setPinnedTransportForTests(transport: PinnedTransport): () => void {
  // Safety guard: the test seam rewires the SSRF transport globally for the
  // whole process — if a non-test caller (or a supply-chained dep) reached
  // it, every fetchPinned() would be diverted, silently bypassing the rebind
  // defense this PR is built to provide. Vitest sets both VITEST and
  // NODE_ENV='test' by default.
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('setPinnedTransportForTests is for tests only');
  }
  activeTransport = transport;
  return () => { activeTransport = defaultTransport; };
}

/**
 * SSRF-safe fetch: resolves DNS once, validates the IP, then pins the http(s)
 * connection to that IP via Agent.lookup. The original hostname is preserved
 * in the URL path (so the Host header is correct) and reaches TLS as SNI (since
 * https.Agent falls back to the request's hostname when servername is unset).
 *
 * Closes the DNS-rebinding window — the legacy
 * `assertPublicUrl(url); fetch(url)` flow allowed a low-TTL record to flip
 * public→loopback between the validation and the socket connect. Here, the
 * socket connect re-uses the validated IP without re-querying DNS.
 *
 * Does NOT follow redirects (use fetchWithPublicRedirects for that).
 * Aborts on init.signal; respects init.method/headers/body.
 */
export async function fetchPinned(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const { address: pinnedIp, family } = await resolveAndValidate(hostname);

  const headers = flattenHeaders(init.headers);
  // Ensure Host header is the original vhost — required for correct vhost
  // routing AND for the SNI fallback (http.request uses options.host for SNI
  // when servername is unset).
  if (!Object.keys(headers).some(h => h.toLowerCase() === 'host')) {
    headers['host'] = parsed.host;
  }

  const method = (init.method ?? 'GET').toUpperCase();
  const body = await materialiseBody(init.body);

  // Default port matches Node's URL behaviour (empty → protocol default).
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);

  return activeTransport({
    url,
    hostname,
    pinnedIp,
    family,
    port,
    method,
    headers,
    body,
    signal: init.signal ?? undefined,
    protocol: parsed.protocol as 'http:' | 'https:',
  });
}

/** Append node:http IncomingHttpHeaders into a Headers (multi-value safe). */
function appendIncomingHeaders(target: Headers, src: IncomingHttpHeaders): void {
  for (const [name, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) target.append(name, v);
    } else {
      target.append(name, String(value));
    }
  }
}

/**
 * Fetch a URL after validating that every hop (initial + each redirect) targets
 * a public host. Returns the final non-redirect response. Re-throws the
 * `Blocked: ...` error on any private-IP hit, so callers don't need their own
 * validation.
 *
 * Each hop is dispatched via fetchPinned() — the connection is pinned to the
 * pre-validated IP, closing the DNS-rebinding window between validation and
 * connect.
 *
 * Notes:
 *  - `init.redirect` is irrelevant — this helper always does its own redirect
 *    handling so it can re-validate each hop.
 *  - 301/302/303 with non-GET methods are rewritten to GET per RFC 9110, body
 *    dropped, to match `fetch()` default-redirect semantics.
 */
export async function fetchWithPublicRedirects(
  url: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number } = {},
): Promise<Response> {
  const max = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let i = 0; i <= max; i++) {
    const hopInit: RequestInit = {
      ...init,
      method,
    };
    if (body !== undefined) {
      hopInit.body = body;
    } else {
      delete (hopInit as { body?: unknown }).body;
    }
    const response = await fetchPinned(currentUrl, hopInit);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Blocked: redirect without location header (${response.status})`);
    }
    if (i === max) {
      throw new Error(`Blocked: too many redirects (>${max})`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    // 301/302 → GET for non-GET/HEAD; 303 → GET always (per RFC 9110).
    if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    } else if ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    }
    currentUrl = nextUrl;
  }

  throw new Error('Blocked: redirect handling failed');
}
