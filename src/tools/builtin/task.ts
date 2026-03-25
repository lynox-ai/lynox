import type { ToolEntry, IAgent, TaskPriority, MemoryScopeRef } from '../../types/index.js';
import { parseScopeString } from '../../core/scope-resolver.js';
import { logErrorChain } from '../../core/utils.js';

// TaskManager accessed via agent.toolContext.taskManager

interface TaskCreateInput {
  title: string;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  assignee?: string | undefined;
  due_date?: string | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
  parent_task_id?: string | undefined;
  schedule?: string | undefined;
  watch_url?: string | undefined;
  watch_interval_minutes?: number | undefined;
  pipeline_id?: string | undefined;
}

interface TaskUpdateInput {
  task_id: string;
  status?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  due_date?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
}

interface TaskListInput {
  scope?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  due?: 'today' | 'week' | 'overdue' | undefined;
  limit?: number | undefined;
}

function formatTaskLine(t: { id: string; title: string; priority: string; status: string; assignee: string | null; scope_type: string; scope_id: string; due_date: string | null }): string {
  const scope = t.scope_type === 'context' && !t.scope_id ? '' : ` (${t.scope_type}:${t.scope_id})`;
  const due = t.due_date ? ` — due ${t.due_date}` : '';
  const assign = t.assignee ? ` @${t.assignee}` : '';
  return `[${t.priority.toUpperCase()}] ${t.id} ${t.title}${assign}${scope}${due} [${t.status}]`;
}

