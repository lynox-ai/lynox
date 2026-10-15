import { describe, it, expect, afterEach } from 'vitest';
import { Socket, connect, createServer, type AddressInfo, type Server } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Server as HttpServer } from 'node:http';
import { MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CredentialRegistry, DENIAL_REASONS, DENIAL_RETENTION_MS, MAX_CREDS, MAX_DENIED_HOST_CHARS, MAX_DENIALS_PER_CRED, MAX_TTL_S, type TunnelHandle } from './registry.js';
import { MAX_HELLO_BYTES, credentialFromHeader, isExactHostname, isHelloRetryRequest, parseAuthority, parseClientHello, parseDenyIps, parseRegistration, pickAddress } from './policy.js';
import { ShellProxy, bearerMatches, createAdminServer, type ProxyLimits } from './server.js';
import { interfaceAddress, secretFromEnv } from './main.js';

const CRED = 'A'.repeat(43);
const CRED2 = 'b'.repeat(42) + '_';
const SECRET = 's'.repeat(40);
const basic = (user: string): string => `Basic ${Buffer.from(user).toString('base64')}`;
const reg = (set: string[] | '*', ttlS = 60) => ({ set: set === '*' ? '*' as const : new Set(set), ttlS, run: 'r', session: 's' });

const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24 = (n: number): Buffer => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/**
 * A minimal TLS 1.2-shaped client hello. `names` go into one server_name extension (none:
 * no extension); `sniExtensions` repeats it; `records` splits the handshake into that many.
 */
function hello(names: string[] | null, opts: { records?: number; sniExtensions?: number; padding?: number; extension?: number } = {}): Buffer {
  const exts: Buffer[] = [];
  if (names !== null) {
    const list = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([0]), u16(n.length), Buffer.from(n, 'latin1')])));
    const data = Buffer.concat([u16(list.length), list]);
    for (let i = 0; i < (opts.sniExtensions ?? 1); i++) exts.push(Buffer.concat([u16(0), u16(data.length), data]));
  }
  if (opts.padding) exts.push(Buffer.concat([u16(21), u16(opts.padding), Buffer.alloc(opts.padding)]));
  if (opts.extension !== undefined) exts.push(Buffer.concat([u16(opts.extension), u16(4), Buffer.alloc(4)]));
  const extBlock = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]),
    ...(extBlock.length === 0 ? [] : [u16(extBlock.length), extBlock]),
  ]);
  const hs = Buffer.concat([Buffer.from([1]), u24(body.length), body]);
  const n = opts.records ?? 1;
  const size = Math.ceil(hs.length / n);
  const recs: Buffer[] = [];
  for (let off = 0; off < hs.length; off += size) {
    const part = hs.subarray(off, off + size);
    recs.push(Buffer.concat([Buffer.from([22, 3, 1]), u16(part.length), part]));
  }
  return Buffer.concat(recs);
}

/** A plaintext ServerHello record; with `retry` its random marks it as a HelloRetryRequest. */
function serverHello(retry: boolean): Buffer {
  const random = retry ? Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex') : Buffer.alloc(32, 7);
  const body = Buffer.concat([Buffer.from([3, 3]), random, Buffer.from([0]), Buffer.from([0x13, 0x01]), Buffer.from([0]), u16(0)]);
  const hs = Buffer.concat([Buffer.from([2]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([22, 3, 3]), u16(hs.length), hs]);
}

/** The change_cipher_spec record a TLS 1.3 client may send before its second hello. */
const CCS = Buffer.from([20, 3, 3, 0, 1, 1]);

/** The first bytes a real `node:tls` client sends for `servername`. */
function realHello(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = createServer((s) => {
      s.once('data', (d: Buffer) => { resolve(d); s.destroy(); server.close(); });
    });
    server.listen(0, '127.0.0.1', () => {
      const c = tlsConnect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, servername });
      c.on('error', () => { /* the stand-in closes it */ });
    });
  });
}

