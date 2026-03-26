import type { ToolEntry, LynoxUserConfig, InlinePipelineStep, PipelineResult, PipelineStepResult, PlannedPipeline, StreamHandler } from '../../types/index.js';
import { validateManifest } from '../../orchestrator/validate.js';
import { runManifest, retryManifest } from '../../orchestrator/runner.js';
import { estimatePipelineCost } from '../../core/dag-planner.js';
import type { Manifest, AgentOutput, RunState, RunHooks } from '../../orchestrator/types.js';
import type { RunHistory } from '../../core/run-history.js';
import { getErrorMessage } from '../../core/utils.js';

const MAX_STEPS = 20;
const DEFAULT_RESULT_BYTES = 51_200; // 50KB per step result
const MAX_PLANS = 10;

// Pipeline config accessed via agent.toolContext (userConfig, tools, streamHandler, runHistory)

// In-memory store for planned pipelines (session-scoped)
const pipelineStore = new Map<string, PlannedPipeline>();

// Store last executed state per pipeline for retry
const executedStates = new Map<string, { manifest: Manifest; state: RunState }>();

/** Get a pipeline by ID (supports prefix matching, falls back to SQLite) */
export function getPipeline(id: string, runHistory?: RunHistory | null): PlannedPipeline | undefined {
  const direct = pipelineStore.get(id);
  if (direct) return direct;
  // Prefix match in memory
  for (const [key, val] of pipelineStore) {
    if (key.startsWith(id)) return val;
  }
  // Fall back to SQLite for cross-session persistence
  if (runHistory) {
    const row = runHistory.getPlannedPipeline(id);
    if (row) {
      try {
        const planned = JSON.parse(row.manifest_json) as PlannedPipeline;
        pipelineStore.set(planned.id, planned); // cache in memory
        return planned;
      } catch { /* ignore parse errors */ }
    }
  }
  return undefined;
}

/** Store a pipeline */
export function storePipeline(id: string, pipeline: PlannedPipeline): void {
  // Enforce store size limit
  if (pipelineStore.size >= MAX_PLANS) {
    const oldest = pipelineStore.keys().next().value;
    if (oldest !== undefined) {
      pipelineStore.delete(oldest);
    }
  }
  pipelineStore.set(id, pipeline);
}

/** Get the pipeline store for listing */
export function getPipelineStore(): Map<string, PlannedPipeline> {
  return pipelineStore;
}

/** Get executed state for retry */
export function getExecutedResult(pipelineId: string): { manifest: Manifest; state: RunState } | undefined {
  return executedStates.get(pipelineId);
}

function truncateResult(result: string, limit = DEFAULT_RESULT_BYTES): string {
  if (result.length <= limit) return result;
  const limitKB = Math.round(limit / 1024);
  return result.slice(0, limit) + `\n...[truncated — result was ${result.length} chars, showing first ${limitKB}KB. Set "pipeline_step_result_limit" in config to increase.]`;
}

function buildManifest(name: string, steps: InlinePipelineStep[], onFailure: 'stop' | 'continue' | 'notify', context?: Record<string, unknown>): Manifest {
  return {
    manifest_version: '1.1',
    name,
    triggered_by: 'pipeline-tool',
    context: context ?? {},
    agents: steps.map(s => ({
      id: s.id,
      agent: s.id,
      runtime: 'inline' as const,
      task: s.task,
      model: s.model,
      role: s.role,
      input_from: s.input_from,
      timeout_ms: s.timeout_ms,
    })),
    gate_points: [],
    on_failure: onFailure,
  };
}

