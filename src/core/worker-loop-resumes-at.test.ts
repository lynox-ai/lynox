import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { TriggerStore } from './trigger-store.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';

// A run whose process is gone stands still until its lease lapses (15 minutes); the owner's
// view says when it is picked up again. A run that is running must not read as standing still.

const TTL = 15 * 60_000;
const HEARTBEAT = 30_000;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function harness(): { loop: WorkerLoop; manager: TaskManager; triggerId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-resumes-at-'));
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  cleanups.push(() => { history.close(); engineDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const manager = new TaskManager(history);
  const triggerId = new TriggerStore(engineDb).armBulkEffect({
    runId: 'run-1', effect: 'bulk_apply', title: 'Bulk run', nextRunAt: new Date().toISOString(),
  });
  const engine = { getTaskManager: () => manager } as unknown as Engine;
  const loop = new WorkerLoop(engine, {} as NotificationRouter, 60_000, undefined, { heartbeatMs: HEARTBEAT, ttlMs: TTL });
  return { loop, manager, triggerId };
}

/** Another holder's lease, last renewed `ago` ms before `now`. */
function leaseByOther(manager: TaskManager, id: string, now: number, ago: number): string {
  const until = new Date(now - ago + TTL).toISOString();
  expect(manager.claimLease(id, 'a-process-that-is-gone', until, new Date(now - ago).toISOString())).not.toBe('held');
  return until;
}

describe('WorkerLoop.resumesAt', () => {
  it('names the end of a lease its holder stopped renewing', () => {
    const { loop, manager, triggerId } = harness();
    const now = Date.now();
    const until = leaseByOther(manager, triggerId, now, 3 * HEARTBEAT);
    expect(loop.resumesAt(triggerId, now)).toBe(until);
  });

  it('is null while the holder still renews it — another process is running the run', () => {
    const { loop, manager, triggerId } = harness();
    const now = Date.now();
    leaseByOther(manager, triggerId, now, HEARTBEAT);
    expect(loop.resumesAt(triggerId, now)).toBeNull();
  });

  it('is null for a lease this loop holds — its run is running', async () => {
    const { loop, manager, triggerId } = harness();
    const now = Date.now();
    // Take the lease as this loop does, then let it go stale: still this loop's own run.
    const holder = (loop as unknown as { leaseHolder: string }).leaseHolder;
    expect(manager.claimLease(triggerId, holder, new Date(now - 3 * HEARTBEAT + TTL).toISOString(), new Date(now - 3 * HEARTBEAT).toISOString())).toBe('claimed');
    expect(loop.resumesAt(triggerId, now)).toBeNull();
  });

  it('is null for a free trigger, a lapsed lease and an unknown trigger', () => {
    const { loop, manager, triggerId } = harness();
    const now = Date.now();
    expect(loop.resumesAt(triggerId, now)).toBeNull();
    leaseByOther(manager, triggerId, now, TTL + 1_000);
    expect(loop.resumesAt(triggerId, now)).toBeNull();
    expect(loop.resumesAt('bulk-no-such-run', now)).toBeNull();
  });
});
