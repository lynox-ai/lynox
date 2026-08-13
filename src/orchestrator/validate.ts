import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { validateGraph } from './graph.js';
import type { Manifest } from '../types/orchestration.js';
import type { InlinePipelineStep, PipelineMode, PlannedPipeline } from '../types/index.js';
import { findAutonomousViolations } from './human-in-the-loop.js';
import { INLINE_CORE_TOOLS } from './runtime-adapter.js';

/**
 * Default policy ceiling on workflow steps. The run-path enforcement points in
 * `pipeline.ts` read this via {@link maxStepsFor}, which lets a config override
 * (`max_workflow_steps`) raise it for a tenant that runs large bulk workflows
 * (e.g. a 2000-contact triage needing >20 batch steps).
 *
 * Lives here (the lower-level validation module) so the manifest schema and the
 * imperative checks in `pipeline.ts` share one constant without an import cycle.
 */
export const MAX_STEPS = 20;

/**
 * Absolute schema-level sanity ceiling. The `.max()` on the manifest schema
 * guards against pathological/accidental manifests (a generated workflow with
 * thousands of steps) regardless of config. The *policy* cap (config-overridable,
 * default {@link MAX_STEPS}) is enforced imperatively in `pipeline.ts`, which is
 * the only place a run can see the resolved config.
 */
export const ABSOLUTE_MAX_STEPS = 1000;

/**
 * Resolve the per-run step cap from config, defaulting to {@link MAX_STEPS}.
 * Structural on the config so this low-level module need not depend on the full
 * LynoxUserConfig type. Used by the run-path enforcement in `pipeline.ts`.
 */
export function maxStepsFor(config?: { max_workflow_steps?: number | undefined } | undefined): number {
  return config?.max_workflow_steps ?? MAX_STEPS;
}

const ConditionOperators = ['lt', 'gt', 'eq', 'neq', 'gte', 'lte', 'exists', 'not_exists', 'contains'] as const;

const ManifestConditionSchema = z.object({
  path: z.string().min(1),
  operator: z.enum(ConditionOperators),
  value: z.unknown().optional(),
});

const ManifestStepSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  runtime: z.enum(['agent', 'mock', 'inline', 'pipeline']),
  task: z.string().optional(),
  model: z.string().optional(),
  // Declared tool set (F2/D2) — schema'd so validation preserves it; zod
  // strips unknown keys, and loadManifestFile USES the validated result.
  tools: z.array(z.string()).optional(),
  // Deterministic-replay pair — schema'd so validation preserves (not strips)
  // the literal captured call carried on a promoted step.
  tool: z.string().optional(),
  input_template: z.record(z.string(), z.unknown()).optional(),
  input_from: z.array(z.string()).optional(),
  conditions: z.array(ManifestConditionSchema).optional(),
  timeout_ms: z.number().positive().optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  tool_gates: z.array(z.string()).optional(),
  pre_approve: z.array(z.object({
    tool: z.string().min(1),
    pattern: z.string().min(1),
    risk: z.enum(['low', 'medium', 'high']).optional(),
  })).optional(),
  pipeline: z.union([z.string(), z.array(z.object({
    id: z.string().min(1),
    task: z.string().min(1),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    input_from: z.array(z.string()).optional(),
    conditions: z.array(ManifestConditionSchema).optional(),
    timeout_ms: z.number().positive().optional(),
  }))]).optional(),
});

const ManifestSchema_1_0 = z.object({
  manifest_version: z.literal('1.0'),
  name: z.string().min(1),
  triggered_by: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
  agents: z.array(ManifestStepSchema).min(1).max(ABSOLUTE_MAX_STEPS),
  gate_points: z.array(z.string()).default([]),
  on_failure: z.enum(['stop', 'continue', 'notify']).default('stop'),
});

const ManifestSchema_1_1 = z.object({
  manifest_version: z.literal('1.1'),
  name: z.string().min(1),
  triggered_by: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
  agents: z.array(ManifestStepSchema).min(1).max(ABSOLUTE_MAX_STEPS),
  gate_points: z.array(z.string()).default([]),
  on_failure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  execution: z.enum(['sequential', 'parallel']).default('parallel'),
});

const ManifestSchema = z.discriminatedUnion('manifest_version', [
  ManifestSchema_1_0,
  ManifestSchema_1_1,
]);

