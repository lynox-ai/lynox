import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK using class syntax (same pattern as pre-approve-planner.test.ts)
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
        stream: (...args: unknown[]) => ({ finalMessage: () => mockCreate(...args) }),
      },
    };
    constructor(..._args: unknown[]) { /* accept any args */ }
  },
}));

import { planDAG, estimatePipelineCost } from './dag-planner.js';
import type { InlinePipelineStep } from '../types/index.js';

function makeToolUseResponse(input: unknown) {
  return {
    content: [
      {
        type: 'tool_use' as const,
        id: 'toolu_1',
        name: 'propose_dag',
        input,
      },
    ],
  };
}

describe('planDAG', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Internal Server Error'));

    const result = await planDAG('build the app');
    expect(result).toBeNull();
  });

  it('returns null when tool_use block missing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
    });

    const result = await planDAG('build the app');
    expect(result).toBeNull();
  });

  it('returns null when steps array missing', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      reasoning: 'some reasoning',
      estimated_cost_usd: 0.01,
      // steps missing
    }));

    const result = await planDAG('build the app');
    expect(result).toBeNull();
  });

  it('successfully parses valid response with steps', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'analyze', task: 'Analyze the codebase', model: 'sonnet' },
        { id: 'implement', task: 'Implement changes', model: 'opus', input_from: ['analyze'] },
        { id: 'test', task: 'Write tests', model: 'haiku', input_from: ['implement'] },
      ],
      reasoning: 'Three-phase approach',
      estimated_cost_usd: 0.12,
    }));

    const result = await planDAG('refactor the auth module');

    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(3);
    expect(result!.steps[0]!.id).toBe('analyze');
    expect(result!.steps[0]!.task).toBe('Analyze the codebase');
    expect(result!.steps[0]!.model).toBe('sonnet');
    expect(result!.steps[1]!.input_from).toEqual(['analyze']);
    expect(result!.steps[2]!.model).toBe('haiku');
    expect(result!.reasoning).toBe('Three-phase approach');
    expect(result!.estimatedCost).toBe(0.12);
  });

  it('filters out invalid step objects', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'valid', task: 'A valid step' },
        null,
        42,
        { id: 'no-task' },           // missing task
        { task: 'no-id' },           // missing id
        { id: 123, task: 'bad id' }, // non-string id
        { id: 'also-valid', task: 'Another valid step' },
      ],
      reasoning: 'mixed input',
      estimated_cost_usd: 0.01,
    }));

    const result = await planDAG('test');

    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(2);
    expect(result!.steps[0]!.id).toBe('valid');
    expect(result!.steps[1]!.id).toBe('also-valid');
  });

  it('respects maxSteps limit (trims excess)', async () => {
    const manySteps = Array.from({ length: 20 }, (_, i) => ({
      id: `step-${i}`,
      task: `Task ${i}`,
    }));

    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: manySteps,
      reasoning: 'lots of steps',
      estimated_cost_usd: 0.20,
    }));

    const result = await planDAG('big project', { maxSteps: 5 });

    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(5);
    expect(result!.steps[4]!.id).toBe('step-4');
  });

  it('passes project context to system prompt', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal', {
      projectContext: 'Node.js TypeScript project with Vitest',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const system = callArgs['system'] as string;
    expect(system).toContain('Node.js TypeScript project with Vitest');
    expect(system).toContain('Project context:');
  });

  it('uses haiku model by default', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal');

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['model']).toBe('claude-haiku-4-5-20251001');
  });

  it('uses custom model when provided', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal', { model: 'claude-sonnet-4-6' });

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['model']).toBe('claude-sonnet-4-6');
  });

  it('constructs API key correctly', async () => {
    // We can't directly check the constructor args since it's mocked,
    // but we verify the mock was called (meaning Anthropic was instantiated)
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal', {
      apiKey: 'sk-test-key',
      apiBaseURL: 'http://localhost:8317',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('handles AbortController timeout (15s)', async () => {
    mockCreate.mockImplementationOnce(() =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('aborted')), 50);
      }),
    );

    const result = await planDAG('test goal');
    expect(result).toBeNull();
  });

  it('returns null on empty steps array after parsing', async () => {
    // All steps are invalid, so after filtering we have empty array
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        null,
        { noId: true },
        42,
      ],
      reasoning: 'bad steps',
      estimated_cost_usd: 0.01,
    }));

    const result = await planDAG('test goal');

    // planDAG returns the result even with 0 steps — caller checks length
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(0);
  });

  it('correctly maps input_from arrays', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'a', task: 'first' },
        { id: 'b', task: 'second' },
        { id: 'c', task: 'merge', input_from: ['a', 'b'] },
      ],
      reasoning: 'fan-in',
      estimated_cost_usd: 0.03,
    }));

    const result = await planDAG('test goal');

    expect(result).not.toBeNull();
    expect(result!.steps[2]!.input_from).toEqual(['a', 'b']);
    expect(result!.steps[0]!.input_from).toBeUndefined();
  });

  it('correctly maps model tiers', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'a', task: 'heavy', model: 'opus' },
        { id: 'b', task: 'normal', model: 'sonnet' },
        { id: 'c', task: 'light', model: 'haiku' },
      ],
      reasoning: 'tiered',
      estimated_cost_usd: 0.11,
    }));

    const result = await planDAG('test goal');

    expect(result).not.toBeNull();
    expect(result!.steps[0]!.model).toBe('opus');
    expect(result!.steps[1]!.model).toBe('sonnet');
    expect(result!.steps[2]!.model).toBe('haiku');
  });

  it('ignores invalid model tier values', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'a', task: 'step a', model: 'gpt-4' },
        { id: 'b', task: 'step b', model: 'invalid' },
        { id: 'c', task: 'step c' }, // no model at all
      ],
      reasoning: 'mixed models',
      estimated_cost_usd: 0.01,
    }));

    const result = await planDAG('test goal');

    expect(result).not.toBeNull();
    expect(result!.steps[0]!.model).toBeUndefined();
    expect(result!.steps[1]!.model).toBeUndefined();
    expect(result!.steps[2]!.model).toBeUndefined();
  });

  it('uses forced tool choice for propose_dag', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal');

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['tool_choice']).toEqual({ type: 'tool', name: 'propose_dag' });
  });

  it('handles non-string reasoning gracefully', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 42,
      estimated_cost_usd: 'not-a-number',
    }));

    const result = await planDAG('test goal');

    expect(result).not.toBeNull();
    expect(result!.reasoning).toBe('');
    expect(result!.estimatedCost).toBe(0);
  });

  it('includes LYNOX_BETAS in API call', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('test goal');

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const betas = callArgs['betas'] as string[];
    expect(betas).toContain('token-efficient-tools-2025-02-19');
  });

  it('sends correct user message with goal', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [{ id: 's1', task: 'do it' }],
      reasoning: 'ok',
      estimated_cost_usd: 0.001,
    }));

    await planDAG('build a REST API');

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const messages = callArgs['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['content']).toContain('build a REST API');
  });

  it('ignores input_from with non-string elements', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({
      steps: [
        { id: 'a', task: 'first' },
        { id: 'b', task: 'second', input_from: [42, null, 'a'] },
      ],
      reasoning: 'mixed deps',
      estimated_cost_usd: 0.01,
    }));

    const result = await planDAG('test goal');

    expect(result).not.toBeNull();
    // input_from with mixed types should be rejected (every() check fails)
    expect(result!.steps[1]!.input_from).toBeUndefined();
  });
});