describe('policy', () => {
  it('takes exact lower-case host names and nothing else', () => {
    expect(isExactHostname('api.example.com')).toBe(true);
    expect(isExactHostname('a-b.example')).toBe(true);
    expect(isExactHostname('a.0xample')).toBe(true);
    for (const bad of [
      'API.example.com', '*.example.com', 'example.com.', '1.2.3.4', '10.0.0.010', '2130706433', '0x7f000001', '0x7f.0x1', 'a.0x7f',
      '', 'a..b', '-a.com', 'a_b.com', `${'a'.repeat(64)}.com`,
    ]) {
      expect(isExactHostname(bad), bad).toBe(false);
    }
  });

  it('caps a credential at the longest shell call plus five seconds', () => {
    expect(MAX_TTL_S).toBe(Math.ceil(MAX_EXEC_TIMEOUT_MS / 1000) + 5);
    expect(MAX_TTL_S).toBe(905);
    expect(parseRegistration({ set: [], ttl_s: MAX_TTL_S, run: 'r', session: 's' }).ok).toBe(true);
    expect(parseRegistration({ set: [], ttl_s: MAX_TTL_S + 1, run: 'r', session: 's' }).ok).toBe(false);
  });

  it('refuses a bad registration body', () => {
    const ok = { set: ['api.example.com'], ttl_s: 30, run: 'r', session: 's' };
    expect(parseRegistration(ok)).toMatchObject({ ok: true, value: { ttlS: 30, run: 'r', session: 's' } });
    expect(parseRegistration({ ...ok, set: '*' })).toMatchObject({ ok: true, value: { set: '*' } });
    for (const bad of [
      null, [], 'x', { ...ok, set: ['*.example.com'] }, { ...ok, set: ['10.0.0.1'] }, { ...ok, set: ['0x5db8d70e'] }, { ...ok, set: 'all' },
      { ...ok, set: [1] }, { ...ok, ttl_s: 0 }, { ...ok, ttl_s: -1 }, { ...ok, ttl_s: 1.5 }, { ...ok, ttl_s: '30' },
      { ...ok, run: '' }, { ...ok, session: 3 }, { ...ok, extra: 1 },
    ]) {
      expect(parseRegistration(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads host and port from a CONNECT target, refusing IPv6 and non-names', () => {
    expect(parseAuthority('API.Example.com:443')).toEqual({ ok: true, value: { host: 'api.example.com', port: 443 } });
    expect(parseAuthority('1.2.3.4:443')).toEqual({ ok: true, value: { host: '1.2.3.4', port: 443 } });
    for (const bad of ['[::1]:443', 'example.com', 'example.com:x', 'example.com:123456', 'a b:443', 'example.com.:443', '0x7f000001:443']) {
      expect(parseAuthority(bad).ok, bad).toBe(false);
    }
  });

  it('reads the credential from Basic auth, with or without a colon', () => {
    expect(credentialFromHeader(basic(`${CRED}:`))).toBe(CRED);
    expect(credentialFromHeader(basic(CRED))).toBe(CRED);
    expect(credentialFromHeader(basic(`${CRED}:pw`))).toBe(CRED);
    expect(credentialFromHeader(basic('short:'))).toBeNull();
    expect(credentialFromHeader(`Bearer ${CRED}`)).toBeNull();
    expect(credentialFromHeader(undefined)).toBeNull();
  });

  it('refuses a name when ANY of its addresses is private, reserved, denied or not IPv4', () => {
    const deny = parseDenyIps(' 93.184.215.99 ,198.51.100.7');
    expect(pickAddress(['93.184.215.14', '93.184.215.15'], deny)).toEqual({ ok: true, value: '93.184.215.14' });
    for (const inward of ['10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1']) {
      expect(pickAddress(['93.184.215.14', inward], deny), inward).toEqual({ ok: false, error: 'private address' });
    }
    expect(pickAddress(['93.184.215.14', '93.184.215.99'], deny)).toEqual({ ok: false, error: 'denied address' });
    expect(pickAddress(['2606:2800::1'], deny).ok).toBe(false);
    expect(pickAddress([], deny).ok).toBe(false);
  });

  it('does not start on an empty deny list, or one with anything but IPv4 addresses', () => {
    expect([...parseDenyIps('93.184.215.99')]).toEqual(['93.184.215.99']);
    expect(() => parseDenyIps(undefined)).toThrow(/at least/);
    expect(() => parseDenyIps(' , ')).toThrow(/at least/);
    expect(() => parseDenyIps('1.2.3.4,example.com')).toThrow(/not an IPv4/);
    expect(() => parseDenyIps('10.0.0.0/8')).toThrow(/not an IPv4/);
  });

  it('reads the server name of a real TLS client hello', async () => {
    const bytes = await realHello('api.example.com');
    expect(parseClientHello(bytes)).toMatchObject({ state: 'hello', sni: 'api.example.com' });
    expect(parseClientHello(bytes.subarray(0, bytes.length - 1))).toEqual({ state: 'more' });
  });

  it('reads the server name across records, and refuses what is not one plain hello', () => {
    expect(parseClientHello(hello(['a.example']))).toMatchObject({ state: 'hello', sni: 'a.example' });
    expect(parseClientHello(hello(['A.Example']))).toMatchObject({ state: 'hello', sni: 'a.example' });
    expect(parseClientHello(hello(['a.example'], { records: 3 }))).toMatchObject({ state: 'hello', sni: 'a.example' });
    expect(parseClientHello(hello(null))).toMatchObject({ state: 'hello', sni: null });
    expect(parseClientHello(hello(['a.example', 'b.example'])).state).toBe('bad');
    expect(parseClientHello(hello(['a.example'], { sniExtensions: 2 })).state).toBe('bad');
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).state).toBe('bad');
    expect(parseClientHello(Buffer.from([22, 3, 1]))).toEqual({ state: 'more' });
    // A handshake that announces more than the cap is refused before it is read.
    const claim = Buffer.concat([Buffer.from([22, 3, 1]), u16(4), Buffer.from([1]), u24(MAX_HELLO_BYTES)]);
    expect(parseClientHello(claim)).toEqual({ state: 'bad', error: 'hello too large' });
    expect(parseClientHello(Buffer.concat([Buffer.from([22, 3, 1]), u16(4), Buffer.from([1]), u24(MAX_HELLO_BYTES - 4)]))).toEqual({ state: 'more' });
  });
});

describe('policy: TLS hellos', () => {
  it('refuses a hello whose records are not all handshake records, or that is not a client hello', () => {
    const two = hello(['a.example'], { records: 2 });
    const firstLen = 5 + two.readUInt16BE(3);
    const mixed = Buffer.from(two);
    mixed[firstLen] = 23;
    expect(parseClientHello(two)).toMatchObject({ state: 'hello', sni: 'a.example' });
    expect(parseClientHello(mixed)).toEqual({ state: 'bad', error: 'not a TLS handshake' });
    const notClient = Buffer.from(hello(['a.example']));
    notClient[5] = 2;
    expect(parseClientHello(notClient)).toEqual({ state: 'bad', error: 'not a client hello' });
  });

  it('refuses records that hold more than the one hello', () => {
    const h = hello(['a.example']);
    const extra = Buffer.from([1, 0, 0, 0]);
    const rec = Buffer.concat([Buffer.from([22, 3, 1]), u16(h.length - 5 + extra.length), h.subarray(5), extra]);
    expect(parseClientHello(rec)).toEqual({ state: 'bad', error: 'more than one handshake message' });
  });

  it('refuses a hello that carries an encrypted inner hello', () => {
    expect(parseClientHello(hello(['a.example'], { extension: 0xfe0d }))).toEqual({ state: 'bad', error: 'encrypted client hello' });
    expect(parseClientHello(hello(['a.example'], { extension: 0xffce }))).toEqual({ state: 'bad', error: 'encrypted client hello' });
    expect(parseClientHello(hello(['a.example'], { extension: 0x002b }))).toMatchObject({ state: 'hello', sni: 'a.example' });
  });

  it('says where the hello ends, so bytes behind it are not taken for part of it', () => {
    const h = hello(['a.example']);
    expect(parseClientHello(Buffer.concat([h, CCS, hello(['evil.example'])]))).toEqual({ state: 'hello', sni: 'a.example', bytes: h.length });
    expect(parseClientHello(Buffer.concat([CCS, h, Buffer.from('x')]), true)).toEqual({ state: 'hello', sni: 'a.example', bytes: CCS.length + h.length });
    expect(parseClientHello(hello(null))).toEqual({ state: 'hello', sni: null, bytes: hello(null).length });
  });

  it('takes a change_cipher_spec record before a second hello only', () => {
    const second = Buffer.concat([CCS, hello(['a.example'])]);
    expect(parseClientHello(second, true)).toMatchObject({ state: 'hello', sni: 'a.example' });
    expect(parseClientHello(second)).toEqual({ state: 'bad', error: 'not a TLS handshake' });
    expect(parseClientHello(CCS.subarray(0, 4), true)).toEqual({ state: 'more' });
    expect(parseClientHello(Buffer.from([20, 3, 3, 0, 2, 1, 1]), true).state).toBe('bad');
    expect(parseClientHello(Buffer.concat([Buffer.from([20, 3, 3, 0, 1, 2]), hello(['a.example'])]), true).state).toBe('bad');
  });

  it('passes early data before a second hello, and nothing else', () => {
    const early = Buffer.concat([Buffer.from([23, 3, 3]), u16(5), Buffer.from('early')]);
    const h = hello(['a.example']);
    expect(parseClientHello(Buffer.concat([CCS, early, h]), true)).toEqual({ state: 'hello', sni: 'a.example', bytes: CCS.length + early.length + h.length });
    expect(parseClientHello(Buffer.concat([early, CCS, early, h]), true)).toEqual({ state: 'hello', sni: 'a.example', bytes: 2 * early.length + CCS.length + h.length });
    expect(parseClientHello(Buffer.concat([CCS, CCS, h]), true)).toEqual({ state: 'bad', error: 'bad change_cipher_spec' });
    expect(parseClientHello(Buffer.concat([Buffer.from([23, 3, 3, 0, 0]), h]), true)).toEqual({ state: 'bad', error: 'bad record length' });
    expect(parseClientHello(Buffer.concat([CCS, early.subarray(0, 7)]), true)).toEqual({ state: 'more' });
    // One record may not exceed the TLS limit, and all of it together not MAX_HELLO_BYTES.
    expect(parseClientHello(Buffer.from([23, 3, 3, 0x41, 0x01]), true)).toEqual({ state: 'bad', error: 'bad record length' });
    const full = Buffer.concat([Buffer.from([23, 3, 3]), u16(16_640), Buffer.alloc(16_640)]);
    expect(parseClientHello(Buffer.concat([full, full, full]), true)).toEqual({ state: 'more' });
    // Refused as soon as a record is announced that would go past the bound, before it is read.
    expect(parseClientHello(Buffer.concat([full, full, full, full.subarray(0, 5)]), true)).toEqual({ state: 'bad', error: 'hello too large' });
    // Without a retry, early data in front of the hello is not a hello.
    expect(parseClientHello(Buffer.concat([early, h])).state).toBe('bad');
  });

  it('tells a HelloRetryRequest from a ServerHello and anything else', () => {
    expect(isHelloRetryRequest(serverHello(true))).toBe('yes');
    expect(isHelloRetryRequest(serverHello(false))).toBe('no');
    expect(isHelloRetryRequest(serverHello(true).subarray(0, 20))).toBe('more');
    expect(isHelloRetryRequest(Buffer.alloc(0))).toBe('more');
    expect(isHelloRetryRequest(Buffer.from([21, 3, 3, 0, 2, 2, 40]))).toBe('no');
    const notServer = Buffer.from(serverHello(true));
    notServer[5] = 1;
    expect(isHelloRetryRequest(notServer)).toBe('no');
    expect(isHelloRetryRequest(Buffer.from([22, 3, 3, 0, 0]))).toBe('no');
  });

  it('reads a HelloRetryRequest split into small records', () => {
    const split = (b: Buffer, size: number): Buffer => {
      const hs = b.subarray(5);
      const out: Buffer[] = [];
      for (let o = 0; o < hs.length; o += size) out.push(Buffer.concat([Buffer.from([22, 3, 3]), u16(Math.min(size, hs.length - o)), hs.subarray(o, o + size)]));
      return Buffer.concat(out);
    };
    expect(isHelloRetryRequest(split(serverHello(true), 7))).toBe('yes');
    expect(isHelloRetryRequest(split(serverHello(false), 7))).toBe('no');
    expect(isHelloRetryRequest(split(serverHello(true), 7).subarray(0, 30))).toBe('more');
    // A record of another type in between ends the reading: not a plain ServerHello.
    const mixed = Buffer.from(split(serverHello(true), 7));
    mixed[12] = 21;
    expect(isHelloRetryRequest(mixed)).toBe('no');
  });
});

describe('registry', () => {
  const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };
  const tunnel = (host: string) => { const t = { host, closed: 0, close: () => { t.closed++; } }; return t; };

  it('expires a credential at its ttl and keeps its denials for 60 s after', () => {
    const c = clock();
    const r = new CredentialRegistry(c.now);
    r.put(CRED, reg(['a.example'], 10));
    r.recordDenial(CRED, 'b.example', 443, 'not-in-set');
    c.t += 9_999;
    expect(r.lookup(CRED)).not.toBeNull();
    c.t += 1;
    expect(r.lookup(CRED)).toBeNull();
    expect(r.denials(CRED)).toEqual([{ host: 'b.example', port: 443, at: 1_000_000, reason: 'not-in-set' }]);
    c.t += DENIAL_RETENTION_MS - 1;
    expect(r.denials(CRED)).not.toBeNull();
    c.t += 1;
    expect(r.denials(CRED)).toBeNull();
  });

  it('keeps denials across a replace and forgets them 60 s after a delete', () => {
    const c = clock();
    const r = new CredentialRegistry(c.now);
    r.put(CRED, reg(['a.example']));
    r.recordDenial(CRED, 'b.example', 443, 'not-in-set');
    r.put(CRED, reg(['b.example']));
    expect(r.lookup(CRED)?.set).toEqual(new Set(['b.example']));
    expect(r.denials(CRED)).toHaveLength(1);
    r.delete(CRED);
    r.delete(CRED);
    expect(r.lookup(CRED)).toBeNull();
    c.t += DENIAL_RETENTION_MS - 1;
    expect(r.denials(CRED)).toHaveLength(1);
    c.t += 1;
    expect(r.denials(CRED)).toBeNull();
    expect(r.denials(CRED2)).toBeNull();
  });

  it('closes tunnels on delete, on expiry, and on a replace that drops their host', () => {
    const c = clock();
    const r = new CredentialRegistry(c.now);
    r.put(CRED, reg(['a.example', 'b.example'], 10));
    const a = tunnel('a.example');
    const b = tunnel('b.example');
    expect(r.attach(CRED, a)).toBe(true);
    expect(r.attach(CRED, b)).toBe(true);
    r.put(CRED, reg(['a.example'], 10));
    expect([a.closed, b.closed]).toEqual([0, 1]);
    c.t += 10_000;
    r.sweep();
    expect(a.closed).toBe(1);
    expect(r.attach(CRED, tunnel('a.example'))).toBe(false);

    r.put(CRED2, reg('*'));
    const d = tunnel('x.example');
    r.attach(CRED2, d as TunnelHandle);
    r.delete(CRED2);
    expect(d.closed).toBe(1);
  });

  it('names every denial reason in a closed set', () => {
    expect([...DENIAL_REASONS].sort()).toEqual(
      ['bad-hello', 'bad-target', 'hello-timeout', 'no-sni', 'not-in-set', 'plain-http', 'port', 'sni-mismatch', 'ssrf'],
    );
  });

  it('keeps only printable ASCII without spaces in a denied host, cut to MAX_DENIED_HOST_CHARS', () => {
    const r = new CredentialRegistry(() => 0);
    r.put(CRED, reg([]));
    r.recordDenial(CRED, 'a b\u0000\u001b[31m\u00e9\u202e.example', 443, 'bad-target');
    r.recordDenial(CRED, 'x'.repeat(MAX_DENIED_HOST_CHARS + 50), 443, 'bad-target');
    const [first, second] = r.denials(CRED) ?? [];
    expect(first?.host).toBe('a?b??[31m??.example');
    expect(second?.host).toHaveLength(MAX_DENIED_HOST_CHARS);
  });

  it('keeps at most MAX_DENIALS_PER_CRED denials', () => {
    const r = new CredentialRegistry(() => 0);
    r.put(CRED, reg([]));
    for (let i = 0; i < MAX_DENIALS_PER_CRED + 10; i++) r.recordDenial(CRED, `h${String(i)}.example`, 443, 'not-in-set');
    expect(r.denials(CRED)).toHaveLength(MAX_DENIALS_PER_CRED);
  });

  it('refuses a new credential when full, but still replaces a known one', () => {
    const r = new CredentialRegistry(() => 0);
    for (let i = 0; i < MAX_CREDS; i++) expect(r.put(String(i).padStart(43, 'x'), reg([]))).toBe(true);
    expect(r.put(CRED, reg([]))).toBe(false);
    expect(r.put('0'.padStart(43, 'x'), reg(['a.example']))).toBe(true);
  });
});

