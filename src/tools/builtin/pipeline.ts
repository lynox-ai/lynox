import type { ToolEntry, LynoxUserConfig, InlinePipelineStep, PipelineResult, PipelineStepResult, PlannedPipeline, StreamHandler } from '../../types/index.js';
import { validateManifest, MAX_STEPS } from '../../orchestrator/validate.js';
import { runManifest, retryManifest } from '../../orchestrator/runner.js';
import { estimatePipelineCost } from '../../core/dag-planner.js';
import type { Manifest, AgentOutput, RunState, RunHooks } from '../../types/orchestration.js';
import type { RunHistory } from '../../core/run-history.js';
import { getErrorMessage } from '../../core/utils.js';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import type { SubAgentPromptHandles } from '../../orchestrator/runtime-adapter.js';
import type { ToolContext } from '../../core/tool-context.js';
import type { IMemory } from '../../types/memory.js';

const DEFAULT_RESULT_BYTES = 20_480; // 20KB per step result
const MAX_PLANS = 10;

// Pipeline config accessed via agent.toolContext (userConfig, tools, streamHandler, runHistory)

// In-memory store for planned pipelines (session-scoped)
const pipelineStore = new Map<string, PlannedPipeline>();

// Store last executed state per pipeline for retry
const executedStates = new Map<string, { manifest: Manifest; state: RunState }>();

/** Track pipeline IDs we've already warned about during legacy-mode migration. */
const warnedLegacyIds = new Set<string>();
const WARNED_LEGACY_MAX = 1024;

/**
 * Backfill defaults on a (possibly-legacy) PlannedPipeline read from disk.
 * Mutates and returns the input.
 */
function backfillPlannedPipelineDefaults(planned: PlannedPipeline): PlannedPipeline {
  planned.executionMode ??= 'orchestrated';
  planned.template ??= false;
  if (planned.mode === undefined) {
    planned.mode = inferPipelineMode(planned.steps);
    if (planned.mode === 'interactive' && !warnedLegacyIds.has(planned.id)) {
      // Bound the dedup set so a long-lived process can't grow it without
      // bound on environments with many distinct legacy pipelines.
      if (warnedLegacyIds.size >= WARNED_LEGACY_MAX) warnedLegacyIds.clear();
      warnedLegacyIds.add(planned.id);
      // One-shot warn: legacy pipeline that references ask_user_* tools
      // is auto-labelled interactive; warn so operators flip ones that
      // were meant for cron.
      console.warn(
        `[pipeline] legacy pipeline "${planned.id}" auto-labelled mode='interactive' ` +
        `because it references human-in-the-loop tools. ` +
        `If this was intended for cron/scheduled runs, remove the ask_user step or it will fail at execution.`,
      );
    }
  }
  return planned;
}

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
        backfillPlannedPipelineDefaults(planned);
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

/**
 * Drop a pipeline from the in-memory cache. The Saved-Workflows library
 * (PRD §6.8) deletes/renames the SQLite row directly; without evicting the
 * cache, a later `getPipeline` could resurrect a stale copy (a deleted
 * workflow staying runnable, a rename not reflected). Supports prefix match
 * so a short id evicts the full-id entry too.
 */
export function forgetPipeline(id: string): void {
  if (pipelineStore.delete(id)) return;
  for (const key of pipelineStore.keys()) {
    if (key.startsWith(id)) { pipelineStore.delete(key); return; }
  }
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
      effort: s.effort,
      thinking: s.thinking,
      input_from: s.input_from,
      timeout_ms: s.timeout_ms,
    })),
    gate_points: [],
    on_failure: onFailure,
  };
}

/** Max characters for the per-step summary surfaced on the live checklist. */
const STEP_SUMMARY_MAX = 160;

/**
 * Condense a step's raw output into a one-line summary for the live progress
 * checklist. Collapses whitespace, takes the first non-empty line, and caps
 * the length — the structured checklist widget is the single progress surface
 * (D9), so this carries what the removed `step_complete` narration used to.
 *
 * Exported for unit testing (`_` prefix marks it test-only, like
 * `_resetPipelineStore`).
 */
export function _summarizeStepOutput(result: string): string {
  const firstLine = result
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= STEP_SUMMARY_MAX) return collapsed;
  return `${collapsed.slice(0, STEP_SUMMARY_MAX - 1)}…`;
}

