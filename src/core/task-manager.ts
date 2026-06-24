import { randomUUID } from 'node:crypto';
import type { RunHistory } from './run-history.js';
import type { TaskRecord, TriggerRecord, TaskStatus, TaskPriority, MemoryScopeRef, PipelineMode } from '../types/index.js';
import { isValidCron, nextOccurrence } from './cron-parser.js';

/**
 * Optional injection point: returns the PipelineMode for a saved pipeline ID,
 * or null if unknown. Keeps task-manager free of a direct import on
 * tools/builtin/pipeline.ts (which would create a cycle through orchestrator).
 *
 * Engine wires this at startup; tests / headless CLI can leave it unset.
 */
type PipelineModeLookup = (pipelineId: string) => PipelineMode | null | undefined;
let pipelineModeLookup: PipelineModeLookup | undefined;

/** Wire the pipeline-mode lookup. Called by Engine bootstrap. */
export function setPipelineModeLookup(fn: PipelineModeLookup | undefined): void {
  pipelineModeLookup = fn;
}

export interface TaskCreateParams {
  title: string;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  assignee?: string | undefined;
  scopeType?: string | undefined;
  scopeId?: string | undefined;
  dueDate?: string | undefined;
  tags?: string[] | undefined;
  parentTaskId?: string | undefined;
  scheduleCron?: string | undefined;
  nextRunAt?: string | undefined;
  taskType?: string | undefined;
  watchConfig?: string | undefined;
  maxRetries?: number | undefined;
  notificationChannel?: string | undefined;
  pipelineId?: string | undefined;
  /** Slice B2: JSON-stringified bound param values for a scheduled workflow run. */
  pipelineParams?: string | undefined;
}

export interface TaskUpdateParams {
  title?: string | undefined;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assignee?: string | undefined;
  dueDate?: string | undefined;
  tags?: string[] | undefined;
  /** Reschedule a one-shot task. ISO 8601. Empty string clears the
   *  schedule (un-schedule without deleting). Mutually exclusive with
   *  scheduleCron. */
  nextRunAt?: string | undefined;
  /** Reschedule a recurring task. Standard cron or shorthand (e.g. '30m').
   *  Empty string clears the schedule. Mutually exclusive with nextRunAt. */
  scheduleCron?: string | undefined;
}

export interface WeekSummary {
  overdue: TaskRecord[];
  dueToday: TaskRecord[];
  dueThisWeek: TaskRecord[];
  inProgress: TaskRecord[];
}

const VALID_STATUSES = new Set<string>(['open', 'in_progress', 'completed', 'failed']);
const VALID_PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

export class TaskManager {
  constructor(private history: RunHistory) {}

  /**
   * Look up a USER-TODO by id (or id-prefix, for UX convenience). The optional
   * `scopeFilter` folds the ownership check into the same SQL read used by
   * the mutation path, so a sub-agent in scope A can never resolve a task
   * in scope B via short-prefix guess. Single-user installs leave it
   * undefined and skip the check.
   */
  getTask(id: string, scopeFilter?: Array<{ type: string; id: string }> | undefined): TaskRecord | undefined {
    return this.history.getTask(id, scopeFilter ? { scopeFilter } : undefined);
  }

  /** Look up an AGENT-TRIGGER by id (or id-prefix). Same scope guard as getTask. */
  getTrigger(id: string, scopeFilter?: Array<{ type: string; id: string }> | undefined): TriggerRecord | undefined {
    return this.history.getTrigger(id, scopeFilter ? { scopeFilter } : undefined);
  }

