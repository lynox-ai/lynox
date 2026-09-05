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
import { readBodyCapped, stripUntrustedSeparators } from './sanitize.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { TriggerRecord, PromptText } from '../types/index.js';
import { flattenPrompt } from './prompt-value.js';
import { WORKER_PROMPT_SUFFIX } from './prompts.js';
import { reservePersistentBudget, releasePersistentBudget, getSessionCostCeiling } from './session-budget.js';
// Pure budget arithmetic, no I/O. It lives under src/server/ because the HTTP
// handler was its first consumer; src/core/ is the better home now that there
// are two, and the move is deliberately NOT made here because it would edit
// http-api.ts, which core#1196 holds. `src/core/config.ts` already imports
// across the same seam, so this is precedented rather than novel.
import { WallClockBudget } from '../server/wall-clock-budget.js';

/** The canonical "the human did not answer" value. Spelled the same in
 *  `http-api.ts` (which calls it "the canonical skip marker") and in
 *  `onboarding-promotion.ts` (`ONBOARDING_SKIP_MARKER`), and recognised by
 *  `ask-user.ts`. It is a fourth literal copy, which is itself drift — hoisting
 *  all four to one exported constant is a follow-up, kept out of this change
 *  because it would edit http-api.ts (held by core#1196). */
const DISMISSED_ANSWER = '__dismissed__';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const MAX_TASK_RESULT_CHARS = 4000; // truncate for notifications
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000; // 5 minutes per task execution
// Per-run ceiling on a watch's change-analysis session — it is a single
// summarization turn, so a low cap bounds runaway LLM spend on a misbehaving
// watch (e.g. a page that changes every tick) without affecting normal use.
const WATCH_ANALYSIS_MAX_USD = 0.5;
const WORKER_MAX_ITERATIONS = 30; // cap agent loops per background task (cost control)
// Per-run cost ceiling on a standard/scheduled background task. executeWatch
// already caps its analysis turn at WATCH_ANALYSIS_MAX_USD; executeStandard runs
// a full autonomous task (up to WORKER_MAX_ITERATIONS loops) and previously had
// NO cost guard, so a runaway loop could burn unbounded LLM spend on a single
// unattended run. $15 is generous for a legitimate multi-step task yet well under
// the $50 interactive session ceiling. Doubles as the reservation estimate below.
const WORKER_MAX_COST_USD = 15;
// Hard ceiling on a watch target's response body. The 30s fetch timeout bounds
// TIME, not BYTES — a hostile/misconfigured watch URL streaming multi-GB within
// the window would buffer the whole body into memory and OOM the worker. 10 MB
// is far above any real HTML page; the signal extractor caps further at 256 KB.
const WATCH_MAX_BODY_BYTES = 10 * 1024 * 1024;

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
  // Strip exotic separators/control chars (NEL/U+2028/U+2029/C0/C1) the `\s+`
  // collapse below would otherwise leave on this attacker-controlled page text
  // before it is framed into the analysis LLM prompt — the same hardening #796
  // applies to the user's own message text. (`\s` already covers space/tab/LF/
  // CR/U+2028/U+2029 but NOT NEL or the rest of C0/C1.)
  return stripUntrustedSeparators(
    s
      // Bounded tag length keeps this linear instead of O(n^2) on '<' spam.
      .replace(/<[^>]{0,1000}>/g, ' ')
      .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, ' '),
  )
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

/** Active task state: abort control, the PAUSABLE execution deadline, and the
 *  store id of the prompt this task is currently parked on. */
export interface ActiveTask {
  controller: AbortController;
  /** Store id of the prompt this task is parked on; undefined while computing. */
  pendingPromptId?: string | undefined;
  /** Stop the execution deadline while parked on a human, and re-arm after.
   *  Human think-time must not consume the task's compute budget. */
  pauseDeadline: () => void;
  resumeDeadline: () => void;
}

/** Access the current worker task context from anywhere in the async call chain. */
export const workerTaskStorage = new AsyncLocalStorage<WorkerTaskContext>();

