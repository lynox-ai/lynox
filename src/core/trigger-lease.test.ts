import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { TriggerStore } from './trigger-store.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * The trigger run lease (engine.db v16), driven across a REAL restart: a second engine
 * process is a second RunHistory + EngineDb + TaskManager + WorkerLoop opened on the same
 * files while the first one's run is still in flight. Nothing hands the lease in — the
 * first loop takes it through its own dispatch, and the second loop only sees what that
 * left in engine.db. An in-memory guard (`activeTasks`) cannot carry across that line.
 */

const T0 = Date.parse('2026-01-01T09:00:30.000Z');
const MIN = 60_000;

const dirs: string[] = [];
const closers: Array<() => void> = [];
/** Releases every run still parked in a session mock, so teardown can drain it. */
const releases: Array<() => void> = [];
/** Resolves once a process has no run left that could still write to its files. */
const settles: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const r of releases.splice(0)) r();
  // A released run still records its result and drops its lease; let it, before the
  // handles close under it.
  for (const s of settles.splice(0)) await s();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-lease-'));
  dirs.push(dir);
  return dir;
}

interface Proc {
  loop: WorkerLoop;
  manager: TaskManager;
  history: RunHistory;
  engineDb: EngineDb;
  /** Agent turns this process dispatched. */
  dispatches: () => number;
  /** Finish this process's in-flight agent turn. */
  finish: (result?: string) => void;
  /** End this process's in-flight agent turn with an error. */
  fail: (error: Error) => void;
  router: { hasChannels: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

/** One engine process on `dir`. Its agent turns hang until `finish` — a run in progress. */
function boot(dir: string, lease?: { heartbeatMs: number; ttlMs: number }): Proc {
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  // An agent run is over for this process once it dropped its lease — the last write of
  // executeTask. Counted against the turns dispatched, so a lease a test takes by hand
  // without a run never holds teardown up.
  let released = 0;
  const realRelease = manager.releaseLease.bind(manager);
  manager.releaseLease = (...a) => { realRelease(...a); released++; };
  const pending: Array<(r: string) => void> = [];
  const failing: Array<(e: Error) => void> = [];
  const run = vi.fn(() => new Promise<string>((resolve, reject) => { pending.push(resolve); failing.push(reject); }));
  releases.push(() => { for (const r of pending.splice(0)) r('released'); });
  settles.push(async () => { await vi.waitFor(() => expect(released).toBeGreaterThanOrEqual(run.mock.calls.length), { timeout: 5_000 }); });
  // getLastRunStop: the real Session always has it and executeStandard reads the run's
  // ending off it; a double without it turns that read into a swallowed TypeError.
  const session = { sessionId: 'thread-lease', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined, run };
  const engine = {
    getTaskManager: () => manager,
    createSession: () => session as unknown as Session,
    getPromptStore: () => null,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
  } as unknown as Engine;
  const routerDouble = { hasChannels: vi.fn(() => false), notify: vi.fn().mockResolvedValue(undefined) };
  const router = routerDouble as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000, undefined, lease);
  closers.push(() => loop.stop());
  return {
    loop, manager, history, engineDb,
    dispatches: () => run.mock.calls.length,
    finish: (result = 'done') => { failing.splice(0); for (const r of pending.splice(0)) r(result); },
    fail: (error) => { pending.splice(0); for (const r of failing.splice(0)) r(error); },
    router: routerDouble,
  };
}

function seedCron(p: Proc): void {
  p.history.insertTrigger({
    id: 'trg-1', title: 'Daily report', source: 'cron', effect: 'run_agent',
    scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  });
}

function leaseRow(p: Proc, id = 'trg-1'): { lease_holder: string | null; lease_until: string | null; next_run_at: string | null } {
  return p.engineDb.getDb().prepare('SELECT lease_holder, lease_until, next_run_at FROM triggers WHERE id = ?')
    .get(id) as { lease_holder: string | null; lease_until: string | null; next_run_at: string | null };
}

describe('the trigger run lease across a restart', () => {
  // MUTATIONS (each tsc-checked): drop the lease clause from TriggerStore.getDue → B lists
  // the trigger as due; let runTriggerNow ignore `held` → B starts it by hand. Dropping the
  // claim in WorkerLoop.tick alone fails this test and the next two.
  it('a run in progress is not started again by a restarted engine while its lease holds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const dir = newDir();
    const a = boot(dir);
    seedCron(a);
    await a.loop.tick();
    await vi.waitFor(() => expect(a.dispatches()).toBe(1));
    expect(leaseRow(a).lease_holder).not.toBeNull();

    // The engine restarts: a new process on the same files, A's run still in flight.
    vi.setSystemTime(T0 + 5 * MIN);
    const b = boot(dir);
    expect(b.manager.getDueTriggers().map((t) => t.id)).toEqual([]);
    await b.loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(b.dispatches()).toBe(0);
    expect(await b.loop.runTriggerNow('trg-1')).toEqual({ ok: false, reason: 'already_running' });
    expect(b.dispatches()).toBe(0);
  });

  // MUTATION: in WorkerLoop.tick, treat `interrupted` like `claimed` (drop the
  // `RESUMES_AFTER_LOSS` branch) → B dispatches a second agent turn.
  it('a lapsed lease of a lost agent run is recorded as interrupted, not run again — and the live run that lost it still runs once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const dir = newDir();
    const a = boot(dir);
    seedCron(a);
    await a.loop.tick();
    await vi.waitFor(() => expect(a.dispatches()).toBe(1));

    // Past the lease: A's heartbeat (30 s, real time) has not fired in this test, so to
    // the second process A looks dead — the same row a crashed engine leaves, and the
    // same row a live run leaves whose event loop was blocked past the lease.
    vi.setSystemTime(T0 + 16 * MIN);
    const b = boot(dir);
    expect(b.manager.getDueTriggers().map((t) => t.id)).toEqual(['trg-1']);
    await b.loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(b.dispatches()).toBe(0);
    const settled = b.manager.getTrigger('trg-1')!;
    expect(settled.last_run_status).toBe('failed');
    expect(settled.last_run_result).toMatch(/engine stopped while this run was in progress/);
    // Scheduled like any failed cron run: its next occurrence, not now.
    expect(Date.parse(settled.next_run_at!)).toBeGreaterThan(T0 + 16 * MIN);
    expect(leaseRow(b).lease_holder).toBeNull();

    // Exactly once: the next tick finds nothing due.
    await b.loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(b.dispatches()).toBe(0);

    // The run that lost its lease was alive after all; it finishes and records — one run in total.
    a.finish('report written');
    await vi.waitFor(() => expect(a.manager.getTrigger('trg-1')!.last_run_result).toBe('report written'));
    expect(a.dispatches() + b.dispatches()).toBe(1);
    expect(leaseRow(a).lease_holder).toBeNull();
  });

