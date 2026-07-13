import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunState, AgentOutput } from '../../types/orchestration.js';
import type { ToolEntry, LynoxUserConfig, InlinePipelineStep, PlannedPipeline } from '../../types/index.js';

// Mock DAG planner
const mockEstimatePipelineCost = vi.fn().mockReturnValue({ steps: [], totalCostUsd: 0.02 });
vi.mock('../../core/dag-planner.js', () => ({
  estimatePipelineCost: (...args: unknown[]) => mockEstimatePipelineCost(...args),
}));

// Mock runner — but keep the REAL buildRunCtx so the contract test asserts the
// actual option-shaping (the structural guard against the dropped-field drift).
const mockRunManifest = vi.fn();
const mockRetryManifest = vi.fn();
vi.mock('../../orchestrator/runner.js', async (importActual) => {
  const actual = await importActual<typeof import('../../orchestrator/runner.js')>();
  return {
    runManifest: (...args: unknown[]) => mockRunManifest(...args),
    retryManifest: (...args: unknown[]) => mockRetryManifest(...args),
    buildRunCtx: actual.buildRunCtx,
  };
});

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
  forgetPipeline,
  getPipelineStore,
  recordExecutedState,
  getExecutedResult,
  _resetPipelineStore,
  _summarizeStepOutput,
} from './pipeline.js';
import type { IAgent, ProcessParameter, AutonomyLevel } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';
import type { RunHistory } from '../../core/run-history.js';
// Resolves to the REAL buildRunCtx (the runner mock above passes it through via
// importActual) so the contract test exercises the actual option-shaping.
import { buildRunCtx } from '../../orchestrator/runner.js';

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
  // noteUntrustedData: the parent-taint seam (CORE-9) — a workflow run must latch
  // the parent's untrusted signal so its end-of-run memory extraction abstains.
  return { toolContext: ctx, noteUntrustedData: vi.fn() } as unknown as IAgent;
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

  it('CORE-9: seats the parent untrusted latch after a workflow runs (delegated output not persisted as trusted)', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    const result = await runWorkflowTool.handler(
      { name: 'single', steps: [makeStep('s1', 'do thing')] },
      agent,
    );
    // Result shape preserved (structured JSON, NOT wrapped) so callers still read it…
    expect((JSON.parse(result) as Record<string, unknown>)['status']).toBe('completed');
    // …and the parent's untrusted latch is seated so end-of-run extraction abstains,
    // exactly as spawn_agent propagates a sub-agent's taint.
    expect(agent.noteUntrustedData).toHaveBeenCalledTimes(1);
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

  it('passes context to manifest, exposed both top-level and under params (§4.5)', async () => {
    const agent = makePipelineAgent();
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    const context = { repo: 'lynox', branch: 'main' };
    await runWorkflowTool.handler(
      { name: 'test', steps: [makeStep('s1', 'do thing')], context },
      agent,
    );

    const manifestArg = mockRunManifest.mock.calls[0]![0] as Record<string, unknown>;
    // Top-level keys preserved ({{repo}} still resolves) + a params namespace
    // added ({{params.repo}} now resolves) — the inline {params} drift fix.
    expect(manifestArg['context']).toEqual({ ...context, params: context });
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
      // No `mode`, no `template` — full legacy row.
    };
    const fakeRunHistory = {
      getPlannedPipeline: () => ({ id: pipelineId, manifest_json: JSON.stringify(legacyPlanned) }),
    };
    const planned = getPipeline(pipelineId, fakeRunHistory as never);
    expect(planned?.mode).toBe('autonomous');
    expect(planned?.template).toBe(false);
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

  it('read-through SQLite cache respects the store cap (no unbounded growth)', () => {
    // Reading many distinct pipelines from SQLite must not grow the in-memory
    // store past MAX_PLANS — pre-fix the fallback did a raw `pipelineStore.set`,
    // bypassing the cap and leaking one entry per distinct id read.
    const fakeRunHistory = {
      getPlannedPipeline: (id: string) => ({
        id,
        manifest_json: JSON.stringify({
          id, name: 'p', goal: 'g', steps: [{ id: 'a', task: 'compute' }],
          reasoning: 'r', estimatedCost: 0, createdAt: new Date().toISOString(), executed: false,
        }),
      }),
    };
    // Zero-padded, equal-length ids so none is a prefix of another (the prefix
    // match in getPipeline would otherwise short-circuit the SQLite fallback).
    for (let i = 0; i < 15; i++) {
      getPipeline(`bulk-${String(i).padStart(2, '0')}`, fakeRunHistory as never);
    }
    expect(getPipelineStore().size).toBeLessThanOrEqual(10); // MAX_PLANS
  });

  it('executedStates uses LRU eviction — a re-recorded hot id survives eviction pressure', () => {
    _resetPipelineStore();
    const val = () => ({ manifest: {}, state: {} }) as unknown as Parameters<typeof recordExecutedState>[1];
    // Fill the retry buffer to its cap (MAX_EXECUTED_STATES = 50).
    for (let i = 0; i < 50; i++) recordExecutedState(`wf-${String(i).padStart(3, '0')}`, val());
    // Re-record the genuine-oldest id → LRU touch moves it to most-recent.
    recordExecutedState('wf-000', val());
    // One new id → evicts the true oldest (wf-001), NOT the re-touched wf-000.
    recordExecutedState('wf-new', val());
    // Pre-fix (plain Map.set + FIFO) wf-000 kept its original slot and would be
    // evicted here; LRU delete-then-set keeps it.
    expect(getExecutedResult('wf-000')).toBeDefined();
    expect(getExecutedResult('wf-001')).toBeUndefined();
    expect(getExecutedResult('wf-new')).toBeDefined();
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

  function seedSavedWorkflow(opts?: { template?: boolean; mode?: 'autonomous' | 'interactive'; steps?: InlinePipelineStep[]; params?: ProcessParameter[] }): string {
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
      parameters: opts?.params ?? [],
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

  it('A2: surfaces per-step errors + the terminal error from the run state', async () => {
    const id = seedSavedWorkflow();
    const outputs = new Map<string, AgentOutput>([
      ['ok-step', { stepId: 'ok-step', result: 'fine', startedAt: '', completedAt: '', durationMs: 5, tokensIn: 1, tokensOut: 1, costUsd: 0.002, skipped: false }],
      ['bad-step', { stepId: 'bad-step', result: '', startedAt: '', completedAt: '', durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, skipped: false, error: 'http 500 from upstream' }],
    ]);
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'run-err', status: 'failed', error: 'step "bad-step" failed', outputs }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(true); // the run executed; the failure is in status/stepErrors
    expect(result.status).toBe('failed');
    expect(result.error).toBe('step "bad-step" failed');
    expect(result.stepErrors).toEqual([{ stepId: 'bad-step', error: 'http 500 from upstream', costUsd: 0 }]);
    // a clean run reports no step errors
    expect(result.costUsd).toBeCloseTo(0.002, 6);
  });

  it('A2: a fully-successful run reports an empty stepErrors list', async () => {
    const id = seedSavedWorkflow();
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'run-ok' }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(true);
    expect(result.stepErrors).toEqual([]);
  });

  it('binds supplied re-target params into the run manifest context', async () => {
    const id = seedSavedWorkflow({
      params: [{ name: 'client', description: 'client name', type: 'string', source: 'user_input' }],
    });
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'rt-1' }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig, { client: 'Acme B' });
    expect(result.ok).toBe(true);
    // The bound params must reach the manifest the runner executes (the
    // {{params.*}} namespace) — the re-target seam.
    const manifestArg = mockRunManifest.mock.calls[0]![0] as { context?: { params?: Record<string, unknown> } };
    expect(manifestArg.context?.params).toEqual({ client: 'Acme B' });
  });

  it('rejects a missing required param when re-targeting (params supplied) — acceptance #4', async () => {
    const id = seedSavedWorkflow({
      params: [{ name: 'client', description: 'client name', type: 'string', source: 'user_input' }],
    });
    // A caller actively re-targeting (a params object given) but omitting a
    // required value gets a clean error — not a silent run.
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('client');
    expect(mockRunManifest).not.toHaveBeenCalled();
  });

  it('a no-param saved workflow still runs unchanged (cron-path regression)', async () => {
    const id = seedSavedWorkflow(); // parameters: []
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'np-1' }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig);
    expect(result.ok).toBe(true);
    expect(mockRunManifest).toHaveBeenCalledTimes(1);
  });

  it('forwards the engine tool set to runManifest so inline steps can execute headless', async () => {
    // The pre-replay gap: runSavedWorkflow ran inline steps with no parentTools,
    // so the runner threw "no parentTools provided" before any step ran.
    const id = seedSavedWorkflow();
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'pt-1' }));
    await runSavedWorkflow(id, fakeRunHistory as never, mockConfig, undefined, { tools: mockTools });
    const opts = mockRunManifest.mock.calls[0]![2] as { parentTools?: ToolEntry[] };
    expect(opts.parentTools).toBe(mockTools);
  });

  it('a required-param workflow still RUNS on the cron path (no params supplied) — no regression', async () => {
    // The autonomous path (cron / run_workflow) supplies no values. A required
    // param must NOT hard-fail the run — it binds leniently (placeholder stays
    // unresolved), preserving the pre-replay behaviour. (Refuter HIGH fix.)
    const id = seedSavedWorkflow({
      params: [{ name: 'month', description: 'report month', type: 'date', source: 'relative_date' }],
    });
    mockRunManifest.mockResolvedValueOnce(makeRunState({ runId: 'cron-1' }));
    const result = await runSavedWorkflow(id, fakeRunHistory as never, mockConfig); // no params
    expect(result.ok).toBe(true);
    expect(mockRunManifest).toHaveBeenCalledTimes(1);
    // The unbound param is absent from the manifest's params namespace.
    const manifestArg = mockRunManifest.mock.calls[0]![0] as { context?: { params?: Record<string, unknown> } };
    expect(manifestArg.context?.params).toEqual({});
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
// consumed by `executePipelineById` (the `run_workflow workflow_id:` path).
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

// ===========================================================================
// Slice A1 — run-context unification (buildRunCtx), autonomy posture, the
// capability-contract seam, and the §4.5 drift fixes.
// ===========================================================================

/** Every field buildRunCtx must emit — the structural guard against a call
 *  site silently dropping one (the parentTools / parentToolContext /
 *  userTimezone drift class C1). */
const RUN_CTX_KEYS = [
  'autonomy', 'parentTools', 'parentToolContext', 'parentMemory', 'userTimezone',
  'parentPrompt', 'parentSessionCounters', 'runHistory', 'hooks', 'capabilityContract',
  'secretStore',
] as const;

/** A pipeline agent with an explicit autonomy posture, for inheritance tests. */
function makeAutonomyAgent(autonomy: AutonomyLevel | undefined): IAgent {
  const ctx = createToolContext(mockConfig);
  ctx.tools = mockTools;
  return { toolContext: ctx, autonomy } as unknown as IAgent;
}

describe('A1: buildRunCtx — complete run-context shaping', () => {
  it('emits every option key (no field can be dropped) and requires autonomy', () => {
    const opts = buildRunCtx({ autonomy: 'autonomous' });
    for (const key of RUN_CTX_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(opts, key)).toBe(true);
    }
    expect(opts.autonomy).toBe('autonomous');
    // parentMemory normalises null when omitted; the rest are explicit undefined.
    expect(opts.parentMemory).toBeNull();
    expect(opts.parentToolContext).toBeUndefined();
    expect(opts.userTimezone).toBeUndefined();
    expect(opts.capabilityContract).toBeUndefined();
  });

  it('passes through the values it is given', () => {
    const tc = createToolContext(mockConfig);
    const opts = buildRunCtx({
      autonomy: undefined,
      parentToolContext: tc,
      userTimezone: 'Europe/Zurich',
    });
    expect(opts.autonomy).toBeUndefined();
    expect(opts.parentToolContext).toBe(tc);
    expect(opts.userTimezone).toBe('Europe/Zurich');
  });
});

describe('A1: every entrypoint routes a complete run-context (contract test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('headless saved-workflow run is autonomous + complete', async () => {
    const id = 'wf-headless';
    storePipeline(id, {
      id, name: 'headless', goal: 'g', steps: [{ id: 's', task: 't' }],
      reasoning: 'r', estimatedCost: 0, createdAt: new Date().toISOString(),
      executed: false, executionMode: 'orchestrated', template: true, mode: 'autonomous',
      parameters: [],
    });
    mockRunManifest.mockResolvedValueOnce(makeRunState());

    await runSavedWorkflow(id, { getPlannedPipeline: () => undefined } as never, mockConfig, undefined, { tools: mockTools });

    const opts = mockRunManifest.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['autonomy']).toBe('autonomous'); // C1: the headless posture is now explicit
    for (const key of RUN_CTX_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(opts, key)).toBe(true);
    }
    // Value (not just key): the headless path forwards the runtime tools, so a
    // future change that drops the VALUE (not just the key) is caught too.
    expect(opts['parentTools']).toBe(mockTools);
  });

  it('in-session inline run inherits the parent agent autonomy + forwards its context', async () => {
    const agent = makeAutonomyAgent('autonomous');
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler(
      { name: 'inline', steps: [makeStep('s1', 'do thing')] },
      agent,
    );
    const opts = mockRunManifest.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['autonomy']).toBe('autonomous');
    for (const key of RUN_CTX_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(opts, key)).toBe(true);
    }
    // Value assertion: the agent's tool context + tools actually flow through.
    expect(opts['parentToolContext']).toBe(agent.toolContext);
    expect(opts['parentTools']).toBe(agent.toolContext.tools);
  });

  it('threads the parent agent secretStore into the run options (value, not just key)', async () => {
    // The security fix: run_workflow forwards agent.secretStore so each step
    // sub-agent's tools resolve `secret:NAME` refs + fire the fail-loud guard —
    // instead of sending the literal `secret:NAME` to the external service.
    // Mirrors spawn.ts threading `parentAgent.secretStore` for spawn_agent.
    const agent = makeAutonomyAgent('autonomous');
    const secretStore = { maskSecrets: (t: string) => t } as unknown as IAgent['secretStore'];
    (agent as unknown as { secretStore: unknown }).secretStore = secretStore;
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler(
      { name: 'inline', steps: [makeStep('s1', 'call api with secret')] },
      agent,
    );
    const opts = mockRunManifest.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['secretStore']).toBe(secretStore);
  });

  it('leaves secretStore undefined for a chat agent with no vault (backward-compat)', async () => {
    const agent = makeAutonomyAgent(undefined); // no secretStore set
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler(
      { name: 'inline', steps: [makeStep('s1', 'no secret')] },
      agent,
    );
    const opts = mockRunManifest.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['secretStore']).toBeUndefined();
  });

  it('in-session stored run inherits undefined autonomy from a normal chat agent', async () => {
    const id = seedStoredPipeline();
    const agent = makeAutonomyAgent(undefined);
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler({ workflow_id: id }, agent);
    const opts = mockRunManifest.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['autonomy']).toBeUndefined(); // normal chat keeps interactive prompting
    for (const key of RUN_CTX_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(opts, key)).toBe(true);
    }
    expect(opts['parentToolContext']).toBe(agent.toolContext);
  });

  it('retry path no longer drops parentToolContext + userTimezone (value, not just key)', async () => {
    const id = seedStoredPipeline();
    // First run populates executedStates.
    mockRunManifest.mockResolvedValueOnce(makeRunState({ status: 'failed' }));
    const agent = makeAutonomyAgent(undefined);
    // Give the agent a userTimezone so the retry can carry it.
    (agent as unknown as { userTimezone: string }).userTimezone = 'Europe/Zurich';
    await runWorkflowTool.handler({ workflow_id: id }, agent);

    mockRetryManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler({ workflow_id: id, retry: true }, agent);

    const retryOpts = mockRetryManifest.mock.calls[0]![3] as Record<string, unknown>;
    // The historical bug dropped these two fields entirely. Assert the actual
    // VALUES flow through, not merely that the keys exist (buildRunCtx always
    // emits the keys, so a key-only check would not catch a re-introduced drop).
    expect(retryOpts['parentToolContext']).toBe(agent.toolContext);
    expect(retryOpts['userTimezone']).toBe('Europe/Zurich');
  });
});

