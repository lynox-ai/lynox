import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgent, ToolEntry, StreamHandler } from '../../types/index.js';
import type { RoleConfig } from '../../core/roles.js';

// === Mocks ===

const mockSend = vi.fn().mockResolvedValue('sub-agent result');

vi.mock('../../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: { send: typeof mockSend; currentRunId?: string | undefined; spawnDepth: number }, config: { spawnDepth?: number | undefined }) {
    this.send = mockSend;
    this.currentRunId = undefined;
    this.spawnDepth = config.spawnDepth ?? 0;
  }),
}));

vi.mock('../../core/observability.js', () => ({
  channels: {
    spawnStart: { publish: vi.fn() },
    spawnEnd: { publish: vi.fn() },
  },
}));

const mockGetRole = vi.fn().mockReturnValue(undefined);
const mockGetRoleNames = vi.fn().mockReturnValue(['researcher', 'creator', 'operator', 'collector']);
// applyTierGate: pass-through mock — the tier-gating behavior has its own
// unit tests in roles.test.ts; spawn tests only care that the override
// threads through without being dropped.
const mockApplyTierGate = vi.fn().mockImplementation((requested: unknown) => requested);
vi.mock('../../core/roles.js', () => ({
  getRole: (...args: unknown[]) => mockGetRole(...args),
  getRoleNames: (...args: unknown[]) => mockGetRoleNames(...args),
  applyTierGate: (...args: unknown[]) => mockApplyTierGate(...args),
}));

import { spawnAgentTool, resetSessionSpawnCost } from './spawn.js';
import { channels } from '../../core/observability.js';

function makeTool(name: string): ToolEntry {
  return {
    definition: { name, description: name, input_schema: { type: 'object' as const, properties: {} } },
    handler: vi.fn(),
  };
}

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    name: 'parent',
    model: 'claude-sonnet-4-6',
    memory: null,
    tools: [
      makeTool('bash'),
      makeTool('read_file'),
      makeTool('write_file'),
      makeTool('spawn_agent'),
    ],
    onStream: null,
    currentRunId: undefined,
    spawnDepth: 0,
    ...overrides,
  };
}

// === Tests ===

