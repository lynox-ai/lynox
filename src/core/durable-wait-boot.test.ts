import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the wait-state substrate (§0 Auflage 3).
 *
 * `durable-wait-substrate.test.ts` proves the two queries and the two columns. It
 * cannot prove the thing that decides whether any of it runs in production: that a
 * real {@link Engine.init} opens both databases, carries their ladders to the
 * versions that add these columns, and wires the trigger store onto the RunHistory
 * the rest of the engine holds. Every one of those is an init-ORDER property, and a
 * unit test that hands the store in itself sees none of them.
 *
 * The state under test is the one this whole arc exists for: a trigger parked by a
 * PREVIOUS process. It has to still be there, and still be findable, after the
 * restart — which is exactly what a test that never boots cannot assert.
 */
describe('Engine boot — a trigger parked by a previous process survives the restart', () => {
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
    reloadConfig();
  });

  it('boots onto both columns and still sees the parked row through its own RunHistory', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wait-boot-'));
    dirs.push(dir);

    // What the previous process left on disk: a parked trigger, its wait already run
    // out. Seeded through the same stores the engine will open, then closed — the
    // process that wrote it is gone.
    const seedEngineDb = new EngineDb(join(dir, 'engine.db'));
    const seedHistory = new RunHistory(join(dir, 'history.db'));
    seedHistory.setVerbGraph(seedEngineDb);
    seedHistory.insertTrigger({
      id: 'parked-across-boot', title: 'Ask and wait', source: 'cron', effect: 'run_agent',
      scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    });
    seedHistory.updateTrigger('parked-across-boot', {
      status: 'waiting', waitingUntil: '2026-01-02T00:00:00.000Z',
    });
    seedHistory.close();
    seedEngineDb.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const history = engine.getRunHistory();
    expect(history).not.toBeNull(); // fixture guard: the boot really produced a RunHistory

    // 1. The parked state itself survived — the whole point of making it durable.
    const parked = history!.getTrigger('parked-across-boot');
    expect(parked?.status).toBe('waiting');
    expect(parked?.waiting_until).toBe('2026-01-02T00:00:00.000Z');

    // 2. The loop that would re-fire it is blind to it, after a real boot.
    expect(history!.getDueTriggers().map(t => t.id)).not.toContain('parked-across-boot');

    // 3. And the query built to end its wait is reachable from the engine's own
    //    RunHistory — i.e. the trigger store is wired, not merely constructible.
    //    Deleting the setVerbGraph call in Engine.init leaves this as [].
    expect(history!.getExpiredWaitingTriggers('2026-06-01T00:00:00.000Z').map(t => t.id))
      .toEqual(['parked-across-boot']);
  });

});
