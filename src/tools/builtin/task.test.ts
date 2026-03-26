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
