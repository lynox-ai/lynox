import { randomUUID } from 'node:crypto';
import type { RunHistory } from './run-history.js';
import type { TaskRecord, TaskStatus, TaskPriority, MemoryScopeRef } from '../types/index.js';
import { isValidCron, nextOccurrence } from './cron-parser.js';

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
}

export interface TaskUpdateParams {
  title?: string | undefined;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assignee?: string | undefined;
  dueDate?: string | undefined;
  tags?: string[] | undefined;
}

export interface WeekSummary {
  overdue: TaskRecord[];
  dueToday: TaskRecord[];
  dueThisWeek: TaskRecord[];
  inProgress: TaskRecord[];
}

const VALID_STATUSES = new Set<string>(['open', 'in_progress', 'completed']);
const VALID_PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

export class TaskManager {
  constructor(private history: RunHistory) {}

  create(params: TaskCreateParams): TaskRecord {
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
      scheduleCron: params.scheduleCron,
      nextRunAt: params.nextRunAt,
      taskType: params.taskType,
      watchConfig: params.watchConfig,
      maxRetries: params.maxRetries,
      notificationChannel: params.notificationChannel,
    });

    return this.history.getTask(id)!;
  }

  complete(id: string): TaskRecord | undefined {
    const task = this.history.getTask(id);
    if (!task) return undefined;

    const now = new Date().toISOString();
    this.history.updateTask(task.id, { status: 'completed', completedAt: now });

    // Complete subtasks too
    const subtasks = this.history.getTasks({ parentTaskId: task.id });
    for (const sub of subtasks) {
      if (sub.status !== 'completed') {
        this.history.updateTask(sub.id, { status: 'completed', completedAt: now });
      }
    }

    return this.history.getTask(task.id);
  }

  reopen(id: string): TaskRecord | undefined {
    const task = this.history.getTask(id);
    if (!task) return undefined;

    this.history.updateTask(task.id, { status: 'open', completedAt: '' });
    return this.history.getTask(task.id);
  }

  update(id: string, params: TaskUpdateParams): TaskRecord | undefined {
    const task = this.history.getTask(id);
    if (!task) return undefined;

    if (params.status && !VALID_STATUSES.has(params.status)) {
      throw new Error(`Invalid status: ${params.status}`);
    }
    if (params.priority && !VALID_PRIORITIES.has(params.priority)) {
      throw new Error(`Invalid priority: ${params.priority}`);
    }

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

    this.history.updateTask(task.id, updateParams);
    return this.history.getTask(task.id);
  }

  list(opts?: { status?: TaskStatus | undefined; scope?: MemoryScopeRef | undefined; assignee?: string | undefined }): TaskRecord[] {
    return this.history.getTasks({
      status: opts?.status,
      assignee: opts?.assignee,
      scopeType: opts?.scope?.type,
      scopeId: opts?.scope?.id,
    });
  }

  getAssignedToNodyn(scopes?: MemoryScopeRef[]): TaskRecord[] {
    if (scopes && scopes.length > 0) {
      const all: TaskRecord[] = [];
      for (const scope of scopes) {
        const tasks = this.history.getTasks({ assignee: 'nodyn', scopeType: scope.type, scopeId: scope.id });
        for (const t of tasks) {
          if (!all.some(existing => existing.id === t.id)) all.push(t);
        }
      }
      return all.filter(t => t.status !== 'completed');
    }
    return this.history.getTasks({ assignee: 'nodyn' }).filter(t => t.status !== 'completed');
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
    const nodynTasks = this.getAssignedToNodyn(scopes);
    const parts: string[] = [];

    const total = summary.overdue.length + summary.dueToday.length + summary.dueThisWeek.length + summary.inProgress.length + nodynTasks.length;
    if (total === 0) return '';

    const counts: string[] = [];
    if (summary.dueToday.length > 0) counts.push(`${summary.dueToday.length} due today`);
    if (summary.overdue.length > 0) counts.push(`${summary.overdue.length} overdue`);
    if (summary.inProgress.length > 0) counts.push(`${summary.inProgress.length} in progress`);
    if (summary.dueThisWeek.length > 0) counts.push(`${summary.dueThisWeek.length} due this week`);
    if (nodynTasks.length > 0) counts.push(`${nodynTasks.length} assigned to you`);
    parts.push(counts.join(', ') + '.');

    for (const t of summary.overdue) {
      const scope = t.scope_type === 'context' ? '' : ` (${t.scope_type}:${t.scope_id})`;
      const assignee = t.assignee ? ` [${t.assignee}]` : '';
      parts.push(`Overdue: "${t.title}"${scope}, due ${t.due_date}, ${t.priority.toUpperCase()}${assignee}`);
    }

    // Highlight tasks assigned to nodyn that aren't already shown as overdue
    const overdueIds = new Set(summary.overdue.map(t => t.id));
    const pendingNodyn = nodynTasks.filter(t => !overdueIds.has(t.id));
    if (pendingNodyn.length > 0) {
      parts.push('Your tasks (assigned to nodyn) — propose working on these:');
      for (const t of pendingNodyn) {
        const due = t.due_date ? `, due ${t.due_date}` : '';
        parts.push(`  - "${t.title}" [${t.status}]${due}`);
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

  /** Create a scheduled recurring task. Sets task_type='scheduled', assignee='nodyn', computes next_run_at. */
  createScheduled(params: TaskCreateParams & {
    scheduleCron: string;
    maxRetries?: number | undefined;
    notificationChannel?: string | undefined;
  }): TaskRecord {
    if (!isValidCron(params.scheduleCron)) {
      throw new Error(`Invalid cron expression: ${params.scheduleCron}`);
    }

    const nextRun = nextOccurrence(params.scheduleCron);

    return this.create({
      ...params,
      assignee: 'nodyn',
      taskType: 'scheduled',
      scheduleCron: params.scheduleCron,
      nextRunAt: nextRun.toISOString(),
      maxRetries: params.maxRetries,
      notificationChannel: params.notificationChannel,
    });
  }

  /** Create a watch/monitor task. Sets task_type='watch', assignee='nodyn', computes next_run_at from interval. */
  createWatch(params: TaskCreateParams & {
    watchUrl: string;
    watchIntervalMinutes?: number | undefined;
    watchSelector?: string | undefined;
    notificationChannel?: string | undefined;
  }): TaskRecord {
    const intervalMinutes = params.watchIntervalMinutes ?? 60;

    const watchConfig = JSON.stringify({
      url: params.watchUrl,
      interval_minutes: intervalMinutes,
      selector: params.watchSelector ?? null,
    });

    return this.create({
      ...params,
      assignee: 'nodyn',
      taskType: 'watch',
      watchConfig,
      nextRunAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
      notificationChannel: params.notificationChannel,
    });
  }

  /** Get tasks due for execution (next_run_at <= now, not completed). */
  getDueTasks(): TaskRecord[] {
    return this.history.getDueTasks();
  }

  /** Record the result of a worker task execution. Updates last_run_at, result, status, and optionally next_run_at for recurring tasks. */
  recordTaskRun(id: string, result: string, status: 'success' | 'failed' | 'timeout'): void {
    const task = this.history.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = new Date();
    const truncatedResult = result.length > MAX_RUN_RESULT_CHARS
      ? result.slice(0, MAX_RUN_RESULT_CHARS)
      : result;

    // Determine next_run_at based on task type
    let nextRunAt: string | undefined;

    if (task.schedule_cron) {
      // Recurring cron task — always compute next run
      nextRunAt = nextOccurrence(task.schedule_cron, now).toISOString();
    } else if (task.watch_config) {
      // Watch task — compute next run from interval
      const config = JSON.parse(task.watch_config) as { interval_minutes: number };
      nextRunAt = new Date(now.getTime() + config.interval_minutes * 60_000).toISOString();
    } else if (status === 'success') {
      // One-shot background task — mark as completed on success
      this.history.updateTask(id, { status: 'completed', completedAt: now.toISOString() });
    }

    this.history.updateTaskRunResult(id, {
      lastRunAt: now.toISOString(),
      lastRunResult: truncatedResult,
      lastRunStatus: status,
      nextRunAt,
    });
  }
}

const MAX_RUN_RESULT_CHARS = 10_000;
