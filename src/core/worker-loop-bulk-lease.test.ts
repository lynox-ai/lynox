import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { TaskManager } from './task-manager.js';
import { BulkLedger, BULK_HALT_REASONS, type PlannedTarget } from './bulk-ledger.js';
import { TriggerStore } from './trigger-store.js';
import { WorkerLoop, type ActiveTask } from './worker-loop.js';
import type { TargetWriter } from './bulk-apply.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * A bulk run's trigger is booked at the run's end only under the run lease of the loop that ran
 * it, and a loop that lost the lease to another engine process (a second connection on the same
 * engine.db here) ends without booking or telling anyone. A loop whose lease lapsed with nobody
 * taking over books and tells as before. The owner's stop reaches the run as a mark in its ledger,
 * from every way of stopping. Real stores throughout: the run history, the task manager, the
 * trigger store and the ledger.
 */

let dir: string;
let engineDb: EngineDb;
let other: EngineDb;
let history: RunHistory;
let tm: TaskManager;
let ledger: BulkLedger;
let triggers: TriggerStore;
let otherTriggers: TriggerStore;
const loops: WorkerLoop[] = [];
const restores: Array<() => void> = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-worker-bulk-lease-')));
  engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  other = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  history = new RunHistory(join(dir, 'history.db'));
  history.setVerbGraph(engineDb);
  tm = new TaskManager(history);
  ledger = new BulkLedger(engineDb, null);
  triggers = new TriggerStore(engineDb);
  otherTriggers = new TriggerStore(other);
});

afterEach(() => {
  for (const l of loops) l.stop();
  loops.length = 0;
  for (const r of restores.reverse()) r();
  restores.length = 0;
  other.close();
  engineDb.close();
  history.close();
  rmSync(dir, { recursive: true, force: true });
});

