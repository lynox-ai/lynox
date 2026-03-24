import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunState, AgentOutput } from '../../orchestrator/types.js';
import type { ToolEntry, NodynUserConfig, InlinePipelineStep, PlannedPipeline } from '../../types/index.js';

// Mock DAG planner
const mockEstimatePipelineCost = vi.fn().mockReturnValue({ steps: [], totalCostUsd: 0.02 });
vi.mock('../../core/dag-planner.js', () => ({
  estimatePipelineCost: (...args: unknown[]) => mockEstimatePipelineCost(...args),
}));

// Mock runner
const mockRunManifest = vi.fn();
const mockRetryManifest = vi.fn();
vi.mock('../../orchestrator/runner.js', () => ({
  runManifest: (...args: unknown[]) => mockRunManifest(...args),
  retryManifest: (...args: unknown[]) => mockRetryManifest(...args),
}));

// Mock validate
const mockValidateManifest = vi.fn();
vi.mock('../../orchestrator/validate.js', () => ({
  validateManifest: (...args: unknown[]) => mockValidateManifest(...args),
}));

import {
  runPipelineTool,
  storePipeline,
  _resetPipelineStore,
} from './pipeline.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

const mockConfig: NodynUserConfig = {
  api_key: 'test-key',
  api_base_url: 'http://localhost:8317',
};

const mockTools: ToolEntry[] = [
  {
    definition: { name: 'bash', description: 'Run bash', input_schema: { type: 'object' as const, properties: {} } },
    handler: vi.fn() as ToolEntry['handler'],
  },
];

function makePipelineAgent(opts?: { config?: NodynUserConfig | null; tools?: ToolEntry[] }): IAgent {
  const ctx = createToolContext(opts?.config ?? mockConfig);
  if (opts?.config === null) {
    (ctx as Record<string, unknown>)['userConfig'] = null;
  }
  ctx.tools = opts?.tools ?? mockTools;
  return { toolContext: ctx } as unknown as IAgent;
}

function makeRunState(overrides?: Partial<RunState>): RunState {
  return {
    runId: 'test-run-id',
    manifestName: 'test',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'completed',
    globalContext: {},
    outputs: new Map<string, AgentOutput>([
      ['step-1', {
        stepId: 'step-1',
        result: 'step result',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 100,
        tokensIn: 50,
        tokensOut: 30,
        costUsd: 0.001,
        skipped: false,
      }],
    ]),
    ...overrides,
  };
}

function makeStep(id: string, task: string, extra?: Partial<InlinePipelineStep>): InlinePipelineStep {
  return { id, task, ...extra };
}

function seedStoredPipeline(steps?: InlinePipelineStep[]): string {
  const pipelineId = 'test-pipeline-id';
  const planned: PlannedPipeline = {
    id: pipelineId,
    name: 'test-plan',
    goal: 'test goal',
    steps: steps ?? [
      { id: 'analyze', task: 'Analyze code' },
      { id: 'implement', task: 'Write code', input_from: ['analyze'] },
    ],
    reasoning: 'test plan',
    estimatedCost: 0.01,
    createdAt: new Date().toISOString(),
    executed: false,
  };
  storePipeline(pipelineId, planned);
  return pipelineId;
}

