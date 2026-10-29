import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineDb } from './engine-db.js';
import { DataStore } from './data-store.js';
import { BulkLedger, BULK_CLAIM_STALE_MS, BULK_HALT_REASONS, bulkFailureLimit } from './bulk-ledger.js';
import type { PlannedTarget } from './bulk-ledger.js';
import { BulkSecretError, bulkWriterFor, runBulkEffect, workspaceWriter, type BulkRunTrail, type TargetWriter } from './bulk-apply.js';
import { TriggerStore } from './trigger-store.js';
import { deriveSourceEffect } from './task-manager.js';
import { WorkerLoop } from './worker-loop.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { bulkPlanTool, bulkStatusTool } from '../tools/builtin/bulk.js';
import { taskListTool } from '../tools/builtin/task.js';
import { recallToolResultTool } from '../tools/builtin/recall-tool-result.js';
import { ToolResultBlobStore } from './tool-result-blob-store.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { IAgent, MemoryScopeRef, TriggerRecord } from '../types/index.js';
import { TEST_STAMP } from '../../tests/helpers/row-stamp.js';

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
  return { toolContext: { bulkLedger: ledger, dataStore: store }, currentThreadId: 'thread-1', principal: OWNER_PRINCIPAL } as unknown as IAgent;
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
  const s = ledger.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets, atomic: opts.atomic });
  return { runId: s.id, initial };
}

const effectDeps = (writer: TargetWriter, now?: () => number) => ({ ledger, trailFor: () => null, writerFor: () => writer, ...(now ? { now } : {}) });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-apply-')));
  ws = join(dir, 'workspace');
  mkdirSync(ws);
  setTenantWorkspace(ws);
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  ledger = new BulkLedger(engineDb, null);
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
        claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers),
        getTrigger: (id: string) => triggers.getById(id),
        recordTaskRun,
      }),
      getToolContext: () => ({ containment: null }),
      getBulkLedger: () => ledger,
      getDataStore: () => store,
      getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
      getUserConfig: () => ({}),
      getEngineDb: () => null,
      getMandateEnds: () => null,
    } as unknown as Engine;
    const router = { hasChannels: () => true, notify } as unknown as NotificationRouter;
    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 25_000 });

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
      getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
        claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers), recordTaskRun }),
      getToolContext: () => ({ containment: null }),
      getBulkLedger: () => ledger,
      getDataStore: () => store,
      getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
      getUserConfig: () => ({}),
      getEngineDb: () => null,
      getMandateEnds: () => null,
    } as unknown as Engine;
    // The in-memory targets need an in-memory writer: route the run to one.
    const { writer } = memory({ k000: 'v0', k001: 'v1' });
    const mod = await import('./bulk-apply.js');
    const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
    try {
      const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
      const before = Date.now();
      await loop.tick();
      await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
      await vi.waitFor(() => expect(triggers.getById(`bulk-${runId}`)!.status).toBe('open'), { timeout: 10_000 });
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
      getTaskManager: () => ({ getDueTriggers: () => [task], getExpiredWaitingTriggers: () => [], endWait: () => false,
        claimLease: () => 'claimed', renewLease: () => true, releaseLease: () => {}, recordTaskRun }),
      getToolContext: () => ({ containment: null }),
      getBulkLedger: () => null,
      getUserConfig: () => ({}),
      getEngineDb: () => null,
      getMandateEnds: () => null,
    } as unknown as Engine;
    const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: vi.fn() } as unknown as NotificationRouter, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalledWith('bulk-x', expect.stringContaining('not available'), 'failed'), { timeout: 10_000 });
  });
});

/** Run one tick of a real WorkerLoop over a memory run; returns what it recorded and announced. */
async function tickMemoryRun(runId: string, writer: TargetWriter): Promise<{ status: string; notes: Array<{ title: string; priority: string }> }> {
  const triggers = new TriggerStore(engineDb);
  const recordTaskRun = vi.fn((_id: string, _r: string, _status: string) => false);
  const notify = vi.fn(async (_n: { title: string; priority: string }) => {});
  const engine = {
    getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
      claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers), recordTaskRun }),
    getToolContext: () => ({ containment: null }),
    getBulkLedger: () => ledger,
    getDataStore: () => store,
    getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
    getUserConfig: () => ({}),
    getEngineDb: () => null,
    getMandateEnds: () => null,
  } as unknown as Engine;
  const mod = await import('./bulk-apply.js');
  const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
  try {
    const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled(), { timeout: 10_000 });
  } finally {
    spy.mockRestore();
  }
  expect(recordTaskRun).toHaveBeenCalledTimes(1);
  return { status: recordTaskRun.mock.calls[0]![2], notes: notify.mock.calls.map((c) => c[0]) };
}

// A run that stops at its approved maximum did what it was told and waits for the owner. As
// `failed` with a high-priority ✗ it was a failure the owner learned to read past — right
// next to the real ones, which a failure halt still is.
describe('a planned halt is not a failure', () => {
  it('a run at its approved maximum is recorded `halted` and announced without ✗, at normal priority', async () => {
    const { runId, initial } = recordMemoryRun(4);
    approve(runId, { maxTargets: 2 });
    const out = await tickMemoryRun(runId, memory(initial).writer);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.maxTargets);
    expect(out.status).toBe('halted');
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.priority).toBe('normal');
    expect(out.notes[0]!.title.startsWith('\u23F8 ')).toBe(true);
  });

  it('a failure halt is still recorded `failed` and announced with ✗ at high priority', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const out = await tickMemoryRun(runId, memory(initial, new Set(['k010', 'k011', 'k012'])).writer);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.consecutiveFailures);
    expect(out.status).toBe('failed');
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.priority).toBe('high');
    expect(out.notes[0]!.title.startsWith('\u2717 ')).toBe(true);
  });
});

