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

/**
 * Parse a textual IPv6 address into its 16 bytes, or null if it isn't a plain
 * hextet IPv6 we can canonicalise (embedded IPv4 / malformed → null → caller
 * falls back to string checks). Handles `::` zero-compression and a zone id, so
 * every representation of the same address yields the same bytes — an
 * exact-string `=== '::1'` misses `0::1` / `0:0:0:0:0:0:0:1`, byte-form does not.
 */
function ipv6ToBytes(addr: string): number[] | null {
  const s = (addr.split('%')[0] ?? addr); // strip zone id (fe80::1%eth0)
  if (!s.includes(':') || s.includes('.')) return null; // embedded IPv4 handled by the caller's v4 path
  const halves = s.split('::');
  if (halves.length > 2) return null; // at most one '::'
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null; // no '::' → must be all 8 groups
  const tail = parseGroups(halves[1] ?? '');
  if (tail === null) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

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
    const bytes = ipv6ToBytes(normalized);
    if (bytes) {
      // Byte-form checks catch EVERY textual representation (canonical or not —
      // `::1`, `0::1`, `0:0:0:0:0:0:0:1` all map to the same bytes), closing the
      // exact-string `=== '::1'` bypass that let `0::1` reach loopback.
      const b0 = bytes[0] ?? 0;
      const b1 = bytes[1] ?? 0;
      const b15 = bytes[15] ?? 0;
      if (bytes.every(b => b === 0)) return true;                              // :: unspecified
      if (bytes.slice(0, 15).every(b => b === 0) && b15 === 1) return true;    // ::1 loopback
      if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;                    // fe80::/10 link-local
      if ((b0 & 0xfe) === 0xfc) return true;                                   // fc00::/7 unique-local
      if (b0 === 0xff) return true;                                            // ff00::/8 multicast
    } else {
      // Unparseable (embedded IPv4, malformed) — conservative string fallback.
      if (normalized === '::1' || normalized === '::') return true;
      if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;   // link-local
      if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;   // unique local
      if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;      // multicast
    }
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
  // Defense-in-depth: a record without an `address` would silently produce a
  // broken pin (Node 22 surfaces this downstream as the cryptic
  // `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`). Fail closed with
  // an explicit message so the caller / operator sees the real problem.
  if (typeof first.address !== 'string' || first.address.length === 0) {
    throw new Error(`Blocked: DNS returned a record without an address for "${cleaned}"`);
  }
  const family: 4 | 6 = first.family === 6 ? 6 : 4;
  return { address: first.address, family };
}

/**
 * Build an http(s) Agent whose `lookup` always returns `pinnedIp` — closes the
 * DNS-rebinding window between validation and connect. The Agent is single-use
 * (`keepAlive:false`) so a long-lived process doesn't cache a stale pin.
 *
 * Node's lookup callback has TWO signatures depending on `options.all`:
 *  - `all === false` (legacy):  `callback(err, address, family)`
 *  - `all === true`  (Node 18+): `callback(err, [{ address, family }, ...])`
 *
 * Node 22's `net.Socket.connect` path (via `lookupAndConnectMultiple`) ALWAYS
 * sets `{ all: true }` — if we hand it back a plain string as the 2nd arg, it
 * iterates the string character-by-character looking for `record.address`,
 * pulls `undefined`, and throws `ERR_INVALID_IP_ADDRESS: Invalid IP address:
 * undefined` on the connect attempt. This silently broke every fetchPinned()
 * call on staging (caught 2026-05-23 in HN-launch smoke: web_research read
 * universal-fail).
 *
 * We branch on `options.all` so the same agent works whether the caller asks
 * for one-shot or all-records resolution. Both branches return the SAME pinned
 * IP — the rebind defense is preserved.
 */
export function __pinnedAgentForTests(protocol: 'http:' | 'https:', pinnedIp: string, family: 4 | 6): http.Agent | https.Agent {
  return pinnedAgent(protocol, pinnedIp, family);
}

