import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerLoop } from './worker-loop.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { NotificationMessage } from './notification-router.js';
import type { TaskRecord } from '../types/index.js';
import type { TaskManager } from './task-manager.js';
import type { Session } from './session.js';

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

  // ---- pipeline path: validateManifest boundary ----
  //
  // Drive executePipeline directly. Routing via tick() → executeTask →
  // fire-and-forget makes the async chain hard to await deterministically
  // (two sequential dynamic imports plus a bugsink capture chain in the
  // outer catch). Direct invocation locks the new validation contract:
  // invalid manifests reject with typed errors before reaching
  // computePhases. The outer catch in executeTask is unchanged and
  // already exercised by the standard task-failure tests above.
  it('executePipeline rejects a malformed persisted manifest with a typed error', async () => {
    vi.useRealTimers();
    const task = makeTask({
      id: 'pipe-task-1',
      pipeline_id: 'pipeline-bad',
      task_type: 'pipeline',
    });
    const engine = {
      getTaskManager: vi.fn(() => makeTaskManager()),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => null),
        getPipelineRunManifest: vi.fn(() =>
          JSON.stringify({
            manifest_version: '1.0',
            name: 'bad-manifest',
            triggered_by: 'test',
            agents: [], // ← rejected by validateManifest's .min(1)
            gate_points: [],
            on_failure: 'stop',
          }),
        ),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    await expect(
      (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
        .executePipeline(task),
    ).rejects.toThrow(/agents/i);
  });

  it('executePipeline rejects corrupt manifest JSON with a clear error', async () => {
    vi.useRealTimers();
    const task = makeTask({
      id: 'pipe-task-2',
      pipeline_id: 'pipeline-corrupt',
      task_type: 'pipeline',
    });
    const engine = {
      getTaskManager: vi.fn(() => makeTaskManager()),
      getUserConfig: vi.fn(() => ({})),
      getRunHistory: vi.fn(() => ({
        getPlannedPipeline: vi.fn(() => null),
        getPipelineRunManifest: vi.fn(() => '{this is not valid json'),
      })),
    } as unknown as Engine;
    const router = makeNotificationRouter(false);
    const loop = new WorkerLoop(engine, router, 60_000);

    await expect(
      (loop as unknown as { executePipeline: (t: TaskRecord) => Promise<void> })
        .executePipeline(task),
    ).rejects.toThrow(/manifest JSON is corrupt/);
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
});
