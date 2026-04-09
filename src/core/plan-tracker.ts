/**
 * Tracked plan execution — manages the active plan state on ToolContext.
 * Plans are tracked in-memory during execution and batch-persisted on finalization.
 */

import type { ActiveTrackedPlan, TrackedStepResult, ToolContext, StreamHandler, PlannedPipeline } from '../types/index.js';
import type { RunHistory } from './run-history.js';

/** Start tracking a plan. Sets toolContext.activePlan and emits pipeline_start. */
export function startTrackedPlan(
  planned: PlannedPipeline,
  toolContext: ToolContext,
): ActiveTrackedPlan {
  const plan: ActiveTrackedPlan = {
    pipelineId: planned.id,
    name: planned.name,
    goal: planned.goal,
    steps: planned.steps.map(s => ({
      id: s.id,
      task: s.task,
      inputFrom: s.input_from,
    })),
    startedAt: new Date().toISOString(),
    stepResults: new Map(),
  };

  toolContext.activePlan = plan;

  // Emit pipeline_start SSE event so the UI shows the PipelineProgress component
  emitIfHandler(toolContext.streamHandler, {
    type: 'pipeline_start',
    pipelineId: plan.pipelineId,
    name: plan.name,
    steps: plan.steps.map(s => ({
      id: s.id,
      task: s.task,
      inputFrom: s.inputFrom,
    })),
    agent: 'pipeline',
  });

  return plan;
}

/** Record a step completion. Emits pipeline_progress SSE event. */
export function recordStepComplete(
  stepId: string,
  summary: string,
  status: 'completed' | 'failed' | 'skipped',
  toolContext: ToolContext,
): { completed: number; total: number } | null {
  const plan = toolContext.activePlan;
  if (!plan) return null;

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return null;

  const now = new Date().toISOString();
  const prevResult = plan.stepResults.get(stepId);
  const startedAt = prevResult?.startedAt ?? plan.startedAt;

  const result: TrackedStepResult = {
    stepId,
    status,
    summary,
    startedAt,
    completedAt: now,
    durationMs: new Date(now).getTime() - new Date(startedAt).getTime(),
  };

  plan.stepResults.set(stepId, result);

  // Emit pipeline_progress SSE event
  emitIfHandler(toolContext.streamHandler, {
    type: 'pipeline_progress',
    stepId,
    status,
    detail: summary,
    durationMs: result.durationMs,
    agent: 'pipeline',
  });

  return {
    completed: plan.stepResults.size,
    total: plan.steps.length,
  };
}

/** Mark a step as started (for elapsed time tracking in the UI). */
export function markStepStarted(
  stepId: string,
  toolContext: ToolContext,
): void {
  const plan = toolContext.activePlan;
  if (!plan) return;

  // Pre-create a result entry so we track the start time
  if (!plan.stepResults.has(stepId)) {
    plan.stepResults.set(stepId, {
      stepId,
      status: 'completed', // will be overwritten by recordStepComplete
      summary: '',
      startedAt: new Date().toISOString(),
      completedAt: '',
      durationMs: 0,
    });
  }

  emitIfHandler(toolContext.streamHandler, {
    type: 'pipeline_progress',
    stepId,
    status: 'started',
    detail: stepId,
    agent: 'pipeline',
  });
}

/** Check if all steps are done and finalize if so. Returns true if finalized. */
export function checkAndFinalize(
  toolContext: ToolContext,
  runHistory: RunHistory | null,
): boolean {
  const plan = toolContext.activePlan;
  if (!plan) return false;

  const allDone = plan.steps.every(s => plan.stepResults.has(s.id));
  if (!allDone) return false;

  finalizeTrackedPlan(toolContext, runHistory);
  return true;
}

/** Batch-persist all step results to RunHistory and clear the active plan. */
export function finalizeTrackedPlan(
  toolContext: ToolContext,
  runHistory: RunHistory | null,
): void {
  const plan = toolContext.activePlan;
  if (!plan) return;

  const now = new Date().toISOString();
  const totalDurationMs = new Date(now).getTime() - new Date(plan.startedAt).getTime();
  const hasErrors = [...plan.stepResults.values()].some(r => r.status === 'failed');

  // Persist to RunHistory (same tables as run_pipeline)
  if (runHistory) {
    try {
      runHistory.insertPipelineRun({
        id: plan.pipelineId,
        manifestName: plan.name,
        status: hasErrors ? 'failed' : 'completed',
        manifestJson: JSON.stringify({
          name: plan.name,
          goal: plan.goal,
          steps: plan.steps,
          executionMode: 'tracked',
        }),
        totalDurationMs,
        totalCostUsd: 0, // Cost lives on the parent session run
        totalTokensIn: 0,
        totalTokensOut: 0,
        stepCount: plan.steps.length,
        error: hasErrors ? 'One or more steps failed' : undefined,
      });

      for (const result of plan.stepResults.values()) {
        runHistory.insertPipelineStepResult({
          pipelineRunId: plan.pipelineId,
          stepId: result.stepId,
          status: result.status,
          result: result.summary,
          error: result.status === 'failed' ? result.summary : undefined,
          durationMs: result.durationMs,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        });
      }
    } catch {
      // Fire-and-forget — don't break the session if persistence fails
    }
  }

  // Clear active plan
  toolContext.activePlan = null;
}

/** Get the active tracked plan (convenience accessor). */
export function getActivePlan(toolContext: ToolContext): ActiveTrackedPlan | null {
  return toolContext.activePlan;
}

// --- Helpers ---

function emitIfHandler(handler: StreamHandler | null, event: Record<string, unknown>): void {
  if (handler) {
    void handler(event as never);
  }
}
