/**
 * Worker loop — persistent background task executor.
 *
 * Runs on a timer, checks for due tasks in the database,
 * creates headless Sessions to execute them, and sends
 * results via NotificationRouter.
 */

import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TaskRecord } from '../types/index.js';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_TASK_RESULT_CHARS = 4000; // truncate for notifications

export class WorkerLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // prevent overlapping ticks
  private readonly activeTasks = new Map<string, AbortController>();

  constructor(
    private readonly engine: Engine,
    private readonly notificationRouter: NotificationRouter,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return; // already running
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref(); // don't prevent process exit
    // Run immediately on start
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Abort all active tasks
    for (const [, controller] of this.activeTasks) {
      controller.abort();
    }
    this.activeTasks.clear();
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /** @internal Exposed for testing. */
  async tick(): Promise<void> {
    if (this.ticking) return; // skip if previous tick still running
    this.ticking = true;
    try {
      const taskManager = this.engine.getTaskManager();
      if (!taskManager) return;

      const dueTasks = taskManager.getDueTasks();
      for (const task of dueTasks) {
        // Skip if already executing
        if (this.activeTasks.has(task.id)) continue;
        // Fire and forget — don't await, execute in parallel
        void this.executeTask(task);
      }
    } catch {
      // Best-effort — don't crash the loop
    } finally {
      this.ticking = false;
    }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const controller = new AbortController();
    this.activeTasks.set(task.id, controller);

    try {
      // Create headless session — no promptUser, autonomous mode
      const session = this.engine.createSession({
        autonomy: 'autonomous',
        systemPromptSuffix: WORKER_SUFFIX,
      });

      // Build task prompt
      const prompt = task.description
        ? `Task: ${task.title}\n\n${task.description}`
        : `Task: ${task.title}`;

      // Execute
      const result = await session.run(prompt);
      const truncatedResult = result.length > MAX_TASK_RESULT_CHARS
        ? result.slice(0, MAX_TASK_RESULT_CHARS) + '\u2026'
        : result;

      // Record success
      const taskManager = this.engine.getTaskManager();
      if (taskManager) {
        taskManager.recordTaskRun(task.id, truncatedResult, 'success');
      }

      // Notify
      if (this.notificationRouter.hasChannels()) {
        await this.notificationRouter.notify({
          title: `\u2713 ${task.title}`,
          body: truncatedResult,
          taskId: task.id,
          priority: 'normal',
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const taskManager = this.engine.getTaskManager();
      if (taskManager) {
        taskManager.recordTaskRun(task.id, errorMsg, 'failed');
      }

      // Notify failure
      if (this.notificationRouter.hasChannels()) {
        await this.notificationRouter.notify({
          title: `\u2717 ${task.title}`,
          body: `Task failed: ${errorMsg}`,
          taskId: task.id,
          priority: 'high',
        });
      }
    } finally {
      this.activeTasks.delete(task.id);
    }
  }
}

const WORKER_SUFFIX = `

## Background Worker
You are running as an autonomous background worker.
- You CANNOT ask questions — there is no user present
- Complete the task independently using available tools
- Be thorough but concise — your response will be sent as a notification
- Always conclude with a clear summary of what was accomplished or why it failed
`;
