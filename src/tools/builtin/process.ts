import type { ToolEntry, IAgent, ProcessRecord, InlinePipelineStep, PlannedPipeline, ProviderConfigSnapshot } from '../../types/index.js';
import { captureProcess } from '../../core/process-capture.js';
import { estimatePipelineCost } from '../../core/dag-planner.js';
import { storePipeline, getPipeline } from './pipeline.js';
import { getErrorMessage, logErrorChain } from '../../core/utils.js';
import { randomUUID } from 'node:crypto';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import { assertPlannedPipelineIsValid } from '../../orchestrator/validate.js';

// Dependencies accessed via agent.toolContext (runHistory, userConfig)

// === save_workflow ===
//
// One atomic call that replaces the former capture_process -> promote_process
// two-step dance. Two sources (PRD D6):
//   - implicit "this session" — captures the work just done in this session
//     and immediately promotes it to a reusable PlannedPipeline template;
//   - an existing `workflow_id` — takes a `plan_task` pipeline and flips it
//     into a reusable template.
// Returns a `workflow_id` either way.

interface SaveWorkflowInput {
  name: string;
  description?: string | undefined;
  /**
   * Optional. When given, promote an existing plan_task pipeline to a
   * reusable template. When omitted, capture + promote the current session.
   */
  workflow_id?: string | undefined;
}

/**
 * Convert a captured ProcessRecord into runnable pipeline steps. Parameter
 * names referenced by a step's inputTemplate are surfaced as `{{name}}`
 * placeholders in the step task so the workflow stays re-parameterizable.
 */
function processToSteps(record: ProcessRecord): InlinePipelineStep[] {
  const validOrders = new Set(record.steps.map(s => s.order));
  return record.steps.map(step => {
    const paramHints = record.parameters
      .filter(p => {
        const templateStr = JSON.stringify(step.inputTemplate);
        return templateStr.includes(p.name);
      })
      .map(p => `{{${p.name}}}`)
      .join(', ');

    const task = paramHints
      ? `${step.description}\n\nParameters: ${paramHints}`
      : step.description;

    // `dependsOn` holds step `order` values — the same space the `step-<order>`
    // IDs below use. Keep only deps that resolve to a real step so a stale
    // order can never leave a dangling `input_from` reference.
    const input_from = step.dependsOn?.length
      ? step.dependsOn.filter(order => validOrders.has(order)).map(order => `step-${order}`)
      : undefined;

    return {
      id: `step-${step.order}`,
      task,
      input_from: input_from?.length ? input_from : undefined,
    };
  });
}

/**
 * Source A — promote an existing plan_task pipeline to a reusable template.
 * Atomic: flips `template` on a fresh copy and stores it; no partial state.
 */
function promoteExistingWorkflow(input: SaveWorkflowInput, agent: IAgent): string {
  const runHistory = agent.toolContext.runHistory;
  if (!runHistory) {
    return 'Error: Workflow save not available. Run history is not initialized.';
  }
  const existing = getPipeline(input.workflow_id!, runHistory);
  if (!existing) {
    return `Error: Workflow "${input.workflow_id}" not found. Pass a workflow_id returned by plan_task, or omit it to save this session's work.`;
  }

  if (existing.template) {
    return JSON.stringify({
      workflow_id: existing.id,
      name: existing.name,
      steps: existing.steps.length,
      already_reusable: true,
      next: `Workflow "${existing.id}" is already a reusable template. Call run_workflow with this workflow_id to run it.`,
    }, null, 2);
  }

  // Store a reusable copy under a new id — keeps the original plan intact.
  const reusableId = randomUUID();
  const reusable: PlannedPipeline = {
    ...existing,
    id: reusableId,
    name: input.name,
    goal: input.description || existing.goal,
    template: true,
    executed: false,
    createdAt: new Date().toISOString(),
  };

  // Save-time gate — same as plan_task.
  assertPlannedPipelineIsValid(reusable);
  // Commit: the in-memory store for this session AND the pipeline_runs row
  // (status='planned') so the Saved Workflows library — which reads SQLite —
  // actually finds it. storePipeline alone is volatile (LRU, lost on restart).
  storePipeline(reusableId, reusable);
  runHistory.insertPlannedPipeline(reusable);

  return JSON.stringify({
    workflow_id: reusableId,
    name: reusable.name,
    steps: reusable.steps.length,
    source: 'workflow_id',
    next: `Call run_workflow with workflow_id "${reusableId}" to run this workflow. It is saved and reusable.`,
  }, null, 2);
}

/**
 * Source B — capture this session's finished work and promote it in one go.
 * Atomic: the internal ProcessRecord is written only after the Haiku
 * extraction succeeds, and the PlannedPipeline only after that — an
 * extraction failure leaves no partial state and is safe to retry.
 */
