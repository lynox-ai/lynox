import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ModelTier, LynoxUserConfig, PreApprovalPattern, PreApprovalSet, ToolEntry, CapabilityContract, WorkflowLimits, SecretStoreLike } from '../types/index.js';
import { getActiveProvider } from '../core/llm-client.js';
import { resolveRunModel } from '../core/tier-resolver.js';
import { calculateCost } from '../core/pricing.js';
import { checkSessionBudget, adjustSessionCost } from '../core/session-budget.js';
import type { SessionCounters } from '../types/agent.js';
import type { IMemory } from '../types/memory.js';
import { buildApprovalSet } from '../core/pre-approve.js';
import { loadAgentDef } from './agent-registry.js';
import { buildStepContext, resolveTaskTemplate, resolveInputTemplate } from './context.js';
import { shouldRunStep, buildConditionContext } from './conditions.js';
import { spawnViaAgent, spawnMock, spawnInline, spawnPipeline, type SubAgentPromptHandles, type StepToolRecorder } from './runtime-adapter.js';
import { computePhases } from './graph.js';
import { channels } from '../core/observability.js';
import type { Manifest, RunState, RunHooks, GateAdapter, AgentOutput, ManifestStep } from '../types/orchestration.js';
import { GateRejectedError, GateExpiredError } from '../types/orchestration.js';
import type { RunHistory } from '../core/run-history.js';
import { PromptBudget, DEFAULT_PROMPT_BUDGET } from './prompt-budget.js';
import { DEFAULT_RESULT_BYTES, truncateResult } from './result-truncate.js';

export { loadManifestFile, validateManifest } from './validate.js';

export interface RunManifestOptions {
  agentsDir?: string | undefined;
  gateAdapter?: GateAdapter | undefined;
  hooks?: RunHooks | undefined;
  mockResponses?: Map<string, string> | undefined;
  parentTools?: ToolEntry[] | undefined;
  parentToolContext?: import('../types/index.js').ToolContext | undefined;
  cachedOutputs?: Map<string, AgentOutput> | undefined;
  depth?: number | undefined;
  runHistory?: RunHistory | undefined;
  parentRunId?: string | undefined;
  /**
   * 2a: the saved-workflow id this run executes (undefined for ad-hoc/inline
   * runs). Threaded here so the orchestrator's start-INSERT stamps the run→
   * workflow linkage (Slice-C2 "Fix in chat" / diagnose) — previously the
   * tool-layer `persistPipelineRun` carried it, but the pipeline_runs writer
   * now lives in `runManifest`.
   */
  workflowId?: string | undefined;
  autonomy?: import('../types/index.js').AutonomyLevel | undefined;
  /**
   * Parent session's prompt callbacks. When provided, sub-agents in this run
   * inherit the ability to call ask_user / ask_secret; their prompts are
   * tagged with the originating step's id + task. Omit for autonomous runs.
   */
  parentPrompt?: SubAgentPromptHandles | undefined;
  /**
   * Per-run prompt budget. When omitted, a fresh PromptBudget is created from
   * the parent's existing budget (sub-pipelines inherit) or from the user
   * config / default. Pipelines without parentPrompt skip budgeting entirely.
   */
  promptBudget?: PromptBudget | undefined;
  /**
   * IANA timezone for the human user. Forwarded to each pipeline sub-agent so
   * times the agent surfaces (e.g. `task_create run_at`) reference the user's
   * wallclock instead of UTC. Read by the pipeline tool from
   * `parentAgent.userTimezone`.
   */
  userTimezone?: string | undefined;
  /**
   * Parent Session's counters object. When the pipeline tool is invoked
   * from a chat turn, this points at the Session's `_sessionCounters` so
   * step costs roll into the same per-Session budget the parent agent +
   * spawned sub-agents share. Optional for headless callers (worker-loop
   * scheduled runs, ad-hoc validate-and-run paths) — they pass their own
   * fresh counters object so cost still has somewhere to land.
   */
  parentSessionCounters?: SessionCounters | undefined;
  /**
   * Parent agent's memory backend. Threaded into `spawnInline` /
   * `spawnPipeline` so the constructed sub-agent's `agent.memory` is
   * non-null and the memory_* tool handlers can actually read/write. PR
   * #548 added the tools to the inline allowlist but left this wiring
   * absent — workflows silently degraded with "Memory is not configured
   * for this agent." until 2026-05-23 live verification caught it.
   *
   * Optional: omitted by headless callers (worker-loop runs without a
   * parent agent context, ad-hoc validate-and-run paths) and by sub-
   * pipelines whose parent run had no memory configured to begin with.
   */
  parentMemory?: IMemory | null | undefined;
  /**
   * Capability contract authorising this run's headless outbound writes.
   * RESERVED SEAM (Slice A1): threaded `runManifest` → spawners → `new Agent`
   * → carried beside `autonomy`/`preApproval` at the `isDangerous` enforcement
   * point, but A1 attaches no enforcement logic — `undefined`/`null` = the safe
   * autonomous-deny default (PRD §4.2 S7). Slice B fills the shape + enforces.
   */
  capabilityContract?: CapabilityContract | undefined;
  /**
   * Per-workflow DoS bounds enforced *inside* this run, between steps (PRD §4.2
   * S3). Set only by the headless saved-workflow path (`runSavedWorkflow`), with
   * conservative defaults applied there; sub-pipelines + in-session runs omit it
   * (undefined = no run-level bound, only the existing per-step/session guards).
   */
  limits?: WorkflowLimits | undefined;
  /**
   * Parent agent's SecretStore, threaded into each step sub-agent's
   * `new Agent({ secretStore })` so a workflow step's tools resolve `secret:NAME`
   * refs against the vault AND the fail-loud unresolved-secret guard (agent.ts)
   * fires. Set by the in-session `run_workflow` tool from `agent.secretStore`
   * (mirrors how `spawn_agent` threads `parentAgent.secretStore`). Absent for
   * non-`run_workflow` entries (headless saved-workflow, ad-hoc tests) →
   * unchanged pre-fix behaviour (the step agent's `secretStore` stays undefined).
   */
  secretStore?: SecretStoreLike | undefined;
}

