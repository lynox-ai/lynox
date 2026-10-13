/**
 * What a server WITHOUT `LYNOX_HTTP_SECRET` answers to, when the request may come from a browser.
 *
 * Without a secret every request is the owner, so the only thing that separates a request the
 * user made from one another site made in the user's browser is what the browser says about it.
 * Two checks, both applied only when there is no secret:
 *
 * 1. `hostRefusal` — every method. The `Host` header must be localhost, an IP address, or the
 *    host of an origin listed in `LYNOX_ALLOWED_ORIGINS`. A page can point a NAME of its own at
 *    this server, and the browser then treats this server as that page's own origin, for reads
 *    as well as writes. An IP address cannot be pointed anywhere, and a request with no `Host`
 *    header at all does not come from a browser.
 *
 * 2. `crossSiteWriteRefusal` — every method but GET, HEAD and OPTIONS. Accepted:
 *    - an `Origin` listed in `LYNOX_ALLOWED_ORIGINS`;
 *    - a localhost `Origin` (`LOCALHOST_ORIGIN`, the set the CORS block also treats as local);
 *    - an `Origin` that is this server itself, reached by IP address: its host, port included,
 *      equals the `Host` header and is an IP literal;
 *    - a request with neither `Origin` nor `Sec-Fetch-Site` — curl, the CLI, an MCP client, a
 *      server-side fetch. A browser sends `Origin` on every write. `Sec-Fetch-Site` it sends
 *      only to a secure context, so over plain HTTP to anything but localhost, `Origin` is the
 *      one header that carries the decision.
 *    Refused: any other `Origin` (`null` included, which a sandboxed frame or a `file:` page
 *    sends), and, without `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site`.
 *
 * Each returns the refusal text, or null when the request may proceed.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true; // IPv6, as URL writes it
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The allowed-origins entries that ARE origins: trimmed, `https://x/` read as `https://x`, and
 * anything that is not an http(s) origin dropped. Dropped, not kept: `lynox.lan:3000` parses as a
 * URL whose scheme is `lynox.lan`, and its origin is the string `null` — the very origin a
 * sandboxed frame sends. Kept, it would let such a frame in.
 */
export function normalizeAllowedOrigins(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    let parsed: URL;
    try { parsed = new URL(entry); } catch { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    out.push(parsed.origin);
  }
  return out;
}

export const NO_SECRET_HOST_REFUSAL =
  'Refused: this server runs without LYNOX_HTTP_SECRET and answers only to localhost, an IP '
  + 'address, or the host of an origin in LYNOX_ALLOWED_ORIGINS. Reached by a host name, add the '
  + 'origin the browser shows (for example http://lynox.local:3000) to LYNOX_ALLOWED_ORIGINS, or '
  + 'set LYNOX_HTTP_SECRET.';

export const CROSS_SITE_WRITE_REFUSAL =
  'Refused: this server runs without LYNOX_HTTP_SECRET and accepts changes from a browser only on '
  + 'localhost, on its own IP address, or from an origin listed in LYNOX_ALLOWED_ORIGINS. '
  + 'Reached by a host name or through a proxy that rewrites the host, add the origin the browser '
  + 'shows to LYNOX_ALLOWED_ORIGINS, or set LYNOX_HTTP_SECRET.';

export function hostRefusal(input: { host: string | undefined; allowedOrigins: readonly string[] }): string | null {
  const host = input.host;
  if (host === undefined || host === '') return null;
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname; } catch { return NO_SECRET_HOST_REFUSAL; }
  // 127.0.0.1 and [::1] are IP literals; `localhost` is the one name that cannot be pointed elsewhere.
  if (hostname === 'localhost' || isIpLiteral(hostname)) return null;
  for (const origin of input.allowedOrigins) {
    try { if (new URL(origin).hostname === hostname) return null; } catch { /* not an origin */ }
  }
  return NO_SECRET_HOST_REFUSAL;
}

export function crossSiteWriteRefusal(input: {
  method: string;
  origin: string | undefined;
  fetchSite: string | undefined;
  host: string | undefined;
  allowedOrigins: readonly string[];
}): string | null {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  const origin = input.origin;
  if (origin !== undefined && origin !== '') {
    // `null` is what a sandboxed frame or a `file:` page sends; no entry can allow it.
    if (origin === 'null') return CROSS_SITE_WRITE_REFUSAL;
    if (input.allowedOrigins.includes(origin)) return null;
    if (LOCALHOST_ORIGIN.test(origin)) return null;
    let parsed: URL | null = null;
    try { parsed = new URL(origin); } catch { parsed = null; }
    if (parsed !== null && input.host !== undefined && parsed.host === input.host && isIpLiteral(parsed.hostname)) {
      return null;
    }
    return CROSS_SITE_WRITE_REFUSAL;
  }
  if (input.fetchSite === 'cross-site' || input.fetchSite === 'same-site') return CROSS_SITE_WRITE_REFUSAL;
  return null;
}
