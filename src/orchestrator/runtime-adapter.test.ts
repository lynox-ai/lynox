import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolEntry, LynoxUserConfig } from '../types/index.js';
import type { RoleConfig } from '../core/roles.js';

const mockSend = vi.fn().mockResolvedValue('mock result');

// Mock Agent class — must use function syntax for constructor
vi.mock('../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: { send: typeof mockSend; abort: ReturnType<typeof vi.fn> }) {
    this.send = mockSend;
    this.abort = vi.fn();
  }),
}));

// Mock getRole
const mockGetRole = vi.fn().mockReturnValue(undefined);
const mockGetRoleNames = vi.fn().mockReturnValue(['researcher', 'creator', 'operator', 'collector']);
vi.mock('../core/roles.js', () => ({
  getRole: (...args: unknown[]) => mockGetRole(...args),
  getRoleNames: (...args: unknown[]) => mockGetRoleNames(...args),
}));

import { Agent } from '../core/agent.js';
import { spawnInline, resolveModel, buildSubAgentPromptCallbacks, stripHumanInTheLoopTools, type SubAgentPromptHandles } from './runtime-adapter.js';
import { PromptBudget, PromptBudgetExceededError } from './prompt-budget.js';
import type { ManifestStep } from './types.js';

const mockConfig = { api_key: 'test-key' } as unknown as LynoxUserConfig;

const mockParentTools: ToolEntry[] = [
  {
    definition: { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'content',
  },
  {
    definition: { name: 'write_file', description: 'Write a file', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'ok',
  },
  {
    definition: { name: 'bash', description: 'Run bash', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'done',
  },
  {
    definition: { name: 'spawn_agent', description: 'Spawn agent', input_schema: { type: 'object' } } as ToolEntry['definition'],
    handler: async () => 'spawned',
  },
];

describe('resolveModel', () => {
  it('maps ModelTier to full model ID', () => {
    expect(resolveModel('sonnet', 'sonnet')).toContain('sonnet');
  });

  it('uses default tier when step model is undefined', () => {
    expect(resolveModel(undefined, 'haiku')).toContain('haiku');
  });

  it('passes through full model ID', () => {
    expect(resolveModel('claude-3-custom-model', 'sonnet')).toBe('claude-3-custom-model');
  });
});

describe('spawnInline with role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('uses default settings when no role specified', async () => {
    const step: ManifestStep = {
      id: 'test-step',
      agent: 'test-step',
      runtime: 'inline',
      task: 'Do something',
    };

    const result = await spawnInline(step, { task: 'Do something' }, mockConfig, mockParentTools);
    expect(result.result).toBe('mock result');

    const agentCalls = vi.mocked(Agent).mock.calls;
    expect(agentCalls).toHaveLength(1);
    const agentConfig = agentCalls[0]![0] as unknown as Record<string, unknown>;

    // Default system prompt
    expect(agentConfig['systemPrompt']).toContain('focused task agent');
    // spawn_agent and recursion tools excluded
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'spawn_agent')).toBeUndefined();
    expect(tools.find(t => t.definition.name === 'run_pipeline')).toBeUndefined();
  });

  it('applies role model and effort', async () => {
    const role: RoleConfig = {
      model: 'opus',
      effort: 'max',
      autonomy: 'guided',
      description: 'Analyzes code',
    };
    mockGetRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'review-step',
      agent: 'review-step',
      runtime: 'inline',
      role: 'researcher',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['effort']).toBe('max');
    expect(agentConfig['model']).toContain('opus');
  });

  it('step.model overrides role.model', async () => {
    const role: RoleConfig = {
      model: 'opus',
      effort: 'max',
      autonomy: 'guided',
      description: 'Researches',
    };
    mockGetRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'research-step',
      agent: 'research-step',
      runtime: 'inline',
      role: 'researcher',
      model: 'haiku',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['model']).toContain('haiku');
  });

  it('throws for unknown role', async () => {
    mockGetRole.mockReturnValue(undefined);

    const step: ManifestStep = {
      id: 'bad-step',
      agent: 'bad-step',
      runtime: 'inline',
      role: 'nonexistent',
    };

    await expect(spawnInline(step, {}, mockConfig, mockParentTools)).rejects.toThrow('Unknown role "nonexistent"');
  });

  it('role denyTools filters tools', async () => {
    const role: RoleConfig = {
      model: 'haiku',
      effort: 'high',
      autonomy: 'autonomous',
      denyTools: ['write_file'],
      description: 'Monitors',
    };
    mockGetRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'monitor-step',
      agent: 'monitor-step',
      runtime: 'inline',
      role: 'operator',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'write_file')).toBeUndefined();
    expect(tools.find(t => t.definition.name === 'read_file')).toBeDefined();
    expect(tools.find(t => t.definition.name === 'bash')).toBeDefined();
  });

  it('role allowTools restricts to whitelist', async () => {
    const role: RoleConfig = {
      model: 'haiku',
      effort: 'medium',
      autonomy: 'supervised',
      allowTools: ['read_file'],
      description: 'Collects feedback',
    };
    mockGetRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'feedback-step',
      agent: 'feedback-step',
      runtime: 'inline',
      role: 'collector',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.definition.name).toBe('read_file');
  });

  it('role defaults to maxIterations 10', async () => {
    const role: RoleConfig = {
      model: 'opus',
      effort: 'high',
      autonomy: 'guided',
      description: 'Plans',
    };
    mockGetRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'plan-step',
      agent: 'plan-step',
      runtime: 'inline',
      role: 'researcher',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['maxIterations']).toBe(10);
  });
});