  create(params: TaskCreateParams): TaskRecord | TriggerRecord {
    const id = randomUUID().slice(0, 8);

    if (params.parentTaskId) {
      const parent = this.history.getTask(params.parentTaskId);
      if (!parent) {
        throw new Error(`Parent task not found: ${params.parentTaskId}`);
      }
    }

    if (params.priority && !VALID_PRIORITIES.has(params.priority)) {
      throw new Error(`Invalid priority: ${params.priority}`);
    }

    if (params.dueDate && !/^\d{4}-\d{2}-\d{2}/.test(params.dueDate)) {
      throw new Error(`Invalid due_date format: ${params.dueDate}. Use YYYY-MM-DD.`);
    }

    // Auto-trigger: if assigned to lynox with no explicit schedule/watch,
    // set nextRunAt = now so WorkerLoop picks it up immediately.
    let resolvedNextRunAt = params.nextRunAt;
    let resolvedTaskType = params.taskType;
    if (params.assignee === 'lynox' && !params.scheduleCron && !params.watchConfig && !params.nextRunAt) {
      resolvedNextRunAt = new Date().toISOString();
      resolvedTaskType = resolvedTaskType ?? 'manual';
    }

    // A row is an AGENT-TRIGGER (→ `triggers` table, fired by the WorkerLoop) if
    // it carries ANY firing/agent attribute; otherwise it's a USER-TODO (→
    // `tasks` table, never fired). Mirrors the migration-v42 predicate. The
    // auto-trigger above already stamped resolvedNextRunAt for assignee=lynox.
    const willBeTrigger = params.assignee === 'lynox'
      || Boolean(resolvedNextRunAt)
      || Boolean(params.scheduleCron)
      || Boolean(params.watchConfig)
      || Boolean(params.pipelineId)
      || Boolean(resolvedTaskType && resolvedTaskType !== 'manual');

    if (willBeTrigger) {
      // Reject any pipeline destined for background execution (cron, explicit
      // nextRunAt, or lynox auto-trigger above) whose mode is not 'autonomous'.
      // All three paths detach execution from the calling session and end up at
      // WorkerLoop, where ask_user has no live session to route back to. When
      // the lookup is unwired (tests / headless CLI) the WorkerLoop hard gate
      // is the backstop.
      const willRunInBackground = Boolean(params.scheduleCron) || Boolean(resolvedNextRunAt);
      if (willRunInBackground && params.pipelineId && pipelineModeLookup) {
        const mode = pipelineModeLookup(params.pipelineId);
        if (mode && mode !== 'autonomous') {
          throw new Error(
            `Cannot schedule pipeline "${params.pipelineId}": mode is '${mode}', but only 'autonomous' pipelines run via WorkerLoop (cron / nextRunAt / assignee=lynox). ` +
            `Remove ask_user/ask_secret steps or invoke the pipeline manually from a chat session.`,
          );
        }
      }

      this.history.insertTrigger({
        id,
        title: params.title,
        description: params.description,
        assignee: params.assignee ?? 'lynox',
        scopeType: params.scopeType ?? 'context',
        scopeId: params.scopeId ?? '',
        scheduleCron: params.scheduleCron,
        nextRunAt: resolvedNextRunAt,
        taskType: resolvedTaskType,
        watchConfig: params.watchConfig,
        maxRetries: params.maxRetries,
        notificationChannel: params.notificationChannel,
        pipelineId: params.pipelineId,
        pipelineParams: params.pipelineParams,
      });

      return this.history.getTrigger(id)!;
    }

    this.history.insertTask({
      id,
      title: params.title,
      description: params.description,
      priority: params.priority ?? 'medium',
      assignee: params.assignee,
      scopeType: params.scopeType ?? 'context',
      scopeId: params.scopeId ?? '',
      dueDate: params.dueDate ? params.dueDate.slice(0, 10) : undefined,
      tags: params.tags ? JSON.stringify(params.tags) : undefined,
      parentTaskId: params.parentTaskId,
    });

    return this.history.getTask(id)!;
  }

