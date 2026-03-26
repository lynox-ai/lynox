import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock planDAG for auto-planning tests
const mockPlanDAG = vi.fn();
vi.mock('../../core/dag-planner.js', () => ({
  planDAG: (...args: unknown[]) => mockPlanDAG(...args),
  estimatePipelineCost: vi.fn().mockReturnValue({ steps: [], totalCostUsd: 0.02 }),
}));

import { planTaskTool, phasesToPipelineSteps } from './plan-task.js';
import { _resetPipelineStore, getPipeline } from './pipeline.js';
import { createToolContext } from '../../core/tool-context.js';
import type { IAgent, LynoxUserConfig } from '../../types/index.js';

const mockConfig: LynoxUserConfig = { api_key: 'test-key' };

function makeAgent(overrides: Partial<IAgent> = {}, userConfig: LynoxUserConfig = {}): IAgent {
  const toolContext = createToolContext(userConfig);
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    toolContext,
    ...overrides,
  } as unknown as IAgent;
}

beforeEach(() => {
  _resetPipelineStore();
  vi.clearAllMocks();
});

describe('planTaskTool', () => {
  // --- Core approval flow ---

  it('should auto-approve in non-interactive context', async () => {
    const agent = makeAgent({ promptUser: undefined });
    const result = await planTaskTool.handler(
      { summary: 'Test plan', steps: ['Step 1'] },
      agent,
    );
    expect(JSON.parse(result)).toEqual({ approved: true });
  });

  it('should return approved on Proceed', async () => {
    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      { summary: 'Test plan', steps: ['Step 1'] },
      agent,
    );
    const parsed = JSON.parse(result) as { approved: boolean };
    expect(parsed.approved).toBe(true);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('should accept y/yes as approval', async () => {
    for (const answer of ['y', 'yes', 'Y', 'YES']) {
      const promptUser = vi.fn().mockResolvedValue(answer);
      const agent = makeAgent({ promptUser });
      const result = await planTaskTool.handler(
        { summary: 'Test', steps: ['Step'] },
        agent,
      );
      expect(JSON.parse(result)).toMatchObject({ approved: true });
    }
  });

  it('should return rejected on Cancel', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      { summary: 'Test', steps: ['Step'] },
      agent,
    );
    const parsed = JSON.parse(result) as { approved: boolean; feedback: string };
    expect(parsed.approved).toBe(false);
    expect(parsed.feedback).toContain('canceled');
  });

  it('should return feedback on Adjust', async () => {
    const promptUser = vi.fn().mockResolvedValue('Adjust');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      { summary: 'Test', steps: ['Step'] },
      agent,
    );
    const parsed = JSON.parse(result) as { approved: boolean; feedback: string };
    expect(parsed.approved).toBe(false);
    expect(parsed.feedback).toContain('adjustments');
  });

  it('should return free-text as feedback', async () => {
    const promptUser = vi.fn().mockResolvedValue('Use PostgreSQL instead');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      { summary: 'Test', steps: ['Step'] },
      agent,
    );
    const parsed = JSON.parse(result) as { approved: boolean; feedback: string };
    expect(parsed.approved).toBe(false);
    expect(parsed.feedback).toBe('Use PostgreSQL instead');
  });

  // --- Business-friendly presentation ---

  it('should present phases as numbered steps', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const agent = makeAgent({ promptUser });
    await planTaskTool.handler(
      {
        summary: 'Automate monthly sales report',
        phases: [
          { name: 'Pull sales data from CRM', steps: ['Export CSV'] },
          { name: 'Clean up date formats', steps: ['Parse dates'] },
          { name: 'Generate report', steps: ['Build charts'] },
        ],
      },
      agent,
    );

    const question = promptUser.mock.calls[0]![0] as string;
    expect(question).toContain('1. Pull sales data from CRM');
    expect(question).toContain('2. Clean up date formats');
    expect(question).toContain('3. Generate report');
    // No developer jargon
    expect(question).not.toContain('Phase');
    expect(question).not.toContain('[opus]');
    expect(question).not.toContain('[sonnet]');
    expect(question).not.toContain('Verify:');
  });

  it('should mark user steps with [your input needed]', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const agent = makeAgent({ promptUser });
    await planTaskTool.handler(
      {
        summary: 'Data import',
        phases: [
          { name: 'Prepare schema', steps: ['Create tables'] },
          { name: 'Upload your CSV file', steps: ['Upload file'], assignee: 'user' },
          { name: 'Import and validate', steps: ['Parse data'] },
        ],
      },
      agent,
    );

    const question = promptUser.mock.calls[0]![0] as string;
    expect(question).toContain('1. Prepare schema');
    expect(question).toContain('2. Upload your CSV file [your input needed]');
    expect(question).toContain('3. Import and validate');
  });

  it('should show context findings', async () => {
    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser });
    await planTaskTool.handler(
      {
        summary: 'Optimize ad spend',
        context: {
          summary: 'Checked your Google Ads account',
          findings: ['3 campaigns active', 'Budget split is uneven'],
        },
        steps: ['Rebalance budgets'],
      },
      agent,
    );

    const question = promptUser.mock.calls[0]![0] as string;
    expect(question).toContain('Checked your Google Ads account');
    expect(question).toContain('3 campaigns active');
    expect(question).toContain('Budget split is uneven');
  });

  it('should end with "Shall I proceed?"', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const agent = makeAgent({ promptUser });
    await planTaskTool.handler({ summary: 'Test' }, agent);
    const question = promptUser.mock.calls[0]![0] as string;
    expect(question).toContain('Shall I proceed?');
  });

  // --- Pipeline bridge ---

  it('should create pipeline on phased plan approval', async () => {
    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      {
        summary: 'Build quarterly report',
        phases: [
          { name: 'Fetch data', steps: ['Query API', 'Parse response'] },
          { name: 'Generate report', steps: ['Aggregate', 'Format'], depends_on: ['Fetch data'] },
        ],
      },
      agent,
    );

    const parsed = JSON.parse(result) as { approved: boolean; pipeline_id: string };
    expect(parsed.approved).toBe(true);
    expect(parsed.pipeline_id).toBeDefined();

    const pipeline = getPipeline(parsed.pipeline_id);
    expect(pipeline).toBeDefined();
    expect(pipeline!.goal).toBe('Build quarterly report');
    expect(pipeline!.steps).toHaveLength(2);
    expect(pipeline!.steps[1]!.input_from).toEqual(['fetch-data']);
  });

  it('should not create pipeline for flat steps', async () => {
    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      { summary: 'Simple task', steps: ['Do it'] },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.approved).toBe(true);
    expect(parsed).not.toHaveProperty('pipeline_id');
  });

  it('should not create pipeline on cancel', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      {
        summary: 'Canceled',
        phases: [{ name: 'Step', steps: ['do'] }],
      },
      agent,
    );

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.approved).toBe(false);
    expect(parsed).not.toHaveProperty('pipeline_id');
  });

  it('should list user steps in response', async () => {
    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser });
    const result = await planTaskTool.handler(
      {
        summary: 'Collaborative flow',
        phases: [
          { name: 'Research', steps: ['Explore'] },
          { name: 'Review findings', steps: ['Check results'], assignee: 'user' },
          { name: 'Implement', steps: ['Build it'], depends_on: ['Review findings'] },
        ],
      },
      agent,
    );

    const parsed = JSON.parse(result) as { approved: boolean; pipeline_id: string; user_steps: string[] };
    expect(parsed.approved).toBe(true);
    expect(parsed.pipeline_id).toBeDefined();
    expect(parsed.user_steps).toEqual(['Review findings']);
  });

  it('should auto-approve with pipeline in non-interactive context', async () => {
    const agent = makeAgent({ promptUser: undefined });
    const result = await planTaskTool.handler(
      {
        summary: 'Auto plan',
        phases: [
          { name: 'Step A', steps: ['do'] },
          { name: 'Step B', steps: ['do'], depends_on: ['Step A'] },
        ],
      },
      agent,
    );

    const parsed = JSON.parse(result) as { approved: boolean; pipeline_id: string };
    expect(parsed.approved).toBe(true);
    expect(parsed.pipeline_id).toBeDefined();
  });
});

