import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { RunAbortedError } from './agent.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { NotificationRouter } from './notification-router.js';

/**
 * What a run of a due trigger does around its effect, pinned before that frame is shared with
 * the webhook drain: it holds the trigger's lease until the result
 * is recorded and gives it up however the run ended, it records the end on the trigger, and the
 * owner's stop ends it as stopped. Against a real engine database: the lease and the recorded
 * end are rows, not calls.
 */

const T0 = Date.parse('2026-01-01T09:00:30.000Z');

const dirs: string[] = [];
const closers: Array<() => void> = [];
const releases: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const r of releases.splice(0)) r();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Proc {
  loop: WorkerLoop;
  history: RunHistory;
  engineDb: EngineDb;
  released: () => number;
  dispatches: () => number;
  finish: (result?: string) => void;
  fail: (error: Error) => void;
}

/** One engine whose agent turns hang until `finish`, `fail` or a stop ends them. */
function boot(): Proc {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  let released = 0;
  const realRelease = manager.releaseLease.bind(manager);
  manager.releaseLease = (...a) => { realRelease(...a); released++; };
  const pending: Array<(r: string) => void> = [];
  const failing: Array<(e: Error) => void> = [];
  const run = vi.fn(() => new Promise<string>((resolve, reject) => { pending.push(resolve); failing.push(reject); }));
  releases.push(() => { for (const r of pending.splice(0)) r('released'); });
  const fail = (error: Error): void => { pending.splice(0); for (const r of failing.splice(0)) r(error); };
  // The agent's own abort: what `Agent.send` throws when its controller was aborted.
  const session = {
    sessionId: 'thread-slot', _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null, promptUser: undefined, run,
    abort: () => fail(new RunAbortedError()),
  };
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
    getToolContext: () => ({ containment: null }),
    getEngineDb: () => null,
    getMandateEnds: () => null,
  } as unknown as Engine;
  const router = { hasChannels: vi.fn(() => false), notify: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  return {
    loop, history, engineDb,
    released: () => released,
    dispatches: () => run.mock.calls.length,
    finish: (result = 'done') => { failing.splice(0); for (const r of pending.splice(0)) r(result); },
    fail,
  };
}

function seedCron(p: Proc): void {
  p.history.insertTrigger({
    id: 'trg-1', title: 'Daily report', source: 'cron', effect: 'run_agent',
    scheduleCron: '0 9 * * *', nextRunAt: '2026-01-01T09:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  });
}

function row(p: Proc): { lease_holder: string | null; status: string; last_run_status: string | null; next_run_at: string | null } {
  return p.engineDb.getDb().prepare('SELECT lease_holder, status, last_run_status, next_run_at FROM triggers WHERE id = ?')
    .get('trg-1') as { lease_holder: string | null; status: string; last_run_status: string | null; next_run_at: string | null };
}

async function started(): Promise<Proc> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const p = boot();
  seedCron(p);
  await p.loop.tick();
  await vi.waitFor(() => expect(p.dispatches()).toBe(1));
  expect(row(p).lease_holder).not.toBeNull();
  return p;
}

describe('the frame around a due trigger\'s run', () => {
  it('holds the lease while it runs, records the success, then gives the lease up', async () => {
    const written = vi.spyOn(process.stderr, 'write');
    const p = await started();
    p.finish('the report');
    await vi.waitFor(() => expect(p.released()).toBe(1));
    expect(row(p)).toMatchObject({ lease_holder: null, status: 'open', last_run_status: 'success' });
    // The cron moved on before the row was free.
    expect(row(p).next_run_at).not.toBe('2026-01-01T09:00:00.000Z');
    // A run with no event writes no event outcome, and so cannot fail to.
    expect(written.mock.calls.some((c) => String(c[0]).includes('could not record the outcome'))).toBe(false);
    written.mockRestore();
  });

  it('records a throw as failed on the trigger and still gives the lease up', async () => {
    const p = await started();
    p.fail(new Error('provider down'));
    await vi.waitFor(() => expect(p.released()).toBe(1));
    expect(row(p)).toMatchObject({ lease_holder: null, status: 'failed', last_run_status: 'failed' });
  });

  it('ends the run as stopped on the owner\'s stop, and gives the lease up', async () => {
    const p = await started();
    expect(p.loop.stopTask('trg-1')).toEqual({ kind: 'requested', via: 'session' });
    await vi.waitFor(() => expect(p.released()).toBe(1));
    expect(row(p)).toMatchObject({ lease_holder: null, last_run_status: 'stopped' });
  });

  it('CONTROL: the lease is held until the run ends', async () => {
    const p = await started();
    await Promise.resolve();
    expect(p.released()).toBe(0);
    expect(row(p).lease_holder).not.toBeNull();
    p.finish();
    await vi.waitFor(() => expect(p.released()).toBe(1));
  });
});
