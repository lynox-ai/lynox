import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunState, AgentOutput } from '../../types/orchestration.js';
import type { ToolEntry, LynoxUserConfig, InlinePipelineStep, PlannedPipeline } from '../../types/index.js';

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

// Mock validate — keep MAX_STEPS in sync with the real module (pipeline.ts
// imports the canonical constant from here).
const mockValidateManifest = vi.fn();
vi.mock('../../orchestrator/validate.js', () => ({
  validateManifest: (...args: unknown[]) => mockValidateManifest(...args),
  MAX_STEPS: 20,
}));

import {
  runWorkflowTool,
  storePipeline,
  getPipeline,
  runSavedWorkflow,
  dispatchOrchestratedPipeline,
  forgetPipeline,
  _resetPipelineStore,
  _summarizeStepOutput,
} from './pipeline.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';
import type { RunHistory } from '../../core/run-history.js';

const mockConfig: LynoxUserConfig = {
  api_key: 'test-key',
  api_base_url: 'http://localhost:8317',
};

const mockTools: ToolEntry[] = [
  {
    definition: { name: 'bash', description: 'Run bash', input_schema: { type: 'object' as const, properties: {} } },
    handler: vi.fn() as ToolEntry['handler'],
  },
];

function makePipelineAgent(opts?: { config?: LynoxUserConfig | null; tools?: ToolEntry[] }): IAgent {
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
    executionMode: 'tracked',
    template: false,
  };
  storePipeline(pipelineId, planned);
  return pipelineId;
}

describe('run_workflow — inline steps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('returns error when config not initialized', async () => {
    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      makePipelineAgent({ config: null }),
    );
    expect(result).toBe('Error: Workflow config not initialized. Workflow tools are not available.');
  });

  it('returns error when no parent tools', async () => {
    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      makePipelineAgent({ tools: [] }),
    );
    expect(result).toBe('Error: No parent tools available for inline pipeline steps.');
  });

  it('returns error when both steps and workflow_id provided', async () => {
    const agent = makePipelineAgent();
    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], workflow_id: 'some-id' },
      agent,
    );
    expect(result).toBe('Error: Provide either steps[] or workflow_id, not both.');
  });

  it('returns error when neither steps nor workflow_id provided', async () => {
    const agent = makePipelineAgent();
    const result = await runWorkflowTool.handler(
      { name: 'test' },
      agent,
    );
    expect(result).toBe('Error: Provide steps[] for inline execution or workflow_id for a stored workflow.');
  });

  it('returns error for empty steps array', async () => {
    const agent = makePipelineAgent();
    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [] },
      agent,
    );
    expect(result).toBe('Error: Workflow must have at least one step.');
  });

  it('returns error when steps exceed MAX_STEPS (20)', async () => {
    const agent = makePipelineAgent();
    const steps = Array.from({ length: 21 }, (_, i) => makeStep(`s${i}`, `task ${i}`));
    const result = await runWorkflowTool.handler(
      { name: 'test', steps },
      agent,
    );
    expect(result).toBe('Error: Workflow exceeds maximum of 20 steps (got 21).');
  });

  it('returns error for duplicate step IDs', async () => {
    const agent = makePipelineAgent();
    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('dup', 'first'), makeStep('dup', 'second')] },
      agent,
    );
    expect(result).toBe('Error: Duplicate step ID "dup".');
  });

  it('successfully executes a single-step pipeline', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const result = await runWorkflowTool.handler(
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

    const result = await runWorkflowTool.handler(
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

    await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], on_failure: 'continue' },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    expect(manifestArg['on_failure']).toBe('continue');
  });

  it('passes context to manifest', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const context = { repo: 'lynox', branch: 'main' };
    await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], context },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    // buildManifest always exposes a `params` namespace; caller context merges over it.
    expect(manifestArg['context']).toEqual({ params: {}, ...context });
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

    const result = await runWorkflowTool.handler(
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

    const result = await runWorkflowTool.handler(
      {
        name: 'cyclic',
        steps: [
          makeStep('a', 'step a', { input_from: ['b'] }),
          makeStep('b', 'step b', { input_from: ['a'] }),
        ],
      },
      agent,
    );

    expect(result).toContain('Error: Workflow execution failed: Cycle detected in DAG');
  });

  it('builds manifest with v1.1 and inline runtime', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runWorkflowTool.handler(
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

    const result = await runWorkflowTool.handler(
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

    const result = await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    expect(result).toBe('Error: Workflow execution failed: Agent crashed');
  });
});