export function validateManifest(raw: unknown): Manifest {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map(e => `${e.path.map(String).join('.')}: ${e.message}`).join('; ');
    throw new Error(`Invalid manifest: ${msg}`);
  }
  const manifest = result.data as Manifest;

  // Inline runtime requires task field
  for (const step of manifest.agents) {
    if (step.runtime === 'inline' && !step.task) {
      throw new Error(`Invalid manifest: agents.${step.id}: "task" is required when runtime is "inline"`);
    }
    if (step.runtime === 'pipeline' && !step.pipeline) {
      throw new Error(`Invalid manifest: agents.${step.id}: "pipeline" is required when runtime is "pipeline"`);
    }
    // F2/D2: a typo'd declared tool on an inline step must fail HERE, not
    // degrade to a silent "Tool not available" at dispatch — this is the gate
    // for YAML manifests and raw run_workflow steps, the same one
    // assertPlannedPipelineIsValid applies to stored plans.
    if (step.runtime === 'inline') {
      const issue = declaredToolIssue(step);
      if (issue) throw new Error(`Invalid manifest: ${issue}`);
    }
    if (step.runtime === 'pipeline' && Array.isArray(step.pipeline)) {
      for (const nested of step.pipeline) {
        const issue = declaredToolIssue(nested);
        if (issue) throw new Error(`Invalid manifest: ${issue}`);
      }
    }
  }

  // v1.1: validate dependency graph
  if (manifest.manifest_version === '1.1') {
    validateGraph(manifest.agents);
  }

  return manifest;
}

export function loadManifestFile(filePath: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
  return validateManifest(raw);
}

/**
 * Error thrown when a pipeline marked autonomous references human-in-the-loop
 * tools. Carries the per-step issues so the caller can surface a precise
 * error message in API responses / save dialogs.
 */
export class AutonomousPipelineViolation extends Error {
  constructor(public readonly issues: ReadonlyArray<{ stepId: string; tool: string; message: string }>) {
    super(
      issues.length === 1
        ? issues[0]!.message
        : `Pipeline marked autonomous but ${issues.length} steps reference human-in-the-loop tools:\n` +
          issues.map(i => `  - ${i.message}`).join('\n'),
    );
    this.name = 'AutonomousPipelineViolation';
  }
}

/**
 * Save-time gate: throw AutonomousPipelineViolation if `mode === 'autonomous'`
 * and any step references ask_user / ask_secret / ask_human. Interactive
 * pipelines are unrestricted.
 *
 * Called by plan_task, save_workflow, the future Workflows editor save
 * endpoint, and again at WorkerLoop scheduler-registration time.
 */
export function assertPipelineModeIsValid(steps: InlinePipelineStep[], mode: PipelineMode): void {
  if (mode === 'interactive') return;
  const issues = findAutonomousViolations(steps);
  if (issues.length > 0) throw new AutonomousPipelineViolation(issues);
}

/**
 * Save-time gate (F2/D2): a declared tool name that is not in the inline pool
 * is a generator bug — fail LOUD at save, not silently at dispatch ("Tool not
 * available" mid-run is how four unexplainable approval dialogs reached a
 * customer). Steps that declare nothing pass (legacy manifests keep working
 * and get the bash-less default pool at run time). An empty declared array is
 * valid — it means "no tools". A captured replay step's `tool` is deliberately
 * NOT pool-checked here: captured workflows legitimately carry non-pool tools,
 * and the runtime already degrades an ungranted replay to the prose task (the
 * allowlist stays the boundary — see the replay gate in runtime-adapter). What
 * IS rejected is a declaration that contradicts its own replay tool: both
 * fields present but `tool` outside `tools` is a generator bug, new data only.
 */
function declaredToolIssue(step: { id: string; tools?: string[] | undefined; tool?: string | undefined }): string | undefined {
  if (!step.tools) return undefined;
  const unknown = step.tools.filter(name => !INLINE_CORE_TOOLS.has(name));
  if (unknown.length > 0) {
    return `Step "${step.id}" declares unknown tool(s): ${unknown.join(', ')}. ` +
      `Declarable tools: ${[...INLINE_CORE_TOOLS].join(', ')}.`;
  }
  if (step.tool !== undefined && !step.tools.includes(step.tool)) {
    return `Step "${step.id}" replays tool "${step.tool}" but its declared tools (${step.tools.join(', ') || 'none'}) exclude it.`;
  }
  return undefined;
}

export function assertDeclaredToolsAreValid(steps: InlinePipelineStep[]): void {
  for (const step of steps) {
    const issue = declaredToolIssue(step);
    if (issue) throw new Error(issue);
  }
}

/** Convenience overload that takes a stored PlannedPipeline. */
export function assertPlannedPipelineIsValid(planned: PlannedPipeline): void {
  assertPipelineModeIsValid(planned.steps, planned.mode);
  assertDeclaredToolsAreValid(planned.steps);
}
