import type { InlinePipelineStep, PipelineMode } from '../types/index.js';

/**
 * Tools that can only run while a live, prompt-capable session exists.
 *
 * Why: each of these calls back into the parent session's `promptUser` /
 * `promptSecret` to ask the user something. In an autonomous (cron / API
 * triggered) run there is no chat session, so the call would either throw
 * or — worse — silently hang. The save-time validator and scheduler use
 * this set to enforce the contract before runtime.
 */
export const HUMAN_IN_THE_LOOP_TOOLS = ['ask_user', 'ask_secret', 'ask_human'] as const;

const HITL_SET = new Set<string>(HUMAN_IN_THE_LOOP_TOOLS);

/**
 * Best-effort scan of a pipeline step for human-in-the-loop tool references.
 * Pipelines today don't carry an explicit per-step tool surface — sub-agents
 * inherit a shared core set — so we look at the step's textual fields.
 *
 * False-positives are conservative: a step that mentions ask_user in a task
 * description is treated as needing interactive mode. That's the right
 * default — the operator can override `mode` explicitly.
 */
export function stepUsesHumanInTheLoopTool(step: InlinePipelineStep): string | null {
  const haystack = step.task ?? '';
  for (const tool of HUMAN_IN_THE_LOOP_TOOLS) {
    if (haystack.includes(tool)) return tool;
  }
  return null;
}

/**
 * Infer a pipeline mode for legacy stored pipelines that have no mode field.
 * If any step references a human-in-the-loop tool → 'interactive'; else
 * 'autonomous'. The caller is expected to log a one-shot warn for the
 * 'interactive' branch so operators can flip pipelines that were intended
 * as cron jobs and silently broken before this PR.
 */
export function inferPipelineMode(steps: InlinePipelineStep[]): PipelineMode {
  for (const step of steps) {
    if (stepUsesHumanInTheLoopTool(step)) return 'interactive';
  }
  return 'autonomous';
}

export interface AutonomousValidationIssue {
  stepId: string;
  tool: string;
  message: string;
}

/**
 * Walk every step's textual surface and flag uses of human-in-the-loop
 * tools. Returns one issue per offending step (the first match per step).
 */
export function findAutonomousViolations(steps: InlinePipelineStep[]): AutonomousValidationIssue[] {
  const issues: AutonomousValidationIssue[] = [];
  for (const step of steps) {
    const tool = stepUsesHumanInTheLoopTool(step);
    if (tool) {
      issues.push({
        stepId: step.id,
        tool,
        message: `Step "${step.id}" uses ${tool}, but the pipeline is marked autonomous. Either remove the human-in-the-loop tool from this step or change the pipeline mode to 'interactive'.`,
      });
    }
  }
  return issues;
}

/** Public helper used by the validator + scheduler. */
export function isHumanInTheLoopTool(name: string): boolean {
  return HITL_SET.has(name);
}
