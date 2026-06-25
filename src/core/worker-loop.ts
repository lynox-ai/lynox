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
import { fetchPinned } from './network-guard.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord } from '../types/index.js';
import { WORKER_PROMPT_SUFFIX } from './prompts.js';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_TASK_RESULT_CHARS = 4000; // truncate for notifications
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000; // 5 minutes per task execution
// Per-run ceiling on a watch's change-analysis session — it is a single
// summarization turn, so a low cap bounds runaway LLM spend on a misbehaving
// watch (e.g. a page that changes every tick) without affecting normal use.
const WATCH_ANALYSIS_MAX_USD = 0.5;
const WORKER_MAX_ITERATIONS = 30; // cap agent loops per background task (cost control)

/**
 * Reduce a fetched HTML page to a stable visible-content signal for change
 * detection. Hashing raw HTML makes a watch fire on every <script> nonce, CSP
 * token, build-id or timestamp churn even when nothing the user cares about
 * changed (the mistral.ai/news watch fired its analysis LLM daily for ~$0.25
 * on byte-churn alone). Stripping <script>/<style>/<noscript>/<meta>/<link>/
 * comments and collapsing whitespace leaves the visible text + <title> — what
 * "did the page change" actually means. An optional bare-tag `selector` (e.g.
 * "main", "article") narrows to the first matching region; #id/.class selectors
 * need a DOM parser and fall back to whole-page text.
 *
 * Detects visible-text + title changes; attribute/link-only changes (e.g. an
 * href version bump) are intentionally NOT detected (including attributes would
 * re-introduce the nonce/data-* churn this exists to remove). Input is
 * length-capped + quantifiers bounded because it runs on untrusted page bytes.
 * Exported for unit testing.
 */