function buildProgressHooks(pipelineStreamHandler: StreamHandler | null): RunHooks {
  const handler = pipelineStreamHandler;
  if (!handler) return {};

  const HEARTBEAT_INTERVAL = 15_000;
  const heartbeats = new Map<string, { timer: ReturnType<typeof setInterval> | null; startedAt: number }>();
  let consolidatedTimer: ReturnType<typeof setInterval> | null = null;

  const emitConsolidatedHeartbeat = (): void => {
    if (heartbeats.size === 0) return;
    if (heartbeats.size === 1) {
      const [stepId, hb] = [...heartbeats.entries()][0]!;
      const elapsed = Math.round((Date.now() - hb.startedAt) / 1000);
      void handler({
        type: 'pipeline_progress', stepId, status: 'started',
        detail: `running ${elapsed}s...`, agent: 'pipeline',
      });
    } else {
      const steps = [...heartbeats.entries()].map(([id, hb]) => {
        const elapsed = Math.round((Date.now() - hb.startedAt) / 1000);
        return `${id} ${elapsed}s`;
      });
      void handler({
        type: 'pipeline_progress', stepId: `${heartbeats.size} steps`, status: 'started',
        detail: `running: ${steps.join(', ')}`, agent: 'pipeline',
      });
    }
  };

  const ensureConsolidatedTimer = (): void => {
    if (!consolidatedTimer) {
      consolidatedTimer = setInterval(emitConsolidatedHeartbeat, HEARTBEAT_INTERVAL);
    }
  };

  const stopConsolidatedTimer = (): void => {
    if (heartbeats.size === 0 && consolidatedTimer) {
      clearInterval(consolidatedTimer);
      consolidatedTimer = null;
    }
  };

  const startHeartbeat = (stepId: string): void => {
    heartbeats.set(stepId, { timer: null, startedAt: Date.now() });
    ensureConsolidatedTimer();
  };

  const stopHeartbeat = (stepId: string): void => {
    heartbeats.delete(stepId);
    stopConsolidatedTimer();
  };

  return {
    onPhaseStart: (phaseIndex: number, stepIds: string[]) => {
      const parallel = stepIds.length > 1 ? ` (${stepIds.length} parallel)` : '';
      void handler({
        type: 'pipeline_progress', stepId: `phase-${phaseIndex + 1}`, status: 'started',
        detail: `Phase ${phaseIndex + 1}${parallel}`, agent: 'pipeline',
      });
    },
    onStepStart: (stepId: string, agentName: string) => {
      void handler({
        type: 'pipeline_progress', stepId, status: 'started',
        detail: agentName, agent: 'pipeline',
      });
      startHeartbeat(stepId);
    },
    onStepComplete: (output: AgentOutput) => {
      stopHeartbeat(output.stepId);
      void handler({
        type: 'pipeline_progress', stepId: output.stepId, status: 'completed',
        durationMs: output.durationMs, agent: 'pipeline',
      });
    },
    onStepSkipped: (stepId: string, reason: string) => {
      stopHeartbeat(stepId);
      void handler({
        type: 'pipeline_progress', stepId, status: 'skipped',
        detail: reason, agent: 'pipeline',
      });
    },
    onError: (stepId: string, error: Error) => {
      stopHeartbeat(stepId);
      void handler({
        type: 'pipeline_progress', stepId, status: 'failed',
        detail: error.message, agent: 'pipeline',
      });
    },
  };
}

function formatResult(state: RunState, name: string, resultLimit?: number): string {
  const steps: PipelineStepResult[] = [];
  let totalDuration = 0;
  let totalCost = 0;

  for (const [, output] of state.outputs) {
    steps.push({
      stepId: output.stepId,
      result: truncateResult(output.result, resultLimit),
      durationMs: output.durationMs,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      costUsd: output.costUsd,
      skipped: output.skipped,
      skipReason: output.skipReason,
      error: output.error,
    });
    totalDuration += output.durationMs;
    totalCost += output.costUsd;
  }

  const result: PipelineResult = {
    pipelineId: state.runId,
    name,
    status: state.status === 'completed' ? 'completed' : state.status === 'rejected' ? 'rejected' : 'failed',
    steps,
    totalDurationMs: totalDuration,
    totalCostUsd: totalCost,
  };

  return JSON.stringify(result, null, 2);
}

function persistPipelineRun(state: RunState, manifest: Manifest, pipelineRunHistory: RunHistory | null, resultLimit?: number): void {
  if (!pipelineRunHistory) return;
  try {
    pipelineRunHistory.insertPipelineRun({
      id: state.runId,
      manifestName: manifest.name,
      status: state.status,
      manifestJson: JSON.stringify(manifest),
      totalDurationMs: [...state.outputs.values()].reduce((s, o) => s + o.durationMs, 0),
      totalCostUsd: [...state.outputs.values()].reduce((s, o) => s + o.costUsd, 0),
      totalTokensIn: [...state.outputs.values()].reduce((s, o) => s + o.tokensIn, 0),
      totalTokensOut: [...state.outputs.values()].reduce((s, o) => s + o.tokensOut, 0),
      stepCount: state.outputs.size,
      error: state.error,
    });
    for (const [, output] of state.outputs) {
      pipelineRunHistory.insertPipelineStepResult({
        pipelineRunId: state.runId,
        stepId: output.stepId,
        status: output.skipped ? 'skipped' : output.error ? 'failed' : 'completed',
        result: truncateResult(output.result, resultLimit),
        error: output.error,
        durationMs: output.durationMs,
        tokensIn: output.tokensIn,
        tokensOut: output.tokensOut,
        costUsd: output.costUsd,
      });
    }
  } catch {
    // Fire-and-forget
  }
}