/**
 * Inputs to {@link buildRunCtx}. `autonomy` is a **required key** (value may be
 * `undefined`) so every call site must consciously decide the run's permission
 * posture — the headless saved-workflow path passes `'autonomous'`, in-session
 * callers inherit the parent agent's autonomy. This is the structural guard
 * against the C1 drift class (a `runManifest` call that silently omits autonomy
 * → a headless step with no approver → silent `DANGEROUS_BASH` denial).
 */
export interface RunCtxInput {
  autonomy: import('../types/index.js').AutonomyLevel | undefined;
  parentTools?: ToolEntry[] | undefined;
  parentToolContext?: import('../types/index.js').ToolContext | undefined;
  parentMemory?: IMemory | null | undefined;
  userTimezone?: string | undefined;
  parentPrompt?: SubAgentPromptHandles | undefined;
  parentSessionCounters?: SessionCounters | undefined;
  runHistory?: RunHistory | undefined;
  hooks?: RunHooks | undefined;
  capabilityContract?: CapabilityContract | undefined;
  limits?: WorkflowLimits | undefined;
  secretStore?: SecretStoreLike | undefined;
  workflowId?: string | undefined;
}

/**
 * Build a *complete* {@link RunManifestOptions} for a pipeline run — the single
 * chokepoint every entrypoint routes through (`executeInlineSteps`,
 * `executePipelineById`, `runSavedWorkflow`, the retry path). Owning the object
 * construction here means no call site can drop a field (the `parentTools` /
 * `parentToolContext` / `userTimezone` drift class): every key is emitted
 * explicitly, and `autonomy` is required on the input. A contract test asserts
 * each entrypoint passes its options through this builder.
 *
 * Billing-agnostic by design: it shapes options only and fires no credit hook —
 * the in-Session path already bills via `Session.run` and the headless path via
 * `runGuardedSavedWorkflow`, so adding a wrapper here would double-bill
 * (prd-review A3).
 */
