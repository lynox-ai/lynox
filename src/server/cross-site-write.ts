/**
 * What a server answers to when the request may come from a browser and its credential is one
 * the browser attaches on its own.
 *
 * Without a secret every request is the owner, so the only thing that separates a request the
 * user made from one another site made in the user's browser is what the browser says about it.
 * The same holds for the session cookie when there is a secret. Checks 1 and 2 apply only when
 * there is no secret; check 3 also to a request signed in by the session cookie:
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
 *      only to a secure context, so over plain HTTP to anything but loopback, `Origin` is the
 *      one header that carries the decision.
 *    Refused: any other `Origin` (`null` included, which a sandboxed frame or a `file:` page
 *    sends), and, without `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site`.
 *
 * 3. `ambientCrossSiteRefusal` — a GET or HEAD that declares an effect, and every write, when the
 *    credential is no secret at all or the session cookie. Its cases are at the function.
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

/**
 * Whether a browser-sent `Origin` is one this server takes changes from. Shared by both checks
 * below, so the `null` case and the port comparison are one definition, not two.
 * `ownOrigins`: this server's own origin reached by NAME, scheme included — one when the server
 * knows the scheme the browser used, both when it does not (see the caller). Given only for a
 * request that carries the session cookie: the cookie is bound to the name the user signed in on,
 * so a page that points a name of its own at this server reaches it without the cookie. Without a
 * secret there is no such binding, and the own origin counts only as an IP address.
 */
function originAccepted(origin: string, host: string | undefined, allowedOrigins: readonly string[], ownOrigins: readonly string[] = []): boolean {
  // `null` is what a sandboxed frame or a `file:` page sends; no entry can allow it.
  if (origin === 'null') return false;
  if (allowedOrigins.includes(origin)) return true;
  if (LOCALHOST_ORIGIN.test(origin)) return true;
  let parsed: URL | null = null;
  try { parsed = new URL(origin); } catch { parsed = null; }
  if (parsed === null) return false;
  for (const own of ownOrigins) {
    try { if (parsed.origin === new URL(own).origin) return true; } catch { /* not an origin */ }
  }
  return host !== undefined && parsed.host === host && isIpLiteral(parsed.hostname);
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
    return originAccepted(origin, input.host, input.allowedOrigins) ? null : CROSS_SITE_WRITE_REFUSAL;
  }
  if (input.fetchSite === 'cross-site' || input.fetchSite === 'same-site') return CROSS_SITE_WRITE_REFUSAL;
  return null;
}

export const AMBIENT_CROSS_SITE_REFUSAL =
  'Refused: the browser says another site sent this request, and it carries a sign-in the browser '
  + 'adds on its own. Send it from this instance\'s own pages, from localhost, or from an origin '
  + 'listed in LYNOX_ALLOWED_ORIGINS.';

/**
 * 3. `ambientCrossSiteRefusal` — a request whose credential the browser attaches on its own, so
 *    another site can make the browser send it. The caller decides when that is: no secret at all
 *    (every request is the owner), or the session cookie, which is `SameSite=Lax` and travels on
 *    a navigation from another site and on every request from a sibling host under the same
 *    registrable domain (`same-site`). A bearer token is never attached by the browser and is not
 *    checked here. The caller applies it to a GET or HEAD whose route declares an effect (its
 *    stance is not `reads`) and to every write; without a secret the writes have met check 2
 *    already, which refuses everything this one would. Accepted:
 *    - `Sec-Fetch-Site` of `same-origin` or `none` (typed, bookmarked, opened from outside a
 *      browser), whatever the `Origin`;
 *    - otherwise an `Origin` that `originAccepted` takes; with the cookie, `ownOrigins` (this
 *      server by name, scheme included) count as well;
 *    - a request with neither header (curl, the CLI, a server-side fetch).
 *    - a `Sec-Fetch-Site` value other than the four a browser sends, without an `Origin`. A page
 *      cannot set the header, so only a client that is not a browser sends one.
 *    Refused: a `Sec-Fetch-Site` of `cross-site` or `same-site` without an accepted `Origin`, and
 *    any `Origin` that is not accepted. A navigation or an `<img>` sends no `Origin` on a GET, so
 *    for them `Sec-Fetch-Site` is the whole decision.
 */
export function ambientCrossSiteRefusal(input: {
  origin: string | undefined;
  fetchSite: string | undefined;
  host: string | undefined;
  allowedOrigins: readonly string[];
  /** This server's own origin by name, given only with the session cookie (see `originAccepted`). */
  ownOrigins: readonly string[];
}): string | null {
  if (input.fetchSite === 'same-origin' || input.fetchSite === 'none') return null;
  const origin = input.origin;
  if (origin !== undefined && origin !== '') {
    return originAccepted(origin, input.host, input.allowedOrigins, input.ownOrigins) ? null : AMBIENT_CROSS_SITE_REFUSAL;
  }
  if (input.fetchSite === 'cross-site' || input.fetchSite === 'same-site') return AMBIENT_CROSS_SITE_REFUSAL;
  return null;
}
