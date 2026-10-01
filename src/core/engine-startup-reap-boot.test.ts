import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the startup reap.
 *
 * `memory-gc-startup-reap.test.ts` proves the reap LOGIC. It cannot prove the one thing
 * that actually matters here: that a real {@link Engine.init} calls it. Without this test,
 * deleting the `_scheduleStartupReap()` line from `init()` leaves the entire suite green —
 * the whole feature dead, and nothing anywhere notices.
 *
 * The gap being closed: the periodic reap fires at `runCount % 50`, and `runCount` is an
 * in-memory field that resets to zero on every restart, so an instance doing fewer than
 * fifty runs per process lifetime reaps nothing, ever. Measured on a production instance:
 * 288 deactivated rows, 28% of the table, with the file untouched for nine days.
 */
describe('Engine boot — the startup reap actually runs', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  let prevDataDir: string | undefined;
  let prevDurable: string | undefined;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    if (prevDurable === undefined) delete process.env['LYNOX_DURABLE_MEMORY_ENABLED'];
    else process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = prevDurable;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('reaps a deactivated row left behind by a previous process', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-reap-boot-'));
    dirs.push(dir);

    // The state a restart-heavy instance is actually in: a row deactivated by a previous
    // process, never reaped because that process never reached fifty runs.
    const seed = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    seed.setEmbeddingDimensions(3);
    const staleId = seed.createMemory({
      text: 'Jana Reber lives in Bern', namespace: 'knowledge',
      scopeType: 'global', scopeId: 'global', embedding: [1, 0, 0],
    });
    const liveId = seed.createMemory({
      text: 'ACME pays by invoice', namespace: 'knowledge',
      scopeType: 'global', scopeId: 'global', embedding: [0, 1, 0],
    });
    seed.deactivateMemoriesByPattern('Jana Reber');
    expect(seed.getMemory(staleId)).not.toBeNull(); // still on disk when the process died
    seed.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    // The reap is fire-and-forget, so let the microtask queue drain before asserting.
    await new Promise(resolve => setImmediate(resolve));

    const check = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    try {
      expect(check.getMemory(staleId)).toBeNull();      // boot did the work the counter never got to
      expect(check.getMemory(liveId)).not.toBeNull();   // and only that work
    } finally {
      check.close();
    }
  });

  it('does NOT touch a RETIRED durable-knowledge entry — that one is an audit record', async () => {
    // The other half of the invariant, and the one that is easy to break by accident.
    // The legacy store hard-deletes its deactivated rows, so "make the durable store
    // symmetric" is the obvious next thought — but `memory_retire` tells the user the
    // entry is never deleted. An earlier cut of this change added exactly that sweep.
    // Guarding it at the store alone is not enough: the failure mode is someone WIRING a
    // purge into the boot path, which only a boot can catch.
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-reap-dk-'));
    dirs.push(dir);
    process.env['LYNOX_DATA_DIR'] = dir;
    // The flag travels by env here, exactly as the managed fleet delivers it — the
    // constructor argument does not reach userConfig, which is loadConfig()'s result.
    prevDurable = process.env['LYNOX_DURABLE_MEMORY_ENABLED'];
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    reloadConfig(); // loadConfig() caches, and an earlier boot in this file filled it

    const first = new Engine({} as LynoxConfig);
    engines.push(first);
    await first.init();
    const store = first.getKnowledgeStore();
    expect(store).not.toBeNull(); // fixture guard: durable memory really is on
    const entry = store!.write({ text: 'ACME renews in March', sourceChannel: 'ui', sourceUntrusted: false });
    store!.retireEntry(entry.id, 'user_asserted');
    await first.shutdown();

    // Second boot: the reap runs again on a store that now holds a retired entry.
    reloadConfig();
    const second = new Engine({} as LynoxConfig);
    engines.push(second);
    await second.init();
    await new Promise(resolve => setImmediate(resolve));

    const survivor = second.getKnowledgeStore()!.getEntry(entry.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.status).toBe('superseded'); // retired, kept, exactly as promised
  });
});
