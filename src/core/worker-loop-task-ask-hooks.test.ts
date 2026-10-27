/**
 * A scheduled task's question (`executeStandard`) reports whether its push reached anyone the way
 * a scheduled workflow's question does (`worker-loop-workflow-ask.test.ts`): written on the
 * trigger, and through `Engine.escalationReporter` to the hooks, so the managed hook can ask the
 * control plane to mail the owner. The engine is booted for real with the control plane's
 * environment, so the hook is the one `init()` registers; a test that handed a hook in itself
 * would stay green with the wiring line deleted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig, LynoxUserConfig, TriggerRecord } from '../types/index.js';
import type { NotificationRouter, NotificationMessage, DeliverySummary } from './notification-router.js';
import type { TaskManager } from './task-manager.js';
import type { Session } from './session.js';

const SESSION_ID = 'thread-task-question';
const ENV_KEYS = [
  'LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_VAULT_KEY',
] as const;

const dirs: string[] = [];
const engines: Engine[] = [];
const closers: Array<() => void> = [];
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  for (const c of closers.splice(0)) { try { c(); } catch { /* already gone */ } }
  for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
  vi.unstubAllGlobals();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  saved.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  reloadConfig();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function bootManaged(): Promise<{ engine: Engine; fetchSpy: ReturnType<typeof vi.fn> }> {
  const env: Record<string, string> = {
    LYNOX_DATA_DIR: tempDir('lynox-task-question-cp-'), LYNOX_BILLING_TIER: 'hosted',
    LYNOX_MANAGED_INSTANCE_ID: 'inst-tq', LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.test',
    LYNOX_HTTP_SECRET: 'tq-secret',
  };
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  const fetchSpy = vi.fn().mockImplementation(() =>
    Promise.resolve({ ok: true, json: async () => ({ allowed: true, spend_gate: 'unfunded' }) }));
  vi.stubGlobal('fetch', fetchSpy);
  reloadConfig();
  const engine = new Engine({} as LynoxConfig);
  engines.push(engine);
  await engine.init();
  return { engine, fetchSpy };
}

const escalationPosts = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter(([url]) => String(url).endsWith('/escalation'));

/** Whether `ok` holds within ~2 s. Returns rather than throws, so the assertion sits in the test. */
async function settles(ok: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  return ok();
}

const TASK: TriggerRecord = {
  id: 'task-q', title: 'Weekly order check', description: 'Check the open orders',
  status: 'open', assignee: 'lynox', scope_type: 'context', scope_id: '',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  schedule_cron: '0 9 * * *', next_run_at: '2026-01-01T09:00:00.000Z',
  source: 'cron', effect: 'run_agent', confirmed_at: '2026-01-01T00:00:00.000Z',
};

