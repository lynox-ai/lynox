import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModeController } from './mode-controller.js';
import { createToolContext } from './tool-context.js';
import type { ModeConfig, StreamEvent } from '../types/index.js';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// === Mock dependencies ===

const mockRecordTurn = vi.fn().mockReturnValue(false);
const mockShouldWarn = vi.fn().mockReturnValue(false);
const mockCostSnapshot = vi.fn().mockReturnValue({ estimatedCostUSD: 0.5, budgetPercent: 10, iterationsUsed: 1 });

vi.mock('./cost-guard.js', () => ({
  CostGuard: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.snapshot = mockCostSnapshot;
    this.recordTurn = mockRecordTurn;
    this.shouldWarn = mockShouldWarn;
    return this;
  }),
}));

vi.mock('./goal-tracker.js', () => ({
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

vi.mock('./daemon-journal.js', () => ({
  DaemonJournal: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.append = vi.fn().mockResolvedValue(undefined);
    return this;
  }),
}));

vi.mock('./triggers/index.js', () => ({
  createTrigger: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../tools/builtin/goal-update.js', () => ({
  goalUpdateTool: { name: 'goal_update', description: 'test', inputSchema: { type: 'object' }, handler: vi.fn() },
}));

vi.mock('./observability.js', () => ({
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

const mockPlanDAG = vi.fn().mockResolvedValue(null);
vi.mock('./dag-planner.js', () => ({
  planDAG: (...args: unknown[]) => mockPlanDAG(...args),
}));

vi.mock('./pre-approve-audit.js', () => ({
  PreApproveAudit: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.recordSetCreated = vi.fn();
    this.recordCheck = vi.fn();
    return this;
  }),
}));

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
    config: { model: 'opus' as const },
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

describe('ModeController', () => {
  let processListeners: Map<string, ((...args: unknown[]) => void)[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTurn.mockReturnValue(false);
    mockShouldWarn.mockReturnValue(false);
    mockCostSnapshot.mockReturnValue({ estimatedCostUSD: 0.5, budgetPercent: 10, iterationsUsed: 1 });
    mockPlanDAG.mockResolvedValue(null);
    // Enable triggers feature flag for tests
    process.env['NODYN_FEATURE_TRIGGERS'] = '1';

    processListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...args: any[]) => void) => {
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

  describe('constructor & getters', () => {
    it('returns the configured mode', () => {
      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      expect(mc.getMode()).toBe('autopilot');
    });

    it('returns null snapshots before apply', () => {
      const mc = new ModeController({ mode: 'interactive' });
      expect(mc.getCostSnapshot()).toBeNull();
      expect(mc.getGoalState()).toBeNull();
    });
  });

  describe('interactive mode', () => {
    it('recreates agent with maxIterations=20', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'interactive' });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalledWith({ maxIterations: 20 });
    });

    it('skips cost guard when no costGuard config', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'interactive' });
      await mc.apply(orch);
      expect(mc.getCostSnapshot()).toBeNull();
    });

    it('creates cost guard when costGuard config provided', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'interactive', costGuard: { maxBudgetUSD: 5 } });
      await mc.apply(orch);
      expect(mc.getCostSnapshot()).not.toBeNull();
    });
  });

  describe('autopilot mode', () => {
    it('throws when no goal provided', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot' });
      await expect(mc.apply(orch)).rejects.toThrow('Autopilot mode requires a goal.');
    });

    it('creates cost guard with default $5 budget', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'deploy app' });
      await mc.apply(orch);
      expect(mc.getCostSnapshot()).not.toBeNull();
    });

    it('creates goal tracker and registers goal_update tool', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'deploy app' });
      await mc.apply(orch);
      expect(mc.getGoalState()).not.toBeNull();
      expect(mc.getGoalState()?.status).toBe('active');
      expect(orch.registerTool).toHaveBeenCalled();
    });

    it('recreates agent with correct overrides', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'deploy app' });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalledWith(expect.objectContaining({
        maxIterations: 50,
        excludeTools: ['ask_user'],
      }));
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['continuationPrompt']).toBeDefined();
      expect(typeof call['systemPromptSuffix']).toBe('string');
      expect(call['systemPromptSuffix'] as string).toContain('deploy app');
    });
  });

  describe('unregistered Pro modes', () => {
    it('throws for sentinel when not registered', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'sentinel' });
      await expect(mc.apply(orch)).rejects.toThrow('Mode "sentinel" is not registered');
    });

    it('throws for daemon when not registered', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'daemon' });
      await expect(mc.apply(orch)).rejects.toThrow('Mode "daemon" is not registered');
    });

    it('throws for swarm when not registered', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'swarm' });
      await expect(mc.apply(orch)).rejects.toThrow('Mode "swarm" is not registered');
    });
  });

  describe('stream handler wrapping', () => {
    it('tracks costs on turn_end events', async () => {
      const orch = createMockOrchestrator();
      const originalHandler = vi.fn();
      orch.onStream = originalHandler;

      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      await mc.apply(orch);

      // Stream handler should be wrapped (different from original)
      expect(orch.onStream).not.toBe(originalHandler);

      // Simulate a turn_end event
      await orch.onStream!({ type: 'turn_end', stop_reason: 'end_turn', usage: usage(100, 50), agent: 'nodyn' } as StreamEvent);
      expect(originalHandler).toHaveBeenCalled();
    });

    it('emits goal_update on tool_result with string result', async () => {
      const orch = createMockOrchestrator();
      const originalHandler = vi.fn();
      orch.onStream = originalHandler;

      const mc = new ModeController({ mode: 'autopilot', goal: 'test goal' });
      await mc.apply(orch);

      await orch.onStream!({ type: 'tool_result', name: 'bash', result: 'some output', agent: 'nodyn' } as StreamEvent);

      // Should emit goal_update to original handler
      const goalUpdateCalls = originalHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as StreamEvent).type === 'goal_update'
      );
      expect(goalUpdateCalls.length).toBeGreaterThan(0);
    });

    it('aborts when cost guard budget exceeded', async () => {
      const orch = createMockOrchestrator();
      const originalHandler = vi.fn();
      orch.onStream = originalHandler;

      const mc = new ModeController({ mode: 'autopilot', goal: 'test', costGuard: { maxBudgetUSD: 1 } });
      await mc.apply(orch);

      // Make recordTurn return true (exceeded) for the next call
      mockRecordTurn.mockReturnValueOnce(true);

      await orch.onStream!({ type: 'turn_end', stop_reason: 'end_turn', usage: usage(1000, 500), agent: 'nodyn' } as StreamEvent);
      expect(orch.abort).toHaveBeenCalled();
    });

    it('passes through non-tracked events to original handler', async () => {
      const orch = createMockOrchestrator();
      const originalHandler = vi.fn();
      orch.onStream = originalHandler;

      const mc = new ModeController({ mode: 'interactive', costGuard: { maxBudgetUSD: 5 } });
      await mc.apply(orch);

      await orch.onStream!({ type: 'text', text: 'hello', agent: 'nodyn' } as StreamEvent);
      expect(originalHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'text' }));
    });
  });

  describe('teardown', () => {
    it('resets all state to null', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      await mc.apply(orch);
      expect(mc.getCostSnapshot()).not.toBeNull();
      expect(mc.getGoalState()).not.toBeNull();

      await mc.teardown();
      expect(mc.getCostSnapshot()).toBeNull();
      expect(mc.getGoalState()).toBeNull();
    });

    it('restores original stream handler', async () => {
      const orch = createMockOrchestrator();
      const originalHandler = vi.fn();
      orch.onStream = originalHandler;

      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      await mc.apply(orch);
      expect(orch.onStream).not.toBe(originalHandler);

      await mc.teardown();
      expect(orch.onStream).toBe(originalHandler);
    });
  });


  describe('autonomy threading', () => {
    it('autopilot mode passes autonomy to agent', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'test', autonomy: 'guided' });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalledWith(expect.objectContaining({ autonomy: 'guided' }));
    });

    it('omits autonomy from agent when not set', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      await mc.apply(orch);
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['autonomy']).toBeUndefined();
    });
  });

  describe('maxIterations config', () => {
    it('autopilot uses custom maxIterations from modeConfig', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'x', maxIterations: 30 });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalledWith(expect.objectContaining({ maxIterations: 30 }));
    });

    it('autopilot with maxIterations: 0 still passes continuationPrompt (for max_tokens handling)', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'x', maxIterations: 0 });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalledWith(expect.objectContaining({
        maxIterations: 0,
        continuationPrompt: expect.any(String),
      }));
    });
  });

  describe('observability', () => {
    it('publishes mode change event on apply', async () => {
      const { channels } = await import('./observability.js');
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'interactive' });
      await mc.apply(orch);
      expect(channels.modeChange.publish).toHaveBeenCalledWith(expect.objectContaining({ mode: 'interactive' }));
    });
  });

  describe('auto-DAG in autopilot mode', () => {
    const dagResult = {
      steps: [
        { id: 'analyze', task: 'Analyze the codebase structure', model: 'sonnet' as const },
        { id: 'implement', task: 'Implement changes', model: 'opus' as const, input_from: ['analyze'] },
        { id: 'test', task: 'Write tests', model: 'haiku' as const, input_from: ['implement'] },
      ],
      reasoning: 'Three-phase approach',
      estimatedCost: 0.12,
    };

    it('triggers planDAG call when enableAutoDAG is set', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      orch.getPromptTabs.mockReturnValue(null); // no dialog — auto-approve path
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'refactor auth module',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      expect(mockPlanDAG).toHaveBeenCalledWith('refactor auth module', expect.objectContaining({
        apiKey: 'test-key',
      }));
    });

    it('does not call planDAG when enableAutoDAG is not set', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'deploy app' });
      await mc.apply(orch);
      expect(mockPlanDAG).not.toHaveBeenCalled();
    });

    it('continues normally when planDAG returns null', async () => {
      mockPlanDAG.mockResolvedValueOnce(null);
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'build app',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalled();
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['systemPromptSuffix'] as string).not.toContain('Auto-DAG Pipeline');
    });

    it('continues normally when planDAG returns empty steps', async () => {
      mockPlanDAG.mockResolvedValueOnce({ steps: [], reasoning: 'nothing', estimatedCost: 0 });
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'simple task',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['systemPromptSuffix'] as string).not.toContain('Auto-DAG Pipeline');
    });

    it('registers subtasks with GoalTracker when planDAG returns steps', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'refactor auth',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);

      // GoalTracker.addSubtask should be called for each step
      const { GoalTracker } = await import('./goal-tracker.js');
      const gtInstances = (GoalTracker as unknown as { mock: { results: { value: Record<string, unknown> }[] } }).mock.results;
      const gt = gtInstances[gtInstances.length - 1]!.value;
      const addSubtask = gt['addSubtask'] as ReturnType<typeof vi.fn>;
      expect(addSubtask).toHaveBeenCalledTimes(3);
      expect(addSubtask).toHaveBeenCalledWith(expect.stringContaining('Analyze the codebase'));
      expect(addSubtask).toHaveBeenCalledWith(expect.stringContaining('Implement changes'));
      expect(addSubtask).toHaveBeenCalledWith(expect.stringContaining('Write tests'));
    });

    it('passes maxDagSteps to planDAG', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'big project',
        enableAutoDAG: true,
        skipDagApproval: true,
        maxDagSteps: 5,
      });
      await mc.apply(orch);
      expect(mockPlanDAG).toHaveBeenCalledWith('big project', expect.objectContaining({
        maxSteps: 5,
      }));
    });

    it('uses default maxDagSteps of 10 when not specified', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'do stuff',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      expect(mockPlanDAG).toHaveBeenCalledWith('do stuff', expect.objectContaining({
        maxSteps: 10,
      }));
    });

    it('system prompt suffix includes Auto-DAG Pipeline section when plan succeeds', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'refactor module',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['systemPromptSuffix'] as string).toContain('Auto-DAG Pipeline');
      expect(call['systemPromptSuffix'] as string).toContain('Do NOT repeat already-completed steps');
    });

    it('skipDagApproval skips approval dialog', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mockTabs = vi.fn();
      orch.getPromptTabs.mockReturnValue(mockTabs);
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'deploy app',
        enableAutoDAG: true,
        skipDagApproval: true,
      });
      await mc.apply(orch);
      // promptTabs should NOT be called since we skipped approval
      expect(mockTabs).not.toHaveBeenCalled();
    });

    it('shows approval dialog when skipDagApproval is not set and promptTabs available', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mockTabs = vi.fn().mockResolvedValue(['Approve']);
      orch.getPromptTabs.mockReturnValue(mockTabs);
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'deploy app',
        enableAutoDAG: true,
      });
      await mc.apply(orch);
      expect(mockTabs).toHaveBeenCalledTimes(1);
      const tabsCallArg = mockTabs.mock.calls[0]![0] as Array<{ question: string; header: string; options: string[] }>;
      expect(tabsCallArg[0]!.header).toBe('Auto-DAG Pipeline');
      expect(tabsCallArg[0]!.options).toContain('Approve');
      expect(tabsCallArg[0]!.options).toContain('Skip DAG');
    });

    it('aborts DAG plan when user selects Skip DAG in approval dialog', async () => {
      mockPlanDAG.mockResolvedValueOnce(dagResult);
      const orch = createMockOrchestrator();
      const mockTabs = vi.fn().mockResolvedValue(['Skip DAG']);
      orch.getPromptTabs.mockReturnValue(mockTabs);
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'deploy app',
        enableAutoDAG: true,
      });
      await mc.apply(orch);
      // System prompt should NOT contain Auto-DAG section since user rejected
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['systemPromptSuffix'] as string).not.toContain('Auto-DAG Pipeline');
    });

    it('executeAutoDAG returns null when no dagPlan', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'autopilot', goal: 'test' });
      await mc.apply(orch);
      const result = await mc.executeAutoDAG(orch);
      expect(result).toBeNull();
    });
  });

  describe('pre-approve patterns', () => {
    it('uses CLI patterns when provided', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'test',
        autoApprovePatterns: [{ tool: 'bash', pattern: 'npm run *', label: 'npm', risk: 'low' }],
      });
      await mc.apply(orch);
      // preApproval should be set from CLI patterns
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['preApproval']).toBeDefined();
    });

    it('returns undefined when no CLI patterns provided', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({
        mode: 'autopilot',
        goal: 'simple task',
      });
      await mc.apply(orch);
      expect(orch._recreateAgent).toHaveBeenCalled();
      const call = orch._recreateAgent.mock.calls[0]![0] as Record<string, unknown>;
      expect(call['preApproval']).toBeUndefined();
    });
  });

  describe('Mode Registry', () => {
    afterEach(() => {
      ModeController.clearModes();
    });

    it('registerMode adds a handler', () => {
      const handler = { apply: vi.fn().mockResolvedValue(undefined) };
      ModeController.registerMode('custom-mode', handler);
      expect(ModeController.getRegisteredModes()).toContain('custom-mode');
    });

    it('dispatches to registered handler on apply', async () => {
      const handler = { apply: vi.fn().mockResolvedValue(undefined) };
      ModeController.registerMode('custom-mode', handler);

      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'custom-mode' as any });
      await mc.apply(orch);

      expect(handler.apply).toHaveBeenCalledTimes(1);
      expect(handler.apply).toHaveBeenCalledWith(
        expect.objectContaining({ modeConfig: expect.objectContaining({ mode: 'custom-mode' }) }),
        orch,
      );
    });

    it('calls handler.teardown on teardown', async () => {
      const handler = {
        apply: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn().mockResolvedValue(undefined),
      };
      ModeController.registerMode('teardown-mode', handler);

      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'teardown-mode' as any });
      await mc.apply(orch);
      await mc.teardown();

      expect(handler.teardown).toHaveBeenCalledTimes(1);
    });

    it('throws for unregistered mode', async () => {
      const orch = createMockOrchestrator();
      const mc = new ModeController({ mode: 'sentinel' });
      await expect(mc.apply(orch)).rejects.toThrow('Mode "sentinel" is not registered');
    });

    it('clearModes resets the registry', () => {
      ModeController.registerMode('a', { apply: vi.fn().mockResolvedValue(undefined) });
      ModeController.registerMode('b', { apply: vi.fn().mockResolvedValue(undefined) });
      expect(ModeController.getRegisteredModes()).toHaveLength(2);

      ModeController.clearModes();
      expect(ModeController.getRegisteredModes()).toHaveLength(0);
    });

    it('context exposes modeConfig to handler', async () => {
      let capturedCtx: Record<string, unknown> | null = null;
      const handler = {
        apply: vi.fn().mockImplementation((ctx: Record<string, unknown>) => {
          capturedCtx = ctx;
        }),
      };
      ModeController.registerMode('ctx-test', handler);

      const config = { mode: 'ctx-test' as any, goal: 'test goal' };
      const mc = new ModeController(config);
      await mc.apply(createMockOrchestrator());

      expect(capturedCtx).not.toBeNull();
      expect((capturedCtx as any).modeConfig).toEqual(config);
    });

    it('getRegisteredModes returns all registered mode names', () => {
      ModeController.registerMode('alpha', { apply: vi.fn().mockResolvedValue(undefined) });
      ModeController.registerMode('beta', { apply: vi.fn().mockResolvedValue(undefined) });

      const modes = ModeController.getRegisteredModes();
      expect(modes).toContain('alpha');
      expect(modes).toContain('beta');
      expect(modes).toHaveLength(2);
    });
  });
});
