import { describe, it, expect, vi, beforeEach } from 'vitest';
import { goalUpdateTool } from './goal-update.js';
import { createToolContext } from '../../core/tool-context.js';
import type { IAgent } from '../../types/index.js';

function makeTracker() {
  return {
    addSubtask: vi.fn(),
    completeSubtask: vi.fn(),
    markComplete: vi.fn(),
    markFailed: vi.fn(),
    state: vi.fn(),
    continuationPrompt: vi.fn(),
    summary: vi.fn(),
  };
}

function makeAgent(tracker: ReturnType<typeof makeTracker> | null = null): IAgent {
  const toolContext = createToolContext({});
  toolContext.goalTracker = tracker as never;
  return { toolContext } as unknown as IAgent;
}

describe('goalUpdateTool', () => {
  it('returns error when no tracker is set', async () => {
    const agent = makeAgent(null);
    const result = await goalUpdateTool.handler(
      { action: 'add_subtask', description: 'test' },
      agent,
    );
    expect(result).toBe('Error: No active goal tracker. goal_update is only available in goal-tracking modes.');
  });

  it('add_subtask calls tracker.addSubtask', async () => {
    const tracker = makeTracker();
    const agent = makeAgent(tracker);

    const result = await goalUpdateTool.handler(
      { action: 'add_subtask', description: 'write tests' },
      agent,
    );
    expect(result).toBe('Subtask registered: write tests');
    expect(tracker.addSubtask).toHaveBeenCalledWith('write tests');
  });

  it('complete_subtask calls tracker.completeSubtask', async () => {
    const tracker = makeTracker();
    const agent = makeAgent(tracker);

    const result = await goalUpdateTool.handler(
      { action: 'complete_subtask', description: 'write tests' },
      agent,
    );
    expect(result).toBe('Subtask completed: write tests');
    expect(tracker.completeSubtask).toHaveBeenCalledWith('write tests');
  });

  it('goal_complete calls tracker.markComplete', async () => {
    const tracker = makeTracker();
    const agent = makeAgent(tracker);

    const result = await goalUpdateTool.handler(
      { action: 'goal_complete', description: 'all done' },
      agent,
    );
    expect(result).toBe('Goal marked as complete.');
    expect(tracker.markComplete).toHaveBeenCalled();
  });

  it('goal_failed calls tracker.markFailed with description', async () => {
    const tracker = makeTracker();
    const agent = makeAgent(tracker);

    const result = await goalUpdateTool.handler(
      { action: 'goal_failed', description: 'out of budget' },
      agent,
    );
    expect(result).toBe('Goal marked as failed: out of budget');
    expect(tracker.markFailed).toHaveBeenCalledWith('out of budget');
  });

  it('returns "Unknown action" for invalid action', async () => {
    const tracker = makeTracker();
    const agent = makeAgent(tracker);

    const result = await goalUpdateTool.handler(
      { action: 'invalid_action' as never, description: 'test' },
      agent,
    );
    expect(result).toBe('Unknown action: invalid_action');
  });

  it('clearing goalTracker on toolContext makes next call return error', async () => {
    const tracker = makeTracker();
    const toolContext = createToolContext({});
    toolContext.goalTracker = tracker as never;
    const agent = { toolContext } as unknown as IAgent;

    // Verify tracker is active
    const first = await goalUpdateTool.handler(
      { action: 'add_subtask', description: 'one' },
      agent,
    );
    expect(first).toContain('Subtask registered');

    // Clear tracker
    toolContext.goalTracker = null;

    const second = await goalUpdateTool.handler(
      { action: 'add_subtask', description: 'two' },
      agent,
    );
    expect(second).toContain('Error: No active goal tracker');
  });
});
