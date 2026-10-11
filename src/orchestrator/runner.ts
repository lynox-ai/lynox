import { randomUUID } from 'node:crypto';
import { WORKFLOW_STOPPED_ERROR, WORKFLOW_QUESTION_UNANSWERED_ERROR, WORKFLOW_QUESTION_NOT_ASKED_ERROR } from './workflow-stop.js';
import { pinnedModelOfConfig } from '../core/profile-pair.js';
import { join } from 'node:path';
import type { ModelTier, LynoxUserConfig, PreApprovalPattern, PreApprovalSet, ToolEntry, CapabilityContract, WorkflowLimits, SecretStoreLike } from '../types/index.js';
import { getActiveProvider } from '../core/llm-client.js';
import { resolveRunModel, effectiveTierModelId } from '../core/tier-resolver.js';
import { calculateCost } from '../core/pricing.js';
import { checkSessionBudget, adjustSessionCost } from '../core/session-budget.js';
import type { SessionCounters } from '../types/agent.js';
import type { IMemory } from '../types/memory.js';
import { buildApprovalSet } from '../core/pre-approve.js';
import { loadAgentDef } from './agent-registry.js';
import { buildStepContext, resolveTaskTemplate, resolveInputTemplate } from './context.js';
import { shouldRunStep, buildConditionContext } from './conditions.js';
import { spawnViaAgent, spawnMock, spawnInline, spawnPipeline, undeclaredInlineStepTier, headlessStepModelOverride, resolveStepSlotCreds, type SubAgentPromptHandles, type StepToolRecorder, type RunTaint } from './runtime-adapter.js';
import { computePhases } from './graph.js';
import { channels } from '../core/observability.js';
import type { Manifest, RunState, RunHooks, GateAdapter, AgentOutput, ManifestStep } from '../types/orchestration.js';
import { GateRejectedError, GateExpiredError } from '../types/orchestration.js';
import type { RunHistory } from '../core/run-history.js';
import { PromptBudget, promptBudgetLimit } from './prompt-budget.js';
import { DEFAULT_RESULT_BYTES, truncateResult } from './result-truncate.js';
import { parallelStepCapFor } from './validate.js';

export { loadManifestFile, validateManifest } from './validate.js';