describe('the effect can only come from the approval (§7 b, the derivation property)', () => {
  // MUTATION: map any task_type onto `bulk_apply` in deriveSourceEffect → this fails.
  it('no create-path intent derives a bulk effect', () => {
    const intents = ['bulk_apply', 'bulk_undo', 'bulk_preview', 'bulk', 'backup', 'reminder', 'pipeline', 'watch', 'manual', '', 'run_agent'];
    for (const taskType of intents) {
      for (const extra of [{}, { scheduleCron: '0 9 * * *' }, { pipelineId: 'wf' }, { watchConfig: '{}' }]) {
        const { effect } = deriveSourceEffect({ taskType, ...extra });
        expect(effect.startsWith('bulk_'), `${taskType} ${JSON.stringify(extra)}`).toBe(false);
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
    // Refused by the phase check itself — the expiry check would halt it instead.
    expect(ledger.getStatus(runId)!.haltReason).toBeNull();
  });

  it('refuses an effect that does not match the run kind', async () => {
    const { runId } = recordMemoryRun(2);
    approve(runId);
    const { writer, state } = memory({ k000: 'v0', k001: 'v1' });
    expect((await runBulkEffect(runId, 'bulk_undo', effectDeps(writer))).status).toBe('refused');
    expect(state.get('k000')).toBe('v0');
    // And the other way round: an undo run fired as bulk_apply.
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    expect((await runBulkEffect(undo.status.id, 'bulk_apply', effectDeps(writer))).status).toBe('refused');
    expect(state.get('k000')).toBe('w0');
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
    // The run did what its approval said: a planned halt, which the trigger records as one.
    expect(out.planned).toBe(true);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.maxTargets);
    expect([...state.values()].filter((v) => v.startsWith('w'))).toHaveLength(3);
  });

  it('counts a write that failed against the approved maximum: it may have reached its target', async () => {
    const { runId, initial } = recordMemoryRun(25);
    approve(runId, { maxTargets: 3 });
    const mem = memory(initial, new Set(['k000']));
    const { writer, writes } = counting(mem.writer);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('halted');
    // Under the failure thresholds, yet a write failed: not the planned halt, a failure the
    // owner must see.
    expect(out.planned).toBeUndefined();
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.maxTargets);
    expect([...writes.keys()]).toEqual(['k000', 'k001', 'k002']);
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
    ledger = new BulkLedger(engineDb, null);
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

  it('an undo takes back a target a dead loop of the run wrote, not one someone else set', async () => {
    // Written by a loop of this run that died before recording it: the target is marked sent.
    const sent = recordMemoryRun(3);
    approve(sent.runId);
    const one = memory(sent.initial);
    ledger.markSent(sent.runId, 1);
    one.state.set('k001', 'w1');
    expect((await runBulkEffect(sent.runId, 'bulk_apply', effectDeps(one.writer))).status).toBe('done');
    expect(ledger.countUndoable(sent.runId)).toBe(3);
    // Set by someone else: never sent to, so the run changed nothing there.
    const other = recordMemoryRun(3);
    approve(other.runId);
    const two = memory(other.initial);
    two.state.set('k001', 'w1');
    expect((await runBulkEffect(other.runId, 'bulk_apply', effectDeps(two.writer))).status).toBe('done');
    expect(ledger.countUndoable(other.runId)).toBe(2);
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
    // The message carries both outcomes, so a failure names the status it saw.
    const outcomes = JSON.stringify([a, b]);
    expect([a.status, b.status].every((st) => st === 'done' || st === 'pending'), outcomes).toBe(true);
    expect([a.status, b.status]).toContain('done');
    expect(writes.size).toBe(210);
    expect([...writes.entries()].filter(([, c]) => c !== 1)).toEqual([]);
    expect(ledger.getStatus(runId)!.applied).toBe(210);
    expect(ledger.getStatus(runId)!.phase).toBe('done');
  });

  // The interleaving above, forced: while this loop writes its first target, a second loop
  // writes and records the rest, so the approved maximum (here the default: every target)
  // is reached with targets still on this loop's stale list.
  it('a run finished by another loop at the approved maximum closes as done, not halted', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId);
    const { writer: inner, state } = memory(initial);
    const writer: TargetWriter = {
      read: (key) => inner.read(key),
      async write(key, after) {
        if (key === 'k000') {
          for (const seq of [1, 2]) {
            expect(ledger.claimTarget(runId, seq, Date.now())).toBe(true);
            state.set(`k00${String(seq)}`, `w${String(seq)}`);
            ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, seq, 'ok');
          }
        }
        return inner.write(key, after);
      },
    };
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status, JSON.stringify(out)).toBe('done');
    expect(ledger.getStatus(runId)!.haltReason).toBeNull();
    expect(ledger.getStatus(runId)!.phase).toBe('done');
    expect(ledger.getStatus(runId)!.applied).toBe(3);
  });

  // As above, but the other loop leaves a target it never sent to (a conflict) on this loop's
  // stale list, which the maximum then makes this loop pass over.
  // MUTATION: halt on the maximum without first asking whether `listPending(...)` still holds
  // a target → a fully recorded run ends halted instead of done.
  it('a run another loop finished closes as done even when this loop passed a target over at the maximum', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId, { maxTargets: 2 });
    const { writer: inner } = memory(initial);
    const writer: TargetWriter = {
      read: (key) => inner.read(key),
      async write(key, after) {
        if (key === 'k000') {
          expect(ledger.claimTarget(runId, 1, Date.now())).toBe(true);
          ledger.recordFailed(runId, 1, 'conflict');
          expect(ledger.claimTarget(runId, 2, Date.now())).toBe(true);
          ledger.recordApplied({ id: runId, kind: 'apply', sourceRunId: null }, 2, 'ok');
        }
        return inner.write(key, after);
      },
    };
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status, JSON.stringify(out)).toBe('done');
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', haltReason: null, applied: 2 });
  });
});

describe('the owner view', () => {
  it('serves at most 500 targets per page', () => {
    const { runId } = recordMemoryRun(501);
    expect(ledger.getPreview(runId, { limit: 5000 })).toHaveLength(500);
    expect(ledger.getPreview(runId, { offset: 500 })).toHaveLength(1);
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

/**
 * The owner's stop of a running write, driven through a REAL worker tick: the dispatch that
 * hands the signal over, `stopTask`, the loop's check between targets and the run record.
 * The writer holds target `holdAt` open until released, so the stop arrives while that
 * target is being written — the case the stop must not cut through.
 */
async function stopMidWrite(n: number, holdAt: string, opts: { atomic?: boolean; shutdown?: boolean; heldElsewhere?: number } = {}): Promise<{
  runId: string; state: Map<string, string>; writes: Map<string, number>; writer: TargetWriter;
  records: Array<[string, string, string]>; notified: number; stopAnswer: unknown;
}> {
  const { runId, initial } = recordMemoryRun(n, opts);
  approve(runId);
  // A target a loop that died still holds by a fresh claim: this loop passes it over.
  if (opts.heldElsewhere !== undefined) expect(ledger.claimTarget(runId, opts.heldElsewhere)).toBe(true);
  const { writer: inner, state } = memory(initial);
  const { writer: counted, writes } = counting(inner);
  let entered!: () => void;
  const inWrite = new Promise<void>((r) => { entered = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = false;
  const writer: TargetWriter = {
    read: (k, f) => counted.read(k, f),
    async write(key, after, sent) {
      if (key === holdAt && !held) {
        held = true;
        entered();
        await gate;
      }
      return counted.write(key, after, sent);
    },
  };
  const triggers = new TriggerStore(engineDb);
  const records: Array<[string, string, string]> = [];
  const recordTaskRun = vi.fn((id: string, result: string, status: string) => {
    records.push([id, result, status]);
    triggers.updateFields(id, { status: status === 'success' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed', nextRunAt: null });
  });
  const engine = {
    getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
      claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers), recordTaskRun }),
    getToolContext: () => ({ containment: null }),
    getBulkLedger: () => ledger,
    getDataStore: () => store,
    getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
    getUserConfig: () => ({}),
    getEngineDb: () => null,
    getMandateEnds: () => null,
  } as unknown as Engine;
  const notify = vi.fn(async () => {});
  const mod = await import('./bulk-apply.js');
  const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
  try {
    const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
    await loop.tick();
    await inWrite;
    const stopAnswer = opts.shutdown === true ? (loop.stop(), null) : loop.stopTask(`bulk-${runId}`);
    release();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 10_000 });
    return { runId, state, writes, writer: counted, records, notified: notify.mock.calls.length, stopAnswer };
  } finally {
    release();
    spy.mockRestore();
  }
}

/**
 * Bulk runs switched OFF while a run waits between two ticks: `stopBulkTasks` cannot reach
 * it, because nothing is running.
 * Its trigger then fires on an engine whose live ledger is null. Driven through a REAL worker
 * tick on the real ledger: the tick must end the run as the owner's stop would, and write
 * nothing — not skip it and leave it unhalted with its trigger spent.
 */
async function tickWhileOff(n: number, opts: { atomic?: boolean; heldElsewhere?: number } = {}): Promise<{
  runId: string; state: Map<string, string>; writes: Map<string, number>; records: Array<[string, string, string]>;
}> {
  const { runId, initial } = recordMemoryRun(n, opts);
  approve(runId);
  if (opts.heldElsewhere !== undefined) expect(ledger.claimTarget(runId, opts.heldElsewhere)).toBe(true);
  const { writer: inner, state } = memory(initial);
  const { writer, writes } = counting(inner);
  const triggers = new TriggerStore(engineDb);
  const records: Array<[string, string, string]> = [];
  const recordTaskRun = vi.fn((id: string, result: string, status: string) => {
    records.push([id, result, status]);
    triggers.updateFields(id, { status: status === 'success' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed', nextRunAt: null });
  });
  let on = true;
  const engine = {
    getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
      claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers), recordTaskRun }),
    getToolContext: () => ({ containment: null }),
    getBulkLedger: () => (on ? ledger : null),
    getBulkLedgerSwitchedOff: () => (on ? null : ledger),
    getDataStore: () => store,
    getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
    getUserConfig: () => ({}),
    getEngineDb: () => null,
    getMandateEnds: () => null,
  } as unknown as Engine;
  const mod = await import('./bulk-apply.js');
  const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
  try {
    const loop = new WorkerLoop(engine, { hasChannels: () => true, notify: vi.fn(async () => {}) } as unknown as NotificationRouter, 60_000);
    if (opts.heldElsewhere !== undefined) {
      // One tick while on: it writes what it can and ends pending on the held target, re-armed.
      await loop.tick();
      await vi.waitFor(() => expect(records).toHaveLength(1), { timeout: 10_000 });
      expect(records[0]![1], 'the tick while on ended waiting on the held target').toContain('another loop holds');
      expect(triggers.getById(`bulk-${runId}`)?.status, 're-armed').toBe('open');
      triggers.updateFields(`bulk-${runId}`, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    }
    on = false;
    const before = records.length;
    await loop.tick();
    await vi.waitFor(() => expect(records.length).toBeGreaterThan(before), { timeout: 10_000 });
    return { runId, state, writes, records: records.slice(before) };
  } finally {
    spy.mockRestore();
  }
}

describe('bulk runs switched off while a run waits between ticks', () => {
  it('an approved run whose trigger fires while off is halted as stopped, nothing written', async () => {
    const out = await tickWhileOff(4);
    expect(out.writes.size, 'nothing written').toBe(0);
    const s = ledger.getStatus(out.runId)!;
    expect([s.applied, s.haltReason]).toEqual([0, BULK_HALT_REASONS.stoppedByOwner]);
    expect(out.records.map((r) => r[2])).toEqual(['stopped']);
  });

  it('an approved ATOMIC run nothing was written for is halted, not ended for good — it can be resumed', async () => {
    const out = await tickWhileOff(4, { atomic: true });
    expect(out.writes.size, 'nothing written').toBe(0);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.applied, s.haltReason]).toEqual(['writing', 0, BULK_HALT_REASONS.stoppedByOwner]);
    expect(out.records.map((r) => r[2])).toEqual(['stopped']);
    // Resumable: once on again, the run writes all of it.
    expect(ledger.resume(out.runId, { checksum: ledger.computeChecksum(out.runId)! }).ok).toBe(true);
  });

  it('a half-written ATOMIC run that waited on a held target is rolled back when its tick fires while off', async () => {
    const out = await tickWhileOff(3, { atomic: true, heldElsewhere: 0 });
    // The tick while on wrote k001 and k002; the one while off took them back.
    expect([...out.state.values()]).toEqual(['v0', 'v1', 'v2']);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.haltReason]).toEqual(['aborted', BULK_HALT_REASONS.atomicStoppedRolledBack]);
    expect(out.records.map((r) => r[2])).toEqual(['stopped']);
  });
});

