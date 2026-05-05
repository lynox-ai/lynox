import type { InlinePipelineStep, PipelineMode } from '../types/index.js';

export const HUMAN_IN_THE_LOOP_TOOLS = ['ask_user', 'ask_secret', 'ask_human'] as const;

const HITL_SET = new Set<string>(HUMAN_IN_THE_LOOP_TOOLS);

// Word-boundary so `ask_users` / `task_user` don't match. `_` is a word char,
// so `\b` anchors cleanly around each tool name.
const HITL_REGEXES: ReadonlyArray<readonly [string, RegExp]> =
  HUMAN_IN_THE_LOOP_TOOLS.map((name) => [name, new RegExp(`\\b${name}\\b`)] as const);

export function stepUsesHumanInTheLoopTool(step: InlinePipelineStep): string | undefined {
  const haystack = step.task ?? '';
  for (const [name, re] of HITL_REGEXES) {
    if (re.test(haystack)) return name;
  }
  return undefined;
}

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

export function isHumanInTheLoopTool(name: string): boolean {
  return HITL_SET.has(name);
}
