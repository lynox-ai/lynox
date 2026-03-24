import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MODEL_MAP } from '../types/index.js';
import type { ModelTier, NodynUserConfig, PreApprovalPattern, PreApprovalSet, ToolEntry } from '../types/index.js';
import { calculateCost } from '../core/pricing.js';
import { checkSessionBudget, adjustSessionCost } from '../core/session-budget.js';
import { buildApprovalSet } from '../core/pre-approve.js';
import { loadAgentDef } from './agent-registry.js';
import { buildStepContext, resolveTaskTemplate } from './context.js';
import { shouldRunStep, buildConditionContext } from './conditions.js';
import { spawnViaAgent, spawnMock, spawnInline, spawnPipeline } from './runtime-adapter.js';
import { computePhases } from './graph.js';
import { channels } from '../core/observability.js';
import type { Manifest, RunState, RunHooks, GateAdapter, AgentOutput, ManifestStep } from './types.js';
import { GateRejectedError, GateExpiredError } from './types.js';
import type { RunHistory } from '../core/run-history.js';

export { loadManifestFile, validateManifest } from './validate.js';

export interface RunManifestOptions {
  agentsDir?: string | undefined;
  gateAdapter?: GateAdapter | undefined;
  hooks?: RunHooks | undefined;
  mockResponses?: Map<string, string> | undefined;
  parentTools?: ToolEntry[] | undefined;
  cachedOutputs?: Map<string, AgentOutput> | undefined;
  depth?: number | undefined;
  runHistory?: RunHistory | undefined;
  parentRunId?: string | undefined;
  autonomy?: import('../types/index.js').AutonomyLevel | undefined;
}

const MAX_PIPELINE_DEPTH = 3;

function getExecutionMode(m: Manifest): 'sequential' | 'parallel' {
  if (m.manifest_version === '1.0') return 'sequential';
  return m.execution ?? 'parallel';
}

export async function runManifest(
  manifest: Manifest,
  config: NodynUserConfig,
  options: RunManifestOptions = {},
): Promise<RunState> {
  const depth = options.depth ?? 0;
  if (depth > MAX_PIPELINE_DEPTH) {
    throw new Error(`Pipeline nesting exceeds max depth (${MAX_PIPELINE_DEPTH})`);
  }

  const runId = randomUUID();
  const agentsDir = options.agentsDir ?? config.agents_dir ?? join(process.cwd(), 'agents');

  const state: RunState = {
    runId,
    manifestName: manifest.name,
    startedAt: new Date().toISOString(),
    status: 'running',
    globalContext: { ...manifest.context, _manifestName: manifest.name },
    outputs: new Map(),
  };

  // Pre-populate cached outputs for retry
  if (options.cachedOutputs) {
    for (const [id, output] of options.cachedOutputs) {
      state.outputs.set(id, output);
    }
  }

  const mode = getExecutionMode(manifest);
  if (mode === 'parallel') {
    await runParallel(manifest, state, config, agentsDir, options);
  } else {
    await runSequential(manifest, state, config, agentsDir, options);
  }

  if (state.status === 'running') {
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
  }
  options.hooks?.onRunComplete?.(state);
  return state;
}

/**
 * Retry a manifest: re-execute failed/skipped steps, skip completed ones.
 */
export async function retryManifest(
  manifest: Manifest,
  previousState: RunState,
  config: NodynUserConfig,
  options: RunManifestOptions = {},
): Promise<RunState> {
  const cachedOutputs = new Map<string, AgentOutput>();
  for (const [id, output] of previousState.outputs) {
    // Cache only successfully completed steps (not skipped, no error)
    if (!output.skipped && !output.error) {
      cachedOutputs.set(id, output);
    }
  }

  return runManifest(manifest, config, {
    ...options,
    cachedOutputs,
  });
}

// --- Sequential execution (v1.0 behavior, zero behavior change) ---

async function runSequential(
  manifest: Manifest,
  state: RunState,
  config: NodynUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
): Promise<void> {
  for (const step of manifest.agents) {
    const result = await executeStep(step, manifest, state, config, agentsDir, options);
    if (result === 'halt') return;
  }
}

// --- Parallel phase-based execution (v1.1) ---

async function runParallel(
  manifest: Manifest,
  state: RunState,
  config: NodynUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
): Promise<void> {
  const { phases } = computePhases(manifest.agents);
  const stepsById = new Map(manifest.agents.map(s => [s.id, s]));

  for (const phase of phases) {
    options.hooks?.onPhaseStart?.(phase.phaseIndex, phase.stepIds);

    const promises = phase.stepIds.map(async (stepId) => {
      const step = stepsById.get(stepId)!;
      return executeStep(step, manifest, state, config, agentsDir, options);
    });

    const settled = await Promise.allSettled(promises);

    options.hooks?.onPhaseComplete?.(phase.phaseIndex);

    // Check for halts (gate rejections or on_failure=stop errors)
    let shouldHalt = false;
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value === 'halt') {
        shouldHalt = true;
      }
      if (s.status === 'rejected') {
        // Unexpected — executeStep catches all errors internally
        shouldHalt = true;
      }
    }
    if (shouldHalt) return;
  }
}

// --- Single step execution (shared by both paths) ---

type StepResult = 'ok' | 'halt';