describe('run_pipeline — inline steps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('returns error when config not initialized', async () => {
    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      makePipelineAgent({ config: null }),
    );
    expect(result).toBe('Error: Pipeline config not initialized. Pipeline tools are not available.');
  });

  it('returns error when no parent tools', async () => {
    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      makePipelineAgent({ tools: [] }),
    );
    expect(result).toBe('Error: No parent tools available for inline pipeline steps.');
  });

  it('returns error when both steps and pipeline_id provided', async () => {
    const agent = makePipelineAgent();
    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], pipeline_id: 'some-id' },
      agent,
    );
    expect(result).toBe('Error: Provide either steps[] or pipeline_id, not both.');
  });

  it('returns error when neither steps nor pipeline_id provided', async () => {
    const agent = makePipelineAgent();
    const result = await runPipelineTool.handler(
      { name: 'test' },
      agent,
    );
    expect(result).toBe('Error: Provide steps[] for inline execution or pipeline_id for a stored pipeline.');
  });

  it('returns error for empty steps array', async () => {
    const agent = makePipelineAgent();
    const result = await runPipelineTool.handler(
      { name: 'test', steps: [] },
      agent,
    );
    expect(result).toBe('Error: Pipeline must have at least one step.');
  });

  it('returns error when steps exceed MAX_STEPS (20)', async () => {
    const agent = makePipelineAgent();
    const steps = Array.from({ length: 21 }, (_, i) => makeStep(`s${i}`, `task ${i}`));
    const result = await runPipelineTool.handler(
      { name: 'test', steps },
      agent,
    );
    expect(result).toBe('Error: Pipeline exceeds maximum of 20 steps (got 21).');
  });

  it('returns error for duplicate step IDs', async () => {
    const agent = makePipelineAgent();
    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('dup', 'first'), makeStep('dup', 'second')] },
      agent,
    );
    expect(result).toBe('Error: Duplicate step ID "dup".');
  });

  it('successfully executes a single-step pipeline', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const result = await runPipelineTool.handler(
      { name: 'single', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['name']).toBe('single');
    expect(parsed['status']).toBe('completed');
    expect(parsed['pipelineId']).toBe('test-run-id');
    expect(mockValidateManifest).toHaveBeenCalledTimes(1);
    expect(mockRunManifest).toHaveBeenCalledTimes(1);
  });

  it('successfully executes multi-step pipeline with input_from', async () => {
    const agent = makePipelineAgent();

    const multiState = makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['analyze', {
          stepId: 'analyze', result: 'analysis complete', startedAt: '', completedAt: '',
          durationMs: 200, tokensIn: 100, tokensOut: 60, costUsd: 0.002, skipped: false,
        }],
        ['implement', {
          stepId: 'implement', result: 'code written', startedAt: '', completedAt: '',
          durationMs: 500, tokensIn: 200, tokensOut: 150, costUsd: 0.01, skipped: false,
        }],
      ]),
    });
    mockRunManifest.mockResolvedValueOnce(multiState);

    const result = await runPipelineTool.handler(
      {
        name: 'multi',
        steps: [
          makeStep('analyze', 'analyze code'),
          makeStep('implement', 'write code', { input_from: ['analyze'] }),
        ],
      },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
    const steps = parsed['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    const agents = manifestArg['agents'] as Array<Record<string, unknown>>;
    expect(agents[1]!['input_from']).toEqual(['analyze']);
  });

  it('handles on_failure=continue', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], on_failure: 'continue' },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    expect(manifestArg['on_failure']).toBe('continue');
  });

  it('passes context to manifest', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const context = { repo: 'nodyn', branch: 'main' };
    await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], context },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    expect(manifestArg['context']).toEqual(context);
  });

  it('truncates result at 50KB and includes config hint', async () => {
    const agent = makePipelineAgent();

    const longResult = 'x'.repeat(60_000);
    const state = makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['s1', {
          stepId: 's1', result: longResult, startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 50, tokensOut: 30, costUsd: 0.001, skipped: false,
        }],
      ]),
    });
    mockRunManifest.mockResolvedValueOnce(state);

    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    const steps = parsed['steps'] as Array<Record<string, unknown>>;
    const stepResult = steps[0]!['result'] as string;
    expect(stepResult.length).toBeLessThan(longResult.length);
    expect(stepResult).toContain('...[truncated');
    expect(stepResult).toContain('pipeline_step_result_limit');
  });

  it('returns validation error for invalid graph (cycle)', async () => {
    const agent = makePipelineAgent();
    mockValidateManifest.mockImplementationOnce(() => {
      throw new Error('Cycle detected in DAG');
    });

    const result = await runPipelineTool.handler(
      {
        name: 'cyclic',
        steps: [
          makeStep('a', 'step a', { input_from: ['b'] }),
          makeStep('b', 'step b', { input_from: ['a'] }),
        ],
      },
      agent,
    );

    expect(result).toContain('Error: Pipeline execution failed: Cycle detected in DAG');
  });

  it('builds manifest with v1.1 and inline runtime', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    expect(manifestArg['manifest_version']).toBe('1.1');
    const agents = manifestArg['agents'] as Array<Record<string, unknown>>;
    expect(agents[0]!['runtime']).toBe('inline');
  });

  it('aggregates total duration and cost from all steps', async () => {
    const agent = makePipelineAgent();

    const state = makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['s1', {
          stepId: 's1', result: 'a', startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, skipped: false,
        }],
        ['s2', {
          stepId: 's2', result: 'b', startedAt: '', completedAt: '',
          durationMs: 200, tokensIn: 20, tokensOut: 10, costUsd: 0.002, skipped: false,
        }],
      ]),
    });
    mockRunManifest.mockResolvedValueOnce(state);

    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'a'), makeStep('s2', 'b')] },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['totalDurationMs']).toBe(300);
    expect(parsed['totalCostUsd']).toBeCloseTo(0.003);
  });

  it('handles runManifest throwing an error', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockRejectedValueOnce(new Error('Agent crashed'));

    const result = await runPipelineTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    expect(result).toBe('Error: Pipeline execution failed: Agent crashed');
  });
});

