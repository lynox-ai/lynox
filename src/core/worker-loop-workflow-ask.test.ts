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
import { OWNER_PRINCIPAL } from './request-principal.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { PromptStore } from './prompt-store.js';
import { ThreadStore } from './thread-store.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';
import type { NotificationRouter, NotificationMessage, DeliverySummary } from './notification-router.js';
import type { TaskManager } from './task-manager.js';
import type { TriggerRecord, PlannedPipeline } from '../types/index.js';
import type { SubAgentPromptHandles } from '../orchestrator/runtime-adapter.js';
import type { WorkflowQuestionWait } from './workflow-questions.js';
import { getPipelineStore } from '../tools/builtin/pipeline.js';
import { WORKFLOW_STOPPED_ERROR, WORKFLOW_QUESTION_UNANSWERED_ERROR, WORKFLOW_QUESTION_NOT_ASKED_ERROR, WORKFLOW_QUESTION_THREAD_DELETED_ERROR } from '../orchestrator/workflow-stop.js';

interface RunOpts {
  runId?: string;
  parentPrompt?: SubAgentPromptHandles;
  questionWait?: WorkflowQuestionWait;
  stopSignal?: AbortSignal;
  approvalFiling?: unknown;
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
  if (opts.questionWait?.unanswered === true) {
    const because = opts.questionWait.unansweredBecause;
    const error = because === 'not_asked' ? WORKFLOW_QUESTION_NOT_ASKED_ERROR
      : because === 'thread_deleted' ? WORKFLOW_QUESTION_THREAD_DELETED_ERROR
      : WORKFLOW_QUESTION_UNANSWERED_ERROR;
    return { ok: true, status: 'failed', error, runId: opts.runId };
  }
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
  escalationBodies: string[];
  deliveries: string[];
  parks: unknown[];
  leaseReleases: () => number;
  notified: NotificationMessage[];
}

function makeHarness(o?: {
  taskTimeoutMs?: number; steps?: PlannedPipeline['steps']; mandatePlan?: boolean; createdUntrusted?: string;
  /** A real engine's `escalationReporter`, so the delivery reaches its hooks. */
  reporter?: Engine['escalationReporter'];
  /** What the push of the question reports. */
  pushOutcome?: 'delivered' | 'failed';
}): Harness {
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
    // A schedule a mandate set up and the owner stamped: its run acts for the mandate.
    ...(o?.mandatePlan === true ? { created_by: 'mandate:eva@kanzlei.example', created_mandate_id: 'TEST-GRANT-EVA' } : {}),
    ...(o?.createdUntrusted !== undefined ? { created_untrusted: o.createdUntrusted } : {}),
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
  const escalationBodies: string[] = [];
  const engine = {
    getTaskManager: () => manager,
    getToolContext: () => ({ containment: null }),
    getRunHistory: () => ({
      getTrigger: () => task, updateTrigger: (_id: string, patch: unknown) => { parks.push(patch); },
      // The owner saved the workflow: no mandate it depends on.
      getWorkflowAuthorship: () => ({ createdBy: null, createdMandateId: null, mandateEditor: null, mandateEditorId: null, mandateEditedAt: null, createdAt: '2026-01-01 00:00:00' }),
    }),
    getPromptStore: () => prompts,
    getThreadStore: () => threads,
    getSecretStore: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: (e: { body: string }) => { escalations++; escalationBodies.push(e.body); return null; },
    escalationReporter: o?.reporter ?? ((caller?: (d: DeliverySummary) => void) => (d: DeliverySummary) => { caller?.(d); }),
    getMandateEnds: () => ({ isLive: () => true }),
    getAuditLog: () => ({ record: () => {} }),
    getApprovalStore: () => APPROVAL_STORE,
    getEngineDb: () => null,
  } as unknown as Engine;
  const notified: NotificationMessage[] = [];
  const router = {
    hasChannels: () => true,
    notify: vi.fn(async (msg: NotificationMessage) => { notified.push(msg); return [{ channel: 'push', outcome: o?.pushOutcome ?? 'delivered' }]; }),
  } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000, o?.taskTimeoutMs);
  loops.push(loop);
  return { loop, prompts, threads, records, escalations: () => escalations, escalationBodies, deliveries, parks, leaseReleases: () => leaseReleases, notified };
}

const APPROVAL_STORE = { tag: 'approval-store' };