  // MUTATION: `bulk_apply: false` in RESUMES_AFTER_LOSS → the lost bulk run is recorded
  // as interrupted instead of dispatched, and this fails.
  it('a lapsed lease of a resumable effect is taken over and run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const dir = newDir();
    const a = boot(dir);
    const id = new TriggerStore(a.engineDb).armBulkEffect({
      runId: 'run-x', effect: 'bulk_apply', title: 'Bulk run x', nextRunAt: new Date(T0 - MIN).toISOString(),
    });
    // A took the lease and died before recording anything.
    expect(a.manager.claimLease(id, 'dead-loop', new Date(T0 + MIN).toISOString(), new Date(T0).toISOString())).toBe('claimed');

    vi.setSystemTime(T0 + 2 * MIN);
    const b = boot(dir);
    await b.loop.tick();
    // This engine has no bulk ledger, so the dispatched effect records exactly that — the
    // witness that executeBulk ran rather than an interrupted record.
    await vi.waitFor(() => expect(b.manager.getTrigger(id)!.last_run_result).toMatch(/Bulk runs are not available/));
    expect(leaseRow(b, id).lease_holder).toBeNull();
  });
});

describe('a lease that cannot be taken', () => {
  // MUTATION: `return 'claimed'` in WorkerLoop.takeLease's catch → the trigger runs
  // without the guard exactly when two processes contend for the write lock.
  it('does not run the trigger when the store refuses the claim (fail closed)', async () => {
    const p = boot(newDir());
    seedCron(p);
    vi.spyOn(p.manager, 'claimLease').mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    await p.loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(p.dispatches()).toBe(0);
    expect(await p.loop.runTriggerNow('trg-1')).toEqual({ ok: false, reason: 'already_running' });
    expect(p.dispatches()).toBe(0);
    // Still due: it waits for the next tick instead of being dropped.
    expect(p.manager.getDueTriggers().map((t) => t.id)).toEqual(['trg-1']);
  });
});

