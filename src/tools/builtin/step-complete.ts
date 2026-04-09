/**
 * step_complete — Zero-overhead tool for tracking plan step execution.
 *
 * The agent calls this after completing each step of an approved plan.
 * No sub-agents, no extra API calls — just bookkeeping + SSE progress events.
 */

import type { ToolEntry, IAgent } from '../../types/index.js';
import { recordStepComplete, markStepStarted, checkAndFinalize } from '../../core/plan-tracker.js';

interface StepCompleteInput {
  /** Step ID from the approved plan */
  step_id: string;
  /** Brief summary of what was accomplished */
  summary: string;
  /** Step status — default: completed */
  status?: 'completed' | 'failed' | 'skipped' | undefined;
}

export const stepCompleteTool: ToolEntry<StepCompleteInput> = {
  definition: {
    name: 'step_complete',
    description:
      'Mark a plan step as completed after you execute it. Call this after each step of an approved plan ' +
      '(from plan_task). Provides tracking, analytics, and enables workflow reuse — zero extra cost.',
    input_schema: {
      type: 'object' as const,
      properties: {
        step_id: {
          type: 'string',
          description: 'Step ID from the approved plan',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the step result (1-2 sentences)',
        },
        status: {
          type: 'string',
          enum: ['completed', 'failed', 'skipped'],
          description: 'Step outcome (default: completed)',
        },
      },
      required: ['step_id', 'summary'],
    },
  },
  handler: async (input: StepCompleteInput, agent: IAgent): Promise<string> => {
    const toolContext = agent.toolContext;
    const plan = toolContext.activePlan;

    if (!plan) {
      return 'No active plan. Use plan_task first to create and approve a plan.';
    }

    const stepId = input.step_id;
    const status = input.status ?? 'completed';

    // Validate step exists in plan
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) {
      const validIds = plan.steps.map(s => s.id).join(', ');
      return `Unknown step "${stepId}". Valid steps: ${validIds}`;
    }

    // Already completed?
    const existing = plan.stepResults.get(stepId);
    if (existing && existing.completedAt) {
      return `Step "${stepId}" was already marked as ${existing.status}.`;
    }

    // Record the result
    const progress = recordStepComplete(stepId, input.summary, status, toolContext);
    if (!progress) {
      return 'Failed to record step result.';
    }

    // Mark the next step as started (for UI elapsed tracking)
    const nextPending = plan.steps.find(s => !plan.stepResults.has(s.id) || !plan.stepResults.get(s.id)!.completedAt);
    if (nextPending && nextPending.id !== stepId) {
      markStepStarted(nextPending.id, toolContext);
    }

    // Check if all steps done → auto-finalize
    const finalized = checkAndFinalize(toolContext, toolContext.runHistory);

    const statusEmoji = status === 'completed' ? '\u2713' : status === 'failed' ? '\u2717' : '\u2014';
    const progressStr = `${progress.completed}/${progress.total}`;

    if (finalized) {
      return `${statusEmoji} Step "${stepId}" ${status} (${progressStr}). Workflow complete — results saved.`;
    }

    return `${statusEmoji} Step "${stepId}" ${status} (${progressStr}).`;
  },
};