const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's open question, once written. */
async function openQuestion(h: Harness): Promise<{ id: string; session: string }> {
  await waitUntil('the run to ask', () => wf.calls[0]?.runId !== undefined && h.prompts.getPending(wf.calls[0].runId) !== undefined);
  const row = h.prompts.getPending(wf.calls[0]!.runId!)!;
  return { id: row.id, session: row.session_id };
}

describe('what a scheduled workflow run files a mail with', () => {
  const prev = process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
  afterEach(() => {
    if (prev === undefined) delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    else process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = prev;
  });

  it('the run gets the trigger and the owner, as a workflow source', async () => {
    process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = '1';
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    await openQuestion(h);
    expect(wf.calls[0]!.approvalFiling).toEqual({ source: 'workflow', triggerId: 'trg-asks', store: APPROVAL_STORE, createdBy: 'owner', mandateId: null });
  });

  it('a workflow set up after foreign content passes that on to what its run files', async () => {
    process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = '1';
    const h = makeHarness({ createdUntrusted: 'marker' });
    wf.step = askingStep([]);
    void h.loop.tick();
    await openQuestion(h);
    expect(wf.calls[0]!.approvalFiling).toMatchObject({ source: 'workflow', triggerId: 'trg-asks', createdUntrusted: true });
  });

  it('with the queue off, the run gets none', async () => {
    delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    await openQuestion(h);
    expect(wf.calls[0]!.approvalFiling).toBeUndefined();
  });
});

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

    h.prompts.answerUser(q.id, 'B', OWNER_PRINCIPAL);
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(answers).toEqual(['B']);
    expect(h.records[0]![2]).toBe('success');
    expect(h.records[0]![1]).toContain('Workflow completed');
  });

  it('a question of a mandate\'s stamped plan carries the mandate the plan acts for', async () => {
    const h = makeHarness({ mandatePlan: true });
    const answers: string[] = [];
    wf.step = askingStep(answers);
    void h.loop.tick();
    const q = await openQuestion(h);
    expect(h.prompts.getById(q.id)!.created_by).toBe('mandate:eva@kanzlei.example');
    // Control: the owner's plan asks as the owner (the case above, read here on the row).
    const o = makeHarness();
    wf.calls.length = 0;
    wf.step = askingStep([]);
    void o.loop.tick();
    const oq = await openQuestion(o);
    expect(o.prompts.getById(oq.id)!.created_by).toBe('owner');
  });

  it('a question asked after the 5-minute deadline still waits, and so does a second one after the answer', async () => {
    // The deadline, shortened as far as it goes: `WallClockBudget` floors every arm at 1 s
    // (`minRearmMs`), so a 30 ms budget fires after 1 s. Each question comes 1.2 s after the
    // previous event, past it. Without the pause at the start the deadline aborts the controller
    // first, and the question then finds the run gone before it is written; the second question
    // is the witness against an answer re-arming the deadline.
    const h = makeHarness({ taskTimeoutMs: 30 });
    const answers: string[] = [];
    wf.step = askingStep(answers, { delayMs: 1_200, count: 2 });
    void h.loop.tick();
    const first = await openQuestion(h);
    h.prompts.answerUser(first.id, 'A', OWNER_PRINCIPAL);
    await waitUntil('the second question', () => {
      const p = h.prompts.getPending(wf.calls[0]!.runId!);
      return p !== undefined && p.id !== first.id;
    });
    h.prompts.answerUser(h.prompts.getPending(wf.calls[0]!.runId!)!.id, 'B', OWNER_PRINCIPAL);
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(answers).toEqual(['A', 'B']);
    expect(h.records[0]![2]).toBe('success');
  }, 10_000);

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

  it('deleting the run\'s thread during the wait withdraws the question and ends the run in words of its own', async () => {
    // The thread was the only place to answer the question. The owner deleted a chat, not the
    // run: no retry, no escalation, and the record does not say they stopped it.
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    const q = await openQuestion(h);
    h.threads.deleteThread(q.session);
    expect(h.prompts.withdrawForDeletedThread(q.session)).toBe(1);
    await waitUntil('the run to end', () => h.records.length > 0);
    const runId = wf.calls[0]!.runId!;
    expect(h.records[0]![1]).toBe(`Workflow ended without an answer: the conversation its question was asked in was deleted, and that was the only place to answer it (run ${runId}).`);
    expect(h.records[0]![1]).not.toMatch(/your instruction|you stopped/i);
    expect(h.records[0]![2]).toBe('stopped');
    expect(wf.calls[0]!.questionWait?.unansweredBecause).toBe('thread_deleted');
    expect(h.prompts.getById(q.id)).toMatchObject({ status: 'expired', closed_reason: 'thread_deleted' });
    expect(h.escalations()).toBe(0);
    expect(h.threads.getThread(q.session), 'the thread stays deleted').toBeUndefined();
  });

  it('a step whose own error reads like the withdrawal is still a failure', async () => {
    // Keyed on the channel too: only a question withdrawn with its thread is recorded as one.
    const h = makeHarness();
    wf.step = async (opts) => ({ ok: true, status: 'failed', error: WORKFLOW_QUESTION_THREAD_DELETED_ERROR, runId: opts.runId });
    void h.loop.tick();
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(h.records[0]![2]).toBe('failed');
  });

  it('a question that expires ends the run failed as unanswered', async () => {
    const h = makeHarness();
    wf.step = askingStep([]);
    void h.loop.tick();
    const q = await openQuestion(h);
    h.prompts.expirePrompt(q.id, 'run_stopped');
    await waitUntil('the run to end', () => h.records.length > 0);
    expect(h.records[0]![2]).toBe('failed');
    expect(wf.calls[0]!.questionWait?.unanswered).toBe(true);
  });

  it('a question that cannot be put to the owner ends the run failed as not asked, and says so', async () => {
    const h = makeHarness();
    const ask = askingStep([]);
    // The owner's own chat in the run's thread holds the session's one open slot.
    wf.step = async (opts) => { h.prompts.insertAskUser(opts.runId!, 'A question of the owner\'s own chat'); return ask(opts); };
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      void h.loop.tick();
      await waitUntil('the run to end', () => h.records.length > 0);
    } finally { write.mockRestore(); }
    expect(h.records[0]![2]).toBe('failed');
    expect(wf.calls[0]!.questionWait?.unansweredBecause).toBe('not_asked');
    expect(h.notified.filter((m) => m.inquiry !== undefined)).toHaveLength(0);
    // The owner is told, with what happened — not that a question expired.
    expect(h.escalationBodies).toHaveLength(1);
    expect(h.escalationBodies[0]).toContain(`Error: ${WORKFLOW_QUESTION_NOT_ASKED_ERROR}`);
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

/**
 * A question whose push reached nobody goes to the engine's hooks as an escalation's delivery
 * does, so the managed hook can ask the control plane to mail the owner. The engine is booted
 * for real with the control plane's environment, so the hook is the one `init()` registers; a
 * test that handed a hook in itself would stay green with the wiring line deleted.
 */
describe('a scheduled workflow question on an instance the control plane runs', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = [
    'LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID',
    'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_VAULT_KEY',
  ] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
    vi.unstubAllGlobals();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    reloadConfig();
  });

  async function bootManaged(): Promise<{ engine: Engine; fetchSpy: ReturnType<typeof vi.fn> }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wf-question-cp-'));
    dirs.push(dir);
    const env: Record<string, string> = {
      LYNOX_DATA_DIR: dir, LYNOX_BILLING_TIER: 'hosted', LYNOX_MANAGED_INSTANCE_ID: 'inst-wfq',
      LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.test', LYNOX_HTTP_SECRET: 'wfq-secret',
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

  it('one whose push reached nobody is reported to the control plane, as an escalation is', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const h = makeHarness({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'failed' });
    wf.step = askingStep([]);
    void h.loop.tick();
    await openQuestion(h);
    await waitUntil('the delivery to be recorded on the schedule', () => h.deliveries.length > 0);
    expect(h.deliveries).toEqual(['not_delivered']);
    await waitUntil('the report to the control plane', () => escalationPosts(fetchSpy).length > 0);
    const posts = escalationPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe('https://cp.test/internal/usage/inst-wfq/escalation');
  });

  it('one whose push reached the owner is not reported', async () => {
    const { engine, fetchSpy } = await bootManaged();
    const h = makeHarness({ reporter: engine.escalationReporter.bind(engine), pushOutcome: 'delivered' });
    wf.step = askingStep([]);
    void h.loop.tick();
    await openQuestion(h);
    await waitUntil('the delivery to be recorded on the schedule', () => h.deliveries.length > 0);
    expect(h.deliveries).toEqual(['delivered']);
    await new Promise((r) => { setTimeout(r, 50); });
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });
});