describe('spawnInline thinking gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('forces thinking=disabled on Haiku DAG steps regardless of step hint', async () => {
    // Haiku 4.5 has no extended-thinking support — Anthropic returns 400 for
    // any thinking shape. Both default and explicit-enabled paths must drop
    // thinking entirely on Haiku.
    const step: ManifestStep = {
      id: 'h-step', agent: 'h-step', runtime: 'inline',
      model: 'haiku', thinking: 'enabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'disabled' });
  });

  it('uses adaptive thinking for non-Haiku DAG step with no hint', async () => {
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline', model: 'sonnet',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'adaptive' });
  });

  it('honors explicit thinking=enabled on non-Haiku step', async () => {
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline',
      model: 'sonnet', thinking: 'enabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'enabled', budget_tokens: 10_000 });
  });

  it('honors explicit thinking=disabled on non-Haiku step', async () => {
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline',
      model: 'sonnet', thinking: 'disabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'disabled' });
  });

  it('Haiku gate also fires on the canonical model ID (not just the tier alias)', async () => {
    // The production matcher is `model.includes('haiku')`. The other tests
    // exercise the tier-alias path; this one locks the full ID path so a
    // future tightening to a strict ID equality wouldn't silently regress.
    const step: ManifestStep = {
      id: 'h-step', agent: 'h-step', runtime: 'inline',
      model: 'claude-haiku-4-5-20251001', thinking: 'enabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'disabled' });
  });
});

describe('stripHumanInTheLoopTools', () => {
  it('drops ask_user / ask_secret entries', () => {
    const tools: ToolEntry[] = [
      { definition: { name: 'bash', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'ok' },
      { definition: { name: 'ask_user', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'q' },
      { definition: { name: 'ask_secret', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 's' },
    ];
    const stripped = stripHumanInTheLoopTools(tools);
    expect(stripped.map(t => t.definition.name)).toEqual(['bash']);
  });
});

describe('buildSubAgentPromptCallbacks', () => {
  const step: ManifestStep = { id: 'vote', agent: 'vote', runtime: 'inline', task: 'Welche Tagline?' };

  it('returns empty object when parent has no callbacks', () => {
    expect(buildSubAgentPromptCallbacks(step, undefined)).toEqual({});
  });

  it('tags promptUser calls with stepId + stepTask meta', async () => {
    const parent = vi.fn(async () => 'green');
    const handles: SubAgentPromptHandles = { parentPromptUser: parent };
    const cbs = buildSubAgentPromptCallbacks(step, handles);
    const answer = await cbs.promptUser!('Pick one', ['red', 'green']);
    expect(answer).toBe('green');
    expect(parent).toHaveBeenCalledWith('Pick one', ['red', 'green'], { stepId: 'vote', stepTask: 'Welche Tagline?' });
  });

  it('lets the caller override step meta', async () => {
    const parent = vi.fn(async () => 'ok');
    const cbs = buildSubAgentPromptCallbacks(step, { parentPromptUser: parent });
    await cbs.promptUser!('Pick', undefined, { stepId: 'override', stepTask: 'X' });
    expect(parent).toHaveBeenCalledWith('Pick', undefined, { stepId: 'override', stepTask: 'X' });
  });

  it('consumes prompt budget when set', async () => {
    const budget = new PromptBudget(1);
    const parent = vi.fn(async () => 'ok');
    const cbs = buildSubAgentPromptCallbacks(step, { parentPromptUser: parent, promptBudget: budget });
    await cbs.promptUser!('Q1');
    expect(budget.usedCount).toBe(1);
    await expect(cbs.promptUser!('Q2')).rejects.toBeInstanceOf(PromptBudgetExceededError);
    // Parent only called once — budget rejected before delegating
    expect(parent).toHaveBeenCalledTimes(1);
  });
});

describe('spawnInline + parentPrompt propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('propagates parentPromptUser to the spawned Agent', async () => {
    const parentPromptUser = vi.fn(async () => 'answer');
    const step: ManifestStep = { id: 'pick', agent: 'pick', runtime: 'inline', task: 'choose' };
    await spawnInline(
      step, {}, mockConfig, mockParentTools, undefined, undefined, undefined,
      { parentPromptUser },
    );
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(typeof agentConfig['promptUser']).toBe('function');

    // Invoking the wrapped callback should delegate to parent + tag meta.
    const wrapped = agentConfig['promptUser'] as (q: string, opts?: string[]) => Promise<string>;
    await wrapped('Q', ['a', 'b']);
    expect(parentPromptUser).toHaveBeenCalledWith('Q', ['a', 'b'], expect.objectContaining({ stepId: 'pick', stepTask: 'choose' }));
  });

  it('strips ask_user from sub-agent tools when no parentPromptUser', async () => {
    const toolsWithAskUser: ToolEntry[] = [
      ...mockParentTools,
      { definition: { name: 'ask_user', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'q' },
    ];
    const step: ManifestStep = { id: 'autonomous-step', agent: 'autonomous-step', runtime: 'inline', task: 'work alone' };
    await spawnInline(step, {}, mockConfig, toolsWithAskUser);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'ask_user')).toBeUndefined();
  });

  it('keeps ask_user in sub-agent tools when parentPromptUser is present', async () => {
    const toolsWithAskUser: ToolEntry[] = [
      ...mockParentTools,
      { definition: { name: 'ask_user', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'q' },
    ];
    const step: ManifestStep = { id: 'interactive', agent: 'interactive', runtime: 'inline', task: 'ask' };
    await spawnInline(
      step, {}, mockConfig, toolsWithAskUser, undefined, undefined, undefined,
      { parentPromptUser: vi.fn(async () => 'answer') },
    );
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'ask_user')).toBeDefined();
  });
});
