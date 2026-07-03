import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager, setPipelineModeLookup, deriveSourceEffect } from './task-manager.js';
import type { TriggerRecord } from '../types/index.js';

describe('deriveSourceEffect (create-path → clean axes; migration-remap twin)', () => {
  // MUST agree with the engine.db v3 migration remap so a trigger CREATED post-slice
  // matches the same trigger MIGRATED from a legacy task_type row.
  it('backup → (cron, backup); reminder → (cron, notify) — the deterministic money-boundary', () => {
    expect(deriveSourceEffect({ taskType: 'backup', scheduleCron: '0 3 * * *' })).toEqual({ source: 'cron', effect: 'backup' });
    // even without a schedule string, backup/reminder are cron-scheduled built-ins:
    expect(deriveSourceEffect({ taskType: 'backup' })).toEqual({ source: 'cron', effect: 'backup' });
    expect(deriveSourceEffect({ taskType: 'reminder', nextRunAt: '2026-07-02T09:00:00Z' })).toEqual({ source: 'cron', effect: 'notify' });
  });

  it('a bound workflow → run_workflow; source from the condition', () => {
    expect(deriveSourceEffect({ taskType: 'pipeline', pipelineId: 'wf-1', scheduleCron: '0 9 * * *' })).toEqual({ source: 'cron', effect: 'run_workflow' });
    expect(deriveSourceEffect({ taskType: 'pipeline', pipelineId: 'wf-1', watchConfig: '{"url":"x"}' })).toEqual({ source: 'watch', effect: 'run_workflow' });
    expect(deriveSourceEffect({ taskType: 'pipeline', pipelineId: 'wf-1' })).toEqual({ source: 'manual', effect: 'run_workflow' });
  });

  it('watch → (watch, run_agent); scheduled agent → (cron, run_agent); bare → (manual, run_agent)', () => {
    expect(deriveSourceEffect({ taskType: 'watch', watchConfig: '{"url":"y"}' })).toEqual({ source: 'watch', effect: 'run_agent' });
    expect(deriveSourceEffect({ taskType: 'scheduled', scheduleCron: '0 8 * * *' })).toEqual({ source: 'cron', effect: 'run_agent' });
    expect(deriveSourceEffect({})).toEqual({ source: 'manual', effect: 'run_agent' });
    // an unknown taskType is a plain agent run, source from its firing shape:
    expect(deriveSourceEffect({ taskType: 'zzz' })).toEqual({ source: 'manual', effect: 'run_agent' });
  });
});

