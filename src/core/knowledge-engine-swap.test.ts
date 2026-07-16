import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';

/**
 * DK.1 tool swap + byte-identical-at-OFF (H9 — no partial swap). Exercises the real
 * engine.ts registration decision under both flag states, isolated to a temp data dir.
 */
describe('DK.1 engine tool swap', () => {
  const tmpDirs: string[] = [];
  const LEGACY = ['memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list', 'memory_promote'];
  const DURABLE = ['remember', 'recall', 'memory_block_edit'];

  async function initEngine(durable: boolean): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-swap-'));
    tmpDirs.push(dir);
    const prevData = process.env['LYNOX_DATA_DIR'];
    const prevFlag = process.env['LYNOX_DURABLE_MEMORY_ENABLED'];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = durable ? 'true' : 'false';
    reloadConfig(); // loadConfig() memoizes — clear the cache so this run reads the env we just set
    try {
      const engine = new Engine({} as import('../types/index.js').LynoxConfig);
      await engine.init();
      return engine;
    } finally {
      if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
      if (prevFlag === undefined) delete process.env['LYNOX_DURABLE_MEMORY_ENABLED']; else process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = prevFlag;
      reloadConfig(); // don't leak this run's env-derived config into other tests
    }
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('flag OFF = byte-identical: the six legacy memory_* tools are registered, none of the new three', async () => {
    const engine = await initEngine(false);
    const reg = engine.getRegistry();
    for (const name of LEGACY) expect(reg.find(name), name).toBeDefined();
    for (const name of DURABLE) expect(reg.find(name), name).toBeUndefined();
    expect(engine.getKnowledgeStore()).toBeNull();
  });

  it('flag ON: the three durable tools are registered, none of the six legacy (no partial swap)', async () => {
    const engine = await initEngine(true);
    const reg = engine.getRegistry();
    for (const name of DURABLE) expect(reg.find(name), name).toBeDefined();
    for (const name of LEGACY) expect(reg.find(name), name).toBeUndefined();
    expect(engine.getKnowledgeStore()).not.toBeNull();
  });
});