async function executeStep(
  step: ManifestStep,
  manifest: Manifest,
  state: RunState,
  config: NodynUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
): Promise<StepResult> {
  // Check cached outputs for retry (skip already-completed steps)
  if (options.cachedOutputs?.has(step.id)) {
    const cached = options.cachedOutputs.get(step.id)!;
    state.outputs.set(step.id, cached);
    options.hooks?.onStepRetrySkipped?.(step.id);
    return 'ok';
  }

  const stepStart = new Date().toISOString();

  try {
    const stepContext = buildStepContext(state.globalContext, step, state.outputs, config.pipeline_context_limit);

    // Use buildConditionContext for condition evaluation (includes ALL completed outputs)
    const condContext = buildConditionContext(state.globalContext, state.outputs);

    if (!shouldRunStep(condContext, step.conditions)) {
      state.outputs.set(step.id, makeSkipped(step.id, 'conditions not met'));
      options.hooks?.onStepSkipped?.(step.id, 'conditions not met');
      return 'ok';
    }

    options.hooks?.onStepStart?.(step.id, step.agent);

    let r: { result: string; tokensIn: number; tokensOut: number; durationMs: number };
    let costUsd = 0;

    // Build per-step pre-approval set if configured
    let stepPreApproval: PreApprovalSet | undefined;
    if (step.pre_approve?.length) {
      const patterns: PreApprovalPattern[] = step.pre_approve.map(p => ({
        tool: p.tool,
        pattern: p.pattern,
        label: `${p.tool}: ${p.pattern}`,
        risk: p.risk ?? 'medium',
      }));
      stepPreApproval = buildApprovalSet(patterns, {
        taskSummary: `DAG step: ${step.id}`,
      });
    }

    if (options.mockResponses !== undefined || step.runtime === 'mock') {
      r = await spawnMock(step, options.mockResponses ?? new Map());
    } else if (step.runtime === 'pipeline') {
      r = await spawnPipeline(step, stepContext, config, options.parentTools ?? [], options.depth ?? 0);
      costUsd = 0; // Cost comes from sub-pipeline steps (tracked individually)
    } else if (step.runtime === 'inline') {
      if (!options.parentTools) {
        throw new Error(`Step "${step.id}" uses inline runtime but no parentTools provided`);
      }
      // Resolve task templates before execution
      const resolvedTask = step.task ? resolveTaskTemplate(step.task, stepContext) : step.task;
      const resolvedStep = resolvedTask !== step.task ? { ...step, task: resolvedTask } : step;
      // Check session budget before spawning step agent
      const stepModel = resolveModelForCost(step, 'sonnet');
      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepEstimate);
      r = await spawnInline(resolvedStep, stepContext, config, options.parentTools, stepPreApproval, options.autonomy);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(costUsd - stepEstimate); // correct estimate to actual
    } else {
      const agentDef = await loadAgentDef(step.agent, agentsDir);
      // Check session budget before spawning step agent
      const stepModel = resolveModelForCost(step, agentDef.defaultTier);
      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepEstimate);
      r = await spawnViaAgent(step, agentDef, stepContext, config, options.gateAdapter, state.runId, stepPreApproval, options.autonomy);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(costUsd - stepEstimate); // correct estimate to actual
    }

    // Gate point check after step completes (real and mock paths)
    if (manifest.gate_points.includes(step.id) && options.gateAdapter) {
      const gateContext = {
        ...buildStepContext(state.globalContext, step, state.outputs, config.pipeline_context_limit),
        [step.id]: { result: r.result, costUsd },
      };
      const approvalId = await options.gateAdapter.submit({
        manifestName: manifest.name,
        stepId: step.id,
        agentName: step.agent,
        context: gateContext,
        runId: state.runId,
      });
      options.hooks?.onGateSubmit?.(step.id, approvalId);
      const decision = await options.gateAdapter.waitForDecision(approvalId);
      options.hooks?.onGateDecision?.(step.id, decision);
      if (decision.status === 'rejected') throw new GateRejectedError(step.id, decision.reason);
      if (decision.status === 'timeout') throw new GateExpiredError(step.id);
    }

    const output: AgentOutput = {
      stepId: step.id,
      result: r.result,
      startedAt: stepStart,
      completedAt: new Date().toISOString(),
      durationMs: r.durationMs,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costUsd,
      skipped: false,
    };
    state.outputs.set(step.id, output);
    options.hooks?.onStepComplete?.(output);
    return 'ok';

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    options.hooks?.onError?.(step.id, error);

    if (err instanceof GateRejectedError || err instanceof GateExpiredError) {
      state.status = 'rejected';
      state.error = error.message;
      state.completedAt = new Date().toISOString();
      return 'halt';
    }

    if (manifest.on_failure === 'stop') {
      state.status = 'failed';
      state.error = error.message;
      state.completedAt = new Date().toISOString();
      return 'halt';
    }

    // Record error in output, continue to next step
    state.outputs.set(step.id, {
      stepId: step.id,
      result: '',
      startedAt: stepStart,
      completedAt: new Date().toISOString(),
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      skipped: false,
      error: error.message,
    });

    // 'notify' = continue + notification
    if (manifest.on_failure === 'notify') {
      options.hooks?.onStepNotify?.(step.id, error);
      channels.dagNotify.publish({
        runId: state.runId, stepId: step.id, agentName: step.agent,
        manifestName: manifest.name, error: error.message,
      });
    }
    return 'ok';
  }
}

function makeSkipped(stepId: string, reason: string): AgentOutput {
  const now = new Date().toISOString();
  return {
    stepId, result: '', startedAt: now, completedAt: now,
    durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
    skipped: true, skipReason: reason,
  };
}

function resolveModelForCost(step: ManifestStep, defaultTier: ModelTier): string {
  if (!step.model) return MODEL_MAP[defaultTier];
  return step.model in MODEL_MAP ? MODEL_MAP[step.model as ModelTier] : step.model;
}