export function extractWatchSignal(html: string, selector?: string): string {
  // Cap before any regex — this runs synchronously on the WorkerLoop over an
  // untrusted, uncapped fetched body; an unbounded tag-strip is O(n^2) on a
  // page of unclosed '<' and would hang the loop. 256 KB is far more HTML than
  // a content page a watch cares about.
  const MAX_INPUT = 256 * 1024;
  let s = (html.length > MAX_INPUT ? html.slice(0, MAX_INPUT) : html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]{0,2000}>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]{0,2000}>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]{0,2000}>[\s\S]*?<\/noscript>/gi, ' ')
    // <meta>/<link> are the churn-heavy head elements (CSP nonces, preload
    // hashes, csrf). Drop them but KEEP <title> (a title change is real).
    .replace(/<(?:meta|link)\b[^>]{0,2000}>/gi, ' ');
  // Best-effort region narrowing for a bare-tag selector (the common
  // "watch the article list" case). Nested same-name tags aren't handled —
  // it falls back to the whole body, which the text-strip below still
  // stabilises. #id / .class selectors need a real DOM parser (follow-up).
  if (selector) {
    const tag = selector.trim().toLowerCase();
    if (/^[a-z][a-z0-9]{0,40}$/.test(tag)) {
      const m = new RegExp(`<${tag}\\b[^>]{0,2000}>([\\s\\S]*?)</${tag}>`, 'i').exec(s);
      if (m && m[1]) s = m[1];
    }
  }
  return s
    // Bounded tag length keeps this linear instead of O(n^2) on '<' spam.
    .replace(/<[^>]{0,1000}>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  /**
   * Run a trigger immediately, off-schedule — the "Run now" UI action.
   *
   * Dispatches through the SAME `executeTask` path the scheduler uses, so a
   * manual run inherits every gate and wrapper the scheduled run has:
   * - the autonomous-only + first-run-confirm consent gate for pipeline
   *   triggers (`executePipeline` refuses an un-confirmed workflow — a manual
   *   run can't smuggle past consent any more than a cron tick can);
   * - the abort/timeout controller, per-task context, Bugsink capture, and
   *   result/failure notification.
   *
   * Fire-and-forget: a pipeline run can take minutes, so the caller is not made
   * to await it — the outcome lands in the trigger's run history (and, on
   * failure, the escalation thread). The typed result lets the HTTP layer 404 a
   * stale id and 409 a trigger that is already running (the scheduler picked it
   * up, or a previous Run-now is still in flight). Does NOT consult the
   * `enabled` kill-switch: pausing stops the *schedule* from auto-firing; an
   * explicit manual run is a deliberate override (the consent gate still bites).
   */
  async runTriggerNow(
    triggerId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_running' }> {
    const taskManager = this.engine.getTaskManager();
    if (!taskManager) return { ok: false, reason: 'not_found' };
    const trigger = taskManager.getTrigger(triggerId);
    if (!trigger) return { ok: false, reason: 'not_found' };
    if (this.activeTasks.has(trigger.id)) return { ok: false, reason: 'already_running' };
    // Resolve to the canonical id (getTrigger accepts an id-prefix) so the
    // activeTasks guard + run history key on exactly the row we found.
    void this.executeTask(trigger);
    return { ok: true };
  }

  /** @internal Exposed for testing. */
  async tick(): Promise<void> {
    if (this.ticking) return; // skip if previous tick still running
    this.ticking = true;
    try {
      const taskManager = this.engine.getTaskManager();
      if (!taskManager) return;

      const dueTasks = taskManager.getDueTriggers();

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

  private async executeTask(task: TriggerRecord): Promise<void> {
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
        } else if (task.task_type === 'reminder') {
          // Standalone reminder — fire notification only, no agent run.
          // The mail-anchored variant lives in inbox-reminder-poller.ts;
          // this branch handles user-created reminders (chat /reminder
          // slash, AutomationHub-create) that may or may not link to
          // an inbox item.
          await this.executeReminder(task);
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
  private async executeBackup(task: TriggerRecord): Promise<void> {
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

  /**
   * Standalone reminder — emit a notification, record success. No agent
   * run, no LLM cost. The optional `inbox_item_id` link is documented in
   * the payload for the UI to deep-link, but firing logic stays simple:
   * a reminder = "tell the user something at time X".
   */
  private async executeReminder(task: TriggerRecord): Promise<void> {
    await this.notificationRouter.notify({
      title: 'Erinnerung',
      body: task.title,
      taskId: task.id,
      priority: 'normal',
    });
    const taskManager = this.engine.getTaskManager();
    if (taskManager) {
      taskManager.recordTaskRun(task.id, 'reminder fired', 'success');
    }
  }

  /** Execute a standard or scheduled task via headless Session. */
  private async executeStandard(task: TriggerRecord): Promise<void> {
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

  /** Execute a pipeline task — always orchestrated via the DAG engine (D9). */
  private async executePipeline(task: TriggerRecord): Promise<void> {
    const runHistory = this.engine.getRunHistory();
    if (!runHistory || !task.pipeline_id) return;

    // Load the PlannedPipeline (if any) to enforce the autonomous-only gate.
    const { getPipeline } = await import('../tools/builtin/pipeline.js');
    const planned = getPipeline(task.pipeline_id, runHistory);

    // Benign race: the workflow was deleted between scheduling and this
    // executor tick. Record a skip (so the task list reflects reality) and
    // return without surfacing to Bugsink — there's nothing to fix in code.
    if (!planned) {
      this.recordAndNotify(task, `Pipeline ${task.pipeline_id} no longer exists (skipped)`, false);
      return;
    }

    // Hard gate: WorkerLoop only runs autonomous pipelines. Interactive
    // pipelines that somehow got onto a cron schedule (legacy data, manual
    // edit, sync from another instance) are refused at the boundary so they
    // can't hang waiting for a non-existent live session.
    if (planned.mode !== 'autonomous') {
      throw new Error(
        `Pipeline "${planned.id}" is marked '${planned.mode}'; WorkerLoop only runs 'autonomous' pipelines. ` +
        `Convert it (remove ask_user/ask_secret steps) or invoke it manually from a chat session.`,
      );
    }

    // Slice B2 — first-run-confirm gate (S2, PRD §4.4): a workflow must have been
    // confirmed by a human before it runs unattended. The B2 scheduling surface
    // stamps `confirmedAt` as part of the consent action, so any workflow
    // scheduled through the product has it; enforce here too so a hand-edited /
    // synced task can't put an un-consented workflow on a cron. (No back-compat
    // carve-out for un-confirmed legacy schedules — pre-product there are none,
    // and the uniform gate is the correct foundation.)
    if (!planned.confirmedAt) {
      // Not confirmed for unattended execution — e.g. an agent-/sync-created
      // cron that skipped the consent flow (the product schedule flow always
      // confirms). Disable the schedule so it stops re-firing every tick and
      // surface why, instead of throwing (which would Bugsink-report an expected
      // state and retry it forever). Re-scheduling via the consent flow confirms
      // it + creates a fresh, enabled task.
      const tm = this.engine.getTaskManager();
      tm?.setEnabled?.(task.id, false);
      tm?.recordTaskRun(
        task.id,
        `Not run: workflow "${planned.id}" needs first-run confirmation. Schedule it from the workflow library (the consent step confirms it) — the schedule has been disabled.`,
        'failed',
      );
      return;
    }

    // Orchestrated execution via the exported saved-workflow entry point.
    //
    // `task.pipeline_id` points at the `status='planned'` `pipeline_runs` row
    // whose `manifest_json` is a `PlannedPipeline`, NOT a `Manifest` — the
    // previous direct-`getPipelineRunManifest` + `validateManifest` call
    // therefore threw on every scheduled fire (T1-5). `runSavedWorkflow`
    // performs the PlannedPipeline→Manifest conversion via the same code
    // path the Saved-Workflows-library "Run" button uses, and it never
    // consumes the template row, so the scheduled task can fire on every
    // subsequent tick instead of being marked `executed` on the first one.
    // Route through the budget + managed-credit lifecycle (cap, credit gate,
    // cost report) — runSavedWorkflow alone bypasses all three.
    // Slice B2: pass the param VALUES bound at schedule time (the cron run can't
    // prompt). Parsed defensively — a malformed blob degrades to no params rather
    // than throwing here. The schedule flow already bound + validated every
    // required param against the schema (requireAll), so the stored object is
    // complete; runSavedWorkflow re-binds it (a non-undefined object → requireAll
    // = true) and only fails if the schema gained a new required param AFTER the
    // schedule was created (an edit-via-chat concern for Slice C), surfaced as a
    // normal run failure.
    let scheduledParams: Record<string, unknown> | undefined;
    if (task.pipeline_params) {
      try {
        const parsed: unknown = JSON.parse(task.pipeline_params);
        if (parsed !== null && typeof parsed === 'object') {
          scheduledParams = parsed as Record<string, unknown>;
        }
      } catch { scheduledParams = undefined; }
    }

    const { runGuardedSavedWorkflow } = await import('./saved-workflow-runner.js');
    const result = await runGuardedSavedWorkflow(this.engine, task.pipeline_id, scheduledParams);

    if (!result.ok) {
      // Surface conversion / validation / not-found / not-template errors as
      // typed throws so the existing executeTask catch routes them through
      // Bugsink + recordTaskRun like any other task failure.
      throw new Error(result.error ?? `Pipeline ${task.pipeline_id} execution failed`);
    }

    const success = result.status === 'completed';
    if (success) {
      this.recordAndNotify(task, `Pipeline completed (run ${result.runId ?? 'unknown'})`, true);
      return;
    }

    // Slice B3 — escalation primitive (consumer #1): a failed scheduled run does
    // NOT just push. Record the failure, then open (or bump) an unread chat
    // thread loaded with the run's context — the user opens it + fixes in chat
    // (Slice C adds the retry/diagnose tools that act on the reply).
    this.engine.getTaskManager()?.recordTaskRun(task.id, `Pipeline ${result.status ?? 'unknown'}`, 'failed');
    const stepDetail = (result.stepErrors ?? [])
      .filter(s => s.error)
      .map(s => `• ${s.stepId}: ${s.error}`)
      .join('\n');
    // The run + workflow ids ride in the seeded body so the agent, when the user
    // replies, can diagnose the run (diagnose_workflow_run), edit the workflow
    // (update_workflow_steps) and re-run it (run_workflow) — Slice C2's fix flow.
    const ref = result.runId
      ? `(run ${result.runId}${task.pipeline_id ? ` · workflow ${task.pipeline_id}` : ''})`
      : (task.pipeline_id ? `(workflow ${task.pipeline_id})` : '');
    this.engine.escalateToUser({
      key: task.id,
      title: `✗ ${task.title}`,
      body:
        `Your scheduled workflow "${task.title}" didn't complete (status: ${result.status ?? 'unknown'}).\n\n` +
        (result.error ? `Error: ${result.error}\n\n` : '') +
        (stepDetail ? `Failed steps:\n${stepDetail}\n\n` : '') +
        `Reply here and I'll help you fix it — I have this run loaded${ref ? ` ${ref}` : ''}.`,
      data: { taskId: task.id, ...(result.runId ? { runId: result.runId } : {}) },
    });
  }

  private recordAndNotify(task: TriggerRecord, resultSummary: string, success: boolean): void {
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
  private async executeWatch(task: TriggerRecord): Promise<void> {
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

    // Direct HTTP fetch — no LLM needed, saves ~$0.001 per check.
    // fetchPinned resolves DNS once, rejects private/internal IPs, and pins the
    // socket to that IP (closing the rebind window) + never follows redirects,
    // so it subsumes the protocol/host/IP SSRF checks we used to hand-roll here.
    let fetchResult: string;
    try {
      const res = await fetchPinned(config.url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'lynox-watch/1.0' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)} ${res.statusText}`);
      }
      fetchResult = await res.text();
    } catch (err: unknown) {
      throw new Error(`Watch fetch failed for ${config.url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Reduce to a stable visible-content signal before hashing. Hashing the raw
    // HTML fired the analysis LLM on every nonce/CSP-token/build-id/timestamp
    // churn even when no visible content changed (a daily watch cost ~$0.25/run
    // for nothing). A watch created before this lands re-baselines once (its
    // old last_hash was over raw HTML) — no migration needed.
    const currentSignal = extractWatchSignal(fetchResult, config.selector);
    // An empty signal (error/blank page) would otherwise collapse distinct
    // responses to the same hash — key it by raw length so a 404 and a 500
    // don't read as "no change" from each other.
    const hashInput = currentSignal.length > 0 ? currentSignal : ` empty:${fetchResult.length}`;
    const currentHash = createHash('sha256').update(hashInput).digest('hex');
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
      // A watch is a single summarize-what-changed turn — a fast-tier job.
      // Without this it inherited the engine's default tier (often
      // 'balanced'/Sonnet), paying a premium model for change-detection. A
      // worker_profile (below) may still override the tier if the user set one.
      model: 'fast',
      systemPromptSuffix: WORKER_PROMPT_SUFFIX,
      costGuard: { maxBudgetUSD: WATCH_ANALYSIS_MAX_USD },
    });
    const workerProfile3 = this.engine.getUserConfig().worker_profile;
    if (workerProfile3) {
      analysisSession._recreateAgent({ profile: workerProfile3 });
    }

    const isFirstRun = !previousHash;
    // Pass the already-fetched, cleaned content inline and tell the agent NOT to
    // re-fetch. The old prompt truncated raw HTML mid-tag at ~8 KB (often inside
    // the <head>), so the agent re-fetched the full page via the http tool — a
    // second network fetch AND a second billed turn on every run.
    const WATCH_CONTENT_CHARS = 8000;
    const contentForPrompt = currentSignal.length > WATCH_CONTENT_CHARS
      ? currentSignal.slice(0, WATCH_CONTENT_CHARS) + ' […truncated]'
      : currentSignal;
    const analysisPrompt = isFirstRun
      ? `You are monitoring ${config.url} for changes. This is the first check. Here is the current page content (already fetched and cleaned for you — do NOT re-fetch the URL):\n\n${contentForPrompt}\n\nSummarize what the page currently contains in 2-3 sentences. This will be the baseline for future comparisons.`
      : `You are monitoring ${config.url} for changes. The content changed since the last check. Here is the current page content (already fetched and cleaned for you — do NOT re-fetch the URL):\n\n${contentForPrompt}\n\nPrevious summary was: ${task.last_run_result?.slice(0, 2000) ?? 'unknown'}\n\nSummarize what changed in 2-3 sentences.`;

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

    // Slice B3 — escalation primitive (consumer #2): a watcher finding opens (or
    // bumps) an unread chat thread with the finding as context, instead of a
    // push into the void. The user opens it to see what changed + can act on it
    // in chat. Not on the first run (baseline only). escalateToUser fires its own
    // push-as-wakeup (pointing at the thread).
    if (!isFirstRun) {
      this.engine.escalateToUser({
        key: task.id,
        title: `\uD83D\uDD0D ${task.title}`,
        body: `${config.url} changed.\n\n${truncatedAnalysis}`,
        data: { taskId: task.id },
      });
    }
  }
}