function pinnedAgent(protocol: 'http:' | 'https:', pinnedIp: string, family: 4 | 6): http.Agent | https.Agent {
  type LookupOptions = { all?: boolean | undefined } | undefined;
  type LookupAllCallback = (
    err: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: number }>,
  ) => void;
  type LookupSingleCallback = (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void;
  const lookup = (
    _hostname: string,
    options: LookupOptions,
    callback: LookupAllCallback | LookupSingleCallback,
  ): void => {
    if (options?.all === true) {
      (callback as LookupAllCallback)(null, [{ address: pinnedIp, family }]);
    } else {
      (callback as LookupSingleCallback)(null, pinnedIp, family);
    }
  };
  const opts = { keepAlive: false, lookup };
  return protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
}

/** Credential headers that must NOT survive a cross-origin redirect. WHATWG
 *  fetch() strips only authorization/cookie/proxy-authorization, but the engine
 *  forwards API keys as x-api-key (custom-provider probe) and recognises
 *  x-api-key/x-auth-token/x-csrf-token as credentials elsewhere (REDACTED_HEADERS
 *  in http.ts). The pre-flight egress secret scan runs ONCE (not per hop) and
 *  only matches SECRET_PATTERNS, so a key that doesn't match a regex would
 *  otherwise replay off-origin — strip these too. */
const CROSS_ORIGIN_DROP_HEADERS = new Set([
  'authorization', 'cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token',
]);

/**
 * Mirror WHATWG `fetch()` redirect semantics: when a redirect hop changes
 * origin, drop credential headers (Authorization / Cookie / Proxy-Authorization)
 * so they are not replayed to the new origin. Our hand-rolled redirect loops
 * (`fetchWithValidatedRedirects`, `fetchWithPublicRedirects`) re-issue the
 * request with the ORIGINAL headers each hop, so without this an auth header —
 * worst case the engine-attached OAuth2 `Bearer <vault access_token>`, which is
 * deliberately exempt from the egress secret scan — would leak verbatim to
 * whatever host a profiled API 30x-redirects to (an open redirect → credential
 * exfil). Same-origin hops keep all headers. Fails closed: if either URL can't
 * be parsed, the headers are stripped.
 */
export function redirectHopHeaders(
  headers: Record<string, string>,
  fromUrl: string,
  toUrl: string,
): Record<string, string> {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin;
  } catch {
    sameOrigin = false; // unparseable → treat as cross-origin, strip credentials
  }
  if (sameOrigin) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_DROP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * True when a redirect hop changes origin. The body counterpart to
 * `redirectHopHeaders`: a 307/308 preserves the method + request body, so a
 * cross-origin hop would replay the body verbatim to the new origin. Used to
 * drop a preserved body when the origin changes, so a secret carried in the
 * body — e.g. an OAuth `client_secret` POST whose `token_url` issues an open
 * redirect — is not exfiltrated off-origin (the header strip alone misses it).
 * Fails closed: an unparseable URL is treated as cross-origin.
 */
export function isCrossOriginHop(fromUrl: string, toUrl: string): boolean {
  try {
    return new URL(fromUrl).origin !== new URL(toUrl).origin;
  } catch {
    return true;
  }
}

/** Convert init.headers (HeadersInit) into a flat Record<string, string>. */
export function flattenHeaders(input: HeadersInit | undefined): Record<string, string> {
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
  // Carried explicitly so credential headers can be dropped on a cross-origin
  // hop (mirror fetch()); see redirectHopHeaders.
  let headers = flattenHeaders(init.headers);

  for (let i = 0; i <= max; i++) {
    const hopInit: RequestInit = {
      ...init,
      method,
      headers,
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
    // Drop credential headers before a cross-origin hop (mirror fetch()).
    headers = redirectHopHeaders(headers, currentUrl, nextUrl);
    // A 307/308 preserves the body — drop it too on a cross-origin hop so a
    // secret in the body is not replayed off-origin, degrading to a bodyless
    // GET (matches the 301/302/303 rewrite path).
    if (body !== undefined && isCrossOriginHop(currentUrl, nextUrl)) {
      method = 'GET';
      body = undefined;
    }
    currentUrl = nextUrl;
  }

  throw new Error('Blocked: redirect handling failed');
}