  complete(id: string, scopeFilter?: Array<{ type: string; id: string }> | undefined): TaskRecord | TriggerRecord | undefined {
    const scopeOpts = scopeFilter && scopeFilter.length > 0 ? { scopeFilter } : undefined;

    // An AGENT-TRIGGER has no subtask cascade — just flip its status. Carry
    // the scope guard into the UPDATE (same as the task branch) so a concurrent
    // re-scope between getTrigger() and updateTrigger() can't let the write
    // land on a now-out-of-scope row.
    const trigger = this.history.getTrigger(id, scopeOpts);
    if (trigger) {
      const ok = this.history.updateTrigger(trigger.id, { status: 'completed' }, scopeOpts);
      if (!ok) return undefined;
      return this.history.getTrigger(trigger.id, scopeOpts);
    }

    const task = this.history.getTask(id, scopeOpts);
    if (!task) return undefined;

    const now = new Date().toISOString();
    // Carry the scope guard into the UPDATE so a concurrent re-scope
    // between getTask() above and updateTask() below cannot let the write
    // land on a now-out-of-scope row.
    const ok = this.history.updateTask(task.id, { status: 'completed', completedAt: now }, scopeOpts);
    if (!ok) return undefined;

    // Subtasks inherit the parent's scope at creation time, so the same
    // filter applies. If a subtask was re-scoped out from under the parent
    // its update silently no-ops, which is the desired safe failure.
    const subtasks = this.history.getTasks({ parentTaskId: task.id });
    for (const sub of subtasks) {
      if (sub.status !== 'completed') {
        this.history.updateTask(sub.id, { status: 'completed', completedAt: now }, scopeOpts);
      }
    }

    return this.history.getTask(task.id, scopeOpts);
  }

  reopen(id: string, scopeFilter?: Array<{ type: string; id: string }> | undefined): TaskRecord | TriggerRecord | undefined {
    const scopeOpts = scopeFilter && scopeFilter.length > 0 ? { scopeFilter } : undefined;

    // Resolve + write under the same scope filter so a sub-agent in scope A
    // can't reopen a trigger/task in scope B via short-prefix guess, and so
    // the write can't land on a row re-scoped out from under the read.
    const trigger = this.history.getTrigger(id, scopeOpts);
    if (trigger) {
      this.history.updateTrigger(trigger.id, { status: 'open' }, scopeOpts);
      return this.history.getTrigger(trigger.id, scopeOpts);
    }

    const task = this.history.getTask(id, scopeOpts);
    if (!task) return undefined;

    this.history.updateTask(task.id, { status: 'open', completedAt: '' }, scopeOpts);
    return this.history.getTask(task.id, scopeOpts);
  }

