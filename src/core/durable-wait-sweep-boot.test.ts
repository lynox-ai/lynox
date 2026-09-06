import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the expiry sweep (§0 Auflage 3).
 *
 * `durable-wait-park.test.ts` proves the sweep's logic, driving a WorkerLoop it
 * constructs itself. It cannot prove the thing that decides whether the sweep
 * ever runs in production: that the loop a real {@link Engine} builds is wired
 * to the same stores the parked row is in, and that its tick reaches the second
 * query at all. That is an init-ORDER property — the loop takes the Engine, not
 * the stores — and a test that builds the loop by hand sees none of it.
 *
 * The state under test is the one the sweep exists for and the ONLY one it can
 * ever see: a trigger a previous process parked and never came back for. In a
 * live process the run's own `finally` ends its wait; a row still `waiting` at
 * boot is by definition one whose process died holding it.
 */
describe('Engine boot — the expiry sweep collects a wait no process is holding', () => {
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

  it('ends the trigger and settles its question, through a real boot', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-sweep-boot-'));
    dirs.push(dir);

    // What the dead process left behind: a parked trigger whose deadline has
    // passed, and the question it was waiting on, still `pending`.
    const seedEngineDb = new EngineDb(join(dir, 'engine.db'));
    const seedHistory = new RunHistory(join(dir, 'history.db'));
    seedHistory.setVerbGraph(seedEngineDb);
    seedHistory.insertTrigger({
      id: 'abandoned', title: 'Ask and never hear back', source: 'cron', effect: 'run_agent',
      scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    });
    seedHistory.updateTrigger('abandoned', {
      status: 'waiting', waitingUntil: '2020-01-01T00:00:00.000Z',
    });
    const seedPrompts = new PromptStore(seedHistory.getDb());
    const promptId = seedPrompts.insertAskUser(
      'thread-dead', 'Which client?', ['Acme'], undefined, undefined, undefined, 'abandoned',
    );
    expect(seedPrompts.getById(promptId)?.status).toBe('pending'); // fixture guard
    seedHistory.close();
    seedEngineDb.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    // The loop the ENGINE builds, not one this test wired: `startWorkerLoop`
    // hands it `this`, so everything it reaches it reaches through the engine.
    engine.startWorkerLoop(60 * 60_000);
    const loop = engine.getWorkerLoop();
    expect(loop, 'the engine must have produced a worker loop').not.toBeNull();
    await loop!.tick();

    const history = engine.getRunHistory()!;
    const after = history.getTrigger('abandoned');
    expect(after?.status).toBe('failed');          // the wait ended
    expect(after?.waiting_until).toBeUndefined();  // and left no deadline behind

    // Settled BEFORE the trigger ended (§0 E6), so a late answer cannot revive it.
    const prompts = engine.getPromptStore()!;
    expect(prompts.getById(promptId)?.status).not.toBe('pending');
    expect(prompts.answerUser(promptId, 'too late')).toBe(false);
  });

});
