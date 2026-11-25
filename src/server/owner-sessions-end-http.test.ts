import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { createManagedHook } from '../core/managed-hook.js';
import type { OwnerSessions } from '../core/owner-sessions.js';

/**
 * Ending the owner's sessions of an instance (owner-sessions.ts), on a real engine of a managed
 * instance: a generation every owner cookie carries, checked by the engine and by the web UI's
 * reader in the same process, moved on through the owner's route and the control plane's, with
 * the instance secret left as it was.
 */
describe('ending the owner sessions (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ADMIN = `a-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_HTTP_ADMIN_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL'];
  let auth: typeof import('../../packages/web-ui/src/lib/server/auth.js');

  const sessionsOf = (): OwnerSessions => {
    const s = (api as unknown as { engine: { getOwnerSessions: () => OwnerSessions | null } }).engine.getOwnerSessions();
    if (s === null) throw new Error('fixture: no store of owner sessions');
    return s;
  };
  /** A cookie signed with the instance secret the way both sides sign one, with `principal` as its principal part. */
  const signed = (principal: Record<string, unknown> | null, atS = Math.floor(Date.now() / 1000)): string => {
    const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
    const nonce = randomBytes(8).toString('hex');
    const payload = principal === null
      ? `${nonce}.${String(atS)}`
      : `${nonce}.${Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url')}.${String(atS)}`;
    return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
  };
  const ownerOf = (gen: number, atS?: number): string => signed(gen === 0 ? { v: 1, kind: 'owner' } : { v: 1, kind: 'owner', gen }, atS);
  const genOf = (token: string): number => {
    const p = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { gen?: number };
    return p.gen ?? 0;
  };
  const get = (headers: Record<string, string>): Promise<Response> => fetch(`${base}/api/config`, { headers });
  const withCookie = (token: string): Record<string, string> => ({ cookie: `lynox_session=${token}` });
  const post = (path: string, headers: Record<string, string>, body = '{}'): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const cpEnd = (body = '{}'): Promise<Response> => post('/api/admin/owner-sessions/end', { authorization: `Bearer ${ADMIN}` }, body);
  const sessionCookieOf = (res: Response): string | undefined => {
    const set = res.headers.getSetCookie().filter((c) => c.startsWith('lynox_session=')).pop();
    return set === undefined ? undefined : decodeURIComponent(set.split(';')[0]!.slice('lynox_session='.length));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-http-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_HTTP_ADMIN_SECRET'] = ADMIN;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'TEST-INSTANCE-1';
    delete process.env['LYNOX_MANAGED_MODE'];
    // A managed engine builds its usage hook at boot and needs a control plane for it: one that
    // answers nothing, on a closed local port.
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'http://127.0.0.1:9';
    reloadConfig();
    auth = await import('../../packages/web-ui/src/lib/server/auth.js');
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: import('node:http').Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    base = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('lynox.ownerSessionsGeneration')];
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  /** Run `fn` as a self-hosted instance, where a cookie without a principal is the owner's. */
  const selfHosted = async (fn: () => Promise<void>): Promise<void> => {
    const tier = process.env['LYNOX_BILLING_TIER'];
    const id = process.env['LYNOX_MANAGED_INSTANCE_ID'];
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    try { await fn(); } finally {
      process.env['LYNOX_BILLING_TIER'] = tier;
      process.env['LYNOX_MANAGED_INSTANCE_ID'] = id;
    }
  };

  it('lets in cookies of today, without a generation and without a principal, until the first end, and then refuses them in the engine and in the web UI', async () => {
    expect(sessionsOf().generation()).toBe(0);
    const today = ownerOf(0);
    const bare = signed(null);
    expect((await get(withCookie(today))).status).toBe(200);
    expect(auth.readSessionToken(today, SECRET)).not.toBeNull();
    await selfHosted(async () => {
      expect((await get(withCookie(bare))).status).toBe(200);
      expect(auth.readSessionToken(bare, SECRET)).not.toBeNull();
    });
    // Generation 0 has one form only, today's: an explicit `gen: 0` is a shape neither reader knows.
    const explicit = signed({ v: 1, kind: 'owner', gen: 0 });
    expect((await get(withCookie(explicit))).status).toBe(401);
    expect(auth.readSessionToken(explicit, SECRET)).toBeNull();
    // A refresh in generation 0 mints today's bytes, which both readers let in.
    const refreshed = sessionCookieOf(await get(withCookie(ownerOf(0, Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60))));
    expect(refreshed).toBeDefined();
    expect(JSON.parse(Buffer.from(refreshed!.split('.')[1]!, 'base64url').toString('utf8'))).toEqual({ v: 1, kind: 'owner' });
    expect((await get(withCookie(refreshed!))).status).toBe(200);
    sessionsOf().endAll();
    expect((await get(withCookie(today))).status).toBe(401);
    expect(auth.readSessionToken(today, SECRET)).toBeNull();
    await selfHosted(async () => {
      expect((await get(withCookie(bare))).status).toBe(401);
      expect(auth.readSessionToken(bare, SECRET)).toBeNull();
    });
  });

  it('lets in only the live generation: an older one and a higher one are refused alike', async () => {
    const live = sessionsOf().generation();
    expect((await get(withCookie(ownerOf(live)))).status).toBe(200);
    for (const gen of [live - 1, live + 1, live + 1000]) {
      expect((await get(withCookie(ownerOf(gen)))).status).toBe(401);
      expect(auth.readSessionToken(ownerOf(gen), SECRET)).toBeNull();
    }
  });

  it('refuses a cookie whose generation was changed after signing, and one with a generation of another shape', async () => {
    const live = sessionsOf().generation();
    const old = ownerOf(live - 1);
    // The principal part swapped for the live generation's, the signature left as it was.
    const parts = old.split('.');
    parts[1] = Buffer.from(JSON.stringify({ v: 1, kind: 'owner', gen: live }), 'utf8').toString('base64url');
    const tampered = parts.join('.');
    expect((await get(withCookie(tampered))).status).toBe(401);
    expect(auth.readSessionToken(tampered, SECRET)).toBeNull();
    for (const principal of [{ v: 1, kind: 'owner', gen: 0 }, { v: 1, kind: 'owner', gen: String(live) }, { v: 1, kind: 'owner', gen: live + 0.5 }, { v: 1, kind: 'owner', gen: live, x: 1 }]) {
      expect((await get(withCookie(signed(principal)))).status).toBe(401);
      expect(auth.readSessionToken(signed(principal), SECRET)).toBeNull();
    }
  });

  it('refuses every owner session while the store cannot be read', async () => {
    const live = ownerOf(sessionsOf().generation());
    expect((await get(withCookie(live))).status).toBe(200);
    const spy = vi.spyOn(sessionsOf(), 'generation').mockImplementation(() => { throw new Error('the database is closed'); });
    try {
      expect((await get(withCookie(live))).status).toBe(401);
      expect(auth.readSessionToken(live, SECRET)).toBeNull();
    } finally { spy.mockRestore(); }
    expect((await get(withCookie(live))).status).toBe(200);
  });

  it('mints every owner login in the live generation', async () => {
    const live = sessionsOf().generation();
    const login = auth.ownerSession(SECRET).token;
    expect(genOf(login)).toBe(live);
    expect((await get(withCookie(login))).status).toBe(200);
  });

  it('ends every other owner session through the owner\'s route, and keeps the caller signed in', async () => {
    const caller = auth.ownerSession(SECRET).token;
    const other = auth.ownerSession(SECRET).token;
    const res = await post('/api/auth/owner-sessions/end', withCookie(caller));
    expect(res.status).toBe(200);
    const { generation } = await res.json() as { generation: number };
    expect(generation).toBe(sessionsOf().generation());
    const renewed = sessionCookieOf(res);
    expect(renewed).toBeDefined();
    expect(genOf(renewed!)).toBe(generation);
    expect((await get(withCookie(renewed!))).status).toBe(200);
    expect((await get(withCookie(caller))).status).toBe(401);
    expect((await get(withCookie(other))).status).toBe(401);
  });

  it('counts two ends at once, one from each route, as exactly two, and every cookie minted after carries the new generation', async () => {
    const before = sessionsOf().generation();
    const [owner, cp] = await Promise.all([
      post('/api/auth/owner-sessions/end', { authorization: `Bearer ${SECRET}` }),
      cpEnd(),
    ]);
    expect([owner.status, cp.status]).toEqual([200, 200]);
    expect(sessionsOf().generation()).toBe(before + 2);
    const seen = [((await owner.json()) as { generation: number }).generation, ((await cp.json()) as { generation: number }).generation].sort((a, b) => a - b);
    expect(seen).toEqual([before + 1, before + 2]);
    expect(genOf(auth.ownerSession(SECRET).token)).toBe(before + 2);
    expect(genOf(auth.createSessionToken(SECRET, auth.OWNER_SESSION_PRINCIPAL))).toBe(before + 2);
  });

  it('ends them through the control plane\'s route, with the bearer the mandate revocation takes', async () => {
    const owner = auth.ownerSession(SECRET).token;
    expect((await post('/api/admin/owner-sessions/end', withCookie(owner))).status).toBe(403);
    expect((await post('/api/admin/owner-sessions/end', { authorization: `Bearer ${SECRET}` })).status).toBe(403);
    expect((await get(withCookie(owner))).status).toBe(200);
    const res = await cpEnd();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: sessionsOf().generation(), ended: true });
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await get(withCookie(owner))).status).toBe(401);
  });

  it('re-asserts through the control plane\'s route a generation it recorded, raised and never lowered', async () => {
    const live = sessionsOf().generation();
    const lower = await cpEnd(JSON.stringify({ generation: live - 1 }));
    expect(await lower.json()).toEqual({ generation: live, ended: false });
    for (const bad of [-1, 1.5, '3', null, Date.now() + 60_000]) {
      expect((await cpEnd(JSON.stringify({ generation: bad }))).status).toBe(400);
    }
    expect(sessionsOf().generation()).toBe(live);
    // A restore brought an older generation back: the control plane's call puts its own back.
    const cookie = auth.ownerSession(SECRET).token;
    const raised = await cpEnd(JSON.stringify({ generation: live + 5 }));
    expect(await raised.json()).toEqual({ generation: live + 5, ended: false });
    expect((await get(withCookie(cookie))).status).toBe(401);
  });

  it('lets only the control plane re-assert a generation: on a self-hosted instance the admin bearer is the owner\'s', async () => {
    await selfHosted(async () => {
      const live = sessionsOf().generation();
      const res = await cpEnd(JSON.stringify({ generation: live + 3 }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('owner_sessions_assert_cp_only');
      expect(sessionsOf().generation()).toBe(live);
    });
  });

  it('ends a stolen session that keeps ending the owner sessions, once the control plane ends them', async () => {
    let stolen = auth.ownerSession(SECRET).token;
    const held: string[] = [stolen];
    for (let i = 0; i < 3; i++) {
      const res = await post('/api/auth/owner-sessions/end', withCookie(stolen));
      expect(res.status).toBe(200);
      stolen = sessionCookieOf(res)!;
      held.push(stolen);
    }
    expect((await cpEnd()).status).toBe(200);
    expect((await post('/api/auth/owner-sessions/end', withCookie(stolen))).status).toBe(401);
    for (const cookie of held) expect((await get(withCookie(cookie))).status).toBe(401);
    expect((await get(withCookie(auth.ownerSession(SECRET).token))).status).toBe(200);
  });

  it('refuses a request whose body was held back past an end, before it ends anything or hands out a cookie', async () => {
    const held = auth.ownerSession(SECRET).token;
    const { request } = await import('node:http');
    let endedTo = -1;
    const answer = new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
      const req = request(`${base}/api/auth/owner-sessions/end`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2', cookie: `lynox_session=${held}` },
      }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] ?? [] }); });
      req.on('error', reject);
      req.flushHeaders();
      // The headers were checked; now another end, and only then the body.
      setTimeout(() => { endedTo = sessionsOf().endAll(); req.end('{}'); }, 300);
    });
    const { status, setCookie } = await answer;
    expect(status).toBe(401);
    expect(setCookie.filter((c) => c.startsWith('lynox_session='))).toEqual([]);
    // The generation stands where the other end left it: the held request moved nothing.
    expect(sessionsOf().generation()).toBe(endedTo);
  });

  it('refreshes a day-old cookie of the live generation in it, and refuses a day-old one of an older generation without refreshing it', async () => {
    const live = sessionsOf().generation();
    const dayOld = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const current = await get(withCookie(ownerOf(live, dayOld)));
    expect(current.status).toBe(200);
    const refreshed = sessionCookieOf(current);
    expect(refreshed).toBeDefined();
    expect(genOf(refreshed!)).toBe(live);
    const stale = await get(withCookie(ownerOf(live - 1, dayOld)));
    expect(stale.status).toBe(401);
    expect(sessionCookieOf(stale)).toBeUndefined();
  });

  it('leaves the instance secret as it was: its bearer still gets in, and a usage sync still carries it', async () => {
    sessionsOf().endAll();
    expect(process.env['LYNOX_HTTP_SECRET']).toBe(SECRET);
    expect((await get({ authorization: `Bearer ${SECRET}` })).status).toBe(200);
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.test';
    const spy = vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);
    try {
      const hook = createManagedHook();
      await hook.onInit?.();
      await hook.onShutdown?.();
      const calls = spy.mock.calls as unknown as [string, RequestInit][];
      expect(calls.length).toBeGreaterThan(0);
      for (const [url, init] of calls) {
        expect(url.startsWith('https://cp.test/internal/usage/TEST-INSTANCE-1')).toBe(true);
        expect((init.headers as Record<string, string>)['x-instance-secret']).toBe(SECRET);
      }
    } finally {
      vi.unstubAllGlobals();
      process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'http://127.0.0.1:9';
    }
  });
});
