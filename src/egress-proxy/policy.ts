/**
 * What the egress proxy lets through, as pure functions (PRD 152 v2 §4.2).
 *
 * The order per connection is fixed, and the server keeps it:
 *   1. the credential is live;
 *   2. the port is 443 or 80;
 *   3. the NAME is in the credential's set — before any resolution, so a name outside the
 *      set never reaches a resolver and cannot carry data out through one;
 *   4. every address the name resolves to is public and not on the deny list;
 *   5. the proxy connects to exactly the address it checked.
 */

import { isIPv4, isIP } from 'node:net';
import { isPrivateIP } from '../core/network-guard.js';
import { CRED_RE, MAX_TTL_S, type HostSet, type Registration } from './registry.js';

export const ALLOWED_PORTS: ReadonlySet<number> = new Set([443, 80]);
export const MAX_SET_SIZE = 256;
const MAX_LABEL_BYTES = 128;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * An exact host name: lower case, no trailing dot, no wildcard, no IP literal. A last label
 * of digits only is refused, so `1.2.3.4` and `1.2.3.0x4`-style forms never count as names.
 */
export function isExactHostname(host: string): boolean {
  if (!HOSTNAME_RE.test(host)) return false;
  const last = host.slice(host.lastIndexOf('.') + 1);
  return !/^[0-9]+$/.test(last);
}

export function isCredential(cred: string): boolean {
  return CRED_RE.test(cred);
}

function isLabel(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= MAX_LABEL_BYTES;
}

/** The body of `PUT /cred/<cred>`: `{set: string[] | '*', ttl_s, run, session}`. */
export function parseRegistration(body: unknown): Parsed<Registration> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['set', 'ttl_s', 'run', 'session'].includes(key)) return { ok: false, error: `unknown field ${key}` };
  }
  let set: HostSet;
  if (b['set'] === '*') {
    set = '*';
  } else if (Array.isArray(b['set'])) {
    const hosts = b['set'] as unknown[];
    if (hosts.length > MAX_SET_SIZE) return { ok: false, error: `set holds at most ${String(MAX_SET_SIZE)} hosts` };
    for (const h of hosts) {
      if (typeof h !== 'string' || !isExactHostname(h)) return { ok: false, error: 'set holds exact lower-case host names only' };
    }
    set = new Set(hosts as string[]);
  } else {
    return { ok: false, error: "set must be an array of host names or '*'" };
  }
  const ttl = b['ttl_s'];
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_S) {
    return { ok: false, error: `ttl_s must be a whole number from 1 to ${String(MAX_TTL_S)}` };
  }
  if (!isLabel(b['run']) || !isLabel(b['session'])) return { ok: false, error: 'run and session must be non-empty strings' };
  return { ok: true, value: { set, ttlS: ttl, run: b['run'], session: b['session'] } };
}

export interface Target {
  host: string;
  port: number;
}

/**
 * `host:port` from a CONNECT request line or an absolute-form URL. The host is lower-cased;
 * an IPv6 literal is not a host name and is refused with every other non-name (the tenant
 * hosts have no IPv6 egress). An IPv4 literal is
 * returned as is; it can only pass a `'*'` set, and then only if it is public.
 */
export function parseAuthority(authority: string, defaultPort?: number): Parsed<Target> {
  const colon = authority.lastIndexOf(':');
  let host = authority;
  let port = defaultPort;
  if (colon !== -1) {
    host = authority.slice(0, colon);
    const p = authority.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(p)) return { ok: false, error: 'bad port' };
    port = Number(p);
  }
  if (port === undefined) return { ok: false, error: 'missing port' };
  host = host.toLowerCase();
  if (!isIPv4(host) && !isExactHostname(host)) return { ok: false, error: 'bad host' };
  return { ok: true, value: { host, port } };
}

/** The credential from a `Proxy-Authorization: Basic …` header, or `null`. */
export function credentialFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Basic +([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const user = colon === -1 ? decoded : decoded.slice(0, colon);
  return isCredential(user) ? user : null;
}

/** `LYNOX_EGRESS_PROXY_DENY_IPS`: comma-separated IPv4 addresses. Anything else is a startup error. */
export function parseDenyIps(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (raw === undefined || raw.trim() === '') return out;
  for (const part of raw.split(',')) {
    const ip = part.trim();
    if (ip === '') continue;
    if (!isIPv4(ip)) throw new Error(`LYNOX_EGRESS_PROXY_DENY_IPS holds something that is not an IPv4 address: ${ip}`);
    out.add(ip);
  }
  return out;
}

/**
 * The address to connect to, or why there is none. Every resolved address must pass, not
 * just the one used: a name that also points inward is refused as a whole.
 */
export function pickAddress(addresses: readonly string[], deny: ReadonlySet<string>): Parsed<string> {
  if (addresses.length === 0) return { ok: false, error: 'no address' };
  for (const ip of addresses) {
    if (isIP(ip) !== 4) return { ok: false, error: 'not an IPv4 address' };
    if (isPrivateIP(ip)) return { ok: false, error: 'private address' };
    if (deny.has(ip)) return { ok: false, error: 'denied address' };
  }
  return { ok: true, value: addresses[0]! };
}
