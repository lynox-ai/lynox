/**
 * A background task's question reports whether its push reached anyone, as a scheduled workflow
 * question's does (`worker-loop-workflow-ask.test.ts`): onto the trigger, and through the
 * engine's `escalationReporter` to the hooks, so on an instance the control plane runs a push
 * that reached nobody asks the control plane to mail the owner.
 *
 * The engine whose reporter the loop calls is booted for real with the control plane's
 * environment, so the hook is the one `init()` registers; a test that handed a hook in itself
 * would stay green with the wiring line deleted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig, TriggerRecord } from '../types/index.js';
import type { NotificationRouter, NotificationMessage } from './notification-router.js';
import type { TaskManager } from './task-manager.js';
import type { Session } from './session.js';

const cleanups: Array<() => void> = [];
const loops: WorkerLoop[] = [];
const engines: Engine[] = [];
const ENV_KEYS = [
  'LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_VAULT_KEY',
] as const;
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  for (const l of loops.splice(0)) l.stop();
  for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
  vi.unstubAllGlobals();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  saved.clear();
  for (const c of cleanups.splice(0)) c();
  reloadConfig();
});

async function waitUntil(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** An engine booted with the control plane's environment, and every fetch it makes. */
async function bootManaged(): Promise<{ engine: Engine; fetchSpy: ReturnType<typeof vi.fn> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-task-question-cp-'));
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  const env: Record<string, string> = {
    LYNOX_DATA_DIR: dir, LYNOX_BILLING_TIER: 'hosted', LYNOX_MANAGED_INSTANCE_ID: 'inst-tq',
    LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.test', LYNOX_HTTP_SECRET: 'tq-secret',
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

/** A scheduled agent task that asks its owner one question, run by a loop whose push reports `pushOutcome`. */
function runAskingTask(reporter: Engine['escalationReporter'], pushOutcome: 'delivered' | 'failed'): { deliveries: string[]; prompts: PromptStore } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-task-question-'));
  const history = new RunHistory(join(dir, 'history.db'));
  cleanups.push(() => { try { history.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const prompts = new PromptStore(history.getDb());

  const task = {
    id: 'trg-task-asks', title: 'Daily report', description: 'Ask which list, then report', status: 'open', assignee: 'lynox',
    scope_type: 'context', scope_id: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    schedule_cron: '0 9 * * *', next_run_at: '2026-01-01T09:00:00.000Z', source: 'cron', effect: 'run_agent',
    confirmed_at: '2026-01-01T00:00:00.000Z',
  } as unknown as TriggerRecord;
  const deliveries: string[] = [];
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
    recordEscalationOutcome: (_id: string, delivery: string) => { deliveries.push(delivery); },
  } as unknown as TaskManager;
  const session = {
    sessionId: 'thread-task-asks',
    _recreateAgent: vi.fn(),
    getAgent: () => null,
    getLastRunStop: () => null,
    promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
    run: vi.fn(async () => { await session.promptUser!('Which list?', ['A', 'B']); return 'Done.'; }),
  };
  const engine = {
    getTaskManager: () => manager,
    createSession: () => session as unknown as Session,
    getThreadStore: () => ({ isDeleted: () => false }),
    getPromptStore: () => prompts,
    getRunHistory: () => history,
    getUserConfig: () => ({}),
    escalateToUser: () => null,
    workerRunModelOverride: () => ({}),
    getSecretStore: () => null,
    escalationReporter: reporter,
    getMandateEnds: () => ({ isLive: () => true }),
    getAuditLog: () => ({ record: () => {} }),
    getToolContext: () => ({ containment: null }),
    getEngineDb: () => null,
  } as unknown as Engine;
  const router = {
    hasChannels: () => true,
    notify: vi.fn(async (_msg: NotificationMessage) => [{ channel: 'push', outcome: pushOutcome }]),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  loops.push(loop);
  void loop.tick();
  return { deliveries, prompts };
}

describe('a background task question on an instance the control plane runs', () => {
  it('one whose push reached nobody is recorded on the trigger and reported to the control plane, as a workflow question is', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const run = runAskingTask(engine.escalationReporter.bind(engine), 'failed');
    await waitUntil('the question to be asked', () => run.prompts.getPending('thread-task-asks') !== undefined);
    await waitUntil('the delivery to be recorded on the trigger', () => run.deliveries.length > 0);
    expect(run.deliveries).toEqual(['not_delivered']);
    await waitUntil('the report to the control plane', () => escalationPosts(fetchSpy).length > 0);
    const posts = escalationPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe('https://cp.test/internal/usage/inst-tq/escalation');
    // A class signal and nothing else: the question stays on the instance.
    expect(JSON.parse(String((posts[0]![1] as { body: string }).body))).toEqual({ kind: 'escalation' });
  });

  it('one whose push reached the owner is recorded and not reported', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const run = runAskingTask(engine.escalationReporter.bind(engine), 'delivered');
    await waitUntil('the delivery to be recorded on the trigger', () => run.deliveries.length > 0);
    expect(run.deliveries).toEqual(['delivered']);
    await new Promise((r) => { setTimeout(r, 50); });
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });
});