  update(id: string, params: TaskUpdateParams, scopeFilter?: Array<{ type: string; id: string }> | undefined): TaskRecord | TriggerRecord | undefined {
    const scopeOpts = scopeFilter && scopeFilter.length > 0 ? { scopeFilter } : undefined;

    if (params.status && !VALID_STATUSES.has(params.status)) {
      throw new Error(`Invalid status: ${params.status}`);
    }
    if (params.priority && !VALID_PRIORITIES.has(params.priority)) {
      throw new Error(`Invalid priority: ${params.priority}`);
    }

    // Errors here surface to the LLM through the tool layer where the
    // field names are `run_at` / `schedule`, so the messages reference
    // those (not the camelCase param names) — otherwise the agent gets
    // an unactionable hint pointing at internal naming.
    if (params.nextRunAt !== undefined && params.scheduleCron !== undefined
        && params.nextRunAt !== '' && params.scheduleCron !== '') {
      throw new Error('run_at and schedule are mutually exclusive — pass only one (or "" to clear).');
    }
    // Date.parse is the same loose validator task_create uses, so the
    // create + update paths share their error surface. Tightening to a
    // strict ISO regex is a cross-cutting follow-up.
    if (params.nextRunAt && Number.isNaN(Date.parse(params.nextRunAt))) {
      throw new Error(`Invalid run_at: ${params.nextRunAt}. Use ISO 8601 datetime.`);
    }
    if (params.scheduleCron && !isValidCron(params.scheduleCron)) {
      throw new Error(`Invalid schedule: ${params.scheduleCron}. Use cron (e.g. '0 9 * * *') or shorthand ('30m', '1h', '1d').`);
    }

    // AGENT-TRIGGER path: schedule fields live here (the `triggers` table). The
    // schedule normalization is part of the trigger update — a TODO has no
    // next_run_at / schedule_cron columns.
    const trigger = this.history.getTrigger(id, scopeOpts);
    if (trigger) {
      const triggerUpdate: {
        title?: string | undefined;
        description?: string | undefined;
        status?: string | undefined;
        assignee?: string | undefined;
        nextRunAt?: string | null | undefined;
        scheduleCron?: string | null | undefined;
      } = {};
      if (params.title !== undefined) triggerUpdate.title = params.title;
      if (params.description !== undefined) triggerUpdate.description = params.description;
      if (params.status !== undefined) triggerUpdate.status = params.status;
      if (params.assignee !== undefined) triggerUpdate.assignee = params.assignee;

      // Schedule fields move as a pair: both nextRunAt and scheduleCron
      // are kept consistent so the worker-loop ("next_run_at <= now") and
      // the recurring re-fire path (recordTaskRun → nextOccurrence) never
      // disagree on a trigger's intent. Empty-string clears wipe BOTH so an
      // agent typing "cancel the schedule" can't leave a stale value
      // behind; setting one positive clears the other (a one-shot drops
      // any prior cron, a new cron drops any prior one-shot run_at).
      if (params.nextRunAt !== undefined) {
        // Normalise positive values to ISO so SQLite's lexicographic
        // `next_run_at <= now` comparison stays monotonic.
        triggerUpdate.nextRunAt = params.nextRunAt ? new Date(params.nextRunAt).toISOString() : '';
        if (params.scheduleCron === undefined) {
          triggerUpdate.scheduleCron = '';
        }
      }
      if (params.scheduleCron !== undefined) {
        triggerUpdate.scheduleCron = params.scheduleCron;
        if (params.nextRunAt === undefined) {
          // Positive cron → recompute the next fire from it.
          // Empty cron → clear next_run_at too (full un-schedule).
          triggerUpdate.nextRunAt = params.scheduleCron
            ? nextOccurrence(params.scheduleCron).toISOString()
            : '';
        }
      }

      const ok = this.history.updateTrigger(trigger.id, triggerUpdate, scopeOpts);
      if (!ok) return undefined;
      return this.history.getTrigger(trigger.id, scopeOpts);
    }

    const task = this.history.getTask(id, scopeOpts);
    if (!task) return undefined;

    const updateParams: {
      title?: string | undefined;
      description?: string | undefined;
      status?: string | undefined;
      priority?: string | undefined;
      assignee?: string | undefined;
      dueDate?: string | undefined;
      tags?: string | undefined;
      completedAt?: string | undefined;
    } = {};

    if (params.title !== undefined) updateParams.title = params.title;
    if (params.description !== undefined) updateParams.description = params.description;
    if (params.status !== undefined) updateParams.status = params.status;
    if (params.priority !== undefined) updateParams.priority = params.priority;
    if (params.assignee !== undefined) updateParams.assignee = params.assignee;
    if (params.dueDate !== undefined) updateParams.dueDate = params.dueDate ? params.dueDate.slice(0, 10) : '';
    if (params.tags !== undefined) updateParams.tags = params.tags ? JSON.stringify(params.tags) : '';

    if (params.status === 'completed' && task.status !== 'completed') {
      updateParams.completedAt = new Date().toISOString();
    } else if (params.status && params.status !== 'completed' && task.status === 'completed') {
      updateParams.completedAt = '';
    }

    const ok = this.history.updateTask(task.id, updateParams, scopeOpts);
    if (!ok) return undefined;
    return this.history.getTask(task.id, scopeOpts);
  }

  list(opts?: { status?: TaskStatus | undefined; scope?: MemoryScopeRef | undefined; assignee?: string | undefined }): TaskRecord[] {
    return this.history.getTasks({
      status: opts?.status,
      assignee: opts?.assignee,
      scopeType: opts?.scope?.type,
      scopeId: opts?.scope?.id,
    });
  }

  /** List AGENT-TRIGGERs (the WorkerLoop-fired rows: cron/watch/pipeline/etc). */
  listTriggers(opts?: { status?: TaskStatus | undefined; scope?: MemoryScopeRef | undefined; taskType?: string | undefined }): TriggerRecord[] {
    return this.history.getTriggers({
      status: opts?.status,
      taskType: opts?.taskType,
      scopeType: opts?.scope?.type,
      scopeId: opts?.scope?.id,
    });
  }

