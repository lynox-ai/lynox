/**
 * A scheduled workflow whose steps ask the owner (PRD 3b-2 §6), through the real worker loop:
 * the dispatch, the mode and consent gates, the run entry, the deadline and the stop all run for
 * real, over a real prompt store and thread store.
 *
 * ⛔ The saved-workflow runner is replaced, and it stands BELOW the claim: what the loop hands it
 * (the question channel, its state, the run id) is the subject, and the replacement plays one
 * step that asks through exactly that channel. The runner's own halt on an unanswered question
 * is witnessed in `runner.test.ts`, the step's time limit in `runtime-adapter.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { ThreadStore } from './thread-store.js';
import type { Engine } from './engine.js';
import type { NotificationRouter, NotificationMessage } from './notification-router.js';
import type { TaskManager } from './task-manager.js';
import type { TriggerRecord, PlannedPipeline } from '../types/index.js';
import type { SubAgentPromptHandles } from '../orchestrator/runtime-adapter.js';
import type { WorkflowQuestionWait } from './workflow-questions.js';
import { getPipelineStore } from '../tools/builtin/pipeline.js';
import { WORKFLOW_STOPPED_ERROR, WORKFLOW_QUESTION_UNANSWERED_ERROR } from '../orchestrator/workflow-stop.js';

interface RunOpts {
  runId?: string;
  parentPrompt?: SubAgentPromptHandles;
  questionWait?: WorkflowQuestionWait;
  stopSignal?: AbortSignal;
}

/** The step the replaced runner plays: it gets what the loop handed over and answers like the runner. */
const wf = vi.hoisted(() => ({
  calls: [] as RunOpts[],
  step: undefined as ((opts: RunOpts) => Promise<Record<string, unknown>>) | undefined,
}));
vi.mock('./saved-workflow-runner.js', () => ({
  runGuardedSavedWorkflow: async (_engine: unknown, _id: unknown, _params: unknown, opts: RunOpts) => {
    wf.calls.push(opts);
    return wf.step!(opts);
  },
}));

/** What the runner would end the run with, read off the run as the runner reads it. */
function runnerResult(opts: RunOpts, answers: string[]): Record<string, unknown> {
  if (opts.stopSignal?.aborted === true) return { ok: true, status: 'failed', error: WORKFLOW_STOPPED_ERROR, runId: opts.runId };
  if (opts.questionWait?.unanswered === true) return { ok: true, status: 'failed', error: WORKFLOW_QUESTION_UNANSWERED_ERROR, runId: opts.runId };
  return { ok: true, status: 'completed', runId: opts.runId, answers };
}

/** One step that asks once, or `count` times one after the other, after `delayMs`. */
function askingStep(answers: string[], o?: { delayMs?: number; count?: number }): (opts: RunOpts) => Promise<Record<string, unknown>> {
  return async (opts) => {
    for (let i = 0; i < (o?.count ?? 1); i++) {
      if (o?.delayMs !== undefined) await new Promise((r) => { setTimeout(r, o.delayMs); });
      const ask = opts.parentPrompt?.parentAskUserPrompt;
      if (!ask) return { ok: false, error: 'the step had no question channel' };
      answers.push(await ask(`Which list (${i + 1})?`, ['A', 'B'], { stepId: 'pick', workflowName: 'Weekly offer' }));
    }
    return runnerResult(opts, answers);
  };
}

const cleanups: Array<() => void> = [];
const loops: WorkerLoop[] = [];
afterEach(async () => {
  for (const l of loops.splice(0)) l.stop();
  await new Promise((r) => { setTimeout(r, 20); });
  while (cleanups.length > 0) cleanups.pop()!();
  wf.calls.length = 0;
  wf.step = undefined;
});

async function waitUntil(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => { setTimeout(r, 5); });
  }
}

