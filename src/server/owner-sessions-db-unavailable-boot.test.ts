import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';

/**
 * A boot on which engine.db cannot be opened has no store of the owner's sessions
 * (owner-sessions.ts): it keeps a generation of its own in memory, past every one a cookie from
 * before can carry, and the engine and the web UI let in that one alike: an old cookie is out, and
 * a fresh login works, request after request.
 */
describe('owner sessions when engine.db cannot be opened (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  let base: string;
  let bootMs: number;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID'];
  const KEY = Symbol.for('lynox.ownerSessionsGeneration');
  const owner = (gen: number): string => {
    const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
    const principal = gen === 0 ? { v: 1, kind: 'owner' } : { v: 1, kind: 'owner', gen };
    const payload = `${randomBytes(8).toString('hex')}.${Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url')}.${String(Math.floor(Date.now() / 1000))}`;
    return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-nodb-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    reloadConfig();
    // A directory where the file should be: the open fails, and it is no corruption to set aside.
    mkdirSync(join(dir, 'engine.db'));
    bootMs = Date.now();
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
      delete (globalThis as Record<symbol, unknown>)[KEY];
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('refuses an old cookie and lets a fresh login in, in the engine and in the web UI, across two requests', async () => {
    expect((api as unknown as { engine: { getOwnerSessions: () => unknown } }).engine.getOwnerSessions()).toBeNull();
    const read = (globalThis as Record<symbol, unknown>)[KEY];
    expect(typeof read).toBe('function');
    const live = (read as () => number)();
    expect(live).toBeGreaterThanOrEqual(bootMs);
    const auth = await import('../../packages/web-ui/src/lib/server/auth.js');
    const get = (token: string): Promise<Response> => fetch(`${base}/api/config`, { headers: { cookie: `lynox_session=${token}` } });
    for (const old of [owner(0), owner(1)]) {
      expect((await get(old)).status).toBe(401);
      expect(auth.readSessionToken(old, SECRET)).toBeNull();
    }
    const fresh = auth.ownerSession(SECRET).token;
    expect(auth.readSessionToken(fresh, SECRET)).not.toBeNull();
    expect((await get(fresh)).status).toBe(200);
    expect((await get(fresh)).status).toBe(200);
  });
});
