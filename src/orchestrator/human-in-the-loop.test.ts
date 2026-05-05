import { describe, it, expect } from 'vitest';
import {
  HUMAN_IN_THE_LOOP_TOOLS,
  inferPipelineMode,
  findAutonomousViolations,
  isHumanInTheLoopTool,
  stepUsesHumanInTheLoopTool,
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
  it('returns null when no HITL tool referenced', () => {
    expect(stepUsesHumanInTheLoopTool(mkStep('analyze', 'Analyze sentiment of the input.')))
      .toBeNull();
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
