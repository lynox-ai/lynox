/**
 * Task and business CLI commands: /task, /business
 */

import type { Nodyn } from '../../core/orchestrator.js';
import { renderTable, BOLD, DIM, BLUE, GREEN, RED, MAGENTA, RESET } from '../ui.js';
import type { CLICtx } from './types.js';

export async function handleTask(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const line = parts.join(' ');
  const history = nodyn.getRunHistory();
  if (!history) { ctx.stdout.write('Run history not available.\n'); return true; }
  const { TaskManager } = await import('../../core/task-manager.js');
  const tm = new TaskManager(history);
  const sub = parts[1];

  if (!sub) {
    // Default: week summary
    const scopes = nodyn.getActiveScopes();
    const summary = tm.getWeekSummary(scopes.length > 0 ? scopes : undefined);
    const { overdue, dueToday, dueThisWeek, inProgress } = summary;

    if (overdue.length + dueToday.length + dueThisWeek.length + inProgress.length === 0) {
      ctx.stdout.write(`${DIM}No active tasks.${RESET}\n`);
      return true;
    }

    const priorityIcon = (p: string) => p === 'urgent' ? '!!' : p === 'high' ? '!' : p === 'medium' ? '>' : '-';
    const fmtTask = (t: { id: string; title: string; priority: string; assignee: string | null; scope_type: string; scope_id: string; due_date: string | null }) => {
      const scope = t.scope_type !== 'project' || t.scope_id ? ` (${t.scope_type}:${t.scope_id})` : '';
      const due = t.due_date ? ` — due ${t.due_date}` : '';
      const assign = t.assignee ? ` @${t.assignee}` : '';
      return `  ${priorityIcon(t.priority)} ${DIM}[${t.priority.toUpperCase()}]${RESET} ${t.id.slice(0, 5)} ${t.title}${assign}${scope}${due}`;
    };

    if (overdue.length > 0) {
      ctx.stdout.write(`${RED}${BOLD}OVERDUE (${overdue.length}):${RESET}\n`);
      for (const t of overdue) ctx.stdout.write(fmtTask(t) + '\n');
    }
    if (dueToday.length > 0) {
      ctx.stdout.write(`${MAGENTA}${BOLD}DUE TODAY (${dueToday.length}):${RESET}\n`);
      for (const t of dueToday) ctx.stdout.write(fmtTask(t) + '\n');
    }
    if (dueThisWeek.length > 0) {
      ctx.stdout.write(`${BLUE}${BOLD}THIS WEEK (${dueThisWeek.length}):${RESET}\n`);
      for (const t of dueThisWeek) ctx.stdout.write(fmtTask(t) + '\n');
    }
    if (inProgress.length > 0) {
      ctx.stdout.write(`${GREEN}${BOLD}IN PROGRESS (${inProgress.length}):${RESET}\n`);
      for (const t of inProgress) ctx.stdout.write(fmtTask(t) + '\n');
    }
    return true;
  }

  if (sub === 'list') {
    const statusFlag = parts.indexOf('--status');
    const scopeFlag = parts.indexOf('--scope');
    const assigneeFlag = parts.indexOf('--assignee');
    const status = statusFlag !== -1 ? parts[statusFlag + 1] : undefined;
    const scopeStr = scopeFlag !== -1 ? parts[scopeFlag + 1] : undefined;
    const assignee = assigneeFlag !== -1 ? parts[assigneeFlag + 1] : undefined;
    let scope: import('../../types/index.js').MemoryScopeRef | undefined;
    if (scopeStr) {
      const { parseScopeString } = await import('../../core/scope-resolver.js');
      scope = parseScopeString(scopeStr);
      if (!scope) { ctx.stdout.write(`Invalid scope: ${scopeStr}\n`); return true; }
    }
    const tasks = tm.list({
      status: status as 'open' | 'in_progress' | 'completed' | undefined,
      assignee,
      scope,
    });
    if (tasks.length === 0) { ctx.stdout.write(`${DIM}No tasks found.${RESET}\n`); return true; }
    const rows = tasks.map(t => [
      t.id.slice(0, 8), t.priority.toUpperCase(), t.status,
      t.title.slice(0, 40),
      t.assignee ?? '',
      t.scope_type !== 'project' || t.scope_id ? `${t.scope_type}:${t.scope_id.slice(0, 8)}` : '',
      t.due_date ?? '',
    ]);
    ctx.stdout.write(renderTable(['ID', 'Priority', 'Status', 'Title', 'Assignee', 'Scope', 'Due'], rows) + '\n');
    return true;
  }

  if (sub === 'add') {
    // Parse: /task add "Title" [--due DATE] [--priority PRIO] [--scope SCOPE] [--assignee NAME]
    const titleMatch = line.match(/add\s+"([^"]+)"|add\s+(\S+)/);
    const title = titleMatch?.[1] ?? titleMatch?.[2];
    if (!title) { ctx.stdout.write('Usage: /task add "Title" [--due YYYY-MM-DD] [--priority high] [--scope client:x] [--assignee user|nodyn|name]\n'); return true; }

    const dueFlag = parts.indexOf('--due');
    const prioFlag = parts.indexOf('--priority');
    const scopeFlag = parts.indexOf('--scope');
    const assigneeFlag = parts.indexOf('--assignee');
    const dueDate = dueFlag !== -1 ? parts[dueFlag + 1] : undefined;
    const priority = prioFlag !== -1 ? parts[prioFlag + 1] : undefined;
    const scopeStr = scopeFlag !== -1 ? parts[scopeFlag + 1] : undefined;
    const assigneeName = assigneeFlag !== -1 ? parts[assigneeFlag + 1] : undefined;

    let scopeType = 'project';
    let scopeId = '';
    if (scopeStr) {
      const { parseScopeString } = await import('../../core/scope-resolver.js');
      const parsed = parseScopeString(scopeStr);
      if (!parsed) { ctx.stdout.write(`Invalid scope: ${scopeStr}\n`); return true; }
      scopeType = parsed.type;
      scopeId = parsed.id;
    } else {
      const projectScope = nodyn.getActiveScopes().find(s => s.type === 'context');
      if (projectScope) scopeId = projectScope.id;
    }

    try {
      const task = tm.create({
        title,
        priority: priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        assignee: assigneeName,
        dueDate,
        scopeType,
        scopeId,
      });
      const assignLabel = task.assignee ? ` @${task.assignee}` : '';
      ctx.stdout.write(`${GREEN}Task created: ${task.id} — ${task.title}${assignLabel}${RESET}\n`);
    } catch (e) {
      ctx.stdout.write(`${RED}Error: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
    }
    return true;
  }

  if (sub === 'done') {
    const id = parts[2];
    if (!id) { ctx.stdout.write('Usage: /task done <id>\n'); return true; }
    const task = tm.complete(id);
    if (!task) { ctx.stdout.write(`${RED}Task not found: ${id}${RESET}\n`); return true; }
    ctx.stdout.write(`${GREEN}Task completed: ${task.id} — ${task.title}${RESET}\n`);
    return true;
  }

  if (sub === 'start') {
    const id = parts[2];
    if (!id) { ctx.stdout.write('Usage: /task start <id>\n'); return true; }
    const task = tm.update(id, { status: 'in_progress' });
    if (!task) { ctx.stdout.write(`${RED}Task not found: ${id}${RESET}\n`); return true; }
    ctx.stdout.write(`${GREEN}Task started: ${task.id} — ${task.title}${RESET}\n`);
    return true;
  }

  if (sub === 'show') {
    const id = parts[2];
    if (!id) { ctx.stdout.write('Usage: /task show <id>\n'); return true; }
    const task = history.getTask(id);
    if (!task) { ctx.stdout.write(`${RED}Task not found: ${id}${RESET}\n`); return true; }

    ctx.stdout.write(`${BOLD}${task.title}${RESET}\n`);
    ctx.stdout.write(`  ID:       ${task.id}\n`);
    ctx.stdout.write(`  Status:   ${task.status}\n`);
    ctx.stdout.write(`  Priority: ${task.priority}\n`);
    ctx.stdout.write(`  Assignee: ${task.assignee ?? 'unassigned'}\n`);
    ctx.stdout.write(`  Scope:    ${task.scope_type}:${task.scope_id}\n`);
    if (task.due_date) ctx.stdout.write(`  Due:      ${task.due_date}\n`);
    if (task.description) ctx.stdout.write(`  Desc:     ${task.description}\n`);
    if (task.tags) {
      try { ctx.stdout.write(`  Tags:     ${(JSON.parse(task.tags) as string[]).join(', ')}\n`); } catch { /* ignore */ }
    }
    ctx.stdout.write(`  Created:  ${task.created_at}\n`);
    if (task.completed_at) ctx.stdout.write(`  Done:     ${task.completed_at}\n`);

    // Show subtasks
    const subtasks = history.getTasks({ parentTaskId: task.id });
    if (subtasks.length > 0) {
      ctx.stdout.write(`\n  ${BOLD}Subtasks (${subtasks.length}):${RESET}\n`);
      for (const st of subtasks) {
        const check = st.status === 'completed' ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`;
        ctx.stdout.write(`    ${check} ${st.id.slice(0, 5)} ${st.title}\n`);
      }
    }
    return true;
  }

  if (sub === 'edit') {
    const id = parts[2];
    if (!id) { ctx.stdout.write('Usage: /task edit <id> --title "..." --due ... --priority ... --assignee ...\n'); return true; }

    const titleFlag = parts.indexOf('--title');
    const dueFlag = parts.indexOf('--due');
    const prioFlag = parts.indexOf('--priority');
    const assigneeFlag = parts.indexOf('--assignee');

    let newTitle: string | undefined;
    if (titleFlag !== -1) {
      const titleMatch = line.match(/--title\s+"([^"]+)"|--title\s+(\S+)/);
      newTitle = titleMatch?.[1] ?? titleMatch?.[2];
    }

    const task = tm.update(id, {
      title: newTitle,
      dueDate: dueFlag !== -1 ? parts[dueFlag + 1] : undefined,
      priority: prioFlag !== -1 ? parts[prioFlag + 1] as 'low' | 'medium' | 'high' | 'urgent' : undefined,
      assignee: assigneeFlag !== -1 ? parts[assigneeFlag + 1] : undefined,
    });
    if (!task) { ctx.stdout.write(`${RED}Task not found: ${id}${RESET}\n`); return true; }
    ctx.stdout.write(`${GREEN}Task updated: ${task.id} — ${task.title}${RESET}\n`);
    return true;
  }

  if (sub === 'delete') {
    const id = parts[2];
    if (!id) { ctx.stdout.write('Usage: /task delete <id>\n'); return true; }
    const task = history.getTask(id);
    if (!task) { ctx.stdout.write(`${RED}Task not found: ${id}${RESET}\n`); return true; }
    const deleted = history.deleteTask(task.id);
    ctx.stdout.write(deleted ? `${GREEN}Task deleted: ${task.id} — ${task.title}${RESET}\n` : `${RED}Failed to delete task.${RESET}\n`);
    return true;
  }

  ctx.stdout.write(`Unknown subcommand: ${sub}\nUsage: /task [list|add|done|start|show|edit|delete]\n`);
  return true;
}

export async function handleBusiness(parts: string[], _nodyn: Nodyn, _ctx: CLICtx): Promise<boolean> {
  const { showProfile, runBusinessOnboarding, clearProfile } = await import('../onboarding.js');
  const sub = parts[1];
  if (sub === 'update') {
    await runBusinessOnboarding();
  } else if (sub === 'clear') {
    await clearProfile();
  } else {
    await showProfile();
  }
  return true;
}
