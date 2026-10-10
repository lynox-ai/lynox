import type { InlinePipelineStep, PipelineMode } from '../types/index.js';

export const HUMAN_IN_THE_LOOP_TOOLS = ['ask_user', 'ask_secret', 'ask_human'] as const;

const HITL_SET = new Set<string>(HUMAN_IN_THE_LOOP_TOOLS);

// Word-boundary so `ask_users` / `task_user` don't match. `_` is a word char,
// so `\b` anchors cleanly around each tool name.
const HITL_REGEXES: ReadonlyArray<readonly [string, RegExp]> =
  HUMAN_IN_THE_LOOP_TOOLS.map((name) => [name, new RegExp(`\\b${name}\\b`)] as const);

export function stepUsesHumanInTheLoopTool(step: InlinePipelineStep): string | undefined {
  // A captured replay step's literal tool is the strongest signal — it WILL
  // call exactly that tool.
  if (step.tool !== undefined && HITL_SET.has(step.tool)) return step.tool;
  // A declared tool set (F2) is AUTHORITATIVE, in both directions: a step that
  // declared ask_user needs a human even if its task prose never names the
  // tool — and a step whose declaration excludes it CANNOT call it (the
  // runtime grants only declared names), so a prose mention must not classify
  // the pipeline interactive.
  if (step.tools) {
    for (const name of step.tools) {
      if (HITL_SET.has(name)) return name;
    }
    return undefined;
  }
  // Undeclared (legacy) steps: prose scan, the pre-F2 heuristic.
  const haystack = step.task ?? '';
  for (const [name, re] of HITL_REGEXES) {
    if (re.test(haystack)) return name;
  }
  return undefined;
}

/** Every human-in-the-loop tool a step uses, by the same reading as {@link stepUsesHumanInTheLoopTool}. */
function stepHumanInTheLoopTools(step: InlinePipelineStep): string[] {
  if (step.tool !== undefined && HITL_SET.has(step.tool)) return [step.tool];
  if (step.tools) return step.tools.filter((name) => HITL_SET.has(name));
  const haystack = step.task ?? '';
  return HITL_REGEXES.filter(([, re]) => re.test(haystack)).map(([name]) => name);
}

/**
 * Whether a workflow's only way to reach a human is `ask_user` (PRD 3b-2 §4.3, G2): it asks at
 * least once, and no step uses `ask_secret` or `ask_human`. That is the interactive workflow a
 * schedule may run, with its questions going to the owner; one that may ask for a secret stays
 * unschedulable. A property derived from the steps, not a third mode.
 */
export function asksOnlyViaAskUser(steps: InlinePipelineStep[]): boolean {
  const used = steps.flatMap(stepHumanInTheLoopTools);
  return used.length > 0 && used.every((name) => name === 'ask_user');
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
