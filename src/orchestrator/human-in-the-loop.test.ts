import { describe, it, expect } from 'vitest';
import {
  HUMAN_IN_THE_LOOP_TOOLS,
  inferPipelineMode,
  findAutonomousViolations,
  isHumanInTheLoopTool,
  stepUsesHumanInTheLoopTool,
  asksOnlyViaAskUser,
  isSchedulableWorkflow,
  pipelineScheduleOf,
  stepsThatAsk,
} from './human-in-the-loop.js';
import type { InlinePipelineStep } from '../types/index.js';

const mkStep = (id: string, task: string): InlinePipelineStep => ({ id, task });

describe('HUMAN_IN_THE_LOOP_TOOLS', () => {
  it('contains the canonical ask_* tools', () => {
    expect([...HUMAN_IN_THE_LOOP_TOOLS]).toEqual(['ask_user', 'ask_secret', 'ask_human']);
  });
});

describe('isHumanInTheLoopTool', () => {
  it('is true for known tool names', () => {
    expect(isHumanInTheLoopTool('ask_user')).toBe(true);
    expect(isHumanInTheLoopTool('ask_secret')).toBe(true);
    expect(isHumanInTheLoopTool('ask_human')).toBe(true);
  });
  it('is false for unrelated tools', () => {
    expect(isHumanInTheLoopTool('bash')).toBe(false);
    expect(isHumanInTheLoopTool('http')).toBe(false);
  });
});

describe('stepUsesHumanInTheLoopTool', () => {
  it('detects ask_user reference in task text', () => {
    expect(stepUsesHumanInTheLoopTool(mkStep('vote', 'Use ask_user to ask which tagline.')))
      .toBe('ask_user');
  });
  it('returns undefined when no HITL tool referenced', () => {
    expect(stepUsesHumanInTheLoopTool(mkStep('analyze', 'Analyze sentiment of the input.')))
      .toBeUndefined();
  });
  it('does not match substrings via word boundaries', () => {
    expect(stepUsesHumanInTheLoopTool(mkStep('a', 'count ask_users in the table.')))
      .toBeUndefined();
    expect(stepUsesHumanInTheLoopTool(mkStep('b', 'fask_user is a typo.')))
      .toBeUndefined();
    expect(stepUsesHumanInTheLoopTool(mkStep('c', 'task_user is a different identifier.')))
      .toBeUndefined();
  });
  it('handles undefined task gracefully', () => {
    expect(stepUsesHumanInTheLoopTool({ id: 'x', task: '' })).toBeUndefined();
  });
  it('detects a DECLARED ask_user even when the task prose never names it (F2)', () => {
    expect(stepUsesHumanInTheLoopTool({ id: 'x', task: 'Confirm the shortlist with a question.', tools: ['ask_user'] }))
      .toBe('ask_user');
  });
  it('a declared non-HITL tool set does not trip the detector', () => {
    expect(stepUsesHumanInTheLoopTool({ id: 'x', task: 'Fetch data.', tools: ['http_request'] }))
      .toBeUndefined();
  });
  it('a declaration is authoritative: prose mentioning ask_user does NOT trip it when the declared set excludes it', () => {
    // The step cannot call a tool it did not declare (the runtime grants only
    // declared names) — classifying it interactive would be a false positive.
    expect(stepUsesHumanInTheLoopTool({ id: 'x', task: 'Do NOT use ask_user here; summarize instead.', tools: ['http_request'] }))
      .toBeUndefined();
  });
  it('a captured replay step whose literal tool is ask_user is detected', () => {
    expect(stepUsesHumanInTheLoopTool({ id: 'x', task: 'replay', tool: 'ask_user', tools: undefined }))
      .toBe('ask_user');
  });
});

