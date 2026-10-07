import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { RunHistory } from './run-history.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT-WIRING proof for the run-claim sweep (PRD idempotency-bulk-first §3.1).
 *
 * `workflow-run-claim.test.ts` proves what `sweepUnstartedWorkflowRunClaims` DOES, on a
 * real `history.db`. It cannot prove the one thing that decides whether any of it runs:
 * that a real {@link Engine.init} calls it. Delete the line from `init()` and the whole
 * suite stays green while the recovery disappears — and the shape of that loss is bad:
 * a claim held by a request that died before its run started would answer 409 for good,
 * so a client that persisted its key could never run that workflow again.
 *
 * ONE boot, and one `it`. Each Engine boot is a heavy fixture; both facts this file has
 * to establish are facts about the SAME boot, so splitting them would double the cost and
 * prove nothing extra.
 */
describe('Engine boot — the run-claim sweep is actually wired', () => {
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

  it('releases a claim that spent nothing and leaves a paid one standing', async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    const dir = mkdtempSync(join(tmpdir(), 'lynox-claim-boot-'));
    dirs.push(dir);

    // What a dead process leaves behind, in both states the table can be in:
    //   · `nothing-spent` — claimed, the run never reached `onRunStart`
    //   · `paid`          — claimed and stamped, so something was spent
    const seed = new RunHistory(join(dir, 'history.db'));
    seed.claimWorkflowRun('wf-1', 'nothing-spent', 'run-a');
    seed.claimWorkflowRun('wf-1', 'paid', 'run-b');
    seed.markWorkflowRunStarted('run-b');
    expect(seed.readWorkflowRunClaim('wf-1', 'nothing-spent')?.startedAt, 'fixture guard').toBeNull();
    expect(seed.readWorkflowRunClaim('wf-1', 'paid')?.startedAt, 'fixture guard').not.toBeNull();
    seed.close();

    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const history = engine.getRunHistory()!;
    expect(history, 'the engine must have opened the history it just swept').not.toBeNull();

    expect(history.readWorkflowRunClaim('wf-1', 'nothing-spent'),
      'a claim whose run never started has no holder left alive — boot is the only thing that can free it')
      .toBeNull();
    expect(history.readWorkflowRunClaim('wf-1', 'paid'),
      'its run spent money: the route has to be able to read that and refuse, so the sweep must not touch it')
      .not.toBeNull();
    expect(history.readWorkflowRunClaim('wf-1', 'paid')?.runId).toBe('run-b');
  });
});