describe('phasesToPipelineSteps', () => {
  it('should convert phases to pipeline steps with dependencies', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Fetch Data', steps: ['Call API', 'Parse JSON'] },
      { name: 'Analyze', steps: ['Run analysis'], depends_on: ['Fetch Data'] },
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]!.id).toBe('fetch-data');
    expect(steps[0]!.task).toContain('1. Call API');
    expect(steps[0]!.input_from).toBeUndefined();
    expect(steps[1]!.id).toBe('analyze');
    expect(steps[1]!.input_from).toEqual(['fetch-data']);
  });

  it('should handle duplicate names', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Process', steps: ['first'] },
      { name: 'Process', steps: ['second'] },
    ]);
    expect(steps[0]!.id).toBe('process');
    expect(steps[1]!.id).toBe('process-2');
  });

  it('should include verification in task', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Build', steps: ['Compile'], verification: 'no errors' },
    ]);
    expect(steps[0]!.task).toContain('After completing, verify: no errors');
  });

  it('should exclude user phases', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Auto step', steps: ['do'] },
      { name: 'Manual step', steps: ['user does'], assignee: 'user' },
      { name: 'Continue', steps: ['finish'], depends_on: ['Manual step'] },
    ]);

    expect(steps).toHaveLength(2);
    expect(steps.map(s => s.id)).toEqual(['auto-step', 'continue']);
    // depends_on still resolves (for context flow after user completes their part)
    expect(steps[1]!.input_from).toEqual(['manual-step']);
  });

  it('should not pass model/role (runtime decides)', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Step', steps: ['do'] },
    ]);
    expect(steps[0]!.model).toBeUndefined();
    expect(steps[0]!.role).toBeUndefined();
  });

  it('should handle independent phases (parallel execution)', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Task A', steps: ['do A'] },
      { name: 'Task B', steps: ['do B'] },
      { name: 'Combine', steps: ['merge'], depends_on: ['Task A', 'Task B'] },
    ]);

    expect(steps[0]!.input_from).toBeUndefined();
    expect(steps[1]!.input_from).toBeUndefined();
    expect(steps[2]!.input_from).toEqual(['task-a', 'task-b']);
  });

  it('should ignore unknown depends_on', () => {
    const steps = phasesToPipelineSteps([
      { name: 'Step', steps: ['do'], depends_on: ['NonExistent'] },
    ]);
    expect(steps[0]!.input_from).toBeUndefined();
  });
});