describe('TaskManager', () => {
  let dir: string;
  let history: RunHistory;
  let engine: EngineDb;
  let tm: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-task-test-'));
    history = new RunHistory(join(dir, 'test.db'));
    engine = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engine);
    tm = new TaskManager(history);
  });

  afterEach(() => {
    try { engine.close(); } catch { /* already closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a task with defaults', () => {
      const task = tm.create({ title: 'Test task' });
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('open');
      expect(task.priority).toBe('medium');
      expect(task.scope_type).toBe('context');
      expect(task.id).toHaveLength(8);
    });

    it('should create a task with all fields', () => {
      const task = tm.create({
        title: 'Full task',
        description: 'A detailed task',
        priority: 'high',
        assignee: 'user',
        scopeType: 'context',
        scopeId: 'acme',
        dueDate: '2026-04-01',
        tags: ['design', 'urgent'],
      });
      expect(task.title).toBe('Full task');
      expect(task.description).toBe('A detailed task');
      expect(task.priority).toBe('high');
      expect(task.assignee).toBe('user');
      expect(task.scope_type).toBe('context');
      expect(task.scope_id).toBe('acme');
      expect(task.due_date).toBe('2026-04-01');
      expect(JSON.parse(task.tags!)).toEqual(['design', 'urgent']);
    });

    it('should create a task with lynox assignee', () => {
      const task = tm.create({ title: 'Agent work', assignee: 'lynox' });
      expect(task.assignee).toBe('lynox');
    });

    it('should create a task with custom assignee', () => {
      const task = tm.create({ title: 'Delegated', assignee: 'maria' });
      expect(task.assignee).toBe('maria');
    });

    it('should create a task with null assignee by default', () => {
      const task = tm.create({ title: 'Unassigned' });
      expect(task.assignee).toBeNull();
    });

    it('should validate parent task exists', () => {
      expect(() => tm.create({ title: 'Sub', parentTaskId: 'nonexistent' }))
        .toThrow('Parent task not found');
    });

    it('should create subtasks', () => {
      const parent = tm.create({ title: 'Parent' });
      const child = tm.create({ title: 'Child', parentTaskId: parent.id });
      expect(child.parent_task_id).toBe(parent.id);
    });

    it('should reject invalid priority', () => {
      expect(() => tm.create({ title: 'Bad', priority: 'extreme' as never }))
        .toThrow('Invalid priority');
    });

    it('should reject invalid date format', () => {
      expect(() => tm.create({ title: 'Bad', dueDate: '01-03-2026' }))
        .toThrow('Invalid due_date format');
    });
  });

  describe('createWatch — interval floor', () => {
    it('floors a sub-minute interval to 1 minute (tick granularity)', () => {
      const task = tm.createWatch({
        title: 'Hammer watch',
        watchUrl: 'https://example.com',
        watchIntervalMinutes: 0.1, // ~6s — a direct caller bypassing the tool's 5min floor
      });
      const cfg = JSON.parse(task.watch_config!) as { interval_minutes: number };
      expect(cfg.interval_minutes).toBe(1);
      // next_run_at must be at least a full minute out, never sub-tick.
      const delta = new Date(task.next_run_at!).getTime() - Date.now();
      expect(delta).toBeGreaterThanOrEqual(59_000);
    });

    it('leaves a normal interval unchanged', () => {
      const task = tm.createWatch({
        title: 'Hourly watch',
        watchUrl: 'https://example.com',
        watchIntervalMinutes: 60,
      });
      const cfg = JSON.parse(task.watch_config!) as { interval_minutes: number };
      expect(cfg.interval_minutes).toBe(60);
    });
  });

  describe('complete', () => {
    it('should complete a task', () => {
      const task = tm.create({ title: 'To complete' });
      const done = tm.complete(task.id);
      expect(done?.status).toBe('completed');
      expect(done?.completed_at).toBeTruthy();
    });

    it('should complete subtasks too', () => {
      const parent = tm.create({ title: 'Parent' });
      const child = tm.create({ title: 'Child', parentTaskId: parent.id });
      tm.complete(parent.id);
      const updatedChild = history.getTask(child.id);
      expect(updatedChild?.status).toBe('completed');
    });

    it('should return undefined for missing task', () => {
      expect(tm.complete('nope')).toBeUndefined();
    });
  });

  describe('reopen', () => {
    it('should reopen a completed task', () => {
      const task = tm.create({ title: 'Reopen me' });
      tm.complete(task.id);
      const reopened = tm.reopen(task.id);
      expect(reopened?.status).toBe('open');
      expect(reopened?.completed_at).toBeNull();
    });
  });

  describe('update', () => {
    it('should update fields', () => {
      const task = tm.create({ title: 'Original' });
      const updated = tm.update(task.id, { title: 'Changed', priority: 'urgent' });
      expect(updated?.title).toBe('Changed');
      expect(updated?.priority).toBe('urgent');
    });

    it('should update assignee', () => {
      const task = tm.create({ title: 'Reassign me' });
      const updated = tm.update(task.id, { assignee: 'lynox' });
      expect(updated?.assignee).toBe('lynox');
    });

    it('should clear assignee with empty string', () => {
      const task = tm.create({ title: 'Clear me', assignee: 'user' });
      const updated = tm.update(task.id, { assignee: '' });
      expect(updated?.assignee).toBeNull();
    });

    it('should set completed_at when status changes to completed', () => {
      const task = tm.create({ title: 'Will complete' });
      const updated = tm.update(task.id, { status: 'completed' });
      expect(updated?.status).toBe('completed');
      expect(updated?.completed_at).toBeTruthy();
    });

    it('should clear completed_at when reopening via update', () => {
      const task = tm.create({ title: 'Will reopen' });
      tm.update(task.id, { status: 'completed' });
      const reopened = tm.update(task.id, { status: 'open' });
      expect(reopened?.completed_at).toBeNull();
    });

    it('should return undefined for missing task', () => {
      expect(tm.update('nope', { title: 'x' })).toBeUndefined();
    });

    it('should reject invalid status', () => {
      const task = tm.create({ title: 'Test' });
      expect(() => tm.update(task.id, { status: 'invalid' as never }))
        .toThrow('Invalid status');
    });

    // Sub-agents carry their parent's activeScopes; without an atomic
    // scope guard, a sub-agent in scope A could mutate a task in scope B
    // just by guessing a short id-prefix. The scopeFilter folds the
    // ownership check into the same SQL WHERE as the UPDATE so check +
    // mutation commit atomically.
    describe('scope filter', () => {
      it('refuses update when task scope is outside the filter', () => {
        const taskInA = tm.create({ title: 'A-side', scopeType: 'client', scopeId: 'acme' });
        const result = tm.update(
          taskInA.id,
          { title: 'pwned' },
          [{ type: 'client', id: 'other' }],
        );
        expect(result).toBeUndefined();
        // The row must remain untouched (no half-mutated state from a
        // cross-scope write).
        const row = history.getTask(taskInA.id);
        expect(row?.title).toBe('A-side');
      });

      it('allows update when task scope matches the filter', () => {
        const task = tm.create({ title: 'A-side', scopeType: 'client', scopeId: 'acme' });
        const updated = tm.update(
          task.id,
          { title: 'changed' },
          [{ type: 'client', id: 'acme' }],
        );
        expect(updated?.title).toBe('changed');
      });

      it('refuses complete when task scope is outside the filter', () => {
        const task = tm.create({ title: 'A-side', scopeType: 'client', scopeId: 'acme' });
        const result = tm.complete(task.id, [{ type: 'client', id: 'other' }]);
        expect(result).toBeUndefined();
        const row = history.getTask(task.id);
        expect(row?.status).toBe('open');
      });

      it('allows complete when task scope matches the filter', () => {
        const task = tm.create({ title: 'A-side', scopeType: 'client', scopeId: 'acme' });
        const done = tm.complete(task.id, [{ type: 'client', id: 'acme' }]);
        expect(done?.status).toBe('completed');
      });

      it('treats empty scopeFilter as no filter (single-user installs)', () => {
        const task = tm.create({ title: 'no-scope', scopeType: 'client', scopeId: 'acme' });
        const updated = tm.update(task.id, { title: 'changed' }, []);
        expect(updated?.title).toBe('changed');
      });

      it('matches when any of multiple active scopes covers the task', () => {
        const taskA = tm.create({ title: 'in A', scopeType: 'client', scopeId: 'acme' });
        const taskB = tm.create({ title: 'in B', scopeType: 'project', scopeId: 'site' });
        const filter = [
          { type: 'client', id: 'acme' },
          { type: 'project', id: 'site' },
        ];
        expect(tm.update(taskA.id, { title: 'a2' }, filter)?.title).toBe('a2');
        expect(tm.update(taskB.id, { title: 'b2' }, filter)?.title).toBe('b2');
      });
    });
  });

  describe('list', () => {
    it('should list all tasks', () => {
      tm.create({ title: 'A' });
      tm.create({ title: 'B' });
      const all = tm.list();
      expect(all).toHaveLength(2);
    });

    it('should filter by status', () => {
      tm.create({ title: 'Open' });
      const task = tm.create({ title: 'Done' });
      tm.complete(task.id);
      expect(tm.list({ status: 'open' })).toHaveLength(1);
      expect(tm.list({ status: 'completed' })).toHaveLength(1);
    });

    it('should filter by scope', () => {
      tm.create({ title: 'Context task', scopeType: 'context', scopeId: 'acme' });
      tm.create({ title: 'User task', scopeType: 'user', scopeId: 'xyz' });
      const results = tm.list({ scope: { type: 'context', id: 'acme' } });
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Context task');
    });

    it('should filter by assignee', () => {
      tm.create({ title: 'My task', assignee: 'user' });
      tm.create({ title: 'Agent task', assignee: 'lynox' });
      tm.create({ title: 'Unassigned' });
      // Post-v42 split: a USER-TODO (`tasks` table) is anything NOT routed to
      // the `triggers` table. assignee='user' and the unassigned row are TODOs;
      // assignee='lynox' is an AGENT-TRIGGER (it auto-fires), so it lands in
      // `triggers` and `tm.list` (the TODO query) no longer sees it.
      const userTasks = tm.list({ assignee: 'user' });
      expect(userTasks).toHaveLength(1);
      expect(userTasks[0]!.title).toBe('My task');
      // The lynox row is now a trigger — query the trigger side.
      expect(tm.list({ assignee: 'lynox' })).toHaveLength(0);
      const lynoxTriggers = tm.listTriggers();
      expect(lynoxTriggers).toHaveLength(1);
      expect(lynoxTriggers[0]!.title).toBe('Agent task');
    });
  });

  describe('getAssignedToLynox', () => {
    it('should return open tasks assigned to lynox', () => {
      tm.create({ title: 'Agent task 1', assignee: 'lynox' });
      tm.create({ title: 'Agent task 2', assignee: 'lynox' });
      tm.create({ title: 'User task', assignee: 'user' });
      const tasks = tm.getAssignedToLynox();
      expect(tasks).toHaveLength(2);
    });

    it('should exclude completed tasks', () => {
      const task = tm.create({ title: 'Done agent task', assignee: 'lynox' });
      tm.complete(task.id);
      tm.create({ title: 'Open agent task', assignee: 'lynox' });
      const tasks = tm.getAssignedToLynox();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.title).toBe('Open agent task');
    });

    it('should filter by scopes', () => {
      tm.create({ title: 'Context task', assignee: 'lynox', scopeType: 'context', scopeId: 'acme' });
      tm.create({ title: 'User task', assignee: 'lynox', scopeType: 'user', scopeId: 'xyz' });
      const tasks = tm.getAssignedToLynox([{ type: 'context', id: 'acme' }]);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.title).toBe('Context task');
    });
  });

  describe('getWeekSummary', () => {
    it('should categorize tasks correctly', () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      tm.create({ title: 'Overdue', dueDate: yesterday });
      tm.create({ title: 'Due today', dueDate: today });
      tm.create({ title: 'Due tomorrow', dueDate: tomorrow });
      const inProg = tm.create({ title: 'In progress' });
      tm.update(inProg.id, { status: 'in_progress' });

      const summary = tm.getWeekSummary();
      expect(summary.overdue).toHaveLength(1);
      expect(summary.dueToday).toHaveLength(1);
      expect(summary.inProgress).toHaveLength(1);
    });
  });

  describe('getBriefingSummary', () => {
    it('should return empty string when no tasks', () => {
      expect(tm.getBriefingSummary()).toBe('');
    });

    it('should include task_overview tags', () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      tm.create({ title: 'Overdue task', dueDate: yesterday, priority: 'high' });
      const briefing = tm.getBriefingSummary();
      expect(briefing).toContain('<task_overview>');
      expect(briefing).toContain('</task_overview>');
      expect(briefing).toContain('overdue');
      expect(briefing).toContain('Overdue task');
    });

    it('should highlight lynox-assigned tasks', () => {
      tm.create({ title: 'Agent work', assignee: 'lynox' });
      const briefing = tm.getBriefingSummary();
      expect(briefing).toContain('assigned to you');
      expect(briefing).toContain('Agent work');
      expect(briefing).toContain('assigned to lynox');
    });

    it('should show assignee on overdue tasks', () => {
      // Post-v42 split: only USER-TODOs have a `due_date` (the overdue concept).
      // A non-lynox assignee keeps the row in the `tasks` table so it can be
      // overdue AND carry a visible assignee tag. (assignee='lynox' would route
      // it to `triggers`, which have no due_date and so are never "overdue".)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      tm.create({ title: 'Overdue delegated', dueDate: yesterday, assignee: 'maria' });
      const briefing = tm.getBriefingSummary();
      expect(briefing).toContain('[maria]');
    });
  });

  describe('getUpcomingDeadlines', () => {
    it('should return tasks due within N days', () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const farFuture = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      tm.create({ title: 'Soon', dueDate: tomorrow });
      tm.create({ title: 'Later', dueDate: farFuture });
      const upcoming = tm.getUpcomingDeadlines(undefined, 3);
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0]!.title).toBe('Soon');
    });
  });

  describe('RunHistory CRUD', () => {
    it('should delete task and subtasks', () => {
      const parent = tm.create({ title: 'Parent' });
      tm.create({ title: 'Child', parentTaskId: parent.id });
      history.deleteTask(parent.id);
      expect(history.getTask(parent.id)).toBeUndefined();
      expect(history.getTasks({ parentTaskId: parent.id })).toHaveLength(0);
    });

    it('should get task by prefix', () => {
      const task = tm.create({ title: 'Prefix test' });
      const found = history.getTask(task.id.slice(0, 4));
      expect(found?.title).toBe('Prefix test');
    });

    it('should order by priority', () => {
      tm.create({ title: 'Low', priority: 'low' });
      tm.create({ title: 'Urgent', priority: 'urgent' });
      tm.create({ title: 'Medium' });
      const tasks = history.getTasks();
      expect(tasks[0]!.priority).toBe('urgent');
      expect(tasks[tasks.length - 1]!.priority).toBe('low');
    });
  });

  describe('scheduler refusal of non-autonomous pipelines', () => {
    afterEach(() => {
      setPipelineModeLookup(undefined);
    });

    it('rejects scheduling a cron task for an interactive pipeline', () => {
      setPipelineModeLookup(() => 'interactive');
      expect(() => tm.create({
        title: 'Daily run',
        pipelineId: 'pipe-1',
        scheduleCron: '0 9 * * *',
      })).toThrow(/only 'autonomous' pipelines/);
    });

    it('accepts scheduling a cron task for an autonomous pipeline', () => {
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.create({
        title: 'Daily run',
        pipelineId: 'pipe-1',
        scheduleCron: '0 9 * * *',
      });
      expect(task.title).toBe('Daily run');
      expect(task.schedule_cron).toBe('0 9 * * *');
    });

    it('does not block when no lookup is wired (defensive default)', () => {
      setPipelineModeLookup(undefined);
      expect(() => tm.create({
        title: 'Daily run',
        pipelineId: 'pipe-1',
        scheduleCron: '0 9 * * *',
      })).not.toThrow();
    });

    it('does not block tasks without a schedule', () => {
      setPipelineModeLookup(() => 'interactive');
      expect(() => tm.create({ title: 'Manual', pipelineId: 'pipe-1', assignee: 'user' })).not.toThrow();
    });

    it('rejects interactive pipeline with explicit nextRunAt', () => {
      setPipelineModeLookup(() => 'interactive');
      expect(() => tm.create({
        title: 'Schedule once',
        pipelineId: 'pipe-1',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      })).toThrow(/'autonomous'/);
    });

    it('rejects interactive pipeline auto-triggered via assignee=lynox', () => {
      setPipelineModeLookup(() => 'interactive');
      // No schedule supplied, but assignee=lynox sets nextRunAt=now under the hood.
      expect(() => tm.create({
        title: 'Auto run',
        pipelineId: 'pipe-1',
        assignee: 'lynox',
      })).toThrow(/'autonomous'/);
    });
  });

  // T1-2 regression — see PRD-HN-LAUNCH-HARDENING §3.
  describe('recordTaskRun — one-shot failure terminates the task', () => {
    it("marks a one-shot task 'failed' and clears next_run_at when it permanently fails with no retries", () => {
      // Simulate the WorkerLoop path: a task assigned to lynox is created
      // with assignee='lynox' which auto-sets next_run_at = now so the
      // worker picks it up immediately.
      const task = tm.create({ title: 'Bad shell command', assignee: 'lynox' }) as TriggerRecord;
      expect(task.next_run_at).toBeTruthy();
      expect(task.status).toBe('open');

      tm.recordTaskRun(task.id, 'permission denied', 'failed');

      // assignee='lynox' routes the row to the `triggers` table (it auto-fires),
      // so read it back via getTrigger — getTask only sees user-TODOs now.
      const after = tm.getTrigger(task.id);
      expect(after).toBeDefined();
      expect(after!.status).toBe('failed');
      // The crux: next_run_at must be cleared, otherwise getDueTriggers
      // would re-select the trigger every worker tick.
      expect(after!.next_run_at ?? null).toBeNull();
      // last_run_status preserves the actual outcome for the UI footer.
      expect(after!.last_run_status).toBe('failed');
    });

    it("treats a 'timeout' on a one-shot task the same as 'failed'", () => {
      const task = tm.create({ title: 'Slow command', assignee: 'lynox' });
      tm.recordTaskRun(task.id, 'execution exceeded budget', 'timeout');

      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('failed');
      expect(after!.next_run_at ?? null).toBeNull();
      expect(after!.last_run_status).toBe('timeout');
    });

    it('a failed one-shot task is no longer selected by getDueTriggers', () => {
      const task = tm.create({ title: 'Bad task', assignee: 'lynox' });
      // Pre-condition: the trigger is due.
      expect(tm.getDueTriggers().some(t => t.id === task.id)).toBe(true);

      tm.recordTaskRun(task.id, 'boom', 'failed');

      // Post-condition: the trigger is gone from the worker's queue.
      expect(tm.getDueTriggers().some(t => t.id === task.id)).toBe(false);
    });

    it('a failed one-shot task is no longer counted as assigned to lynox', () => {
      const task = tm.create({ title: 'Bad task', assignee: 'lynox' });
      expect(tm.getAssignedToLynox().some(t => t.id === task.id)).toBe(true);

      tm.recordTaskRun(task.id, 'boom', 'failed');

      expect(tm.getAssignedToLynox().some(t => t.id === task.id)).toBe(false);
    });

    it('a one-shot task with retries remaining still backs off — does NOT short-circuit to failed', () => {
      const task = tm.create({
        title: 'Flaky task',
        assignee: 'lynox',
        maxRetries: 3,
      });
      tm.recordTaskRun(task.id, 'transient error', 'failed');

      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('open');           // not failed yet
      expect(after!.retry_count).toBe(1);
      expect(after!.next_run_at).toBeTruthy();      // scheduled for retry
      // Backoff regression guard: a future-dated next_run_at means the
      // task waits; a past-dated value would re-introduce the tight loop.
      expect(new Date(after!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
      expect(after!.last_run_status).toBe('failed');
    });

    it('a recurring cron task that fails surfaces status=failed but keeps a future next_run_at', () => {
      // New semantic (replaces the pre-2026-05-23 "stays open"):
      //   - status='failed' so the UI can show the cron task is unhealthy
      //   - next_run_at is still set (cron schedule, not status, drives
      //     re-runs — getDueTriggers was widened to keep cron rows in the
      //     queue even when status='failed')
      //   - A subsequent successful run auto-recovers status to 'open'
      //     (see "auto-recovers" test below)
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.createScheduled({
        title: 'Hourly check',
        scheduleCron: '0 * * * *',
      });
      tm.recordTaskRun(task.id, 'transient error', 'failed');

      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('failed');         // surface the failure
      // Stricter than toBeTruthy: ensure the rescheduled timestamp is
      // genuinely in the future, so a regression that re-emits a stale
      // backdated next_run_at would fail this test.
      expect(new Date(after!.next_run_at!).getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(after!.last_run_status).toBe('failed');
      setPipelineModeLookup(undefined);
    });

    it('a cron task with status=timeout also surfaces status=failed', () => {
      // The derivation `status === 'success' ? 'open' : 'failed'` lumps
      // 'timeout' into 'failed' (a timed-out probe is unhealthy from the
      // operator's perspective). Guards a future "only 'failed' triggers
      // the flip" optimization that would mask timeouts.
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.createScheduled({
        title: 'Hourly check',
        scheduleCron: '0 * * * *',
      });
      tm.recordTaskRun(task.id, 'timed out', 'timeout');
      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('failed');
      expect(after!.last_run_status).toBe('timeout');
      setPipelineModeLookup(undefined);
    });

    it('a cron task that fails twice in a row stays status=failed (no flap)', () => {
      // Steady-state guard: a future "only flip status on transition"
      // optimization would mask chronic failures. Two failures in a row
      // must keep status pinned at 'failed' (not flap open/failed).
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.createScheduled({
        title: 'Hourly check',
        scheduleCron: '0 * * * *',
      });
      tm.recordTaskRun(task.id, 'boom 1', 'failed');
      expect(tm.getTrigger(task.id)!.status).toBe('failed');
      tm.recordTaskRun(task.id, 'boom 2', 'failed');
      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('failed');
      expect(after!.last_run_status).toBe('failed');
      setPipelineModeLookup(undefined);
    });

    it('a cron task with status=failed is STILL picked up by getDueTriggers (recurrence survives)', () => {
      // Regression guard: if the getDueTriggers SELECT ever reverts to
      // excluding all status='failed' rows, a single transient failure
      // would permanently freeze a weekly cron — the exact bug this
      // sprint fixes.
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.createScheduled({
        title: 'Hourly check',
        scheduleCron: '0 * * * *',
      });
      tm.recordTaskRun(task.id, 'boom', 'failed');
      expect(tm.getTrigger(task.id)!.status).toBe('failed');

      // Backdate next_run_at via the history layer (tm.update would also
      // wipe schedule_cron because of the "schedule fields move as a
      // pair" rule). The point of this test is the getDueTriggers SELECT
      // shape, not the manager API. Schedule fields live on the `triggers`
      // table now, so backdate via updateTrigger.
      history.updateTrigger(task.id, { nextRunAt: '2020-01-01T00:00:00.000Z' });
      const due = tm.getDueTriggers();
      expect(due.some(t => t.id === task.id)).toBe(true);
      setPipelineModeLookup(undefined);
    });

    it('a cron task auto-recovers status=open on the next successful run', () => {
      // Self-healing: failed → success flips status back without
      // operator intervention. Matches the "derived from latest run"
      // design choice (Approach A in the PR description).
      setPipelineModeLookup(() => 'autonomous');
      const task = tm.createScheduled({
        title: 'Hourly check',
        scheduleCron: '0 * * * *',
      });
      tm.recordTaskRun(task.id, 'transient error', 'failed');
      expect(tm.getTrigger(task.id)!.status).toBe('failed');

      tm.recordTaskRun(task.id, 'all good', 'success');
      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('open');           // auto-recovered
      expect(after!.last_run_status).toBe('success');
      expect(after!.next_run_at).toBeTruthy();      // still scheduled
      setPipelineModeLookup(undefined);
    });

    it('a successful one-shot task is still marked completed (pre-existing happy path)', () => {
      const task = tm.create({ title: 'Good task', assignee: 'lynox' });
      tm.recordTaskRun(task.id, 'ok', 'success');

      const after = tm.getTrigger(task.id);
      expect(after!.status).toBe('completed');
      expect(after!.last_run_status).toBe('success');
    });
  });

  describe('Slice B2: scheduled-workflow params + kill-switch', () => {
    afterEach(() => setPipelineModeLookup(undefined));

    it('createPipelineTask round-trips the stored param values', () => {
      // The referenced workflow must exist in engine.db so the trigger's FK
      // (target_workflow_id → workflows) resolves — a pipeline trigger always
      // points at a saved workflow (created before it is scheduled).
      history.insertPlannedPipeline({
        id: 'wf-1', name: 'Monthly report', goal: 'report', steps: [],
        reasoning: '', estimatedCost: 0, createdAt: '2026-07-01T00:00:00.000Z', template: true,
      });
      const task = tm.createPipelineTask({
        title: 'Monthly report',
        pipelineId: 'wf-1',
        scheduleCron: '0 9 1 * *',
        pipelineParams: JSON.stringify({ month: '2026-06' }),
      });
      // createPipelineTask produces an AGENT-TRIGGER — read it back via getTrigger.
      const stored = tm.getTrigger(task.id);
      expect(stored!.pipeline_params).toBe(JSON.stringify({ month: '2026-06' }));
      expect(stored!.pipeline_id).toBe('wf-1');
      // A fresh scheduled trigger is enabled by default (the column defaults to 1).
      expect(stored!.enabled).toBe(1);
    });

    it('setEnabled toggles the cron kill-switch without losing the schedule/params', () => {
      const task = tm.createPipelineTask({
        title: 'Toggle me', pipelineId: 'wf-2', scheduleCron: '0 9 * * *',
        pipelineParams: JSON.stringify({ a: 1 }),
      });
      expect(tm.setEnabled(task.id, false)).toBe(true);
      let stored = tm.getTrigger(task.id);
      expect(stored!.enabled).toBe(0);
      // schedule + params survive the disable.
      expect(stored!.schedule_cron).toBe('0 9 * * *');
      expect(stored!.pipeline_params).toBe(JSON.stringify({ a: 1 }));
      expect(tm.setEnabled(task.id, true)).toBe(true);
      stored = tm.getTrigger(task.id);
      expect(stored!.enabled).toBe(1);
    });

    it('setEnabled returns false for an unknown task', () => {
      expect(tm.setEnabled('does-not-exist', false)).toBe(false);
    });

    it('a disabled task is excluded from getDueTriggers and re-enabling restores it (reversible, no side effects)', () => {
      // A due one-shot scheduled AGENT-TRIGGER (past next_run_at, status open).
      // taskType='scheduled' + nextRunAt routes it to the `triggers` table.
      const t = tm.create({ title: 'Due', taskType: 'scheduled', nextRunAt: '2020-01-01T00:00:00.000Z' });
      expect(tm.getDueTriggers().some((x) => x.id === t.id)).toBe(true);

      tm.setEnabled(t.id, false);
      expect(tm.getDueTriggers().some((x) => x.id === t.id)).toBe(false);
      // Crucially, the disable did NOT complete the one-shot — its status is
      // untouched, so re-enabling resurrects it (the bug the getDueTriggers-level
      // filter avoids vs. skipping after selection).
      expect(tm.getTrigger(t.id)!.status).toBe('open');

      tm.setEnabled(t.id, true);
      expect(tm.getDueTriggers().some((x) => x.id === t.id)).toBe(true);
    });
  });
});