function approvedRun(n: number, opts: { atomic?: boolean } = {}): { runId: string; tid: string; initial: Record<string, string> } {
  const initial: Record<string, string> = {};
  const targets: PlannedTarget[] = [];
  for (let i = 0; i < n; i++) {
    const key = `k${String(i).padStart(3, '0')}`;
    initial[key] = `v${String(i)}`;
    targets.push({ key, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` });
  }
  const s = ledger.recordDryRun({ createdBy: 't', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets, atomic: opts.atomic });
  const out = ledger.approve(s.id, { checksum: ledger.computeChecksum(s.id)! });
  if (!out.ok) throw new Error(out.reason);
  return { runId: s.id, tid: out.triggerId, initial };
}

/** Another engine process takes the trigger's lease over once it lapsed. */
function anotherProcessTakesOver(tid: string): void {
  other.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), tid);
  expect(otherTriggers.claimLease(tid, 'other-process', new Date(Date.now() + 15 * 60_000).toISOString(), new Date().toISOString())).not.toBe('held');
}

/** The lease lapses and nobody takes it: the process only stood still. */
function leaseLapses(tid: string): void {
  other.getDb().prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', tid);
}

function memory(initial: Record<string, string>, onWrite: (key: string) => void = () => {}): { writer: TargetWriter; state: Map<string, string> } {
  const state = new Map(Object.entries(initial));
  return {
    state,
    writer: {
      async read(key) { return { absent: false, value: state.get(key)! }; },
      async write(key, after) {
        state.set(key, after.absent ? '' : after.value as string);
        onWrite(key);
        return 'ok';
      },
    },
  };
}

async function routeWriter(writer: TargetWriter): Promise<void> {
  const mod = await import('./bulk-apply.js');
  const spy = vi.spyOn(mod, 'bulkWriterFor').mockReturnValue(writer);
  restores.push(() => { spy.mockRestore(); });
}

function makeLoop(opts: { ledger?: BulkLedger; switchedOff?: boolean; backup?: () => Promise<unknown> } = {}): { loop: WorkerLoop; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => {});
  const l = opts.ledger ?? ledger;
  const engine = {
    getTaskManager: () => tm,
    getRunHistory: () => history,
    getToolContext: () => ({ containment: null }),
    getBulkLedger: () => (opts.switchedOff === true ? null : l),
    getBulkLedgerSwitchedOff: () => (opts.switchedOff === true ? l : null),
    getDataStore: () => null,
    getUserConfig: () => ({}),
    getEngineDb: () => null,
    getMandateEnds: () => null,
    getPromptStore: () => null,
    getBackupManager: () => (opts.backup ? { createBackup: opts.backup, pruneBackups: () => {} } : null),
  } as unknown as Engine;
  const loop = new WorkerLoop(engine, { hasChannels: () => true, notify } as unknown as NotificationRouter, 60_000);
  loops.push(loop);
  return { loop, notify };
}

/** A writer whose writes wait until released; `both` resolves once `n` writes have started.
 *  `writes` lists the key of every write that landed, `state` the targets' values. */
function bothWriting(initial: Record<string, string>, n = 2): { release: () => void; writes: string[]; state: Map<string, string>; writer: { writer: TargetWriter; both: Promise<void> } } {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const both = new Promise<void>((r) => { started = r; });
  let entered = 0;
  const writes: string[] = [];
  const m = memory(initial, (k) => { writes.push(k); });
  return {
    release,
    writes,
    state: m.state,
    writer: {
      both,
      writer: { read: (k) => m.writer.read(k, null), async write(k, a) { if (++entered === n) started(); await held; return m.writer.write(k, a); } },
    },
  };
}

/** The test's ledger, whose `requestStop` throws where `refuse` says so (the store refusing the write). */
function refusingStop(refuse: () => boolean): BulkLedger {
  return new Proxy(ledger, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'requestStop' || typeof v !== 'function') return v;
      return (...args: unknown[]): unknown => {
        if (refuse()) throw new Error('store refused');
        return Reflect.apply(v as (...a: unknown[]) => unknown, receiver, args);
      };
    },
  });
}

const trig = (tid: string) => engineDb.getDb().prepare('SELECT status, next_run_at, last_run_status, last_run_result FROM triggers WHERE id = ?')
  .get(tid) as { status: string; next_run_at: string | null; last_run_status: string | null; last_run_result: string | null };

describe('a bulk loop that lost its run lease to another process', () => {
  it('ends displaced: no booking on the trigger, no notice to the owner, one log line', async () => {
    const { runId, tid, initial } = approvedRun(2);
    const before = trig(tid);
    const m = memory(initial, (k) => { if (k === 'k000') anotherProcessTakesOver(tid); });
    await routeWriter(m.writer);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(() => { err.mockRestore(); });
    const { loop, notify } = makeLoop();
    await loop.tick();
    await vi.waitFor(() => expect(err.mock.calls.some((c) => String(c[0]).includes('lost its run lease to another engine process; this loop stopped writing'))).toBe(true), { timeout: 10_000 });
    expect(err.mock.calls.filter((c) => String(c[0]).includes('this loop stopped writing'))).toHaveLength(1);
    expect(trig(tid)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
    // Nothing of the run was recorded by the displaced loop.
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'writing', applied: 0, haltReason: null });
  });

  it('a run left pending whose lease was taken before the booking: the trigger is neither booked nor re-armed', async () => {
    const { runId, tid, initial } = approvedRun(3);
    // Target 2 is held by a live loop elsewhere: the run ends pending.
    engineDb.getDb().prepare('UPDATE bulk_targets SET claimed_at = ? WHERE run_id = ? AND seq = 2').run(new Date(Date.now() + 60_000).toISOString(), runId);
    const before = trig(tid);
    let pendingReads = 0;
    const proxied = new Proxy(ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'listPending' || typeof v !== 'function') return v;
        return (...args: unknown[]): unknown => {
          // The second read is the one after the last target: the lease goes right there.
          if (++pendingReads === 2) anotherProcessTakesOver(tid);
          return Reflect.apply(v as (...a: unknown[]) => unknown, receiver, args);
        };
      },
    });
    await routeWriter(memory(initial).writer);
    const record = vi.spyOn(tm, 'recordTaskRun');
    const { loop, notify } = makeLoop({ ledger: proxied });
    await loop.tick();
    await vi.waitFor(() => expect(record).toHaveBeenCalled(), { timeout: 10_000 });
    expect(record.mock.calls[0]![2]).toBe('success');
    expect(record.mock.results[0]!.value).toBe(false);
    expect(trig(tid)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('control: a run left pending under its own lease is booked and re-armed for its retry', async () => {
    const { runId, tid, initial } = approvedRun(3);
    engineDb.getDb().prepare('UPDATE bulk_targets SET claimed_at = ? WHERE run_id = ? AND seq = 2').run(new Date(Date.now() + 60_000).toISOString(), runId);
    await routeWriter(memory(initial).writer);
    const { loop } = makeLoop();
    const at = Date.now();
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('success'), { timeout: 10_000 });
    await vi.waitFor(() => expect(trig(tid).status).toBe('open'));
    expect(Date.parse(trig(tid).next_run_at!)).toBeGreaterThanOrEqual(at + 25_000);
  });
});

describe('a bulk loop whose lease lapsed with nobody taking over: as before', () => {
  it('writes the run to its end, books the trigger and tells the owner', async () => {
    const { runId, tid, initial } = approvedRun(2);
    const m = memory(initial, (k) => { if (k === 'k000') leaseLapses(tid); });
    await routeWriter(m.writer);
    const { loop, notify } = makeLoop();
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('success'), { timeout: 10_000 });
    expect(trig(tid).status).toBe('completed');
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 2 });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  });
});

describe('a run of another effect books as before, whoever holds its lease at its end', () => {
  it('a backup whose lease another process took during the run is still booked', async () => {
    triggers.upsert({
      id: 'bk', title: 'Backup', description: '', source: 'cron', effect: 'backup',
      conditionJson: JSON.stringify({ schedule_cron: '0 3 * * *', watch_config: null }),
      paramsJson: '{}', status: 'open', enabled: true, retryCount: 0, confirmedAt: '2026-01-01T00:00:00.000Z',
      nextRunAt: '2000-01-01T00:00:00.000Z',
    });
    const { loop } = makeLoop({
      backup: async () => { anotherProcessTakesOver('bk'); return { success: true, path: '/tmp/none.db', duration_ms: 1 }; },
    });
    await loop.tick();
    await vi.waitFor(() => expect(trig('bk').last_run_status).toBe('success'), { timeout: 10_000 });
  });
});

describe('the owner\'s stop reaches the run through its ledger', () => {
  it('stopTask on a running bulk write records the stop in the ledger, and the run ends as the owner\'s stop', async () => {
    const { runId, tid, initial } = approvedRun(3);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let inWrite!: () => void;
    const writing = new Promise<void>((r) => { inWrite = r; });
    const m = memory(initial);
    await routeWriter({ read: (k) => m.writer.read(k, null), async write(k, a) { inWrite(); await held; return m.writer.write(k, a); } });
    const { loop, notify } = makeLoop();
    await loop.tick();
    await writing;
    expect(ledger.isStopRequested(runId)).toBe(false);
    expect(loop.stopTask(tid)).toEqual({ kind: 'requested', via: 'signal' });
    expect(ledger.isStopRequested(runId)).toBe(true);
    release();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.stoppedByOwner });
    expect(notify).not.toHaveBeenCalled();
  });

  it('stopBulkTasks (bulk runs switched off) records the stop in the ledger of each running write', async () => {
    const one = approvedRun(3);
    const two = approvedRun(3);
    const { release, writer } = bothWriting(one.initial);
    await routeWriter(writer.writer);
    const { loop } = makeLoop();
    await loop.tick();
    await writer.both;
    expect([...loop.stopBulkTasks()].sort()).toEqual([one.tid, two.tid].sort());
    expect(ledger.isStopRequested(one.runId)).toBe(true);
    expect(ledger.isStopRequested(two.runId)).toBe(true);
    release();
    await vi.waitFor(() => expect(trig(one.tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    await vi.waitFor(() => expect(trig(two.tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
  });

  it('stopTask on a bulk write whose ledger refuses the stop mark still aborts the task, answers requested, says so on stderr, and ends the run stopped without writing the targets after the stop', async () => {
    const { runId, tid, initial } = approvedRun(3);
    const { release, writes, state, writer } = bothWriting(initial, 1);
    await routeWriter(writer.writer);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(() => { err.mockRestore(); });
    const { loop } = makeLoop({ ledger: refusingStop(() => true) });
    await loop.tick();
    await writer.both;
    const active = (loop as unknown as { activeTasks: Map<string, ActiveTask> }).activeTasks.get(tid)!;
    expect(loop.stopTask(tid)).toEqual({ kind: 'requested', via: 'signal' });
    expect(active.stopRequested).toBe(true);
    expect(active.controller.signal.aborted).toBe(true);
    expect(active.ownerStop.signal.aborted).toBe(true);
    expect(ledger.isStopRequested(runId)).toBe(false);
    expect(err.mock.calls.filter((c) => String(c[0]).includes(`recording the stop of "${tid}" in its ledger threw: store refused`))).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    // The write in flight at the stop lands; the two targets after it are never written.
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.stoppedByOwner });
    expect(writes).toEqual(['k000']);
    expect(Object.fromEntries(state)).toEqual({ k000: 'w0', k001: 'v1', k002: 'v2' });
  });

  it('a run stopped on a refused stop mark, once resumed, writes its remaining targets to done: the refused mark is not carried into the next run start', async () => {
    const { runId, tid, initial } = approvedRun(3);
    const { release, writes, state, writer } = bothWriting(initial, 1);
    await routeWriter(writer.writer);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(() => { err.mockRestore(); });
    const { loop } = makeLoop({ ledger: refusingStop(() => true) });
    await loop.tick();
    await writer.both;
    expect(loop.stopTask(tid)).toEqual({ kind: 'requested', via: 'signal' });
    expect(ledger.isStopRequested(runId)).toBe(false);
    release();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.stoppedByOwner });
    expect(writes).toEqual(['k000']);
    // The first run start is over (its lease given back) before the next tick looks.
    await vi.waitFor(() => expect(triggers.leaseOf(tid)!.holder).toBeNull());
    const resumed = ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! });
    if (!resumed.ok) throw new Error(resumed.reason);
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('success'), { timeout: 10_000 });
    expect(ledger.getStatus(runId)).toMatchObject({ phase: 'done', applied: 3, haltReason: null });
    expect(writes).toEqual(['k000', 'k001', 'k002']);
    expect(Object.fromEntries(state)).toEqual({ k000: 'w0', k001: 'w1', k002: 'w2' });
  });

  it('stopBulkTasks: a first task whose stop mark throws does not cost the second its stop, and both runs end stopped without writing the targets after the stop', async () => {
    const one = approvedRun(3);
    const two = approvedRun(3);
    // Both runs plan the same keys, so they share one store here: each sends its first write.
    const { release, writes, state, writer } = bothWriting(one.initial);
    await routeWriter(writer.writer);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    restores.push(() => { err.mockRestore(); });
    // The first mark the sweep writes throws, whichever run it is for.
    let marks = 0;
    const { loop } = makeLoop({ ledger: refusingStop(() => ++marks === 1) });
    await loop.tick();
    await writer.both;
    const active = (loop as unknown as { activeTasks: Map<string, ActiveTask> }).activeTasks;
    const [first, second] = [...active.keys()];
    expect([...loop.stopBulkTasks()].sort()).toEqual([one.tid, two.tid].sort());
    expect(marks).toBe(2);
    const runOf = (tid: string): string => (tid === one.tid ? one.runId : two.runId);
    expect(ledger.isStopRequested(runOf(first!))).toBe(false);
    expect(ledger.isStopRequested(runOf(second!))).toBe(true);
    for (const tid of [first!, second!]) {
      expect(active.get(tid)!.stopRequested).toBe(true);
      expect(active.get(tid)!.controller.signal.aborted).toBe(true);
    }
    expect(err.mock.calls.filter((c) => String(c[0]).includes('in its ledger threw'))).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(trig(second!).last_run_status).toBe('stopped'), { timeout: 10_000 });
    await vi.waitFor(() => expect(trig(first!).last_run_status).toBe('stopped'), { timeout: 10_000 });
    for (const tid of [first!, second!]) {
      expect(ledger.getStatus(runOf(tid))).toMatchObject({ applied: 1, haltReason: BULK_HALT_REASONS.stoppedByOwner });
    }
    // One write each, the one in flight at the stop; the targets after it are never written.
    expect(writes).toEqual(['k000', 'k000']);
    expect(Object.fromEntries(state)).toEqual({ k000: 'w0', k001: 'v1', k002: 'v2' });
  });

  it('a tick while bulk runs are switched off records the stop and ends the run as the owner\'s stop, writing nothing', async () => {
    const { runId, tid, initial } = approvedRun(2);
    const m = memory(initial);
    await routeWriter(m.writer);
    const { loop } = makeLoop({ switchedOff: true });
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    expect(ledger.isStopRequested(runId)).toBe(true);
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 0, haltReason: BULK_HALT_REASONS.stoppedByOwner });
    expect([...m.state.values()]).toEqual(['v0', 'v1']);
  });

  it('requestBulkStop for a run with no loop in this process records the stop and makes the trigger due; the next tick ends the run stopped', async () => {
    const { runId, tid, initial } = approvedRun(2);
    engineDb.getDb().prepare(`UPDATE triggers SET status = 'open', next_run_at = ? WHERE id = ?`).run(new Date(Date.now() + 30_000).toISOString(), tid);
    const m = memory(initial);
    await routeWriter(m.writer);
    const { loop } = makeLoop();
    expect(loop.requestBulkStop('bulk_apply', runId, true)).toBe(true);
    expect(triggers.getDue().map((t) => t.id)).toContain(tid);
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    expect(ledger.getStatus(runId)).toMatchObject({ applied: 0, haltReason: BULK_HALT_REASONS.stoppedByOwner });
  });

  it('requestBulkStop records nothing for the read phase\'s trigger, nor for a halted run', () => {
    const { runId } = approvedRun(2);
    const { loop } = makeLoop();
    expect(loop.requestBulkStop('bulk_preview', runId, true)).toBe(false);
    expect(loop.requestBulkStop('bulk_judge', runId, true)).toBe(false);
    expect(ledger.isStopRequested(runId)).toBe(false);
    ledger.halt(runId, BULK_HALT_REASONS.timeBudget);
    expect(loop.requestBulkStop('bulk_apply', runId, true)).toBe(false);
    expect(ledger.isStopRequested(runId)).toBe(false);
  });

  it('a resumed run is not stopped again by the stop it was halted with', async () => {
    const { runId, tid, initial } = approvedRun(2);
    expect(ledger.requestStop(runId)).toBe(true);
    const m = memory(initial);
    await routeWriter(m.writer);
    const { loop } = makeLoop();
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('stopped'), { timeout: 10_000 });
    // The first run is over (its lease given back) before the next tick looks.
    await vi.waitFor(() => expect(triggers.leaseOf(tid)!.holder).toBeNull());
    const resumed = ledger.resume(runId, { checksum: ledger.computeChecksum(runId)! });
    if (!resumed.ok) throw new Error(resumed.reason);
    await loop.tick();
    await vi.waitFor(() => expect(trig(tid).last_run_status).toBe('success'), { timeout: 10_000 });
    expect([...m.state.values()]).toEqual(['w0', 'w1']);
  });
});

describe('booking a run under its lease (TaskManager.recordTaskRun)', () => {
  it('books under the holder\'s lease, and books nothing and schedules no retry for a holder that lost it', () => {
    const { tid } = approvedRun(1);
    expect(triggers.claimLease(tid, 'me', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())).toBe('claimed');
    const before = trig(tid);
    expect(tm.recordTaskRun(tid, 'not mine', 'failed', { leaseHolder: 'someone-else' })).toBe(false);
    expect(trig(tid)).toEqual(before);
    tm.recordTaskRun(tid, 'mine', 'success', { leaseHolder: 'me' });
    expect(trig(tid)).toMatchObject({ last_run_status: 'success', last_run_result: 'mine', status: 'completed' });
  });
});
