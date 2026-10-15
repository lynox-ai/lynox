/**
 * What the egress proxy lets through, as pure functions (PRD 152 v2 §4.2).
 *
 * The shell side speaks one thing: `CONNECT host:443`, followed by a TLS handshake. The order
 * per connection is fixed, and the server keeps it:
 *   1. the credential is live;
 *   2. the port is 443;
 *   3. the NAME is in the credential's set — before any resolution, so a name outside the
 *      set never reaches a resolver and cannot carry data out through one;
 *   4. every address the name resolves to is public and not on the deny list;
 *   5. the proxy connects to exactly the address it checked;
 *   6. with a set of names, the server name in the client's TLS hello must be that same
 *      name — in the second hello too, when the server asks for one (HelloRetryRequest) —
 *      and a hello that carries an encrypted inner hello (ECH) is refused, since the server
 *      would route on the name inside it.
 *
 * What the client sends inside the encrypted session is not visible here. A front end that
 * routes on the encrypted Host header rather than on the server name can still be asked for
 * another of its sites through an allowed name; the proxy does not intercept TLS to see it.
 *
 * After the hello it checked (and the second one after a retry), the proxy passes the
 * handshake on unread. Another plaintext hello sent later is the server's to refuse: a TLS 1.3
 * server expects encrypted records by then, and a TLS 1.2 server is in the middle of its own
 * handshake; a conforming server aborts rather than act on it.
 *
 * Plain http is not offered: its Host header and every later request on the connection
 * would have to be parsed and held to the name. It is refused with its own reason, so a
 * tool that tries it (a package mirror reached over http, say) is told to use https.
 */

import { isIPv4, isIP } from 'node:net';
import { isPrivateIP } from '../core/network-guard.js';
import { CRED_RE, MAX_TTL_S, type HostSet, type Registration } from './registry.js';

export const ALLOWED_PORTS: ReadonlySet<number> = new Set([443]);
export const MAX_SET_SIZE = 256;
/** A TLS client hello spread over several records is read up to this size, then refused. */
export const MAX_HELLO_BYTES = 64 * 1024;
const MAX_LABEL_BYTES = 128;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * An exact host name: lower case, no trailing dot, no wildcard, no IP literal. A last label of
 * digits only, or of `0x` and hex digits, is refused: the resolver reads `1.2.3.4`,
 * `2130706433`, `0x7f000001` and `0x7f.0x1` as addresses, not names.
 */
export function isExactHostname(host: string): boolean {
  if (!HOSTNAME_RE.test(host)) return false;
  const last = host.slice(host.lastIndexOf('.') + 1);
  return !/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last);
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
 * `host:port` from a CONNECT request line. The host is lower-cased. An IPv6 literal is not a
 * host name and is refused with every other non-name (the tenant hosts have no IPv6 egress).
 * A dotted IPv4 literal is returned as is; it can only pass a `'*'` set, and then only if it
 * is public.
 */
export function parseAuthority(authority: string): Parsed<Target> {
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { ok: false, error: 'missing port' };
  const p = authority.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(p)) return { ok: false, error: 'bad port' };
  const host = authority.slice(0, colon).toLowerCase();
  if (!isIPv4(host) && !isExactHostname(host)) return { ok: false, error: 'bad host' };
  return { ok: true, value: { host, port: Number(p) } };
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

/**
 * `LYNOX_EGRESS_PROXY_DENY_IPS`: comma-separated IPv4 addresses, at least one. The tenant
 * host's own public address is never empty, so an empty list is a wiring mistake and the
 * proxy does not start on it.
 */
export function parseDenyIps(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const ip = part.trim();
    if (ip === '') continue;
    if (!isIPv4(ip)) throw new Error(`LYNOX_EGRESS_PROXY_DENY_IPS holds something that is not an IPv4 address: ${ip}`);
    out.add(ip);
  }
  if (out.size === 0) throw new Error('LYNOX_EGRESS_PROXY_DENY_IPS must name at least the tenant host\'s own address');
  return out;
}

/** Documentation and relay ranges that `isPrivateIP` leaves to the network; no real service lives there. */
function isReservedV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
  return (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || (a === 192 && b === 88 && c === 99);
}

/**
 * The address to connect to, or why there is none. Every resolved address must pass, not
 * just the one used: a name that also points inward is refused as a whole.
 */
export function pickAddress(addresses: readonly string[], deny: ReadonlySet<string>): Parsed<string> {
  if (addresses.length === 0) return { ok: false, error: 'no address' };
  for (const ip of addresses) {
    if (isIP(ip) !== 4) return { ok: false, error: 'not an IPv4 address' };
    if (isPrivateIP(ip) || isReservedV4(ip)) return { ok: false, error: 'private address' };
    if (deny.has(ip)) return { ok: false, error: 'denied address' };
  }
  return { ok: true, value: addresses[0]! };
}

export type HelloResult =
  | { state: 'more' }
  | { state: 'hello'; sni: string | null; bytes: number }
  | { state: 'bad'; error: string };

/**
 * Extensions that carry an encrypted inner hello: ECH, and the draft ESNI before it. Clients
 * built on BoringSSL send a GREASE ECH extension by default; they are refused too, since the
 * proxy cannot tell GREASE from a real inner hello. Node, OpenSSL and Go clients send none.
 */
const ENCRYPTED_HELLO_EXTENSIONS: ReadonlySet<number> = new Set([0xfe0d, 0xffce]);

/**
 * The server name of a TLS client hello at the start of `buf`. The hello may span several
 * handshake records; `more` asks for further bytes, up to MAX_HELLO_BYTES. `sni` is `null`
 * when the hello names no server, and lower-cased otherwise. The records that carry the
 * hello must carry nothing else; `bytes` is where they end. What follows them is not part of
 * the hello and is not read here: the caller holds it back, because a client may send a
 * second hello right behind the first. `afterRetry` allows the change_cipher_spec record a
 * TLS 1.3 client may send before its second hello; `bytes` then counts it too.
 */