  /** The AGENT-TRIGGER rows lynox fires — surfaced in the briefing as "your
   *  tasks". Post-split these all live in the `triggers` table (every trigger
   *  is assignee=lynox), so no assignee filter is needed; just exclude terminal
   *  states. */
  getAssignedToLynox(scopes?: MemoryScopeRef[]): TriggerRecord[] {
    // Exclude terminal states. `failed` is terminal for one-shot triggers
    // (no retries remaining) — same as `completed`, it must not count
    // as active work or get re-surfaced in the briefing.
    const isActive = (t: TriggerRecord) => t.status !== 'completed' && t.status !== 'failed';
    if (scopes && scopes.length > 0) {
      const all: TriggerRecord[] = [];
      for (const scope of scopes) {
        const triggers = this.history.getTriggers({ scopeType: scope.type, scopeId: scope.id });
        for (const t of triggers) {
          if (!all.some(existing => existing.id === t.id)) all.push(t);
        }
      }
      return all.filter(isActive);
    }
    return this.history.getTriggers().filter(isActive);
  }

  getWeekSummary(scopes?: MemoryScopeRef[]): WeekSummary {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const endOfWeek = new Date(now);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    const weekEnd = endOfWeek.toISOString().slice(0, 10);

    const scopeArr = scopes?.map(s => ({ type: s.type, id: s.id }));

    const overdue = this.history.getOverdueTasks(scopeArr);
    const todayTasks = this.history.getTasksDueInRange(today, today, scopeArr);
    const weekTasks = this.history.getTasksDueInRange(today, weekEnd, scopeArr)
      .filter(t => t.due_date !== today); // exclude today's tasks

    // In progress across all scopes
    const inProgressOpts: { status?: string; scopeType?: string; scopeId?: string } = { status: 'in_progress' };
    // If we have scopes, get all in_progress for those scopes
    let inProgress: TaskRecord[];
    if (scopeArr && scopeArr.length > 0) {
      inProgress = [];
      for (const scope of scopeArr) {
        const tasks = this.history.getTasks({ status: 'in_progress', scopeType: scope.type, scopeId: scope.id });
        for (const t of tasks) {
          if (!inProgress.some(existing => existing.id === t.id)) {
            inProgress.push(t);
          }
        }
      }
    } else {
      inProgress = this.history.getTasks(inProgressOpts);
    }

    return { overdue, dueToday: todayTasks, dueThisWeek: weekTasks, inProgress };
  }

  getBriefingSummary(scopes?: MemoryScopeRef[]): string {
    const summary = this.getWeekSummary(scopes);
    const lynoxTasks = this.getAssignedToLynox(scopes);
    const parts: string[] = [];

    const total = summary.overdue.length + summary.dueToday.length + summary.dueThisWeek.length + summary.inProgress.length + lynoxTasks.length;
    if (total === 0) return '';

    const counts: string[] = [];
    if (summary.dueToday.length > 0) counts.push(`${summary.dueToday.length} due today`);
    if (summary.overdue.length > 0) counts.push(`${summary.overdue.length} overdue`);
    if (summary.inProgress.length > 0) counts.push(`${summary.inProgress.length} in progress`);
    if (summary.dueThisWeek.length > 0) counts.push(`${summary.dueThisWeek.length} due this week`);
    if (lynoxTasks.length > 0) counts.push(`${lynoxTasks.length} assigned to you`);
    parts.push(counts.join(', ') + '.');

    for (const t of summary.overdue) {
      const scope = t.scope_type === 'context' ? '' : ` (${t.scope_type}:${t.scope_id})`;
      const assignee = t.assignee ? ` [${t.assignee}]` : '';
      parts.push(`Overdue: "${t.title}"${scope}, due ${t.due_date}, ${t.priority.toUpperCase()}${assignee}`);
    }

    // Highlight tasks assigned to lynox that aren't already shown as overdue
    const overdueIds = new Set(summary.overdue.map(t => t.id));
    const pendingLynox = lynoxTasks.filter(t => !overdueIds.has(t.id));
    if (pendingLynox.length > 0) {
      parts.push('Your tasks (assigned to lynox) — propose working on these:');
      for (const t of pendingLynox) {
        // These are AGENT-TRIGGERs — no `due_date` column; surface the next
        // scheduled fire instead when present.
        const next = t.next_run_at ? `, next run ${t.next_run_at}` : '';
        parts.push(`  - "${t.title}" [${t.status}]${next}`);
      }
    }

    return `<task_overview>\n${parts.join('\n')}\n</task_overview>`;
  }

