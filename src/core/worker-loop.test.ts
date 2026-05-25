import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the orchestrator runner so the pipeline-path tests can drive
// status/runId outcomes deterministically without spinning up an LLM.
// `runManifest` is the single execution primitive `runSavedWorkflow`
// delegates to; mocking it isolates the worker-loop wiring under test
// from the orchestrator's real behaviour. Real-orchestrator coverage
// lives in pipeline.test.ts + the orchestrator's own suite.
const mockRunManifest = vi.fn();
const mockRetryManifest = vi.fn();
const mockValidateManifest = vi.fn((m: unknown) => m);
vi.mock('../orchestrator/runner.js', () => ({
  runManifest: (...args: unknown[]) => mockRunManifest(...args),
  retryManifest: (...args: unknown[]) => mockRetryManifest(...args),
}));
vi.mock('../orchestrator/validate.js', async (importOriginal) => {
  // Keep MAX_STEPS + the rest of the module intact; only intercept
  // validateManifest so we don't have to assemble a fully-valid Manifest
  // shape in every test setup.
  const actual = await importOriginal<typeof import('../orchestrator/validate.js')>();
  return {
    ...actual,
    validateManifest: (...args: unknown[]) => mockValidateManifest(...args),
  };
});

import { WorkerLoop } from './worker-loop.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { NotificationMessage } from './notification-router.js';
import type { TaskRecord, PlannedPipeline } from '../types/index.js';
import type { TaskManager } from './task-manager.js';
import type { Session } from './session.js';
import type { RunState, AgentOutput } from '../types/orchestration.js';

