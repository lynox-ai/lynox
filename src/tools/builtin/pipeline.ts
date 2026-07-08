import type { ToolEntry, LynoxUserConfig, InlinePipelineStep, PipelineResult, PipelineStepResult, PlannedPipeline, StreamHandler, AutonomyLevel, WorkflowLimits, SecretStoreLike } from '../../types/index.js';
import { validateManifest, MAX_STEPS } from '../../orchestrator/validate.js';
import { runManifest, retryManifest, buildRunCtx } from '../../orchestrator/runner.js';
import { estimatePipelineCost } from '../../core/dag-planner.js';
import type { Manifest, AgentOutput, RunState, RunHooks } from '../../types/orchestration.js';
import type { RunHistory } from '../../core/run-history.js';
import { getErrorMessage } from '../../core/utils.js';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import { bindWorkflowParameters } from '../../orchestrator/workflow-params.js';
import { applyModifications, type StepModification } from '../../orchestrator/workflow-edit.js';
import type { SubAgentPromptHandles } from '../../orchestrator/runtime-adapter.js';
import type { ToolContext } from '../../core/tool-context.js';
import type { IMemory } from '../../types/memory.js';

const DEFAULT_RESULT_BYTES = 20_480; // 20KB per step result
const MAX_PLANS = 10;
/** Retry-state buffer cap — larger than the plan cache so a burst of distinct
 *  workflows keeps each other's executed state retriable; bounds the leak. */
const MAX_EXECUTED_STATES = 50;

// Pipeline config accessed via agent.toolContext (userConfig, tools, streamHandler, runHistory)

// In-memory store for planned pipelines (session-scoped)
const pipelineStore = new Map<string, PlannedPipeline>();

// Store last executed state per pipeline for retry
const executedStates = new Map<string, { manifest: Manifest; state: RunState }>();

// Non-template reentrancy guard: a non-template (run-once) pipeline currently
// in-flight. `executePipelineById` marks `planned.executed = true` before the
// run completes and only writes `executedStates` after — so a retry firing in
// that window observes `executed = true` with no recoverable state and used to
// 404 with "no previous execution". Tracking the id here closes that window: a
// retry while the original run is still in flight gets a clear "still running"
// error instead. (A second *fresh* run is already blocked separately by the
// `executed === true` check with "already been executed".) Templates (saved
// workflows) are reusable by definition and never enter this set.
const inFlightNonTemplatePipelines = new Set<string>();

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
  // Legacy rows (saved before the re-target schema landed) have no `parameters`;
  // default to an empty schema so binding/validation treats them as no-param.
  planned.parameters ??= [];
  // Legacy rows have no stored failure strategy; default to 'stop' (the prior
  // hardcoded headless behaviour) so the headless path can read it uniformly.
  planned.on_failure ??= 'stop';
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
        storePipeline(planned.id, planned); // cache in memory (cap-enforced)
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

/** Record an executed pipeline's retry state with a bounded, TRUE-LRU map — the
 *  `executedStates` map otherwise grows one entry per distinct executed pipeline
 *  id for the life of the process (unbounded leak). delete-then-set moves a
 *  re-recorded (retried) id to the most-recent slot, so a hot pipeline is NOT
 *  evicted as "oldest" while it is still being retried (a plain `Map.set` keeps
 *  the original insertion position → FIFO, which would drop a hot entry after N
 *  other executions). Uses its OWN cap, larger than the plan cache, so a burst
 *  of distinct workflows doesn't evict each other's still-retriable state. */