export interface RunManifestOptions {
  agentsDir?: string | undefined;
  /** The run's id, minted by the caller instead of here. A route that holds a claim on
   *  this run has to know the id BEFORE the run starts — the claim is taken first, and a
   *  run that throws before answering leaves nothing to look the id up by. Absent: minted
   *  below, which is every other caller. */
  runId?: string | undefined;
  gateAdapter?: GateAdapter | undefined;
  hooks?: RunHooks | undefined;
  mockResponses?: Map<string, string> | undefined;
  parentTools?: ToolEntry[] | undefined;
  parentToolContext?: import('../types/index.js').ToolContext | undefined;
  /**
   * The calling session's memory scopes. Inline steps run the parent's task and memory tools,
   * which filter by `agent.activeScopes`, so each step agent inherits these. Absent for headless
   * runs, which have no calling session.
   */
  parentActiveScopes?: import('../types/index.js').MemoryScopeRef[] | undefined;
  /**
   * Who started the run. Every step agent is built for it, so a mandate's step runs under
   * the mandate's lock — its tool list is the parent's filtered one already, and the
   * principal is what also refuses the protected secrets and stamps the step's writes
   * (PRD customer-granted-operator-access D1, §3.13 E5). Absent = the owner.
   */
  principal?: import('../core/request-principal.js').RequestPrincipal | undefined;
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
   * The workflow name to put on this run's prompts, when it is not
   * `manifest.name`. Exists for SYNTHETIC manifests: `spawnPipeline` builds a
   * sub-manifest called `<stepId>-sub`, which is a machine id the user has never
   * seen — naming it in a confirmation dialog is worse than naming the workflow
   * they actually started. Omit and `manifest.name` is used.
   */
  originWorkflowName?: string | undefined;
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
   * Set only beside a reviewed grant: confirms that a `{{params…}}` value in a step's task is
   * exactly the value the person accepted, so it goes in without the untrusted-data boundary
   * (`resolveTaskTemplate`). Threaded into nested pipelines, where it confirms the same way —
   * a value that changed on the way is not confirmed and keeps the boundary.
   */
  isAcceptedParam?: ((path: string, value: unknown) => boolean) | undefined;
  /**
   * Sees every tool call a top-level step's own agent makes, whether or not a
   * RunHistory records it. The saved-workflow run report reads refused and
   * possibly-landed writes from it. Not threaded into nested pipelines.
   */
  observeToolCall?: StepToolRecorder | undefined;
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
  /**
   * Run-level untrusted-content accumulator (see {@link RunTaint} in
   * runtime-adapter.ts). Created per run by the pipeline entrypoints — seeded
   * from the calling agent in-session, clean for headless runs — and MUTATED by
   * the real step spawners (inline / named-agent; `spawnMock` never touches
   * it): an armed accumulator arms each step agent's sticky
   * latch before send, and each finished step folds what it saw back in. This
   * is the cross-STEP counterpart of spawn.ts's parent↔child taint seed; a
   * nested sub-pipeline shares the same object so taint crosses nesting levels.
   * Absent (ad-hoc tests, legacy callers) = pre-fix behaviour: steps start clean.
   */
  runTaint?: RunTaint | undefined;
  /**
   * The scope whose abort may reach this run's step agents — a session's, or a run's own.
   *
   * ⚠ Absent for the library Run button and the HTTP re-target, which have no calling
   * agent to source it from. The worker loop's SCHEDULED pipeline has no session either;
   * it builds a scope of its own per run, which the owner's stop aborts (see
   * `stopSignal`). A process-wide set is not the fallback: it is what let a stop in one
   * thread abort another thread's agents.
   *
   * ⚠ An earlier version said "headless or worker-driven". Half wrong: a worker path that
   * runs an agent turn has a session with a scope, and so does the interactive
   * `run_workflow`. For a while neither supplied it, which made the whole step half dead
   * code. See `AbortScope`.
   */
  abortScope?: import('../types/config.js').AbortScope | undefined;
  /**
   * Aborted when the run's OWNER stopped it — and for nothing else: the caller aborts it
   * only for an explicit stop, never for a shutdown or a deadline. Read before each step, and
   * by a step that fails while it is aborted, which ends the run rather than carrying on
   * under `on_failure: 'continue'` — also when that step was the last one. It does not interrupt a step by itself:
   * ending the step agents in flight is `abortScope`'s job, so a caller passes both.
   */
  stopSignal?: AbortSignal | undefined;
  /**
   * The question channel's state, for a scheduled run whose steps may ask its owner (PRD 3b-2
   * §4.5, G5): a question that went unanswered halts the run, after the owner's stop, and the
   * time spent waiting for answers does not count against the wall clock. Absent for every run
   * that cannot ask.
   */
  questionWait?: import('../core/workflow-questions.js').WorkflowQuestionWait | undefined;
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
  parentActiveScopes?: import('../types/index.js').MemoryScopeRef[] | undefined;
  /** See `RunManifestOptions.principal`. */
  principal?: import('../core/request-principal.js').RequestPrincipal | undefined;
  parentMemory?: IMemory | null | undefined;
  userTimezone?: string | undefined;
  parentPrompt?: SubAgentPromptHandles | undefined;
  parentSessionCounters?: SessionCounters | undefined;
  runHistory?: RunHistory | undefined;
  runId?: string | undefined;
  hooks?: RunHooks | undefined;
  capabilityContract?: CapabilityContract | undefined;
  isAcceptedParam?: ((path: string, value: unknown) => boolean) | undefined;
  observeToolCall?: StepToolRecorder | undefined;
  limits?: WorkflowLimits | undefined;
  secretStore?: SecretStoreLike | undefined;
  workflowId?: string | undefined;
  runTaint?: RunTaint | undefined;
  /**
   * The scope whose abort may reach this run's step agents — a session's, or a run's own.
   *
   * ⚠ Absent for the library Run button and the HTTP re-target, which have no calling
   * agent to source it from. The worker loop's SCHEDULED pipeline has no session either;
   * it builds a scope of its own per run, which the owner's stop aborts (see
   * `stopSignal`). A process-wide set is not the fallback: it is what let a stop in one
   * thread abort another thread's agents.
   *
   * ⚠ An earlier version said "headless or worker-driven". Half wrong: a worker path that
   * runs an agent turn has a session with a scope, and so does the interactive
   * `run_workflow`. For a while neither supplied it, which made the whole step half dead
   * code. See `AbortScope`.
   */
  abortScope?: import('../types/config.js').AbortScope | undefined;
  /**
   * Aborted when the run's OWNER stopped it — and for nothing else: the caller aborts it
   * only for an explicit stop, never for a shutdown or a deadline. Read before each step, and
   * by a step that fails while it is aborted, which ends the run rather than carrying on
   * under `on_failure: 'continue'` — also when that step was the last one. It does not interrupt a step by itself:
   * ending the step agents in flight is `abortScope`'s job, so a caller passes both.
   */
  stopSignal?: AbortSignal | undefined;
  /** See `RunManifestOptions.questionWait`. */
  questionWait?: import('../core/workflow-questions.js').WorkflowQuestionWait | undefined;
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
    parentActiveScopes: input.parentActiveScopes,
    principal: input.principal,
    parentMemory: input.parentMemory ?? null,
    userTimezone: input.userTimezone,
    parentPrompt: input.parentPrompt,
    parentSessionCounters: input.parentSessionCounters,
    runHistory: input.runHistory,
    runId: input.runId,
    hooks: input.hooks,
    capabilityContract: input.capabilityContract,
    isAcceptedParam: input.isAcceptedParam,
    observeToolCall: input.observeToolCall,
    limits: input.limits,
    secretStore: input.secretStore,
    workflowId: input.workflowId,
    runTaint: input.runTaint,
    abortScope: input.abortScope,
    stopSignal: input.stopSignal,
    questionWait: input.questionWait,
  };
}