describe('A1: §4.5 drift fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPipelineStore();
    mockValidateManifest.mockImplementation((m: unknown) => m);
  });

  it('runSavedWorkflow honours the stored on_failure strategy (not hardcoded stop)', async () => {
    const id = 'wf-onfail';
    storePipeline(id, {
      id, name: 'onfail', goal: 'g', steps: [{ id: 's', task: 't' }],
      reasoning: 'r', estimatedCost: 0, createdAt: new Date().toISOString(),
      executed: false, executionMode: 'orchestrated', template: true, mode: 'autonomous',
      parameters: [], on_failure: 'continue',
    });
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runSavedWorkflow(id, { getPlannedPipeline: () => undefined } as never, mockConfig, undefined, { tools: mockTools });
    const manifest = mockRunManifest.mock.calls[0]![0] as { on_failure: string };
    expect(manifest.on_failure).toBe('continue');
  });

  it('inline run exposes context under both top-level and the params namespace', async () => {
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler(
      { name: 'inline', steps: [makeStep('s1', 'do thing')], context: { foo: 'bar' } },
      makeAutonomyAgent(undefined),
    );
    const manifest = mockRunManifest.mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(manifest.context['foo']).toBe('bar'); // legacy {{foo}} still resolves
    expect((manifest.context['params'] as Record<string, unknown>)['foo']).toBe('bar'); // {{params.foo}} now resolves
  });

  it('run_workflow re-targets a stored workflow via params', async () => {
    const id = 'wf-retarget';
    storePipeline(id, {
      id, name: 'retarget', goal: 'g', steps: [{ id: 's', task: 'report for {{params.client}}' }],
      reasoning: 'r', estimatedCost: 0, createdAt: new Date().toISOString(),
      executed: false, executionMode: 'orchestrated', template: true, mode: 'autonomous',
      parameters: [{ name: 'client', description: 'client name', type: 'string', source: 'user_input' }],
    });
    mockRunManifest.mockResolvedValueOnce(makeRunState());
    await runWorkflowTool.handler({ workflow_id: id, params: { client: 'Acme' } }, makeAutonomyAgent(undefined));
    const manifest = mockRunManifest.mock.calls[0]![0] as { context: { params: Record<string, unknown> } };
    expect(manifest.context.params['client']).toBe('Acme');
  });

  it('non-template reentrancy: a retry while the run is in flight is rejected, not 404', async () => {
    const id = seedStoredPipeline(); // template:false → non-template
    let resolveRun!: (v: RunState) => void;
    mockRunManifest.mockImplementationOnce(() => new Promise<RunState>(res => { resolveRun = res; }));
    const agent = makeAutonomyAgent(undefined);

    const inFlight = runWorkflowTool.handler({ workflow_id: id }, agent); // starts, parks at await
    await Promise.resolve();
    const retry = await runWorkflowTool.handler({ workflow_id: id, retry: true }, agent);
    expect(retry).toMatch(/still running/);

    resolveRun(makeRunState());
    await inFlight;
  });
});