export function parseClientHello(buf: Buffer, afterRetry = false): HelloResult {
  const hs: Buffer[] = [];
  let hsLen = 0;
  let off = 0;
  let need = -1;
  if (afterRetry) {
    // Before its second hello a TLS 1.3 client may have sent one change_cipher_spec record
    // and, with 0-RTT, early data (encrypted application_data records) behind its first hello.
    // A server skips that early data after a retry; it is passed on with the hello, unread.
    let ccs = 0;
    while (off < buf.length && (buf[off] === 20 || buf[off] === 23)) {
      if (off + 5 > buf.length) return { state: 'more' };
      const len = buf.readUInt16BE(off + 3);
      if (len === 0 || len > 16_384 + 256) return { state: 'bad', error: 'bad record length' };
      if (off + 5 + len > MAX_HELLO_BYTES) return { state: 'bad', error: 'hello too large' };
      if (off + 5 + len > buf.length) return { state: 'more' };
      if (buf[off] === 20 && (len !== 1 || buf[off + 5] !== 1 || ++ccs > 1)) return { state: 'bad', error: 'bad change_cipher_spec' };
      off += 5 + len;
    }
  }
  while (need === -1 || hsLen < need) {
    if (off + 5 > buf.length) return buf.length >= MAX_HELLO_BYTES ? { state: 'bad', error: 'hello too large' } : { state: 'more' };
    if (buf[off] !== 22) return { state: 'bad', error: 'not a TLS handshake' };
    const len = buf.readUInt16BE(off + 3);
    if (len === 0 || len > 16_384 + 2048) return { state: 'bad', error: 'bad record length' };
    if (off + 5 + len > buf.length) return off + 5 + len > MAX_HELLO_BYTES ? { state: 'bad', error: 'hello too large' } : { state: 'more' };
    hs.push(buf.subarray(off + 5, off + 5 + len));
    hsLen += len;
    off += 5 + len;
    if (need === -1 && hsLen >= 4) {
      const head = Buffer.concat(hs);
      if (head[0] !== 1) return { state: 'bad', error: 'not a client hello' };
      need = 4 + head.readUIntBE(1, 3);
      if (need > MAX_HELLO_BYTES) return { state: 'bad', error: 'hello too large' };
    }
  }
  if (hsLen > need) return { state: 'bad', error: 'more than one handshake message' };
  const h = Buffer.concat(hs).subarray(4, need);
  try {
    let p = 2 + 32;
    p += 1 + h.readUInt8(p);
    p += 2 + h.readUInt16BE(p);
    p += 1 + h.readUInt8(p);
    if (p > h.length) return { state: 'bad', error: 'truncated hello' };
    if (p === h.length) return { state: 'hello', sni: null, bytes: off };
    const extEnd = p + 2 + h.readUInt16BE(p);
    if (extEnd > h.length) return { state: 'bad', error: 'truncated extensions' };
    p += 2;
    let sni: string | null = null;
    while (p < extEnd) {
      const type = h.readUInt16BE(p);
      const len = h.readUInt16BE(p + 2);
      const end = p + 4 + len;
      if (end > extEnd) return { state: 'bad', error: 'truncated extension' };
      if (ENCRYPTED_HELLO_EXTENSIONS.has(type)) return { state: 'bad', error: 'encrypted client hello' };
      if (type === 0) {
        let q = p + 4 + 2;
        const listEnd = q + h.readUInt16BE(p + 4);
        if (listEnd > end) return { state: 'bad', error: 'bad server_name list' };
        while (q < listEnd) {
          const nameType = h.readUInt8(q);
          const nameLen = h.readUInt16BE(q + 1);
          if (q + 3 + nameLen > listEnd) return { state: 'bad', error: 'bad server_name entry' };
          if (nameType === 0) {
            // Also catches a second server_name extension.
            if (sni !== null) return { state: 'bad', error: 'two host names' };
            sni = h.subarray(q + 3, q + 3 + nameLen).toString('latin1').toLowerCase();
          }
          q += 3 + nameLen;
        }
      }
      p = end;
    }
    return { state: 'hello', sni, bytes: off };
  } catch {
    return { state: 'bad', error: 'truncated hello' };
  }
}

/** The `random` of a ServerHello that is really a HelloRetryRequest (RFC 8446 §4.1.3). */
const HELLO_RETRY_RANDOM = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex');

/**
 * Whether the server's first bytes are a HelloRetryRequest, after which the client sends a
 * second hello that must be checked too. The start of the server's handshake is put together
 * across records, so a ServerHello split into small records is still read. Anything that is
 * not a plaintext ServerHello is `no`. The bytes waited for stay bounded: every record adds
 * at least one byte toward the 38 needed, and one record holds at most 64 KiB.
 */
export function isHelloRetryRequest(buf: Buffer): 'yes' | 'no' | 'more' {
  const need = 4 + 2 + 32;
  const hs: Buffer[] = [];
  let len = 0;
  let off = 0;
  while (len < need) {
    if (off + 5 > buf.length) return 'more';
    if (buf[off] !== 22) return 'no';
    const recLen = buf.readUInt16BE(off + 3);
    if (recLen === 0) return 'no';
    if (off + 5 + recLen > buf.length) return 'more';
    hs.push(buf.subarray(off + 5, off + 5 + recLen));
    len += recLen;
    off += 5 + recLen;
  }
  const h = Buffer.concat(hs);
  if (h[0] !== 2) return 'no';
  return h.subarray(4 + 2, need).equals(HELLO_RETRY_RANDOM) ? 'yes' : 'no';
}
