import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { EngineDb } from './engine-db.js';
import { GrantLedger } from './grant-ledger.js';

/**
 * `Engine.init` wires the grant ledger into the api store and runs the backfill
 * (PRD connection-attribution A1, A2(6)). The unit tests hand the store a ledger
 * themselves; delete the wiring line and they all stay green while no connection
 * ever gets a grant. So this boots a real Engine, three times.
 */
describe('Engine boot — every registered api connection leaves the boot with a grant the ledger knows', () => {
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

  it('mints on a save, backfills a connection that lost its grant, and a further boot mints nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-grantboot-'));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    reloadConfig();

    // Boot 1: a save through the engine's own store mints — the ledger is wired.
    const first = await boot();
    const saved1 = first.getApiStore()!.save({
      id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd',
      auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] },
    });
    expect(saved1.ok).toBe(true);
    const minted = first.getApiStore()!.get('shop')?.oauth_grant?.grant_id;
    expect(minted).toBeDefined();
    await first.shutdown();

    // The row loses its grant, as a row from before the ledger has none.
    const dbPath = join(dir, 'engine.db');
    expect(existsSync(dbPath)).toBe(true);
    const raw = new EngineDb(dbPath);
    raw.getDb().prepare("UPDATE connections SET config_json = json_remove(config_json, '$.oauth_grant.grant_id') WHERE id = 'shop'").run();
    raw.close();

    // Boot 2: the backfill gives it a fresh one, known to the ledger.
    const second = await boot();
    const backfilled = second.getApiStore()!.get('shop')?.oauth_grant?.grant_id;
    expect(backfilled).toBeDefined();
    expect(backfilled).not.toBe(minted);
    await second.shutdown();
    const check = new EngineDb(dbPath);
    expect(new GrantLedger(check.getDb()).get(backfilled!)).toMatchObject({ connection_id: 'shop', reason: 'backfill' });
    check.close();

    // Boot 3: nothing to do.
    const third = await boot();
    expect(third.getApiStore()!.get('shop')?.oauth_grant?.grant_id).toBe(backfilled);
    await third.shutdown();
  });

  it('records the hosts of each grant, and the boot recompute writes a missing snapshot again, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-granthosts-'));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    reloadConfig();
    const dbPath = join(dir, 'engine.db');
    const history = (grantId: string): string[] => {
      const db = new EngineDb(dbPath);
      try { return new GrantLedger(db.getDb()).hostsHistory(grantId).map((h) => h.hosts.join(',')); } finally { db.close(); }
    };

    // Boot 1: the engine's own save writes the first snapshot.
    const first = await boot();
    expect(first.getApiStore()!.save({ id: 'shop', name: 'shop', base_url: 'https://api.shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } }).ok).toBe(true);
    const g = first.getApiStore()!.get('shop')!.oauth_grant!.grant_id!;
    await first.shutdown();
    expect(history(g)).toEqual(['api.shop.example']);

    // The snapshot is lost, as a write that failed after the save leaves it.
    const raw = new EngineDb(dbPath);
    raw.getDb().prepare('DELETE FROM connection_grant_hosts WHERE grant_id = ?').run(g);
    raw.close();

    // Boot 2: the recompute writes it again.
    const second = await boot();
    await second.shutdown();
    expect(history(g)).toEqual(['api.shop.example']);

    // Boot 3: nothing to do.
    const third = await boot();
    await third.shutdown();
    expect(history(g)).toEqual(['api.shop.example']);
  }, 60_000);
});