describe('startup', () => {
  it('needs exactly one IPv4 address on each interface', () => {
    const v4 = (address: string) => ({ address, family: 'IPv4' as const, internal: false, netmask: '255.255.240.0', mac: '00', cidr: null });
    expect(interfaceAddress({ shell0: [v4('192.168.64.2')] }, 'shell0')).toBe('192.168.64.2');
    expect(() => interfaceAddress({ eth0: [v4('172.17.0.2')] }, 'shell0')).toThrow(/shell0/);
    expect(() => interfaceAddress({ shell0: [v4('192.168.64.2'), v4('192.168.64.3')] }, 'shell0')).toThrow();
  });

  it('refuses a missing or short secret', () => {
    expect(() => secretFromEnv(undefined)).toThrow();
    expect(() => secretFromEnv('x'.repeat(31))).toThrow();
    expect(secretFromEnv(SECRET)).toBe(SECRET);
  });

  it('compares the Bearer secret', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
    expect(bearerMatches(undefined, SECRET)).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});

// ── Contract: the listeners over real sockets ─────────────────────────────────

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function listen(server: Server | HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port); });
    closers.push(() => new Promise((r) => { server.close(() => { r(); }); (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.(); }));
  });
}

/**
 * A TCP server standing in for the internet: echoes what it gets, prefixed. With `firstAnswer`
 * it answers the first bytes of each connection with those instead (a ServerHello, say).
 */