// ===== Private execution helpers =====

interface StepModification {
  step_id: string;
  action: 'remove' | 'update_task';
  value?: string | undefined;
}

async function executeInlineSteps(input: RunPipelineInput, deps: PipelineDeps): Promise<string> {
  const steps = input.steps!;

  if (steps.length === 0) {
    return 'Error: Pipeline must have at least one step.';
  }
  if (steps.length > MAX_STEPS) {
    return `Error: Pipeline exceeds maximum of ${MAX_STEPS} steps (got ${steps.length}).`;
  }

  // Validate unique IDs
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      return `Error: Duplicate step ID "${step.id}".`;
    }
    ids.add(step.id);
  }

  const resultLimit = deps.config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;

  try {
    const manifest = buildManifest(
      input.name ?? 'inline-pipeline',
      steps,
      input.on_failure ?? 'stop',
      input.context,
    );

    validateManifest(manifest);

    const costEstimate = estimatePipelineCost(steps);
    if (deps.streamHandler) {
      void deps.streamHandler({
        type: 'pipeline_progress', stepId: 'cost-estimate', status: 'started',
        detail: `${steps.length} steps, estimated cost: $${costEstimate.totalCostUsd.toFixed(4)}`,
        agent: 'pipeline',
      });
    }

    const hooks = buildProgressHooks(deps.streamHandler);
    const state = await runManifest(manifest, deps.config, {
      parentTools: deps.tools,
      hooks,
      runHistory: deps.runHistory ?? undefined,
    });

    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    return formatResult(state, input.name ?? 'inline-pipeline', resultLimit);
  } catch (err: unknown) {
    return `Error: Pipeline execution failed: ${getErrorMessage(err)}`;
  }
}

function applyModifications(steps: InlinePipelineStep[], modifications: StepModification[]): string | null {
  for (const mod of modifications) {
    const idx = steps.findIndex(s => s.id === mod.step_id);

    if (mod.action === 'remove') {
      if (idx === -1) {
        return `Error: Step "${mod.step_id}" not found for removal.`;
      }
      const removedId = steps[idx]!.id;
      steps.splice(idx, 1);
      for (const s of steps) {
        if (s.input_from) {
          s.input_from = s.input_from.filter(dep => dep !== removedId);
          if (s.input_from.length === 0) {
            s.input_from = undefined;
          }
        }
      }
    } else if (mod.action === 'update_task') {
      if (idx === -1) {
        return `Error: Step "${mod.step_id}" not found for task update.`;
      }
      if (!mod.value) {
        return 'Error: "value" is required for update_task modification.';
      }
      steps[idx]!.task = mod.value;
    }
  }
  return null; // no error
}

interface PipelineDeps {
  config: LynoxUserConfig;
  tools: ToolEntry[];
  streamHandler: StreamHandler | null;
  runHistory: RunHistory | null;
}

async function executePipelineById(input: RunPipelineInput, deps: PipelineDeps): Promise<string> {
  const planned = getPipeline(input.pipeline_id!, deps.runHistory);
  if (!planned) {
    return `Error: Pipeline "${input.pipeline_id}" not found.`;
  }

  const resultLimit = deps.config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;

  // Retry mode
  if (input.retry) {
    const prev = executedStates.get(planned.id);
    if (!prev) {
      return `Error: No previous execution found for pipeline "${planned.id}". Execute it first before retrying.`;
    }

    try {
      const hooks = buildProgressHooks(deps.streamHandler);
      const state = await retryManifest(prev.manifest, prev.state, deps.config, {
        parentTools: deps.tools,
        hooks,
        runHistory: deps.runHistory ?? undefined,
      });

      executedStates.set(planned.id, { manifest: prev.manifest, state });
      persistPipelineRun(state, prev.manifest, deps.runHistory, resultLimit);
      return formatResult(state, planned.name, resultLimit);
    } catch (err: unknown) {
      return `Error: Pipeline retry failed: ${getErrorMessage(err)}`;
    }
  }

  if (planned.executed) {
    return `Error: Pipeline "${planned.id}" has already been executed.`;
  }

  // Deep copy steps for modification
  const steps: InlinePipelineStep[] = planned.steps.map(s => ({ ...s }));

  if (input.modifications?.length) {
    const error = applyModifications(steps, input.modifications);
    if (error) return error;
  }

  if (steps.length === 0) {
    return 'Error: All steps were removed. Nothing to execute.';
  }

  if (steps.length > MAX_STEPS) {
    return `Error: Pipeline exceeds maximum of ${MAX_STEPS} steps.`;
  }

  try {
    const manifest = buildManifest(
      planned.name,
      steps,
      input.on_failure ?? 'stop',
    );

    validateManifest(manifest);
    planned.executed = true;

    const hooks = buildProgressHooks(deps.streamHandler);
    const state = await runManifest(manifest, deps.config, {
      parentTools: deps.tools,
      hooks,
      runHistory: deps.runHistory ?? undefined,
    });

    executedStates.set(planned.id, { manifest, state });
    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    try { deps.runHistory?.markPipelineExecuted(planned.id); } catch { /* fire-and-forget */ }

    return formatResult(state, planned.name, resultLimit);
  } catch (err: unknown) {
    planned.executed = false; // Allow retry on validation errors
    return `Error: Pipeline execution failed: ${getErrorMessage(err)}`;
  }
}

