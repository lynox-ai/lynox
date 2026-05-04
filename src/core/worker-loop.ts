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
import { lookup } from 'node:dns/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TaskRecord } from '../types/index.js';
import { WORKER_PROMPT_SUFFIX } from './prompts.js';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_TASK_RESULT_CHARS = 4000; // truncate for notifications
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000; // 5 minutes per task execution
const WORKER_MAX_ITERATIONS = 30; // cap agent loops per background task (cost control)

/** Per-task execution context available via AsyncLocalStorage. */
export interface WorkerTaskContext {
  taskId: string;
  taskTitle: string;
  taskType: string;
  startedAt: number;
}

/** Active task state including abort control and optional pending user input. */
export interface ActiveTask {
  controller: AbortController;
  pendingInput?: {
    question: string;
    options?: string[] | undefined;
    resolve: (answer: string) => void;
  } | undefined;
}

/** Access the current worker task context from anywhere in the async call chain. */
export const workerTaskStorage = new AsyncLocalStorage<WorkerTaskContext>();

export class WorkerLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // prevent overlapping ticks
  private readonly activeTasks = new Map<string, ActiveTask>();

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
    for (const [, active] of this.activeTasks) {
      if (active.pendingInput) {
        active.pendingInput.resolve('Task cancelled.');
        active.pendingInput = undefined;
      }
      active.controller.abort();
    }
    this.activeTasks.clear();
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /** Resolve a pending user-input request for a background task. Returns true if resolved. */
  resolveTaskInput(taskId: string, answer: string): boolean {
    const active = this.activeTasks.get(taskId);
    if (!active?.pendingInput) return false;
    active.pendingInput.resolve(answer);
    active.pendingInput = undefined;
    return true;
  }

  /** Get pending input request for a task, if any. */
  getTaskPendingInput(taskId: string): { question: string; options?: string[] | undefined } | undefined {
    const active = this.activeTasks.get(taskId);
    if (!active?.pendingInput) return undefined;
    return { question: active.pendingInput.question, options: active.pendingInput.options };
  }

  /** @internal Exposed for testing. */
  async tick(): Promise<void> {
    if (this.ticking) return; // skip if previous tick still running
    this.ticking = true;
    try {
      const taskManager = this.engine.getTaskManager();
      if (!taskManager) return;

      const dueTasks = taskManager.getDueTasks();

      // Missed run detection: warn about tasks that were due >10min ago
      const now = Date.now();
      for (const task of dueTasks) {
        if (task.next_run_at) {
          const dueAt = new Date(task.next_run_at).getTime();
          const delayMs = now - dueAt;
          if (delayMs > 10 * 60_000) {
            const delayMin = Math.round(delayMs / 60_000);
            process.stderr.write(
              `[lynox:worker] Missed run: "${task.title}" (${task.id}) was due ${String(delayMin)}min ago\n`,
            );
          }
        }
      }

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
    this.activeTasks.set(task.id, { controller });

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
        if (task.task_type === 'backup') {
          await this.executeBackup(task);
        } else if (task.pipeline_id) {
          await this.executePipeline(task);
        } else if (task.task_type === 'watch') {
          await this.executeWatch(task);
        } else {
          await this.executeStandard(task);
        }
      });
    } catch (err: unknown) {
      // Bugsink capture for background task failures
      void import('./error-reporting.js').then(({ captureError }) => {
        import('@sentry/node').then((Sentry) => {
          Sentry.withScope((scope) => {
            scope.setTag('task.id', task.id);
            scope.setTag('task.type', task.task_type ?? 'manual');
            scope.setTag('source', 'worker-loop');
            captureError(err);
          });
        }).catch(() => {
          // @sentry/node not installed — use basic capture
          captureError(err);
        });
      }).catch(() => {});

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

      // If task had pending input, it was interrupted while waiting
      const active = this.activeTasks.get(task.id);
      if (active?.pendingInput) {
        active.pendingInput.resolve('Task failed while waiting for your response.');
        active.pendingInput = undefined;
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

  /** Execute a backup task — no LLM needed, direct BackupManager call. */
  private async executeBackup(task: TaskRecord): Promise<void> {
    const backupManager = this.engine.getBackupManager();
    if (!backupManager) {
      throw new Error('Backup manager not initialized');
    }

    const result = await backupManager.createBackup();
    const taskManager = this.engine.getTaskManager();

    if (taskManager) {
      taskManager.recordTaskRun(
        task.id,
        result.success
          ? `Backup created: ${result.path} (${String(result.duration_ms)}ms)`
          : `Backup failed: ${result.error ?? 'unknown'}`,
        result.success ? 'success' : 'failed',
      );
    }

    // Auto-prune old backups
    const config = this.engine.getUserConfig();
    const retentionDays = config.backup_retention_days ?? 30;
    if (retentionDays > 0) {
      backupManager.pruneBackups(retentionDays);
    }

    if (!result.success) {
      throw new Error(result.error ?? 'Backup failed');
    }
  }

  /** Execute a standard or scheduled task via headless Session. */
  private async executeStandard(task: TaskRecord): Promise<void> {
    const session = this.engine.createSession({
      autonomy: 'autonomous',
      systemPromptSuffix: WORKER_PROMPT_SUFFIX,
    });
    // Cost control: cap agent loop iterations for background tasks
    // Worker profile: route background tasks to cheaper provider (e.g. Mistral)
    const workerProfile = this.engine.getUserConfig().worker_profile;
    session._recreateAgent({ maxIterations: WORKER_MAX_ITERATIONS, autonomy: 'autonomous', profile: workerProfile });

    // Wire promptUser so background tasks can ask questions via notifications
    session.promptUser = (question: string, options?: string[]): Promise<string> => {
      return new Promise<string>((resolve) => {
        const active = this.activeTasks.get(task.id);
        if (active) {
          active.pendingInput = { question, options, resolve };
        }
        void this.notificationRouter.notify({
          title: `\u2753 ${task.title}`,
          body: question,
          taskId: task.id,
          priority: 'high',
          inquiry: { question, options },
        });
      });
    };

    const prompt = task.description && task.description.trim() !== task.title.trim()
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

  /** Execute a pipeline task — tracked (via session) or orchestrated (via DAG engine). */
  private async executePipeline(task: TaskRecord): Promise<void> {
    const runHistory = this.engine.getRunHistory();
    if (!runHistory || !task.pipeline_id) return;

    // Try to load as a PlannedPipeline first (tracked mode)
    const { getPipeline } = await import('../tools/builtin/pipeline.js');
    const planned = getPipeline(task.pipeline_id, runHistory);

    if (planned && planned.executionMode === 'tracked') {
      await this.executeTrackedPipeline(task, planned);
      return;
    }

    // Fallback: orchestrated execution via DAG engine
    const manifestJson = runHistory.getPipelineRunManifest(task.pipeline_id);
    if (!manifestJson) {
      throw new Error(`Pipeline ${task.pipeline_id} not found`);
    }

    const rawManifest = JSON.parse(manifestJson) as unknown;
    const config = this.engine.getUserConfig();

    // DB-persisted manifests can be from older schema versions or partially
    // stored — revalidate before running so a malformed `agents` field surfaces
    // as a typed error instead of a deep stack-trace from computePhases.
    const { runManifest, validateManifest } = await import('../orchestrator/runner.js');
    const manifest = validateManifest(rawManifest);
    const state = await runManifest(manifest, config, { runHistory });

    const success = state.status === 'completed';
    const stepCount = state.outputs.size;
    const resultSummary = success
      ? `Pipeline completed: ${String(stepCount)} steps`
      : `Pipeline ${state.status}: ${state.error ?? 'unknown error'}`;

    this.recordAndNotify(task, resultSummary, success);
  }

  /** Execute a tracked pipeline via a headless session (agent executes + step_complete). */
  private async executeTrackedPipeline(
    task: TaskRecord,
    planned: import('../types/index.js').PlannedPipeline,
  ): Promise<void> {
    const { startTrackedPlan } = await import('./plan-tracker.js');

    const stepsDescription = planned.steps
      .map((s, i) => {
        const deps = s.input_from?.length ? ` (after: ${s.input_from.join(', ')})` : '';
        return `${String(i + 1)}. [${s.id}] ${s.task}${deps}`;
      })
      .join('\n');

    const prompt = `Execute this workflow plan. After completing each step, call step_complete(step_id, summary).

Goal: ${planned.goal}

Steps:
${stepsDescription}`;

    const session = this.engine.createSession({
      autonomy: 'autonomous',
      systemPromptSuffix: WORKER_PROMPT_SUFFIX,
    });
    const workerProfile2 = this.engine.getUserConfig().worker_profile;
    session._recreateAgent({ maxIterations: WORKER_MAX_ITERATIONS, autonomy: 'autonomous', profile: workerProfile2 });

    // Activate tracked plan on the session's toolContext
    const toolContext = this.engine.getToolContext();
    startTrackedPlan(planned, toolContext);

    try {
      const result = await session.run(prompt);
      const success = toolContext.activePlan === null; // null = finalized successfully
      const resultSummary = success
        ? `Tracked workflow completed: ${String(planned.steps.length)} steps`
        : `Tracked workflow incomplete: ${result.slice(0, 200)}`;
      this.recordAndNotify(task, resultSummary, success);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordAndNotify(task, `Tracked workflow failed: ${msg}`, false);
    }
  }

  private recordAndNotify(task: TaskRecord, resultSummary: string, success: boolean): void {
    const taskManager = this.engine.getTaskManager();
    if (taskManager) {
      taskManager.recordTaskRun(task.id, resultSummary, success ? 'success' : 'failed');
    }

    if (this.notificationRouter.hasChannels()) {
      void this.notificationRouter.notify({
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

    // SSRF protection: only allow http/https, block internal networks (with DNS resolution)
    const parsedUrl = new URL(config.url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`Watch task: only HTTP/HTTPS URLs allowed, got ${parsedUrl.protocol}`);
    }
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    // Check hostname string first
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      throw new Error('Watch task: internal/private URLs are not allowed');
    }
    // Resolve DNS and check the actual IP
    try {
      const { address } = await lookup(hostname);
      const mapped = address.startsWith('::ffff:') ? address.slice(7) : address;
      const v4Parts = mapped.split('.');
      if (v4Parts.length === 4 && v4Parts.every(p => /^\d{1,3}$/.test(p))) {
        const [a, b] = v4Parts.map(Number) as [number, number, number, number];
        if (a === 127 || a === 10 || a === 0 || a >= 224
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254)
            || (a === 100 && b >= 64 && b <= 127)) {
          throw new Error('Watch task: internal/private URLs are not allowed');
        }
      }
      const normalized = address.toLowerCase();
      if (normalized === '::1' || normalized === '::' || /^fe[89ab]/.test(normalized) || /^f[cd]/.test(normalized)) {
        throw new Error('Watch task: internal/private URLs are not allowed');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not allowed')) throw err;
      throw new Error(`Watch task: DNS resolution failed for ${hostname}`);
    }

    // Direct HTTP fetch — no LLM needed, saves ~$0.001 per check
    let fetchResult: string;
    try {
      const res = await fetch(config.url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'lynox-watch/1.0' },
        redirect: 'error',  // Prevent SSRF via redirect to internal endpoints
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)} ${res.statusText}`);
      }
      fetchResult = await res.text();
    } catch (err: unknown) {
      throw new Error(`Watch fetch failed for ${config.url}: ${err instanceof Error ? err.message : String(err)}`);
    }

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
      systemPromptSuffix: WORKER_PROMPT_SUFFIX,
    });
    const workerProfile3 = this.engine.getUserConfig().worker_profile;
    if (workerProfile3) {
      analysisSession._recreateAgent({ profile: workerProfile3 });
    }

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