function buildProgressHooks(pipelineStreamHandler: StreamHandler | null, manifest?: Manifest): RunHooks {
  const handler = pipelineStreamHandler;
  if (!handler) return {};

  const HEARTBEAT_INTERVAL = 15_000;
  const heartbeats = new Map<string, { timer: ReturnType<typeof setInterval>; startedAt: number }>();

  const startHeartbeat = (stepId: string): void => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      void handler({
        type: 'pipeline_progress', stepId, status: 'started',
        detail: `running`, elapsed, agent: 'pipeline',
      });
    }, HEARTBEAT_INTERVAL);
    heartbeats.set(stepId, { timer, startedAt });
  };

  const stopHeartbeat = (stepId: string): void => {
    const hb = heartbeats.get(stepId);
    if (hb) {
      clearInterval(hb.timer);
      heartbeats.delete(stepId);
    }
  };

  return {
    onRunStart: () => {
      if (!manifest) return;
      void handler({
        type: 'pipeline_start',
        pipelineId: manifest.name,
        name: manifest.name,
        steps: manifest.agents.map(a => ({
          id: a.id,
          task: a.task ?? a.id,
          inputFrom: a.input_from,
        })),
        agent: 'pipeline',
      });
    },
    onPhaseStart: (_phaseIndex: number, _stepIds: string[]) => {
      // Phase info is derived from manifest structure in the UI
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
        durationMs: output.durationMs,
        // Per-step summary for the live checklist (R1) — a one-line condensation
        // of the step's output. Replaces the inline narration the removed
        // `step_complete` tool used to echo into the message stream.
        summary: _summarizeStepOutput(output.result),
        agent: 'pipeline',
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
  // Build step-id → model-tier lookup from manifest
  const stepModelMap = new Map<string, string>();
  for (const step of manifest.agents) {
    stepModelMap.set(step.id, step.model ?? 'balanced');
  }
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
        modelTier: stepModelMap.get(output.stepId) ?? '',
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
    return 'Error: Workflow must have at least one step.';
  }
  if (steps.length > MAX_STEPS) {
    return `Error: Workflow exceeds maximum of ${MAX_STEPS} steps (got ${steps.length}).`;
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

    const historicalAvg = deps.runHistory?.getAvgStepCostByModelTier(30);
    const costEstimate = estimatePipelineCost(steps, historicalAvg);
    if (deps.streamHandler) {
      void deps.streamHandler({
        type: 'pipeline_progress', stepId: 'cost-estimate', status: 'started',
        detail: `${steps.length} steps, estimated cost: $${costEstimate.totalCostUsd.toFixed(4)}`,
        agent: 'pipeline',
      });
    }

    const hooks = buildProgressHooks(deps.streamHandler, manifest);
    const state = await runManifest(manifest, deps.config, {
      parentTools: deps.tools,
      parentToolContext: deps.toolContext,
      hooks,
      runHistory: deps.runHistory ?? undefined,
      parentPrompt: deps.parentPrompt,
      userTimezone: deps.userTimezone,
      parentSessionCounters: deps.sessionCounters,
      parentMemory: deps.memory ?? null,
    });

    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    return formatResult(state, input.name ?? 'inline-pipeline', resultLimit);
  } catch (err: unknown) {
    return `Error: Workflow execution failed: ${getErrorMessage(err)}`;
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

export interface PipelineDeps {
  config: LynoxUserConfig;
  tools: ToolEntry[];
  streamHandler: StreamHandler | null;
  runHistory: RunHistory | null;
  toolContext?: ToolContext | undefined;
  parentPrompt?: SubAgentPromptHandles | undefined;
  userTimezone?: string | undefined;
  /**
   * Parent Session's counters object — threaded into runManifest so step
   * cost shares the same per-Session budget as the calling agent + its
   * spawns. Absent when the pipeline tool is exercised outside a real
   * Session (e.g. unit tests); runManifest then allocates a fresh
   * counters object.
   */
  sessionCounters?: import('../../types/agent.js').SessionCounters | undefined;
  /**
   * Parent agent's memory backend. Threaded down to sub-agent constructors
   * (`spawnInline` / `spawnPipeline`) so workflow sub-steps can call
   * `memory_recall` / `memory_store` / `memory_update` / `memory_list` —
   * without this, those tool handlers find `agent.memory == null` and
   * short-circuit with "Memory is not configured for this agent." (caught
   * live on 2026-05-23 after PR #548 added the tools to INLINE_CORE_TOOLS
   * but left the backend unwired). Absent for headless callers (worker-loop
   * scheduled pipelines, unit tests) — those sub-agents simply degrade to
   * the same "not configured" path the parent saw.
   */
  memory?: IMemory | null | undefined;
}

/**
 * Run a stored pipeline through the orchestrated runner (`runManifest`) — the
 * exact isolation path `executePipelineById` uses (one fresh sub-agent per
 * step, per-step `model` honored via `resolveModelForCost`). Exported so the
 * O7 auto-trigger in `plan_task` can dispatch eligible plans straight to the
 * orchestrated runner instead of running them inline on the main loop.
 *
 * Returns the formatted `PipelineResult` JSON, or an `Error: ...` string.
 */
export async function dispatchOrchestratedPipeline(
  planned: PlannedPipeline,
  deps: PipelineDeps,
): Promise<string> {
  // Interactive pipelines need a live prompt-capable session — mirror the
  // executePipelineById guard so the dispatch fails fast with a clear error
  // rather than throwing "ask_user is not set" deep inside a step.
  if (planned.mode === 'interactive' && !deps.parentPrompt?.parentPromptUser) {
    return `Error: Workflow "${planned.id}" is interactive (uses ask_user / ask_secret) and requires a live chat session. Invoke it from a chat instead of a headless context.`;
  }

  // Saved workflows (`template:true`) are reusable by definition — never
  // mark them executed (T2-W1). Without this guard, dispatching a saved
  // template through the orchestrated runner consumed the template after
  // the first run.
  const isTemplate = planned.template === true;

  if (!isTemplate && planned.executed) {
    return `Error: Workflow "${planned.id}" has already been executed.`;
  }

  const resultLimit = deps.config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;
  const steps: InlinePipelineStep[] = planned.steps.map(s => ({ ...s }));

  if (steps.length === 0) {
    return 'Error: Workflow has no steps to execute.';
  }
  if (steps.length > MAX_STEPS) {
    return `Error: Workflow exceeds maximum of ${MAX_STEPS} steps.`;
  }

  try {
    const manifest = buildManifest(planned.name, steps, 'stop');
    validateManifest(manifest);
    if (!isTemplate) planned.executed = true;

    const hooks = buildProgressHooks(deps.streamHandler, manifest);
    const state = await runManifest(manifest, deps.config, {
      parentTools: deps.tools,
      parentToolContext: deps.toolContext,
      hooks,
      runHistory: deps.runHistory ?? undefined,
      parentPrompt: deps.parentPrompt,
      userTimezone: deps.userTimezone,
      parentSessionCounters: deps.sessionCounters,
      parentMemory: deps.memory ?? null,
    });

    executedStates.set(planned.id, { manifest, state });
    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    if (!isTemplate) {
      try { deps.runHistory?.markPipelineExecuted(planned.id); } catch { /* fire-and-forget */ }
    }

    return formatResult(state, planned.name, resultLimit);
  } catch (err: unknown) {
    if (!isTemplate) planned.executed = false; // Allow retry on validation errors
    return `Error: Workflow execution failed: ${getErrorMessage(err)}`;
  }
}

/** Outcome of a Saved-Workflows-library "Run" action. */
export interface RunSavedWorkflowResult {
  ok: boolean;
  /** ID of the fresh `pipeline_runs` row written for this execution. */
  runId?: string | undefined;
  status?: string | undefined;
  error?: string | undefined;
  /** Total USD cost of the run, so a caller can report it to the managed
   *  credit hook (onAfterRun) — the pipeline path otherwise bypasses billing. */
  costUsd?: number | undefined;
}

/**
 * Run a *saved workflow* (a `PlannedPipeline` with `template:true`) headless,
 * for the Saved-Workflows library UI's "Run" action (PRD §6.8 / D13).
 *
 * Unlike `executePipelineById` / `dispatchOrchestratedPipeline`, this never
 * consumes the template: a saved workflow is reusable by definition, so the
 * stored row is left untouched and a *fresh* `pipeline_runs` row (the
 * orchestrated run's `state.runId`) is written for every invocation. The
 * library "Run" is fire-once per click; live progress streaming is a chat
 * concern, so no `streamHandler` is wired.
 *
 * Interactive saved workflows are refused — they need a live chat session.
 */
export async function runSavedWorkflow(
  workflowId: string,
  runHistory: RunHistory | null,
  config: LynoxUserConfig,
): Promise<RunSavedWorkflowResult> {
  if (!runHistory) {
    return { ok: false, error: 'Run history is not available.' };
  }

  const planned = getPipeline(workflowId, runHistory);
  if (!planned) {
    return { ok: false, error: `Workflow "${workflowId}" not found.` };
  }
  if (!planned.template) {
    return { ok: false, error: `Workflow "${planned.id}" is not a saved workflow.` };
  }
  if (planned.mode === 'interactive') {
    return {
      ok: false,
      error: `Workflow "${planned.id}" is interactive (uses ask_user / ask_secret) and must be run from a chat session.`,
    };
  }

  const steps: InlinePipelineStep[] = planned.steps.map(s => ({ ...s }));
  if (steps.length === 0) {
    return { ok: false, error: 'Workflow has no steps to execute.' };
  }
  if (steps.length > MAX_STEPS) {
    return { ok: false, error: `Workflow exceeds maximum of ${MAX_STEPS} steps.` };
  }

  const resultLimit = config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;
  try {
    const manifest = buildManifest(planned.name, steps, 'stop');
    validateManifest(manifest);
    const state = await runManifest(manifest, config, { runHistory });
    persistPipelineRun(state, manifest, runHistory, resultLimit);
    const costUsd = [...state.outputs.values()].reduce((s, o) => s + o.costUsd, 0);
    return { ok: true, runId: state.runId, status: state.status, costUsd };
  } catch (err: unknown) {
    return { ok: false, error: `Workflow execution failed: ${getErrorMessage(err)}` };
  }
}

async function executePipelineById(input: RunPipelineInput, deps: PipelineDeps): Promise<string> {
  const planned = getPipeline(input.workflow_id!, deps.runHistory);
  if (!planned) {
    return `Error: Workflow "${input.workflow_id}" not found.`;
  }

  // Interactive pipelines need a live prompt-capable session. Refuse with a
  // clear error rather than running steps that will throw "ask_user is not
  // set" deep in the run.
  if (planned.mode === 'interactive' && !deps.parentPrompt?.parentPromptUser) {
    return `Error: Workflow "${planned.id}" is interactive (uses ask_user / ask_secret) and requires a live chat session. Invoke it from a chat instead of a headless context.`;
  }

  const resultLimit = deps.config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;

  // Retry mode
  if (input.retry) {
    const prev = executedStates.get(planned.id);
    if (!prev) {
      return `Error: No previous execution found for pipeline "${planned.id}". Execute it first before retrying.`;
    }

    try {
      const hooks = buildProgressHooks(deps.streamHandler, prev.manifest);
      const state = await retryManifest(prev.manifest, prev.state, deps.config, {
        parentTools: deps.tools,
        hooks,
        runHistory: deps.runHistory ?? undefined,
        parentPrompt: deps.parentPrompt,
        parentSessionCounters: deps.sessionCounters,
        parentMemory: deps.memory ?? null,
      });

      executedStates.set(planned.id, { manifest: prev.manifest, state });
      persistPipelineRun(state, prev.manifest, deps.runHistory, resultLimit);
      return formatResult(state, planned.name, resultLimit);
    } catch (err: unknown) {
      return `Error: Workflow retry failed: ${getErrorMessage(err)}`;
    }
  }

  // Saved workflows (`template:true`) are reusable by definition — skip the
  // executed-guard, the executed=true write, and the markPipelineExecuted
  // call (T2-W1). Mirrors the guard `runSavedWorkflow` already enforces.
  const isTemplate = planned.template === true;

  if (!isTemplate && planned.executed) {
    return `Error: Workflow "${planned.id}" has already been executed.`;
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
    return `Error: Workflow exceeds maximum of ${MAX_STEPS} steps.`;
  }

  try {
    const manifest = buildManifest(
      planned.name,
      steps,
      input.on_failure ?? 'stop',
    );

    validateManifest(manifest);
    if (!isTemplate) planned.executed = true;

    const hooks = buildProgressHooks(deps.streamHandler, manifest);
    const state = await runManifest(manifest, deps.config, {
      parentTools: deps.tools,
      parentToolContext: deps.toolContext,
      hooks,
      runHistory: deps.runHistory ?? undefined,
      parentPrompt: deps.parentPrompt,
      userTimezone: deps.userTimezone,
      parentSessionCounters: deps.sessionCounters,
      parentMemory: deps.memory ?? null,
    });

    executedStates.set(planned.id, { manifest, state });
    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    if (!isTemplate) {
      try { deps.runHistory?.markPipelineExecuted(planned.id); } catch { /* fire-and-forget */ }
    }

    return formatResult(state, planned.name, resultLimit);
  } catch (err: unknown) {
    if (!isTemplate) planned.executed = false; // Allow retry on validation errors
    return `Error: Workflow execution failed: ${getErrorMessage(err)}`;
  }
}

// ===== run_workflow =====

interface RunPipelineInput {
  name?: string | undefined;
  steps?: InlinePipelineStep[] | undefined;
  workflow_id?: string | undefined;
  on_failure?: 'stop' | 'continue' | 'notify' | undefined;
  context?: Record<string, unknown> | undefined;
  retry?: boolean | undefined;
  modifications?: StepModification[] | undefined;
}

export const runWorkflowTool: ToolEntry<RunPipelineInput> = {
  definition: {
    name: 'run_workflow',
    description:
      'Execute a multi-step workflow. Provide steps[] for inline execution, or workflow_id to run a stored workflow. ' +
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
        workflow_id: {
          type: 'string',
          description: 'ID of a stored workflow to execute (from plan_task or save_workflow)',
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
          description: 'If true, skip completed steps and re-execute only failed/skipped ones (requires workflow_id)',
        },
        modifications: {
          type: 'array',
          description: 'Modify steps before execution (requires workflow_id)',
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
    const rawPipelineConfig = agent.toolContext.userConfig;
    const pipelineTools = agent.toolContext.tools;
    const pipelineStreamHandler = agent.toolContext.streamHandler;
    const pipelineRunHistory = agent.toolContext.runHistory;
    if (!rawPipelineConfig) {
      return 'Error: Workflow config not initialized. Workflow tools are not available.';
    }

    // H-011: prefer fresh getProviderConfig() snapshot over stale userConfig.
    // toolContext.userConfig is captured at engine init and goes stale after a
    // runtime provider-switch (reloadUserConfig); the snapshot accessor reflects
    // the post-switch state. Sub-steps run via runManifest -> runtime-adapter
    // read config.{api_key,api_base_url,provider,openai_model_id}, so we shape
    // a fresh overlay. Tolerate legacy mocks without getProviderConfig via
    // typeof-check + fall back to userConfig. Pattern recidivism of #568/#570/#571.
    const pipelineProv = typeof (agent as { getProviderConfig?: unknown }).getProviderConfig === 'function'
      ? (agent as { getProviderConfig: () => import('../../types/agent.js').ProviderConfigSnapshot }).getProviderConfig()
      : null;
    const pipelineConfig: LynoxUserConfig = pipelineProv
      ? {
          ...rawPipelineConfig,
          api_key: pipelineProv.apiKey ?? rawPipelineConfig.api_key,
          api_base_url: pipelineProv.apiBaseURL ?? rawPipelineConfig.api_base_url,
          provider: pipelineProv.provider ?? rawPipelineConfig.provider,
          openai_model_id: pipelineProv.openaiModelId ?? rawPipelineConfig.openai_model_id,
        }
      : rawPipelineConfig;

    if (pipelineTools.length === 0) {
      return 'Error: No parent tools available for inline pipeline steps.';
    }

    if (input.steps && input.workflow_id) {
      return 'Error: Provide either steps[] or workflow_id, not both.';
    }

    if (!input.steps && !input.workflow_id) {
      return 'Error: Provide steps[] for inline execution or workflow_id for a stored workflow.';
    }

    const pipelineToolContext = agent.toolContext;

    // run_workflow is always called from a chat session; inherit the parent
    // agent's prompt callbacks so sub-agents can route ask_user/ask_secret
    // back through the live SSE stream. Stored autonomous pipelines that
    // somehow get invoked here will still be rejected at executePipelineById
    // / WorkerLoop boundaries; for inline runs the contract is "always
    // interactive" by definition.
    const parentPrompt = (agent.promptUser || agent.promptTabs || agent.promptSecret)
      ? {
          parentPromptUser: agent.promptUser,
          parentPromptTabs: agent.promptTabs,
          parentPromptSecret: agent.promptSecret,
        }
      : undefined;

    if (input.workflow_id) {
      return executePipelineById(input, {
        config: pipelineConfig,
        tools: pipelineTools,
        streamHandler: pipelineStreamHandler,
        runHistory: pipelineRunHistory,
        toolContext: pipelineToolContext,
        parentPrompt,
        userTimezone: agent.userTimezone,
        sessionCounters: agent.sessionCounters,
        memory: agent.memory,
      });
    }

    return executeInlineSteps(input, {
        config: pipelineConfig,
        tools: pipelineTools,
        streamHandler: pipelineStreamHandler,
        sessionCounters: agent.sessionCounters,
        runHistory: pipelineRunHistory,
        toolContext: pipelineToolContext,
        parentPrompt,
        userTimezone: agent.userTimezone,
        memory: agent.memory,
      });
  },
};

/** Reset pipeline store — for testing only */
export function _resetPipelineStore(): void {
  pipelineStore.clear();
  executedStates.clear();
  warnedLegacyIds.clear();
}
