import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { OwnerSessions } from '../core/owner-sessions.js';

/**
 * A boot that found engine.db corrupt and started an empty one lost the live generation of the
 * owner's sessions (owner-sessions.ts): it ends every owner session from before the boot instead.
 */
describe('owner sessions after a boot that recreated engine.db (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  let bootMs: number;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID'];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-recreated-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    delete process.env['LYNOX_MANAGED_INSTANCE_ID'];
    reloadConfig();
    writeFileSync(join(dir, 'engine.db'), 'not a database, only text where one should be');
    bootMs = Date.now();
    api = new LynoxHTTPApi();
    await api.init();
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('raises the generation past every one an end could have reached, so no cookie from before the boot counts', () => {
    const sessions = (api as unknown as { engine: { getOwnerSessions: () => OwnerSessions | null } }).engine.getOwnerSessions();
    expect(sessions).not.toBeNull();
    expect(sessions!.generation()).toBeGreaterThanOrEqual(bootMs);
    for (const gen of [0, 1, 2, 1000]) expect(sessions!.ended(gen)).toBe(true);
  });
});
