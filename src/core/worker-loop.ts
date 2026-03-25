/**
 * Worker loop — persistent background task executor.
 *
 * Runs on a timer, checks for due tasks in the database,
 * creates headless Sessions to execute them, and sends
 * results via NotificationRouter.
 *
 * Watch tasks use crypto.createHash('sha256') for content change detection.
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TaskRecord } from '../types/index.js';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_TASK_RESULT_CHARS = 4000; // truncate for notifications
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000; // 5 minutes per task execution

/** Per-task execution context available via AsyncLocalStorage. */
export interface WorkerTaskContext {
  taskId: string;
  taskTitle: string;
  taskType: string;
  startedAt: number;
}

/** Access the current worker task context from anywhere in the async call chain. */
export const workerTaskStorage = new AsyncLocalStorage<WorkerTaskContext>();

export class WorkerLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // prevent overlapping ticks
  private readonly activeTasks = new Map<string, AbortController>();

  constructor(
    private readonly engine: Engine,
    private readonly notificationRouter: NotificationRouter,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly taskTimeoutMs: number = DEFAULT_TASK_TIMEOUT_MS,
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

    // Node.js AbortSignal.timeout() — hard kill after taskTimeoutMs
    const timeoutSignal = AbortSignal.timeout(this.taskTimeoutMs);
    timeoutSignal.addEventListener('abort', () => controller.abort(), { once: true });

    // AsyncLocalStorage — per-task context for logging/tracing
    const taskCtx: WorkerTaskContext = {
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.task_type ?? 'manual',
      startedAt: Date.now(),
    };

    try {
      await workerTaskStorage.run(taskCtx, async () => {
        if (task.pipeline_id) {
          await this.executePipeline(task);
        } else if (task.task_type === 'watch') {
          await this.executeWatch(task);
        } else {
          await this.executeStandard(task);
        }
      });
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const errorMsg = isTimeout
        ? `Task timed out after ${Math.round(this.taskTimeoutMs / 1000)}s`
        : (err instanceof Error ? err.message : String(err));
      const status = isTimeout ? 'timeout' as const : 'failed' as const;

      // Check if task will be retried BEFORE recording (retry_count not yet incremented)
      const willRetry = (task.max_retries ?? 0) > 0
        && (task.retry_count ?? 0) < (task.max_retries ?? 0);

      const taskManager = this.engine.getTaskManager();
      if (taskManager) {
        taskManager.recordTaskRun(task.id, errorMsg, status);
      }

      // Only notify on FINAL failure (all retries exhausted)
      if (!willRetry && this.notificationRouter.hasChannels()) {
        await this.notificationRouter.notify({
          title: `\u2717 ${task.title}`,
          body: `Task failed: ${errorMsg}`,
          taskId: task.id,
          priority: 'high',
          followUps: [
            { label: 'Retry', task: task.description ?? task.title },
            { label: 'Explain', task: `Explain why this failed: ${task.title} — Error: ${errorMsg}` },
          ],
        });
      }
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  /** Execute a standard or scheduled task via headless Session. */
  private async executeStandard(task: TaskRecord): Promise<void> {
    const session = this.engine.createSession({
      autonomy: 'autonomous',
      systemPromptSuffix: WORKER_SUFFIX,
    });

    const prompt = task.description
      ? `Task: ${task.title}\n\n${task.description}`
      : `Task: ${task.title}`;

    const result = await session.run(prompt);
    const truncatedResult = result.length > MAX_TASK_RESULT_CHARS
      ? result.slice(0, MAX_TASK_RESULT_CHARS) + '\u2026'
      : result;

    const taskManager = this.engine.getTaskManager();
    if (taskManager) {
      taskManager.recordTaskRun(task.id, truncatedResult, 'success');
    }

    if (this.notificationRouter.hasChannels()) {
      await this.notificationRouter.notify({
        title: `\u2713 ${task.title}`,
        body: truncatedResult,
        taskId: task.id,
        priority: 'normal',
        followUps: [
          { label: 'Details', task: `Show me more details about: ${task.title}` },
          { label: 'Run again', task: task.description ?? task.title },
        ],
      });
    }
  }

  /** Execute a pipeline task via the DAG engine. */
  private async executePipeline(task: TaskRecord): Promise<void> {
    const runHistory = this.engine.getRunHistory();
    if (!runHistory || !task.pipeline_id) return;

    // Load the pipeline manifest
    const manifestJson = runHistory.getPipelineRunManifest(task.pipeline_id);
    if (!manifestJson) {
      throw new Error(`Pipeline ${task.pipeline_id} not found`);
    }

    const manifest = JSON.parse(manifestJson) as import('../orchestrator/types.js').Manifest;
    const config = this.engine.getUserConfig();

    // Execute pipeline using existing DAG engine
    const { runManifest } = await import('../orchestrator/runner.js');
    const state = await runManifest(manifest, config, { runHistory });

    const success = state.status === 'completed';
    const stepCount = state.outputs.size;
    const resultSummary = success
      ? `Pipeline completed: ${String(stepCount)} steps`
      : `Pipeline ${state.status}: ${state.error ?? 'unknown error'}`;

    const taskManager = this.engine.getTaskManager();
    if (taskManager) {
      taskManager.recordTaskRun(task.id, resultSummary, success ? 'success' : 'failed');
    }

    if (this.notificationRouter.hasChannels()) {
      await this.notificationRouter.notify({
        title: `${success ? '\u2713' : '\u2717'} ${task.title}`,
        body: resultSummary,
        taskId: task.id,
        priority: success ? 'normal' : 'high',
      });
    }
  }

  /**
   * Execute a watch task: fetch URL, hash content, compare with previous.
   * Only notifies (and runs agent analysis) when content has changed.
   * Uses Node.js crypto.createHash('sha256') for fast comparison.
   */
  private async executeWatch(task: TaskRecord): Promise<void> {
    let config: { url?: string; interval_minutes?: number; selector?: string; last_hash?: string };
    try {
      config = task.watch_config ? JSON.parse(task.watch_config) as typeof config : {};
    } catch {
      config = {};
    }

    if (!config.url) {
      const taskManager = this.engine.getTaskManager();
      if (taskManager) {
        taskManager.recordTaskRun(task.id, 'Watch task missing URL in config', 'failed');
      }
      return;
    }

    // Fetch the page via a headless session with http_request tool
    const fetchSession = this.engine.createSession({
      autonomy: 'autonomous',
      model: 'haiku', // cheap fetch — just reading a page
      systemPromptSuffix: WATCH_FETCH_SUFFIX,
    });

    const fetchResult = await fetchSession.run(
      `Fetch the content of this URL and return ONLY the raw text content, no commentary:\n${config.url}`,
    );

    // Hash the fetched content
    const currentHash = createHash('sha256').update(fetchResult).digest('hex');
    const previousHash = config.last_hash;

    if (previousHash && currentHash === previousHash) {
      // No change — record run silently, don't notify
      const taskManager = this.engine.getTaskManager();
      if (taskManager) {
        taskManager.recordTaskRun(task.id, 'No changes detected', 'success');
      }
      return;
    }

    // Content changed (or first run) — run analysis via agent
    const analysisSession = this.engine.createSession({
      autonomy: 'autonomous',
      systemPromptSuffix: WORKER_SUFFIX,
    });

    const isFirstRun = !previousHash;
    const analysisPrompt = isFirstRun
      ? `You are monitoring ${config.url} for changes. This is the first check — summarize what the page currently contains in 2-3 sentences. This will be the baseline for future comparisons.`
      : `You are monitoring ${config.url} for changes. The content has changed since last check. Here is the current content:\n\n${fetchResult.slice(0, 8000)}\n\nPrevious result was: ${task.last_run_result?.slice(0, 2000) ?? 'unknown'}\n\nSummarize what changed.`;

    const analysis = await analysisSession.run(analysisPrompt);
    const truncatedAnalysis = analysis.length > MAX_TASK_RESULT_CHARS
      ? analysis.slice(0, MAX_TASK_RESULT_CHARS) + '\u2026'
      : analysis;

    // Update config with new hash and record result
    config.last_hash = currentHash;
    const taskManager = this.engine.getTaskManager();
    if (taskManager) {
      taskManager.recordTaskRun(task.id, truncatedAnalysis, 'success');
      taskManager.updateWatchConfig(task.id, config);
    }

    // Notify — but not on first run (baseline only)
    if (!isFirstRun && this.notificationRouter.hasChannels()) {
      await this.notificationRouter.notify({
        title: `\uD83D\uDD0D ${task.title}`,
        body: truncatedAnalysis,
        taskId: task.id,
        priority: 'normal',
      });
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

const WATCH_FETCH_SUFFIX = `

## URL Fetch Mode
You are fetching a URL for content monitoring. Use the http_request tool to GET the URL.
Return ONLY the page text content — no commentary, no analysis, no markdown formatting.
If the page fails to load, return the error message.
`;