async function origin(firstAnswer?: Buffer, thenSend?: Buffer): Promise<{ port: number; received: () => string; sockets: Socket[] }> {
  let got = '';
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    let answered = firstAnswer === undefined;
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (!answered) {
        answered = true;
        s.write(firstAnswer!);
        if (thenSend) setTimeout(() => { if (!s.destroyed) s.write(thenSend); }, 20);
        return;
      }
      s.write(`echo:${d.toString('latin1')}`);
    });
    s.on('error', () => { /* closed by the test */ });
  });
  closers.push(async () => { for (const s of sockets) s.destroy(); });
  const port = await listen(server);
  return { port, received: () => got, sockets };
}

interface Rig {
  registry: CredentialRegistry;
  clock: { t: number };
  shellPort: number;
  adminPort: number;
  lookups: string[];
  connects: Array<{ ip: string; port: number }>;
  proxy: ShellProxy;
}

interface RigOpts {
  addresses?: Record<string, string[]>;
  originPort?: number;
  deny?: string[];
  limits?: Partial<ProxyLimits>;
  /** The resolver answers after this long. */
  lookupDelayMs?: number;
  /** Runs inside the resolver, before it answers. */
  duringLookup?: (registry: CredentialRegistry) => void;
  /** Replaces the stand-in connection. */
  connect?: () => Socket;
}

