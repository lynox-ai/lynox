import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from '../../core/run-history.js';
import { TaskManager } from '../../core/task-manager.js';
import { taskCreateTool, taskUpdateTool, taskListTool } from './task.js';
import type { IAgent, MemoryScopeRef } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

let sharedTaskManager: TaskManager | null = null;

function makeAgent(scopes?: MemoryScopeRef[]): IAgent {
  const ctx = createToolContext({});
  ctx.taskManager = sharedTaskManager;
  return {
    name: 'test',
    model: 'claude-haiku-4-5-20251001',
    memory: null,
    tools: [],
    onStream: null,
    activeScopes: scopes,
    toolContext: ctx,
  };
}

describe('Task Tools', () => {
  let dir: string;
  let history: RunHistory;
  let tm: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-tool-test-'));
    history = new RunHistory(join(dir, 'test.db'));
    tm = new TaskManager(history);
    sharedTaskManager = tm;
  });

  afterEach(() => {
    sharedTaskManager = null;
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('task_create', () => {
    it('should create a task', async () => {
      const result = await taskCreateTool.handler({ title: 'New task' }, makeAgent());
      expect(result).toContain('Task created');
      expect(result).toContain('New task');
    });

    it('should create a task with scope', async () => {
      const agent = makeAgent([{ type: 'context', id: 'acme' }]);
      const result = await taskCreateTool.handler(
        { title: 'Client work', scope: 'context:acme', priority: 'high' },
        agent,
      );
      expect(result).toContain('Task created');
      expect(result).toContain('HIGH');
    });

    it('should create a task with assignee', async () => {
      const result = await taskCreateTool.handler(
        { title: 'Agent task', assignee: 'lynox' },
        makeAgent(),
      );
      expect(result).toContain('Task created');
      expect(result).toContain('@lynox');
    });

    it('should reject unauthorized scope', async () => {
      const agent = makeAgent([{ type: 'context', id: 'p1' }]);
      const result = await taskCreateTool.handler(
        { title: 'Bad', scope: 'context:other' },
        agent,
      );
      expect(result).toContain('Unauthorized scope');
    });

    it('should return error when manager not set', async () => {
      sharedTaskManager = null;
      const result = await taskCreateTool.handler({ title: 'No mgr' }, makeAgent());
      expect(result).toContain('Error');
    });

    // Regression: reproduces the real failure from 2026-04-24 where an agent
    // emitted an escaped close-quote mid-string, causing schedule/priority/
    // assignee to land inside `description` as literal text. The task was
    // created as a regular (unscheduled) task and never ran.
    it('should reject description with embedded JSON param fragments', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Weekly Google Autocomplete Crawler — DACH Keywords',
          description:
            'Fetch Google Autocomplete suggestions across DE/AT/CH geos. Next actions: 1) Review top-rank shifts week-over-week, 2) Mine long-tail cluster combinations, 3) Feed into content strategy.","schedule":"0 2 * * 4","priority":"medium","assignee":"lynox"',
        },
        makeAgent(),
      );
      expect(result).toMatch(/Error/);
      expect(result).toMatch(/description/i);
      expect(result).toMatch(/schedule|priority|assignee/i);
      expect(result).not.toContain('Task created');
      expect(result).not.toContain('Scheduled task');
    });

    it('should not flag legitimate quoted prose in description', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Follow up',
          description: 'Customer said, "This needs more work", so check in next week.',
        },
        makeAgent(),
      );
      expect(result).toContain('Task created');
    });

    it('should not flag unrelated JSON-like snippets in description', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Config review',
          description: 'Verify settings "foo":"bar" and "baz":"qux" are applied.',
        },
        makeAgent(),
      );
      expect(result).toContain('Task created');
    });

    it('should still create real scheduled tasks via schedule parameter', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Real scheduled task',
          description: 'Runs every Thursday at 02:00 UTC.',
          schedule: '0 2 * * 4',
        },
        makeAgent(),
      );
      expect(result).toContain('Scheduled task created');
      expect(result).toContain('next run:');
    });

    // Review nit (PR #151): smuggling can land in `title` too, not just description.
    it('should reject title with embedded JSON param fragments', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Daily standup","schedule":"0 9 * * 1-5","priority":"high',
          description: 'normal description',
        },
        makeAgent(),
      );
      expect(result).toMatch(/Error/);
      expect(result).toMatch(/title/i);
      expect(result).toMatch(/schedule|priority/i);
      expect(result).not.toContain('Task created');
    });

    // Review nit: `tags` smuggles as `","tags":[...]` (array, not string value).
    it('should reject description with embedded tags array smuggle', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Notes',
          description: 'Some content here.","tags":["urgent","internal"',
        },
        makeAgent(),
      );
      expect(result).toMatch(/Error/);
      expect(result).toMatch(/tags/i);
      expect(result).not.toContain('Task created');
    });

    // Review nit: whitespace variants (`", "schedule" : "`) — regex uses `\s*`
    // so this should match. Lock it down so a future tightening doesn't regress.
    it('should reject description with whitespace-padded JSON param fragments', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Spaced',
          description: 'Some content here." , "schedule" : "0 0 * * 0',
        },
        makeAgent(),
      );
      expect(result).toMatch(/Error/);
      expect(result).toMatch(/schedule/i);
      expect(result).not.toContain('Task created');
    });

    // Review concern: array-with-bracket value-side could over-match. Verify
    // legitimate prose containing brackets stays clean.
    it('should not flag legitimate prose containing colon and brackets', async () => {
      const result = await taskCreateTool.handler(
        {
          title: 'Doc draft',
          description: 'Reference: see [appendix A] and [section 3.2] for details.',
        },
        makeAgent(),
      );
      expect(result).toContain('Task created');
    });

    it('should schedule a one-shot future task via run_at', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
      const result = await taskCreateTool.handler(
        { title: 'Tomorrow morning', assignee: 'lynox', run_at: future },
        makeAgent(),
      );
      expect(result).toContain('Task scheduled for');
      expect(result).toContain(future);
      // Ensure the task did NOT auto-fire — nextRunAt should equal what we passed,
      // not the creation timestamp.
      const created = tm.list().find((t) => t.title === 'Tomorrow morning');
      expect(created?.next_run_at).toBe(future);
    });

    it('should reject invalid run_at', async () => {
      const result = await taskCreateTool.handler(
        { title: 'Bad time', assignee: 'lynox', run_at: 'not-a-date' },
        makeAgent(),
      );
      expect(result).toContain('Error');
      expect(result).toContain('invalid run_at');
    });

    it('should still auto-fire lynox-assignee tasks with no schedule', async () => {
      const before = Date.now();
      await taskCreateTool.handler(
        { title: 'Do it now', assignee: 'lynox' },
        makeAgent(),
      );
      const created = tm.list().find((t) => t.title === 'Do it now');
      expect(created?.next_run_at).toBeTruthy();
      // Should be roughly "now" (within 5 seconds of when we called it)
      const ts = new Date(created!.next_run_at!).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now() + 5000);
    });

    it('should create a recurring scheduled task via schedule', async () => {
      const result = await taskCreateTool.handler(
        { title: 'Daily check', assignee: 'lynox', schedule: '0 9 * * *' },
        makeAgent(),
      );
      expect(result).toContain('Scheduled task created');
      const created = tm.list().find((t) => t.title === 'Daily check');
      expect(created?.schedule_cron).toBe('0 9 * * *');
      expect(created?.next_run_at).toBeTruthy();
    });
  });

  describe('task_update', () => {
    it('should update status', async () => {
      const task = tm.create({ title: 'To update' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, status: 'in_progress' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      expect(result).toContain('in_progress');
    });

    it('should complete via status', async () => {
      const task = tm.create({ title: 'To complete' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, status: 'completed' },
        makeAgent(),
      );
      expect(result).toContain('Task completed');
    });

    it('should update assignee', async () => {
      const task = tm.create({ title: 'Reassign' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, assignee: 'lynox' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      expect(result).toContain('@lynox');
    });

    it('should handle missing task', async () => {
      const result = await taskUpdateTool.handler(
        { task_id: 'missing', status: 'open' },
        makeAgent(),
      );
      expect(result).toContain('not found');
    });

    // 2026-05-05 incident: agent typed "in 5 min", server time was hour-stale,
    // tried task_update to fix the schedule, found no run_at field on the
    // tool, fell back to delete-and-recreate (and forgot to delete) → two
    // tasks. These tests pin the rescheduling contract.
    it('reschedules a one-shot task via run_at', async () => {
      const task = tm.create({ title: 'Reminder', assignee: 'lynox', run_at: '2026-05-06T09:00:00Z' });
      // TaskManager normalises every input via `new Date(...).toISOString()`
      // so SQLite's lexicographic `next_run_at <= now` comparison stays
      // monotonic even if the agent submits two slightly different ISO
      // shapes (e.g. with vs. without milliseconds). Tests assert against
      // the normalised form.
      const result = await taskUpdateTool.handler(
        { task_id: task.id, run_at: '2026-05-06T14:30:00Z' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      expect(result).toContain('2026-05-06T14:30:00.000Z');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.next_run_at).toBe('2026-05-06T14:30:00.000Z');
    });

    it('reschedules a recurring task via schedule (recomputes next_run_at)', async () => {
      const task = tm.createScheduled({ title: 'Daily', scheduleCron: '0 9 * * *' });
      const before = task.next_run_at;
      const result = await taskUpdateTool.handler(
        { task_id: task.id, schedule: '0 14 * * *' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.schedule_cron).toBe('0 14 * * *');
      expect(updated?.next_run_at).toBeTruthy();
      // The next-run timestamp must change — otherwise the worker keeps
      // firing at the old time despite the schedule edit.
      expect(updated?.next_run_at).not.toBe(before);
    });

    it('clears run_at when an empty string is passed (un-schedule, keep open)', async () => {
      const task = tm.create({ title: 'Cancel reminder', assignee: 'lynox', run_at: '2026-05-06T09:00:00Z' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, run_at: '' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.next_run_at).toBeFalsy();
      expect(updated?.status).toBe('open');
    });

    it('rejects an invalid run_at with a clear error', async () => {
      const task = tm.create({ title: 'Bad reschedule' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, run_at: 'not-a-date' },
        makeAgent(),
      );
      expect(result).toContain('Error');
      expect(result).toContain('Invalid run_at');
    });

    it('rejects passing both run_at and schedule simultaneously', async () => {
      const task = tm.create({ title: 'Conflict' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, run_at: '2026-05-06T09:00:00Z', schedule: '0 9 * * *' },
        makeAgent(),
      );
      expect(result).toContain('Error');
      expect(result).toMatch(/mutually exclusive|only one/i);
    });

    it('switching schedule -> run_at clears the cron (and vice versa)', async () => {
      // Without this clear, a task with both fields set would re-fire on
      // the old recurring cadence even after the agent thinks it moved
      // it to a one-shot run. Pin the implicit-clear contract.
      const task = tm.createScheduled({ title: 'Was recurring', scheduleCron: '0 9 * * *' });
      await taskUpdateTool.handler(
        { task_id: task.id, run_at: '2026-05-06T14:30:00Z' },
        makeAgent(),
      );
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.next_run_at).toBe('2026-05-06T14:30:00.000Z');
      expect(updated?.schedule_cron).toBeFalsy();
    });

    it('switching run_at -> schedule recomputes next_run_at (inverse direction)', async () => {
      // Symmetric to the cron-clear test above: a one-shot moved onto a
      // recurring cadence must drop its old run_at and pick up the next
      // fire computed from the new cron.
      const task = tm.create({ title: 'Was one-shot', assignee: 'lynox', run_at: '2026-05-06T09:00:00Z' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, schedule: '0 14 * * *' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.schedule_cron).toBe('0 14 * * *');
      // The new next_run_at must NOT be the original one-shot value —
      // worker would otherwise fire at the stale time before the cron
      // schedule kicks in.
      expect(updated?.next_run_at).toBeTruthy();
      expect(updated?.next_run_at).not.toBe('2026-05-06T09:00:00.000Z');
    });

    it('rejects an invalid cron schedule with a clear error (symmetric to invalid run_at)', async () => {
      const task = tm.create({ title: 'Bad cron' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, schedule: 'not-a-cron' },
        makeAgent(),
      );
      expect(result).toContain('Error');
      expect(result).toContain('Invalid schedule');
    });

    it('clears schedule when an empty string is passed (un-schedule, also clears next_run_at)', async () => {
      // Pre-PR semantic gap: clearing scheduleCron alone left the stale
      // next_run_at, so the worker would fire the recurring task one
      // last time and only THEN fall into the completion branch. Now
      // both fields move together.
      const task = tm.createScheduled({ title: 'Stop firing', scheduleCron: '0 9 * * *' });
      expect(task.next_run_at).toBeTruthy();
      const result = await taskUpdateTool.handler(
        { task_id: task.id, schedule: '' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.schedule_cron).toBeFalsy();
      expect(updated?.next_run_at).toBeFalsy();
    });

    it('completion short-circuits before any reschedule fields are applied', async () => {
      // Pin the precedence in case an agent sends both at once. The
      // tool routes status='completed' through TaskManager.complete()
      // which IGNORES run_at/schedule. If a future caller wanted to
      // reschedule a completed task they have to reopen it first.
      // (Note: TaskManager.create() takes `nextRunAt`, not `run_at` —
      // `run_at` is the tool-layer field name. Hence the camelCase here.)
      const task = tm.create({ title: 'Done plus reschedule', assignee: 'lynox', nextRunAt: '2026-05-06T09:00:00.000Z' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, status: 'completed', run_at: '2026-05-06T14:30:00Z' },
        makeAgent(),
      );
      expect(result).toContain('Task completed');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.status).toBe('completed');
      // Completion runs through `complete()`, not `update()`, so run_at
      // stays at its original value (not the requested 14:30).
      expect(updated?.next_run_at).toBe('2026-05-06T09:00:00.000Z');
    });

    // Pre-PR: clearing run_at alone disabled the task silently when it
    // had a recurring cron — worker stopped firing because next_run_at
    // was null but cron was still in the row. The clear-both semantic
    // means run_at: '' fully un-schedules.
    it('clears run_at + schedule together when run_at is set to empty string', async () => {
      const task = tm.createScheduled({ title: 'Stop me too', scheduleCron: '0 9 * * *' });
      const result = await taskUpdateTool.handler(
        { task_id: task.id, run_at: '' },
        makeAgent(),
      );
      expect(result).toContain('Task updated');
      const updated = tm.list().find((t) => t.id === task.id);
      expect(updated?.next_run_at).toBeFalsy();
      expect(updated?.schedule_cron).toBeFalsy();
    });
  });

  describe('task_list', () => {
    it('should list tasks', async () => {
      tm.create({ title: 'Task A' });
      tm.create({ title: 'Task B' });
      const result = await taskListTool.handler({}, makeAgent());
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
    });

    it('should filter by status', async () => {
      tm.create({ title: 'Open task' });
      const done = tm.create({ title: 'Done task' });
      tm.complete(done.id);
      const result = await taskListTool.handler({ status: 'open' }, makeAgent());
      expect(result).toContain('Open task');
      expect(result).not.toContain('Done task');
    });

    it('should return no tasks message', async () => {
      const result = await taskListTool.handler({ status: 'completed' }, makeAgent());
      expect(result).toContain('No tasks found');
    });

    it('should filter by assignee', async () => {
      tm.create({ title: 'User task', assignee: 'user' });
      tm.create({ title: 'Agent task', assignee: 'lynox' });
      const result = await taskListTool.handler({ assignee: 'lynox' }, makeAgent());
      expect(result).toContain('Agent task');
      expect(result).not.toContain('User task');
    });

    it('should filter overdue', async () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      tm.create({ title: 'Overdue', dueDate: yesterday });
      tm.create({ title: 'No due date' });
      const result = await taskListTool.handler({ due: 'overdue' }, makeAgent());
      expect(result).toContain('Overdue');
    });
  });
});