  getOverdueCount(scopes?: MemoryScopeRef[]): number {
    const scopeArr = scopes?.map(s => ({ type: s.type, id: s.id }));
    return this.history.getOverdueTasks(scopeArr).length;
  }

  getUpcomingDeadlines(scopes?: MemoryScopeRef[], days = 7): TaskRecord[] {
    const now = new Date();
    const start = now.toISOString().slice(0, 10);
    const end = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
    const scopeArr = scopes?.map(s => ({ type: s.type, id: s.id }));
    return this.history.getTasksDueInRange(start, end, scopeArr);
  }

  // ---------------------------------------------------------------------------
  // Scheduling CRUD
  // ---------------------------------------------------------------------------

  /** Create a scheduled recurring AGENT-TRIGGER. Sets task_type='scheduled', assignee='lynox', computes next_run_at. */
  createScheduled(params: TaskCreateParams & {
    scheduleCron: string;
    maxRetries?: number | undefined;
    notificationChannel?: string | undefined;
  }): TriggerRecord {
    if (!isValidCron(params.scheduleCron)) {
      throw new Error(`Invalid cron expression: ${params.scheduleCron}`);
    }

    const nextRun = nextOccurrence(params.scheduleCron);

    // assignee='lynox' + schedule → always lands in the `triggers` table.
    return this.create({
      ...params,
      assignee: 'lynox',
      taskType: 'scheduled',
      scheduleCron: params.scheduleCron,
      nextRunAt: nextRun.toISOString(),
      maxRetries: params.maxRetries,
      notificationChannel: params.notificationChannel,
    }) as TriggerRecord;
  }

  /** Create a pipeline AGENT-TRIGGER. Sets task_type='pipeline', assignee='lynox'. Optionally recurring via scheduleCron. */
  createPipelineTask(params: TaskCreateParams & {
    pipelineId: string;
    scheduleCron?: string | undefined;
    maxRetries?: number | undefined;
  }): TriggerRecord {
    if (params.scheduleCron) {
      if (!isValidCron(params.scheduleCron)) {
        throw new Error(`Invalid cron expression: ${params.scheduleCron}`);
      }
      const nextRun = nextOccurrence(params.scheduleCron);
      return this.create({
        ...params,
        assignee: 'lynox',
        taskType: 'pipeline',
        pipelineId: params.pipelineId,
        scheduleCron: params.scheduleCron,
        nextRunAt: nextRun.toISOString(),
        maxRetries: params.maxRetries,
      }) as TriggerRecord;
    }

    return this.create({
      ...params,
      assignee: 'lynox',
      taskType: 'pipeline',
      pipelineId: params.pipelineId,
      maxRetries: params.maxRetries,
    }) as TriggerRecord;
  }

  /** Slice B2: cron kill-switch — disable/enable a scheduled trigger without
   *  deleting it (so its schedule + stored params survive). Returns false if no
   *  trigger matched. */
  setEnabled(id: string, enabled: boolean): boolean {
    return this.history.setTriggerEnabled(id, enabled);
  }

  /** Create a watch/monitor AGENT-TRIGGER. Sets task_type='watch', assignee='lynox', computes next_run_at from interval. */
  createWatch(params: TaskCreateParams & {
    watchUrl: string;
    watchIntervalMinutes?: number | undefined;
    watchSelector?: string | undefined;
    notificationChannel?: string | undefined;
  }): TriggerRecord {
    const intervalMinutes = params.watchIntervalMinutes ?? 60;

    const watchConfig = JSON.stringify({
      url: params.watchUrl,
      interval_minutes: intervalMinutes,
      selector: params.watchSelector ?? null,
    });

    return this.create({
      ...params,
      assignee: 'lynox',
      taskType: 'watch',
      watchConfig,
      nextRunAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
      notificationChannel: params.notificationChannel,
    }) as TriggerRecord;
  }