interface Harness {
  loop: WorkerLoop;
  prompts: PromptStore;
  threads: ThreadStore;
  records: Array<[string, string, string]>;
  escalations: () => number;
  deliveries: string[];
  parks: unknown[];
  leaseReleases: () => number;
  notified: NotificationMessage[];
}

function makeHarness(o?: { taskTimeoutMs?: number; steps?: PlannedPipeline['steps'] }): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-wfask-'));
  const history = new RunHistory(join(dir, 'history.db'));
  cleanups.push(() => { try { history.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const prompts = new PromptStore(history.getDb());
  const threads = new ThreadStore(history.getDb());

  // In the module cache, as `worker-loop-stop.test.ts` does: a trigger in the store would have
  // its workflow link nulled by an FK this file cannot satisfy.
  getPipelineStore().set('wf-asks', {
    id: 'wf-asks', name: 'Weekly offer', mode: 'interactive', confirmedAt: '2026-01-01T00:00:00.000Z',
    steps: o?.steps ?? [{ id: 'pick', task: 'ask_user which list to send' }],
  } as unknown as PlannedPipeline);
  cleanups.push(() => { getPipelineStore().delete('wf-asks'); });

  const task = {
    id: 'trg-asks', title: 'Weekly offer', description: '', status: 'open', assignee: 'lynox',
    scope_type: 'context', scope_id: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    next_run_at: '2026-01-01T09:00:00.000Z', source: 'cron', effect: 'run_workflow', pipeline_id: 'wf-asks',
    confirmed_at: '2026-01-01T00:00:00.000Z',
  } as unknown as TriggerRecord;
  const records: Array<[string, string, string]> = [];
  const deliveries: string[] = [];
  let leaseReleases = 0;
  let dispatched = false;
  const manager = {
    getDueTriggers: () => (dispatched ? [] : (dispatched = true, [task])),
    getExpiredWaitingTriggers: () => [],
    endWait: () => false,
    claimLease: () => 'claimed',
    renewLease: () => true,
    releaseLease: () => { leaseReleases++; },
    getTrigger: (id: string) => (id === task.id ? task : undefined),
    recordTaskRun: (id: string, result: string, status: string) => { records.push([id, result, status]); return false; },
    setEnabled: () => true,
    startEscalation: () => true,
    recordEscalationOutcome: (_id: string, delivery: string) => { deliveries.push(delivery); },
  } as unknown as TaskManager;
  const parks: unknown[] = [];
  let escalations = 0;
  const engine = {
    getTaskManager: () => manager,
    getRunHistory: () => ({ getTrigger: () => task, updateTrigger: (_id: string, patch: unknown) => { parks.push(patch); } }),
    getPromptStore: () => prompts,
    getThreadStore: () => threads,
    getSecretStore: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => { escalations++; return null; },
  } as unknown as Engine;
  const notified: NotificationMessage[] = [];
  const router = {
    hasChannels: () => true,
    notify: vi.fn(async (msg: NotificationMessage) => { notified.push(msg); return [{ channel: 'push', outcome: 'delivered' }]; }),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000, o?.taskTimeoutMs);
  loops.push(loop);
  return { loop, prompts, threads, records, escalations: () => escalations, deliveries, parks, leaseReleases: () => leaseReleases, notified };
}

const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's open question, once written. */
async function openQuestion(h: Harness): Promise<{ id: string; session: string }> {
  await waitUntil('the run to ask', () => wf.calls[0]?.runId !== undefined && h.prompts.getPending(wf.calls[0].runId) !== undefined);
  const row = h.prompts.getPending(wf.calls[0]!.runId!)!;
  return { id: row.id, session: row.session_id };
}

describe('a scheduled workflow that asks its owner', () => {
  it('waits at the question in the run\'s thread, with no trigger, and an answer lets it go on', async () => {
    const h = makeHarness();
    const answers: string[] = [];
    wf.step = askingStep(answers);
    void h.loop.tick();
    const q = await openQuestion(h);

    const handed = wf.calls[0]!;
    expect(handed.runId).toMatch(RUN_ID_SHAPE);
    // The channel alone: no `parentPromptUser`, so no consent gate in a step can use it.
    expect(Object.keys(handed.parentPrompt ?? {})).toEqual(['parentAskUserPrompt']);
    expect(handed.questionWait).toBeDefined();

    const row = h.prompts.getById(q.id)!;
    expect(row.session_id).toBe(handed.runId);
    expect(row.trigger_id).toBeNull();
    expect(h.threads.getThread(handed.runId!)?.title).toBe('Weekly offer');
    // Nothing is parked: the re-arm and the expiry sweep read only `waiting` triggers.
    expect(h.parks).toEqual([]);
    expect(h.notified[0]).toMatchObject({ taskId: 'trg-asks', data: { threadId: handed.runId, promptId: q.id } });
    await waitUntil('the delivery to be recorded on the schedule', () => h.deliveries.length > 0);
    expect(h.deliveries).toEqual(['delivered']);

    h.prompts.answerUser(q.id, 'B');
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(answers).toEqual(['B']);
    expect(h.records[0]![2]).toBe('success');
    expect(h.records[0]![1]).toContain('Pipeline completed');
  });

  it('a question asked after the 5-minute deadline still waits, and so does a second one after the answer', async () => {
    // The deadline, shortened to 30 ms. Without the pause at the start it aborts the controller
    // first, and the question then finds the run gone before it is written.
    const h = makeHarness({ taskTimeoutMs: 30 });
    const answers: string[] = [];
    wf.step = askingStep(answers, { delayMs: 80, count: 2 });
    void h.loop.tick();
    const first = await openQuestion(h);
    h.prompts.answerUser(first.id, 'A');
    await waitUntil('the second question', () => {
      const p = h.prompts.getPending(wf.calls[0]!.runId!);
      return p !== undefined && p.id !== first.id;
    });
    h.prompts.answerUser(h.prompts.getPending(wf.calls[0]!.runId!)!.id, 'B');
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(answers).toEqual(['A', 'B']);
    expect(h.records[0]![2]).toBe('success');
  });

  it('a stop during the wait ends the run stopped, withdraws the question, and escalates nothing', async () => {
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    const q = await openQuestion(h);
    expect(h.loop.stopTask('trg-asks')).toEqual({ kind: 'requested', via: 'wait' });
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(h.records[0]![2]).toBe('stopped');
    expect(h.prompts.getById(q.id)!.status).toBe('expired');
    expect(h.escalations()).toBe(0);
  });

  it('a question that expires ends the run failed as unanswered', async () => {
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    const q = await openQuestion(h);
    h.prompts.expirePrompt(q.id);
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(h.records[0]![2]).toBe('failed');
    expect(wf.calls[0]!.questionWait?.unanswered).toBe(true);
  });

  it('a shutdown during the wait records nothing, escalates nothing, and keeps the lease', async () => {
    // In the order `LynoxHTTPApi.shutdown()` runs them: the prompt rows are closed first, then
    // the loop stops. Nothing between the two may make the wait read as a TTL.
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    const q = await openQuestion(h);
    h.prompts.expireUnparked();
    h.loop.stop();
    await new Promise((r) => { setTimeout(r, 50); });
    expect(h.records).toEqual([]);
    expect(h.escalations()).toBe(0);
    expect(h.leaseReleases()).toBe(0);
    expect(wf.calls[0]!.questionWait?.unanswered).toBe(false);
    expect(h.prompts.getById(q.id)!.closed_reason).toBe('process_restarted');
  });

  it('a workflow that may ask for a secret gets no channel and does not run', async () => {
    const h = makeHarness({ steps: [{ id: 'k', task: 'ask_secret for the key' }] });
    wf.step = askingStep([]);
    void h.loop.tick();
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(wf.calls).toEqual([]);
    expect(h.records[0]![2]).toBe('failed');
  });
});