export function buildRunCtx(input: RunCtxInput): RunManifestOptions {
  return {
    autonomy: input.autonomy,
    parentTools: input.parentTools,
    parentToolContext: input.parentToolContext,
    parentMemory: input.parentMemory ?? null,
    userTimezone: input.userTimezone,
    parentPrompt: input.parentPrompt,
    parentSessionCounters: input.parentSessionCounters,
    runHistory: input.runHistory,
    hooks: input.hooks,
    capabilityContract: input.capabilityContract,
    limits: input.limits,
    secretStore: input.secretStore,
    workflowId: input.workflowId,
  };
}

/**
 * Per-workflow DoS guard (PRD §4.2 S3). Returns an abort reason, or null when
 * within bounds / unbounded. Primary guard is wall-clock — it terminates a
 * non-terminating run without capping legitimate (research) spend. `iterations`
 * = steps executed so far (a backstop above MAX_STEPS); `maxSpendUsd` is the
 * opt-in tighter per-run cap on top of the tenant-level `checkPersistentBudget`.
 *
 * **Granularity (no silent cap):** the guard is evaluated at STEP/PHASE
 * boundaries (before each sequential step, before each parallel phase), so it
 * bounds the common shape — a linear captured workflow runs one step per phase,
 * so the wall-clock/spend/step bound is re-checked before every step. It does
 * NOT interrupt work already in flight: a single long-running step, or a single
 * *wide* parallel phase (independent steps with no `input_from`, all launched
 * together), is bounded instead by that step's own `timeout_ms`, the agent's
 * per-spawn iteration cap, and the per-step `checkSessionBudget` — not by this
 * guard. Exported for direct unit testing of each bound.
 */
export function workflowBoundExceeded(
  limits: WorkflowLimits | undefined,
  startMs: number,
  iterations: number,
  stepCounters: SessionCounters,
): string | null {
  if (!limits) return null;
  if (limits.maxIterations !== undefined && iterations >= limits.maxIterations) {
    return `Workflow exceeded its step limit (${limits.maxIterations}) — aborting to prevent a runaway.`;
  }
  if (limits.maxWallClockMs !== undefined && Date.now() - startMs > limits.maxWallClockMs) {
    return `Workflow exceeded its wall-clock limit (${Math.round(limits.maxWallClockMs / 1000)}s) — aborting to prevent a runaway.`;
  }
  if (limits.maxSpendUsd !== undefined && stepCounters.costUSD > limits.maxSpendUsd) {
    return `Workflow exceeded its spend limit ($${limits.maxSpendUsd.toFixed(2)}) — aborting to prevent a runaway.`;
  }
  return null;
}

const MAX_PIPELINE_DEPTH = 3;

function getExecutionMode(m: Manifest): 'sequential' | 'parallel' {
  if (m.manifest_version === '1.0') return 'sequential';
  return m.execution ?? 'parallel';
}

