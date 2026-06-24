// === Pipeline ===

import type { ModelTier, ThinkingHint, EffortLevel } from './models.js';
import type { CapabilityContract } from './capability-contract.js';

/**
 * Per-workflow resource bounds for unattended (headless/autonomous) runs — the
 * DoS guard the entry-only `checkPersistentBudget` can't provide (PRD §4.2 S3).
 * Enforced *inside* the run, between steps, by `runManifest`. Stored on the
 * `PlannedPipeline` JSON blob; headless runs apply conservative defaults when a
 * field is unset (`resolveHeadlessLimits`). The primary guard is wall-clock —
 * it terminates a non-terminating run without capping legitimate spend (research
 * workflows are legitimately expensive; spend is bounded by the tenant-level
 * `checkPersistentBudget`, with `maxSpendUsd` an opt-in tighter per-run cap).
 */
export interface WorkflowLimits {
  /** Abort once this much wall-clock elapsed (checked between steps). */
  maxWallClockMs?: number | undefined;
  /** Abort once this many steps have executed (backstop above MAX_STEPS). */
  maxIterations?: number | undefined;
  /** Abort once cumulative run cost exceeds this (opt-in; unset = no per-run cap). */
  maxSpendUsd?: number | undefined;
}

export interface InlinePipelineStep {
  id: string;
  task: string;
  model?: ModelTier | undefined;
  /** Thinking mode hint for this step. Capability-checked at spawn time (e.g. Haiku ignores 'adaptive'). */
  thinking?: ThinkingHint | undefined;
  /** Effort level for this step. */
  effort?: EffortLevel | undefined;
  /** Role for agent specialization. Used by YAML manifests — not exposed to LLM. */
  role?: string | undefined;
  input_from?: string[] | undefined;
  timeout_ms?: number | undefined;
  /**
   * Deterministic-replay pair (captured workflows only). When a step was
   * promoted from a captured tool call, `tool` is the literal tool name and
   * `input_template` the literal input object (with `{{params.<name>}}`
   * placeholders for re-targetable values). At run time the runner substitutes
   * the bound params into `input_template` and instructs the step agent to
   * execute exactly that call — replacing prose re-interpretation with a literal
   * replay. Absent on hand-authored/plan_task steps, which run as prose tasks.
   */
  tool?: string | undefined;
  input_template?: Record<string, unknown> | undefined;
}

export interface PipelineStepResult {
  stepId: string;
  result: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped: boolean;
  skipReason?: string | undefined;
  error?: string | undefined;
}

export interface PipelineResult {
  pipelineId: string;
  name: string;
  status: 'completed' | 'failed' | 'rejected';
  steps: PipelineStepResult[];
  totalDurationMs: number;
  totalCostUsd: number;
}

export type PipelineExecutionMode = 'tracked' | 'orchestrated';

/**
 * Pipeline interaction mode.
 * - 'interactive' allows human-in-the-loop tools (ask_user, ask_secret) and
 *   only runs from a live chat session.
 * - 'autonomous' bans those tools at save time and is the only mode the
 *   scheduler / WorkerLoop will run on a cron / API trigger.
 */
export type PipelineMode = 'interactive' | 'autonomous';

