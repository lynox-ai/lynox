import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { EngineDb } from './engine-db.js';
import { GrantLedger } from './grant-ledger.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';

/**
 * `Engine.init` wires the fingerprint reader and runs the credential comparison after the
 * backfill (PRD connection-attribution A2(5)). The unit tests hand the store a reader
 * themselves; delete either wiring line and they stay green while no boot ever compares. So
 * this boots a real Engine, five times, with the credential coming from the environment.
 */
describe('Engine boot — the credential comparison runs, and mints only for a credential the grant did not record', () => {
  const dirs: string[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  const boot = async (): Promise<Engine> => {
    const engine = new Engine({} as LynoxConfig);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { await engine.init(); } finally { stderr.mockRestore(); }
    return engine;
  };

  it('records at the save, keeps at an unchanged boot, mints on a changed credential, and mints the baseline of a grant without fingerprints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-grantfp-'));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    setEnv('LYNOX_SECRET_SHOP_KEY', 'shop-key-one-0000');
    reloadConfig();
    const dbPath = join(dir, 'engine.db');
    // The engine records a keyed fingerprint (`EngineDb.keyedHash` under the vault key), never the
    // plain token fingerprint, which a copy of the row would let anyone test guesses against.
    const keyed = (v: string): string => {
      const db = new EngineDb(dbPath);
      try { return db.keyedHash(['lynox-grant-fingerprint', v]).slice(0, 32); } finally { db.close(); }
    };
    const reasonOf = (grant: string): string | undefined => {
      const db = new EngineDb(dbPath);
      try { return new GrantLedger(db.getDb()).get(grant)?.reason; } finally { db.close(); }
    };

    // Boot 1: the save records the credential the environment holds.
    const first = await boot();
    expect(first.getApiStore()!.save({
      id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd',
      auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] },
    }).ok).toBe(true);
    const g1 = first.getApiStore()!.get('shop')!.oauth_grant!;
    await first.shutdown();
    expect(g1.fingerprints).toEqual({ SHOP_KEY: keyed('shop-key-one-0000') });
    expect(g1.fingerprints!['SHOP_KEY']).not.toBe(tokenFingerprint('shop-key-one-0000'));

    // Boot 2: nothing changed, nothing minted.
    const second = await boot();
    expect(second.getApiStore()!.get('shop')!.oauth_grant!.grant_id).toBe(g1.grant_id);
    await second.shutdown();

    // Boot 3: the environment now holds another key — a credential the grant did not record.
    setEnv('LYNOX_SECRET_SHOP_KEY', 'shop-key-two-0000');
    const third = await boot();
    const g3 = third.getApiStore()!.get('shop')!.oauth_grant!;
    expect(g3.grant_id).not.toBe(g1.grant_id);
    await third.shutdown();
    expect(g3.fingerprints).toEqual({ SHOP_KEY: keyed('shop-key-two-0000') });
    expect(reasonOf(g3.grant_id!)).toBe('secret-changed');

    // Boot 4: the stored row loses its fingerprints, as a grant minted before they were recorded.
    const raw = new EngineDb(dbPath);
    raw.getDb().prepare("UPDATE connections SET config_json = json_remove(config_json, '$.oauth_grant.fingerprints') WHERE id = 'shop'").run();
    raw.close();
    const fourth = await boot();
    const g4 = fourth.getApiStore()!.get('shop')!.oauth_grant!;
    expect(g4.grant_id).not.toBe(g3.grant_id);
    await fourth.shutdown();
    expect(g4.fingerprints).toEqual({ SHOP_KEY: keyed('shop-key-two-0000') });
    expect(reasonOf(g4.grant_id!)).toBe('baseline');

    // Boot 5: another vault key. Every fingerprint differs; the boot mints once, as a rekey.
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-1111111111');
    reloadConfig();
    const fifth = await boot();
    const g5 = fifth.getApiStore()!.get('shop')!.oauth_grant!;
    await fifth.shutdown();
    expect(g5.grant_id).not.toBe(g4.grant_id);
    expect(reasonOf(g5.grant_id!)).toBe('rekey');
    expect(g5.fingerprints).toEqual({ SHOP_KEY: keyed('shop-key-two-0000') });
    expect(g5.fingerprints!['SHOP_KEY']).not.toBe(g4.fingerprints!['SHOP_KEY']);
  });

  it('takes no fingerprints without a vault key, where the hash would be plain SHA-256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-grantfp-'));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', undefined);
    setEnv('LYNOX_SECRET_SHOP_KEY', 'shop-key-one-0000');
    reloadConfig();
    // A boot without a key generates one — unless a vault already exists, whose key is lost.
    writeFileSync(join(dir, 'vault.db'), '');
    const engine = await boot();
    expect(process.env['LYNOX_VAULT_KEY']).toBeUndefined();
    expect(engine.getApiStore()!.save({
      id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd',
      auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] },
    }).ok).toBe(true);
    const g = engine.getApiStore()!.get('shop')!.oauth_grant!;
    await engine.shutdown();
    // The grant is minted all the same; only its credential record is left out.
    expect(g.grant_id).toBeDefined();
    expect(g.fingerprints).toBeUndefined();
    expect(g.fingerprint_check).toBeUndefined();
  });
});