describe('run_pipeline — stored pipeline (pipeline_id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('returns error for unknown pipeline_id', async () => {
    const agent = makePipelineAgent();
    const result = await runPipelineTool.handler(
      { pipeline_id: 'nonexistent-id' },
      agent,
    );
    expect(result).toContain('Error: Pipeline "nonexistent-id" not found');
  });

  it('returns error when pipeline already executed', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    // Execute once
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );

    // Try to execute again
    const result = await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );
    expect(result).toContain('has already been executed');
  });

  it('successfully executes stored pipeline', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const state = makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['analyze', {
          stepId: 'analyze', result: 'analysis done', startedAt: '', completedAt: '',
          durationMs: 150, tokensIn: 80, tokensOut: 40, costUsd: 0.005, skipped: false,
        }],
        ['implement', {
          stepId: 'implement', result: 'implementation done', startedAt: '', completedAt: '',
          durationMs: 300, tokensIn: 150, tokensOut: 100, costUsd: 0.01, skipped: false,
        }],
      ]),
    });
    mockRunManifest.mockResolvedValueOnce(state);

    const result = await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
    const steps = parsed['steps'] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
  });

  it('applies remove modification', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline([
      { id: 'a', task: 'step a' },
      { id: 'b', task: 'step b', input_from: ['a'] },
      { id: 'c', task: 'step c' },
    ]);

    mockRunManifest.mockResolvedValueOnce(makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['a', {
          stepId: 'a', result: 'ok', startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, skipped: false,
        }],
        ['c', {
          stepId: 'c', result: 'ok', startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, skipped: false,
        }],
      ]),
    }));

    const result = await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'b', action: 'remove' }],
      },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    const agents = manifestArg['agents'] as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a['id'])).toEqual(['a', 'c']);

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
  });

  it('cleans up input_from references when removing a step', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline([
      { id: 'a', task: 'step a' },
      { id: 'b', task: 'step b', input_from: ['a'] },
    ]);

    mockRunManifest.mockResolvedValueOnce(makeRunState({
      outputs: new Map<string, AgentOutput>([
        ['b', {
          stepId: 'b', result: 'ok', startedAt: '', completedAt: '',
          durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001, skipped: false,
        }],
      ]),
    }));

    await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'a', action: 'remove' }],
      },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    const agents = manifestArg['agents'] as Array<Record<string, unknown>>;
    expect(agents[0]!['input_from']).toBeUndefined();
  });

  it('applies update_task modification', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'analyze', action: 'update_task', value: 'Deep analysis of auth module' }],
      },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    const agents = manifestArg['agents'] as Array<Record<string, unknown>>;
    expect(agents[0]!['task']).toBe('Deep analysis of auth module');
  });

  it('returns error for invalid modification target', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const result = await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'nonexistent', action: 'remove' }],
      },
      agent,
    );

    expect(result).toContain('Error: Step "nonexistent" not found for removal');
  });

  it('returns error for update_task without value', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const result = await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'analyze', action: 'update_task' }],
      },
      agent,
    );

    expect(result).toContain('Error: "value" is required for update_task');
  });

  it('returns error when all steps removed', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline([{ id: 'only', task: 'the only step' }]);

    const result = await runPipelineTool.handler(
      {
        pipeline_id: pipelineId,
        modifications: [{ step_id: 'only', action: 'remove' }],
      },
      agent,
    );

    expect(result).toBe('Error: All steps were removed. Nothing to execute.');
  });

  it('allows retry after validation failure', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    // First attempt fails validation
    mockValidateManifest.mockImplementationOnce(() => {
      throw new Error('Schema validation failed');
    });

    const firstResult = await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );
    expect(firstResult).toContain('Error: Pipeline execution failed');

    // Second attempt should work (executed flag reset to false on error)
    mockValidateManifest.mockImplementation((m: unknown) => m);
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const secondResult = await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );
    const parsed = JSON.parse(secondResult) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
  });

  it('supports retry mode for failed steps', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    // First execution
    mockRunManifest.mockResolvedValueOnce(makeRunState({ status: 'failed' }));
    await runPipelineTool.handler(
      { pipeline_id: pipelineId },
      agent,
    );

    // Retry
    mockRetryManifest.mockResolvedValueOnce(makeRunState());
    const result = await runPipelineTool.handler(
      { pipeline_id: pipelineId, retry: true },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
    expect(mockRetryManifest).toHaveBeenCalledTimes(1);
  });

  it('returns error for retry without previous execution', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const result = await runPipelineTool.handler(
      { pipeline_id: pipelineId, retry: true },
      agent,
    );

    expect(result).toContain('No previous execution found');
  });
});