async function saveSessionWorkflow(input: SaveWorkflowInput, agent: IAgent): Promise<string> {
  const runHistory = agent.toolContext.runHistory;
  const config = agent.toolContext.userConfig;
  if (!runHistory || !config) {
    return 'Error: Workflow capture not available. Run history is not initialized.';
  }

  const runId = agent.currentRunId;
  if (!runId) {
    return 'Error: No active run. save_workflow can only capture work during a session.';
  }

  // Provider config: prefer the live agent snapshot over loadConfig() so a
  // UI provider-switch on managed-tier isn't masked by stale config.json
  // (same gap PR #568 closed for sub-agent spawn). Defensive typeof-check
  // tolerates IAgent mocks/older test helpers that don't implement
  // getProviderConfig — falls back to userConfig in that path.
  const parentProv: ProviderConfigSnapshot | null =
    typeof (agent as { getProviderConfig?: unknown }).getProviderConfig === 'function'
      ? (agent as { getProviderConfig: () => ProviderConfigSnapshot }).getProviderConfig()
      : null;

  const apiKey = parentProv?.apiKey ?? config.api_key;
  if (!apiKey) {
    return 'Error: API key not configured. Required for workflow analysis.';
  }
  const provider = parentProv?.provider ?? config.provider;
  const apiBaseURL = parentProv?.apiBaseURL ?? config.api_base_url;
  const openaiModelId = parentProv?.openaiModelId ?? config.openai_model_id;
  const openaiAuth = parentProv?.openaiAuth;

  // A conversation spans many runs (one per turn); `agent.currentRunId` is the
  // run executing save_workflow itself, which holds no prior workflow tool
  // calls. Resolve the owning session and gather its full tool-call history so
  // the capture sees the actual work the user just did. Prefer the thread id;
  // fall back to the run's session_id; fall back to single-run scope if neither
  // resolves (an empty-string session_id, the column default, is unresolved).
  const sessionId = agent.currentThreadId
    || runHistory.getRun(runId)?.session_id
    || undefined;
  const toolCalls = sessionId
    ? runHistory.getSessionToolCalls(sessionId)
    : runHistory.getRunToolCalls(runId);
  if (toolCalls.length === 0) {
    return 'No tool calls found in this session. Nothing to save as a workflow.';
  }

  // --- Phase 1: Haiku extraction (the only failure-prone, retryable step) ---
  let record: ProcessRecord;
  try {
    record = await captureProcess(runId, input.name, toolCalls, {
      apiKey,
      apiBaseURL,
      provider,
      openaiModelId,
      openaiAuth,
      description: input.description,
    });
  } catch (err) {
    logErrorChain('save_workflow:extract', err);
    // Nothing has been persisted yet — safe to retry.
    return `Error: Workflow extraction failed (${getErrorMessage(err)}). No workflow was saved. This is a transient analysis failure — call save_workflow again to retry.`;
  }

  // --- Phase 2: build the reusable pipeline from the extracted steps ---
  const pipelineSteps = processToSteps(record);
  if (pipelineSteps.length === 0) {
    // No partial state written yet — bail before touching storage.
    return 'No actionable steps were found in this session. Nothing to save as a workflow.';
  }

  try {
    const pipelineId = randomUUID();
    const historicalAvg = runHistory.getAvgStepCostByModelTier(30);
    const costEstimate = estimatePipelineCost(pipelineSteps, historicalAvg);

    const planned: PlannedPipeline = {
      id: pipelineId,
      name: record.name,
      goal: record.description || record.name,
      steps: pipelineSteps,
      reasoning: `Saved from session ${runId}`,
      estimatedCost: costEstimate.totalCostUsd,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'orchestrated',
      template: true, // Saved workflows are always reusable templates.
      // Captured sessions don't carry ask_user/ask_secret today; infer the
      // interaction mode by step inspection so the contract stays honest.
      mode: inferPipelineMode(pipelineSteps),
    };

    // Save-time gate — same as plan_task.
    assertPlannedPipelineIsValid(planned);

    // Commit: the in-memory store + the pipeline_runs row (status='planned')
    // so the Saved Workflows library (which reads SQLite) finds it, then the
    // ProcessRecord for lineage/audit (D11 — internal, never agent-facing).
    // Stamping the promotion link last keeps the ProcessRecord consistent
    // with the pipeline that exists.
    storePipeline(pipelineId, planned);
    runHistory.insertPlannedPipeline(planned);
    record.promotedToPipelineId = pipelineId;
    runHistory.insertProcess(record);

    const paramNames = record.parameters.map(p => p.name);
    return JSON.stringify({
      workflow_id: pipelineId,
      name: record.name,
      steps: pipelineSteps.length,
      parameters: paramNames,
      estimated_cost: `$${costEstimate.totalCostUsd.toFixed(4)}`,
      source: 'session',
      next: `Call run_workflow with workflow_id "${pipelineId}" to run this workflow. It is saved and reusable.`,
    }, null, 2);
  } catch (err) {
    logErrorChain('save_workflow:promote', err);
    return `Error: Could not save the workflow (${getErrorMessage(err)}). No workflow was saved.`;
  }
}

export const saveWorkflowTool: ToolEntry<SaveWorkflowInput> = {
  definition: {
    name: 'save_workflow',
    description:
      'Save a multi-step procedure as a reusable workflow in one call. ' +
      'Omit workflow_id to save the work you just completed in this session ' +
      '(the actual tool steps are analysed automatically). Pass workflow_id ' +
      'to turn an existing plan_task plan into a reusable workflow. ' +
      'Returns a workflow_id you can pass to run_workflow or task_create.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for this workflow (e.g., "Monthly Ad Report")' },
        description: { type: 'string', description: 'Brief description of what this workflow does' },
        workflow_id: {
          type: 'string',
          description: 'Optional. An existing plan_task workflow_id to make reusable. Omit to save this session\'s work.',
        },
      },
      required: ['name'],
    },
  },
  handler: async (input: SaveWorkflowInput, agent: IAgent): Promise<string> => {
    try {
      if (input.workflow_id) {
        return promoteExistingWorkflow(input, agent);
      }
      return await saveSessionWorkflow(input, agent);
    } catch (err) {
      logErrorChain('save_workflow', err);
      return `Error saving workflow: ${getErrorMessage(err)}`;
    }
  },
};
