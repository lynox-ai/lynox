import { it, expect, vi } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import type { Engine } from './engine.js';
import type { TaskManager } from './task-manager.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';

/**
 * A bulk write that ends with a summary too long for a push carries a short version: the run
 * result keeps the summary (the way included, for the history and the model), the push says
 * the short one. Without a short version, the push says the summary.
 */

const outcome = vi.hoisted(() => ({ value: { status: 'refused', summary: '' } as { status: 'refused'; summary: string; pushSummary?: string } }));
vi.mock('./bulk-apply.js', async (orig) => ({
  ...(await orig<typeof import('./bulk-apply.js')>()),
  runBulkEffect: async () => outcome.value,
}));

const FULL = 'lynox wrote nothing. The full sentence, with the way to fix it, for the history.';
const SHORT = 'lynox wrote nothing. The short one for a push.';

async function runOnce(): Promise<{ records: string[]; notes: string[] }> {
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
    getEngineDb: () => null,
    getMandateEnds: () => null,
    config: {},
  } as unknown as Engine;
  const router = {
    hasChannels: () => true,
    notify: async (n: { title: string; body: string }) => { notes.push(n.body); },
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  try {
    await loop.tick();
    await vi.waitFor(() => { if (records.length === 0 || notes.length === 0) throw new Error('not yet'); }, { timeout: 5_000, interval: 10 });
  } finally {
    loop.stop();
  }
  return { records, notes };
}

it('records the summary and pushes the short version when the write gives one', async () => {
  outcome.value = { status: 'refused', summary: FULL, pushSummary: SHORT };
  const { records, notes } = await runOnce();
  expect(records.join('\n')).toContain(FULL);
  expect(notes.join('\n')).toContain(SHORT);
  expect(notes.join('\n')).not.toContain(FULL);
});

it('pushes the summary itself when the write gives no short version', async () => {
  outcome.value = { status: 'refused', summary: FULL };
  const { records, notes } = await runOnce();
  expect(records.join('\n')).toContain(FULL);
  expect(notes.join('\n')).toContain(FULL);
});