export function recordExecutedState(id: string, value: { manifest: Manifest; state: RunState }): void {
  executedStates.delete(id);
  if (executedStates.size >= MAX_EXECUTED_STATES) {
    const oldest = executedStates.keys().next().value;
    if (oldest !== undefined) executedStates.delete(oldest);
  }
  executedStates.set(id, value);
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

export function buildManifest(name: string, steps: InlinePipelineStep[], onFailure: 'stop' | 'continue' | 'notify', context?: Record<string, unknown>): Manifest {
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
      // Deterministic-replay pair — preserved so the inline runtime can replay
      // the literal captured call instead of re-interpreting `task`.
      tool: s.tool,
      input_template: s.input_template,
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

function persistPipelineRun(state: RunState, manifest: Manifest, pipelineRunHistory: RunHistory | null, resultLimit?: number, workflowId?: string | undefined): void {
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
      // Slice C2: link the run to its saved workflow (undefined for inline/ad-hoc)
      // so a failed run resolves back to the workflow for diagnose/fix/re-run.
      ...(workflowId ? { workflowId } : {}),
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
      // Expose inline context under BOTH the top-level namespace (preserves
      // existing `{{key}}` references — no regression) and the `params`
      // namespace, so inline steps resolve `{{params.key}}` consistently with
      // saved-workflow runs (§4.5 drift fix). The explicit `params` key wins
      // on a name collision.
      { ...(input.context ?? {}), params: input.context ?? {} },
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
    const state = await runManifest(manifest, deps.config, buildRunCtx({
      autonomy: deps.autonomy,
      parentTools: deps.tools,
      parentToolContext: deps.toolContext,
      hooks,
      runHistory: deps.runHistory ?? undefined,
      parentPrompt: deps.parentPrompt,
      userTimezone: deps.userTimezone,
      parentSessionCounters: deps.sessionCounters,
      parentMemory: deps.memory ?? null,
      secretStore: deps.secretStore,
    }));

    persistPipelineRun(state, manifest, deps.runHistory, resultLimit);
    return formatResult(state, input.name ?? 'inline-pipeline', resultLimit);
  } catch (err: unknown) {
    return `Error: Workflow execution failed: ${getErrorMessage(err)}`;
  }
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
   * Permission posture the run's step sub-agents inherit. In-session callers
   * (the `run_workflow` tool) thread the parent agent's `autonomy` so a normal
   * chat keeps interactive prompting (parent `undefined`) while a worker-session
   * run propagates `'autonomous'`. The headless saved-workflow path does not use
   * this — it passes `'autonomous'` to `buildRunCtx` directly. The C1 fix: every
   * pipeline run now carries an explicit autonomy instead of silently omitting it.
   */
  autonomy?: AutonomyLevel | undefined;
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
  /**
   * Caller-supplied re-target values for a parametrised saved workflow, bound +
   * validated against `PlannedPipeline.parameters` before the run (the
   * `{{params.<name>}}` namespace). Supplied by the agent `run_workflow` tool
   * (its `params` input, §4.5 re-target), the HTTP `/run` route, and the
   * saved-workflow library; absent for a cron fire with no stored params (binds
   * leniently to schema defaults).
   */
  params?: Record<string, unknown> | undefined;
  /**
   * Parent agent's SecretStore, threaded from the `run_workflow` tool
   * (`agent.secretStore`) down into each step sub-agent so a workflow step's
   * tools resolve `secret:NAME` refs against the vault AND the fail-loud
   * unresolved-secret guard (agent.ts) fires — instead of silently sending the
   * literal `secret:NAME` to an external service (which then 4xx/empties and the
   * model papers over it). Mirrors how `spawn_agent` threads
   * `parentAgent.secretStore`. Absent for headless callers (worker-loop
   * saved-workflow runs, unit tests) → the step agent's `secretStore` stays
   * undefined, i.e. unchanged pre-fix behaviour.
   */
  secretStore?: SecretStoreLike | undefined;
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
  /** A2: per-step failure detail (stepId + message + that step's cost), so the
   *  caller (POST /run → run UI) can show WHICH step failed and why where the
   *  run was triggered — not just a terminal status. Empty when all steps
   *  succeeded; present for every step that recorded an error (incl. on_failure
   *  = 'continue'/'notify' runs that finished 'completed' with errored steps). */
  stepErrors?: Array<{ stepId: string; error?: string | undefined; costUsd: number }> | undefined;
}

/**
 * Conservative default DoS bounds for an unattended (headless/autonomous) run
 * (PRD §4.2 S3). Wall-clock is the primary guard — it terminates a
 * non-terminating run without capping legitimate (research) spend. The step
 * backstop sits above MAX_STEPS (= 20). Per-run spend is intentionally NOT
 * defaulted: research workflows are legitimately expensive, so spend is bounded
 * by the tenant-level `checkPersistentBudget`, with `maxSpendUsd` an opt-in
 * tighter per-run cap a workflow can declare.
 */
const DEFAULT_HEADLESS_WALL_CLOCK_MS = 30 * 60_000; // 30 minutes
const DEFAULT_HEADLESS_MAX_ITERATIONS = 50;          // backstop above MAX_STEPS

/** Merge a workflow's stored limits with the headless defaults (unset → default;
 *  `maxSpendUsd` stays opt-in). */
function resolveHeadlessLimits(stored: WorkflowLimits | undefined): WorkflowLimits {
  return {
    maxWallClockMs: stored?.maxWallClockMs ?? DEFAULT_HEADLESS_WALL_CLOCK_MS,
    maxIterations: stored?.maxIterations ?? DEFAULT_HEADLESS_MAX_ITERATIONS,
    maxSpendUsd: stored?.maxSpendUsd,
  };
}

/**
 * Run a *saved workflow* (a `PlannedPipeline` with `template:true`) headless,
 * for the Saved-Workflows library UI's "Run" action (PRD §6.8 / D13).
 *
 * Unlike `executePipelineById`, this never
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
  params?: Record<string, unknown> | undefined,
  runtime?: { tools?: ToolEntry[] | undefined; toolContext?: ToolContext | undefined; memory?: IMemory | null | undefined } | undefined,
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

  // Bind the supplied re-target values against the workflow's parameter schema.
  // Strict only when the caller actually supplied values (HTTP `/run` body / the
  // run UI): a missing required param then fails fast. An autonomous run with no
  // values (cron, `run_workflow`) binds leniently — unbound params stay as
  // unresolved placeholders, preserving the pre-replay behaviour (no regression).
  // Slice B: a contract-governed workflow constrains its re-targetable params at
  // bind (enum/regex/min-max) so a supplied value can't redirect an outbound
  // call before it resolves raw into the literal step call (S1).
  const bound = bindWorkflowParameters(planned.parameters ?? [], params, {
    requireAll: params !== undefined,
    constraints: planned.capabilityContract?.paramConstraints,
  });
  if (!bound.ok) {
    return { ok: false, error: bound.error };
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
    // Honour the workflow's stored failure strategy instead of hardcoding 'stop'
    // (§4.5 drift fix). Backfilled to 'stop' on read, so legacy rows are
    // unchanged; the edit-via-chat tool (Slice C) is the producer of a
    // non-'stop' value.
    const manifest = buildManifest(planned.name, steps, planned.on_failure ?? 'stop', { params: bound.params });
    validateManifest(manifest);
    // Inline steps need the engine's tool set to execute — without `parentTools`
    // the runner throws "no parentTools provided" before any step runs (the gap
    // that left every headless saved-workflow run failing). The library "Run",
    // cron, and the HTTP re-target all reach here via runGuardedSavedWorkflow,
    // which sources these off the engine.
    //
    // C1 fix: headless saved-workflow runs are explicitly `autonomous`. Without
    // it the step sub-agents inherited an undefined posture → a benign step that
    // hit any DANGEROUS_BASH pattern was denied non-interactively (no approver)
    // and the run silently failed. `buildRunCtx` makes the posture explicit +
    // the option object complete; the capability-contract seam rides along (null
    // here = the safe autonomous-deny default until Slice B grants writes).
    const state = await runManifest(manifest, config, buildRunCtx({
      autonomy: 'autonomous',
      runHistory,
      parentTools: runtime?.tools,
      parentToolContext: runtime?.toolContext,
      parentMemory: runtime?.memory ?? null,
      // Slice B: the stored capability-contract authorises this headless run's
      // declared outbound writes (enforced per-tool-call at isDangerous); the
      // DoS bounds (wall-clock/iterations/spend, with headless defaults) stop a
      // runaway from inside the run. Absent contract = the safe deny default.
      capabilityContract: planned.capabilityContract,
      limits: resolveHeadlessLimits(planned.limits),
    }));
    persistPipelineRun(state, manifest, runHistory, resultLimit, planned.id);
    const costUsd = [...state.outputs.values()].reduce((s, o) => s + o.costUsd, 0);
    // A2: surface per-step failures + the terminal run error so the trigger UI
    // shows WHICH step failed (not just status). `ok:true` = the run executed;
    // a failed step is reflected in `status`/`error`/`stepErrors`, not `ok`.
    const stepErrors = [...state.outputs.values()]
      .filter(o => o.error !== undefined && o.error !== '')
      .map(o => ({ stepId: o.stepId, error: o.error, costUsd: o.costUsd }));
    return { ok: true, runId: state.runId, status: state.status, costUsd, stepErrors, error: state.error };
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
    // Reentrancy guard: a non-template's fresh run sets executed=true before it
    // records `executedStates`, so a retry firing in that window would have hit
    // the misleading "no previous execution found" below. Reject with a clear
    // message instead while the original run is still in flight.
    if (inFlightNonTemplatePipelines.has(planned.id)) {
      return `Error: Workflow "${planned.id}" is still running — wait for the current run to finish before retrying.`;
    }
    const prev = executedStates.get(planned.id);
    if (!prev) {
      return `Error: No previous execution found for pipeline "${planned.id}". Execute it first before retrying.`;
    }

    try {
      const hooks = buildProgressHooks(deps.streamHandler, prev.manifest);
      // buildRunCtx restores the two fields the retry path used to drop
      // (parentToolContext + userTimezone) — without them a retried step ran
      // with no tool context / wrong timezone vs its original run (§4.1).
      const state = await retryManifest(prev.manifest, prev.state, deps.config, buildRunCtx({
        autonomy: deps.autonomy,
        parentTools: deps.tools,
        parentToolContext: deps.toolContext,
        hooks,
        runHistory: deps.runHistory ?? undefined,
        parentPrompt: deps.parentPrompt,
        userTimezone: deps.userTimezone,
        parentSessionCounters: deps.sessionCounters,
        parentMemory: deps.memory ?? null,
      }));

      recordExecutedState(planned.id, { manifest: prev.manifest, state });
      persistPipelineRun(state, prev.manifest, deps.runHistory, resultLimit, planned.id);
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

  // Deliberately NOT contract-governed (Slice B1): the in-session `run_workflow`
  // tool runs with a live approver, so `isDangerous` still prompts for outbound
  // writes — the capability-contract grant + param constraints are the headless
  // unattended substitute for that prompt and are threaded only on the headless
  // `runSavedWorkflow` path. Keeping them off here means zero in-session
  // behaviour change. (If `run_workflow` is ever made callable from an
  // unattended/worker session, thread `planned.capabilityContract` +
  // `paramConstraints` + `limits` here too.)
  const bound = bindWorkflowParameters(planned.parameters ?? [], deps.params, { requireAll: deps.params !== undefined });
  if (!bound.ok) {
    return `Error: ${bound.error}`;
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
      { params: bound.params },
    );

    validateManifest(manifest);
    if (!isTemplate) {
      planned.executed = true;
      // Mark in-flight so a concurrent retry sees "still running" instead of the
      // misleading "no previous execution" (the executed=true → executedStates
      // window). Cleared in finally.
      inFlightNonTemplatePipelines.add(planned.id);
    }

    const hooks = buildProgressHooks(deps.streamHandler, manifest);
    const state = await runManifest(manifest, deps.config, buildRunCtx({
      autonomy: deps.autonomy,
      parentTools: deps.tools,
      parentToolContext: deps.toolContext,
      hooks,
      runHistory: deps.runHistory ?? undefined,
      parentPrompt: deps.parentPrompt,
      userTimezone: deps.userTimezone,
      parentSessionCounters: deps.sessionCounters,
      parentMemory: deps.memory ?? null,
      secretStore: deps.secretStore,
    }));

    recordExecutedState(planned.id, { manifest, state });
    persistPipelineRun(state, manifest, deps.runHistory, resultLimit, planned.id);
    if (!isTemplate) {
      try { deps.runHistory?.markPipelineExecuted(planned.id); } catch { /* fire-and-forget */ }
    }

    return formatResult(state, planned.name, resultLimit);
  } catch (err: unknown) {
    if (!isTemplate) planned.executed = false; // Allow retry on validation errors
    return `Error: Workflow execution failed: ${getErrorMessage(err)}`;
  } finally {
    if (!isTemplate) inFlightNonTemplatePipelines.delete(planned.id);
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
  /**
   * Re-target values for a parametrised saved workflow (`workflow_id` path).
   * Bound + validated against `PlannedPipeline.parameters` before the run and
   * resolved into `{{params.<name>}}` placeholders. The §4.5 fix that lets the
   * agent re-target a stored workflow from chat (previously the tool had no
   * params field, so a re-targetable workflow could only run with its defaults).
   */
  params?: Record<string, unknown> | undefined;
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
        params: {
          type: 'object',
          description: 'Re-target values for a stored workflow\'s {{params.<name>}} placeholders (requires workflow_id).',
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
        // Inherit the calling agent's posture: a normal chat (undefined) keeps
        // interactive prompting; a worker-session run propagates 'autonomous'
        // so its steps don't silently fail on a benign DANGEROUS_BASH op (C1).
        autonomy: agent.autonomy,
        // Re-target values for a parametrised stored workflow (§4.5).
        params: input.params,
        // Thread the parent agent's SecretStore so step sub-agents resolve
        // `secret:NAME` refs + fire the fail-loud guard (mirrors spawn.ts for
        // spawn_agent). `agent.secretStore` is undefined for a headless/no-vault
        // parent → unchanged behaviour.
        secretStore: agent.secretStore,
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
        autonomy: agent.autonomy,
        // Thread the parent agent's SecretStore (see executePipelineById above).
        secretStore: agent.secretStore,
      });
  },
};

/** Reset pipeline store — for testing only */
export function _resetPipelineStore(): void {
  pipelineStore.clear();
  executedStates.clear();
  warnedLegacyIds.clear();
  inFlightNonTemplatePipelines.clear();
}
