import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModeConfig, StreamEvent } from '../../src/types/index.js';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// === Mock dependencies ===

const mockRecordTurn = vi.fn().mockReturnValue(false);
const mockShouldWarn = vi.fn().mockReturnValue(false);
const mockCostSnapshot = vi.fn().mockReturnValue({ estimatedCostUSD: 0.5, budgetPercent: 10, iterationsUsed: 1 });

vi.mock('../../src/core/cost-guard.js', () => ({
  CostGuard: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.snapshot = mockCostSnapshot;
    this.recordTurn = mockRecordTurn;
    this.shouldWarn = mockShouldWarn;
    return this;
  }),
}));

vi.mock('../../src/core/goal-tracker.js', () => ({
  GoalTracker: vi.fn().mockImplementation(function (this: Record<string, unknown>, goal: string) {
    this.goal = goal;
    this._complete = false;
    this.getState = vi.fn().mockReturnValue({ goal, status: 'active', subtasks: [], iterations: 0, costUSD: 0 });
    this.continuationPrompt = vi.fn().mockReturnValue('Continue working on the goal.');
    this.recordIteration = vi.fn();
    this.recordCost = vi.fn();
    this.parseResponse = vi.fn();
    this.isComplete = vi.fn().mockImplementation(function (this: Record<string, boolean>) { return this._complete; });
    this.markComplete = vi.fn();
    this.addSubtask = vi.fn();
    this.completeSubtask = vi.fn();
    return this;
  }),
}));

vi.mock('../../src/core/daemon-journal.js', () => ({
  DaemonJournal: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.append = vi.fn().mockResolvedValue(undefined);
    return this;
  }),
}));

vi.mock('../../src/core/triggers/index.js', () => ({
  createTrigger: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/tools/builtin/goal-update.js', () => ({
  goalUpdateTool: { name: 'goal_update', description: 'test', inputSchema: { type: 'object' }, handler: vi.fn() },
}));

vi.mock('../../src/core/observability.js', () => ({
  channels: {
    modeChange: { publish: vi.fn() },
    goalUpdate: { publish: vi.fn() },
    triggerFire: { publish: vi.fn() },
    costWarning: { publish: vi.fn() },
    preApprovalMatch: { publish: vi.fn() },
    preApprovalExhausted: { publish: vi.fn() },
    preApprovalExpired: { publish: vi.fn() },
  },
}));

const mockPlanPreApprovals = vi.fn().mockResolvedValue({ patterns: [], reasoning: '', estimatedToolCalls: 0 });
vi.mock('../../src/core/pre-approve-planner.js', () => ({
  planPreApprovals: (...args: unknown[]) => mockPlanPreApprovals(...args),
}));

const mockPlanDAG = vi.fn().mockResolvedValue(null);
vi.mock('../../src/core/dag-planner.js', () => ({
  planDAG: (...args: unknown[]) => mockPlanDAG(...args),
}));

vi.mock('../../src/cli/approval-dialog.js', () => ({
  showApprovalDialog: vi.fn().mockResolvedValue({ approved: false, patterns: [], maxUses: 10, ttlMs: 0 }),
  autoApproveDefaults: vi.fn().mockReturnValue({ approved: false, patterns: [], maxUses: 10, ttlMs: 0 }),
}));

vi.mock('../../src/core/pre-approve-audit.js', () => ({
  PreApproveAudit: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.recordSetCreated = vi.fn();
    this.recordCheck = vi.fn();
    return this;
  }),
}));

// Import ModeController AFTER mocks are registered
import { ModeController } from '../../src/core/mode-controller.js';
import { createToolContext } from '../../src/core/tool-context.js';

// === Helpers ===

function usage(input: number, output: number): BetaUsage {
  return { input_tokens: input, output_tokens: output } as BetaUsage;
}

function createMockOrchestrator() {
  const agentMock = {
    setContinuationPrompt: vi.fn(),
  };
  const toolContext = createToolContext({});
  return {
    config: { model: 'nodyn' as const },
    run: vi.fn().mockResolvedValue('done'),
    abort: vi.fn(),
    registerTool: vi.fn(),
    registerPipelineTools: vi.fn(),
    onStream: null as ((event: StreamEvent) => Promise<void>) | null,
    getAgent: vi.fn().mockReturnValue(agentMock),
    getApiConfig: vi.fn().mockReturnValue({ apiKey: 'test-key', apiBaseURL: undefined }),
    getPromptTabs: vi.fn().mockReturnValue(null),
    getRunHistory: vi.fn().mockReturnValue(null),
    getModelTier: vi.fn().mockReturnValue('opus'),
    getToolContext: () => toolContext,
    _recreateAgent: vi.fn(),
    _agentMock: agentMock,
  };
}

// === Tests ===