/**
 * Worst-case per-run cost used as the admission reservation — it must be an
 * UPPER BOUND on what the run can add to recorded spend, or the reservation
 * under-covers and parallel fire can still overshoot the cap. Each effect
 * reserves the ceiling its own enforcement actually guarantees:
 *  - run_agent (watch): the $0.50 analysis costGuard.
 *  - run_agent (standard): the $15 per-run costGuard (executeStandard).
 *  - run_workflow: NO per-run dollar cap of its own — a saved workflow is
 *    bounded only by the per-session ceiling (orchestrator per-step
 *    checkSessionBudget), so reserve that ceiling, not $15.
 * Non-money effects (backup/notify/reminder) reserve nothing and must never be
 * blocked by (or consume headroom from) the cap. Exported for direct testing.
 */
export function reservationEstimate(task: TriggerRecord): number {
  if (task.effect === 'run_agent') {
    return task.source === 'watch' ? WATCH_ANALYSIS_MAX_USD : WORKER_MAX_COST_USD;
  }
  if (task.effect === 'run_workflow') return getSessionCostCeiling();
  return 0;
}

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
      // No `resolve('Task cancelled.')` here any more. That string was handed to
      // a parked agent in the slot a USER ANSWER occupies, where it is not
      // distinguishable from one — the same failure `onboarding-promotion.ts`
      // guards with `ONBOARDING_SKIP_MARKER` after a control-flow string was
      // promoted as a literal fact. The wait is now a store prompt awaited with
      // this controller's signal, so aborting IS the cancellation and the waiter
      // observes `status: 'aborted'`.
      active.pauseDeadline();
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

  /** Resolve a pending user-input request for a background task. Returns true if resolved.
   *  Now a thin adapter over the prompt store: the same `answerUser` the HTTP
   *  reply route calls, so this method and the route settle the SAME row instead
   *  of two parallel mechanisms. It had zero callers for as long as it owned its
   *  own in-memory resolver. */
  resolveTaskInput(taskId: string, answer: string): boolean {
    const promptId = this.activeTasks.get(taskId)?.pendingPromptId;
    if (promptId === undefined) return false;
    return this.engine.getPromptStore()?.answerUser(promptId, answer) ?? false;
  }

  /** Get pending input request for a task, if any. */
  getTaskPendingInput(taskId: string): { question: string; options?: string[] | undefined } | undefined {
    const promptId = this.activeTasks.get(taskId)?.pendingPromptId;
    if (promptId === undefined) return undefined;
    const row = this.engine.getPromptStore()?.getById(promptId);
    if (!row) return undefined;
    const options = row.options_json ? (JSON.parse(row.options_json) as string[]) : undefined;
    return { question: row.question, options };
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
        // Admission control against the daily/monthly cap. This loop is fully
        // synchronous and reservePersistentBudget is synchronous, so every
        // due-task's reservation lands before any executeTask body runs — that
        // atomicity is what closes the parallel-fire race (each task sees the
        // prior reservations instead of the same stale pre-run total).
        const estimate = reservationEstimate(task);
        const reservation = reservePersistentBudget(estimate);
        if (!reservation.allowed) {
          // Cap would be exceeded by in-flight work — defer to a later tick.
          // The task stays due (next_run_at untouched) and retries once budget
          // frees or the daily window resets. No status write → no churn.
          continue;
        }
        // Fire and forget — don't await, execute in parallel. Release the
        // reservation once the task settles, via .finally so it runs even if
        // executeTask's synchronous prologue throws — a leaked reservation would
        // otherwise shrink the tenant's daily headroom for the process lifetime.
        void this.executeTask(task).finally(() => releasePersistentBudget(reservation.reservedUSD));
      }
    } catch {
      // Best-effort — don't crash the loop
    } finally {
      this.ticking = false;
    }
  }

  private async executeTask(task: TriggerRecord): Promise<void> {
    const controller = new AbortController();

    // The execution deadline. It used to be an `AbortSignal.timeout()` wired to
    // `controller.abort()` while nothing in this file ever read the signal, so
    // the deadline fired into the void. The invariant that matters now: the
    // signal has a consumer — the prompt wait below — so `stop()` reaches a task
    // parked on a human instead of leaving it awaiting a promise nobody can
    // settle.
    //
    // PAUSABLE, and that is load-bearing rather than tidy: `ask_user` is exempt
    // from the per-tool cap (`Agent.TOOL_TIMEOUT_EXEMPT`), so while a task is
    // parked this deadline is the only clock that could fire. Unpaused it would
    // abort the run mid-question — the exact failure `WallClockBudget` was
    // written for on the HTTP path (its docstring cites issue #77: the human
    // answers, the run is already gone). Human think-time must not consume
    // compute budget.
    //
    // NOTE ON REACH: the timer aborts the controller, which today ends a WAIT.
    // It does not kill a computing run — that needs `session.abort()`, and
    // enabling it is a separate, measured decision: on one production instance
    // 1 of 17 pipeline runs and 1 of 58 headless runs ran past this 5-minute
    // default, the longest being 15.2 minutes AND SUCCEEDING. Turning a bound
    // on that has never fired would abort work that completes today.
    const budget = new WallClockBudget(this.taskTimeoutMs);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (): void => {
      deadlineTimer = setTimeout(() => controller.abort(), budget.arm(Date.now()));
      deadlineTimer.unref();
    };
    const pauseDeadline = (): void => {
      if (deadlineTimer === undefined) return;
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      budget.pause(Date.now());
    };
    const resumeDeadline = (): void => {
      if (deadlineTimer !== undefined) return;
      armDeadline();
    };
    armDeadline();
    this.activeTasks.set(task.id, { controller, pauseDeadline, resumeDeadline });

    // AsyncLocalStorage — per-task context for logging/tracing
    const taskCtx: WorkerTaskContext = {
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.effect,
      startedAt: Date.now(),
    };

    try {
      await workerTaskStorage.run(taskCtx, async () => {
        // Dispatch on the EFFECT axis (S3-behaviour-a). This switch IS the
        // money-vs-deterministic boundary: run_workflow/run_agent may mint a Run
        // (→ managed onBeforeRun gate / onAfterRun debit); backup/notify never do.
        // `effect` is read as a plain string (the store casts it from a TEXT column,
        // so a value the union doesn't know — a newer schema, a synced/corrupt row —
        // is possible at runtime) → the default fails CLOSED, never a money run.
        const effect: string = task.effect;
        switch (effect) {
          case 'backup':
            await this.executeBackup(task);
            break;
          case 'notify':
            // Standalone reminder — notification only, no agent run. The
            // mail-anchored variant lives in inbox-reminder-poller.ts; this handles
            // user-created reminders (chat /reminder, AutomationHub) that may or may
            // not link to an inbox item.
            await this.executeReminder(task);
            break;
          case 'run_workflow':
            // executePipeline handles a null target_workflow_id (FK ON DELETE SET
            // NULL nulls a deleted workflow's link) as a benign skip — never a
            // fall-through to an autonomous run of the title.
            await this.executePipeline(task);
            break;
          case 'run_agent':
            // Consent gate (triggers-consent) — DEFENSE-IN-DEPTH backstop to the
            // primary getDueTriggers exclusion. A `run_agent` trigger runs an
            // AUTONOMOUS agent turn (the injection-amplification surface), so unlike
            // the deterministic effects it needs an explicit human first-run-confirm
            // (`run_workflow` has its own confirmedAt gate in executePipeline;
            // backup/notify are deterministic → exempt). getDueTriggers already
            // excludes an unconfirmed one, so this branch is normally unreachable; if
            // a `confirmed_at`-less run_agent trigger ever reaches dispatch (a direct
            // executeTask call, a bypassed read path), refuse it — record + stop,
            // NEVER mint the autonomous run.
            if (!task.confirmed_at) {
              this.recordAndNotify(task, 'This scheduled agent action needs your confirmation before it runs unattended — skipped.', false);
              break;
            }
            // Source-gated executor choice — NOT a money boundary (both branches are
            // the run_agent effect = may mint a Run). A `watch` source runs its
            // change-detection gate first (executeWatch: no change → no spend); any
            // other source runs the agent turn directly (executeStandard).
            if (task.source === 'watch') {
              await this.executeWatch(task);
            } else {
              await this.executeStandard(task);
            }
            break;
          default:
            // Fail-closed (RU2): an unknown effect must NOT reach an autonomous
            // money-spending run. Record + stop, so it stops re-firing every tick.
            this.recordAndNotify(task, `Unknown trigger effect '${effect}' — skipped`, false);
        }
      });
    } catch (err: unknown) {
      // Bugsink capture for background task failures
      void import('./error-reporting.js').then(({ captureError }) => {
        import('@sentry/node').then((Sentry) => {
          Sentry.withScope((scope) => {
            scope.setTag('task.id', task.id);
            scope.setTag('task.source', task.source);
            scope.setTag('task.effect', task.effect);
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

      // If the task was parked on a human it was interrupted while waiting.
      // It used to be RESOLVED with 'Task failed while waiting for your
      // response.' — a sentence delivered into the slot a user answer occupies,
      // which the model cannot tell from an answer. Aborting the controller
      // ends the store wait as `aborted` instead, a state the caller reads as
      // a non-answer.
      const active = this.activeTasks.get(task.id);
      if (active) {
        active.pauseDeadline();
        active.controller.abort();
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
      // Clear the deadline timer before dropping the entry — `pauseDeadline` is
      // idempotent and is the only handle on it once the map entry is gone.
      this.activeTasks.get(task.id)?.pauseDeadline();
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
      // Per-run cost ceiling: without this an autonomous background task could
      // loop up to WORKER_MAX_ITERATIONS times with no dollar bound. The guard
      // stops the agent loop once estimated spend crosses the cap.
      costGuard: { maxBudgetUSD: WORKER_MAX_COST_USD },
    });
    // Cost control: cap agent loop iterations for background tasks
    // Worker profile: route background tasks to cheaper provider (e.g. Mistral)
    const workerProfile = this.engine.getUserConfig().worker_profile;
    session._recreateAgent({ maxIterations: WORKER_MAX_ITERATIONS, autonomy: 'autonomous', profile: workerProfile });

    // Wire promptUser through the PROMPT STORE — the same surface the HTTP path
    // uses (`insertAskUser` -> `waitForSettled`). It used to be a bare Promise
    // whose `resolve` sat in memory under `activeTasks`, and that second,
    // poorer copy is what made a background question unanswerable: no
    // persistence, no 24h expiry, no abort, and an answer method
    // (`resolveTaskInput`) with zero callers because the route that settles a
    // prompt — `POST /api/sessions/:id/reply` -> `answerUser` — only ever knew
    // about store rows. Going through the store INHERITS all four rather than
    // re-implementing them.
    // Captured ONCE, here, where `executeTask` has just put the entry in the map
    // (both entry points — `tick` and `runTriggerNow` — go through it). Looking
    // it up per call instead was a real defect: `stop()` CLEARS the map, so a
    // second `ask_user` after a cancellation found `undefined`, skipped the
    // aborted-check below, and then waited with NO signal — an unabortable park
    // for the full 24h TTL. The entry object outlives the map entry, which is
    // exactly what makes the cancellation observable after a `stop()`.
    const active = this.activeTasks.get(task.id);
    session.promptUser = async (rawQuestion: string | PromptText, options?: string[]): Promise<string> => {
      // Resolved at ASK time, not at wiring time: `Engine._promptStore` starts
      // null and is assigned during init (engine.ts:1101), and is set back to
      // null if that init fails — so a store captured when the task started
      // could be stale in both directions.
      const promptStore = this.engine.getPromptStore();
      // A background task surfaces through a notification body, which is plain
      // text with no renderer — so the frame/value split has nothing to protect
      // here and the flattened form is the honest one. This is the ONE
      // difference from the HTTP path that is deliberate, not a gap.
      const question = flattenPrompt(rawQuestion);
      // Already cancelled: `waitForSettled` would settle 'aborted' at once, but
      // only AFTER this inserted a row and pushed a high-priority question at a
      // user whose task is gone. Refuse before either side effect.
      if (active?.controller.signal.aborted === true) return DISMISSED_ANSWER;
      if (!promptStore) {
        // No store: no durable park and no way to answer. The canonical marker
        // is the honest outcome — hanging would be worse, and a prose sentence
        // would land in the slot an answer occupies.
        return DISMISSED_ANSWER;
      }
      const promptId = promptStore.insertAskUser(session.sessionId, question, options);
      if (active) {
        active.pendingPromptId = promptId;
        // Park the execution deadline: from here until the prompt settles the
        // clock must not run, or the human's think-time eats the task's budget.
        active.pauseDeadline();
      }
      void this.notificationRouter.notify({
        title: `\u2753 ${task.title}`,
        body: question,
        taskId: task.id,
        priority: 'high',
        // Deep-link to the asking thread so a tap opens the conversation where
        // the answer is expected (sw.js routes `data.threadId` \u2192 `/app?thread=\u2026`).
        // `promptId` rides along so a client can settle this exact row.
        data: { threadId: session.sessionId, promptId },
        inquiry: { question, options },
      });
      try {
        const outcome = await promptStore.waitForSettled(promptId, active?.controller.signal);
        if (outcome.status === 'answered') return outcome.row.answer ?? DISMISSED_ANSWER;
        // An ABORTED wait leaves the row `pending` — `waitForSettled` resolves
        // off the signal without touching it. Two consequences, both real: the
        // row keeps this session's slot in the partial unique index
        // (`pending_prompts(session_id) WHERE status='pending'`), so the agent's
        // very next `ask_user` throws `PromptConflictError` out of this closure;
        // and it stays answerable for its full TTL with nobody awaiting the
        // answer — the shape `WallClockBudget`'s docstring cites as issue #77.
        // Drain it, the same call the HTTP takeover path makes. Idempotent, so
        // an already-`expired` outcome costs one no-op UPDATE.
        //
        // SWALLOWED, and not defensively: this runs on the CANCELLATION path,
        // and `Engine.shutdown()` calls `stop()` and later closes the history
        // DB — so the write can land on a closed handle and throw. Letting that
        // escape would reject `promptUser` and leave the agent's wait unsettled,
        // i.e. the failure this whole change removes, re-introduced by its own
        // cleanup. `http-api.ts` swallows the same call for the same reason and
        // names the cost in its comment: the row may survive to its TTL. A
        // leaked row is strictly better than a wedged wait.
        try { promptStore.expirePrompt(promptId); } catch { /* closing/closed DB — the wait must still settle */ }
        return DISMISSED_ANSWER;
      } finally {
        if (active) {
          active.pendingPromptId = undefined;
          // Only re-arm while this entry is still the live one. `stop()` clears
          // the map, and `executeTask`'s finally can only clear a timer it can
          // still reach through it — so resuming a dropped entry arms a timer
          // that no longer has an owner. It is `unref()`d and its fire is a
          // no-op on an already-aborted controller, so this is hygiene, not a
          // behaviour fix; the mutation that removes it survives by design.
          if (this.activeTasks.get(task.id) === active) active.resumeDeadline();
        }
      }
    };

    const prompt = task.description && task.description.trim() !== task.title.trim()
      ? `Task: ${task.title}\n\n${task.description}`
      : `Task: ${task.title}`;

    // Attribute the run to its trigger source (P1, DEF-0097) so this scheduled
    // automation turn is distinguishable from a user chat turn in run-history.
    const result = await session.run(prompt, { triggerOrigin: task.source });
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
        // Deep-link the notification to THIS run's chat thread so a tap opens the
        // result instead of a blank new chat (the service worker routes
        // `data.threadId` \u2192 `/app?thread=\u2026`). session.sessionId is the thread id.
        data: { threadId: session.sessionId },
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
    if (!runHistory) return;
    if (!task.pipeline_id) {
      // The target workflow was deleted (engine.db FK ON DELETE SET NULL nulled
      // target_workflow_id) or was never exact-resolved at insert. Routed here by
      // effect=run_workflow, so a null target lands here rather than at
      // executeStandard. Same benign skip as a workflow deleted mid-flight (below):
      // record it and stop — NEVER run the trigger title as an autonomous task.
      this.recordAndNotify(task, 'Pipeline target workflow no longer exists (skipped)', false);
      return;
    }

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
      fetchResult = await readBodyCapped(res, WATCH_MAX_BODY_BYTES);
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
    const hashInput = currentSignal.length > 0 ? currentSignal : `\u0000empty:${fetchResult.length}`;
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

    // noTools: this turn embeds up to 8 KB of the WATCHED PAGE — content the
    // user did not author and an attacker may control (a monitored forum, a
    // competitor page). A summarize turn needs no tools, so suppress the whole
    // registry: an injected "run bash …" then has nothing to call, rather than
    // relying on the consent gate (this session is autonomous + headless, where
    // a non-critical dangerous tool would AUTO-GRANT — see permission-guard
    // _detectDanger). Removing the capability beats gating it. Same mechanism the
    // compaction summarizer uses for the same "pure summarize" shape.
    const analysis = await analysisSession.run(analysisPrompt, { noTools: true, triggerOrigin: 'watch' });
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