export async function runManifest(
  manifest: Manifest,
  config: LynoxUserConfig,
  options: RunManifestOptions = {},
): Promise<RunState> {
  const depth = options.depth ?? 0;
  if (depth > MAX_PIPELINE_DEPTH) {
    throw new Error(`Pipeline nesting exceeds max depth (${MAX_PIPELINE_DEPTH})`);
  }

  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    throw new Error(
      `Manifest "${manifest.name ?? '(unnamed)'}" has no agents — refusing to run. ` +
      `Pass it through validateManifest() before runManifest() to surface schema errors.`,
    );
  }

  // Per-run prompt budget. Allocated only at the top-level run (depth === 0)
  // so sub-pipelines share the parent's cap; autonomous runs (no parent
  // prompt callbacks) skip budgeting entirely.
  let parentPrompt = options.parentPrompt;
  if (parentPrompt && !parentPrompt.promptBudget && depth === 0) {
    const limit = config.pipeline_prompt_budget ?? DEFAULT_PROMPT_BUDGET;
    const budget = options.promptBudget ?? new PromptBudget(limit);
    parentPrompt = { ...parentPrompt, promptBudget: budget };
  }

  // Session counters for this pipeline run. When invoked from a chat
  // turn the pipeline tool threads the parent Session's counters; for
  // headless callers (worker-loop scheduled pipelines, ad-hoc test
  // harnesses) we allocate a fresh object so cost still has somewhere
  // to land. Either way `checkSessionBudget` + `adjustSessionCost`
  // operate on a real per-run counter rather than the deleted module
  // global.
  const stepCounters: SessionCounters = options.parentSessionCounters ?? {
    httpRequests: 0,
    writeBytes: 0,
    costUSD: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };

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

  options.hooks?.onRunStart?.();

  // 2a durable run-record: the orchestrator is the SINGLE canonical writer of
  // the pipeline_runs row (invariant I1). A start-INSERT here makes an in-flight
  // run visible ('running'); the finalize-UPDATE in the `finally` below closes
  // it out — and runs even on a thrown error, so a caught catastrophic failure
  // never leaves the row stuck at 'running'. A hard process death (SIGKILL /
  // container stop) skips the finally, leaving a 'running' row that the boot
  // sweep (B4) relabels 'interrupted' on the next start (and which the cost
  // aggregate already ignores — it filters to terminal rows, B6).
  // Every run at ANY depth writes its row (B5): a nested sub-pipeline stamps its
  // parent's runId (parent_run_id), so the top-level views — getRecentPipelineRuns
  // and getPipelineCostStats, both filtered to parent_run_id IS NULL — keep it
  // out while it stays reachable by id (invariant I6). The write is
  // fire-and-forget: a history failure must never break or mask the run.
  const rh = options.runHistory;
  if (rh !== undefined) {
    try {
      rh.insertPipelineRun({
        id: runId,
        manifestName: manifest.name,
        status: 'running',
        manifestJson: JSON.stringify(manifest),
        ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
        ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
      });
    } catch { /* fire-and-forget */ }
  }

  // 2a/B3 durable step-record: each step writes its pipeline_step_results row
  // AS-COMPLETED (result='' deferred) into this accumulator; the finally below
  // fills the result-text by rowid once the run terminates. Present whenever the
  // run row is (any depth with RunHistory), so a nested run's step rows attach to
  // its own parent run row — never an orphan (B5 lifted the old depth-0 gate).
  const stepRows: StepRowAccumulator | undefined = rh !== undefined ? [] : undefined;

  // Effective options carry the (possibly-augmented) parentPrompt so
  // executeStep / spawners pick up the per-run budget without mutating the
  // caller's options.
  const effectiveOptions: RunManifestOptions = parentPrompt === options.parentPrompt
    ? options
    : { ...options, parentPrompt };

  const mode = getExecutionMode(manifest);
  try {
    if (mode === 'parallel') {
      await runParallel(manifest, state, config, agentsDir, effectiveOptions, stepCounters, stepRows);
    } else {
      await runSequential(manifest, state, config, agentsDir, effectiveOptions, stepCounters, stepRows);
    }

    if (state.status === 'running') {
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
    }
    options.hooks?.onRunComplete?.(state);
    return state;
  } catch (err) {
    // A thrown (catastrophic) error must not leave the record at 'running':
    // settle the in-memory state to 'failed' so the finalize records a terminal
    // row. Re-throw — recording must never swallow the caller's error.
    if (state.status === 'running') {
      state.status = 'failed';
      state.error = state.error ?? (err instanceof Error ? err.message : String(err));
      state.completedAt = new Date().toISOString();
    }
    throw err;
  } finally {
    if (rh !== undefined) {
      try {
        const outs = [...state.outputs.values()];
        rh.updatePipelineRun(runId, {
          status: state.status,
          totalDurationMs: outs.reduce((s, o) => s + o.durationMs, 0),
          totalCostUsd: outs.reduce((s, o) => s + o.costUsd, 0),
          totalTokensIn: outs.reduce((s, o) => s + o.tokensIn, 0),
          totalTokensOut: outs.reduce((s, o) => s + o.tokensOut, 0),
          stepCount: state.outputs.size,
          error: state.error,
        });
      } catch { /* fire-and-forget */ }

      // 2a/B3: NOW persist the deferred step result-texts (each row was inserted
      // result='' as-completed). This runs only on run termination (completed /
      // failed) — a hard crash skips the finally, so a crashed run's step rows
      // keep result='' on disk (invariant I4, the structural 2b fence). Filled
      // by rowid, never by (run_id, step_id), so for_each's N-per-step survives.
      if (stepRows !== undefined) {
        const limit = config.pipeline_step_result_limit ?? DEFAULT_RESULT_BYTES;
        for (const { rowId, result } of stepRows) {
          if (result === '') continue; // skipped / failed steps carry no result
          try { rh.updatePipelineStepResultText(rowId, truncateResult(result, limit)); } catch { /* fire-and-forget */ }
        }
      }
    }
  }
}