async function rig(opts: RigOpts = {}): Promise<Rig> {
  const clock = { t: 5_000_000 };
  const registry = new CredentialRegistry(() => clock.t);
  const lookups: string[] = [];
  const connects: Array<{ ip: string; port: number }> = [];
  const proxy = new ShellProxy({
    registry,
    deny: new Set(opts.deny ?? []),
    lookup: async (host) => {
      lookups.push(host);
      if (opts.lookupDelayMs) await new Promise((res) => setTimeout(res, opts.lookupDelayMs));
      opts.duringLookup?.(registry);
      const a = opts.addresses?.[host];
      if (!a) throw new Error('ENOTFOUND');
      return a;
    },
    // Records the address it was asked for, then reaches the stand-in origin locally.
    connect: (ip, port) => { connects.push({ ip, port }); return opts.connect ? opts.connect() : connect({ host: '127.0.0.1', port: opts.originPort ?? 1 }); },
    log: () => { /* quiet */ },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const admin = createAdminServer({ registry, secret: SECRET, log: () => { /* quiet */ } });
  return { registry, clock, shellPort: await listen(proxy.server), adminPort: await listen(admin), lookups, connects, proxy };
}

async function api(r: Rig, method: string, path: string, body?: unknown, auth = `Bearer ${SECRET}`): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(r.adminPort)}${path}`, {
    method, headers: { authorization: auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as unknown : null };
}

/** Send a raw request head to the shell listener; resolves with the response head and the open socket. */
function shellRequest(r: Rig, head: string): Promise<{ status: number; head: string; socket: Socket; data: () => string }> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port: r.shellPort });
    let buf = '';
    let done = false;
    s.on('error', reject);
    s.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (!done && end !== -1) {
        done = true;
        const h = buf.slice(0, end);
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(h)?.[1]), head: h, socket: s, data: () => buf.slice(end + 4) });
      }
    });
    s.on('close', () => { if (!done) { done = true; resolve({ status: 0, head: '', socket: s, data: () => buf }); } });
    closers.push(async () => { s.destroy(); });
    s.write(head);
  });
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

const connectHead = (target: string, cred: string | null = CRED) =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${cred === null ? '' : `Proxy-Authorization: ${basic(`${cred}:`)}\r\n`}\r\n`;

describe('contract: registration listener', () => {
  it('PUT replaces, DELETE is idempotent, denials stay 60 s', async () => {
    const r = await rig();
    expect((await api(r, 'PUT', `/cred/${CRED}`, { set: ['a.example'], ttl_s: 30, run: 'r', session: 's' })).status).toBe(204);
    expect((await api(r, 'PUT', `/cred/${CRED}`, { set: ['b.example'], ttl_s: 30, run: 'r', session: 's' })).status).toBe(204);
    expect(r.registry.lookup(CRED)?.set).toEqual(new Set(['b.example']));
    r.registry.recordDenial(CRED, 'c.example', 443, 'not-in-set');
    expect(await api(r, 'GET', `/denials/${CRED}`)).toEqual({ status: 200, json: [{ host: 'c.example', port: 443, at: 5_000_000, reason: 'not-in-set' }] });
    expect((await api(r, 'DELETE', `/cred/${CRED}`)).status).toBe(204);
    expect((await api(r, 'DELETE', `/cred/${CRED}`)).status).toBe(204);
    expect((await api(r, 'DELETE', `/cred/${CRED2}`)).status).toBe(204);
    r.clock.t += DENIAL_RETENTION_MS - 1;
    expect((await api(r, 'GET', `/denials/${CRED}`)).status).toBe(200);
    r.clock.t += 1;
    expect((await api(r, 'GET', `/denials/${CRED}`)).status).toBe(404);
    expect((await api(r, 'GET', `/denials/${CRED2}`)).status).toBe(404);
  });

  it('answers 401 without the secret, before looking at the path', async () => {
    const r = await rig();
    expect((await api(r, 'PUT', `/cred/${CRED}`, { set: [], ttl_s: 1, run: 'r', session: 's' }, 'Bearer wrong')).status).toBe(401);
    expect((await api(r, 'GET', '/nothing', undefined, '')).status).toBe(401);
    expect(r.registry.lookup(CRED)).toBeNull();
  });

  it('answers 400 for a bad credential or body, 404 and 405 for the rest', async () => {
    const r = await rig();
    expect((await api(r, 'PUT', '/cred/short', { set: [], ttl_s: 1, run: 'r', session: 's' })).status).toBe(400);
    expect((await api(r, 'PUT', `/cred/${CRED}`, '{not json')).status).toBe(400);
    expect((await api(r, 'PUT', `/cred/${CRED}`, { set: ['*.example'], ttl_s: 1, run: 'r', session: 's' })).status).toBe(400);
    expect((await api(r, 'PUT', `/cred/${CRED}`, { set: [], ttl_s: MAX_TTL_S + 1, run: 'r', session: 's' })).status).toBe(400);
    expect((await api(r, 'PUT', `/cred/${CRED}`, 'x'.repeat(70 * 1024))).status).toBe(400);
    expect((await api(r, 'GET', '/other')).status).toBe(404);
    expect((await api(r, 'POST', `/cred/${CRED}`, {})).status).toBe(405);
    expect((await api(r, 'DELETE', `/denials/${CRED}`)).status).toBe(405);
    expect(r.registry.lookup(CRED)).toBeNull();
  });
});

describe('contract: shell listener', () => {
  /** CONNECT, then the client hello for `sni`; resolves once the proxy has answered the CONNECT. */
  const open = async (r: Rig, target = 'a.example:443', sni: string[] | null = ['a.example'], cred: string = CRED) => {
    const res = await shellRequest(r, connectHead(target, cred));
    if (res.status === 200) res.socket.write(hello(sni));
    return res;
  };
  const closedOf = (s: Socket): (() => boolean) => { let c = s.destroyed; s.on('close', () => { c = true; }); return () => c; };

  it('answers 407 without a credential, or with an unknown one, and opens nothing', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const none = await shellRequest(r, connectHead('a.example:443', null));
    expect(none.status).toBe(407);
    expect(none.head).toMatch(/Proxy-Authenticate: Basic/);
    expect((await shellRequest(r, connectHead('a.example:443', CRED2))).status).toBe(407);
    // Without a credential the request is not looked at further: 407, not 403 or 405.
    expect((await shellRequest(r, 'GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\n\r\n')).status).toBe(407);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([]);
  });

  it('checks the name BEFORE resolving it: a name outside the set reaches no resolver', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'], 'secret-data.attacker.example': ['93.184.215.99'] } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('secret-data.attacker.example:443'))).status).toBe(403);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([]);
    expect(r.registry.denials(CRED)).toEqual([{ host: 'secret-data.attacker.example', port: 443, at: 5_000_000, reason: 'not-in-set' }]);
  });

  it('refuses every port but 443 before resolving, 80 included', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:22'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('a.example:80'))).status).toBe(403);
    expect(r.lookups).toEqual([]);
    expect(r.registry.denials(CRED)?.map((d) => [d.port, d.reason])).toEqual([[22, 'port'], [80, 'port']]);
  });

  it('refuses plain http and malformed targets, and records them as denials', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] } });
    r.registry.put(CRED, reg('*'));
    const auth = `Proxy-Authorization: ${basic(CRED)}\r\n`;
    expect((await shellRequest(r, `GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\n${auth}\r\n`)).status).toBe(403);
    expect((await shellRequest(r, connectHead('evil.example.:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('[::1]:443'))).status).toBe(403);
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([
      ['http://a.example/', 'plain-http'], ['evil.example.:443', 'bad-target'], ['[::1]:443', 'bad-target'],
    ]);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([]);
  });

  it('refuses a request it cannot parse', async () => {
    const r = await rig();
    r.registry.put(CRED, reg('*'));
    expect((await shellRequest(r, 'nonsense\r\n\r\n')).status).toBe(400);
    expect((await shellRequest(r, `CONNECT a.example:443 HTTP/1.1\r\nno colon\r\n\r\n`)).status).toBe(400);
    expect((await shellRequest(r, `CONNECT a.example:443 HTTP/1.1\r\nX: ${'y'.repeat(20 * 1024)}\r\n\r\n`)).status).toBe(431);
    expect(r.connects).toEqual([]);
  });

  it('connects to exactly the checked address, and forwards once the hello names the same host', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14', '93.184.215.15'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('A.Example:443'));
    expect(res.status).toBe(200);
    expect(r.lookups).toEqual(['a.example']);
    expect(r.connects).toEqual([{ ip: '93.184.215.14', port: 443 }]);
    // Nothing reaches the upstream before the hello is read.
    res.socket.write(hello(['a.example']).subarray(0, 10));
    await new Promise((x) => setTimeout(x, 30));
    expect(o.received()).toBe('');
    res.socket.write(hello(['a.example']).subarray(10));
    res.socket.write('after');
    await until(() => o.received().endsWith('after'));
    expect(o.received()).toBe(hello(['a.example']).toString('latin1') + 'after');
    await until(() => res.data().includes('echo:'));
    expect(r.registry.denials(CRED)).toEqual([]);
  });

  it('closes the tunnel when the hello names another host, or none, and forwards nothing', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example', 'b.example']));
    for (const sni of [['other.cdn.example'], ['b.example'], null, ['a.example', 'b.example']]) {
      const res = await shellRequest(r, connectHead('a.example:443'));
      expect(res.status).toBe(200);
      const closed = closedOf(res.socket);
      res.socket.write(hello(sni));
      await until(closed);
    }
    expect(o.received()).toBe('');
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([
      ['other.cdn.example', 'sni-mismatch'], ['b.example', 'sni-mismatch'], ['a.example', 'no-sni'], ['a.example', 'bad-hello'],
    ]);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('closes a tunnel whose client sends no hello in time', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, limits: { headerTimeoutMs: 50 } });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    expect(res.status).toBe(200);
    await until(closedOf(res.socket));
    expect(r.registry.denials(CRED)).toEqual([{ host: 'a.example', port: 443, at: 5_000_000, reason: 'hello-timeout' }]);
  });

  it('refuses a name that also resolves inward, or to a denied address, and connects nowhere', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14', '127.0.0.1'], 'b.example': ['93.184.215.99'] }, deny: ['93.184.215.99'] });
    r.registry.put(CRED, reg(['a.example', 'b.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('b.example:443'))).status).toBe(403);
    expect(r.lookups).toEqual(['a.example', 'b.example']);
    expect(r.connects).toEqual([]);
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([['a.example', 'ssrf'], ['b.example', 'ssrf']]);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it("lets an IPv4 literal through only a '*' set, and only when it is public; '*' reads no hello", async () => {
    const o = await origin();
    const r = await rig({ originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    r.registry.put(CRED2, reg('*'));
    expect((await shellRequest(r, connectHead('93.184.215.14:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('169.254.169.254:443', CRED2))).status).toBe(403);
    const res = await shellRequest(r, connectHead('93.184.215.14:443', CRED2));
    expect(res.status).toBe(200);
    res.socket.write('raw');
    await until(() => o.received() === 'raw');
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([{ ip: '93.184.215.14', port: 443 }]);
  });

  it('closes an open tunnel when its credential is revoked', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await open(r);
    expect(res.status).toBe(200);
    await until(() => o.received().length > 0);
    expect(r.proxy.openTunnels).toBe(1);
    const closed = closedOf(res.socket);
    expect((await api(r, 'DELETE', `/cred/${CRED}`)).status).toBe(204);
    await until(closed);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('caps the tunnels of one credential, also against requests that resolve at the same time', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, lookupDelayMs: 30, limits: { tunnelsPerCred: 2 } });
    r.registry.put(CRED, reg(['a.example']));
    const all = await Promise.all(Array.from({ length: 6 }, () => shellRequest(r, connectHead('a.example:443'))));
    expect(all.map((x) => x.status).sort()).toEqual([200, 200, 503, 503, 503, 503]);
    expect(r.connects).toHaveLength(2);
    expect(r.proxy.openTunnels).toBe(2);
  });

  it('caps the tunnels of all credentials together, also against requests that resolve at the same time', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, lookupDelayMs: 30, limits: { tunnelsTotal: 2 } });
    r.registry.put(CRED, reg(['a.example']));
    r.registry.put(CRED2, reg(['a.example']));
    const all = await Promise.all([CRED, CRED2, CRED, CRED2].map((c) => shellRequest(r, connectHead('a.example:443', c))));
    expect(all.map((x) => x.status).sort()).toEqual([200, 200, 503, 503]);
    expect(r.connects).toHaveLength(2);
  });

  it('gives the slot back when a request is refused after resolving', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'], 'b.example': ['10.0.0.1'] }, originPort: o.port, limits: { tunnelsPerCred: 1, tunnelsTotal: 1 } });
    r.registry.put(CRED, reg(['a.example', 'b.example']));
    expect((await shellRequest(r, connectHead('b.example:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('c.example:443'))).status).toBe(403);
    expect(r.proxy.openTunnels).toBe(0);
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(200);
  });

  it('closes connections over the connection cap', async () => {
    const r = await rig({ limits: { connectionsTotal: 2 } });
    const held = [connect({ host: '127.0.0.1', port: r.shellPort }), connect({ host: '127.0.0.1', port: r.shellPort })];
    for (const h of held) { h.on('error', () => { /* closed by the test */ }); closers.push(async () => { h.destroy(); }); }
    await Promise.all(held.map((h) => new Promise((x) => h.once('connect', x))));
    await new Promise((x) => setTimeout(x, 20));
    const third = await shellRequest(r, connectHead('a.example:443'));
    expect(third.status).toBe(0);
  });

  it('answers 431 to a head that grows past the cap without ending', async () => {
    const r = await rig();
    expect((await shellRequest(r, `CONNECT a.example:443 HTTP/1.1\r\nX: ${'y'.repeat(20 * 1024)}`)).status).toBe(431);
  });

  it('refuses two Proxy-Authorization headers', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] } });
    r.registry.put(CRED, reg(['a.example']));
    const head = `CONNECT a.example:443 HTTP/1.1\r\nProxy-Authorization: ${basic(CRED2)}\r\nProxy-Authorization: ${basic(CRED)}\r\n\r\n`;
    expect((await shellRequest(r, head)).status).toBe(400);
    expect(r.lookups).toEqual([]);
  });

  it('opens nothing when the credential is revoked while its name resolves', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, duringLookup: (reg2) => { reg2.delete(CRED); } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(407);
    expect(r.connects).toEqual([]);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('closes a tunnel that stays idle', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, limits: { idleTimeoutMs: 50 } });
    r.registry.put(CRED, reg(['a.example']));
    const res = await open(r);
    expect(res.status).toBe(200);
    await until(() => o.received().length > 0);
    await until(closedOf(res.socket));
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('answers 504 when the upstream does not connect in time', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, limits: { connectTimeoutMs: 50 }, connect: () => new Socket() });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(504);
    await until(() => r.proxy.openTunnels === 0);
  });

  it('answers a refusal with a fixed head and no body, naming no address and no list', async () => {
    const fixed = (code: string) => `HTTP/1.1 ${code}\r\nContent-Length: 0\r\nConnection: close`;
    const r = await rig({
      addresses: { 'inward.example': ['93.184.215.14', '10.1.2.3'], 'listed.example': ['93.184.215.99'] },
      deny: ['93.184.215.99'],
    });
    r.registry.put(CRED, reg(['inward.example', 'listed.example', 'gone.example', 'a.example']));
    const cases: Array<[string, string]> = [
      ['inward.example:443', '403 Forbidden'],
      ['listed.example:443', '403 Forbidden'],
      ['a.example:22', '403 Forbidden'],
    ];
    for (const [target, code] of cases) {
      const res = await shellRequest(r, connectHead(target));
      expect(res.head, target).toBe(fixed(code));
      expect(res.data(), target).toBe('');
    }
    const full = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, limits: { tunnelsPerCred: 0 } });
    full.registry.put(CRED, reg(['a.example']));
    const busy = await shellRequest(full, connectHead('a.example:443'));
    expect(busy.head).toBe(fixed('503 Service Unavailable'));
    const r2 = await rig({ addresses: {}, connect: () => new Socket(), limits: { connectTimeoutMs: 30 } });
    r2.registry.put(CRED, reg(['gone.example']));
    const unresolved = await shellRequest(r2, connectHead('gone.example:443'));
    expect(unresolved.head).toBe(fixed('502 Bad Gateway'));
    expect(unresolved.data()).toBe('');
  });

  it('holds the second hello after a HelloRetryRequest to the same name', async () => {
    const o = await origin(serverHello(true));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const first = hello(['a.example']).toString('latin1');

    const bad = await open(r);
    await until(() => bad.data().length > 0);
    expect(bad.data()).toBe(serverHello(true).toString('latin1'));
    const badClosed = closedOf(bad.socket);
    bad.socket.write(Buffer.concat([CCS, hello(['other.cdn.example'])]));
    await until(badClosed);
    expect(o.received()).toBe(first);

    const good = await open(r);
    await until(() => good.data().length > 0);
    good.socket.write(Buffer.concat([CCS, hello(['a.example'])]));
    await until(() => o.received().length === 2 * first.length + CCS.length + hello(['a.example']).length);
    good.socket.write('after');
    await until(() => o.received().endsWith('after'));
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([['other.cdn.example', 'sni-mismatch']]);
  });

  it.each(['b.example', 'x.a.example'])('refuses a second hello naming %s, which is not the CONNECT host', async (name) => {
    // The second hello is held to the CONNECT host, exactly: not to the set (a
    // name the credential may reach on its own CONNECT is still a different
    // tunnel), and not to a name that merely ends in the host.
    const o = await origin(serverHello(true));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example', 'b.example']));
    const res = await open(r);
    await until(() => res.data().length > 0);
    const closed = closedOf(res.socket);
    res.socket.write(Buffer.concat([CCS, hello([name])]));
    await until(closed);
    expect(o.received()).toBe(hello(['a.example']).toString('latin1'));
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([[name, 'sni-mismatch']]);
  });

  it('starts the tunnel when the server answers with a plain ServerHello', async () => {
    const o = await origin(serverHello(false));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await open(r);
    await until(() => res.data().length > 0);
    // Not a retry: what follows is not checked as a hello.
    res.socket.write(hello(['other.cdn.example']));
    await until(() => res.data().includes('echo:'));
    expect(r.registry.denials(CRED)).toEqual([]);
  });

  it('refuses a hello with an encrypted inner hello', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    const closed = closedOf(res.socket);
    res.socket.write(hello(['a.example'], { extension: 0xfe0d }));
    await until(closed);
    expect(o.received()).toBe('');
    expect(r.registry.denials(CRED)?.map((d) => d.reason)).toEqual(['bad-hello']);
  });

  it('closes a refused connection after the linger even if the client keeps its side open', async () => {
    const r = await rig({ limits: { connectionsTotal: 1, replyLingerMs: 30 } });
    // allowHalfOpen: the client does not answer the proxy's end with its own.
    const held = connect({ host: '127.0.0.1', port: r.shellPort, allowHalfOpen: true });
    held.on('error', () => { /* closed by the proxy */ });
    closers.push(async () => { held.destroy(); });
    let answer = '';
    let ended = false;
    held.on('data', (d: Buffer) => { answer += d.toString('latin1'); });
    held.on('end', () => { ended = true; });
    let open = -1;
    const count = (): void => { r.proxy.server.getConnections((_e, n) => { open = n; }); };
    held.write(connectHead('a.example:443', null));
    await until(() => ended);
    expect(answer).toMatch(/^HTTP\/1\.1 407 /);
    // The proxy's side goes away although the client never closes its own.
    await until(() => { count(); return open === 0; });
    expect(held.destroyed).toBe(false);
    expect((await shellRequest(r, connectHead('a.example:443', null))).status).toBe(407);
  });

  it('answers 502 and gives the slot back when opening the connection throws', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, connect: () => { throw new Error('no socket'); } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(502);
    expect(r.proxy.openTunnels).toBe(0);
    expect(r.registry.tunnelCount(CRED)).toBe(0);
  });

  it('gives the slot back when a name does not resolve', async () => {
    const r = await rig({ addresses: {}, limits: { tunnelsTotal: 1 } });
    r.registry.put(CRED, reg(['gone.example', 'gone2.example']));
    expect((await shellRequest(r, connectHead('gone.example:443'))).status).toBe(502);
    expect(r.proxy.openTunnels).toBe(0);
    expect((await shellRequest(r, connectHead('gone2.example:443'))).status).toBe(502);
  });

  it('opens nothing for a client that leaves while its name resolves', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, lookupDelayMs: 40 });
    r.registry.put(CRED, reg(['a.example']));
    const s = connect({ host: '127.0.0.1', port: r.shellPort });
    s.on('error', () => { /* closed by the test */ });
    s.write(connectHead('a.example:443'));
    await until(() => r.lookups.length === 1);
    s.destroy();
    await new Promise((x) => setTimeout(x, 80));
    expect(r.connects).toEqual([]);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('produces every reason in DENIAL_REASONS', async () => {
    const r = await rig({
      addresses: { 'a.example': ['93.184.215.14'], 'inward.example': ['10.0.0.1'] },
      originPort: (await origin()).port, limits: { headerTimeoutMs: 50 },
    });
    r.registry.put(CRED, reg(['a.example', 'inward.example']));
    const auth = `Proxy-Authorization: ${basic(CRED)}\r\n`;
    await shellRequest(r, connectHead('b.example:443'));
    await shellRequest(r, `GET http://a.example/ HTTP/1.1\r\n${auth}\r\n`);
    await shellRequest(r, connectHead('a.example:22'));
    await shellRequest(r, connectHead('[::1]:443'));
    await shellRequest(r, connectHead('inward.example:443'));
    for (const sni of [['b.example'], null, ['a.example', 'b.example']]) {
      const res = await shellRequest(r, connectHead('a.example:443'));
      const closed = closedOf(res.socket);
      res.socket.write(hello(sni));
      await until(closed);
    }
    const quiet = await shellRequest(r, connectHead('a.example:443'));
    await until(closedOf(quiet.socket));
    const produced = [...new Set(r.registry.denials(CRED)?.map((d) => d.reason))].sort();
    expect(produced).toEqual([...DENIAL_REASONS].sort());
  });

  it('holds a second hello the client sends right behind the first, and checks it after a retry', async () => {
    const o = await origin(serverHello(true));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const first = hello(['a.example']);

    const bad = await shellRequest(r, connectHead('a.example:443'));
    const badClosed = closedOf(bad.socket);
    bad.socket.write(Buffer.concat([first, CCS, hello(['other.cdn.example'])]));
    await until(badClosed);
    expect(o.received()).toBe(first.toString('latin1'));
    expect(r.registry.denials(CRED)?.map((d) => [d.host, d.reason])).toEqual([['other.cdn.example', 'sni-mismatch']]);

    const good = await shellRequest(r, connectHead('a.example:443'));
    const both = Buffer.concat([first, CCS, hello(['a.example']), Buffer.from('x')]);
    good.socket.write(both);
    await until(() => o.received().length === first.length + both.length);
    expect(o.received()).toBe(first.toString('latin1') + both.toString('latin1'));
  });

  it('passes bytes sent behind the hello on when the server does not ask for a retry', async () => {
    const o = await origin(serverHello(false));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    const first = hello(['a.example']);
    res.socket.write(Buffer.concat([first, Buffer.from('early')]));
    // The hello alone first; the rest only after the server's answer.
    await until(() => o.received().endsWith('early'));
    expect(o.received()).toBe(`${first.toString('latin1')}early`);
  });

  it('forwards nothing more when the server does not answer the hello in time', async () => {
    const silent = createServer((s) => {
      let got = '';
      s.on('data', (d: Buffer) => { got += d.toString('latin1'); seen = got; });
      s.on('error', () => { /* closed by the test */ });
      closers.push(async () => { s.destroy(); });
    });
    let seen = '';
    const port = await listen(silent);
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: port, limits: { serverHelloTimeoutMs: 60, idleTimeoutMs: 10_000 } });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    const closed = closedOf(res.socket);
    res.socket.write(hello(['a.example']));
    await new Promise((x) => setTimeout(x, 10));
    res.socket.write(Buffer.concat([CCS, hello(['other.cdn.example'])]));
    await until(closed);
    await new Promise((x) => setTimeout(x, 20));
    expect(seen).toBe(hello(['a.example']).toString('latin1'));
    expect(r.registry.denials(CRED)).toEqual([]);
  });

  it('keeps what the server sends while the second hello is awaited', async () => {
    const o = await origin(serverHello(true), Buffer.from('tail'));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await open(r);
    await until(() => res.data().length > 0);
    await new Promise((x) => setTimeout(x, 60));
    res.socket.write(Buffer.concat([CCS, hello(['a.example'])]));
    // The origin echoes the second hello after its tail; the tail must not be lost before it.
    await until(() => res.data().includes('echo:'));
    expect(res.data().startsWith(`${serverHello(true).toString('latin1')}tail`)).toBe(true);
  });

  it('lets 0-RTT early data through a retry when the second hello names the host', async () => {
    const o = await origin(serverHello(true));
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    const first = hello(['a.example']);
    const early = Buffer.concat([Buffer.from([23, 3, 3]), u16(5), Buffer.from('early')]);
    res.socket.write(Buffer.concat([first, CCS, early]));
    await until(() => res.data().length > 0);
    res.socket.write(hello(['a.example']));
    const all = Buffer.concat([first, CCS, early, hello(['a.example'])]).toString('latin1');
    await until(() => o.received().length === all.length);
    expect(o.received()).toBe(all);
    expect(r.registry.denials(CRED)).toEqual([]);
  });
});