export const taskCreateTool: ToolEntry<TaskCreateInput> = {
  definition: {
    name: 'task_create',
    description: 'Create a task with title, priority, due date, assignee, and scope.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority level. Default: medium' },
        assignee: { type: 'string', description: 'Who is responsible: "user" (the human), "nodyn" (the agent), or a custom name. Default: unassigned.' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        scope: { type: 'string', description: 'Scope as "type:id" (e.g., "client:acme"). Default: current project scope.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        parent_task_id: { type: 'string', description: 'Parent task ID for subtasks' },
        schedule: { type: 'string', description: 'Cron schedule for recurring tasks. Standard cron (e.g. \'0 8 * * *\' for daily at 8am) or shorthand (\'30m\', \'1h\', \'6h\', \'1d\').' },
        watch_url: { type: 'string', description: 'URL to monitor for changes. Creates a watch task that checks periodically.' },
        watch_interval_minutes: { type: 'number', description: 'How often to check the watched URL (in minutes). Default: 60.' },
        pipeline_id: { type: 'string', description: 'ID of a stored workflow/pipeline to execute on this schedule.' },
      },
      required: ['title'],
    },
  },
  handler: async (input: TaskCreateInput, agent: IAgent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    let scopeType = 'context';
    let scopeId = '';
    if (input.scope) {
      const parsed = parseScopeString(input.scope);
      if (!parsed) return `Invalid scope: "${input.scope}". Format: "type:name" (e.g., "client:acme", "project:website").`;
      if (agent.activeScopes) {
        const valid = agent.activeScopes.some(s => s.type === parsed.type && s.id === parsed.id);
        if (!valid) return `Unauthorized scope: "${input.scope}".`;
      }
      scopeType = parsed.type;
      scopeId = parsed.id;
    } else if (agent.activeScopes) {
      const projectScope = agent.activeScopes.find(s => s.type === 'context');
      if (projectScope) scopeId = projectScope.id;
    }

    try {
      const baseParams = {
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignee: input.assignee,
        scopeType,
        scopeId,
        dueDate: input.due_date,
        tags: input.tags,
        parentTaskId: input.parent_task_id,
      };

      if (input.pipeline_id) {
        const task = managerRef.createPipelineTask({
          ...baseParams,
          pipelineId: input.pipeline_id,
          scheduleCron: input.schedule,
        });
        const nextRun = task.next_run_at ? ` — next run: ${task.next_run_at}` : '';
        const scheduleInfo = input.schedule ? ` (schedule: ${input.schedule})` : '';
        return `Pipeline task created: ${formatTaskLine(task)}${nextRun}${scheduleInfo}`;
      }

      if (input.schedule) {
        const task = managerRef.createScheduled({
          ...baseParams,
          scheduleCron: input.schedule,
        });
        const nextRun = task.next_run_at ? ` — next run: ${task.next_run_at}` : '';
        return `Scheduled task created: ${formatTaskLine(task)}${nextRun}`;
      }

      if (input.watch_url) {
        const intervalMinutes = input.watch_interval_minutes ?? 60;
        const task = managerRef.createWatch({
          ...baseParams,
          watchUrl: input.watch_url,
          watchIntervalMinutes: intervalMinutes,
        });
        return `Watch task created: ${formatTaskLine(task)} — watching ${input.watch_url} every ${String(intervalMinutes)}min`;
      }

      const task = managerRef.create(baseParams);
      return `Task created: ${formatTaskLine(task)}`;
    } catch (e: unknown) {
      logErrorChain('task_create', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const taskUpdateTool: ToolEntry<TaskUpdateInput> = {
  definition: {
    name: 'task_update',
    description: 'Update task status, priority, assignee, due date, or other fields.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID (or prefix)' },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed'], description: 'New status' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'New priority' },
        assignee: { type: 'string', description: 'New assignee: "user", "nodyn", custom name, or empty string to clear' },
        due_date: { type: 'string', description: 'New due date (YYYY-MM-DD), or empty string to clear' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing)' },
      },
      required: ['task_id'],
    },
  },
  handler: async (input: TaskUpdateInput, agent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    try {
      if (input.status === 'completed') {
        const task = managerRef.complete(input.task_id);
        if (!task) return `Task not found: ${input.task_id}`;
        return `Task completed: ${formatTaskLine(task)}`;
      }

      const task = managerRef.update(input.task_id, {
        title: input.title,
        description: input.description,
        status: input.status as 'open' | 'in_progress' | 'completed' | undefined,
        priority: input.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        assignee: input.assignee,
        dueDate: input.due_date,
        tags: input.tags,
      });
      if (!task) return `Task not found: ${input.task_id}`;
      return `Task updated: ${formatTaskLine(task)}`;
    } catch (e: unknown) {
      logErrorChain('task_update', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const taskListTool: ToolEntry<TaskListInput> = {
  definition: {
    name: 'task_list',
    description: 'List tasks filtered by scope, status, assignee, or due date.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'Filter by scope ("client:acme"). Omit for all active scopes.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed'], description: 'Filter by status' },
        assignee: { type: 'string', description: 'Filter by assignee: "user", "nodyn", or custom name' },
        due: { type: 'string', enum: ['today', 'week', 'overdue'], description: 'Filter by due date range' },
        limit: { type: 'number', description: 'Max results. Default: 20' },
      },
      required: [],
    },
  },
  handler: async (input: TaskListInput, agent: IAgent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    if (input.due) {
      const scopes = agent.activeScopes;
      if (input.due === 'overdue') {
        // Use the history directly for overdue
        const overdue = managerRef.getWeekSummary(scopes).overdue;
        if (overdue.length === 0) return 'No overdue tasks.';
        return overdue.map(t => formatTaskLine(t)).join('\n');
      }
      if (input.due === 'today') {
        const summary = managerRef.getWeekSummary(scopes);
        const tasks = [...summary.overdue, ...summary.dueToday];
        if (tasks.length === 0) return 'No tasks due today (and none overdue).';
        return tasks.map(t => formatTaskLine(t)).join('\n');
      }
      if (input.due === 'week') {
        const summary = managerRef.getWeekSummary(scopes);
        const tasks = [...summary.overdue, ...summary.dueToday, ...summary.dueThisWeek];
        if (tasks.length === 0) return 'No tasks due this week.';
        return tasks.map(t => formatTaskLine(t)).join('\n');
      }
    }

    let scope: MemoryScopeRef | undefined;
    if (input.scope) {
      const parsed = parseScopeString(input.scope);
      if (!parsed) return `Invalid scope format: "${input.scope}".`;
      scope = parsed;
    }

    const tasks = managerRef.list({
      status: input.status as 'open' | 'in_progress' | 'completed' | undefined,
      assignee: input.assignee,
      scope,
    });

    const limited = tasks.slice(0, input.limit ?? 20);
    if (limited.length === 0) return 'No tasks found.';

    const lines = limited.map(t => formatTaskLine(t));
    if (tasks.length > limited.length) {
      lines.push(`... and ${tasks.length - limited.length} more`);
    }
    return lines.join('\n');
  },
};