/**
 * Retry a manifest: re-execute failed/skipped steps, skip completed ones.
 */
export async function retryManifest(
  manifest: Manifest,
  previousState: RunState,
  config: LynoxUserConfig,
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
  config: LynoxUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
  stepCounters: SessionCounters,
  stepRows: StepRowAccumulator | undefined,
): Promise<void> {
  const startMs = Date.parse(state.startedAt);
  let iterations = 0;
  for (const step of manifest.agents) {
    const exceeded = workflowBoundExceeded(options.limits, startMs, iterations, stepCounters);
    if (exceeded) {
      state.status = 'failed';
      state.error = exceeded;
      state.completedAt = new Date().toISOString();
      return;
    }
    const result = await executeStep(step, manifest, state, config, agentsDir, options, stepCounters, stepRows);
    iterations++;
    if (result === 'halt') return;
  }
}

// --- Parallel phase-based execution (v1.1) ---

async function runParallel(
  manifest: Manifest,
  state: RunState,
  config: LynoxUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
  stepCounters: SessionCounters,
  stepRows: StepRowAccumulator | undefined,
): Promise<void> {
  const { phases } = computePhases(manifest.agents);
  const stepsById = new Map(manifest.agents.map(s => [s.id, s]));

  const startMs = Date.parse(state.startedAt);
  let iterations = 0;
  for (const phase of phases) {
    const exceeded = workflowBoundExceeded(options.limits, startMs, iterations, stepCounters);
    if (exceeded) {
      state.status = 'failed';
      state.error = exceeded;
      state.completedAt = new Date().toISOString();
      return;
    }
    iterations += phase.stepIds.length;
    options.hooks?.onPhaseStart?.(phase.phaseIndex, phase.stepIds);

    const promises = phase.stepIds.map(async (stepId) => {
      const step = stepsById.get(stepId)!;
      return executeStep(step, manifest, state, config, agentsDir, options, stepCounters, stepRows);
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

/**
 * 2a/B3 accumulator: the pipeline_step_results rowid each step wrote AS-COMPLETED
 * paired with the step's result-text, held IN MEMORY until run-finalize persists
 * it. The row was inserted with result='' (invariant I4 — the structural 2b
 * fence: a crash before finalize leaves result='' on disk, so the partial
 * result-text is never persisted). Present for any run with a RunHistory,
 * matching the pipeline_runs row — a nested run's step rows attach to its own
 * parent run row (B5), so they never orphan.
 */
type StepRowAccumulator = Array<{ rowId: number | bigint; result: string }>;

/**
 * Insert one pipeline_step_results row as-completed (result='' deferred) and
 * record its rowid + result-text for the finalize fill. Best-effort: the
 * durable record must never break or mask the run.
 */
function recordStepRow(
  runHistory: RunHistory,
  runId: string,
  step: ManifestStep,
  output: AgentOutput,
  acc: StepRowAccumulator,
): void {
  const status = output.skipped ? 'skipped' : output.error ? 'failed' : 'completed';
  try {
    const rowId = runHistory.insertPipelineStepResult({
      pipelineRunId: runId,
      stepId: step.id,
      status,
      result: '', // I4: deferred — filled by id at run-finalize, never mid-run
      error: output.error,
      durationMs: output.durationMs,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      costUsd: output.costUsd,
      modelTier: step.model ?? 'balanced',
    });
    acc.push({ rowId, result: output.result });
  } catch { /* best-effort */ }
}

async function executeStep(
  step: ManifestStep,
  manifest: Manifest,
  state: RunState,
  config: LynoxUserConfig,
  agentsDir: string,
  options: RunManifestOptions,
  stepCounters: SessionCounters,
  stepRows: StepRowAccumulator | undefined,
): Promise<StepResult> {
  // Check cached outputs for retry (skip already-completed steps)
  if (options.cachedOutputs?.has(step.id)) {
    const cached = options.cachedOutputs.get(step.id)!;
    state.outputs.set(step.id, cached);
    if (stepRows && options.runHistory) recordStepRow(options.runHistory, state.runId, step, cached, stepRows);
    options.hooks?.onStepRetrySkipped?.(step.id);
    return 'ok';
  }

  const stepStart = new Date().toISOString();
  // A2: the step's `pipeline_step` run id (declared before the try so the catch
  // can finalize it as failed). Undefined when RunHistory isn't wired.
  let stepRunId: string | undefined;
  // Hoisted before the try so BOTH finalizers (success + catch) can stamp them:
  // `toolSeq` = the count of tool calls recorded for this step (becomes
  // `tool_call_count`); `stepModelId` = the resolved concrete model the step ran
  // on (becomes `model_id`, '' for mock/pipeline steps that resolve no model).
  let toolSeq = 0;
  let stepModelId = '';

  try {
    const stepContext = buildStepContext(state.globalContext, step, state.outputs, config.pipeline_context_limit);

    // Use buildConditionContext for condition evaluation (includes ALL completed outputs)
    const condContext = buildConditionContext(state.globalContext, state.outputs);

    if (!shouldRunStep(condContext, step.conditions)) {
      const skipped = makeSkipped(step.id, 'conditions not met');
      state.outputs.set(step.id, skipped);
      if (stepRows && options.runHistory) recordStepRow(options.runHistory, state.runId, step, skipped, stepRows);
      options.hooks?.onStepSkipped?.(step.id, 'conditions not met');
      return 'ok';
    }

    options.hooks?.onStepStart?.(step.id, step.agent);

    // A2 observability: record this step as a `pipeline_step` run — the
    // live-progress row (status running→completed/failed, polled by the UI via
    // `spawn_parent_id = pipelineRunId`) AND the run id this step's tool calls
    // attach to (`run_tool_calls.run_id`). Best-effort: a history failure never
    // breaks the run. `session_id = state.runId` (the pipeline run id, NOT a
    // chat session) isolates these from `getSessionToolCalls`; the row is
    // excluded from every spend/stats/usage aggregate (see run-history.ts).
    // cost/tokens/status are finalized at step end (success + catch).
    if (options.runHistory) {
      try {
        stepRunId = options.runHistory.insertRun({
          sessionId: state.runId,
          taskText: step.task ?? step.id,
          modelTier: step.model ?? '',
          modelId: '',
          runType: 'pipeline_step',
          spawnParentId: state.runId,
          spawnDepth: (options.depth ?? 0) + 1,
        });
      } catch { stepRunId = undefined; }
    }
    const recordToolCall: StepToolRecorder | undefined = (stepRunId && options.runHistory)
      ? (call) => {
          try {
            options.runHistory!.insertToolCall({
              runId: stepRunId!,
              toolName: call.toolName,
              inputJson: call.inputJson,
              outputJson: call.outputJson,
              durationMs: call.durationMs,
              sequenceOrder: toolSeq++,
            });
          } catch { /* best-effort: observability must never break the run */ }
        }
      : undefined;

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
      r = await spawnPipeline(step, stepContext, config, options.parentTools ?? [], options.depth ?? 0, options.parentPrompt, options.userTimezone, stepCounters, options.parentMemory ?? null, options.autonomy, options.capabilityContract, options.runHistory, options.secretStore, state.runId);
      costUsd = 0; // Cost comes from sub-pipeline steps (tracked individually)
    } else if (step.runtime === 'inline') {
      if (!options.parentTools) {
        throw new Error(`Step "${step.id}" uses inline runtime but no parentTools provided`);
      }
      // Resolve task + captured-call templates before execution. The prose task
      // resolves `{{params.*}}` with the untrusted-data boundary; the captured
      // `input_template` resolves the same params into the literal call the step
      // agent replays (no boundary — those are tool arguments, not prose).
      const resolvedTask = step.task ? resolveTaskTemplate(step.task, stepContext) : step.task;
      const resolvedInputTemplate = step.input_template
        ? resolveInputTemplate(step.input_template, stepContext)
        : step.input_template;
      const resolvedStep =
        (resolvedTask !== step.task || resolvedInputTemplate !== step.input_template)
          ? { ...step, task: resolvedTask, input_template: resolvedInputTemplate }
          : step;
      // Check session budget before spawning step agent
      const stepModel = resolveModelForCost(step, 'balanced', config);
      stepModelId = stepModel; // A2: stamp the resolved model on the step run at finalize
      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepCounters, stepEstimate);
      r = await spawnInline(resolvedStep, stepContext, config, options.parentTools, stepPreApproval, options.autonomy, options.parentToolContext, options.parentPrompt, options.userTimezone, options.parentMemory ?? null, options.capabilityContract, stepRunId, recordToolCall, options.secretStore);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(stepCounters, costUsd - stepEstimate); // correct estimate to actual
    } else {
      const agentDef = await loadAgentDef(step.agent, agentsDir);
      // Check session budget before spawning step agent
      const stepModel = resolveModelForCost(step, agentDef.defaultTier, config);
      stepModelId = stepModel; // A2: stamp the resolved model on the step run at finalize
      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepCounters, stepEstimate);
      r = await spawnViaAgent(step, agentDef, stepContext, config, options.gateAdapter, state.runId, stepPreApproval, options.autonomy, options.parentPrompt, options.userTimezone, options.capabilityContract, stepRunId, recordToolCall, options.secretStore);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(stepCounters, costUsd - stepEstimate); // correct estimate to actual
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
    // A2: finalize the step's progress row — status completed + real per-step
    // cost/tokens/duration (queryable in the run-detail view; still excluded
    // from spend aggregates).
    if (stepRunId && options.runHistory) {
      try {
        options.runHistory.updateRun(stepRunId, {
          status: 'completed',
          costUsd,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          durationMs: r.durationMs,
          toolCallCount: toolSeq,
          modelId: stepModelId,
        });
      } catch { /* best-effort */ }
    }
    // 2a/B3: durable pipeline_step_results row, written as-completed with its
    // result-text DEFERRED to run-finalize (invariant I4).
    if (stepRows && options.runHistory) recordStepRow(options.runHistory, state.runId, step, output, stepRows);
    return 'ok';

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    options.hooks?.onError?.(step.id, error);
    // A2: finalize the step's progress row as failed (errorText is encrypted at
    // rest like response_text). The error also surfaces via state.error/outputs.
    if (stepRunId && options.runHistory) {
      try {
        options.runHistory.updateRun(stepRunId, { status: 'failed', errorText: error.message, toolCallCount: toolSeq, modelId: stepModelId });
      } catch { /* best-effort */ }
    }
    // 2a/B3: record the failed step in pipeline_step_results too (result=''), so
    // it shows in the /:id/steps list even under on_failure='stop', which halts
    // WITHOUT adding the step to state.outputs (the batch writer's blind spot).
    // Covers every caught mode (stop/notify/continue/gate) exactly once here.
    if (stepRows && options.runHistory) {
      recordStepRow(options.runHistory, state.runId, step, {
        stepId: step.id, result: '', startedAt: stepStart, completedAt: new Date().toISOString(),
        durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, skipped: false, error: error.message,
      }, stepRows);
    }

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

function resolveModelForCost(step: ManifestStep, defaultTier: ModelTier, config: LynoxUserConfig): string {
  // Price the step against the SAME model the runtime-adapter ran it on — gate +
  // clamp + the ACTIVE provider — not an Anthropic-only tier map. A Mistral tenant
  // was previously billed at Claude prices (and a clamped deep step at deep prices).
  return resolveRunModel({
    requested: step.model,
    defaultTier,
    accountTier: config.account_tier,
    maxTier: config.max_tier,
    provider: getActiveProvider(),
  }).modelId;
}
