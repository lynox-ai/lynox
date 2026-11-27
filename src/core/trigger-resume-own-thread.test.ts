import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriggerRecord } from '../types/index.js';
import type { TaskManager } from './task-manager.js';
import type { PromptStore } from './prompt-store.js';
import type { NotificationRouter } from './notification-router.js';
import type { Engine } from './engine.js';

/**
 * A run for a mandate that picks up an answer given in a conversation the mandate does not own
 * does not write into that conversation. The worker's choice of thread is checked here through a
 * REAL engine, session and thread store (the model stream stubbed, as in
 * `owner-continues-helper-thread.test.ts`), so the proof is what lands in the store, not which
 * id a mock was handed.
 */

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

const endTurn = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 10 },
});

const EVA_TAG = 'mandate:eva@kanzlei.example';

/** A plan Eva shaped and the owner stamped: it runs for Eva (`planOf`). */
const plan: TriggerRecord = {
  id: 'plan-eva', title: 'Weekly report', description: 'Write the weekly report', status: 'open', assignee: 'lynox',
  scope_type: 'context', scope_id: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  schedule_cron: '0 9 * * 1', next_run_at: '2026-01-01T09:00:00.000Z', source: 'cron', effect: 'run_agent',
  confirmed_at: '2026-01-01T00:00:00.000Z', created_by: EVA_TAG, created_mandate_id: 'TEST-GRANT-EVA',
} as unknown as TriggerRecord;

describe('a mandate\'s run that picks up an answer from a conversation it does not own', { timeout: 45_000 }, () => {
  let dataDir = '';
  let prevDataDir: string | undefined;
  const engines: Engine[] = [];

  beforeEach(async () => {
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    dataDir = await mkdtemp(join(tmpdir(), 'lynox-resume-own-'));
    process.env['LYNOX_DATA_DIR'] = dataDir;
    mockProcess.mockReset();
    mockProcess.mockResolvedValue(endTurn('Report written.'));
  });

  afterEach(async () => {
    for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Boots a real engine, opens the conversation `threadId` for `createdBy` with one turn in it,
   * and runs Eva's plan once after its question was answered there. Returns the thread store.
   */
  async function resumeIn(threadId: string, createdBy: string) {
    const { Engine } = await import('./engine.js');
    const { WorkerLoop } = await import('./worker-loop.js');
    const engine = new Engine({ model: 'balanced', context: { id: 'resume-own', name: 'resume-own', source: 'cli', workspaceDir: '' } });
    engines.push(engine);
    await engine.init();
    const threads = engine.getThreadStore()!;
    threads.createThread(threadId, { created_by: createdBy });
    threads.appendMessages(threadId, [{ role: 'user', content: 'Which week?' }, { role: 'assistant', content: 'Asked.' }], 0);
    const before = new Set(threads.listThreadsForExport({ limit: 1000 }).map((t) => t.id));

    let dispatched = false;
    const recorded: string[] = [];
    const manager = {
      getDueTriggers: () => (dispatched ? [] : (dispatched = true, [plan])),
      getExpiredWaitingTriggers: () => [], getWaitingTriggers: () => [], getAwaitingConsentUnreminded: () => [],
      endWait: () => false, claimLease: () => 'claimed', renewLease: () => true, releaseLease: () => {},
      getTrigger: (id: string) => (id === plan.id ? plan : undefined),
      recordTaskRun: (_id: string, result: string) => { recorded.push(result); return false; },
      setEnabled: () => true,
    } as unknown as TaskManager;
    const answered = {
      getAnsweredForTrigger: () => ({
        id: 'prompt-1', session_id: threadId, question: 'Which week?', answer: 'Last week.', created_by: 'owner',
      }),
      releaseTrigger: () => {},
      getPendingForTrigger: () => undefined,
    } as unknown as PromptStore;
    // The real engine, with the plan's schedule and the answered row put in front of it.
    const worker = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getTaskManager') return () => manager;
        if (prop === 'getPromptStore') return () => answered;
        if (prop === 'getMandateEnds') return () => ({ isLive: () => true });
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const router = { hasChannels: () => false, notify: vi.fn(async () => []) } as unknown as NotificationRouter;
    const loop = new WorkerLoop(worker, router, 60_000);
    try {
      await loop.tick();
      for (let i = 0; i < 400 && recorded.length === 0; i++) await new Promise((r) => { setTimeout(r, 10); });
    } finally {
      loop.stop();
    }
    expect(recorded, 'the run ended').toHaveLength(1);
    const added = threads.listThreadsForExport({ limit: 1000 }).filter((t) => !before.has(t.id));
    return { threads, added };
  }

  it('leaves the owner\'s conversation as it was and writes the run into a new one of Eva\'s', async () => {
    const { threads, added } = await resumeIn('thread-owner', 'owner');
    expect(threads.getMessages('thread-owner'), 'nothing appended to the owner\'s conversation').toHaveLength(2);
    expect(added, 'one new conversation').toHaveLength(1);
    expect(added[0]!.created_by, 'opened for Eva').toBe(EVA_TAG);
    const written = threads.getMessages(added[0]!.id).map((m) => JSON.stringify(m));
    expect(written.length, 'the run wrote there').toBeGreaterThan(0);
    expect(written.some((m) => m.includes('Last week.')), 'with the answer as input').toBe(true);
  });

  it('control: continues in Eva\'s own conversation', async () => {
    const { threads, added } = await resumeIn('thread-eva', EVA_TAG);
    expect(added, 'no new conversation').toHaveLength(0);
    expect(threads.getMessages('thread-eva').length, 'the run wrote into it').toBeGreaterThan(2);
  });
});
