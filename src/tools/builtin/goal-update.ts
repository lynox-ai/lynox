import type { ToolEntry } from '../../types/index.js';
import type { GoalTracker } from '../../core/goal-tracker.js';

interface GoalUpdateInput {
  action: 'add_subtask' | 'complete_subtask' | 'goal_complete' | 'goal_failed';
  description: string;
}

// GoalTracker accessed via agent.toolContext.goalTracker

export const goalUpdateTool: ToolEntry<GoalUpdateInput> = {
  definition: {
    name: 'goal_update',
    description: 'Track progress on the current objective — add subtasks, mark them complete, or report completion/failure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['add_subtask', 'complete_subtask', 'goal_complete', 'goal_failed'],
          description: 'The action to take on the goal.',
        },
        description: {
          type: 'string',
          description: 'For add_subtask/complete_subtask: the subtask description. For goal_failed: the reason.',
        },
      },
      required: ['action', 'description'],
    },
  },
  handler: async (input: GoalUpdateInput, agent): Promise<string> => {
    const trackerRef = agent.toolContext.goalTracker;
    if (!trackerRef) {
      return 'Error: No active goal tracker. goal_update is only available in goal-tracking modes.';
    }

    switch (input.action) {
      case 'add_subtask':
        trackerRef.addSubtask(input.description);
        return `Subtask registered: ${input.description}`;
      case 'complete_subtask':
        trackerRef.completeSubtask(input.description);
        return `Subtask completed: ${input.description}`;
      case 'goal_complete':
        trackerRef.markComplete();
        return 'Goal marked as complete.';
      case 'goal_failed':
        trackerRef.markFailed(input.description);
        return `Goal marked as failed: ${input.description}`;
      default:
        return `Unknown action: ${String(input.action)}`;
    }
  },
};