describe('the owner stops a running write — between targets, never inside one', () => {
  it('a stop during the write of target k leaves k written and recorded; k+1 is not written', async () => {
    const out = await stopMidWrite(10, 'k003');
    expect(out.stopAnswer).toEqual({ kind: 'requested', via: 'signal' });
    expect([...out.state.values()]).toEqual(['w0', 'w1', 'w2', 'w3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.applied, s.failed, s.haltReason]).toEqual(['writing', 4, 0, BULK_HALT_REASONS.stoppedByOwner]);
    // Recorded as the owner's stop — no failure, no retry — and the record names the count.
    expect(out.records).toHaveLength(1);
    expect(out.records[0]![2]).toBe('stopped');
    expect(out.records[0]![1]).toContain('Applied 4,');
    expect(out.records[0]![1]).toContain(BULK_HALT_REASONS.stoppedByOwner);
    expect(out.notified, 'the owner asked; nobody is notified of it').toBe(0);
  });

  it('after the stop, an undo takes back exactly the targets written', async () => {
    const out = await stopMidWrite(10, 'k003');
    const undo = ledger.planUndo(out.runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(undo.status.total).toBe(4);
    approve(undo.status.id);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(out.writer))).status).toBe('done');
    expect([...out.state.values()]).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });

  it('a resume after the stop writes the rest, none of them twice', async () => {
    const out = await stopMidWrite(10, 'k003');
    expect(ledger.resume(out.runId, { checksum: ledger.computeChecksum(out.runId)! }).ok).toBe(true);
    expect((await runBulkEffect(out.runId, 'bulk_apply', effectDeps(out.writer))).status).toBe('done');
    expect([...out.state.values()].every((v) => v.startsWith('w'))).toBe(true);
    expect([...out.writes.values()].every((c) => c === 1), JSON.stringify([...out.writes])).toBe(true);
    expect(out.writes.size).toBe(10);
  });

  it('a stopped atomic run rolls back, with a reason that says it was stopped', async () => {
    const out = await stopMidWrite(6, 'k002', { atomic: true });
    expect([...out.state.values()]).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.haltReason]).toEqual(['aborted', BULK_HALT_REASONS.atomicStoppedRolledBack]);
    expect(out.records[0]![2]).toBe('stopped');
    expect(out.records[0]![1]).toContain('stopped and rolled back');
  });

  it('a stop on the last target this loop can write is not lost to the pending re-arm', async () => {
    // The rest is held by another loop: the loop ends `pending`, which re-arms the trigger.
    // Re-armed after a stop, the next tick would write on behind the owner's 202.
    // The held target comes FIRST, so the stop lands on the loop's last pass: no check
    // between targets is left to read it, and the loop ends on the pending branch.
    const out = await stopMidWrite(2, 'k001', { heldElsewhere: 0 });
    expect(out.stopAnswer).toEqual({ kind: 'requested', via: 'signal' });
    const s = ledger.getStatus(out.runId)!;
    expect([s.applied, s.haltReason]).toEqual([1, BULK_HALT_REASONS.stoppedByOwner]);
    expect(out.records[0]![2]).toBe('stopped');
    const t = new TriggerStore(engineDb).getById(`bulk-${out.runId}`)!;
    expect([t.status, t.next_run_at ?? null], 'nothing re-armed').toEqual(['stopped', null]);
  });

  it('a stopped ATOMIC run on its pending branch rolls back, not left half written', async () => {
    const out = await stopMidWrite(3, 'k002', { atomic: true, heldElsewhere: 0 });
    expect([out.state.get('k001'), out.state.get('k002')]).toEqual(['v1', 'v2']);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.haltReason]).toEqual(['aborted', BULK_HALT_REASONS.atomicStoppedRolledBack]);
    expect(out.records[0]![2]).toBe('stopped');
  });

  it('a shutdown during a write is not the owner\'s stop: the run writes on', async () => {
    const out = await stopMidWrite(6, 'k002', { shutdown: true });
    expect([...out.state.values()].every((v) => v.startsWith('w'))).toBe(true);
    const s = ledger.getStatus(out.runId)!;
    expect([s.phase, s.haltReason]).toEqual(['done', null]);
    expect(out.records[0]![2]).toBe('success');
  });
});