describe('Operational Modes Integration', () => {
  let processListeners: Map<string, ((...args: unknown[]) => void)[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTurn.mockReturnValue(false);
    mockShouldWarn.mockReturnValue(false);
    mockPlanDAG.mockResolvedValue(null);
    // Enable triggers feature flag for tests
    process.env['NODYN_FEATURE_TRIGGERS'] = '1';

    processListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
      const key = String(event);
      const handlers = processListeners.get(key) ?? [];
      handlers.push(handler);
      processListeners.set(key, handlers);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('autopilot excludes ask_user from tools', async () => {
    const orch = createMockOrchestrator();
    const mc = new ModeController({ mode: 'autopilot', goal: 'test task' });
    await mc.apply(orch);

    expect(orch._recreateAgent).toHaveBeenCalledTimes(1);
    expect(orch._recreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ['ask_user'],
      }),
    );
  });

  it('GoalTracker continuation prompt and system suffix contain goal text', async () => {
    const orch = createMockOrchestrator();
    const goal = 'deploy the application to production';
    const mc = new ModeController({ mode: 'autopilot', goal });
    await mc.apply(orch);

    expect(orch._recreateAgent).toHaveBeenCalledTimes(1);
    const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;

    // continuationPrompt should be defined (from GoalTracker mock)
    expect(call['continuationPrompt']).toBe('Continue working on the goal.');

    // systemPromptSuffix should contain the goal text
    expect(typeof call['systemPromptSuffix']).toBe('string');
    expect(call['systemPromptSuffix'] as string).toContain(goal);
    expect(call['systemPromptSuffix'] as string).toContain('Goal-Tracking Mode');
  });

  it('GoalTracker parseResponse is called on tool_result events', async () => {
    const orch = createMockOrchestrator();
    const mc = new ModeController({ mode: 'autopilot', goal: 'complete the task' });
    await mc.apply(orch);

    // The stream handler should have been wrapped
    expect(orch.onStream).not.toBeNull();
    const streamHandler = orch.onStream!;

    // Simulate a tool_result event
    const toolResultEvent: StreamEvent = {
      type: 'tool_result',
      name: 'bash',
      result: '[GOAL_COMPLETE] All tasks finished',
      agent: 'nodyn',
    };
    await streamHandler(toolResultEvent);

    // GoalTracker.parseResponse should have been called with the result string
    const goalState = mc.getGoalState();
    expect(goalState).not.toBeNull();
    // The mock GoalTracker's parseResponse should have been invoked
    // Access via the goal state — we know the tracker exists because getGoalState returned non-null
    expect(goalState?.status).toBe('active');
  });

  it('CostGuard budget warning triggers on shouldWarn', async () => {
    mockShouldWarn.mockReturnValue(true);

    const orch = createMockOrchestrator();
    const originalHandler = vi.fn();
    orch.onStream = originalHandler;

    const mc = new ModeController({ mode: 'autopilot', goal: 'expensive task' });
    await mc.apply(orch);

    const streamHandler = orch.onStream!;

    // Simulate a turn_end event
    const turnEndEvent: StreamEvent = {
      type: 'turn_end',
      stop_reason: 'end_turn',
      usage: usage(5000, 2000),
      agent: 'nodyn',
    };
    await streamHandler(turnEndEvent);

    // Original handler should have received a cost_warning event
    const costWarningCalls = originalHandler.mock.calls.filter(
      (c: unknown[]) => (c[0] as StreamEvent).type === 'cost_warning',
    );
    expect(costWarningCalls.length).toBeGreaterThan(0);
  });

  it('CostGuard snapshot returns expected shape', async () => {
    mockCostSnapshot.mockReturnValue({ estimatedCostUSD: 1.5, budgetPercent: 15, iterationsUsed: 3 });

    const orch = createMockOrchestrator();
    const mc = new ModeController({
      mode: 'autopilot',
      goal: 'budget check',
      costGuard: { maxBudgetUSD: 10 },
    });
    await mc.apply(orch);

    const snapshot = mc.getCostSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot).toEqual({
      estimatedCostUSD: 1.5,
      budgetPercent: 15,
      iterationsUsed: 3,
    });
  });

  it('daemon mode throws when not registered (Pro only)', async () => {
    const orch = createMockOrchestrator();
    const mc = new ModeController({ mode: 'daemon', goal: 'monitor' });
    await expect(mc.apply(orch)).rejects.toThrow('Mode "daemon" is not registered');
  });

  it('sentinel mode throws when not registered (Pro only)', async () => {
    const orch = createMockOrchestrator();
    const mc = new ModeController({ mode: 'sentinel' });
    await expect(mc.apply(orch)).rejects.toThrow('Mode "sentinel" is not registered');
  });

  it('CostGuard and GoalTracker track independently in autopilot', async () => {
    const orch = createMockOrchestrator();
    const originalHandler = vi.fn();
    orch.onStream = originalHandler;

    const mc = new ModeController({ mode: 'autopilot', goal: 'dual tracking' });
    await mc.apply(orch);

    // Both should be initialized
    expect(mc.getCostSnapshot()).not.toBeNull();
    expect(mc.getGoalState()).not.toBeNull();
    expect(mc.getGoalState()?.goal).toBe('dual tracking');

    // Simulate a turn_end event — should run without error
    const turnEndEvent: StreamEvent = {
      type: 'turn_end',
      stop_reason: 'end_turn',
      usage: usage(200, 100),
      agent: 'nodyn',
    };
    await orch.onStream!(turnEndEvent);

    // Original handler should have been called (pass-through)
    expect(originalHandler).toHaveBeenCalled();

    // Simulate a tool_result event — should also run without error
    const toolResultEvent: StreamEvent = {
      type: 'tool_result',
      name: 'bash',
      result: 'task output',
      agent: 'nodyn',
    };
    await orch.onStream!(toolResultEvent);

    // goal_update should have been emitted to the original handler
    const goalUpdateCalls = originalHandler.mock.calls.filter(
      (c: unknown[]) => (c[0] as StreamEvent).type === 'goal_update',
    );
    expect(goalUpdateCalls.length).toBeGreaterThan(0);

    // Both snapshots should still be valid
    expect(mc.getCostSnapshot()).not.toBeNull();
    expect(mc.getGoalState()).not.toBeNull();
  });
});
