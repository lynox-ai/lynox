import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';

/**
 * A boot on which engine.db cannot be opened has no store of the owner's sessions
 * (owner-sessions.ts): the engine and the web UI then let in generation 0 alike, so no page opens
 * on a cookie every `/api` call refuses.
 */
describe('owner sessions when engine.db cannot be opened (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
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
    api = new LynoxHTTPApi();
    await api.init();
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

  it('publishes generation 0, so the web UI lets in and mints only what the engine lets in', async () => {
    expect((api as unknown as { engine: { getOwnerSessions: () => unknown } }).engine.getOwnerSessions()).toBeNull();
    const read = (globalThis as Record<symbol, unknown>)[KEY];
    expect(typeof read).toBe('function');
    expect((read as () => unknown)()).toBe(0);
    const auth = await import('../../packages/web-ui/src/lib/server/auth.js');
    expect(auth.readSessionToken(owner(0), SECRET)).not.toBeNull();
    expect(auth.readSessionToken(owner(1), SECRET)).toBeNull();
  });
});