/** Whether the owner stopped the run; if so, end it as stopped. */
function stoppedByOwner(options: RunManifestOptions, state: RunState): boolean {
  if (options.stopSignal?.aborted !== true) return false;
  // A run that already ended on a cause of its own keeps it: a sibling step that failed or
  // was rejected in the same phase is the run's outcome, and reading it as the stop would
  // drop the escalation and the retry it is owed. The stop still ends the run.
  if (state.status !== 'running') return true;
  state.status = 'failed';
  state.error = WORKFLOW_STOPPED_ERROR;
  state.completedAt = new Date().toISOString();
  return true;
}

/**
 * Whether the run lacks an answer it asked for — a question that went unanswered until its TTL
 * ran out, or one that could not be put to the owner; if so, end the run with that cause (PRD
 * 3b-2 §4.5). Checked after `stoppedByOwner`: a stop wins. A run that already
 * ended on a cause of its own keeps it, as with the stop.
 */
function questionUnanswered(options: RunManifestOptions, state: RunState): boolean {
  if (options.questionWait?.unanswered !== true) return false;
  if (state.status !== 'running') return true;
  state.status = 'failed';
  state.error = options.questionWait.unansweredBecause === 'not_asked' ? WORKFLOW_QUESTION_NOT_ASKED_ERROR : WORKFLOW_QUESTION_UNANSWERED_ERROR;
  state.completedAt = new Date().toISOString();
  return true;
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

/**
 * Refuse a manifest whose approval gates this run cannot enforce.
 *
 * A declared gate reads as "this needs approval", so a gate that is silently not applied is the
 * dangerous failure: the step runs as if nobody had asked for one. Three cases, all checked
 * before the first step:
 *  - a `gate_points` entry that names no step in the manifest, which can never match;
 *  - no `gateAdapter` on this run: nothing can ask anyone, so `gate_points` and `tool_gates`
 *    would both be skipped;
 *  - `tool_gates` on a step whose runtime does not apply them. Only the `agent` runtime wraps
 *    tools with the adapter; `inline` and `pipeline` steps build their tools without it, so
 *    an adapter on the run does not help them.
 *
 * The adapter and runtime cases are refused at run time rather than in `validateManifest`
 * because the declaration itself is valid: a caller that passes an adapter gets gates on the
 * paths that apply them. Manifests built
 * inside this package (`buildManifest`, the nested pipeline manifest) declare neither field.
 */
function assertGatesEnforceable(manifest: Manifest, hasGateAdapter: boolean): void {
  const name = manifest.name ?? '(unnamed)';
  const gatePoints = manifest.gate_points ?? [];
  // A gate point is matched against step ids by exact string, so a typo is a gate that never
  // fires: the same silent skip as a missing adapter, with the adapter present.
  const stepIds = new Set(manifest.agents.map((s) => s.id));
  const unknown = gatePoints.filter((id) => !stepIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Manifest "${name}" declares gate_points for step ids that do not exist (${unknown.join(', ')}), ` +
      `so those gates would never fire. Steps in this manifest: ${[...stepIds].join(', ')}. ` +
      `Correct the ids or remove them from gate_points.`,
    );
  }
  if (!hasGateAdapter) {
    if (gatePoints.length > 0) {
      throw new Error(
        `Manifest "${name}" declares gate_points (${gatePoints.join(', ')}) but this run has no gateAdapter, ` +
        `so no approval could be asked for and the gates would be skipped. ` +
        `Pass a gateAdapter to runManifest, or remove gate_points.`,
      );
    }
  }
  for (const step of manifest.agents) {
    const toolGates = step.tool_gates ?? [];
    if (toolGates.length === 0) continue;
    if (step.runtime !== 'agent') {
      throw new Error(
        `Step "${step.id}" in manifest "${name}" declares tool_gates (${toolGates.join(', ')}) on the ` +
        `"${step.runtime}" runtime, which does not apply them, so those tools would run without approval. ` +
        `Use runtime "agent" for gated tools, or remove tool_gates from this step.`,
      );
    }
    if (!hasGateAdapter) {
      throw new Error(
        `Step "${step.id}" in manifest "${name}" declares tool_gates (${toolGates.join(', ')}) but this run ` +
        `has no gateAdapter, so those tools would run without approval. ` +
        `Pass a gateAdapter to runManifest, or remove tool_gates from this step.`,
      );
    }
  }
}

/**
 * Refuse `tool_gates` naming a tool the step's agent definition does not define.
 *
 * The `agent` runtime gates a tool by wrapping it in the list built from the definition, so a
 * name that matches nothing there is a declared approval that never applies: a typo, or a tool
 * the step gets from elsewhere. The provider-side `web_search` is one; the Agent can add it
 * itself (see `builtinTools` in `core/agent.ts`), outside that list, so it cannot be wrapped.
 *
 * Checked before the run starts, with the other gate checks, because the definitions do not
 * depend on any step's output: refusing at the step would come after earlier steps had acted.
 * Skipped when `mockResponses` is set, since every step then goes to `spawnMock` and no tool runs.
 */
async function assertToolGatesWrappable(manifest: Manifest, agentsDir: string): Promise<void> {
  for (const step of manifest.agents) {
    const gated = step.tool_gates ?? [];
    if (step.runtime !== 'agent' || gated.length === 0) continue;
    const agentDef = await loadAgentDef(step.agent, agentsDir);
    const defined = new Set((agentDef.tools ?? []).map((t) => t.name));
    const ungatable = gated.filter((name) => !defined.has(name));
    if (ungatable.length > 0) {
      throw new Error(
        `Step "${step.id}" declares tool_gates for ${ungatable.join(', ')}, which agent "${agentDef.name}" ` +
        `does not define, so no approval could be applied to them. Gate only tools listed in the agent ` +
        `definition.`,
      );
    }
  }
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

  assertGatesEnforceable(manifest, options.gateAdapter !== undefined);
  const agentsDir = options.agentsDir ?? config.agents_dir ?? join(process.cwd(), 'agents');
  if (options.mockResponses === undefined) await assertToolGatesWrappable(manifest, agentsDir);

  // Per-run prompt budget. Allocated only at the top-level run (depth === 0)
  // so sub-pipelines share the parent's cap; autonomous runs (no parent
  // prompt callbacks) skip budgeting entirely.
  let parentPrompt = options.parentPrompt;
  if (parentPrompt && !parentPrompt.promptBudget && depth === 0) {
    const limit = promptBudgetLimit(config.pipeline_prompt_budget);
    const budget = options.promptBudget ?? new PromptBudget(limit);
    parentPrompt = { ...parentPrompt, promptBudget: budget };
  }
  // Name the workflow on every prompt its steps raise. Unlike the budget this
  // is set at EVERY depth and overwrites a parent's: a step belongs to the
  // manifest that declares it, so a REAL nested workflow names itself rather
  // than the outer one, which would point the user at a step list that does not
  // contain the step asking.
  //
  // `originWorkflowName` is the exception, and it exists because that rule has a
  // blind spot: `spawnPipeline` wraps a composed step in a manifest called
  // `<stepId>-sub`, and preferring THAT swaps a name the user started for one
  // they have never seen. The caller that knows the manifest is synthetic says so.
  //
  // An empty name is dropped rather than carried. `validateManifest` requires
  // min(1), but `runManifest` does not itself validate, and a stored `''` would
  // travel all the way to the renderer as a workflow that asked and cannot be
  // named — which is the one thing the origin line must never say.
  if (parentPrompt) {
    const originName = options.originWorkflowName ?? manifest.name;
    parentPrompt = originName
      ? { ...parentPrompt, workflowName: originName }
      : { ...parentPrompt, workflowName: undefined };
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
  };

  // A caller that holds a claim on this run passes the id in; it cannot wait for one
  // minted here, because the claim is taken before the run and a run that throws before
  // answering returns no id at all.
  //
  // ⚠ Validated, because `runManifest` is a PUBLISHED export of this package, so this
  // option is public surface and the two failure modes are both silent:
  //  · `??` is nullish, so `{ runId: '' }` would run under the empty-string id rather
  //    than minting one — the same trap this repo has already paid for elsewhere.
  //  · a DUPLICATE id makes the start-INSERT below hit the `pipeline_runs` primary key,
  //    where it is swallowed as fire-and-forget; the finalize UPDATE then rewrites the
  //    OTHER run's row, which afterwards reads as "that workflow's completed run failed
  //    and cost nothing". Minting the id here made that state unreachable; accepting one
  //    from a caller is what makes it reachable, so the check belongs with the option.
  // Refused before `onRunStart` fires, so a rejected run never stamps a claim.
  if (options.runId !== undefined) {
    if (typeof options.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.runId)) {
      throw new Error('runManifest: `runId` must be a UUID when supplied.');
    }
    if (options.runHistory?.getPipelineRun(options.runId) !== undefined) {
      throw new Error(`runManifest: a run with id "${options.runId}" already exists — a supplied runId must be unused.`);
    }
  }
  const runId = options.runId ?? randomUUID();

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

  // ⚠ NOT wrapped in a try/catch, and that asymmetry against the guarded history writes
  // below is deliberate. The route's hook stamps its run claim as having spent something;
  // if a throw here were swallowed the run would proceed and spend while the claim still
  // read "nothing spent", so the request's own cleanup would release a paid claim and the
  // retry would pay twice. Failing the run before it spends is the safe direction. The
  // neighbouring comment at the start-INSERT says a history failure must never break the
  // run — that applies to the RECORD of a run, not to a gate that precedes it.
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
  // parent's runId (parent_run_id), so the top-level per-manifest views — the run
  // list, the cost aggregate and the step stats, all filtered to parent_run_id IS
  // NULL — keep it out while it stays reachable by id (invariant I6). The write is
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
        // Totals + step_count derive from the RECORDED step rows, never from
        // state.outputs: a stop-failed or GATE-REJECTED step gets a row but never
        // enters outputs (the catch halts first), so summing outputs would
        // under-count both the steps and the real spend — and leave the run row
        // disagreeing with its own /:id/steps list. `stepRows` is present exactly
        // when `rh` is (same gate), so this is the same set the rows were written from.
        const rows = stepRows ?? [];
        rh.updatePipelineRun(runId, {
          status: state.status,
          totalDurationMs: rows.reduce((s, o) => s + o.durationMs, 0),
          totalCostUsd: rows.reduce((s, o) => s + o.costUsd, 0),
          totalTokensIn: rows.reduce((s, o) => s + o.tokensIn, 0),
          totalTokensOut: rows.reduce((s, o) => s + o.tokensOut, 0),
          stepCount: rows.length,
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
    // The time the run spent waiting for its owner's answers is left out (G5 (a)): the
    // question's TTL bounds the wait, and only one clock may.
    const exceeded = workflowBoundExceeded(options.limits, startMs + (options.questionWait?.pausedMs() ?? 0), iterations, stepCounters);
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

/**
 * Run `fn` over `items` with at most `concurrency` in flight at once, returning
 * `PromiseSettledResult`s in INPUT order — a drop-in for
 * `Promise.allSettled(items.map(fn))` that bounds simultaneous execution.
 *
 * This is the backpressure seam for `runParallel`: a phase with N steps and
 * `limits.maxParallelSteps = K` launches at most K step agents at a time.
 *
 * Mirrors `Promise.allSettled` semantics exactly: every item runs to
 * completion (no fast-fail), rejections land as `{status:'rejected'}`, and the
 * caller evaluates halts AFTER the full set settles — so a gate-rejected
 * step's siblings still finish + record (the existing runParallel contract).
 */
async function mapAllSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++; // microtask-safe handout: JS is single-threaded,
      // so read+inc happens atomically between awaits — no two workers take the
      // same index.
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err };
      }
    }
  }
  const pool = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

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
    // The time the run spent waiting for its owner's answers is left out (G5 (a)): the
    // question's TTL bounds the wait, and only one clock may.
    const exceeded = workflowBoundExceeded(options.limits, startMs + (options.questionWait?.pausedMs() ?? 0), iterations, stepCounters);
    if (exceeded) {
      state.status = 'failed';
      state.error = exceeded;
      state.completedAt = new Date().toISOString();
      return;
    }
    iterations += phase.stepIds.length;
    options.hooks?.onPhaseStart?.(phase.phaseIndex, phase.stepIds);

    const runStep = (stepId: string): Promise<StepResult> => {
      const step = stepsById.get(stepId)!;
      return executeStep(step, manifest, state, config, agentsDir, options, stepCounters, stepRows);
    };
    // UNSET = unbounded: every step of the phase launches at once (the existing
    // v1.1 behaviour — the limit-less parallel test pins it). SET → bound
    // simultaneous execution via a worker pool.
    //
    // The normalization matters. This used to read `cap !== undefined && cap > 0`,
    // which lumped a MALFORMED value in with an absent one: `0`, `-1` and `NaN`
    // all failed `> 0` and fell through to the unbounded branch. A caller who
    // asks for a bound and supplies nonsense would then get FULL fan-out — the
    // one outcome a limiter must never produce. `parallelStepCapFor` maps a
    // present-but-malformed value to the tightest bound (1) instead.
    const cap = parallelStepCapFor(options.limits?.maxParallelSteps, 1);
    const settled = cap !== undefined
      ? await mapAllSettledWithConcurrency(phase.stepIds, cap, runStep)
      : await Promise.allSettled(phase.stepIds.map(runStep));

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
type StepRowAccumulator = Array<{
  rowId: number | bigint;
  result: string;
  /** The step's recorded spend. The run's finalize sums THESE (not state.outputs)
   *  so the run row and the /:id/steps list can never disagree: a stop-failed or
   *  gate-rejected step gets a row but never enters state.outputs, which would
   *  otherwise make the run under-count both its step_count and its real cost. */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}>;

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
  /** The band the step was RESOLVED to and charged at (`resolveRunModel().tier`).
   *  Undefined only where no model was ever resolved — a retry-cached step (its
   *  original row already carries the truth) and a condition-skipped one, neither
   *  of which ran. Those keep the declaration-based fallback below. */
  resolvedTier?: ModelTier | undefined,
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
      // F1: record the tier the step actually RAN on. This row feeds
      // getAvgStepCostByModelTier — a wrong tier here poisons the per-tier cost
      // estimate the plan preview shows, which is the number a user APPROVES in
      // the plan_task consent dialog (plan-task.ts). Also read by pipeline.ts and
      // process.ts for the same estimate.
      //
      // `resolvedTier` is preferred because `step.model` is the DECLARATION, and
      // under the headless deep-consent clamp the two differ by construction: an
      // autonomous run rewrites a `deep` request to `balanced` BEFORE resolution,
      // so the step runs and is billed at balanced while the declaration still
      // says deep. Stamping the declaration filed balanced-priced rows in the deep
      // bucket and dragged the deep average down — measured 2026-08-18 on a live
      // headless run, where a `deep` step cost $0.0002643 (minimax-m3, the
      // balanced slot) against $0.0011938 had it truly run deep, a factor of 4.5.
      // Agent/mock runtimes with no resolution keep the legacy fallback (their
      // tier lives in the AgentDef, which this record cannot see).
      modelTier: resolvedTier ?? step.model ?? (step.runtime === 'inline' ? undeclaredInlineStepTier(step) : 'balanced'),
    });
    acc.push({
      rowId, result: output.result,
      costUsd: output.costUsd, tokensIn: output.tokensIn,
      tokensOut: output.tokensOut, durationMs: output.durationMs,
    });
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

  // The owner's stop is read HERE, before each step — the one place every path reaches: the
  // next sequential step, the first step of the next phase, and a step of a wide phase the
  // pool hands out after the stop (the scope can only abort agents that already exist).
  if (stoppedByOwner(options, state)) return 'halt';
  if (questionUnanswered(options, state)) return 'halt';

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
  // The resolved BAND for the same step, hoisted alongside `stepModelId` and for
  // the same reason: both finalizers (success + catch) must stamp what RAN, and
  // the catch is the only place a gate-rejected step gets recorded at all.
  let stepModelTier: ModelTier | undefined;
  // Also hoisted: a step's real spend. A GATE-REJECTED step has already RUN and
  // cost money (the gate check happens AFTER the step completes) — but it throws
  // before `state.outputs.set`, so the catch is the only place that can record
  // what it actually cost. Left at 0 when the step throws before executing.
  let costUsd = 0;
  let stepTokensIn = 0;
  let stepTokensOut = 0;
  let stepDurationMs = 0;

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
    const persist = (stepRunId && options.runHistory) ? options.runHistory : undefined;
    const observe = options.observeToolCall;
    const recordToolCall: StepToolRecorder | undefined = (persist || observe)
      ? (call) => {
          if (persist) {
            try {
              persist.insertToolCall({
                runId: stepRunId!,
                toolName: call.toolName,
                inputJson: call.inputJson,
                outputJson: call.outputJson,
                durationMs: call.durationMs,
                sequenceOrder: toolSeq++,
              });
            } catch { /* best-effort: observability must never break the run */ }
          }
          if (observe) {
            try { observe(call); } catch { /* an observer never breaks the run */ }
          }
        }
      : undefined;

    let r: { result: string; tokensIn: number; tokensOut: number; durationMs: number };

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
      r = await spawnPipeline(step, stepContext, config, options.parentTools ?? [], options.depth ?? 0, options.parentPrompt, options.userTimezone, stepCounters, options.parentMemory ?? null, options.autonomy, options.capabilityContract, options.runHistory, options.secretStore, state.runId, options.runTaint, options.parentActiveScopes, options.abortScope, options.isAcceptedParam, options.principal, options.parentToolContext);
      costUsd = 0; // Cost comes from sub-pipeline steps (tracked individually)
    } else if (step.runtime === 'inline') {
      if (!options.parentTools) {
        throw new Error(`Step "${step.id}" uses inline runtime but no parentTools provided`);
      }
      // Resolve task + captured-call templates before execution. The prose task
      // resolves `{{params.*}}` with the untrusted-data boundary; the captured
      // `input_template` resolves the same params into the literal call the step
      // agent replays (no boundary — those are tool arguments, not prose).
      const resolvedTask = step.task ? resolveTaskTemplate(step.task, stepContext, options.isAcceptedParam) : step.task;
      const resolvedInputTemplate = step.input_template
        ? resolveInputTemplate(step.input_template, stepContext)
        : step.input_template;
      const resolvedStep =
        (resolvedTask !== step.task || resolvedInputTemplate !== step.input_template)
          ? { ...step, task: resolvedTask, input_template: resolvedInputTemplate }
          : step;
      // Check session budget before spawning step agent — same undeclared-tier
      // default as the spawn (F1), so the budget prices the model that runs.
      const stepModel = resolveModelForCost(step, undeclaredInlineStepTier(step), config, options.autonomy);
      stepModelId = stepModel; // A2: stamp the resolved model on the step run at finalize
      stepModelTier = resolveTierForCost(step, undeclaredInlineStepTier(step), config, options.autonomy); // …and its band

      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepCounters, stepEstimate);
      r = await spawnInline(resolvedStep, stepContext, config, options.parentTools, stepPreApproval, options.autonomy, options.parentToolContext, options.parentPrompt, options.userTimezone, options.parentMemory ?? null, options.capabilityContract, stepRunId, recordToolCall, options.secretStore, options.runTaint, options.parentActiveScopes, options.abortScope, options.principal);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(stepCounters, costUsd - stepEstimate); // correct estimate to actual
    } else {
      const agentDef = await loadAgentDef(step.agent, agentsDir);
      // Check session budget before spawning step agent
      const stepModel = resolveModelForCost(step, agentDef.defaultTier, config, options.autonomy);
      stepModelId = stepModel; // A2: stamp the resolved model on the step run at finalize
      stepModelTier = resolveTierForCost(step, agentDef.defaultTier, config, options.autonomy); // …and its band

      const stepEstimate = calculateCost(stepModel, { input_tokens: 40_000, output_tokens: 16_000 });
      checkSessionBudget(stepCounters, stepEstimate);
      r = await spawnViaAgent(step, agentDef, stepContext, config, options.gateAdapter, state.runId, stepPreApproval, options.autonomy, options.parentPrompt, options.userTimezone, options.capabilityContract, stepRunId, recordToolCall, options.secretStore, options.runTaint, options.abortScope, options.principal, options.parentToolContext);
      costUsd = calculateCost(stepModel, { input_tokens: r.tokensIn, output_tokens: r.tokensOut });
      adjustSessionCost(stepCounters, costUsd - stepEstimate); // correct estimate to actual
    }

    // The step has RUN — stamp its real spend on the hoisted vars so the catch
    // below can still record it if the gate rejects (which happens next).
    stepTokensIn = r.tokensIn;
    stepTokensOut = r.tokensOut;
    stepDurationMs = r.durationMs;

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
    if (stepRows && options.runHistory) recordStepRow(options.runHistory, state.runId, step, output, stepRows, stepModelTier);
    return 'ok';

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    options.hooks?.onError?.(step.id, error);
    // A2: finalize the step's progress row as failed (errorText is encrypted at
    // rest like response_text). The error also surfaces via state.error/outputs.
    if (stepRunId && options.runHistory) {
      try {
        options.runHistory.updateRun(stepRunId, {
          status: 'failed', errorText: error.message, toolCallCount: toolSeq, modelId: stepModelId,
          // Real spend of a step that RAN and was then rejected/failed (0 if it
          // threw before executing) — kept in sync with the step row below.
          costUsd, tokensIn: stepTokensIn, tokensOut: stepTokensOut, durationMs: stepDurationMs,
        });
      } catch { /* best-effort */ }
    }
    // 2a/B3: record the failed step in pipeline_step_results too (result=''), so
    // it shows in the /:id/steps list even under on_failure='stop', which halts
    // WITHOUT adding the step to state.outputs (the batch writer's blind spot).
    // Covers every caught mode (stop/notify/continue/gate) exactly once here —
    // carrying its REAL cost, which a gate-rejected step has already incurred.
    if (stepRows && options.runHistory) {
      recordStepRow(options.runHistory, state.runId, step, {
        stepId: step.id, result: '', startedAt: stepStart, completedAt: new Date().toISOString(),
        durationMs: stepDurationMs, tokensIn: stepTokensIn, tokensOut: stepTokensOut, costUsd,
        skipped: false, error: error.message,
      }, stepRows, stepModelTier);
    }

    // A step that failed while the owner's stop is out ended because of it (its agent was
    // aborted) or ends the run anyway: a stopped run does not carry on to the next step.
    if (stoppedByOwner(options, state)) return 'halt';
    if (questionUnanswered(options, state)) return 'halt';

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

/** Exported ONLY so a test can pin that the budget precheck + step-row stamp
 * price the model the run actually uses — including the headless deep-consent
 * rewrite. A ledger that names a different tier than the run is exactly the
 * announce≠run gap the shared-resolution work closed; no compiler check ties
 * this wiring, so a test has to. */
export function resolveModelForCost(step: ManifestStep, defaultTier: ModelTier, config: LynoxUserConfig, autonomy?: import('../types/index.js').AutonomyLevel | undefined): string {
  // Price the step against the SAME model the runtime-adapter ran it on — gate +
  // clamp + the ACTIVE provider — not an Anthropic-only tier map. A Mistral tenant
  // was previously billed at Claude prices (and a clamped deep step at deep prices).
  // The headless deep-consent override is applied here too, so the budget precheck
  // and the step-row stamp name the CLAMPED model, not the refused/announced deep
  // one (the run itself runs the clamped tier — the ledger must not disagree).
  //
  // That property was only half true until 2026-08-17, and the comment above
  // asserted it anyway. `resolveRunModel`'s tier branch answers with the BASE
  // provider's model for the tier — but under HYBRID routing the tier's slot is
  // what executes, and the two are different models at very different prices.
  // A tenant on the `efficient` preset ran Fireworks (minimax-m3, $0.30/$1.20)
  // and was priced at the base provider's balanced model (sonnet-5, $3/$15) —
  // a ~10x over-debit against their included budget, so they hit cost ceilings
  // they had not actually reached. Pre-existing, but this release made presets
  // CP-pinnable, which is what turns it from a corner case into the norm.
  //
  // A PINNED raw id is exempt: that id is the model that runs, so it is already
  // the right thing to charge. Only a tier has to be mapped through the active
  // routing — hence the `pinned` flag rather than re-deriving the branch here.
  const resolved = resolveStepRunModel(step, defaultTier, config, autonomy);
  // A config overlay from a profiled caller pins the step to the profile's model,
  // exactly where the runtime-adapter does: whenever the tier has no cross-provider
  // slot of its own (core/profile-pair.ts). Then that model is what runs and what
  // the ledger must name.
  const profilePinned = pinnedModelOfConfig(config);
  if (profilePinned && !resolveStepSlotCreds(config, resolved.tier).crossProviderSlot) return profilePinned;
  return resolved.pinned ? resolved.modelId : effectiveTierModelId(resolved.tier, getActiveProvider());
}

/**
 * The BAND {@link resolveModelForCost} priced the step at, for the durable step
 * row. Both read {@link resolveStepRunModel} with the same inputs, so they cannot
 * disagree — the resolution is pure config math, so calling it twice costs
 * nothing and keeps each function answering exactly one question.
 *
 * Split out on 2026-08-18: `recordStepRow` had no resolved value to stamp and
 * fell back to `step.model`, the DECLARED tier. Under the headless clamp those
 * differ by construction, and the row fed a cost average shown in a consent
 * dialog. See the note at the `modelTier` assignment.
 */
export function resolveTierForCost(
  step: ManifestStep,
  defaultTier: ModelTier,
  config: LynoxUserConfig,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
): ModelTier {
  return resolveStepRunModel(step, defaultTier, config, autonomy).tier;
}

/**
 * The one resolution both the PRICE and the recorded TIER read from, so they can
 * never name different bands for the same step. Split out of
 * {@link resolveModelForCost} on 2026-08-18: that function returned only the model
 * id, so `recordStepRow` had nothing to stamp and fell back to `step.model` — the
 * DECLARED tier. Under the headless clamp those differ by construction: a step
 * declaring `deep` runs on `balanced`, and the row said `deep`.
 *
 * Deriving the tier from the resolved MODEL ID instead would reintroduce the bug
 * with the opposite sign. Under a hybrid tier_set a slot holds whatever model the
 * set names, and the registry tier of that model need not equal the slot it fills:
 * in the `balanced` preset the balanced slot holds `glm-5p2`, which the registry
 * bands as `deep`. `resolveRunModel().tier` is the band that was actually charged
 * and clamped against `max_tier`; the model id is one mapping further downstream.
 */
function resolveStepRunModel(
  step: ManifestStep,
  defaultTier: ModelTier,
  config: LynoxUserConfig,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
): ReturnType<typeof resolveRunModel> {
  return resolveRunModel({
    requested: headlessStepModelOverride(step.model, defaultTier, autonomy),
    defaultTier,
    accountTier: config.account_tier,
    maxTier: config.max_tier,
    blockedModelIds: config.blocked_model_ids,
    provider: getActiveProvider(),
  });
}