describe('run_workflow — stored workflow (workflow_id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('returns error for unknown workflow_id', async () => {
    const agent = makePipelineAgent();
    const result = await runWorkflowTool.handler(
      { workflow_id: 'nonexistent-id' },
      agent,
    );
    expect(result).toContain('Error: Workflow "nonexistent-id" not found');
  });

  it('refuses an interactive pipeline run from a non-prompt-capable agent', async () => {
    // Agent with no promptUser callback (e.g. headless / autonomous worker).
    const agent = makePipelineAgent();
    const pipelineId = 'interactive-stored';
    storePipeline(pipelineId, {
      id: pipelineId,
      name: 'asks',
      goal: 'pick',
      steps: [{ id: 'q', task: 'ask_user something' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'tracked',
      template: false,
      mode: 'interactive',
    });
    const result = await runWorkflowTool.handler(
      { workflow_id: pipelineId },
      agent,
    );
    expect(result).toMatch(/requires a live chat session/);
  });

  it('returns error when pipeline already executed', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    // Execute once
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler(
      { workflow_id: pipelineId },
      agent,
    );

    // Try to execute again
    const result = await runWorkflowTool.handler(
      { workflow_id: pipelineId },
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

    const result = await runWorkflowTool.handler(
      { workflow_id: pipelineId },
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

    const result = await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
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

    await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
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

    await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
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

    const result = await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
        modifications: [{ step_id: 'nonexistent', action: 'remove' }],
      },
      agent,
    );

    expect(result).toContain('Error: Step "nonexistent" not found for removal');
  });

  it('returns error for update_task without value', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const result = await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
        modifications: [{ step_id: 'analyze', action: 'update_task' }],
      },
      agent,
    );

    expect(result).toContain('Error: "value" is required for update_task');
  });

  it('returns error when all steps removed', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline([{ id: 'only', task: 'the only step' }]);

    const result = await runWorkflowTool.handler(
      {
        workflow_id: pipelineId,
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

    const firstResult = await runWorkflowTool.handler(
      { workflow_id: pipelineId },
      agent,
    );
    expect(firstResult).toContain('Error: Workflow execution failed');

    // Second attempt should work (executed flag reset to false on error)
    mockValidateManifest.mockImplementation((m: unknown) => m);
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const secondResult = await runWorkflowTool.handler(
      { workflow_id: pipelineId },
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
    await runWorkflowTool.handler(
      { workflow_id: pipelineId },
      agent,
    );

    // Retry
    mockRetryManifest.mockResolvedValueOnce(makeRunState());
    const result = await runWorkflowTool.handler(
      { workflow_id: pipelineId, retry: true },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['status']).toBe('completed');
    expect(mockRetryManifest).toHaveBeenCalledTimes(1);
  });

  it('returns error for retry without previous execution', async () => {
    const agent = makePipelineAgent();
    const pipelineId = seedStoredPipeline();

    const result = await runWorkflowTool.handler(
      { workflow_id: pipelineId, retry: true },
      agent,
    );

    expect(result).toContain('No previous execution found');
  });
});