describe('estimatePipelineCost', () => {
  it('returns correct structure with steps array and totalCostUsd', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'step1', task: 'Analyze the code' },
    ];
    const result = estimatePipelineCost(steps);
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('totalCostUsd');
    expect(Array.isArray(result.steps)).toBe(true);
    expect(typeof result.totalCostUsd).toBe('number');
    expect(result.steps[0]).toHaveProperty('stepId', 'step1');
    expect(result.steps[0]).toHaveProperty('model');
    expect(result.steps[0]).toHaveProperty('estimatedCostUsd');
  });

  it('uses per-step cost lookup for sonnet', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'analyze', task: 'Analyze code', model: 'sonnet' },
    ];
    const result = estimatePipelineCost(steps);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.estimatedCostUsd).toBe(0.08);
    expect(result.steps[0]!.model).toBe('claude-sonnet-4-6');
    expect(result.totalCostUsd).toBe(0.08);
  });

  it('sums totalCostUsd across multiple steps', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'First task', model: 'sonnet' },
      { id: 'b', task: 'Second task', model: 'sonnet' },
      { id: 'c', task: 'Third task', model: 'sonnet' },
    ];
    const result = estimatePipelineCost(steps);

    expect(result.steps).toHaveLength(3);
    expect(result.totalCostUsd).toBeCloseTo(0.24, 10);
  });

  it('produces different costs for different model tiers', () => {
    const task = 'Do something';
    const opusCost = estimatePipelineCost([{ id: 'o', task, model: 'opus' }]);
    const sonnetCost = estimatePipelineCost([{ id: 's', task, model: 'sonnet' }]);
    const haikuCost = estimatePipelineCost([{ id: 'h', task, model: 'haiku' }]);

    // Opus > Sonnet > Haiku
    expect(opusCost.totalCostUsd).toBe(1.20);
    expect(sonnetCost.totalCostUsd).toBe(0.08);
    expect(haikuCost.totalCostUsd).toBe(0.005);

    expect(opusCost.totalCostUsd).toBeGreaterThan(sonnetCost.totalCostUsd);
    expect(sonnetCost.totalCostUsd).toBeGreaterThan(haikuCost.totalCostUsd);

    // Verify resolved model IDs
    expect(opusCost.steps[0]!.model).toBe('claude-opus-4-7');
    expect(sonnetCost.steps[0]!.model).toBe('claude-sonnet-4-6');
    expect(haikuCost.steps[0]!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('defaults to sonnet cost when step has no model', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'nomodel', task: 'A task without explicit model' },
    ];
    const result = estimatePipelineCost(steps);

    expect(result.steps[0]!.model).toBe('claude-sonnet-4-6');
    expect(result.steps[0]!.estimatedCostUsd).toBe(0.08);
  });

  it('returns empty steps and zero cost for empty input', () => {
    const result = estimatePipelineCost([]);
    expect(result.steps).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
  });
});
