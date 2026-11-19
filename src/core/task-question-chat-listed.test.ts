// When a background task asks its owner a question, the chat it asks in is already in the
// chat list and marked as waiting: the mail that tells the owner a run is waiting sends them
// to the chat list, so the run's chat has to be findable there at the moment it asks.
//
// Driven through a REAL Engine, Session, Agent, ThreadStore and WorkerLoop; only the
// provider is stubbed (its one turn calls `ask_user`), and the task manager and the
// notification router are stand-ins.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockProcess } = vi.hoisted(() => ({ mockProcess: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: () => ({}) } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { Engine } from './engine.js';
import { WorkerLoop } from './worker-loop.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig, TriggerRecord } from '../types/index.js';
import type { NotificationMessage, NotificationRouter } from './notification-router.js';
import type { TaskManager } from './task-manager.js';

const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_EMBEDDING_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
const engines: Engine[] = [];
const loops: WorkerLoop[] = [];

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function boot(): Promise<Engine> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-tqcl-'));
  dirs.push(dir);
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('LYNOX_DATA_DIR', dir);
  setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  return engine;
}

afterEach(async () => {
  for (const l of loops.splice(0)) l.stop();
  for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  reloadConfig();
}, 30_000);

async function waitUntil(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a background task that asks its owner', { timeout: 60_000 }, () => {
  it('asks in a chat that is in the chat list and waiting for an answer', async () => {
    const engine = await boot();
    mockProcess.mockResolvedValueOnce({
      content: [{ type: 'tool_use' as const, id: 'tu-ask', name: 'ask_user', input: { question: 'Which list should the report use?' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const task = {
      id: 'trg-asks', title: 'Daily report', description: 'Ask which list, then report', status: 'open', assignee: 'lynox',
      scope_type: 'context', scope_id: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      schedule_cron: '0 9 * * *', next_run_at: '2026-01-01T09:00:00.000Z', source: 'cron', effect: 'run_agent',
      confirmed_at: '2026-01-01T00:00:00.000Z',
    } as unknown as TriggerRecord;
    let dispatched = false;
    const manager = {
      getDueTriggers: () => (dispatched ? [] : (dispatched = true, [task])),
      getExpiredWaitingTriggers: () => [],
      getWaitingTriggers: () => [],
      getAwaitingConsentUnreminded: () => [],
      endWait: () => false,
      claimLease: () => 'claimed',
      renewLease: () => true,
      releaseLease: () => {},
      getTrigger: (id: string) => (id === task.id ? task : undefined),
      recordTaskRun: () => false,
      setEnabled: () => true,
      startEscalation: () => true,
      recordEscalationOutcome: () => {},
    } as unknown as TaskManager;
    // The real engine for everything the run touches, except the task manager.
    const host = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getTaskManager') return () => manager;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

    // What the chat list and its marks read at the moment the question goes out.
    let seen: { listed: boolean; messageCount: number; waiting: boolean } | undefined;
    const router = {
      hasChannels: () => true,
      notify: vi.fn(async (msg: NotificationMessage) => {
        // Only the question; the loop also sends other notices (a missed run, the result).
        if (msg.inquiry === undefined) return [{ channel: 'push', outcome: 'delivered' as const }];
        const threadId = (msg.data as { threadId: string }).threadId;
        const store = engine.getThreadStore()!;
        seen = {
          listed: store.listThreads().some((t) => t.id === threadId),
          messageCount: store.getThread(threadId)?.message_count ?? 0,
          waiting: (engine.getPromptStore()?.listPendingSessions() ?? []).some((p) => p.session_id === threadId),
        };
        return [{ channel: 'push', outcome: 'failed' as const }];
      }),
    } as unknown as NotificationRouter;

    const loop = new WorkerLoop(host, router, 60_000);
    loops.push(loop);
    void loop.tick();
    await waitUntil('the question to go out', () => seen !== undefined);

    expect(seen!.listed).toBe(true);
    expect(seen!.messageCount).toBeGreaterThan(0);
    expect(seen!.waiting).toBe(true);
  });
});
