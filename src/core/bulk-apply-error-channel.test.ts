import { it, expect, afterEach, vi } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import type { Engine } from './engine.js';
import type { TaskManager } from './task-manager.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * `executeBulk`'s inner catch (PRD bulk-loop §3.1, error classes): an error
 * thrown inside a bulk write leaves the worker as a fixed text, and reaches the tracker as its
 * class only. Today nothing inside throws a target's text; this holds the channel shut for when
 * something does.
 */

const captured = vi.hoisted(() => [] as Error[]);
vi.mock('./error-reporting.js', async (orig) => ({
  ...(await orig<typeof import('./error-reporting.js')>()),
  captureError: (err: unknown) => { captured.push(err as Error); },
}));
const MARK = vi.hoisted(() => 'ZXQ-TARGET-CONTENT-91c2');
vi.mock('./bulk-apply.js', async (orig) => ({
  ...(await orig<typeof import('./bulk-apply.js')>()),
  runBulkEffect: async () => { throw new Error(`write failed on "${MARK}"`); },
}));

afterEach(() => { vi.restoreAllMocks(); captured.length = 0; });

it('a bulk write that throws: the run result and the notification carry a fixed text, the tracker the class', async () => {
  const records: string[] = [];
  const notes: string[] = [];
  const task = {
    id: 'trg-apply', title: 'Apply', description: '', status: 'open', assignee: 'lynox', scope_type: 'context', scope_id: '',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', next_run_at: '2026-01-01T09:00:00.000Z',
    source: 'cron', effect: 'bulk_apply', confirmed_at: '2026-01-01T00:00:00.000Z', bulk_run_id: 'run-1',
  } as unknown as TriggerRecord;
  let due = true;
  const manager = {
    getDueTriggers: () => (due ? (due = false, [task]) : []),
    getExpiredWaitingTriggers: () => [], endWait: () => false, claimLease: () => 'claimed', renewLease: () => true,
    releaseLease: () => { /* none */ }, getTrigger: () => task,
    recordTaskRun: (_id: string, result: string) => { records.push(result); }, setEnabled: () => true,
  } as unknown as TaskManager;
  const engine = {
    getTaskManager: () => manager,
    getRunHistory: () => ({ getTrigger: () => task, updateTrigger: () => { /* none */ } }),
    getUserConfig: () => ({}), workerRunModelOverride: () => ({}), escalateToUser: () => null, getPromptStore: () => null,
    getSecretStore: () => null, getDataStore: () => null, getApiStore: () => null, getToolContext: () => ({ containment: null }),
    getBackupManager: () => null, getHooks: () => [], getContext: () => null,
    getBulkLedger: () => ({ getRunForApply: () => ({ targetSystem: 'data_store' }) }),
  } as unknown as Engine;
  const router = {
    hasChannels: () => true,
    notify: async (n: { title: string; body: string }) => { notes.push(`${n.title}\n${n.body}`); },
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  try {
    await loop.tick();
    await vi.waitFor(() => { if (records.length === 0 || captured.length === 0) throw new Error('not yet'); }, { timeout: 5_000, interval: 10 });
  } finally {
    loop.stop();
  }
  // Positive control: the write did fail, and its record says so.
  expect(records.join('\n')).toContain('The bulk write stopped on an error inside lynox.');
  expect(captured.some((e) => e.message === 'bulk_apply failed: Error')).toBe(true);
  for (const text of [...records, ...notes, ...captured.map((e) => `${e.message} ${String(e.stack)}`)]) {
    expect(text).not.toContain(MARK);
  }
});