describe('recording a lost run', () => {
  // MUTATION: drop the try around recordAndNotify/releaseLease in the interrupted branch
  // → the throw leaves the tick, and the second due trigger is not dispatched.
  it('a store error while recording one lost run does not stop the other due triggers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const p = boot(newDir());
    seedCron(p);
    p.history.insertTrigger({
      id: 'trg-2', title: 'Weekly digest', source: 'cron', effect: 'run_agent',
      scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:10.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    });
    // trg-1's run was lost: a lapsed lease taken after its occurrence was due.
    p.manager.claimLease('trg-1', 'dead-loop', new Date(T0 + MIN).toISOString(), new Date(T0).toISOString());
    vi.setSystemTime(T0 + 2 * MIN);
    const real = p.manager.recordTaskRun.bind(p.manager);
    vi.spyOn(p.manager, 'recordTaskRun').mockImplementation((id, ...rest) => {
      if (id === 'trg-1') throw new Error('SQLITE_BUSY: database is locked');
      return real(id, ...rest);
    });
    const before = leaseRow(p);
    await p.loop.tick();
    await vi.waitFor(() => expect(p.dispatches()).toBe(1));
    // The dispatched turn was trg-2's: trg-1 was neither run nor settled — its occurrence is
    // unchanged, and the lease this tick took over stays held instead of being dropped.
    const after = leaseRow(p);
    expect(after.next_run_at).toBe(before.next_run_at);
    expect(after.lease_holder).not.toBeNull();
    expect(after.lease_holder).not.toBe('dead-loop');
    expect(leaseRow(p, 'trg-2').lease_holder).not.toBeNull();
    // MUTATION: release trg-1's lease in the catch → the next tick reads it `claimed` and
    // runs the lost run from the start. Without the release it lapses again, reads
    // `interrupted` again, and is still not run.
    vi.setSystemTime(T0 + 2 * MIN + 16 * MIN);
    await p.loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(p.dispatches()).toBe(1);
  });
});

describe('the claim predicate (TriggerStore.claimLease)', () => {
  // Asserted directly as well: the restart tests above see `held` and `interrupted` only
  // through what the loop does with them.
  it('grants a free lease, refuses a live one, and tells a lost run from a settled one', () => {
    const dir = newDir();
    const p = boot(dir);
    seedCron(p);
    const iso = (ms: number): string => new Date(ms).toISOString();
    expect(p.manager.claimLease('nope', 'h1', iso(T0 + MIN), iso(T0))).toBe('not_found');
    expect(p.manager.claimLease('trg-1', 'h1', iso(T0 + MIN), iso(T0))).toBe('claimed');
    // MUTATION: drop `row.lease_until > now` → a second holder takes a live lease.
    expect(p.manager.claimLease('trg-1', 'h2', iso(T0 + 2 * MIN), iso(T0 + 30_000))).toBe('held');
    expect(p.manager.renewLease('trg-1', 'h2', iso(T0 + 3 * MIN))).toBe(false);
    expect(p.manager.renewLease('trg-1', 'h1', iso(T0 + 3 * MIN))).toBe(true);
    // Lapsed, and the occurrence h1 ran is still the due one: h1 was lost mid-run.
    expect(p.manager.claimLease('trg-1', 'h2', iso(T0 + 5 * MIN), iso(T0 + 4 * MIN))).toBe('interrupted');
    // h1 cannot release what h2 now holds.
    p.manager.releaseLease('trg-1', 'h1');
    expect(leaseRow(p).lease_holder).toBe('h2');

    // Lapsed, but the run was settled meanwhile (a sweep moved next_run_at past the moment
    // h2 took it): a fresh occurrence, not a lost run.
    // MUTATION: drop the `next_run_at <= lease_since` term → this reads `interrupted`, and
    // a cron trigger whose parked run was swept would skip its next occurrence.
    p.history.updateTriggerRunResult('trg-1', { lastRunAt: iso(T0 + 6 * MIN), lastRunResult: 'swept', lastRunStatus: 'failed', nextRunAt: iso(T0 + 7 * MIN) });
    expect(p.manager.claimLease('trg-1', 'h3', iso(T0 + 20 * MIN), iso(T0 + 10 * MIN))).toBe('claimed');
    p.manager.releaseLease('trg-1', 'h3');
    expect(leaseRow(p).lease_holder).toBeNull();
    expect(p.manager.claimLease('trg-1', 'h4', iso(T0 + 30 * MIN), iso(T0 + 11 * MIN))).toBe('claimed');
  });

  it('the getDue lease clause keeps a held trigger out and lets a lapsed one back in', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const p = boot(newDir());
    seedCron(p);
    const iso = (ms: number): string => new Date(ms).toISOString();
    p.manager.claimLease('trg-1', 'h1', iso(T0 + MIN), iso(T0));
    // MUTATION: drop `AND (lease_until IS NULL OR lease_until <= ?)` from getDue → listed.
    expect(p.manager.getDueTriggers()).toEqual([]);
    vi.setSystemTime(T0 + 2 * MIN);
    expect(p.manager.getDueTriggers().map((t) => t.id)).toEqual(['trg-1']);
  });
});

