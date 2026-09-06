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
 * The BOOT-WIRING proof for everything that only a real restart can show
 * (§0 A1/A2/A12, Auflage 3).
 *
 * `durable-wait-park.test.ts` proves the logic against a WorkerLoop it builds
 * itself. It cannot prove what decides whether any of it runs in production:
 * that the loop a real {@link Engine} constructs is wired to the same stores the
 * parked row is in, and — the part no unit test can reach — that the boot-time
 * prompt expiry lets a parked question through while killing every other.
 *
 * ONE boot for all of it, deliberately. Each Engine boot here costs the suite a
 * heavy fixture, and `engine-init-wiring-boot.test.ts` already runs at up to 88%
 * of the shared 10s budget on green main runs — two PRs in this arc have tipped
 * it by adding a boot. Three triggers and three prompts in one boot say
 * everything three boots would, so this file has exactly one.
 */
describe('Engine boot — what survives a restart, and what the first tick does with it', () => {
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

  it('keeps a parked question, drops an unparked one, and sweeps only what ran out', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wait-boot-'));
    dirs.push(dir);

    // What the dead process left on disk:
    //   · `abandoned`    — parked, deadline already passed, question still pending
    //   · `still-waiting` — parked, deadline an hour out, question still pending
    //   · a chat prompt bound to no trigger, still pending
    const seedEngineDb = new EngineDb(join(dir, 'engine.db'));
    const seedHistory = new RunHistory(join(dir, 'history.db'));
    seedHistory.setVerbGraph(seedEngineDb);
    const seedTrigger = (id: string, until: string): void => {
      seedHistory.insertTrigger({
        id, title: `Ask (${id})`, source: 'cron', effect: 'run_agent',
        scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      });
      seedHistory.updateTrigger(id, { status: 'waiting', waitingUntil: until });
    };
    seedTrigger('abandoned', '2020-01-01T00:00:00.000Z');
    seedTrigger('still-waiting', new Date(Date.now() + 3600_000).toISOString());

    const seedPrompts = new PromptStore(seedHistory.getDb());
    const abandonedPrompt = seedPrompts.insertAskUser(
      'thread-abandoned', 'Which client?', ['Acme'], undefined, undefined, undefined, 'abandoned',
    );
    const livePrompt = seedPrompts.insertAskUser(
      'thread-live', 'Which client?', ['Acme'], undefined, undefined, undefined, 'still-waiting',
    );
    const chatPrompt = seedPrompts.insertAskUser('thread-chat', 'Still there?');
    for (const id of [abandonedPrompt, livePrompt, chatPrompt]) {
      expect(seedPrompts.getById(id)?.status, 'fixture guard').toBe('pending');
    }
    seedHistory.close();
    seedEngineDb.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const prompts = engine.getPromptStore()!;
    const history = engine.getRunHistory()!;

    // ── A1/A2: the boot expiry is the RULE, a parked question is the EXCEPTION ──
    expect(prompts.getById(chatPrompt)?.status,
      'a chat prompt is bound to an SSE connection the restart severed — it must die')
      .toBe('expired');
    expect(prompts.getById(livePrompt)?.status,
      'a parked question outlives the process that asked it — that is the whole arc')
      .toBe('pending');
    expect(prompts.getById(abandonedPrompt)?.status).toBe('pending');
    // Both parked triggers still carry their state.
    expect(history.getTrigger('still-waiting')?.status).toBe('waiting');
    expect(history.getTrigger('abandoned')?.status).toBe('waiting');

    // ── A2: and the answer is ACCEPTED, not 410/404 ──
    expect(prompts.answerUser(livePrompt, 'Acme'),
      'an answer arriving in a later process must be taken')
      .toBe(true);

    // ── A12/A10: the FIRST tick does both, and there must not be a second ──
    //
    // `startWorkerLoop` runs one immediately. That tick computes its due list
    // BEFORE the sweep and the re-arm, so neither trigger is dispatched by it —
    // both are still `waiting` when the list is taken. A second tick WOULD
    // dispatch the re-armed one, start a real agent run, and leave it in flight
    // for teardown to close the database under. So: one tick, polled for rather
    // than awaited, since `start()` fires it fire-and-forget.
    engine.startWorkerLoop(60 * 60_000);
    const loop = engine.getWorkerLoop();
    expect(loop, 'the engine must have produced a worker loop').not.toBeNull();
    const deadline = Date.now() + 5000;
    while (history.getTrigger('abandoned')?.status === 'waiting') {
      if (Date.now() > deadline) throw new Error('the boot tick never swept the abandoned wait');
      await new Promise(r => setTimeout(r, 5));
    }
    loop!.stop();

    expect(history.getTrigger('abandoned')?.status).toBe('failed');
    expect(history.getTrigger('abandoned')?.waiting_until).toBeUndefined();
    expect(prompts.getById(abandonedPrompt)?.status).not.toBe('pending');

    // ── A10: and the ANSWERED one is due again — the whole round trip ──
    // Parked in one process, survived the restart, answered in the next, and
    // now scheduled to run. This assertion used to read "still waiting, its
    // deadline has not passed", which was true until an answer could end a wait;
    // the answer above is what changes it, and that is the feature.
    const rearmed = history.getTrigger('still-waiting');
    expect(rearmed?.status).toBe('open');
    expect(rearmed?.waiting_until).toBeUndefined();
    expect(new Date(rearmed!.next_run_at!).getTime()).toBeLessThanOrEqual(Date.now());
    expect(engine.getTaskManager()!.getDueTriggers().map(t => t.id)).toContain('still-waiting');
    // Asserted as a QUERY, not by ticking again: being due is the claim, and
    // proving it by dispatching would start a real run this test has no way to
    // finish.
  });
});