export interface PlannedPipeline {
  id: string;
  name: string;
  goal: string;
  steps: InlinePipelineStep[];
  reasoning: string;
  estimatedCost: number;
  createdAt: string;
  executed: boolean;
  /**
   * Legacy execution-mode marker. Retained on the type (no migration) so old
   * stored rows still deserialize; new pipelines always run through the
   * orchestrator and are written `'orchestrated'`. No code branches on this
   * field anymore — the `'tracked'` path was removed (D9). Legacy rows
   * carrying `'tracked'` are inert.
   */
  executionMode: PipelineExecutionMode;
  /** Template pipelines can be re-executed (for scheduling) */
  template: boolean;
  /**
   * Interaction contract.
   * - 'interactive' = sub-agents may call ask_user / ask_secret; requires a live chat session.
   * - 'autonomous' = no human-in-the-loop tools; eligible for cron / WorkerLoop.
   * Defaulted on read for legacy entries (see `tools/builtin/pipeline.ts#getPipeline`).
   */
  mode: PipelineMode;
  /**
   * Failure strategy honoured by headless runs (`runSavedWorkflow`): `'stop'`
   * halts at the first failed step, `'continue'` runs the rest, `'notify'`
   * continues + flags. Round-trips for free (the whole pipeline is
   * JSON-stringified by `insertPlannedPipeline`) and is backfilled to `'stop'`
   * on read for legacy rows. The in-session `run_workflow` tool still honours
   * its per-call `on_failure` input; this is the stored default for unattended
   * runs that have no caller input. A producer that sets a non-`'stop'` value
   * (the edit-via-chat tool) lands in Slice C; the consumer is wired here so the
   * headless path stops hardcoding `'stop'`.
   */
  on_failure?: 'stop' | 'continue' | 'notify' | undefined;
  /**
   * Re-target schema for the saved workflow — the parameters a caller supplies
   * at run time (`{{params.<name>}}` placeholders resolve against these). Lifted
   * here from the capture's `ProcessRecord.parameters` so a saved template
   * carries its own re-target contract (binding, validation, the run UI form all
   * read it). Round-trips for free — `insertPlannedPipeline` JSON-stringifies the
   * whole pipeline — and is backfilled to `[]` on read for legacy rows
   * (`tools/builtin/pipeline.ts#backfillPlannedPipelineDefaults`).
   */
  parameters: ProcessParameter[];
  /**
   * Capability contract authorising this workflow's headless outbound writes
   * (PRD §4.2). Absent = the safe autonomous-deny default (no outbound writes
   * headless). Stored on this blob (PRD §8.1) so save→confirm→run is one seam;
   * enforced per-tool-call at `isDangerous`. Round-trips for free
   * (`insertPlannedPipeline` JSON-stringifies the whole pipeline); absent on
   * legacy rows. Validated at save by `validateContractAgainstSteps` (every
   * re-targetable param that flows into a tool call must be constrained).
   */
  capabilityContract?: CapabilityContract | undefined;
  /**
   * First-run-confirm timestamp (PRD §4.2 S2). Set once by a human at
   * promote-to-cron after they've seen the resolved contract. **B1 defines this
   * field as part of the storage seam; the scheduling surface that enforces it
   * (refusing to schedule a contract-governed workflow whose `confirmedAt` is
   * absent) is Slice B2** — until then there is no product path that writes a
   * `capabilityContract` onto a saved workflow, so the gate is not yet
   * load-bearing. Capture-time presence of a contract does NOT authorise
   * unattended-N-times; this explicit human action does.
   */
  confirmedAt?: string | undefined;
  /**
   * Per-workflow DoS bounds for unattended runs (PRD §4.2 S3). Absent fields
   * fall back to conservative headless defaults at run time
   * (`resolveHeadlessLimits`). Round-trips on the blob.
   */
  limits?: WorkflowLimits | undefined;
}

// === Process Capture ===

export type ProcessParameterSource = 'user_input' | 'relative_date' | 'context';

export interface ProcessParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'date';
  defaultValue?: unknown;
  source: ProcessParameterSource;
}

export interface ProcessStep {
  order: number;
  tool: string;
  description: string;
  inputTemplate: Record<string, unknown>;
  dependsOn?: number[] | undefined;
}

export interface ProcessRecord {
  id: string;
  name: string;
  description: string;
  sourceRunId: string;
  steps: ProcessStep[];
  parameters: ProcessParameter[];
  createdAt: string;
  promotedToPipelineId?: string | undefined;
}

// === Task Management ===

export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;      // 'user', 'lynox', or custom name
  scope_type: string;
  scope_id: string;
  due_date: string | null;
  tags: string | null;           // JSON array
  parent_task_id: string | null; // one-level subtasks
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  schedule_cron?: string | undefined;
  next_run_at?: string | undefined;
  last_run_at?: string | undefined;
  last_run_result?: string | undefined;
  last_run_status?: string | undefined;
  task_type?: string | undefined;
  watch_config?: string | undefined;
  max_retries?: number | undefined;
  retry_count?: number | undefined;
  notification_channel?: string | undefined;
  pipeline_id?: string | undefined;
}