describe('the heartbeat', () => {
  // The direction the lease fails in, measured rather than assumed: the heartbeat is a
  // timer, and a synchronous tool (`bash` runs `execSync`) blocks the event loop, so no
  // renewal happens for as long as the block lasts — however short the interval is set.
  // A lease shorter than the longest block lapses under a live run; the test above shows
  // what that leads to (an interrupted record, not a second run).
  it('renews on its interval, and not at all while the event loop is blocked', async () => {
    const dir = newDir();
    const a = boot(dir, { heartbeatMs: 20, ttlMs: 60 });
    seedCron(a);
    const renewals: number[] = [];
    const real = a.manager.renewLease.bind(a.manager);
    vi.spyOn(a.manager, 'renewLease').mockImplementation((...args) => { renewals.push(Date.now()); return real(...args); });
    await a.loop.tick();
    await vi.waitFor(() => expect(a.dispatches()).toBe(1));
    await vi.waitFor(() => expect(renewals.length).toBeGreaterThanOrEqual(3));

    const blockStart = Date.now();
    while (Date.now() - blockStart < 300) { /* a synchronous tool, e.g. execSync */ }
    const blockEnd = Date.now();
    const during = renewals.filter((t) => t > blockStart && t < blockEnd);
    expect(during).toEqual([]);
    // Right after the block the lease has lapsed although the run is alive.
    const row = leaseRow(a);
    expect(Date.parse(row.lease_until!)).toBeLessThan(blockEnd);
    // …and the next renewal restores it once the loop is free again.
    await vi.waitFor(() => expect(renewals.some((t) => t >= blockEnd)).toBe(true));
    expect(Date.parse(leaseRow(a).lease_until!)).toBeGreaterThan(blockEnd);

    a.finish();
    await vi.waitFor(() => expect(leaseRow(a).lease_holder).toBeNull());
  });
});

describe('a schedule deleted while its run is in flight', () => {
  // The delete route removes the row and leaves the run going; the run ends later and
  // records its result against a row that no longer exists. MUTATION: put the throw back
  // in TaskManager.recordTaskRun (`if (!task) throw …`) → the first test sees the rejection.
  it('ends without an unhandled rejection', async () => {
    const dir = newDir();
    const a = boot(dir);
    seedCron(a);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      await a.loop.tick();
      await vi.waitFor(() => expect(a.dispatches()).toBe(1));
      expect(a.history.deleteTrigger('trg-1')).toBe(true);

      a.finish();
      // Two macrotask turns: the run's settle chain and Node's rejection report.
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  // MUTATION: drop the row check from `willRetry` in WorkerLoop.executeTask → the run
  // counts on a retry its deleted row can no longer give, and no failure is reported.
  it('reports a failure that its deleted schedule can no longer retry', async () => {
    const dir = newDir();
    const a = boot(dir);
    a.history.insertTrigger({
      id: 'trg-1', title: 'One-off report', source: 'cron', effect: 'run_agent',
      nextRunAt: '2026-01-01T09:00:00.000Z', confirmedAt: '2026-01-01T00:00:00.000Z', maxRetries: 2,
    });
    a.router.hasChannels.mockReturnValue(true);
    await a.loop.tick();
    await vi.waitFor(() => expect(a.dispatches()).toBe(1));
    a.history.deleteTrigger('trg-1');
    a.fail(new Error('provider down'));
    await vi.waitFor(() => expect(a.router.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '\u2717 One-off report' })));
  });

  it('is reported by the heartbeat as deleted, not as a lease lost to another process', async () => {
    const dir = newDir();
    const a = boot(dir, { heartbeatMs: 20, ttlMs: 60 });
    seedCron(a);
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string' && chunk.includes('[lynox:worker]')) { lines.push(chunk); return true; }
      return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    try {
      await a.loop.tick();
      await vi.waitFor(() => expect(a.dispatches()).toBe(1));
      a.history.deleteTrigger('trg-1');
      // Several heartbeat intervals pass with the row gone.
      await new Promise((r) => setTimeout(r, 150));
      expect(lines.filter((l) => l.includes('lost its run lease'))).toEqual([]);
      expect(lines.filter((l) => l.includes('was deleted'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
      a.finish();
    }
  });
});
