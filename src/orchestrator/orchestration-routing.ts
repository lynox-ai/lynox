/**
 * O7 — Cheap Sub-Agent Routing classifier.
 *
 * Phase 3 of the Agent-Efficiency PRD (`PRD-AGENT-EFFICIENCY.md` §9). A
 * multi-step plan approved through `plan_task` historically always ran
 * **tracked** — inline on the main Sonnet loop, where the main agent works
 * the checklist itself via `step_complete`. That is the expensive turn-class:
 * raw tool results accumulate in one ever-growing context (the §2
 * 460k-token workflow turn) and per-step `model` hints are ignored because
 * there is no sub-agent to apply them to.
 *
 * The **orchestrated** path (`runManifest`) instead isolates every step as a
 * fresh agent with its own context + per-step model. This classifier decides
 * which plans should take that path.
 *
 * Pure function — no side effects — so it is directly unit-testable.
 */

import type { InlinePipelineStep, ModelTier } from '../types/index.js';

/**
 * Model tiers considered "cheap" for routing purposes. A step that explicitly
 * carries one of these tiers signals the planner wants it to run on a cheap
 * model — which only actually happens on the orchestrated path, where the
 * runner resolves `step.model` via `resolveModelForCost`. On the tracked
 * (inline-on-main) path a per-step model is inert because the work runs on
 * the main Sonnet loop.
 *
 * `haiku` is the cheap tier in the `ModelTier` space; under the Mistral
 * tier-set it resolves to `mistral-small-2603` (the cheap orchestration
 * model), so the routing decision stays correct provider-agnostically.
 */
export const CHEAP_MODEL_TIERS: ReadonlySet<ModelTier> = new Set<ModelTier>(['haiku']);

/**
 * Minimum number of independent (parallelisable) steps that, on their own,
 * justify routing a plan to the orchestrated runner. A plan with this many
 * dependency-free steps benefits from real parallelism + per-step context
 * isolation; smaller / mostly-sequential plans are fine inline.
 */
export const MIN_INDEPENDENT_STEPS_FOR_ORCHESTRATION = 3;

/** True when the step carries no upstream dependency (parallelisable). */
function isIndependentStep(step: InlinePipelineStep): boolean {
  return !step.input_from || step.input_from.length === 0;
}

/** True when the step explicitly carries a cheap-tier model. */
function carriesCheapTier(step: InlinePipelineStep): boolean {
  return step.model !== undefined && CHEAP_MODEL_TIERS.has(step.model);
}

/**
 * O7 auto-trigger. A plan runs **orchestrated** when either:
 *   - it has ≥ {@link MIN_INDEPENDENT_STEPS_FOR_ORCHESTRATION} independent
 *     steps (steps with no `input_from` dependency — i.e. parallelisable), OR
 *   - any step carries a cheap-tier `model`.
 *
 * Otherwise the plan stays **tracked** (inline on the main loop) — small /
 * sequential plans do not pay the sub-agent cold-start overhead.
 *
 * @param steps pipeline steps (post `phasesToPipelineSteps` conversion).
 */
export function shouldRunOrchestrated(steps: readonly InlinePipelineStep[]): boolean {
  if (steps.length === 0) return false;

  if (steps.some(carriesCheapTier)) return true;

  const independentCount = steps.reduce(
    (count, step) => (isIndependentStep(step) ? count + 1 : count),
    0,
  );
  return independentCount >= MIN_INDEPENDENT_STEPS_FOR_ORCHESTRATION;
}
