import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_CLAIM_STALE_MS, BULK_HALT_REASONS } from './bulk-ledger.js';
import type { PlannedTarget } from './bulk-ledger.js';
import { bulkWriterFor, runBulkEffect, workspaceWriter, type TargetWriter } from './bulk-apply.js';
import { TriggerStore } from './trigger-store.js';
import { deriveSourceEffect } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool, bulkStatusTool } from '../tools/builtin/bulk.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { IAgent, MemoryScopeRef, TriggerRecord } from '../types/index.js';

/**
 * Acceptance for the apply/undo slice of PRD bulk-changes-reversible (§7 b–e, g, h;
 * §3.4/§3.5): an approved run is written by a worker effect off its trigger, a stop at
 * ~80 % resumes without writing any target twice, two loops on one ledger never both
 * write a target, an undo is a second approved run that restores exactly what was
 * applied, an atomic run is all or nothing, and a target someone else changed is a
 * conflict — shown, not overwritten.
 */

// The 210-target runs write real files with an fsync each and two engine.db commits per
// target; ~2–5 s alone, more under the full suite's load.
vi.setConfig({ testTimeout: 30_000 });

const scope: MemoryScopeRef = { type: 'context', id: 'bulk-apply-test' };
const MARK = 'ZXQ-SECRET-MARK';

let dir: string;
let ws: string;
let engineDb: EngineDb;
let ledger: BulkLedger;
let store: DataStore;

function agent(): IAgent {
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1' } as unknown as IAgent;
}

function runIdOf(result: string): string {
  const m = /Bulk run ([0-9a-f-]{36})/.exec(result);
  if (!m) throw new Error(`no run id in: ${result}`);
  return m[1]!;
}

/** Plan workspace targets through the model-facing tool, the way a run starts. */
async function planFiles(rows: { target: string; after: string }[], atomic = false): Promise<string> {
  writeFileSync(join(ws, 'src.json'), JSON.stringify(rows));
  const out = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json', atomic }, agent());
  return runIdOf(out);
}

function approve(runId: string, extra: { maxTargets?: number; now?: number } = {}): void {
  const out = ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, ...extra });
  if (!out.ok) throw new Error(`approve refused: ${out.reason}`);
}

/** Wraps a writer and counts writes per key — the "no target twice" witness. */
function counting(inner: TargetWriter, delayMs = 0): { writer: TargetWriter; writes: Map<string, number> } {
  const writes = new Map<string, number>();
  return {
    writes,
    writer: {
      async read(key) {
        if (delayMs > 0) await sleep(delayMs);
        return inner.read(key);
      },
      async write(key, after) {
        writes.set(key, (writes.get(key) ?? 0) + 1);
        return inner.write(key, after);
      },
    },
  };
}

/** An in-memory target system for loop-logic tests. `fail` keys throw on write. */
function memory(initial: Record<string, string>, fail: Set<string> = new Set()): { writer: TargetWriter; state: Map<string, string> } {
  const state = new Map(Object.entries(initial));
  return {
    state,
    writer: {
      async read(key) {
        return state.has(key) ? { absent: false, value: state.get(key)! } : { absent: true };
      },
      async write(key, after) {
        if (fail.has(key)) throw new Error(`boom ${MARK}`);
        if (after.absent) state.delete(key);
        else state.set(key, after.value as string);
        return 'ok';
      },
    },
  };
}

