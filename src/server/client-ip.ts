import type { IncomingMessage } from 'node:http';

/**
 * Minimal shape needed to resolve a client IP — a real {@link IncomingMessage}
 * satisfies it, and tests can construct it directly without a live socket.
 */
export interface ProxyAwareRequest {
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly headers: IncomingMessage['headers'];
}

/**
 * How many trailing `X-Forwarded-For` entries are appended by trusted proxies
 * (default 1 = a single reverse proxy, e.g. Traefik in managed deployments).
 * The real client is the entry that many hops from the RIGHT. Bump only when
 * more trusted proxies are chained in front (e.g. a CDN ahead of Traefik).
 */
function trustedHops(): number {
  const raw = process.env['LYNOX_TRUSTED_PROXY_HOPS'];
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Strip a trailing `:port` (IPv4 `1.2.3.4:5` / bracketed IPv6 `[::1]:5`) and
 * the IPv4-mapped-IPv6 `::ffff:` prefix, yielding a bare address.
 */
function normalizeIp(addr: string): string {
  // Strip the IPv4-mapped-IPv6 `::ffff:` prefix FIRST so a mapped address that
  // also carries a port (`::ffff:1.2.3.4:56789`) collapses to a single-colon
  // `host:port` the port-strip below handles — otherwise its 4 colons look like
  // a bare IPv6 and the port is kept.
  let host = addr.replace(/^::ffff:/, '');
  const bracket = /^\[(.+)\](?::\d+)?$/.exec(host);
  if (bracket?.[1]) {
    host = bracket[1].replace(/^::ffff:/, '');
  } else if ((host.match(/:/g)?.length ?? 0) === 1) {
    // Exactly one colon ⇒ IPv4 `host:port`; bare IPv6 has multiple colons → leave it.
    const h = host.split(':')[0];
    if (h) host = h;
  }
  return host;
}

/**
 * Resolve the real client IP from a proxy-aware request, resistant to
 * client-supplied `X-Forwarded-For` spoofing.
 *
 * When `trustProxy` is false the value is the direct TCP peer
 * (`socket.remoteAddress`) — no header is trusted.
 *
 * When `trustProxy` is true the engine runs behind a reverse proxy (managed
 * deployments front it with Traefik) that APPENDS the address it observed to
 * `X-Forwarded-For`. A hostile client can pre-populate the header
 * (`X-Forwarded-For: 1.2.3.4`) and the proxy turns it into
 * `1.2.3.4, <real-client>` — so the trustworthy value is the entry the proxy
 * appended (counted from the RIGHT via {@link trustedHops}), never the
 * left-most (attacker-controllable) one. If the header is absent, shorter than
 * the configured hop count, or otherwise underivable, we fall back to the
 * direct socket peer (the proxy itself) — never the spoofable left-most entry.
 */
export function resolveClientIp(req: ProxyAwareRequest, trustProxy: boolean): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return normalizeIp(socketIp);

  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof chain === 'string') {
    const parts = chain
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const idx = parts.length - trustedHops();
    const entry = idx >= 0 ? parts[idx] : undefined;
    if (entry) return normalizeIp(entry);
  }
  return normalizeIp(socketIp);
}