describe('halt thresholds', () => {
  it('halts after three failures in a row', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory(initial, new Set(['k010', 'k011', 'k012']));
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(out.status).toBe('halted');
    // A failure halt is not a planned one: it stays a failure for the owner.
    expect(out.planned).toBeUndefined();
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.applied, s.failed, s.phase]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 10, 3, 'writing']);
    expect(out.summary).not.toContain(MARK);
  });

  it('counts the targets failed now: after a resume and a second pass the counts never add up past the run', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const fail = new Set(['k005', 'k015', 'k025', 'k035', 'k045', 'k055', 'k065']);
    const { writer } = memory(initial, fail);
    const halted = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(halted.status).toBe('halted');
    expect(ledger.getStatus(runId)).toMatchObject({ haltReason: BULK_HALT_REASONS.failureRate, failed: 6 });
    expect(halted.summary).toContain('failed 6,');
    // What the resume button shows: six failed so far; five may fail in the next pass and the
    // sixth halts it; the fifty not written are what it tries.
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 50, failedOnce: 6, failureLimit: 5, resumeOpen: 50, resumeTries: 50 });
    // The six now write; three later targets fail. Three of 100 is under 5 % for this pass —
    // the halt counts per pass — so the run finishes.
    fail.clear();
    for (const k of ['k070', 'k080', 'k090']) fail.add(k);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    const done = await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(done.status).toBe('done');
    const s = ledger.getStatus(runId)!;
    expect([s.phase, s.applied, s.conflicts, s.failed]).toEqual(['done', 97, 0, 3]);
    // Over both passes: the six of the first, written since, and the three of the second.
    expect(s.failedOnce).toBe(9);
    expect(s.applied + s.conflicts + s.failed).toBeLessThanOrEqual(s.total);
    // The notice after the run and what the model reads say the same count.
    expect(done.summary).toContain('Applied 97, failed 3, conflicts 0');
    expect(await bulkStatusTool.handler({ run_id: runId }, agent())).toContain('Applied 97, failed 3, conflicts 0, undone 0.');
  });

  it('a written target is not counted failed, whatever a loop that lost its claim recorded on it', async () => {
    const { runId, initial } = recordMemoryRun(10);
    approve(runId);
    const { writer } = memory(initial, new Set());
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    // A second loop past a stale claim can record a failure on a target the first one wrote.
    engineDb.getDb().prepare("UPDATE bulk_targets SET error = 'write_failed' WHERE run_id = ? AND seq = 0").run(runId);
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 10, failed: 0 });
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

  it('a conflict breaks a run of failures', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory({ ...initial, k011: 'someone else' }, new Set(['k010', 'k012', 'k013']));
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failed, s.conflicts, s.applied]).toEqual([null, 3, 1, 96]);
    expect(s.failedOnce, 'a conflict is not a failure').toBe(3);
  });

  it('the failure limit the status shows is the one the halt keeps', async () => {
    // 60 × 0.05 is exactly 3: three may fail, the fourth halts.
    expect(bulkFailureLimit(60)).toBe(3);
    const scattered = ['k005', 'k020', 'k035', 'k050'];
    const under = recordMemoryRun(60);
    approve(under.runId);
    const three = await runBulkEffect(under.runId, 'bulk_apply', effectDeps(memory(under.initial, new Set(scattered.slice(0, 3))).writer));
    expect([three.status, ledger.getStatus(under.runId)!.failureLimit, ledger.getStatus(under.runId)!.failed]).toEqual(['done', 3, 3]);
    const over = recordMemoryRun(60);
    approve(over.runId);
    expect((await runBulkEffect(over.runId, 'bulk_apply', effectDeps(memory(over.initial, new Set(scattered)).writer))).status).toBe('halted');
    const s = ledger.getStatus(over.runId)!;
    expect([s.haltReason, s.failed]).toEqual([BULK_HALT_REASONS.failureRate, s.failureLimit + 1]);
    // 30 × 0.05 is 1.5: one may fail, the second halts — rounded, the status would say two.
    const half = recordMemoryRun(30);
    approve(half.runId);
    await runBulkEffect(half.runId, 'bulk_apply', effectDeps(memory(half.initial, new Set(['k005', 'k020'])).writer));
    expect(ledger.getStatus(half.runId)).toMatchObject({ haltReason: BULK_HALT_REASONS.failureRate, failed: 2, failureLimit: 1 });
  });

  it('a run approved before failures were recorded per target has no total', async () => {
    const { runId, initial } = recordMemoryRun(20);
    approve(runId);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(memory(initial, new Set(['k004'])).writer))).status).toBe('done');
    expect(ledger.getStatus(runId)!.failedOnce).toBe(1);
    // As the migration leaves an approved run: unknown on its targets.
    engineDb.getDb().prepare('UPDATE bulk_targets SET failed_once = NULL WHERE run_id = ? AND seq = 4').run(runId);
    expect(ledger.getStatus(runId)!.failedOnce).toBeNull();
    // One failure recorded now does not make the earlier passes known.
    // k004 is still to write, so the record lands.
    ledger.recordFailed(runId, 4, 'write_failed');
    expect(engineDb.getDb().prepare('SELECT failed_once AS f FROM bulk_targets WHERE run_id = ? AND seq = 4').get(runId)).toEqual({ f: null });
    expect(ledger.getStatus(runId)!.failedOnce).toBeNull();
  });

  it('resume arms the trigger again, after a halt ended it', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory(initial, new Set(['k010', 'k011', 'k012']));
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    const triggers = new TriggerStore(engineDb);
    // What the worker's run record does to a one-shot trigger that failed.
    triggers.updateFields(`bulk-${runId}`, { status: 'failed', nextRunAt: null });
    expect(triggers.getDue()).toEqual([]);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    expect(triggers.getDue().map((t) => [t.id, t.effect])).toEqual([[`bulk-${runId}`, 'bulk_apply']]);
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

describe('a run and an undo of it never write at the same time', () => {
  /** Four targets, halted after two at the approved maximum. */
  async function halfWritten(): Promise<{ runId: string; state: Map<string, string>; writer: TargetWriter }> {
    const { runId, initial } = recordMemoryRun(4);
    approve(runId, { maxTargets: 2 });
    const { writer, state } = memory(initial);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('halted');
    return { runId, state, writer };
  }
  const resumeAll = (runId: string) => ledger.resume(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 4 });
  const approveUndo = (undoId: string) => ledger.approve(undoId, { checksum: ledger.computeChecksum(undoId)! });

  it('a run is not resumed while an undo of it is approved', async () => {
    const { runId } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(approveUndo(undo.status.id).ok).toBe(true);
    expect(resumeAll(runId)).toEqual({ ok: false, reason: 'undo_open' });
    // Refused before anything moved: the run is still halted where it stopped.
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'writing', haltReason: BULK_HALT_REASONS.maxTargets, applied: 2 });
  });

  it('a previewed undo holds nothing: the run resumes, and the undo is then refused while it writes', async () => {
    const { runId } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(resumeAll(runId).ok).toBe(true);
    expect(approveUndo(undo.status.id)).toEqual({ ok: false, reason: 'source_running' });
  });

  it('an undo planned before the run wrote more is refused as stale', async () => {
    const { runId, writer } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(undo.status.total).toBe(2);
    expect(resumeAll(runId).ok).toBe(true);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    expect(approveUndo(undo.status.id)).toEqual({ ok: false, reason: 'undo_stale' });
    expect(ledger.getStatus(runId)!.phase).toBe('done');
    expect(ledger.getStatus(undo.status.id)!.phase).toBe('previewed');
    // A fresh plan covers all four.
    const again = ledger.planUndo(runId);
    if (!again.ok) throw new Error(again.reason);
    expect(again.status.total).toBe(4);
  });

  it('a second undo is refused while the first is approved — planned or approved', async () => {
    const { runId } = await halfWritten();
    const first = ledger.planUndo(runId);
    const second = ledger.planUndo(runId);
    if (!first.ok || !second.ok) throw new Error('plan refused');
    expect(approveUndo(first.status.id).ok).toBe(true);
    expect(ledger.planUndo(runId)).toEqual({ ok: false, reason: 'undo_open' });
    expect(approveUndo(second.status.id)).toEqual({ ok: false, reason: 'undo_open' });
  });

  it('once the undo is done, the run is undone and stays that way', async () => {
    const { runId, state, writer } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(approveUndo(undo.status.id).ok).toBe(true);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('done');
    expect(ledger.getStatus(runId)!.phase).toBe('undone');
    expect([...state.values()]).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(resumeAll(runId)).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('a halted undo resumes — it does not hold itself', async () => {
    const { runId, writer, state } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)!, maxTargets: 1 }).ok).toBe(true);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('halted');
    expect(ledger.resume(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)!, maxTargets: 2 }).ok).toBe(true);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('done');
    expect([...state.values()]).toEqual(['v0', 'v1', 'v2', 'v3']);
  });

  it('an approved undo whose loop never ran resumes — its own approval does not hold it', async () => {
    const { runId } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(approveUndo(undo.status.id).ok).toBe(true);
    expect(ledger.getStatus(undo.status.id)).toMatchObject({ phase: 'approved', haltReason: null });
    expect(ledger.resume(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)! }).ok).toBe(true);
  });

  it('a halted undo holds nothing: the run resumes, and the undo then waits for it and is stale after it', async () => {
    const { runId, writer, state } = await halfWritten();
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(ledger.approve(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)!, maxTargets: 1 }).ok).toBe(true);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('halted');
    // An undo that may never be resumed must not hold its source.
    expect(resumeAll(runId).ok).toBe(true);
    const resumeUndo = () => ledger.resume(undo.status.id, { checksum: ledger.computeChecksum(undo.status.id)!, maxTargets: 2 });
    expect(resumeUndo()).toEqual({ ok: false, reason: 'source_running' });
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    expect(resumeUndo()).toEqual({ ok: false, reason: 'undo_stale' });
    // k001 was taken back by the halted undo and stays so; the run did not write it again.
    expect([...state.values()]).toEqual(['w0', 'v1', 'w2', 'w3']);
  });

  it('an undo of a run another undo already took back is refused as stale, not told the run still writes', async () => {
    const { runId, writer } = await halfWritten();
    const first = ledger.planUndo(runId);
    const second = ledger.planUndo(runId);
    if (!first.ok || !second.ok) throw new Error('plan refused');
    expect(approveUndo(first.status.id).ok).toBe(true);
    await runBulkEffect(first.status.id, 'bulk_undo', effectDeps(writer));
    expect(ledger.getStatus(runId)!.phase).toBe('undone');
    expect(approveUndo(second.status.id)).toEqual({ ok: false, reason: 'undo_stale' });
  });

  it('a halted undo waits for an undo of a sibling undo — the whole family writes one at a time', async () => {
    const { runId, writer, state } = await halfWritten();
    // U takes back one of the two, then halts.
    const u = ledger.planUndo(runId);
    if (!u.ok) throw new Error(u.reason);
    expect(ledger.approve(u.status.id, { checksum: ledger.computeChecksum(u.status.id)!, maxTargets: 1 }).ok).toBe(true);
    expect((await runBulkEffect(u.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('halted');
    // U2 takes back the other; the run is undone.
    const u2 = ledger.planUndo(runId);
    if (!u2.ok) throw new Error(u2.reason);
    expect(approveUndo(u2.status.id).ok).toBe(true);
    expect((await runBulkEffect(u2.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('done');
    expect(ledger.getStatus(runId)!.phase).toBe('undone');
    // An undo of U2 writes the run's value back; while it may write, U waits.
    const redo = ledger.planUndo(u2.status.id);
    if (!redo.ok) throw new Error(redo.reason);
    expect(approveUndo(redo.status.id).ok).toBe(true);
    const resumeU = () => ledger.resume(u.status.id, { checksum: ledger.computeChecksum(u.status.id)!, maxTargets: 2 });
    expect(resumeU()).toEqual({ ok: false, reason: 'undo_open' });
    expect((await runBulkEffect(redo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('done');
    // After it, U is stale: its source was taken back, and what U would write over is the redo.
    expect(resumeU()).toEqual({ ok: false, reason: 'undo_stale' });
    expect(state.get('k000')).toBe('w0');
  });

  it('a new undo is not planned while a run two levels down the family may write', async () => {
    const { runId, writer } = await halfWritten();
    // U takes back one of the two and halts: the run is stopped, not undone.
    const u = ledger.planUndo(runId);
    if (!u.ok) throw new Error(u.reason);
    expect(ledger.approve(u.status.id, { checksum: ledger.computeChecksum(u.status.id)!, maxTargets: 1 }).ok).toBe(true);
    expect((await runBulkEffect(u.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('halted');
    // An undo of U is approved: not a direct undo of the run, but of its family.
    const redo = ledger.planUndo(u.status.id);
    if (!redo.ok) throw new Error(redo.reason);
    expect(approveUndo(redo.status.id).ok).toBe(true);
    expect(ledger.planUndo(runId)).toEqual({ ok: false, reason: 'undo_open' });
  });

  it('a local target whose write failed is not part of the undo: nothing reached it', async () => {
    // One failure in a hundred stays under the halt thresholds: 99 applied, 1 failed.
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    const { writer } = memory(initial, new Set(['k010']));
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('done');
    // A local write's outcome is known: its failure is not counted unclear.
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 99, failed: 1, sentUnknown: 0 });
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    expect(undo.status.total).toBe(99);
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

  it('a rollback leaves a target someone else set to the planned value as it found it', async () => {
    const { runId, initial } = recordMemoryRun(4, { atomic: true });
    approve(runId);
    // k001 already holds its planned value, set by someone else; k003 fails and rolls the run back.
    const { writer, state } = memory({ ...initial, k001: 'w1' }, new Set(['k003']));
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer))).status).toBe('aborted');
    expect([...state.values()]).toEqual(['v0', 'w1', 'v2', 'v3']);
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
    // The owner's view names the one target the rollback left: written by the run, not taken
    // back. The ones it took back are undone, and the one that failed was never written.
    const view = ledger.getPreview(runId).map((t) => [t.key, t.written, t.undone]);
    expect(view).toEqual([['k000', true, false], ['k001', true, true], ['k002', true, true], ['k003', false, false]]);
  });

  it('a target found already as planned is not one the run wrote', async () => {
    const { runId, initial } = recordMemoryRun(3, { atomic: true });
    approve(runId);
    const { writer } = memory({ ...initial, k000: 'w0' }, new Set(['k002']));
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    expect(ledger.getPreview(runId).map((t) => [t.key, t.written, t.undone])).toEqual([['k000', false, false], ['k001', true, true], ['k002', false, false]]);
  });

  it('an atomic run cannot be approved with a cap below its size', () => {
    const { runId } = recordMemoryRun(5, { atomic: true });
    expect(ledger.approve(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 3 }))
      .toEqual({ ok: false, reason: 'bad_max_targets' });
  });

  it('an atomic run out of time rolls back instead of halting half written', async () => {
    const { runId, initial } = recordMemoryRun(10, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial);
    const t = Date.now();
    const clock = (): number => ((ledger.getStatus(runId)?.applied ?? 0) >= 4 ? t + 10 * 60 * 60_000 : t);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(writer, clock))).status).toBe('aborted');
    expect([...state.values()]).toEqual(Object.values(initial));
    // Its reason says time ran out: no target failed, so "could not be written" would be wrong.
    expect([ledger.getStatus(runId)!.phase, ledger.getStatus(runId)!.haltReason]).toEqual(['aborted', BULK_HALT_REASONS.atomicTimeRolledBack]);
  });

  it('an atomic run out of time whose rollback does not complete says both', async () => {
    const { runId, initial } = recordMemoryRun(6, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial);
    const t = Date.now();
    const clock = (): number => ((ledger.getStatus(runId)?.applied ?? 0) >= 3 ? t + 10 * 60 * 60_000 : t);
    const sneaky: TargetWriter = {
      read: (k) => writer.read(k),
      write: async (k, a) => {
        const r = await writer.write(k, a);
        if (k === 'k002') state.set('k001', 'touched');
        return r;
      },
    };
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(sneaky, clock))).status).toBe('aborted');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.atomicTimeRollbackIncomplete);
    expect(ledger.getPreview(runId).filter((p) => p.written && !p.undone).map((p) => p.key)).toEqual(['k001']);
  });

  // The undo of an atomic run is atomic too. When IT rolls back, the source's targets
  // stand again — they must not stay marked undone, or the source could never be undone.
  it('an atomic undo that rolls back leaves the source undoable', async () => {
    const { runId, initial } = recordMemoryRun(4, { atomic: true });
    approve(runId);
    const { writer, state } = memory(initial);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(writer));
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    state.set('k001', 'someone else'); // undo runs k003, k002, then conflicts on k001
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(writer))).status).toBe('aborted');
    expect([state.get('k003'), state.get('k002')]).toEqual(['w3', 'w2']);
    expect(ledger.getStatus(runId)!.undone).toBe(0);
    state.set('k001', 'w1');
    expect(ledger.planUndo(runId).ok).toBe(true);
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
    // The file is reached without following links, so the link at the leaf is refused before
    // anything is read — and left as it is.
    const { lstatSync } = await import('node:fs');
    expect(lstatSync(join(ws, 'leaf.txt')).isSymbolicLink()).toBe(true);
    expect(ledger.getPreview(runId)[0]!.error).toBe('path_changed');
  });

  it('a symlink planted between read and write is refused, and nothing is written through it', async () => {
    writeFileSync(join(ws, 'r.txt'), 'before');
    const secret = join(dir, 'secret-r.txt');
    writeFileSync(secret, 'secret', { mode: 0o600 });
    const key = realpathSync(join(ws, 'r.txt'));
    const w = workspaceWriter();
    expect(await w.read(key)).toEqual({ absent: false, value: 'before' });
    rmSync(key);
    symlinkSync(secret, key);
    await expect(w.write(key, { absent: false, value: 'written' })).rejects.toThrow();
    await expect(w.write(key, { absent: true })).rejects.toThrow();
    expect(readFileSync(secret, 'utf-8')).toBe('secret');
    const { lstatSync, statSync } = await import('node:fs');
    expect(lstatSync(key).isSymbolicLink()).toBe(true);
    expect(statSync(secret).mode & 0o777).toBe(0o600);
  });

  // The leaf guards behind the confinement check only matter when a path is swapped AFTER
  // that check. A resolver that vouches for the key stands in for that moment.
  describe('each guard on its own, with the confinement check outrun', () => {
    const vouches = (t: string): string => t;

    it('the read does not follow a symlink at the leaf', async () => {
      writeFileSync(join(dir, 'same.txt'), 'before');
      const key = join(ws, 'leaf-r.txt');
      symlinkSync(join(dir, 'same.txt'), key);
      expect(await workspaceWriter(vouches).read(key)).toBe('foreign');
    });

    it('the write refuses a symlink at the leaf and copies no mode from it', async () => {
      const secret = join(dir, 'secret-w.txt');
      writeFileSync(secret, 'secret', { mode: 0o600 });
      const key = join(ws, 'leaf-w.txt');
      symlinkSync(secret, key);
      await expect(workspaceWriter(vouches).write(key, { absent: false, value: 'x' })).rejects.toThrow();
      const { lstatSync, statSync } = await import('node:fs');
      expect(lstatSync(key).isSymbolicLink()).toBe(true);
      expect([readFileSync(secret, 'utf-8'), statSync(secret).mode & 0o777]).toEqual(['secret', 0o600]);
    });

    it('a key that no longer resolves to itself is refused before mkdir and before unlink', async () => {
      const refuses = (): null => null;
      const fresh = join(ws, 'never', 'made.txt');
      await expect(workspaceWriter(refuses).write(fresh, { absent: false, value: 'x' })).rejects.toThrow();
      expect(existsSync(join(ws, 'never'))).toBe(false);
      writeFileSync(join(ws, 'keep.txt'), 'k');
      await expect(workspaceWriter(refuses).write(join(ws, 'keep.txt'), { absent: true })).rejects.toThrow();
      expect(existsSync(join(ws, 'keep.txt'))).toBe(true);
    });

    it('directories mkdir created are checked again before the file goes in', async () => {
      // Vouches once (the check before mkdir), refuses after: a directory made on the way
      // that no longer resolves inside the area stops the write.
      let calls = 0;
      const flips = (t: string): string | null => (++calls === 1 ? t : null);
      const key = join(ws, 'made', 'here.txt');
      await expect(workspaceWriter(flips).write(key, { absent: false, value: 'x' })).rejects.toThrow();
      expect(existsSync(key)).toBe(false);
      expect(calls).toBe(2);
    });
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
    store.insertRecords({ collection: 'products', records, stamp: TEST_STAMP });
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
    expect((await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor })).status).toBe('done');

    const all = store.queryRecords({ collection: 'products', limit: 500 }).rows;
    expect(all).toHaveLength(210);
    expect(store.getCollectionInfo('products')!.recordCount).toBe(210);
    const s7 = all.find((r) => r['sku'] === 'S7')!;
    expect([s7['price'], s7['owner']]).toEqual([1007, 'subj-7']);
    expect(all.find((r) => r['sku'] === 'S200')!['owner']).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    expect((await runBulkEffect(undo.status.id, 'bulk_undo', { ledger, trailFor: () => null, writerFor })).status).toBe('done');
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
    const out = await runBulkEffect(runId, 'bulk_apply', { ledger, trailFor: () => null, writerFor: (run) => bulkWriterFor(run, store) });
    expect(out.status).toBe('refused');
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.unavailable);
  });
});