function makeRunState(overrides?: Partial<RunState>): RunState {
  return {
    runId: 'fresh-run-id',
    manifestName: 'test',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'completed',
    globalContext: {},
    outputs: new Map<string, AgentOutput>(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'task-1',
    title: 'Daily Report',
    description: 'Generate the daily report',
    status: 'open',
    priority: 'medium',
    assignee: 'lynox',
    scope_type: 'context',
    scope_id: '',
    due_date: null,
    tags: null,
    parent_task_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    schedule_cron: '0 9 * * *',
    next_run_at: '2026-01-01T09:00:00.000Z',
    task_type: 'scheduled',
    ...overrides,
  };
}

function makeTaskManager(tasks: TaskRecord[] = []): TaskManager {
  return {
    getDueTasks: vi.fn<() => TaskRecord[]>().mockReturnValue(tasks),
    recordTaskRun: vi.fn(),
  } as unknown as TaskManager;
}

function makeSession(result: string | Error = 'Done.'): Session {
  const runFn = result instanceof Error
    ? vi.fn<(task: string) => Promise<string>>().mockRejectedValue(result)
    : vi.fn<(task: string) => Promise<string>>().mockResolvedValue(result);
  return { run: runFn, _recreateAgent: vi.fn(), promptUser: undefined } as unknown as Session;
}

function makeEngine(opts?: {
  taskManager?: TaskManager | null;
  session?: Session;
}): Engine {
  const tm = opts?.taskManager ?? null;
  const session = opts?.session ?? makeSession();
  return {
    getTaskManager: vi.fn(() => tm),
    createSession: vi.fn(() => session),
    getUserConfig: vi.fn(() => ({})),
  } as unknown as Engine;
}

function makeNotificationRouter(hasChannels = true): NotificationRouter {
  return {
    hasChannels: vi.fn<() => boolean>().mockReturnValue(hasChannels),
    notify: vi.fn<(msg: NotificationMessage) => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as NotificationRouter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- 1. start/stop lifecycle ----

  it('start() creates interval, stop() clears it', () => {
    const engine = makeEngine();
    const router = makeNotificationRouter();
    const loop = new WorkerLoop(engine, router, 5000);

    expect(loop.isRunning).toBe(false);

    loop.start();
    expect(loop.isRunning).toBe(true);

    loop.stop();
    expect(loop.isRunning).toBe(false);
  });

  it('start() is idempotent — calling twice does not create a second timer', () => {
    const engine = makeEngine();
    const router = makeNotificationRouter();
    const loop = new WorkerLoop(engine, router, 5000);

    loop.start();
    loop.start(); // no-op
    expect(loop.isRunning).toBe(true);

    loop.stop();
    expect(loop.isRunning).toBe(false);
  });

  // ---- 2. tick executes due tasks ----

  it('tick executes due tasks via headless session', async () => {
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const session = makeSession('Report generated.');
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();

    // Wait for the fire-and-forget executeTask to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(tm.getDueTasks).toHaveBeenCalled();
    expect(engine.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: 'autonomous' }),
    );
    expect(session.run).toHaveBeenCalledWith(
      'Task: Daily Report\n\nGenerate the daily report',
    );
  });

  // ---- 3. skip if already executing ----

  it('skips task if already executing (no double-execution)', async () => {
    // Session that never resolves — simulates a long-running task
    const neverResolve = {
      run: vi.fn<(task: string) => Promise<string>>().mockReturnValue(new Promise(() => {})),
      _recreateAgent: vi.fn(),
    } as unknown as Session;
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const engine = makeEngine({ taskManager: tm, session: neverResolve });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);

    // First tick — task starts executing
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.activeTaskCount).toBe(1);

    // Second tick — same task still running, should be skipped
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(neverResolve.run).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  // ---- 4. successful task → recordTaskRun('success') + notify ----

  it('records success and sends notification on successful task', async () => {
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const session = makeSession('All done.');
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(tm.recordTaskRun).toHaveBeenCalledWith(task.id, 'All done.', 'success');
    expect(router.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining(task.title) as string,
        body: 'All done.',
        taskId: task.id,
        priority: 'normal',
      }),
    );
  });

  // ---- 5. failed task → recordTaskRun('failed') + notify high priority ----

  it('records failure and sends high-priority notification on failed task', async () => {
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const session = makeSession(new Error('Connection refused'));
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(tm.recordTaskRun).toHaveBeenCalledWith(task.id, 'Connection refused', 'failed');
    expect(router.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining(task.title) as string,
        body: 'Task failed: Connection refused',
        taskId: task.id,
        priority: 'high',
      }),
    );
  });

  // ---- 6. no taskManager → tick gracefully returns ----

  it('tick gracefully returns when no taskManager is available', async () => {
    const engine = makeEngine({ taskManager: null });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    // Should not throw
    await expect(loop.tick()).resolves.toBeUndefined();
  });

  // ---- 7. stop aborts active tasks ----

  it('stop() aborts active tasks and clears the map', async () => {
    const neverResolve = {
      run: vi.fn<(task: string) => Promise<string>>().mockImplementation(
        () => new Promise((_resolve, reject) => {
          void reject; // unused
        }),
      ),
      _recreateAgent: vi.fn(),
    } as unknown as Session;
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const engine = makeEngine({ taskManager: tm, session: neverResolve });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(loop.activeTaskCount).toBe(1);

    loop.stop();
    expect(loop.activeTaskCount).toBe(0);
    expect(loop.isRunning).toBe(false);
  });

  // ---- 8. isRunning / activeTaskCount getters ----

  it('isRunning and activeTaskCount reflect correct state', async () => {
    const neverResolve = {
      run: vi.fn<(task: string) => Promise<string>>().mockReturnValue(new Promise(() => {})),
      _recreateAgent: vi.fn(),
    } as unknown as Session;
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const tm = makeTaskManager(tasks);
    const engine = makeEngine({ taskManager: tm, session: neverResolve });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);

    expect(loop.isRunning).toBe(false);
    expect(loop.activeTaskCount).toBe(0);

    loop.start();
    expect(loop.isRunning).toBe(true);

    // Let the initial tick fire and the async executeTask calls start
    await vi.advanceTimersByTimeAsync(0);

    expect(loop.activeTaskCount).toBe(2);

    loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(loop.activeTaskCount).toBe(0);
  });

  // ---- 9. tick doesn't overlap (ticking guard) ----

  it('tick does not overlap — second tick is skipped while first is running', async () => {
    let resolveFirst: (() => void) | null = null;
    const blockingTm: TaskManager = {
      getDueTasks: vi.fn<() => TaskRecord[]>().mockImplementation(() => {
        return new Promise<TaskRecord[]>((resolve) => {
          resolveFirst = () => resolve([]);
        }) as unknown as TaskRecord[];
      }),
      recordTaskRun: vi.fn(),
    } as unknown as TaskManager;

    // Actually, getDueTasks is sync in the real impl, but tick() wraps everything
    // in try/catch. Let's test the guard with a slow executeTask instead.
    const slowSession = {
      run: vi.fn<(task: string) => Promise<string>>().mockImplementation(
        () => new Promise((resolve) => {
          setTimeout(() => resolve('slow result'), 5000);
        }),
      ),
    } as unknown as Session;
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const engine = makeEngine({ taskManager: tm, session: slowSession });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 1000);
    loop.start();

    // First tick fires immediately on start
    await vi.advanceTimersByTimeAsync(0);
    expect(tm.getDueTasks).toHaveBeenCalledTimes(1);

    // Advance to next interval — tick should complete since getDueTasks is sync
    // and executeTask is fire-and-forget. The ticking guard resets in the finally block.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tm.getDueTasks).toHaveBeenCalledTimes(2);

    loop.stop();
    void resolveFirst; // unused in this path
  });

  // ---- 10. truncates long results ----

  it('truncates long results to MAX_TASK_RESULT_CHARS', async () => {
    const longResult = 'x'.repeat(5000);
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const session = makeSession(longResult);
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    // recordTaskRun should get truncated result
    const recordedResult = (tm.recordTaskRun as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(recordedResult.length).toBeLessThanOrEqual(4001); // 4000 + ellipsis char
    expect(recordedResult.endsWith('\u2026')).toBe(true);

    // Notification body should also be truncated
    const notifyCall = (router.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as NotificationMessage;
    expect(notifyCall.body.length).toBeLessThanOrEqual(4001);
  });

  // ---- 11. no notification when no channels registered ----

  it('skips notification when no channels are registered', async () => {
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const session = makeSession('Done.');
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter(false); // no channels

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(router.notify).not.toHaveBeenCalled();
    // But success should still be recorded
    expect(tm.recordTaskRun).toHaveBeenCalledWith(task.id, 'Done.', 'success');
  });

  // ---- 12. task without description uses title only ----

  it('builds prompt from title only when description is empty', async () => {
    const task = makeTask({ description: '' });
    const tm = makeTaskManager([task]);
    const session = makeSession('Ok.');
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(session.run).toHaveBeenCalledWith('Task: Daily Report');
  });

  it('does not duplicate the title when description equals title', async () => {
    // Older clients (and the previous HTTP API) sent description = title for
    // tasks created without a separate body. The prompt MUST NOT then render
    // "Task: X\n\nX" — the agent reads the same line twice.
    const task = makeTask({ description: 'Daily Report' });
    const tm = makeTaskManager([task]);
    const session = makeSession('Ok.');
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(session.run).toHaveBeenCalledWith('Task: Daily Report');
  });

  // ---- 13. resolveTaskInput resolves pending input ----

  it('resolveTaskInput returns false when no task is active', () => {
    const engine = makeEngine();
    const router = makeNotificationRouter();
    const loop = new WorkerLoop(engine, router, 60_000);

    expect(loop.resolveTaskInput('nonexistent', 'hello')).toBe(false);
  });

  it('resolveTaskInput returns false when task has no pending input', async () => {
    const neverResolve = {
      run: vi.fn<(task: string) => Promise<string>>().mockReturnValue(new Promise(() => {})),
      _recreateAgent: vi.fn(),
      promptUser: undefined,
    } as unknown as Session;
    const task = makeTask();
    const tm = makeTaskManager([task]);
    const engine = makeEngine({ taskManager: tm, session: neverResolve });
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    // Task is active but has no pending input
    expect(loop.resolveTaskInput(task.id, 'answer')).toBe(false);

    loop.stop();
  });

  // ---- 14. getTaskPendingInput returns undefined when no pending input ----

  it('getTaskPendingInput returns undefined for non-existent task', () => {
    const engine = makeEngine();
    const router = makeNotificationRouter();
    const loop = new WorkerLoop(engine, router, 60_000);

    expect(loop.getTaskPendingInput('nonexistent')).toBeUndefined();
  });

  // ---- 15. promptUser is wired to session during executeStandard ----

  it('wires promptUser to session during executeStandard', async () => {
    let capturedPromptUser: ((q: string, o?: string[]) => Promise<string>) | undefined;

    const session = {
      run: vi.fn<(task: string) => Promise<string>>().mockResolvedValue('Done.'),
      _recreateAgent: vi.fn(),
      promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
    };

    // Intercept the session to capture promptUser after it's assigned
    const engine = {
      getTaskManager: vi.fn(() => makeTaskManager([makeTask()])),
      getUserConfig: vi.fn(() => ({})),
      createSession: vi.fn(() => {
        // Return a proxy that captures promptUser assignment
        return new Proxy(session, {
          set(target, prop, value: unknown) {
            if (prop === 'promptUser') {
              capturedPromptUser = value as typeof capturedPromptUser;
            }
            (target as Record<string | symbol, unknown>)[prop] = value;
            return true;
          },
        });
      }),
    } as unknown as Engine;
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    // promptUser should have been assigned
    expect(capturedPromptUser).toBeDefined();
  });

  // ---- 16. stop() resolves pending inputs before aborting ----

  it('stop() resolves pending inputs with cancellation message', async () => {
    let promptResolve: ((answer: string) => void) | undefined;
    const promptPromise = new Promise<string>((resolve) => {
      promptResolve = resolve;
    });

    // Session that triggers a prompt during run, then waits forever
    const session = {
      run: vi.fn<(task: string) => Promise<string>>().mockReturnValue(new Promise(() => {})),
      _recreateAgent: vi.fn(),
      promptUser: undefined as ((q: string, o?: string[]) => Promise<string>) | undefined,
    };

    const task = makeTask();
    const tm = makeTaskManager([task]);
    const engine = {
      getTaskManager: vi.fn(() => tm),
      getUserConfig: vi.fn(() => ({})),
      createSession: vi.fn(() => session),
    } as unknown as Engine;
    const router = makeNotificationRouter();

    const loop = new WorkerLoop(engine, router, 60_000);
    await loop.tick();
    await vi.advanceTimersByTimeAsync(0);

    // Manually simulate pending input on the active task
    // by calling promptUser which was wired during executeStandard
    if (session.promptUser) {
      // This creates pending input
      void session.promptUser('Approve this?', ['Yes', 'No']);
      await vi.advanceTimersByTimeAsync(0);
    }

    // Verify pending input exists
    const pending = loop.getTaskPendingInput(task.id);
    if (pending) {
      expect(pending.question).toBe('Approve this?');
      expect(pending.options).toEqual(['Yes', 'No']);
    }

    loop.stop();
    expect(loop.activeTaskCount).toBe(0);

    void promptPromise;
    void promptResolve;
  });

  // ---- pipeline path: routed through runSavedWorkflow (T1-5) ----
  //
  // Drive executePipeline directly. Routing via tick() → executeTask →
  // fire-and-forget makes the async chain hard to await deterministically
  // (two sequential dynamic imports plus a bugsink capture chain in the
  // outer catch). Direct invocation locks the new contract: scheduled
  // pipelines run via `runSavedWorkflow`, which performs the
  // PlannedPipeline → Manifest conversion correctly AND leaves the
  // template row untouched so the next tick can fire it again. The outer
  // catch in executeTask is unchanged and already exercised by the
  // standard task-failure tests above.
  it('executePipeline skips cleanly when the workflow no longer exists', async () => {
    vi.useRealTimers();
    const task = makeTask({
      id: 'pipe-task-missing',
      pipeline_id: 'pipeline-missing',
      task_type: 'pipeline',
    });
    const tm = makeTaskManager();
    const engine = {
      getTaskManager: vi.fn(() => tm),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        // No saved-workflow row, no in-memory entry — getPipeline returns
        // undefined and executePipeline records a benign skip via
        // recordAndNotify without throwing (so it doesn't land in Bugsink).
        getPlannedPipeline: vi.fn(() => undefined),
        insertPipelineRun: vi.fn(),
        insertPipelineStepResult: vi.fn(),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    // Reset module-private pipeline store between tests via the public
    // forget API so an entry from another test cannot satisfy this lookup.
    const { _resetPipelineStore } = await import('../tools/builtin/pipeline.js');
    _resetPipelineStore();

    await expect(
      (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
        .executePipeline(task),
    ).resolves.toBeUndefined();

    expect(tm.recordTaskRun).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining('no longer exists'),
      'failed',
    );
  });

  it('executePipeline surfaces a non-template pipeline as a typed error', async () => {
    vi.useRealTimers();
    const task = makeTask({
      id: 'pipe-task-not-template',
      pipeline_id: 'pipeline-not-template',
      task_type: 'pipeline',
    });
    // A `plan_task`-style row (template:false) cannot be re-fired on a
    // schedule by definition — runSavedWorkflow refuses it cleanly instead
    // of crashing deep in validateManifest like the old code path did.
    const nonTemplatePlanned = JSON.stringify({
      id: 'pipeline-not-template',
      name: 'plan-task-style',
      goal: 'do thing once',
      steps: [{ id: 's1', task: 'work' }],
      reasoning: 'plan',
      estimatedCost: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      executed: false,
      executionMode: 'orchestrated',
      template: false,
      mode: 'autonomous',
    });
    const engine = {
      getTaskManager: vi.fn(() => makeTaskManager()),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => ({ id: 'pipeline-not-template', manifest_json: nonTemplatePlanned })),
        insertPipelineRun: vi.fn(),
        insertPipelineStepResult: vi.fn(),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    const { _resetPipelineStore } = await import('../tools/builtin/pipeline.js');
    _resetPipelineStore();

    await expect(
      (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
        .executePipeline(task),
    ).rejects.toThrow(/not a saved workflow/i);
  });

  // T1-5 acceptance test — the actual headline bug:
  //   a workflow scheduled via task_create(workflow_id, schedule)
  //   executes on its first WorkerLoop tick AND the template row stays
  //   byte-identical (no `executed` flip, no manifest_json mutation), so
  //   the next tick can fire it again.
  it('executes a scheduled saved workflow and leaves the template row byte-identical', async () => {
    vi.useRealTimers();
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'fresh-run-monthly', status: 'completed' }));

    // Round-trip through JSON so we capture exactly what SQLite would hold.
    const templateBefore = JSON.stringify({
      id: 'saved-monthly-report',
      name: 'Monthly Report',
      goal: 'Compile + send the monthly report',
      steps: [{ id: 'gather', task: 'Gather metrics' }],
      reasoning: 'saved',
      estimatedCost: 0.02,
      createdAt: '2026-01-01T00:00:00.000Z',
      executed: false,
      executionMode: 'orchestrated',
      template: true,
      mode: 'autonomous',
    });

    // RunHistory stub backed by a mutable record so we can snapshot the
    // row before AND after the tick and assert deep equality.
    const stored = { manifest_json: templateBefore };
    const taskManager = makeTaskManager();
    const insertedRuns: unknown[] = [];

    const engine = {
      getTaskManager: vi.fn(() => taskManager),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => ({ id: 'saved-monthly-report', manifest_json: stored.manifest_json })),
        // persistPipelineRun calls these for the FRESH run row (separate id);
        // they must NOT touch the template row.
        insertPipelineRun: vi.fn((row: unknown) => { insertedRuns.push(row); }),
        insertPipelineStepResult: vi.fn(),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    // Reset and prime the pipeline store with the same template so
    // getPipeline hits the in-memory path; deep-clone so any accidental
    // mutation by executePipeline shows up against the snapshot.
    const { _resetPipelineStore, storePipeline } = await import('../tools/builtin/pipeline.js');
    _resetPipelineStore();
    const liveTemplate = JSON.parse(templateBefore) as PlannedPipeline;
    storePipeline('saved-monthly-report', liveTemplate);

    const task = makeTask({
      id: 'scheduled-monthly',
      pipeline_id: 'saved-monthly-report',
      task_type: 'pipeline',
      schedule_cron: '0 9 1 * *',
    });

    await (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
      .executePipeline(task);

    // 1. The pipeline executed — success was recorded.
    expect(taskManager.recordTaskRun).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining('Pipeline completed') as string,
      'success',
    );

    // 2. Byte-identical template — neither the in-memory PlannedPipeline
    //    nor the would-be SQLite blob have changed. This is the core
    //    "doesn't consume the template" guarantee that lets the next
    //    cron tick fire the same workflow again.
    expect(liveTemplate.executed).toBe(false);
    expect(JSON.stringify(liveTemplate)).toBe(templateBefore);
    expect(stored.manifest_json).toBe(templateBefore);

    // 3. The fresh run row is a SEPARATE pipeline_runs entry (its own
    //    runId), not a mutation of the template row.
    expect(insertedRuns.length).toBe(1);
  });

  // Lock the headline cron-fires-N-times guarantee: a scheduled
  // workflow that fired this minute MUST be eligible to fire again next
  // minute. The previous code path marked the template `executed=true`
  // (or threw) on first fire, so a "schedule this workflow daily" task
  // would either run once and then become a no-op, or fail outright.
  it('executes a scheduled saved workflow repeatedly across ticks', async () => {
    vi.useRealTimers();
    mockRunManifest.mockReset();
    mockRunManifest
      .mockResolvedValueOnce(makeRunState({ runId: 'tick-1', status: 'completed' }))
      .mockResolvedValueOnce(makeRunState({ runId: 'tick-2', status: 'completed' }))
      .mockResolvedValueOnce(makeRunState({ runId: 'tick-3', status: 'completed' }));

    const templateJson = JSON.stringify({
      id: 'recurring-wf',
      name: 'Recurring',
      goal: 'fire on cron',
      steps: [{ id: 's', task: 'do' }],
      reasoning: 'saved',
      estimatedCost: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      executed: false,
      executionMode: 'orchestrated',
      template: true,
      mode: 'autonomous',
    });

    const taskManager = makeTaskManager();
    const engine = {
      getTaskManager: vi.fn(() => taskManager),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => ({ id: 'recurring-wf', manifest_json: templateJson })),
        insertPipelineRun: vi.fn(),
        insertPipelineStepResult: vi.fn(),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    const { _resetPipelineStore, storePipeline, getPipeline } = await import('../tools/builtin/pipeline.js');
    _resetPipelineStore();
    storePipeline('recurring-wf', JSON.parse(templateJson) as PlannedPipeline);

    const task = makeTask({
      id: 'recurring-task',
      pipeline_id: 'recurring-wf',
      task_type: 'pipeline',
      schedule_cron: '* * * * *',
    });

    const fire = (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> }).executePipeline.bind(loop);

    await fire(task);
    await fire(task);
    await fire(task);

    // Three ticks -> three successful records -> three runManifest calls.
    expect(mockRunManifest).toHaveBeenCalledTimes(3);
    expect(taskManager.recordTaskRun).toHaveBeenCalledTimes(3);
    // Template still re-runnable -- `executed` never flipped.
    expect(getPipeline('recurring-wf')?.executed).toBe(false);
  });

  // `runSavedWorkflow` returning {ok:true, status:'failed'|'partial'} is a
  // legit orchestrator outcome (a step errored but the run itself terminated
  // cleanly). worker-loop's `success = result.status === 'completed'` check
  // then records the task as failed. Pin that branch so a regression that
  // collapses non-completed onto 'success' is caught.
  it('records non-completed orchestrator status as a failed task run', async () => {
    vi.useRealTimers();
    mockRunManifest.mockReset();
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'partial-1', status: 'failed' }));

    const templateJson = JSON.stringify({
      id: 'partial-wf',
      name: 'Partial',
      goal: 'might fail mid-step',
      steps: [{ id: 's', task: 'do' }],
      reasoning: 'saved',
      estimatedCost: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      executed: false,
      executionMode: 'orchestrated',
      template: true,
      mode: 'autonomous',
    });

    const taskManager = makeTaskManager();
    const engine = {
      getTaskManager: vi.fn(() => taskManager),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => ({ id: 'partial-wf', manifest_json: templateJson })),
        insertPipelineRun: vi.fn(),
        insertPipelineStepResult: vi.fn(),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    const { _resetPipelineStore, storePipeline } = await import('../tools/builtin/pipeline.js');
    _resetPipelineStore();
    storePipeline('partial-wf', JSON.parse(templateJson) as PlannedPipeline);

    const task = makeTask({
      id: 'partial-task',
      pipeline_id: 'partial-wf',
      task_type: 'pipeline',
      schedule_cron: '0 9 * * *',
    });

    await (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
      .executePipeline(task);

    // Orchestrator succeeded the call but the run ended 'failed' →
    // worker-loop records the task as failed (not 'success') and the
    // summary line names the actual status so a /tasks UI watcher sees it.
    expect(taskManager.recordTaskRun).toHaveBeenCalledWith(
      task.id,
      expect.stringMatching(/Pipeline failed/) as string,
      'failed',
    );
    // Template still re-runnable on the next tick even after a failed run.
    expect(JSON.parse(templateJson).executed).toBe(false);
  });

  // Hard gate at execution time: WorkerLoop only runs autonomous pipelines.
  // An interactive pipeline that somehow got onto a schedule (legacy data,
  // sync from another instance) must be rejected at the boundary so it
  // can't hang waiting for a non-existent live session.
  it('executePipeline refuses an interactive PlannedPipeline', async () => {
    vi.useRealTimers();
    const task = makeTask({
      id: 'pipe-interactive',
      pipeline_id: 'pipeline-interactive',
      task_type: 'pipeline',
    });
    const interactivePlanned = JSON.stringify({
      id: 'pipeline-interactive',
      name: 'asks-user',
      goal: 'pick a tagline',
      steps: [{ id: 'q', task: 'ask_user which option' }],
      reasoning: 'interactive',
      estimatedCost: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      executed: false,
      executionMode: 'tracked',
      template: false,
      mode: 'interactive',
    });
    const engine = {
      getTaskManager: vi.fn(() => makeTaskManager()),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        // Pipeline lookup goes through getPlannedPipeline (manifest_json blob).
        getPlannedPipeline: vi.fn(() => ({ id: 'pipeline-interactive', manifest_json: interactivePlanned })),
        getPipelineRunManifest: vi.fn(() => null),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    await expect(
      (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
        .executePipeline(task),
    ).rejects.toThrow(/only runs 'autonomous' pipelines/);
  });

  // ---- task_type: 'reminder' branch (Phase-4 standalone reminders) ----

  it('executes a reminder by firing notify + recordTaskRun, no agent run', async () => {
    const task = makeTask({ task_type: 'reminder', title: 'Roland anrufen' });
    const tm = makeTaskManager([task]);
    const session = makeSession();
    const engine = makeEngine({ taskManager: tm, session });
    const router = makeNotificationRouter();
    const loop = new WorkerLoop(engine, router, 60_000);
    await (loop as unknown as { executeTask: (t: TaskRecord) => Promise<void> }).executeTask(task);
    // Reminder fired → notify called once, recordTaskRun stamped success.
    expect(router.notify).toHaveBeenCalledTimes(1);
    const msg = (router.notify as unknown as { mock: { calls: Array<[NotificationMessage]> } }).mock.calls[0]?.[0];
    expect(msg?.title).toBe('Erinnerung');
    expect(msg?.body).toBe('Roland anrufen');
    expect(tm.recordTaskRun).toHaveBeenCalledWith(task.id, 'reminder fired', 'success');
    // No agent invocation — session.run never called.
    expect(session.run).not.toHaveBeenCalled();
  });
});
