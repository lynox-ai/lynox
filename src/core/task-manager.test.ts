import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { TaskManager } from './task-manager.js';

describe('TaskManager', () => {
  let dir: string;
  let history: RunHistory;
  let tm: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodyn-task-test-'));
    history = new RunHistory(join(dir, 'test.db'));
    tm = new TaskManager(history);
  });

  afterEach(() => {
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

    it('should create a task with nodyn assignee', () => {
      const task = tm.create({ title: 'Agent work', assignee: 'nodyn' });
      expect(task.assignee).toBe('nodyn');
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
      const updated = tm.update(task.id, { assignee: 'nodyn' });
      expect(updated?.assignee).toBe('nodyn');
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
      tm.create({ title: 'Agent task', assignee: 'nodyn' });
      tm.create({ title: 'Unassigned' });
      const userTasks = tm.list({ assignee: 'user' });
      expect(userTasks).toHaveLength(1);
      expect(userTasks[0]!.title).toBe('My task');
      const nodynTasks = tm.list({ assignee: 'nodyn' });
      expect(nodynTasks).toHaveLength(1);
      expect(nodynTasks[0]!.title).toBe('Agent task');
    });
  });

  describe('getAssignedToNodyn', () => {
    it('should return open tasks assigned to nodyn', () => {
      tm.create({ title: 'Agent task 1', assignee: 'nodyn' });
      tm.create({ title: 'Agent task 2', assignee: 'nodyn' });
      tm.create({ title: 'User task', assignee: 'user' });
      const tasks = tm.getAssignedToNodyn();
      expect(tasks).toHaveLength(2);
    });

    it('should exclude completed tasks', () => {
      const task = tm.create({ title: 'Done agent task', assignee: 'nodyn' });
      tm.complete(task.id);
      tm.create({ title: 'Open agent task', assignee: 'nodyn' });
      const tasks = tm.getAssignedToNodyn();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.title).toBe('Open agent task');
    });

    it('should filter by scopes', () => {
      tm.create({ title: 'Context task', assignee: 'nodyn', scopeType: 'context', scopeId: 'acme' });
      tm.create({ title: 'User task', assignee: 'nodyn', scopeType: 'user', scopeId: 'xyz' });
      const tasks = tm.getAssignedToNodyn([{ type: 'context', id: 'acme' }]);
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

    it('should highlight nodyn-assigned tasks', () => {
      tm.create({ title: 'Agent work', assignee: 'nodyn' });
      const briefing = tm.getBriefingSummary();
      expect(briefing).toContain('assigned to you');
      expect(briefing).toContain('Agent work');
      expect(briefing).toContain('assigned to nodyn');
    });

    it('should show assignee on overdue tasks', () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      tm.create({ title: 'Overdue agent', dueDate: yesterday, assignee: 'nodyn' });
      const briefing = tm.getBriefingSummary();
      expect(briefing).toContain('[nodyn]');
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
});
