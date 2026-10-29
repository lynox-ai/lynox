import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore } from './api-store.js';
import { reloadConfig } from './config.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The boot's half of the opaque API profile id (660a-1c S-2). The migration gives every row an id
 * once; a row an older binary writes after a pin back has none, so the boot fills it each time.
 * The fill runs in its own catch: a failure there costs a row's id, never engine.db, the profiles
 * or the instance trail.
 */
describe('Engine boot — the opaque id of an API profile', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.restoreAllMocks();
    reloadConfig();
  });

  async function boot(dir: string): Promise<Engine> {
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  /**
   * A data dir whose engine.db holds the profile `shop` and an API row `legacy`, both without an
   * id, as an older binary leaves them. `shop` the boot rewrites (its grant is issued again), and
   * that write gives it an id through the upsert. `legacy` has a config the store cannot read, so
   * no part of the boot but the fill touches it: that row is the one that shows the fill.
   */
  function withProfileWithoutId(): string {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-apf-boot-'));
    dirs.push(dir);
    const before = new EngineDb(join(dir, 'engine.db'));
    const store = new ApiStore();
    store.setConnectionStore(new ConnectionStore(before));
    expect(store.save({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } }).ok).toBe(true);
    before.getDb().exec("UPDATE connections SET trail_id = NULL WHERE id = 'shop'; INSERT INTO connections (id, kind, name, config_json) VALUES ('legacy', 'api', 'Legacy', 'not-json')");
    before.close();
    return dir;
  }

  it('gives a profile row without an id one', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = await boot(withProfileWithoutId());
    expect(engine.getApiStore()!.trailIdOf('legacy')).toMatch(/^apf_[0-9a-f]{16}$/);
    expect(engine.getApiStore()!.trailIdOf('shop')).toMatch(/^apf_[0-9a-f]{16}$/);
  });

  it('a fill that fails leaves engine.db, the profiles and the trail working, and says so', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(ConnectionStore.prototype, 'fillApiTrailIds').mockImplementation(() => { throw new Error('disk I/O error'); });
    const engine = await boot(withProfileWithoutId());
    expect(engine.getEngineDb()).not.toBeNull();
    expect(engine.getApiStore()!.get('shop'), 'the profiles are loaded').toBeDefined();
    expect(engine.getApiStore()!.trailIdOf('legacy'), 'precondition: the fill did not run').toBeUndefined();
    const log = engine.getAuditLog();
    expect(log).not.toBeNull();
    log!.record({ principal: OWNER_PRINCIPAL, correlationId: 'c-1', action: 'instance:probe:change', target: 'probe', phase: 'attempt', runId: 'run-1' });
    expect((engine.getEngineDb()!.getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'instance:probe:change'").get() as { n: number }).n, 'the trail writes').toBe(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).some((l) => l.includes('API profile id fill failed: disk I/O error'))).toBe(true);
  });
});