describe('plan_task auto-planning fallback', () => {
  it('should auto-generate phases when no phases/steps provided', async () => {
    mockPlanDAG.mockResolvedValueOnce({
      steps: [
        { id: 'research', task: 'Research the topic' },
        { id: 'write', task: 'Write the report', input_from: ['research'] },
      ],
      reasoning: 'Two-phase approach',
      estimatedCost: 0.02,
    });

    const agent = makeAgent({ promptUser: undefined }, mockConfig);
    const result = await planTaskTool.handler(
      { summary: 'Create a research report' },
      agent,
    );

    const parsed = JSON.parse(result) as { approved: boolean; pipeline_id: string };
    expect(parsed.approved).toBe(true);
    expect(parsed.pipeline_id).toBeDefined();
    expect(mockPlanDAG).toHaveBeenCalledOnce();

    const pipeline = getPipeline(parsed.pipeline_id);
    expect(pipeline).toBeDefined();
    expect(pipeline!.steps).toHaveLength(2);
    expect(pipeline!.steps[1]!.input_from).toEqual(['research']);
  });

  it('should skip auto-plan when planDAG returns null', async () => {
    mockPlanDAG.mockResolvedValueOnce(null);

    const promptUser = vi.fn().mockResolvedValue('Proceed');
    const agent = makeAgent({ promptUser }, mockConfig);
    const result = await planTaskTool.handler(
      { summary: 'Simple task' },
      agent,
    );

    const parsed = JSON.parse(result) as { approved: boolean };
    expect(parsed.approved).toBe(true);
    expect(parsed).not.toHaveProperty('pipeline_id');
  });

  it('should skip auto-plan when no API key configured', async () => {
    // No setPlanTaskConfig call — no config
    const agent = makeAgent({ promptUser: undefined });
    const result = await planTaskTool.handler(
      { summary: 'Task without config' },
      agent,
    );

    expect(mockPlanDAG).not.toHaveBeenCalled();
    const parsed = JSON.parse(result) as { approved: boolean };
    expect(parsed.approved).toBe(true);
  });

  it('should not auto-plan when phases are provided', async () => {
    const agent = makeAgent({ promptUser: undefined }, mockConfig);
    const result = await planTaskTool.handler(
      {
        summary: 'Manual plan',
        phases: [{ name: 'Step 1', steps: ['do it'] }],
      },
      agent,
    );

    expect(mockPlanDAG).not.toHaveBeenCalled();
    const parsed = JSON.parse(result) as { approved: boolean; pipeline_id: string };
    expect(parsed.pipeline_id).toBeDefined();
  });
});