describe('inferPipelineMode', () => {
  it('returns interactive when any step references ask_user', () => {
    const steps = [
      mkStep('a', 'Fetch data via http.'),
      mkStep('b', 'ask_user which option to pick.'),
    ];
    expect(inferPipelineMode(steps)).toBe('interactive');
  });

  it('returns autonomous when no step references HITL tools', () => {
    const steps = [
      mkStep('a', 'Fetch data via http.'),
      mkStep('b', 'Summarize and write to disk.'),
    ];
    expect(inferPipelineMode(steps)).toBe('autonomous');
  });
});

describe('findAutonomousViolations', () => {
  it('returns one issue per offending step', () => {
    const steps = [
      mkStep('safe', 'Just compute.'),
      mkStep('bad1', 'ask_user which way to go.'),
      mkStep('bad2', 'Capture credential via ask_secret.'),
    ];
    const issues = findAutonomousViolations(steps);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ stepId: 'bad1', tool: 'ask_user' });
    expect(issues[1]).toMatchObject({ stepId: 'bad2', tool: 'ask_secret' });
    expect(issues[0]!.message).toContain('autonomous');
  });

  it('returns empty when no violations', () => {
    expect(findAutonomousViolations([mkStep('a', 'No HITL here.')])).toEqual([]);
  });
});

describe('asksOnlyViaAskUser (PRD 3b-2 §4.3)', () => {
  it('holds for a workflow whose only question tool is ask_user', () => {
    expect(asksOnlyViaAskUser([mkStep('a', 'gather data'), mkStep('b', 'ask_user which list')])).toBe(true);
    expect(asksOnlyViaAskUser([{ id: 'c', task: 'pick', tools: ['ask_user', 'bash'] }])).toBe(true);
  });

  it('fails for a workflow that asks for a secret or a human any other way, in any step', () => {
    expect(asksOnlyViaAskUser([mkStep('a', 'ask_user which list'), mkStep('b', 'ask_secret for the key')])).toBe(false);
    // Both in one step's prose: the first match alone would read as ask_user.
    expect(asksOnlyViaAskUser([mkStep('a', 'ask_user which list, then ask_secret for the key')])).toBe(false);
    expect(asksOnlyViaAskUser([{ id: 'c', task: 'pick', tools: ['ask_user', 'ask_human'] }])).toBe(false);
    expect(asksOnlyViaAskUser([{ id: 'd', task: 'x', tool: 'ask_secret' }])).toBe(false);
  });

  it('fails for a workflow that asks nothing', () => {
    expect(asksOnlyViaAskUser([mkStep('a', 'gather data')])).toBe(false);
  });
});

describe('which workflows a schedule may run (PRD 3b-2 §4.3)', () => {
  const asks = [mkStep('a', 'gather'), mkStep('pick', 'ask_user which list')];
  const secret = [mkStep('pick', 'ask_user which list'), mkStep('k', 'ask_secret for the key')];

  it('an autonomous workflow, or an interactive one that asks only through ask_user', () => {
    expect(isSchedulableWorkflow({ mode: 'autonomous', steps: [mkStep('a', 'gather')] })).toBe(true);
    expect(isSchedulableWorkflow({ mode: 'interactive', steps: asks })).toBe(true);
    expect(isSchedulableWorkflow({ mode: 'interactive', steps: secret })).toBe(false);
    expect(isSchedulableWorkflow({ mode: undefined, steps: asks })).toBe(false);
  });

  it('pipelineScheduleOf hands the task manager the mode and the verdict', () => {
    expect(pipelineScheduleOf({ mode: 'interactive', steps: asks })).toEqual({ mode: 'interactive', schedulable: true });
    expect(pipelineScheduleOf({ mode: 'interactive', steps: secret })).toEqual({ mode: 'interactive', schedulable: false });
    expect(pipelineScheduleOf({ mode: undefined, steps: [] })).toEqual({ mode: 'interactive', schedulable: false });
  });

  it('stepsThatAsk names the steps that may ask through ask_user', () => {
    expect(stepsThatAsk(asks)).toEqual(['pick']);
    expect(stepsThatAsk([{ id: 'd', task: 'pick', tools: ['ask_user'] }, mkStep('k', 'ask_secret for the key')])).toEqual(['d']);
  });
});
