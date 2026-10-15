import { describe, it, expect, afterEach } from 'vitest';
import { Socket, connect, createServer, type AddressInfo, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CredentialRegistry, DENIAL_RETENTION_MS, MAX_CREDS, MAX_DENIALS_PER_CRED, MAX_TTL_S, type TunnelHandle } from './registry.js';
import { credentialFromHeader, isExactHostname, parseAuthority, parseDenyIps, parseRegistration, pickAddress } from './policy.js';
import { ShellProxy, bearerMatches, createAdminServer, type ProxyLimits } from './server.js';
import { interfaceAddress, secretFromEnv } from './main.js';

const CRED = 'A'.repeat(43);
const CRED2 = 'b'.repeat(42) + '_';
const SECRET = 's'.repeat(40);
const basic = (user: string): string => `Basic ${Buffer.from(user).toString('base64')}`;
const reg = (set: string[] | '*', ttlS = 60) => ({ set: set === '*' ? '*' as const : new Set(set), ttlS, run: 'r', session: 's' });

describe('policy', () => {
  it('takes exact lower-case host names and nothing else', () => {
    expect(isExactHostname('api.example.com')).toBe(true);
    expect(isExactHostname('a-b.example')).toBe(true);
    for (const bad of ['API.example.com', '*.example.com', 'example.com.', '1.2.3.4', '10.0.0.010', '', 'a..b', '-a.com', 'a_b.com', `${'a'.repeat(64)}.com`]) {
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
      null, [], 'x', { ...ok, set: ['*.example.com'] }, { ...ok, set: ['10.0.0.1'] }, { ...ok, set: 'all' },
      { ...ok, set: [1] }, { ...ok, ttl_s: 0 }, { ...ok, ttl_s: -1 }, { ...ok, ttl_s: 1.5 }, { ...ok, ttl_s: '30' },
      { ...ok, run: '' }, { ...ok, session: 3 }, { ...ok, extra: 1 },
    ]) {
      expect(parseRegistration(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads host and port from an authority, refusing IPv6', () => {
    expect(parseAuthority('API.Example.com:443')).toEqual({ ok: true, value: { host: 'api.example.com', port: 443 } });
    expect(parseAuthority('example.com', 80)).toEqual({ ok: true, value: { host: 'example.com', port: 80 } });
    expect(parseAuthority('1.2.3.4:443')).toEqual({ ok: true, value: { host: '1.2.3.4', port: 443 } });
    for (const bad of ['[::1]:443', 'example.com', 'example.com:x', 'example.com:123456', 'a b:443']) {
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

  it('refuses a name when ANY of its addresses is private, denied or not IPv4', () => {
    const deny = parseDenyIps(' 203.0.113.9 ,198.51.100.7');
    expect(pickAddress(['93.184.215.14', '93.184.215.15'], deny)).toEqual({ ok: true, value: '93.184.215.14' });
    expect(pickAddress(['93.184.215.14', '10.0.0.1'], deny).ok).toBe(false);
    expect(pickAddress(['93.184.215.14', '169.254.169.254'], deny).ok).toBe(false);
    expect(pickAddress(['93.184.215.14', '203.0.113.9'], deny).ok).toBe(false);
    expect(pickAddress(['2606:2800::1'], deny).ok).toBe(false);
    expect(pickAddress([], deny).ok).toBe(false);
  });

  it('stops on a deny list entry that is not an IPv4 address', () => {
    expect(parseDenyIps(undefined).size).toBe(0);
    expect(() => parseDenyIps('1.2.3.4,example.com')).toThrow(/not an IPv4/);
    expect(() => parseDenyIps('10.0.0.0/8')).toThrow(/not an IPv4/);
  });
});

describe('registry', () => {
  const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };
  const tunnel = (host: string) => { const t = { host, closed: 0, close: () => { t.closed++; } }; return t; };

  it('expires a credential at its ttl and keeps its denials for 60 s after', () => {
    const c = clock();
    const r = new CredentialRegistry(c.now);
    r.put(CRED, reg(['a.example'], 10));
    r.recordDenial(CRED, 'b.example', 443);
    c.t += 9_999;
    expect(r.lookup(CRED)).not.toBeNull();
    c.t += 1;
    expect(r.lookup(CRED)).toBeNull();
    expect(r.denials(CRED)).toEqual([{ host: 'b.example', port: 443, at: 1_000_000 }]);
    c.t += DENIAL_RETENTION_MS - 1;
    expect(r.denials(CRED)).not.toBeNull();
    c.t += 1;
    expect(r.denials(CRED)).toBeNull();
  });

  it('keeps denials across a replace and forgets them 60 s after a delete', () => {
    const c = clock();
    const r = new CredentialRegistry(c.now);
    r.put(CRED, reg(['a.example']));
    r.recordDenial(CRED, 'b.example', 443);
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

  it('keeps at most MAX_DENIALS_PER_CRED denials', () => {
    const r = new CredentialRegistry(() => 0);
    r.put(CRED, reg([]));
    for (let i = 0; i < MAX_DENIALS_PER_CRED + 10; i++) r.recordDenial(CRED, `h${String(i)}.example`, 443);
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

/** A TCP server standing in for the internet: echoes what it gets, prefixed. */
async function origin(): Promise<{ port: number; received: () => string; sockets: Socket[] }> {
  let got = '';
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    s.on('data', (d) => { got += d.toString('latin1'); s.write(`echo:${d.toString('latin1')}`); });
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
    r.registry.recordDenial(CRED, 'c.example', 443);
    expect(await api(r, 'GET', `/denials/${CRED}`)).toEqual({ status: 200, json: [{ host: 'c.example', port: 443, at: 5_000_000 }] });
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
  it('answers 407 without a credential, or with an unknown one, and opens nothing', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const none = await shellRequest(r, connectHead('a.example:443', null));
    expect(none.status).toBe(407);
    expect(none.head).toMatch(/Proxy-Authenticate: Basic/);
    expect((await shellRequest(r, connectHead('a.example:443', CRED2))).status).toBe(407);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([]);
  });

  it('checks the name BEFORE resolving it: a name outside the set reaches no resolver', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'], 'secret-data.attacker.example': ['93.184.215.99'] } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('secret-data.attacker.example:443'))).status).toBe(403);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([]);
    expect(r.registry.denials(CRED)).toEqual([{ host: 'secret-data.attacker.example', port: 443, at: 5_000_000 }]);
  });

  it('refuses a port other than 443 and 80 before resolving', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] } });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:22'))).status).toBe(403);
    expect(r.lookups).toEqual([]);
    expect(r.registry.denials(CRED)).toEqual([{ host: 'a.example', port: 22, at: 5_000_000 }]);
  });

  it('connects to exactly the checked address and tunnels bytes both ways', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14', '93.184.215.15'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('A.Example:443'));
    expect(res.status).toBe(200);
    expect(r.lookups).toEqual(['a.example']);
    expect(r.connects).toEqual([{ ip: '93.184.215.14', port: 443 }]);
    res.socket.write('hello');
    await until(() => res.data().includes('echo:hello'));
    expect(o.received()).toBe('hello');
    expect(r.registry.denials(CRED)).toEqual([]);
  });

  it('refuses a name that also resolves inward, or to a denied address, and connects nowhere', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14', '127.0.0.1'], 'b.example': ['203.0.113.9'] }, deny: ['203.0.113.9'] });
    r.registry.put(CRED, reg(['a.example', 'b.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('b.example:443'))).status).toBe(403);
    expect(r.lookups).toEqual(['a.example', 'b.example']);
    expect(r.connects).toEqual([]);
    expect(r.registry.denials(CRED)?.map((d) => d.host)).toEqual(['a.example', 'b.example']);
  });

  it("lets an IPv4 literal through only a '*' set, and only when it is public", async () => {
    const o = await origin();
    const r = await rig({ originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    r.registry.put(CRED2, reg('*'));
    expect((await shellRequest(r, connectHead('93.184.215.14:443'))).status).toBe(403);
    expect((await shellRequest(r, connectHead('169.254.169.254:80', CRED2))).status).toBe(403);
    expect((await shellRequest(r, connectHead('93.184.215.14:443', CRED2))).status).toBe(200);
    expect(r.lookups).toEqual([]);
    expect(r.connects).toEqual([{ ip: '93.184.215.14', port: 443 }]);
  });

  it('forwards absolute-form http in origin form, without the proxy credential', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r,
      `GET http://a.example/path?q=1 HTTP/1.1\r\nHost: a.example\r\nProxy-Authorization: ${basic(`${CRED}:`)}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    // The origin echoes the request it got; its first line is the response head here.
    expect(res.head).toMatch(/^echo:GET \/path\?q=1 HTTP\/1\.1/);
    expect(o.received()).not.toMatch(/Proxy-/i);
    expect(o.received()).toMatch(/\r\nConnection: close\r\n/);
    expect(r.connects).toEqual([{ ip: '93.184.215.14', port: 80 }]);
  });

  it('refuses other request forms', async () => {
    const r = await rig();
    r.registry.put(CRED, reg('*'));
    expect((await shellRequest(r, `GET /local HTTP/1.1\r\nProxy-Authorization: ${basic(CRED)}\r\n\r\n`)).status).toBe(405);
    expect((await shellRequest(r, `GET https://a.example/ HTTP/1.1\r\nProxy-Authorization: ${basic(CRED)}\r\n\r\n`)).status).toBe(405);
    expect((await shellRequest(r, connectHead('[::1]:443'))).status).toBe(400);
    expect((await shellRequest(r, 'nonsense\r\n\r\n')).status).toBe(400);
    expect((await shellRequest(r, `CONNECT a.example:443 HTTP/1.1\r\nX: ${'y'.repeat(20 * 1024)}\r\n\r\n`)).status).toBe(431);
    expect(r.connects).toEqual([]);
  });

  it('closes an open tunnel when its credential is revoked', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    const res = await shellRequest(r, connectHead('a.example:443'));
    expect(res.status).toBe(200);
    expect(r.proxy.openTunnels).toBe(1);
    let closed = false;
    res.socket.on('close', () => { closed = true; });
    expect((await api(r, 'DELETE', `/cred/${CRED}`)).status).toBe(204);
    await until(() => closed);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('caps the tunnels of one credential', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port });
    r.registry.put(CRED, reg(['a.example']));
    for (let i = 0; i < 32; i++) expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(200);
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(503);
    expect(r.connects).toHaveLength(32);
  });

  it('caps the tunnels of all credentials together', async () => {
    const o = await origin();
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, originPort: o.port, limits: { tunnelsTotal: 2 } });
    r.registry.put(CRED, reg(['a.example']));
    r.registry.put(CRED2, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(200);
    expect((await shellRequest(r, connectHead('a.example:443', CRED2))).status).toBe(200);
    expect((await shellRequest(r, connectHead('a.example:443', CRED2))).status).toBe(503);
    expect(r.connects).toHaveLength(2);
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
    const res = await shellRequest(r, connectHead('a.example:443'));
    expect(res.status).toBe(200);
    let closed = false;
    res.socket.on('close', () => { closed = true; });
    await until(() => closed);
    expect(r.proxy.openTunnels).toBe(0);
  });

  it('answers 504 when the upstream does not connect in time', async () => {
    const r = await rig({ addresses: { 'a.example': ['93.184.215.14'] }, limits: { connectTimeoutMs: 50 }, connect: () => new Socket() });
    r.registry.put(CRED, reg(['a.example']));
    expect((await shellRequest(r, connectHead('a.example:443'))).status).toBe(504);
    await until(() => r.proxy.openTunnels === 0);
  });
});