/** Record a dry run of in-memory targets directly: key k<i>, before v<i>, after w<i>. */
function recordMemoryRun(n: number, opts: { atomic?: boolean } = {}): { runId: string; initial: Record<string, string> } {
  const initial: Record<string, string> = {};
  const targets: PlannedTarget[] = [];
  for (let i = 0; i < n; i++) {
    const key = `k${String(i).padStart(3, '0')}`;
    initial[key] = `v${String(i)}`;
    targets.push({ key, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` });
  }
  const s = ledger.recordDryRun({ createdBy: 't', targetSystem: 'workspace', scope: 'mem', targets, atomic: opts.atomic });
  return { runId: s.id, initial };
}

const effectDeps = (writer: TargetWriter, now?: () => number) => ({ ledger, writerFor: () => writer, ...(now ? { now } : {}) });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-apply-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb);
  store = new DataStore(join(dir, 'datastore.db'));
});

afterEach(() => {
  clearTenantWorkspace();
  engineDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 210 files: 140 exist and change, 70 are created. */
function seedFiles(): { target: string; after: string }[] {
  mkdirSync(join(ws, 'pages'));
  const rows: { target: string; after: string }[] = [];
  for (let i = 0; i < 210; i++) {
    const name = `pages/p${String(i).padStart(3, '0')}.md`;
    if (i < 140) writeFileSync(join(ws, name), `old ${String(i)}\n${MARK}\n`);
    rows.push({ target: name, after: `new ${String(i)}\n` });
  }
  return rows;
}

describe('approval → trigger → worker effect → handler (§7 b)', () => {
  it('writes a 210-file run through a real worker tick off the trigger the approval armed', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);

    const triggers = new TriggerStore(engineDb);
    const due = triggers.getDue();
    expect(due.map((t) => [t.effect, t.bulk_run_id])).toEqual([['bulk_apply', runId]]);

    const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
      triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
      triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
    });
    const notify = vi.fn(async () => {});
    const engine = {
      getTaskManager: () => ({
        getDueTriggers: () => triggers.getDue(),
        getExpiredWaitingTriggers: () => [],
        endWait: () => false,
        getTrigger: (id: string) => triggers.getById(id),
        recordTaskRun,
      }),
      getBulkLedger: () => ledger,
      getDataStore: () => store,
      getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
      getUserConfig: () => ({}),
    } as unknown as Engine;
    const router = { hasChannels: () => true, notify } as unknown as NotificationRouter;
    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });

    for (let i = 0; i < 210; i++) {
      expect(readFileSync(join(ws, `pages/p${String(i).padStart(3, '0')}.md`), 'utf-8')).toBe(`new ${String(i)}\n`);
    }
    const s = ledger.getStatus(runId)!;
    expect([s.phase, s.applied, s.failed, s.conflicts]).toEqual(['done', 210, 0, 0]);
    expect(recordTaskRun.mock.calls[0]![2]).toBe('success');
    // The run result and the notification are counts — never a target's content.
    expect(recordTaskRun.mock.calls[0]![1]).not.toContain(MARK);
    expect(JSON.stringify(notify.mock.calls)).not.toContain(MARK);
    // One-shot: done, the trigger is no longer due.
    expect(triggers.getDue()).toEqual([]);

    // §7 (e): the same rule planned again finds nothing to change.
    const again = ledger.getStatus(await planFiles(rows))!;
    expect(again.changes).toEqual({ update: 0, create: 0, delete: 0, unchanged: 210, invalid: 0 });
  });

  it('bulk_status after the run reports counts and phase, no content', async () => {
    const runId = await planFiles(seedFiles());
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    const out = await bulkStatusTool.handler({ run_id: runId }, agent());
    expect(out).toContain('phase done');
    expect(out).toContain('Applied 210, failed 0, conflicts 0, undone 0.');
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('new 1');
  });

  it('a run left pending (a dead loop\'s fresh claim) re-arms its trigger instead of ending it', async () => {
    const { runId } = recordMemoryRun(2);
    approve(runId);
    expect(ledger.claimTarget(runId, 1)).toBe(true); // held by a loop that died
    const triggers = new TriggerStore(engineDb);
    const recordTaskRun = vi.fn((id: string, _r: string, status: string) => {
      triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
    });
    const engine = {
      getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false, recordTaskRun }),
      getBulkLedger: () => ledger,
      getDataStore: () => store,
      getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
      getUserConfig: () => ({}),
    } as unknown as Engine;
    // The in-memory targets need an in-memory writer: route the run to one.
    const { writer } = memory({ k000: 'v0', k001: 'v1' });
    const mod = await import('./bulk-apply.js');
    const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
    try {
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      const before = Date.now();
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled());
      await vi.waitFor(() => expect(triggers.getById(`bulk-${runId}`)!.status).toBe('open'));
      const t = triggers.getById(`bulk-${runId}`)!;
      expect(Date.parse(t.next_run_at!)).toBeGreaterThanOrEqual(before + 25_000);
      expect(ledger.getStatus(runId)!.applied).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a worker tick with a bulk trigger but no ledger records a skip and writes nothing', async () => {
    const recordTaskRun = vi.fn();
    const task = { id: 'bulk-x', title: 'Bulk run x', effect: 'bulk_apply', bulk_run_id: 'x', source: 'manual' } as unknown as TriggerRecord;
    const engine = {
      getTaskManager: () => ({ getDueTriggers: () => [task], getExpiredWaitingTriggers: () => [], endWait: () => false, recordTaskRun }),
      getBulkLedger: () => null,
      getUserConfig: () => ({}),
    } as unknown as Engine;
    const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalledWith('bulk-x', expect.stringContaining('not available'), 'failed'));
  });
});

describe('the effect can only come from the approval (§7 b, the derivation property)', () => {
  // MUTATION: map any task_type onto `bulk_apply` in deriveSourceEffect → this fails.
  it('no create-path intent derives a bulk effect', () => {
    const intents = ['bulk_apply', 'bulk_undo', 'bulk', 'backup', 'reminder', 'pipeline', 'watch', 'manual', '', 'run_agent'];
    for (const taskType of intents) {
      for (const extra of [{}, { scheduleCron: '0 9 * * *' }, { pipelineId: 'wf' }, { watchConfig: '{}' }]) {
        const { effect } = deriveSourceEffect({ taskType, ...extra });
        expect(effect === 'bulk_apply' || effect === 'bulk_undo', `${taskType} ${JSON.stringify(extra)}`).toBe(false);
      }
    }
  });

  it('a bulk trigger keeps its effect and run id through a field update', async () => {
    const runId = await planFiles([{ target: 'a.txt', after: 'x' }]);
    approve(runId);
    const triggers = new TriggerStore(engineDb);
    triggers.updateFields(`bulk-${runId}`, { title: 'renamed', scheduleCron: '0 9 * * *', status: 'open' });
    const t = triggers.getById(`bulk-${runId}`)!;
    expect([t.effect, t.bulk_run_id]).toEqual(['bulk_apply', runId]);
  });

  it('refuses a run that was never approved and writes nothing', async () => {
    writeFileSync(join(ws, 'a.txt'), 'before');
    const runId = await planFiles([{ target: 'a.txt', after: 'after' }]);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    expect(out.status).toBe('refused');
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('before');
    expect(ledger.getStatus(runId)!.phase).toBe('previewed');
  });

  it('refuses an effect that does not match the run kind', async () => {
    const { runId } = recordMemoryRun(2);
    approve(runId);
    const { writer, state } = memory({ k000: 'v0', k001: 'v1' });
    expect((await runBulkEffect(runId, 'bulk_undo', effectDeps(writer))).status).toBe('refused');
    expect(state.get('k000')).toBe('v0');
  });
});

describe('approval checks (§7 g)', () => {
  it('approve refuses a checksum that is not the current one', async () => {
    const runId = await planFiles([{ target: 'a.txt', after: 'x' }]);
    expect(ledger.approve(runId, { checksum: 'stale' })).toEqual({ ok: false, reason: 'checksum' });
    expect(new TriggerStore(engineDb).getDue()).toEqual([]);
  });

  it('a ledger changed after approval is refused and halted, nothing written', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId);
    engineDb.getDb().prepare('UPDATE bulk_targets SET after_planned = ? WHERE run_id = ? AND seq = 0')
      .run(engineDb.enc(JSON.stringify('evil')), runId);
    const { writer, state } = memory(initial);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('refused');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.checksum);
    expect([...state.values()]).toEqual(['v0', 'v1', 'v2']);
  });

  it('an expired approval is refused', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId, { now: Date.now() - 2 * 24 * 60 * 60_000 });
    const { writer, state } = memory(initial);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('refused');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.expired);
    expect(state.get('k000')).toBe('v0');
  });

  it('stops at the approved maximum', async () => {
    const { runId, initial } = recordMemoryRun(10);
    approve(runId, { maxTargets: 3 });
    const { writer, state } = memory(initial);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('halted');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.maxTargets);
    expect([...state.values()].filter((v) => v.startsWith('w'))).toHaveLength(3);
  });

  it('refuses maxTargets outside 1..writing targets', async () => {
    const { runId } = recordMemoryRun(3);
    const checksum = ledger.computeChecksum(runId)!;
    expect(ledger.approve(runId, { checksum, maxTargets: 4 })).toEqual({ ok: false, reason: 'bad_max_targets' });
    expect(ledger.approve(runId, { checksum, maxTargets: 0 })).toEqual({ ok: false, reason: 'bad_max_targets' });
  });
});

describe('stop at ~80 % and resume (§7 c)', () => {
  it('resumes a time-budget halt after a human resume, no target written twice', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);
    // A clock that jumps past the run's budget once 168 targets (80 %) are written.
    const { writer, writes } = counting(workspaceWriter());
    let t = Date.now();
    const clock = (): number => ((ledger.getStatus(runId)?.applied ?? 0) >= 168 ? t + 10 * 60 * 60_000 : t);
    const first = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer, clock));
    expect(first.status).toBe('halted');
    expect(ledger.getStatus(runId)!.applied).toBe(168);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.timeBudget);
    // Re-firing the trigger while halted writes nothing.
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('refused');

    const resumed = ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! });
    expect(resumed.ok).toBe(true);
    t = Date.now();
    const second = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer, () => t));
    expect(second.status).toBe('done');
    expect(ledger.getStatus(runId)!.applied).toBe(210);
    expect([...writes.values()].every((n) => n === 1)).toBe(true);
    expect(writes.size).toBe(210);
  });

  it('a restart re-fires the trigger and the next loop finishes, taking the dead loop\'s stale claim', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);
    // Loop 1 "dies" on its 169th target: the write never returns, nothing is recorded.
    let n = 0;
    const inner = workspaceWriter();
    const dying: TargetWriter = {
      read: (k) => inner.read(k),
      write: (k, a) => (++n === 169 ? new Promise<string>(() => {}) : inner.write(k, a)),
    };
    void runBulkEffect(runId, 'bulk_apply', effectDeps(dying));
    await vi.waitFor(() => expect(n).toBe(169), { timeout: 20_000 });
    expect(ledger.getStatus(runId)!.applied).toBe(168);

    // "Restart": a fresh ledger on the same file, the trigger still due.
    engineDb.close();
    engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
    ledger = new BulkLedger(engineDb);
    const [trigger] = new TriggerStore(engineDb).getDue();
    expect(trigger?.bulk_run_id).toBe(runId);

    const { writer, writes } = counting(workspaceWriter());
    // Right after the restart the dead loop's claim is still fresh: the run waits.
    const early = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(early.status).toBe('pending');
    const later = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer, () => Date.now() + BULK_CLAIM_STALE_MS + 1_000));
    expect(later.status).toBe('done');
    expect(ledger.getStatus(runId)!.applied).toBe(210);
    // 41 not yet written plus the claimed one; none of the 168 again.
    expect(writes.size).toBe(42);
    expect([...writes.values()].every((c) => c === 1)).toBe(true);
    expect(readFileSync(join(ws, 'pages/p168.md'), 'utf-8')).toBe('new 168\n');
  });

  it('a target written but not recorded (died in between) is recognised, not written again', async () => {
    const { runId, initial } = recordMemoryRun(5);
    approve(runId);
    const { writer, state } = memory(initial);
    state.set('k002', 'w2');
    const spy = counting(writer);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(spy.writer))).status).toBe('done');
    expect(spy.writes.has('k002')).toBe(false);
    expect(ledger.getStatus(runId)!.applied).toBe(5);
  });

  // MUTATION: drop the `claimed_at IS NULL OR claimed_at < ?` guard (or the whole
  // condition) from BulkLedger.claimTarget → two loops write the same targets.
  it('two loops on one ledger never both write a target', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);
    const { writer, writes } = counting(workspaceWriter(), 1);
    const [a, b] = await Promise.all([
      runBulkEffect(runId, 'bulk_apply', effectDeps(writer)),
      runBulkEffect(runId, 'bulk_apply', effectDeps(writer)),
    ]);
    // Whichever loop finds the last target taken may end `pending`; at least one closes the run.
    expect([a.status, b.status].every((st) => st === 'done' || st === 'pending')).toBe(true);
    expect([a.status, b.status]).toContain('done');
    expect(writes.size).toBe(210);
    expect([...writes.entries()].filter(([, c]) => c !== 1)).toEqual([]);
    expect(ledger.getStatus(runId)!.applied).toBe(210);
    expect(ledger.getStatus(runId)!.phase).toBe('done');
  });
});

describe('the claim predicate (BulkLedger.claimTarget)', () => {
  // Asserted directly: in the loop, an applied target that is claimed again only reaches
  // the "already holds the planned state" path, which hides a claim that should never
  // have been granted — harmless for a local file, a second request for an external one.
  it('grants a claim only on a target that is open, or held by a dead loop', () => {
    const { runId } = recordMemoryRun(3);
    approve(runId);
    const t0 = Date.now();
    expect(ledger.claimTarget(runId, 0, t0)).toBe(true);
    expect(ledger.claimTarget(runId, 0, t0 + 1_000)).toBe(false);
    expect(ledger.claimTarget(runId, 0, t0 + BULK_CLAIM_STALE_MS + 1_000)).toBe(true);

    ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 0, 'ok');
    expect(ledger.claimTarget(runId, 0, t0 + 10 * BULK_CLAIM_STALE_MS)).toBe(false);

    expect(ledger.claimTarget(runId, 1, t0)).toBe(true);
    ledger.recordFailed(runId, 1, 'write_failed');
    expect(ledger.claimTarget(runId, 1, t0 + 10 * BULK_CLAIM_STALE_MS)).toBe(false);
  });
});

describe('a run closed by the other loop', () => {
  // The loop that finds the run already closed must report `done`, not a halt: the
  // worker turns a non-done outcome into a failure notice.
  it('a slow loop that finds the run done by a fast one reports done', async () => {
    const { runId, initial } = recordMemoryRun(40);
    approve(runId);
    const { writer } = memory(initial);
    const slow: TargetWriter = { read: async (k) => { await sleep(20); return writer.read(k); }, write: (k, a) => writer.write(k, a) };
    const [fast, late] = await Promise.all([
      runBulkEffect(runId, 'bulk_apply', effectDeps(writer)),
      runBulkEffect(runId, 'bulk_apply', effectDeps(slow)),
    ]);
    expect([fast.status, late.status]).toEqual(['done', 'done']);
    expect(ledger.getStatus(runId)!.applied).toBe(40);
  });
});

describe('halt thresholds', () => {
  it('halts after three failures in a row', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory(initial, new Set(['k010', 'k011', 'k012']));
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('halted');
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.applied, s.failed, s.phase]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 10, 3, 'writing']);
    expect(out.summary).not.toContain(MARK);
  });

  it('halts once more than 5 % failed, scattered', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const fail = new Set(['k005', 'k015', 'k025', 'k035', 'k045', 'k055', 'k065']);
    const { writer } = memory(initial, fail);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('halted');
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failed]).toEqual([BULK_HALT_REASONS.failureRate, 6]);
  });

  it('under the thresholds the run finishes with its failures counted', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory(initial, new Set(['k050']));
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    expect([ledger.getStatus(runId)!.applied, ledger.getStatus(runId)!.failed]).toEqual([99, 1]);
  });

  it('resume retries failed targets', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const fail = new Set(['k010', 'k011', 'k012']);
    const { writer, state } = memory(initial, fail);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    fail.clear();
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    expect([...state.values()].every((v) => v.startsWith('w'))).toBe(true);
  });
});

describe('undo — a second approval, its own run (§7 d)', () => {
  it('after a full run restores every changed file and removes every created one', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));

    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect([undo.status.kind, undo.status.sourceRunId, undo.status.phase]).toEqual(['undo', runId, 'previewed']);
    expect(undo.status.changes).toMatchObject({ update: 140, delete: 70 });
    // Planning an undo writes nothing; it needs its own approval.
    expect(readFileSync(join(ws, 'pages/p000.md'), 'utf-8')).toBe('new 0\n');
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(workspaceWriter()))).status).toBe('refused');
    approve(undo.status.id);
    expect(new TriggerStore(engineDb).getById(`bulk-${undo.status.id}`)?.effect).toBe('bulk_undo');
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(workspaceWriter()))).status).toBe('done');

    for (let i = 0; i < 210; i++) {
      const p = join(ws, `pages/p${String(i).padStart(3, '0')}.md`);
      if (i < 140) expect(readFileSync(p, 'utf-8')).toBe(`old ${String(i)}\n${MARK}\n`);
      else expect(existsSync(p)).toBe(false);
    }
    expect(ledger.getStatus(runId)!.phase).toBe('undone');
    expect(ledger.getStatus(runId)!.undone).toBe(210);
    // Nothing left to take back.
    expect(ledger.planUndo(runId)).toEqual({ ok: false, reason: 'not_undoable' });
  });

  it('after a halt at 80 % takes back exactly the applied targets', async () => {
    const { runId, initial } = recordMemoryRun(10);
    approve(runId, { maxTargets: 8 });
    const { writer, state } = memory(initial);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect([...state.values()]).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'v8', 'v9']);

    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(undo.status.total).toBe(8);
    approve(undo.status.id);
    const order: string[] = [];
    const tracking: TargetWriter = { read: (k) => writer.read(k), write: async (k, a) => { order.push(k); return writer.write(k, a); } };
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(tracking))).status).toBe('done');
    expect([...state.values()]).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
    // Reverse order (§3.5).
    expect(order).toEqual(['k007', 'k006', 'k005', 'k004', 'k003', 'k002', 'k001', 'k000']);
  });

  it('refuses to plan an undo of a run still writing', async () => {
    const { runId } = recordMemoryRun(3);
    approve(runId);
    expect(ledger.planUndo(runId)).toEqual({ ok: false, reason: 'not_undoable' });
  });

  it('an undo of the undo re-applies the run', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId);
    const { writer, state } = memory(initial);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer));
    const redo = ledger.planUndo(undo.status.id);
    if (!redo.ok) throw new Error(redo.reason);
    approve(redo.status.id);
    expect((await runBulkEffect(redo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('done');
    expect([...state.values()]).toEqual(['w0', 'w1', 'w2']);
  });
});

describe('conflicts — shown, not overwritten (§7 h)', () => {
  it('an undo leaves a file someone changed after the run and restores the rest', async () => {
    const rows = seedFiles();
    const runId = await planFiles(rows);
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    writeFileSync(join(ws, 'pages/p003.md'), 'edited by someone else\n');
    rmSync(join(ws, 'pages/p150.md'));

    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(workspaceWriter()))).status).toBe('done');
    expect(readFileSync(join(ws, 'pages/p003.md'), 'utf-8')).toBe('edited by someone else\n');
    expect(readFileSync(join(ws, 'pages/p004.md'), 'utf-8')).toBe(`old 4\n${MARK}\n`);
    // p150 was created by the run and deleted since: it already holds the undo's end
    // state, so it counts as taken back, not as a conflict. p003 is the one conflict.
    expect(existsSync(join(ws, 'pages/p150.md'))).toBe(false);
    const s = ledger.getStatus(undo.status.id)!;
    expect([s.conflicts, s.applied, s.failed]).toEqual([1, 209, 0]);
    // The source is not fully undone while one of its targets still stands.
    expect(ledger.getStatus(runId)!.phase).toBe('done');
  });

  it('a file changed between approval and apply is a conflict, not overwritten', async () => {
    writeFileSync(join(ws, 'a.txt'), 'planned-before');
    writeFileSync(join(ws, 'b.txt'), 'b-before');
    const runId = await planFiles([{ target: 'a.txt', after: 'A' }, { target: 'b.txt', after: 'B' }]);
    approve(runId);
    writeFileSync(join(ws, 'a.txt'), 'changed meanwhile');
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('changed meanwhile');
    expect(readFileSync(join(ws, 'b.txt'), 'utf-8')).toBe('B');
    expect(ledger.getStatus(runId)!.conflicts).toBe(1);
  });
});

describe('atomic runs (§3.1, decided 30.9.)', () => {
  it('a failing target rolls back what was written and aborts; undo is refused', async () => {
    const { runId, initial } = recordMemoryRun(10, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial, new Set(['k006']));
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('aborted');
    expect([...state.values()]).toEqual(Object.values(initial));
    const s = ledger.getStatus(runId)!;
    expect([s.phase, s.haltReason, s.undone]).toEqual(['aborted', BULK_HALT_REASONS.atomicRolledBack, 6]);
    expect(ledger.planUndo(runId)).toEqual({ ok: false, reason: 'atomic_partial' });
    // Its trigger firing again (a restart, a model re-arming the task) writes nothing:
    // an aborted run is not approved any more.
    const refire = await runBulkEffect(runId, 'bulk_apply', effectDeps(memory(initial).writer));
    expect(refire.status).toBe('refused');
    const again = memory(initial);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(again.writer));
    expect([...again.state.values()]).toEqual(Object.values(initial));
  });

  it('a conflict also rolls an atomic run back', async () => {
    const { runId, initial } = recordMemoryRun(4, { atomic: true });
    approve(runId);
    const { writer, state } = memory({ ...initial, k002: 'someone else' });
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('aborted');
    expect([...state.values()]).toEqual(['v0', 'v1', 'someone else', 'v3']);
  });

  it('a rollback that finds a target changed says so', async () => {
    const { runId, initial } = recordMemoryRun(4, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial, new Set(['k003']));
    const sneaky: TargetWriter = {
      read: (k) => writer.read(k),
      write: async (k, a) => {
        const r = await writer.write(k, a);
        if (k === 'k002') state.set('k000', 'touched');
        return r;
      },
    };
    await runBulkEffect(runId, 'bulk_apply', effectDeps(sneaky));
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.atomicRollbackIncomplete);
    expect(state.get('k000')).toBe('touched');
  });

  it('a fully applied atomic run is undone whole', async () => {
    const { runId, initial } = recordMemoryRun(5, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(undo.status.atomic).toBe(true);
    approve(undo.status.id);
    await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer));
    expect([...state.values()]).toEqual(Object.values(initial));
  });
});

describe('workspace writes stay in the file area (A-review obligation)', () => {
  it('a directory swapped for a symlink after planning is path_changed; nothing lands outside', async () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'inside');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'f.txt'), 'outside-original');
    const runId = await planFiles([{ target: 'sub/f.txt', after: 'written' }]);
    approve(runId);
    rmSync(join(ws, 'sub'), { recursive: true });
    symlinkSync(outside, join(ws, 'sub'));
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    expect(readFileSync(join(outside, 'f.txt'), 'utf-8')).toBe('outside-original');
    expect(ledger.getStatus(runId)!.failed).toBe(1);
    expect(ledger.getPreview(runId)[0]!.error).toBe('path_changed');
  });

  it('a symlink planted at the leaf is not followed', async () => {
    writeFileSync(join(ws, 'leaf.txt'), 'before');
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'before');
    const runId = await planFiles([{ target: 'leaf.txt', after: 'written' }]);
    approve(runId);
    rmSync(join(ws, 'leaf.txt'));
    symlinkSync(secret, join(ws, 'leaf.txt'));
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    expect(readFileSync(secret, 'utf-8')).toBe('before');
    // The key no longer resolves to itself (its real path is the link's target), so the
    // target is refused before anything is read — and the link is left as it is.
    const { lstatSync } = await import('node:fs');
    expect(lstatSync(join(ws, 'leaf.txt')).isSymbolicLink()).toBe(true);
    expect(ledger.getPreview(runId)[0]!.error).toBe('path_changed');
  });

  it('creates missing directories inside the area and keeps an existing file\'s mode', async () => {
    writeFileSync(join(ws, 'x.sh'), 'old', { mode: 0o750 });
    const runId = await planFiles([{ target: 'x.sh', after: 'new' }, { target: 'deep/er/n.txt', after: 'n' }]);
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(workspaceWriter()));
    expect(readFileSync(join(ws, 'deep/er/n.txt'), 'utf-8')).toBe('n');
    const { statSync } = await import('node:fs');
    expect(statSync(join(ws, 'x.sh')).mode & 0o777).toBe(0o750);
  });
});

describe('data-store runs', () => {
  function seedStore(): void {
    store.createCollection({
      name: 'products', scope, uniqueKey: ['sku'],
      columns: [
        { name: 'sku', type: 'string' }, { name: 'price', type: 'number' },
        { name: 'owner', type: 'subject', subjectKind: 'person' },
      ],
    });
    const records = [];
    for (let i = 0; i < 150; i++) records.push({ sku: `S${String(i)}`, price: i, owner: `subj-${String(i)}` });
    store.insertRecords({ collection: 'products', records });
  }

  it('applies 210 rows, keeps subject cells verbatim, and the undo restores and removes', async () => {
    seedStore();
    // Resolving a subject cell as a name would create a subject — must never happen.
    const resolve = vi.fn(() => { throw new Error('resolved a subject cell'); });
    store.setSubjectBridge({ resolve, findAll: () => [], name: () => null });
    const rows = [];
    for (let i = 0; i < 210; i++) rows.push({ target: `S${String(i)}`, price: 1000 + i });
    writeFileSync(join(ws, 'prices.json'), JSON.stringify(rows));
    const runId = runIdOf(await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_file: 'prices.json' }, agent()));
    approve(runId);
    const writerFor = (run: Parameters<typeof bulkWriterFor>[0]) => bulkWriterFor(run, store);
    expect((await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor })).status).toBe('done');

    const all = store.queryRecords({ collection: 'products', limit: 500 }).rows;
    expect(all).toHaveLength(210);
    const s7 = all.find((r) => r['sku'] === 'S7')!;
    expect([s7['price'], s7['owner']]).toEqual([1007, 'subj-7']);
    expect(all.find((r) => r['sku'] === 'S200')!['owner']).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, writerFor })).status).toBe('done');
    const back = store.queryRecords({ collection: 'products', limit: 500 }).rows;
    expect(back).toHaveLength(150);
    expect(back.find((r) => r['sku'] === 'S7')).toMatchObject({ price: 7, owner: 'subj-7' });
    expect(resolve).not.toHaveBeenCalled();
    expect(store.getCollectionInfo('products')!.recordCount).toBe(150);
  });

  it('a data-store run whose collection is gone halts as unavailable', async () => {
    seedStore();
    writeFileSync(join(ws, 'p.json'), JSON.stringify([{ target: 'S1', price: 5 }]));
    const runId = runIdOf(await bulkPlanTool.handler(
      { target_system: 'data_store', target_collection: 'products', source_file: 'p.json' }, agent()));
    approve(runId);
    store.dropCollection('products');
    const out = await runBulkEffect(runId, 'bulk_apply', { ledger, writerFor: (run) => bulkWriterFor(run, store) });
    expect(out.status).toBe('refused');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
  });
});
