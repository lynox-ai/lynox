import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Role, ToolEntry, NodynUserConfig } from '../types/index.js';

const mockSend = vi.fn().mockResolvedValue('mock result');

// Mock Agent class — must use function syntax for constructor
vi.mock('../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: { send: typeof mockSend; abort: ReturnType<typeof vi.fn> }) {
    this.send = mockSend;
    this.abort = vi.fn();
  }),
}));

// Mock loadRole
const mockLoadRole = vi.fn().mockReturnValue(null);
vi.mock('../core/roles.js', () => ({
  loadRole: (...args: unknown[]) => mockLoadRole(...args),
  warnModelMismatch: vi.fn().mockReturnValue(null),
}));

import { Agent } from '../core/agent.js';
import { spawnInline, resolveModel } from './runtime-adapter.js';
import type { ManifestStep } from './types.js';

const mockConfig = { api_key: 'test-key' } as unknown as NodynUserConfig;

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
    mockLoadRole.mockReturnValue(null);
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

  it('applies role model, system prompt, and effort', async () => {
    const role: Role = {
      id: 'analyst',
      name: 'Analyst',
      description: 'Analyzes code',
      version: '1.0.0',
      systemPrompt: 'You are an analyst.',
      model: 'opus',
      effort: 'max',
    };
    mockLoadRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'review-step',
      agent: 'review-step',
      runtime: 'inline',
      role: 'analyst',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['systemPrompt']).toBe('You are an analyst.');
    expect(agentConfig['effort']).toBe('max');
    expect(agentConfig['model']).toContain('opus');
  });

  it('step.model overrides role.model', async () => {
    const role: Role = {
      id: 'researcher',
      name: 'Researcher',
      description: 'Researches',
      version: '1.0.0',
      systemPrompt: 'Research stuff.',
      model: 'opus',
    };
    mockLoadRole.mockReturnValue(role);

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
    mockLoadRole.mockReturnValue(null);

    const step: ManifestStep = {
      id: 'bad-step',
      agent: 'bad-step',
      runtime: 'inline',
      role: 'nonexistent',
    };

    await expect(spawnInline(step, {}, mockConfig, mockParentTools)).rejects.toThrow('Unknown role "nonexistent"');
  });

  it('role deniedTools filters tools', async () => {
    const role: Role = {
      id: 'operator',
      name: 'Operator',
      description: 'Monitors',
      version: '1.0.0',
      systemPrompt: 'Monitor stuff.',
      deniedTools: ['write_file'],
    };
    mockLoadRole.mockReturnValue(role);

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

  it('role allowedTools restricts to whitelist', async () => {
    const role: Role = {
      id: 'collector',
      name: 'Collector',
      description: 'Collects feedback',
      version: '1.0.0',
      systemPrompt: 'Collect feedback.',
      allowedTools: ['read_file'],
    };
    mockLoadRole.mockReturnValue(role);

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

  it('role maxIterations propagates to agent', async () => {
    const role: Role = {
      id: 'strategist',
      name: 'Strategist',
      description: 'Plans',
      version: '1.0.0',
      systemPrompt: 'Plan stuff.',
      maxIterations: 5,
    };
    mockLoadRole.mockReturnValue(role);

    const step: ManifestStep = {
      id: 'plan-step',
      agent: 'plan-step',
      runtime: 'inline',
      role: 'strategist',
    };

    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['maxIterations']).toBe(5);
  });
});