describe('getPipeline — legacy mode backfill', () => {
  beforeEach(() => {
    _resetPipelineStore();
  });

  it('reads back the mode that was stored', () => {
    const pipelineId = 'modetest-1';
    storePipeline(pipelineId, {
      id: pipelineId,
      name: 'modetest',
      goal: 'g',
      steps: [{ id: 'a', task: 'compute' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'tracked',
      template: false,
      mode: 'autonomous',
    });
    expect(getPipeline(pipelineId)?.mode).toBe('autonomous');
  });

  it('mode survives in-memory storage roundtrip', () => {
    const pipelineId = 'modetest-2';
    storePipeline(pipelineId, {
      id: pipelineId,
      name: 'modetest',
      goal: 'g',
      steps: [{ id: 'q', task: 'ask_user' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'tracked',
      template: false,
      mode: 'interactive',
    });
    expect(getPipeline(pipelineId)?.mode).toBe('interactive');
  });

  it('legacy SQLite row missing mode is auto-labelled by step inspection', () => {
    const pipelineId = 'legacy-pipeline-1';
    const legacyPlanned = {
      id: pipelineId,
      name: 'legacy',
      goal: 'g',
      steps: [{ id: 'a', task: 'no human stuff' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
      // No `mode`, no `executionMode`, no `template` — full legacy row.
    };
    const fakeRunHistory = {
      getPlannedPipeline: () => ({ id: pipelineId, manifest_json: JSON.stringify(legacyPlanned) }),
    };
    const planned = getPipeline(pipelineId, fakeRunHistory as never);
    expect(planned?.mode).toBe('autonomous');
    expect(planned?.executionMode).toBe('orchestrated');
    expect(planned?.template).toBe(false);
    expect(planned?.parameters).toEqual([]); // F-1: legacy row backfills parameters
  });

  it('preserves stored parameters through the getPipeline roundtrip (F-1)', () => {
    const pipelineId = 'param-pipeline-1';
    const parameters = [
      { name: 'client', description: 'the client', type: 'string', source: 'user_input' },
    ];
    const planned = {
      id: pipelineId, name: 'with-params', goal: 'g',
      steps: [{ id: 'a', task: 'audit {{params.client}}' }],
      reasoning: 'r', estimatedCost: 0, createdAt: new Date().toISOString(),
      executed: false, executionMode: 'orchestrated', template: true, mode: 'autonomous',
      parameters,
    };
    const fakeRunHistory = {
      getPlannedPipeline: () => ({ id: pipelineId, manifest_json: JSON.stringify(planned) }),
    };
    expect(getPipeline(pipelineId, fakeRunHistory as never)?.parameters).toEqual(parameters);
  });

  it('legacy row with ask_user step is auto-labelled interactive (with warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipelineId = 'legacy-pipeline-2';
    const legacyPlanned = {
      id: pipelineId,
      name: 'legacy-2',
      goal: 'g',
      steps: [{ id: 'q', task: 'ask_user something' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
    };
    const fakeRunHistory = {
      getPlannedPipeline: () => ({ id: pipelineId, manifest_json: JSON.stringify(legacyPlanned) }),
    };
    const planned = getPipeline(pipelineId, fakeRunHistory as never);
    expect(planned?.mode).toBe('interactive');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/legacy pipeline/);
    warnSpy.mockRestore();
  });

  it('legacy migration warns at most once per pipeline id', () => {
    // After the first read the pipeline is cached in memory, so subsequent
    // calls hit the in-memory branch and never trigger backfill again. The
    // warnedLegacyIds Set still guarantees idempotency if the cache misses
    // (e.g. process restart with same DB).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipelineId = 'legacy-pipeline-3';
    const legacyPlanned = {
      id: pipelineId,
      name: 'legacy-3',
      goal: 'g',
      steps: [{ id: 'q', task: 'ask_user something' }],
      reasoning: 'r',
      estimatedCost: 0,
      createdAt: new Date().toISOString(),
      executed: false,
    };
    const fakeRunHistory = {
      getPlannedPipeline: () => ({ id: pipelineId, manifest_json: JSON.stringify(legacyPlanned) }),
    };
    getPipeline(pipelineId, fakeRunHistory as never);
    getPipeline(pipelineId, fakeRunHistory as never);
    getPipeline(pipelineId, fakeRunHistory as never);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// PRD-WORKFLOW-UX D13 — Saved Workflows library "Run" path.
describe('runSavedWorkflow', () => {
  // Minimal RunHistory stub — persistPipelineRun fire-and-forgets these.
  const fakeRunHistory = {
    getPlannedPipeline: () => undefined,
    insertPipelineRun: vi.fn(),
    insertPipelineStepResult: vi.fn(),
  };

  function seedSavedWorkflow(opts?: { template?: boolean; mode?: 'autonomous' | 'interactive'; steps?: InlinePipelineStep[] }): string {
    const id = 'saved-wf-id';
    storePipeline(id, {
      id,
      name: 'Monthly Report',
      goal: 'Compile the monthly report',
      steps: opts?.steps ?? [{ id: 'gather', task: 'Gather data' }],
      reasoning: 'saved',
      estimatedCost: 0.02,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'orchestrated',
      template: opts?.template ?? true,
      mode: opts?.mode ?? 'autonomous',
    });
    return id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('runs a saved workflow and reports the fresh run id', async () => {
    const id = seedSavedWorkflow();
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'fresh-run-1' }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(true);
    expect(result.runId).toBe('fresh-run-1');
    expect(result.status).toBe('completed');
    expect(mockRunManifest).toHaveBeenCalledTimes(1);
  });

  it('does not consume the template — a saved workflow stays re-runnable', async () => {
    const id = seedSavedWorkflow();
    mockRunManifest.mockResolvedValue(makeRunState());
    await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    // The stored template must not have been flipped to executed.
    expect(getPipeline(id)?.executed).toBe(false);
    const second = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(second.ok).toBe(true);
    expect(mockRunManifest).toHaveBeenCalledTimes(2);
  });

  it('returns an error when the workflow is not found', async () => {
    const result = await runSavedWorkflow('ghost', fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('refuses a planned pipeline that is not a saved template', async () => {
    const id = seedSavedWorkflow({ template: false });
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a saved workflow/);
  });

  it('refuses an interactive saved workflow', async () => {
    const id = seedSavedWorkflow({ mode: 'interactive' });
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/interactive/);
  });

  it('returns an error when run history is unavailable', async () => {
    const result = await runSavedWorkflow('any', null, mockConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Run history is not available/);
  });

  it('surfaces a runManifest failure as an execution error', async () => {
    const id = seedSavedWorkflow();
    mockRunManifest.mockRejectedValueOnce(new Error('boom'));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Workflow execution failed/);
  });

  it('forgetPipeline evicts a cached entry by id', () => {
    const id = seedSavedWorkflow();
    expect(getPipeline(id)).toBeDefined();
    forgetPipeline(id);
    // No SQLite fallback passed — a forgotten entry is gone.
    expect(getPipeline(id)).toBeUndefined();
  });
});

// --- Per-step summary plumb (A2/U1/R1) ---
describe('_summarizeStepOutput', () => {
  it('takes the first non-empty line and collapses whitespace', () => {
    expect(_summarizeStepOutput('  Fetched 12 records\n\nmore detail'))
      .toBe('Fetched 12 records');
  });

  it('collapses internal runs of whitespace', () => {
    expect(_summarizeStepOutput('Did\t\tthe   thing')).toBe('Did the thing');
  });

  it('returns an empty string for blank output', () => {
    expect(_summarizeStepOutput('   \n  \n')).toBe('');
  });

  it('truncates a long first line with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const summary = _summarizeStepOutput(long);
    expect(summary.length).toBe(160);
    expect(summary.endsWith('…')).toBe(true);
  });
});

// PRD-HN-LAUNCH-HARDENING T2-W1 — saved-workflow templates must never be
// consumed by `executePipelineById` (the `run_workflow workflow_id:` path)
// or by `dispatchOrchestratedPipeline` (the plan_task O7 auto-trigger).
// `runSavedWorkflow` is already guarded; see the dedicated suite above.
describe('template-integrity guard (T2-W1)', () => {
  const markExecutedSpy = vi.fn();
  const fakeRunHistory = {
    getPlannedPipeline: () => undefined,
    insertPipelineRun: vi.fn(),
    insertPipelineStepResult: vi.fn(),
    markPipelineExecuted: markExecutedSpy,
  };

  function seedTemplate(id = 'tpl-1'): string {
    storePipeline(id, {
      id,
      name: 'Saved Template',
      goal: 'reusable workflow',
      steps: [{ id: 'one', task: 'do one thing' }],
      reasoning: 'saved',
      estimatedCost: 0.01,
      createdAt: new Date().toISOString(),
      executed: false,
      executionMode: 'orchestrated',
      template: true,
      mode: 'autonomous',
    });
    return id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  function makeAgentWithRunHistory(): IAgent {
    const agent = makePipelineAgent();
    (agent.toolContext as Record<string, unknown>)['runHistory'] =
      fakeRunHistory as unknown as RunHistory | null;
    return agent;
  }

  describe('executePipelineById (run_workflow workflow_id:)', () => {
    it('does NOT mark a template as executed', async () => {
      const agent = makeAgentWithRunHistory();
      const id = seedTemplate();
      mockRunManifest.mockResolvedValue(makeRunState());

      // First run via the run_workflow tool.
      const first = await runWorkflowTool.handler({ workflow_id: id }, agent);
      expect(first).not.toMatch(/Error/);
      // Three-part invariant: in-memory flag stays false, markPipelineExecuted
      // was NOT called, and a second run is still permitted (no "already
      // executed" error).
      expect(getPipeline(id)?.executed).toBe(false);
      expect(markExecutedSpy).not.toHaveBeenCalled();

      const second = await runWorkflowTool.handler({ workflow_id: id }, agent);
      expect(second).not.toMatch(/already been executed/);
      expect(getPipeline(id)?.executed).toBe(false);
      expect(markExecutedSpy).not.toHaveBeenCalled();
    });

    it('still marks a non-template (regular planned pipeline) executed', async () => {
      const agent = makeAgentWithRunHistory();
      const id = seedStoredPipeline(); // template: false
      mockRunManifest.mockResolvedValueOnce(makeRunState());

      const first = await runWorkflowTool.handler({ workflow_id: id }, agent);
      expect(first).not.toMatch(/Error/);
      expect(getPipeline(id)?.executed).toBe(true);
      expect(markExecutedSpy).toHaveBeenCalledTimes(1);

      // Second run is now refused — proves the guard only relaxes for templates.
      const second = await runWorkflowTool.handler({ workflow_id: id }, agent);
      expect(second).toMatch(/already been executed/);
    });
  });

  describe('dispatchOrchestratedPipeline (plan_task O7 auto-trigger)', () => {
    it('does NOT mark a template as executed', async () => {
      const id = seedTemplate('tpl-disp-1');
      const planned = getPipeline(id)!;
      mockRunManifest.mockResolvedValueOnce(makeRunState());

      const result = await dispatchOrchestratedPipeline(planned, {
        config: mockConfig,
        tools: mockTools,
        streamHandler: null,
        runHistory: fakeRunHistory as never,
      });
      expect(result).not.toMatch(/Error/);
      expect(planned.executed).toBe(false);
      expect(markExecutedSpy).not.toHaveBeenCalled();

      // Re-dispatching the same template must not be blocked.
      mockRunManifest.mockResolvedValueOnce(makeRunState());
      const second = await dispatchOrchestratedPipeline(planned, {
        config: mockConfig,
        tools: mockTools,
        streamHandler: null,
        runHistory: fakeRunHistory as never,
      });
      expect(second).not.toMatch(/already been executed/);
    });

    it('still marks a non-template planned pipeline executed', async () => {
      const id = 'disp-regular';
      storePipeline(id, {
        id,
        name: 'regular',
        goal: 'g',
        steps: [{ id: 's', task: 't' }],
        reasoning: 'r',
        estimatedCost: 0,
        createdAt: new Date().toISOString(),
        executed: false,
        executionMode: 'orchestrated',
        template: false,
        mode: 'autonomous',
      });
      const planned = getPipeline(id)!;
      mockRunManifest.mockResolvedValueOnce(makeRunState());

      await dispatchOrchestratedPipeline(planned, {
        config: mockConfig,
        tools: mockTools,
        streamHandler: null,
        runHistory: fakeRunHistory as never,
      });
      expect(planned.executed).toBe(true);
      expect(markExecutedSpy).toHaveBeenCalledTimes(1);

      const second = await dispatchOrchestratedPipeline(planned, {
        config: mockConfig,
        tools: mockTools,
        streamHandler: null,
        runHistory: fakeRunHistory as never,
      });
      expect(second).toMatch(/already been executed/);
    });
  });
});

// H-011: run_workflow must read provider config from the agent's fresh
// getProviderConfig() snapshot, not the stale toolContext.userConfig — the
// latter was captured at engine init and is not updated after a runtime
// reloadUserConfig (UI provider-switch). Pattern recidivism of PRs #568/#570/#571.
describe('run_workflow — H-011: fresh provider config via getProviderConfig()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
  });

  it('uses fresh getProviderConfig() snapshot, NOT stale userConfig (UI provider-switch)', async () => {
    // Stale userConfig: anthropic (pre-switch).
    const staleConfig: LynoxUserConfig = {
      api_key: 'anthropic-key',
      api_base_url: 'https://api.anthropic.com/v1',
      provider: 'anthropic',
    };

    // Fresh snapshot: mistral (post-switch).
    const getProviderConfig = vi.fn(() => ({
      provider: 'openai' as const,
      apiKey: 'mistral-key',
      apiBaseURL: 'https://api.mistral.ai/v1',
      openaiModelId: 'mistral-large-2512',
      openaiAuth: 'static' as const,
    }));

    const baseAgent = makePipelineAgent({ config: staleConfig });
    const agent = { ...baseAgent, getProviderConfig } as unknown as IAgent;

    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runWorkflowTool.handler(
      { name: 'single', steps: [makeStep('s1', 'do thing')] },
      agent,
    );

    expect(getProviderConfig).toHaveBeenCalled();
    expect(mockRunManifest).toHaveBeenCalledTimes(1);

    // runManifest(manifest, config, options) — config is arg[1].
    const cfgArg = mockRunManifest.mock.calls[0]![1] as LynoxUserConfig;
    expect(cfgArg.api_key).toBe('mistral-key');
    expect(cfgArg.api_base_url).toBe('https://api.mistral.ai/v1');
    expect(cfgArg.provider).toBe('openai');
    expect(cfgArg.openai_model_id).toBe('mistral-large-2512');
    // CRITICAL: stale anthropic-key MUST NOT leak through.
    expect(cfgArg.api_key).not.toBe('anthropic-key');
  });

  it('falls back to userConfig when agent has no getProviderConfig (legacy mock)', async () => {
    const userConfig: LynoxUserConfig = {
      api_key: 'anthropic-key',
      api_base_url: 'https://api.anthropic.com/v1',
      provider: 'anthropic',
    };

    // Legacy IAgent mock: makePipelineAgent doesn't attach getProviderConfig.
    const agent = makePipelineAgent({ config: userConfig });
    expect((agent as { getProviderConfig?: unknown }).getProviderConfig).toBeUndefined();

    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await expect(
      runWorkflowTool.handler(
        { name: 'single', steps: [makeStep('s1', 'do thing')] },
        agent,
      ),
    ).resolves.not.toThrow();

    expect(mockRunManifest).toHaveBeenCalledTimes(1);
    const cfgArg = mockRunManifest.mock.calls[0]![1] as LynoxUserConfig;
    expect(cfgArg.api_key).toBe('anthropic-key');
    expect(cfgArg.provider).toBe('anthropic');
  });
});