describe('spawn_agent tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue('sub-agent result');
    mockGetRole.mockReturnValue(undefined);
    resetSessionSpawnCost();
  });

  it('spawns a sub-agent and returns result', async () => {
    const agent = makeAgent();
    const result = await spawnAgentTool.handler(
      { agents: [{ name: 'worker', task: 'Analyze this data' }] },
      agent,
    );

    expect(result).toContain('## worker');
    expect(result).toContain('sub-agent result');
  });

  it('publishes spawnStart and spawnEnd events', async () => {
    const agent = makeAgent({ currentRunId: 'run123' });
    await spawnAgentTool.handler(
      { agents: [{ name: 'w1', task: 'Think about X' }] },
      agent,
    );

    expect(vi.mocked(channels.spawnStart.publish)).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ['w1'],
        parent: 'parent',
        parentRunId: 'run123',
        depth: 1,
      }),
    );

    expect(vi.mocked(channels.spawnEnd.publish)).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ['w1'],
        parent: 'parent',
        parentRunId: 'run123',
        depth: 1,
        spawnRecords: expect.arrayContaining([
          expect.objectContaining({ childName: 'w1' }),
        ]),
      }),
    );
  });

  it('passes parentRunId from agent.currentRunId', async () => {
    const agent = makeAgent({ currentRunId: 'run-abc' });
    await spawnAgentTool.handler(
      { agents: [{ name: 'child', task: 'Think' }] },
      agent,
    );

    const startCall = vi.mocked(channels.spawnStart.publish).mock.calls[0]![0] as { parentRunId: string };
    expect(startCall.parentRunId).toBe('run-abc');
  });

  it('increments spawn depth for child agents', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const agent = makeAgent({ spawnDepth: 2 });
    await spawnAgentTool.handler(
      { agents: [{ name: 'deep', task: 'Think deeper' }] },
      agent,
    );

    // Child depth should be parentDepth + 1 = 3
    expect(vi.mocked(MockAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ spawnDepth: 3 }),
    );
  });

  it('enforces max spawn depth (5)', async () => {
    const agent = makeAgent({ spawnDepth: 5 });

    await expect(
      spawnAgentTool.handler(
        { agents: [{ name: 'too-deep', task: 'This should fail' }] },
        agent,
      ),
    ).rejects.toThrow(/Max spawn depth.*5.*exceeded/);

    // Should not have published any events
    expect(vi.mocked(channels.spawnStart.publish)).not.toHaveBeenCalled();
  });

  it('allows spawning at depth 4 (child becomes 5)', async () => {
    const agent = makeAgent({ spawnDepth: 4 });
    const result = await spawnAgentTool.handler(
      { agents: [{ name: 'edge', task: 'Think at limit' }] },
      agent,
    );

    expect(result).toContain('sub-agent result');
    expect(vi.mocked(channels.spawnStart.publish)).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 5 }),
    );
  });

  it('handles multiple agents with Promise.allSettled', async () => {
    mockSend
      .mockResolvedValueOnce('result-a')
      .mockResolvedValueOnce('result-b');

    const agent = makeAgent();
    const result = await spawnAgentTool.handler(
      {
        agents: [
          { name: 'agent-a', task: 'Think about A' },
          { name: 'agent-b', task: 'Think about B' },
        ],
      },
      agent,
    );

    expect(result).toContain('## agent-a');
    expect(result).toContain('result-a');
    expect(result).toContain('## agent-b');
    expect(result).toContain('result-b');
  });

  it('handles partial failures gracefully', async () => {
    mockSend
      .mockResolvedValueOnce('success')
      .mockRejectedValueOnce(new Error('sub-agent crashed'));

    const agent = makeAgent();
    const result = await spawnAgentTool.handler(
      {
        agents: [
          { name: 'good', task: 'Think' },
          { name: 'bad', task: 'Think and crash' },
        ],
      },
      agent,
    );

    expect(result).toContain('## good');
    expect(result).toContain('success');
    expect(result).toContain('## bad');
    expect(result).toContain('Error');
  });

  it('throws AggregateError when all agents fail', async () => {
    mockSend.mockRejectedValue(new Error('all fail'));

    const agent = makeAgent();
    await expect(
      spawnAgentTool.handler(
        {
          agents: [
            { name: 'fail1', task: 'Think' },
            { name: 'fail2', task: 'Think too' },
          ],
        },
        agent,
      ),
    ).rejects.toThrow(/All sub-agents failed/);
  });

  it('calls onStream with spawn event', async () => {
    const onStream = vi.fn() as StreamHandler;
    const agent = makeAgent({ onStream });
    await spawnAgentTool.handler(
      { agents: [{ name: 'notifier', task: 'Think' }] },
      agent,
    );

    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'spawn', agents: ['notifier'] }),
    );
  });

  it('forwards a filtered stream wrapper to child agents for progress visibility', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const onStream = vi.fn() as StreamHandler;
    const agent = makeAgent({ onStream });
    await spawnAgentTool.handler(
      { agents: [{ name: 'silent', task: 'Think quietly' }] },
      agent,
    );

    // Child agent receives a wrapper (not the raw parent stream) so we can
    // filter which sub-agent events surface in the parent UI.
    expect(vi.mocked(MockAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ onStream: expect.any(Function) }),
    );
    // Parent gets at least the spawn_child_done event for visibility.
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'spawn_child_done', subAgent: 'silent' }),
    );
  });

  it('uses undefined parentRunId when agent has no currentRunId', async () => {
    const agent = makeAgent({ currentRunId: undefined });
    await spawnAgentTool.handler(
      { agents: [{ name: 'orphan', task: 'Think alone' }] },
      agent,
    );

    const endCall = vi.mocked(channels.spawnEnd.publish).mock.calls[0]![0] as { parentRunId: string | undefined };
    expect(endCall.parentRunId).toBeUndefined();
  });

  // === Role-based spawn tests ===

  it('applies role model and tool scoping', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    mockGetRole.mockReturnValue({
      model: 'sonnet',
      effort: 'high',
      autonomy: 'guided',
      denyTools: ['write_file', 'bash'],
      description: 'Thorough exploration, source citation. Read-only.',
    } as RoleConfig);

    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'r1', task: 'Research X', role: 'researcher' }] },
      agent,
    );

    expect(mockGetRole).toHaveBeenCalledWith('researcher');
    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    // write_file and bash should be excluded, spawn_agent always excluded
    const toolNames = (agentCall['tools'] as ToolEntry[]).map(t => t.definition.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('spawn_agent');
  });

  it('explicit spec fields override role defaults', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    mockGetRole.mockReturnValue({
      model: 'sonnet',
      effort: 'high',
      autonomy: 'guided',
      description: 'Research role',
    } as RoleConfig);

    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'r1', task: 'Research', role: 'researcher', model: 'opus', system_prompt: 'Custom prompt.', effort: 'max' }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentCall['systemPrompt']).toBe('Custom prompt.');
    expect(agentCall['effort']).toBe('max');
    expect(agentCall['model']).toBe('claude-opus-4-6');
  });

  it('throws for unknown role', async () => {
    mockGetRole.mockReturnValue(undefined);
    const agent = makeAgent();

    await expect(
      spawnAgentTool.handler(
        { agents: [{ name: 'r1', task: 'Do stuff', role: 'nonexistent' }] },
        agent,
      ),
    ).rejects.toThrow(/Unknown role "nonexistent"/);
  });

  it('role allowTools whitelist filters parent tools', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    mockGetRole.mockReturnValue({
      model: 'haiku',
      effort: 'medium',
      autonomy: 'supervised',
      allowTools: ['read_file'],
      description: 'Collector role',
    } as RoleConfig);

    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'fb', task: 'Collect', role: 'collector' }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const toolNames = (agentCall['tools'] as ToolEntry[]).map(t => t.definition.name);
    expect(toolNames).toEqual(['read_file']);
  });

  it('spec.tools overrides role tool scoping', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    mockGetRole.mockReturnValue({
      model: 'opus',
      effort: 'max',
      autonomy: 'guided',
      denyTools: ['write_file', 'bash'],
      description: 'Research role',
    } as RoleConfig);

    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'r1', task: 'Do it', role: 'researcher', tools: ['bash'] }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const toolNames = (agentCall['tools'] as ToolEntry[]).map(t => t.definition.name);
    // spec.tools takes precedence, so bash should be included
    expect(toolNames).toEqual(['bash']);
  });

  it('context is prepended to task', async () => {
    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'ctx', task: 'Analyze this', context: 'The codebase uses TypeScript.' }] },
      agent,
    );

    expect(mockSend).toHaveBeenCalledWith('<context>The codebase uses TypeScript.</context>\n\nAnalyze this');
  });

  it('isolated_memory removes memory from child', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const mockMemory = {} as IAgent['memory'];
    const agent = makeAgent({ memory: mockMemory });
    await spawnAgentTool.handler(
      { agents: [{ name: 'iso', task: 'Work alone', isolated_memory: true }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentCall['memory']).toBeUndefined();
  });

  it('3-tier resolution: spec > role > defaults', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    mockGetRole.mockReturnValue({
      model: 'opus',
      effort: 'high',
      autonomy: 'guided',
      description: 'Strategy role',
    } as RoleConfig);

    const agent = makeAgent();
    // spec overrides effort but not model
    await spawnAgentTool.handler(
      { agents: [{ name: 'p1', task: 'Plan it', role: 'researcher', effort: 'max' }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentCall['model']).toBe('claude-opus-4-6'); // from role
    expect(agentCall['effort']).toBe('max'); // from spec (overrides role)
  });

  it('always excludes spawn_agent from children', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'child', task: 'Work' }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const toolNames = (agentCall['tools'] as ToolEntry[]).map(t => t.definition.name);
    expect(toolNames).not.toContain('spawn_agent');
  });

  // === Cost guard tests ===

  it('passes default costGuard ($5) to spawned agents', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'budgeted', task: 'Work within budget' }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const cg = agentCall['costGuard'] as { maxBudgetUSD: number; maxIterations: number };
    expect(cg).toBeDefined();
    expect(cg.maxBudgetUSD).toBe(5);
    expect(cg.maxIterations).toBe(10);
  });

  it('uses explicit max_budget_usd from spec', async () => {
    const { Agent: MockAgent } = await import('../../core/agent.js');
    const agent = makeAgent();
    await spawnAgentTool.handler(
      { agents: [{ name: 'custom-budget', task: 'Work', max_budget_usd: 15 }] },
      agent,
    );

    const agentCall = vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const cg = agentCall['costGuard'] as { maxBudgetUSD: number };
    expect(cg.maxBudgetUSD).toBe(15);
  });

  it('emits estimated cost in spawn stream event', async () => {
    const onStream = vi.fn() as StreamHandler;
    const agent = makeAgent({ onStream });
    await spawnAgentTool.handler(
      { agents: [{ name: 'est', task: 'Think' }] },
      agent,
    );

    const spawnEvent = (onStream as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { type: string }).type === 'spawn',
    );
    expect(spawnEvent).toBeDefined();
    const event = spawnEvent![0] as { estimatedCostUSD?: number };
    expect(event.estimatedCostUSD).toBeGreaterThan(0);
  });

  it('estimate for 3 default-Sonnet researchers stays well under typical session ceiling', async () => {
    const onStream = vi.fn() as StreamHandler;
    const agent = makeAgent({ onStream });
    await spawnAgentTool.handler(
      {
        agents: [
          { name: 'product-pricing', task: 'Research lindy.ai pricing' },
          { name: 'content-seo', task: 'Research lindy.ai content' },
          { name: 'business', task: 'Research lindy.ai funding/news' },
        ],
      },
      agent,
    );

    const spawnEvent = (onStream as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { type: string }).type === 'spawn',
    );
    expect(spawnEvent).toBeDefined();
    const event = spawnEvent![0] as { estimatedCostUSD?: number };
    // 3 sonnet × 10 turns × ((4K/1M × $3) + (16K × 0.3 / 1M × $15)) ≈ $2.52.
    // Tight band catches estimator regressions; pricing tweaks bump the literal.
    expect(event.estimatedCostUSD).toBeGreaterThan(2);
    expect(event.estimatedCostUSD).toBeLessThan(3.5);
  });

  // === Session spawn cost ceiling ===

  describe('session spawn cost ceiling', () => {
    it('under ceiling passes', async () => {
      const agent = makeAgent();
      // A single spawn should be well under $50
      const result = await spawnAgentTool.handler(
        { agents: [{ name: 'cheap', task: 'Think' }] },
        agent,
      );
      expect(result).toContain('## cheap');
    });

    it('over ceiling throws with message', async () => {
      const agent = makeAgent();
      // 10 opus × 50 turns × $0.26/turn ≈ $130, well over $50 session ceiling
      const agents = Array.from({ length: 10 }, (_, i) => ({
        name: `agent-${i}`,
        task: 'Think hard',
        model: 'opus' as const,
        max_turns: 50,
      }));
      await expect(
        spawnAgentTool.handler({ agents }, agent),
      ).rejects.toThrow(/Session cost ceiling/);
    });

    it('cumulative tracking across calls', async () => {
      const agent = makeAgent();
      // First call — should pass
      await spawnAgentTool.handler(
        { agents: [{ name: 'w1', task: 'Think' }] },
        agent,
      );
      // Second call exceeds ceiling on its own; cumulative just adds to that
      const agents = Array.from({ length: 10 }, (_, i) => ({
        name: `w${i}`,
        task: 'Think more',
        model: 'opus' as const,
        max_turns: 50,
      }));
      await expect(
        spawnAgentTool.handler({ agents }, agent),
      ).rejects.toThrow(/Session cost ceiling/);
    });

    it('resetSessionSpawnCost clears the counter', async () => {
      const agent = makeAgent();
      // First spawn
      await spawnAgentTool.handler(
        { agents: [{ name: 'w1', task: 'Think' }] },
        agent,
      );
      // Reset
      resetSessionSpawnCost();
      // Should pass again (counter is reset)
      const result = await spawnAgentTool.handler(
        { agents: [{ name: 'w2', task: 'Think' }] },
        agent,
      );
      expect(result).toContain('## w2');
    });
  });

  describe('input validation', () => {
    it('rejects empty agents array', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler({ agents: [] }, agent),
      ).rejects.toThrow(/at least one agent/);
    });

    it('rejects more than 10 agents per call', async () => {
      const agent = makeAgent();
      const agents = Array.from({ length: 11 }, (_, i) => ({
        name: `a${i}`,
        task: 'Think',
      }));
      await expect(
        spawnAgentTool.handler({ agents }, agent),
      ).rejects.toThrow(/at most 10 agents/);
    });

    it('rejects negative max_turns', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_turns: -5 }] },
          agent,
        ),
      ).rejects.toThrow(/max_turns must be an integer/);
    });

    it('rejects max_turns above 50', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_turns: 51 }] },
          agent,
        ),
      ).rejects.toThrow(/max_turns must be an integer/);
    });

    it('rejects fractional max_turns', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_turns: 1.5 }] },
          agent,
        ),
      ).rejects.toThrow(/max_turns must be an integer/);
    });

    it('rejects negative max_budget_usd', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_budget_usd: -1 }] },
          agent,
        ),
      ).rejects.toThrow(/max_budget_usd must be a number/);
    });

    it('rejects max_budget_usd above 50', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_budget_usd: 51 }] },
          agent,
        ),
      ).rejects.toThrow(/max_budget_usd must be a number/);
    });

    it('rejects NaN max_turns (would otherwise return NaN estimate)', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'Think', max_turns: NaN }] },
          agent,
        ),
      ).rejects.toThrow(/max_turns must be an integer/);
    });

    it('rejects empty name', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler({ agents: [{ name: '', task: 'Think' }] }, agent),
      ).rejects.toThrow(/name must be a non-empty string/);
    });

    it('rejects name longer than 64 chars', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'x'.repeat(65), task: 'Think' }] },
          agent,
        ),
      ).rejects.toThrow(/name must be a non-empty string/);
    });

    it('rejects name with control characters (log injection vector)', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'evil\nINFO: spoofed', task: 'Think' }] },
          agent,
        ),
      ).rejects.toThrow(/control characters/);
    });

    it('rejects empty task', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler({ agents: [{ name: 'w', task: '' }] }, agent),
      ).rejects.toThrow(/task must be a non-empty string/);
    });

    it('rejects oversized task (> 16K chars)', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'w', task: 'x'.repeat(16_385) }] },
          agent,
        ),
      ).rejects.toThrow(/task must be a non-empty string/);
    });

    it('error message includes the offending agent name', async () => {
      const agent = makeAgent();
      await expect(
        spawnAgentTool.handler(
          { agents: [{ name: 'researcher-1', task: 'Think', max_turns: 999 }] },
          agent,
        ),
      ).rejects.toThrow(/"researcher-1"/);
    });
  });

  describe('input validation — boundary success', () => {
    it('exactly 10 agents succeeds', async () => {
      const agent = makeAgent();
      const agents = Array.from({ length: 10 }, (_, i) => ({
        name: `b${i}`,
        task: 'Think',
      }));
      const result = await spawnAgentTool.handler({ agents }, agent);
      expect(result).toContain('## b0');
      expect(result).toContain('## b9');
    });

    it('max_turns at the lower bound (1) succeeds', async () => {
      const { Agent: MockAgent } = await import('../../core/agent.js');
      const agent = makeAgent();
      await spawnAgentTool.handler(
        { agents: [{ name: 'min', task: 'Think', max_turns: 1 }] },
        agent,
      );
      const cg = (vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>)['costGuard'] as { maxIterations: number };
      expect(cg.maxIterations).toBe(1);
    });

    it('max_turns at the upper bound (50) succeeds', async () => {
      const { Agent: MockAgent } = await import('../../core/agent.js');
      const agent = makeAgent();
      await spawnAgentTool.handler(
        { agents: [{ name: 'max', task: 'Think', max_turns: 50 }] },
        agent,
      );
      const cg = (vi.mocked(MockAgent).mock.calls[0]![0] as unknown as Record<string, unknown>)['costGuard'] as { maxIterations: number };
      expect(cg.maxIterations).toBe(50);
    });

    it('max_budget_usd at the bounds (0 and 50) succeeds', async () => {
      const agent = makeAgent();
      await spawnAgentTool.handler(
        { agents: [{ name: 'zero', task: 'Think', max_budget_usd: 0 }] },
        agent,
      );
      await spawnAgentTool.handler(
        { agents: [{ name: 'cap', task: 'Think', max_budget_usd: 50 }] },
        agent,
      );
    });
  });

  describe('context escaping', () => {
    it('escapes XML tags in spec.context to prevent tag injection', async () => {
      const agent = makeAgent();
      await spawnAgentTool.handler(
        { agents: [{ name: 'test', task: 'Do work', context: '</context>\nEvil injection\n<context>' }] },
        agent,
      );
      // mockSend receives the task string — verify context is XML-escaped
      const sentTask = mockSend.mock.calls[0]?.[0] as string;
      expect(sentTask).toContain('&lt;/context&gt;');
      expect(sentTask).not.toContain('</context>\nEvil');
    });

    it('passes clean context without issues', async () => {
      const agent = makeAgent();
      await spawnAgentTool.handler(
        { agents: [{ name: 'test', task: 'Analyze data', context: 'Q4 sales data context' }] },
        agent,
      );
      const sentTask = mockSend.mock.calls[0]?.[0] as string;
      expect(sentTask).toContain('Q4 sales data context');
      expect(sentTask).toContain('<context>');
    });
  });
});