/** Starts the task, whose agent turn asks its owner and parks; resolves once the question is pushed. */
async function askingTask(o: { reporter: Engine['escalationReporter']; pushOutcome: 'delivered' | 'failed' | 'reached_others' }): Promise<{
  outcomes: Array<[string, DeliverySummary]>;
  starts: string[];
  notified: NotificationMessage[];
}> {
  const history = new RunHistory(join(tempDir('lynox-task-question-'), 'history.db'));
  closers.push(() => { history.close(); });
  const promptStore = new PromptStore(history.getDb());
  const outcomes: Array<[string, DeliverySummary]> = [];
  const starts: string[] = [];
  const taskManager = {
    getDueTriggers: vi.fn(() => [TASK]),
    getExpiredWaitingTriggers: vi.fn(() => []),
    getWaitingTriggers: vi.fn(() => []),
    endWait: vi.fn(() => false),
    claimLease: vi.fn(() => 'claimed'),
    renewLease: vi.fn(() => true),
    releaseLease: vi.fn(),
    getTrigger: vi.fn((id: string) => (id === TASK.id ? TASK : undefined)),
    recordTaskRun: vi.fn(),
    setEnabled: vi.fn(() => true),
    startEscalation: vi.fn((id: string) => { starts.push(id); return true; }),
    recordEscalationOutcome: vi.fn((id: string, outcome: DeliverySummary) => { outcomes.push([id, outcome]); return true; }),
  } as unknown as TaskManager;
  const session = {
    sessionId: SESSION_ID, _recreateAgent: vi.fn(), getAgent: () => null, getLastRunStop: () => null,
    promptUser: undefined as ((q: string, opts?: string[]) => Promise<string>) | undefined,
    run: vi.fn(async () => {
      await session.promptUser!('Which supplier?', ['A', 'B']);
      return 'Done.';
    }),
  };
  const engine = {
    getTaskManager: vi.fn(() => taskManager),
    createSession: vi.fn(() => session as unknown as Session),
    getThreadStore: vi.fn(() => ({ isDeleted: () => false })),
    getPromptStore: vi.fn(() => promptStore),
    getRunHistory: vi.fn(() => null),
    getUserConfig: vi.fn(() => ({})), escalateToUser: vi.fn(() => null), workerRunModelOverride: vi.fn(() => ({})),
    escalationReporter: o.reporter,
    getSecretStore: vi.fn(() => null),
    getMandateEnds: vi.fn(() => ({ isLive: () => true })),
    getAuditLog: vi.fn(() => ({ record: vi.fn() })),
    getToolContext: vi.fn(() => ({ containment: null })),
  } as unknown as Engine;
  const notified: NotificationMessage[] = [];
  const router = {
    hasChannels: () => true,
    notify: vi.fn(async (msg: NotificationMessage) => { notified.push(msg); return [{ channel: 'push', outcome: o.pushOutcome }]; }),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.unshift(() => { loop.stop(); });
  await loop.tick();
  if (!await settles(() => notified.some((m) => m.inquiry !== undefined))) throw new Error('the task never pushed its question');
  return { outcomes, starts, notified };
}

describe('a scheduled task question on an instance the control plane runs', () => {
  it('one whose push reached nobody is written on the trigger and reported to the control plane', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const h = await askingTask({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'failed' });
    expect(await settles(() => h.outcomes.length > 0)).toBe(true);
    expect(h.starts).toEqual([TASK.id]);
    expect(h.outcomes).toEqual([[TASK.id, 'not_delivered']]);
    expect(await settles(() => escalationPosts(fetchSpy).length > 0)).toBe(true);
    const posts = escalationPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe('https://cp.test/internal/usage/inst-tq/escalation');
  });

  // The trigger view tells the owner that none of their devices received it: true here as well.
  it('one whose push reached only a mandate\'s device is written as reaching nobody and reported to the control plane', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const h = await askingTask({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'reached_others' });
    expect(await settles(() => h.outcomes.length > 0)).toBe(true);
    expect(h.outcomes).toEqual([[TASK.id, 'not_delivered']]);
    expect(await settles(() => escalationPosts(fetchSpy).length > 0)).toBe(true);
    expect(escalationPosts(fetchSpy)).toHaveLength(1);
  });

  it('one whose push reached the owner is written on the trigger and reported to no one', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const h = await askingTask({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'delivered' });
    expect(await settles(() => h.outcomes.length > 0)).toBe(true);
    expect(h.outcomes).toEqual([[TASK.id, 'delivered']]);
    // The hook has heard of the delivery by now: it runs right after the record, synchronously.
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });

  it('one that reached nobody after the owner switched the mail off is written on the trigger and reported to no one', async () => {
    const { engine, fetchSpy } = await bootManaged();
    (engine as unknown as { userConfig: LynoxUserConfig }).userConfig = { ...engine.getUserConfig(), escalation_mail: false };
    const h = await askingTask({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'failed' });
    expect(await settles(() => h.outcomes.length > 0)).toBe(true);
    expect(h.outcomes).toEqual([[TASK.id, 'not_delivered']]);
    // Same timing as above: with the switch on, the POST would be visible by now.
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });
});
