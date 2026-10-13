/**
 * Which state-changing requests a server WITHOUT `LYNOX_HTTP_SECRET` accepts from a browser.
 *
 * Without a secret every request is admin, so the only thing that tells a request the user made
 * from one another site made in the user's browser is where the browser says it came from. A
 * browser sends `Origin` on every POST/PUT/PATCH/DELETE, and `Sec-Fetch-Site` alongside it.
 *
 * Accepted:
 *   - safe methods (GET, HEAD, OPTIONS) — this check is about writes;
 *   - an `Origin` listed in `LYNOX_ALLOWED_ORIGINS`;
 *   - a localhost `Origin` (the same set the CORS block treats as local);
 *   - an `Origin` that is this server itself, reached by IP address: its host equals the
 *     `Host` header and is an IP literal. A NAME is not enough, because a name can be pointed
 *     at this server by someone else; a server reached by name sets `LYNOX_ALLOWED_ORIGINS`;
 *   - a request with neither header — curl, the CLI, an MCP client, a server-side fetch. No
 *     browser sends a write without `Origin`, so this is not a browser request.
 * Refused: any other `Origin` (including `null`), and, without `Origin`, a `Sec-Fetch-Site` of
 * `cross-site` or `same-site`.
 *
 * Returns the refusal text, or null when the request may proceed.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true; // IPv6, as URL writes it
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export const CROSS_SITE_WRITE_REFUSAL =
  'Refused: this server runs without LYNOX_HTTP_SECRET and accepts changes from a browser only on '
  + 'localhost, on its own IP address, or from an origin listed in LYNOX_ALLOWED_ORIGINS. '
  + 'Reached by a host name, set LYNOX_ALLOWED_ORIGINS to that origin, or set LYNOX_HTTP_SECRET.';

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
