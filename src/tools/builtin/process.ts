import type { ToolEntry, IAgent, ProcessRecord, InlinePipelineStep, PlannedPipeline } from '../../types/index.js';
import { captureProcess } from '../../core/process-capture.js';
import { estimatePipelineCost } from '../../core/dag-planner.js';
import { storePipeline } from './pipeline.js';
import { getErrorMessage, logErrorChain } from '../../core/utils.js';
import { randomUUID } from 'node:crypto';

// Dependencies accessed via agent.toolContext (runHistory, userConfig)

// === capture_process ===

interface CaptureInput {
  name: string;
  description?: string | undefined;
}

export const captureProcessTool: ToolEntry<CaptureInput> = {
  definition: {
    name: 'capture_process',
    description:
      'Save the work you just completed as a reusable workflow template. ' +
      'Reads the actual steps from this session and identifies what is fixed vs. variable.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for this workflow (e.g., "Monthly Ad Report")' },
        description: { type: 'string', description: 'Brief description of what this workflow does' },
      },
      required: ['name'],
    },
  },
  handler: async (input: CaptureInput, agent: IAgent): Promise<string> => {
    const _runHistory = agent.toolContext.runHistory;
    const _config = agent.toolContext.userConfig;
    if (!_runHistory || !_config) {
      return 'Error: Process capture not available. Run history is not initialized.';
    }

    const runId = agent.currentRunId;
    if (!runId) {
      return 'Error: No active run. Process capture can only be used during a session.';
    }

    const apiKey = _config.api_key;
    if (!apiKey) {
      return 'Error: API key not configured. Required for process analysis.';
    }

    try {
      const toolCalls = _runHistory.getRunToolCalls(runId);
      if (toolCalls.length === 0) {
        return 'No tool calls found in this session. Nothing to capture.';
      }

      const record = await captureProcess(runId, input.name, toolCalls, {
        apiKey,
        apiBaseURL: _config.api_base_url,
        description: input.description,
      });

      _runHistory.insertProcess(record);

      // Format summary for agent to present to user
      const stepSummary = record.steps.map((s, i) =>
        `${i + 1}. ${s.description}`,
      ).join('\n');

      const paramSummary = record.parameters.length > 0
        ? record.parameters.map(p =>
            `- ${p.name}: ${p.description} (${p.source}, default: ${p.defaultValue ?? 'none'})`,
          ).join('\n')
        : 'None — all values are fixed.';

      return JSON.stringify({
        process_id: record.id,
        name: record.name,
        steps: stepSummary,
        parameters: paramSummary,
        step_count: record.steps.length,
        parameter_count: record.parameters.length,
      }, null, 2);
    } catch (err) {
      logErrorChain('capture_process', err);
      return `Error capturing process: ${getErrorMessage(err)}`;
    }
  },
};

// === promote_process ===

interface PromoteInput {
  process_id: string;
  parameter_values?: Record<string, unknown> | undefined;
}

function processToSteps(record: ProcessRecord): InlinePipelineStep[] {
  return record.steps.map(step => {
    // Build task from description + parameter hints
    const paramHints = record.parameters
      .filter(p => {
        // Check if this parameter appears in this step's inputTemplate
        const templateStr = JSON.stringify(step.inputTemplate);
        return templateStr.includes(p.name);
      })
      .map(p => `{{${p.name}}}`)
      .join(', ');

    const task = paramHints
      ? `${step.description}\n\nParameters: ${paramHints}`
      : step.description;

    // Convert dependsOn indices to step IDs
    const input_from = step.dependsOn?.length
      ? step.dependsOn.map(idx => {
          const dep = record.steps[idx];
          return dep ? `step-${idx}` : undefined;
        }).filter((id): id is string => id !== undefined)
      : undefined;

    return {
      id: `step-${step.order}`,
      task,
      input_from: input_from?.length ? input_from : undefined,
    };
  });
}

export const promoteProcessTool: ToolEntry<PromoteInput> = {
  definition: {
    name: 'promote_process',
    description:
      'Convert a captured process into a reusable workflow. ' +
      'Parameters become configurable inputs that can change between runs.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        process_id: { type: 'string', description: 'Process ID returned by capture_process' },
        parameter_values: {
          type: 'object',
          description: 'Override default parameter values for the pipeline',
        },
      },
      required: ['process_id'],
    },
  },
  handler: async (input: PromoteInput, agent): Promise<string> => {
    const _runHistory = agent.toolContext.runHistory;
    if (!_runHistory) {
      return 'Error: Process storage not available.';
    }

    const record = _runHistory.getProcess(input.process_id);
    if (!record) {
      return `Error: Process "${input.process_id}" not found. Use capture_process first.`;
    }

    if (record.promotedToPipelineId) {
      return `This process was already promoted to pipeline "${record.promotedToPipelineId}".`;
    }

    try {
      const pipelineSteps = processToSteps(record);
      if (pipelineSteps.length === 0) {
        return 'Error: Process has no steps to promote.';
      }

      const pipelineId = randomUUID();
      const costEstimate = estimatePipelineCost(pipelineSteps);

      // Build context from parameters with defaults or overrides
      const context: Record<string, unknown> = {};
      for (const param of record.parameters) {
        const override = input.parameter_values?.[param.name];
        context[param.name] = override ?? param.defaultValue ?? null;
      }

      const planned: PlannedPipeline = {
        id: pipelineId,
        name: record.name,
        goal: record.description || record.name,
        steps: pipelineSteps,
        reasoning: `Promoted from captured process ${record.id}`,
        estimatedCost: costEstimate.totalCostUsd,
        createdAt: new Date().toISOString(),
        executed: false,
      };

      storePipeline(pipelineId, planned);
      _runHistory.updateProcessPromotion(record.id, pipelineId);

      return JSON.stringify({
        pipeline_id: pipelineId,
        name: record.name,
        steps: pipelineSteps.length,
        parameters: record.parameters.map(p => p.name),
        estimated_cost: `$${costEstimate.totalCostUsd.toFixed(4)}`,
        next: `Call run_pipeline with pipeline_id "${pipelineId}" to run this workflow.`,
      }, null, 2);
    } catch (err) {
      logErrorChain('promote_process', err);
      return `Error promoting process: ${getErrorMessage(err)}`;
    }
  },
};

// State reset no longer needed — dependencies come from ToolContext