  /** Get AGENT-TRIGGERs due for execution (next_run_at <= now, not completed). */
  getDueTriggers(): TriggerRecord[] {
    return this.history.getDueTriggers();
  }

  /** Update the watch_config JSON for a watch trigger (e.g. to store last_hash). */
  updateWatchConfig(id: string, config: Record<string, unknown>): void {
    this.history.updateTriggerWatchConfig(id, JSON.stringify(config));
  }

  /** Record the result of a worker trigger execution. Updates last_run_at, result, status, and optionally next_run_at for recurring triggers. */
  recordTaskRun(id: string, result: string, status: 'success' | 'failed' | 'timeout'): void {
    const task = this.history.getTrigger(id);
    if (!task) {
      throw new Error(`Trigger not found: ${id}`);
    }

    const now = new Date();
    const truncatedResult = result.length > MAX_RUN_RESULT_CHARS
      ? result.slice(0, MAX_RUN_RESULT_CHARS)
      : result;

    // Determine next_run_at based on trigger type.
    // `undefined` = leave column unchanged. `null` = explicitly clear
    // the column (one-shot trigger reached a terminal state and must NOT
    // be re-selected by getDueTriggers the next tick).
    let nextRunAt: string | null | undefined;
    let retryCount: number | undefined;

    if (task.schedule_cron) {
      // Recurring cron trigger — always compute next run
      nextRunAt = nextOccurrence(task.schedule_cron, now).toISOString();
      // Reset retry count on success
      if (status === 'success') retryCount = 0;
      // Surface the latest run outcome in `status` so silently-failing
      // cron triggers show up in the UI instead of staying 'open' forever.
      // This is derived state, NOT terminal: the cron schedule (not
      // status) keeps determining re-runs, and a subsequent successful
      // run flips status back to 'open' (auto-recovery on next success).
      // The `getDueTriggers` SELECT was widened so cron rows stay in the
      // worker queue even when status='failed' — see
      // run-history-persistence.ts `getDueTriggers`.
      // Guard: don't resurrect a cron that was manually marked
      // 'completed' mid-tick (narrow race between complete() and the
      // finishing tick).
      if (task.status !== 'completed') {
        this.history.updateTrigger(id, { status: status === 'success' ? 'open' : 'failed' });
      }
    } else if (task.watch_config) {
      // Watch trigger — compute next run from interval
      const config = JSON.parse(task.watch_config) as { interval_minutes: number };
      nextRunAt = new Date(now.getTime() + config.interval_minutes * 60_000).toISOString();
      // Reset retry count on success
      if (status === 'success') retryCount = 0;
    } else if (
      (status === 'failed' || status === 'timeout')
      && task.max_retries
      && (task.retry_count ?? 0) < task.max_retries
    ) {
      // Retry with exponential backoff if retries remaining
      retryCount = (task.retry_count ?? 0) + 1;
      const backoffMs = Math.min(60_000 * Math.pow(2, retryCount - 1), 30 * 60_000); // 1m, 2m, 4m... cap 30m
      nextRunAt = new Date(now.getTime() + backoffMs).toISOString();
    } else if (status === 'success') {
      // One-shot background trigger — mark as completed on success
      this.history.updateTrigger(id, { status: 'completed' });
    } else {
      // One-shot trigger that failed permanently (no max_retries, or
      // retries exhausted). Without this branch `next_run_at` would
      // stay set and `getDueTriggers` would re-select the trigger every
      // worker tick → runaway autonomous LLM spend. Mark it `failed`
      // and clear `next_run_at` so the worker leaves it alone, while
      // last_run_status preserves the actual outcome ('failed' vs
      // 'timeout') for the UI.
      this.history.updateTrigger(id, { status: 'failed' });
      nextRunAt = null;
    }

    this.history.updateTriggerRunResult(id, {
      lastRunAt: now.toISOString(),
      lastRunResult: truncatedResult,
      lastRunStatus: status,
      nextRunAt,
      retryCount,
    });
  }
}

const MAX_RUN_RESULT_CHARS = 10_000;