// ===== run_pipeline =====

interface RunPipelineInput {
  name?: string | undefined;
  steps?: InlinePipelineStep[] | undefined;
  pipeline_id?: string | undefined;
  on_failure?: 'stop' | 'continue' | 'notify' | undefined;
  context?: Record<string, unknown> | undefined;
  retry?: boolean | undefined;
  modifications?: StepModification[] | undefined;
}

export const runPipelineTool: ToolEntry<RunPipelineInput> = {
  definition: {
    name: 'run_pipeline',
    description:
      'Execute a multi-step workflow. Provide steps[] for inline execution, or pipeline_id to run a stored pipeline. ' +
      'Steps without dependencies run in parallel automatically.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name for tracking (required for inline steps)',
        },
        steps: {
          type: 'array',
          description: 'Inline workflow steps. Each step gets its own sub-agent. Use input_from for data dependencies.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step ID' },
              task: { type: 'string', description: 'Task description for the sub-agent' },
              input_from: { type: 'array', items: { type: 'string' }, description: 'Step IDs whose output flows into this step\'s context' },
              timeout_ms: { type: 'number', description: 'Timeout in ms (default: 600000)' },
            },
            required: ['id', 'task'],
          },
        },
        pipeline_id: {
          type: 'string',
          description: 'ID of a stored workflow to execute (from plan_task or promote_process)',
        },
        on_failure: {
          type: 'string',
          enum: ['stop', 'continue', 'notify'],
          description: 'Failure strategy (default: stop)',
        },
        context: {
          type: 'object',
          description: 'Global context variables available to all steps',
        },
        retry: {
          type: 'boolean',
          description: 'If true, skip completed steps and re-execute only failed/skipped ones (requires pipeline_id)',
        },
        modifications: {
          type: 'array',
          description: 'Modify steps before execution (requires pipeline_id)',
          items: {
            type: 'object',
            properties: {
              step_id: { type: 'string', description: 'Step ID to modify' },
              action: { type: 'string', enum: ['remove', 'update_task'], description: 'Modification type' },
              value: { type: 'string', description: 'New value (required for update_task)' },
            },
            required: ['step_id', 'action'],
          },
        },
      },
    },
  },
  handler: async (input: RunPipelineInput, agent): Promise<string> => {
    const pipelineConfig = agent.toolContext.userConfig;
    const pipelineTools = agent.toolContext.tools;
    const pipelineStreamHandler = agent.toolContext.streamHandler;
    const pipelineRunHistory = agent.toolContext.runHistory;
    if (!pipelineConfig) {
      return 'Error: Pipeline config not initialized. Pipeline tools are not available.';
    }

    if (pipelineTools.length === 0) {
      return 'Error: No parent tools available for inline pipeline steps.';
    }

    if (input.steps && input.pipeline_id) {
      return 'Error: Provide either steps[] or pipeline_id, not both.';
    }

    if (!input.steps && !input.pipeline_id) {
      return 'Error: Provide steps[] for inline execution or pipeline_id for a stored pipeline.';
    }

    if (input.pipeline_id) {
      return executePipelineById(input, {
        config: pipelineConfig,
        tools: pipelineTools,
        streamHandler: pipelineStreamHandler,
        runHistory: pipelineRunHistory,
      });
    }

    return executeInlineSteps(input, {
        config: pipelineConfig,
        tools: pipelineTools,
        streamHandler: pipelineStreamHandler,
        runHistory: pipelineRunHistory,
      });
  },
};

/** Reset pipeline store — for testing only */
export function _resetPipelineStore(): void {
  pipelineStore.clear();
  executedStates.clear();
}