// PRD §7(i): before-images reach no model context. Enumerated by CHANNEL — every place a
// bulk run produces text the model reads — rather than by grepping consumers: the tool
// results of bulk_plan/bulk_status (which a session stores as thread messages and a
// compaction parks for recall_tool_result), the bulk trigger as task_list shows it (its
// title and, after a failed run, its last result), and the worker's run record and
// notification. Content, target keys and after-states each carry their own marker.
describe('§7(i) before-images reach no model context', () => {
  const IN_BEFORE = 'ZXQ-BEFORE-IMAGE';
  const IN_AFTER = 'ZXQ-AFTER-STATE';
  const IN_KEY = 'zxq-key-name';

  it('none of the channels carries a target\'s content, key or after-state', async () => {
    mkdirSync(join(ws, 'pages'));
    const rows: { target: string; after: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `pages/${IN_KEY}-${String(i)}.md`;
      if (i < 15) writeFileSync(join(ws, name), `${IN_BEFORE} ${String(i)}\n`);
      rows.push({ target: name, after: `${IN_AFTER} ${String(i)}\n` });
    }
    // One row the plan refuses, so the `invalid (reason n)` part of the status renders.
    rows.push({ target: `pages/${IN_KEY}-bad.md`, after: 42 as unknown as string });
    const seen: string[] = [];
    writeFileSync(join(ws, 'src.json'), JSON.stringify(rows));
    const planned = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src.json' }, agent());
    seen.push(planned);
    const runId = runIdOf(planned);
    approve(runId);

    // The worker path, with its run record and notification captured.
    const triggers = new TriggerStore(engineDb);
    const notify = vi.fn(async (msg: unknown) => { seen.push(JSON.stringify(msg)); });
    const recordTaskRun = vi.fn((id: string, result: string, status: 'success' | 'failed' | 'timeout') => {
      seen.push(result);
      triggers.updateFields(id, { status: status === 'success' ? 'completed' : 'failed' });
      triggers.updateRunResult(id, { lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunStatus: status, nextRunAt: null });
    });
    const engine = {
      getTaskManager: () => ({ getDueTriggers: () => triggers.getDue(), getExpiredWaitingTriggers: () => [], endWait: () => false,
        claimLease: triggers.claimLease.bind(triggers), renewLease: triggers.renewLease.bind(triggers), releaseLease: triggers.releaseLease.bind(triggers), recordTaskRun }),
      getToolContext: () => ({ containment: null }),
      getBulkLedger: () => ledger,
      getDataStore: () => store,
      getRunHistory: () => ({ updateTrigger: (id: string, p: Parameters<TriggerStore['updateFields']>[1]) => triggers.updateFields(id, p) }),
      getUserConfig: () => ({}),
      getEngineDb: () => null,
      getMandateEnds: () => null,
    } as unknown as Engine;
    // A conflict on one target, so the run's result carries more than a clean count.
    writeFileSync(join(ws, `pages/${IN_KEY}-0.md`), `changed by someone else ${IN_BEFORE}\n`);
    const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 25_000 });

    // A second run that FAILS at the worker (an expired approval), so task_list renders
    // the trigger's last result — the failed-run detail line is where a result shows.
    rmSync(join(ws, 'src.json'));
    writeFileSync(join(ws, 'src2.json'), JSON.stringify(rows.map((r) => ({ ...r, after: `${r.after}${IN_AFTER}-2` }))));
    const planned2 = await bulkPlanTool.handler({ target_system: 'workspace', source_file: 'src2.json' }, agent());
    seen.push(planned2);
    const runId2 = runIdOf(planned2);
    approve(runId2, { now: Date.now() - 2 * 24 * 60 * 60_000 });
    recordTaskRun.mockClear();
    await loop.tick();
    await vi.waitFor(() => expect(recordTaskRun).toHaveBeenCalled(), { timeout: 25_000 });
    expect(recordTaskRun.mock.calls[0]![2]).toBe('failed');

    // An undo planned, approved and run, so the undo run's rows are in the ledger too.
    const undo = ledger.planUndo(runId);
    if (!undo.ok) throw new Error(undo.reason);
    approve(undo.status.id);
    // The undo is the path that writes before-images BACK — its summary is a channel too.
    const undone = await runBulkEffect(undo.status.id, 'bulk_undo', effectDeps(workspaceWriter()));
    expect(undone.status).toBe('done');
    seen.push(undone.summary);

    // Both worker runs notified; the notification is a channel only if it was sent.
    expect(notify).toHaveBeenCalledTimes(2);

    const statuses = await bulkStatusTool.handler({}, agent());
    expect(statuses).toContain('after_not_text 1');
    seen.push(statuses);
    for (const id of [runId, runId2, undo.status.id]) seen.push(await bulkStatusTool.handler({ run_id: id }, agent()));

    // task_list as the model calls it, over the bulk triggers.
    const bulkTriggers = [runId, runId2, undo.status.id].map((id) => triggers.getById(`bulk-${id}`)!);
    const listAgent = {
      toolContext: { taskManager: { list: () => [], listTriggers: () => bulkTriggers } },
      activeScopes: [],
    } as unknown as IAgent;
    const listed = await taskListTool.handler({}, listAgent);
    expect(listed).toContain(`Bulk run ${runId2}`);
    // The failed run's result is rendered — the line that could carry a leak.
    expect(listed).toContain('last run FAILED');
    seen.push(listed);

    // The same tool results after a compaction parked them, recalled by handle.
    const blobs = new ToolResultBlobStore();
    const messages = seen.slice(0, 4).map((content, i) => [
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: `tu-${String(i)}`, name: 'bulk_status', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: `tu-${String(i)}`, content }] },
    ]).flat();
    const handles = blobs.evictFrom(messages, 0);
    expect(handles.length).toBeGreaterThan(0);
    for (const h of handles) {
      seen.push(await recallToolResultTool.handler({ id: h.id }, { toolResultBlobStore: blobs } as unknown as IAgent));
    }

    // Positive control: the markers are really there — in the files and, decrypted, in
    // the ledger — so their absence below is not the absence of anything to leak.
    const preview = JSON.stringify(ledger.getPreview(runId));
    expect(preview).toContain(IN_BEFORE);
    expect(preview).toContain(IN_AFTER);
    expect(preview).toContain(IN_KEY);
    expect(readFileSync(join(ws, `pages/${IN_KEY}-0.md`), 'utf-8')).toContain(IN_BEFORE);

    expect(seen.length).toBeGreaterThan(10);
    for (const text of seen) {
      for (const mark of [IN_BEFORE, IN_AFTER, IN_KEY]) expect(text, text.slice(0, 200)).not.toContain(mark);
    }
  });
});

