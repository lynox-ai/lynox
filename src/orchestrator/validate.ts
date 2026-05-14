import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { validateGraph } from './graph.js';
import type { Manifest } from '../types/orchestration.js';
import type { InlinePipelineStep, PipelineMode, PlannedPipeline } from '../types/index.js';
import { findAutonomousViolations } from './human-in-the-loop.js';

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
  agents: z.array(ManifestStepSchema).min(1),
  gate_points: z.array(z.string()).default([]),
  on_failure: z.enum(['stop', 'continue', 'notify']).default('stop'),
});

const ManifestSchema_1_1 = z.object({
  manifest_version: z.literal('1.1'),
  name: z.string().min(1),
  triggered_by: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
  agents: z.array(ManifestStepSchema).min(1),
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
 * Called by plan_task, promote_process, the future Workflows editor save
 * endpoint, and again at WorkerLoop scheduler-registration time.
 */
export function assertPipelineModeIsValid(steps: InlinePipelineStep[], mode: PipelineMode): void {
  if (mode === 'interactive') return;
  const issues = findAutonomousViolations(steps);
  if (issues.length > 0) throw new AutonomousPipelineViolation(issues);
}

/** Convenience overload that takes a stored PlannedPipeline. */
export function assertPlannedPipelineIsValid(planned: PlannedPipeline): void {
  assertPipelineModeIsValid(planned.steps, planned.mode);
}