// PRD customer-granted-operator-access §3.9: a run a delegated session planned has a pair of rows
// around each call of its effect — one before anything is read or written, one when it ends.
describe('the trail of one call of a run', () => {
  function trail(opts: { beginThrows?: boolean } = {}): { trail: BulkRunTrail; events: string[] } {
    const events: string[] = [];
    return {
      events,
      trail: {
        begin: () => { if (opts.beginThrows) throw new Error('log down'); events.push('begin'); },
        end: (outcome, written, failed, planned) => { events.push(`end ${outcome} ${String(written)} ${String(failed)}${planned ? ' planned' : ''}`); },
      },
    };
  }
  /** A writer that logs each read and write into the same list as the trail. */
  function logging(inner: TargetWriter, events: string[]): TargetWriter {
    return {
      async read(key, fields) { events.push(`read ${key}`); return inner.read(key, fields); },
      async write(key, after, sent) { events.push(`write ${key}`); return inner.write(key, after, sent); },
    };
  }

  it('writes the row before the first read and the row after the last write, with the targets written', async () => {
    const { runId, initial } = recordMemoryRun(2);
    approve(runId);
    const t = trail();
    const out = await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(logging(memory(initial).writer, t.events)), trailFor: () => t.trail });
    expect(out.status).toBe('done');
    expect(t.events).toEqual(['begin', 'read k000', 'write k000', 'read k001', 'write k001', 'end done 2 0']);
  });

  it('reads and writes nothing when the row before cannot be written, and halts the run saying so', async () => {
    const { runId, initial } = recordMemoryRun(2);
    approve(runId);
    const t = trail({ beginThrows: true });
    const out = await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(logging(memory(initial).writer, t.events)), trailFor: () => t.trail });
    expect(out.status).toBe('halted');
    expect(t.events, 'no read, no write, and no row after a row that was never written').toEqual([]);
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.runUnrecorded);
  });

  it('writes the row after a halt too, with what was written and what failed', async () => {
    const { runId, initial } = recordMemoryRun(4);
    approve(runId);
    const t = trail();
    const { writer } = memory(initial, new Set(['k001', 'k002', 'k003']));
    const out = await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(writer), trailFor: () => t.trail });
    expect(out.status).toBe('halted');
    // One target of four failed: more than 5 %, so the run halts there.
    expect(t.events).toEqual(['begin', 'end halted 1 1']);
  });

  it('writes the row after an error that ends the call, and lets the error through', async () => {
    const { runId, initial } = recordMemoryRun(2);
    approve(runId);
    const t = trail();
    let calls = 0;
    // The clock fails once the call is under way: the effect throws from inside its loop.
    const now = (): number => { calls++; if (calls > 3) throw new Error('clock'); return Date.now(); };
    await expect(runBulkEffect(runId, 'bulk_apply', { ...effectDeps(memory(initial).writer, now), trailFor: () => t.trail })).rejects.toThrow('clock');
    expect(t.events).toEqual(['begin', 'end error 0 0']);
  });

  it('writes no row for a call that is refused before it starts', async () => {
    const { runId } = recordMemoryRun(1);
    const t = trail();
    const out = await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(memory({}).writer), trailFor: () => t.trail });
    expect(out.status).toBe('refused');
    expect(t.events).toEqual([]);
  });

  it('counts in the row after only what this call wrote, not what earlier calls of the run did', async () => {
    const { runId, initial } = recordMemoryRun(3);
    approve(runId, { maxTargets: 1 });
    const { writer } = memory(initial);
    const first = trail();
    expect((await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(writer), trailFor: () => first.trail })).status).toBe('halted');
    expect(first.events, 'stopped at its approved maximum with no failed write: a planned halt').toEqual(['begin', 'end halted 1 0 planned']);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)!, maxTargets: 3 }).ok).toBe(true);
    const second = trail();
    expect((await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(writer), trailFor: () => second.trail })).status).toBe('done');
    expect(second.events, 'its own pair, with the two it wrote').toEqual(['begin', 'end done 2 0']);
  });

  it('writes the row after and keeps the outcome when the ledger cannot be read for the counts', async () => {
    // The finally's read of the counts is the effect's last read of the run: count the reads of
    // a clean call first, then make exactly that one throw on a second, identical call.
    const countReads = async (throwAt: number | null): Promise<{ reads: number; out: Awaited<ReturnType<typeof runBulkEffect>>; t: ReturnType<typeof trail> }> => {
      const { runId, initial } = recordMemoryRun(1);
      approve(runId);
      let reads = 0;
      const proxied = new Proxy(ledger, {
        get(target, prop, receiver) {
          if (prop === 'getRunForApply') {
            return (id: string) => { reads++; if (reads === throwAt) throw new Error('database is locked'); return target.getRunForApply(id); };
          }
          const v: unknown = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const t = trail();
      const out = await runBulkEffect(runId, 'bulk_apply', { ...effectDeps(memory(initial).writer), ledger: proxied, trailFor: () => t.trail });
      return { reads, out, t };
    };
    const clean = await countReads(null);
    expect(clean.t.events).toEqual(['begin', 'end done 1 0']);
    const failing = await countReads(clean.reads);
    expect(failing.out.status, 'a finished call stays finished').toBe('done');
    expect(failing.t.events, 'the row after is written, with the counts it could not read as unknown, not as zero').toEqual(['begin', 'end done null null']);
  });

  it('control: with no trail the same run writes as before', async () => {
    const { runId, initial } = recordMemoryRun(2);
    approve(runId);
    const out = await runBulkEffect(runId, 'bulk_apply', effectDeps(memory(initial).writer));
    expect(out.status).toBe('done');
  });
});

describe('what a resume after a failure halt may still do', () => {
  /** A memory writer whose read fails for `readFail` (before anything is sent) and whose write
   *  fails for `fail`, or for `secret` on what it would send. */
  function failing(initial: Record<string, string>, f: { fail?: string[]; readFail?: string[]; secret?: string[] }): TargetWriter {
    const inner = memory(initial, new Set(f.fail ?? [])).writer;
    return {
      async read(key, fields) {
        if (f.readFail?.includes(key)) throw new Error(`read ${MARK}`);
        return inner.read(key, fields);
      },
      async write(key, after, onSend) {
        if (f.secret?.includes(key)) throw new BulkSecretError();
        return inner.write(key, after, onSend);
      },
    };
  }

  it('limit below the open targets: the next pass halts on the failure past the limit', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: ['k010', 'k011', 'k012'] })));
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failureLimit, s.resumeOpen]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 5, 90]);
    expect(s.failureLimit).toBeLessThan(s.resumeOpen);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    const six = ['k020', 'k030', 'k040', 'k050', 'k060', 'k070'];
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: six })))).status).toBe('halted');
    expect(ledger.getStatus(runId)).toMatchObject({ haltReason: BULK_HALT_REASONS.failureRate, failed: 6 });
  });

  it('limit at least the open targets, three or more open: only three in a row stop the next pass', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: ['k096', 'k097', 'k098'] })));
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failureLimit, s.resumeOpen]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 5, 4]);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    // All four fail: the share cannot be passed, three in a row still halt.
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: ['k096', 'k097', 'k098', 'k099'] })));
    expect(ledger.getStatus(runId)!.haltReason).toBe(BULK_HALT_REASONS.consecutiveFailures);
  });

  it('fewer than three open: the next pass does not stop for its failures', async () => {
    const { runId, initial } = recordMemoryRun(100);
    approve(runId);
    // The secret target stays failed through the resume, so two are left open.
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { secret: ['k097'], fail: ['k098', 'k099'] })));
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failureLimit, s.resumeOpen, s.resumeTries]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 5, 2, 2]);
    expect(ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! }).ok).toBe(true);
    expect((await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: ['k098', 'k099'] })))).status).toBe('done');
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', haltReason: null, failed: 3, failedOnce: 3 });
  });

  it('under a cap, a pass fails more targets than it may send to: failures before the send spend no place', async () => {
    // A maximum of 1, and three reads fail in a row: nothing was sent, so the cap is not spent,
    // and the pass fails three targets — more than the one it may still send to.
    const { runId, initial } = recordMemoryRun(40);
    approve(runId, { maxTargets: 1 });
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { readFail: ['k000', 'k001', 'k002'] })));
    const s = ledger.getStatus(runId)!;
    expect([s.haltReason, s.failed, s.failureLimit, s.resumeOpen, s.resumeTries]).toEqual([BULK_HALT_REASONS.consecutiveFailures, 3, 2, 40, 1]);
    expect(s.failed).toBeGreaterThan(s.resumeTries);
  });

  it('under a cap, a target already sent to takes no place from it', async () => {
    const { runId, initial } = recordMemoryRun(40);
    approve(runId, { maxTargets: 3 });
    // The write is sent and fails: write_sent marks it, so a retry sends to no new target.
    await runBulkEffect(runId, 'bulk_apply', effectDeps(failing(initial, { fail: ['k001'] })));
    const s = ledger.getStatus(runId)!;
    // k000 and k002 written, k001 sent and failed: the cap of 3 is spent, and of the 38 open
    // only k001 may still be sent to.
    expect([s.haltReason, s.applied, s.resumeOpen, s.resumeTries]).toEqual([BULK_HALT_REASONS.maxTargets, 2, 38, 1]);
    // The maximum the halt names, which writing on has to go above.
    expect(s.maxTargets).toBe(3);
  });
});
