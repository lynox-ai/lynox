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
// Partial mock: keep the real applyTierGate (the account gate resolveRunModel
// composes) and only stub role lookup.
vi.mock('../core/roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/roles.js')>();
  return {
    ...actual,
    getRole: (...args: unknown[]) => mockGetRole(...args),
    getRoleNames: (...args: unknown[]) => mockGetRoleNames(...args),
  };
});

import { Agent } from '../core/agent.js';
import { spawnInline, spawnViaAgent, spawnPipeline, resolveModel, buildSubAgentPromptCallbacks, stripHumanInTheLoopTools, buildReplayInstruction, INLINE_CORE_TOOLS, createStepStreamHandler, type SubAgentPromptHandles, type StepToolRecorder } from './runtime-adapter.js';
import type { AgentDef } from '../types/orchestration.js';
import type { StreamEvent } from '../types/index.js';
import { PromptBudget, PromptBudgetExceededError } from './prompt-budget.js';
import type { ManifestStep } from '../types/orchestration.js';

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
    expect(resolveModel('balanced', 'balanced')).toContain('sonnet');
  });

  it('uses default tier when step model is undefined', () => {
    expect(resolveModel(undefined, 'fast')).toContain('haiku');
  });

  it('passes through full model ID', () => {
    expect(resolveModel('claude-3-custom-model', 'balanced')).toBe('claude-3-custom-model');
  });

  it('resolves legacy Anthropic-brand tier names on a step (pre-rename manifests)', () => {
    // Back-compat: a manifest/pipeline persisted before the 2026-05-29 rename
    // stores model: 'sonnet'|'haiku'|'opus'. These must resolve to the tier's
    // model id, NOT be passed through as a literal (which the API would reject).
    expect(resolveModel('sonnet', 'fast')).toContain('sonnet');
    expect(resolveModel('haiku', 'balanced')).toContain('haiku');
    expect(resolveModel('opus', 'fast')).toContain('opus');
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

    // Default system prompt — A2: pipeline steps carry the grounding block too.
    expect(agentConfig['systemPrompt']).toContain('focused task agent');
    expect(agentConfig['systemPrompt']).toContain('Grounding & provenance');
    // spawn_agent and recursion tools excluded
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'spawn_agent')).toBeUndefined();
    expect(tools.find(t => t.definition.name === 'run_workflow')).toBeUndefined();
  });

  it('applies role model and effort', async () => {
    const role: RoleConfig = {
      model: 'deep',
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
      model: 'deep',
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
      model: 'fast',
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
      model: 'fast',
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
      model: 'fast',
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
      model: 'deep',
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
      model: 'fast', thinking: 'enabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'disabled' });
  });

  it('uses adaptive thinking for non-Haiku DAG step with no hint', async () => {
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline', model: 'balanced',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'adaptive' });
  });

  it('maps the legacy thinking=enabled hint to adaptive on non-Haiku step', async () => {
    // The manual `{type:'enabled', budget_tokens}` shape 400s on Sonnet 5 /
    // Opus 4.7+ (manual extended thinking removed in the 4.7/5 generation), so
    // the legacy `'enabled'` hint now resolves to adaptive — safe on 4.6 too.
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline',
      model: 'balanced', thinking: 'enabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'adaptive' });
  });

  it('honors explicit thinking=disabled on non-Haiku step', async () => {
    const step: ManifestStep = {
      id: 's-step', agent: 's-step', runtime: 'inline',
      model: 'balanced', thinking: 'disabled',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'disabled' });
  });

  it('maps the legacy thinking=enabled hint to adaptive on the named-agent path', async () => {
    // spawnViaAgent is the named-agent pipeline emitter — same 'enabled'→adaptive
    // mapping so a pre-4.7 manifest hint never emits the 400-ing manual shape.
    const step: ManifestStep = {
      id: 'n-step', agent: 'n-step', runtime: 'agent',
      model: 'balanced', thinking: 'enabled',
    };
    const agentDef: AgentDef = {
      name: 'n-step', version: '1', defaultTier: 'balanced', systemPrompt: 'do it', tools: [],
    };
    await spawnViaAgent(step, agentDef, {}, mockConfig, undefined, 'run-1');
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['thinking']).toEqual({ type: 'adaptive' });
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

  it('refunds budget if parent prompt rejects (e.g. abort)', async () => {
    const budget = new PromptBudget(1);
    const parent = vi.fn(async () => { throw new Error('aborted'); });
    const cbs = buildSubAgentPromptCallbacks(step, { parentPromptUser: parent, promptBudget: budget });
    await expect(cbs.promptUser!('Q1')).rejects.toThrow('aborted');
    // Slot returned — caller can ask again instead of being blocked by the cap.
    expect(budget.usedCount).toBe(0);
    expect(budget.remaining).toBe(1);
  });

  it('refunds budget on promptTabs / promptSecret rejection too', async () => {
    const budget = new PromptBudget(2);
    const tabsParent = vi.fn(async () => { throw new Error('x'); });
    const secretParent = vi.fn(async () => { throw new Error('y'); });
    const cbs = buildSubAgentPromptCallbacks(step, {
      parentPromptTabs: tabsParent,
      parentPromptSecret: secretParent,
      promptBudget: budget,
    });
    await expect(cbs.promptTabs!([{ question: 'q' }])).rejects.toThrow('x');
    await expect(cbs.promptSecret!('name', 'p')).rejects.toThrow('y');
    expect(budget.usedCount).toBe(0);
  });

  it('consumes budget on promptTabs success', async () => {
    const budget = new PromptBudget(2);
    const cbs = buildSubAgentPromptCallbacks(step, {
      parentPromptTabs: vi.fn(async () => ['ok']),
      parentPromptSecret: vi.fn(async () => 'saved'),
      promptBudget: budget,
    });
    await cbs.promptTabs!([{ question: 'q' }]);
    await cbs.promptSecret!('n', 'p');
    expect(budget.usedCount).toBe(2);
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

  it('strips all human-in-the-loop tools when no parentPromptUser', async () => {
    const toolsWithHitl: ToolEntry[] = [
      ...mockParentTools,
      { definition: { name: 'ask_user', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'q' },
      { definition: { name: 'ask_secret', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 's' },
      { definition: { name: 'ask_human', description: '', input_schema: {} } as ToolEntry['definition'], handler: async () => 'h' },
    ];
    const step: ManifestStep = { id: 'autonomous-step', agent: 'autonomous-step', runtime: 'inline', task: 'work alone' };
    await spawnInline(step, {}, mockConfig, toolsWithHitl);
    const lastCall = vi.mocked(Agent).mock.calls.at(-1)!;
    const agentConfig = lastCall[0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'ask_user')).toBeUndefined();
    expect(tools.find(t => t.definition.name === 'ask_secret')).toBeUndefined();
    expect(tools.find(t => t.definition.name === 'ask_human')).toBeUndefined();
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

describe('spawnInline + parentMemory propagation (regression-gate for memory_* in workflows)', () => {
  // PR #548 added memory_recall/memory_store/memory_update/memory_list to
  // INLINE_CORE_TOOLS so workflow sub-steps could dispatch them, but the
  // memory *backend* (`agent.memory`) was not threaded into the sub-agent
  // constructors — every memory_* handler short-circuits with
  // "Memory is not configured for this agent." until the parent's IMemory
  // is forwarded. Live-verified 2026-05-23 on staging via a 2-step
  // store→recall workflow; this test pins the wiring so a future refactor
  // can't silently regress it.
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('passes parentMemory through to the spawned Agent constructor', async () => {
    const mockMemory = {
      append: vi.fn(),
      load: vi.fn(),
      appendScoped: vi.fn(),
      loadScoped: vi.fn(),
      delete: vi.fn(),
      deleteScoped: vi.fn(),
      update: vi.fn(),
      updateScoped: vi.fn(),
      maybeUpdate: vi.fn(),
    } as unknown as Parameters<typeof spawnInline>[9];

    const step: ManifestStep = { id: 'remember', agent: 'remember', runtime: 'inline', task: 'store + recall' };
    await spawnInline(
      step, {}, mockConfig, mockParentTools,
      undefined, undefined, undefined, undefined, undefined,
      mockMemory,
    );

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['memory']).toBe(mockMemory);
  });

  it('falls back to undefined memory when parent has none (headless caller)', async () => {
    const step: ManifestStep = { id: 'headless', agent: 'headless', runtime: 'inline', task: 'no memory' };
    await spawnInline(step, {}, mockConfig, mockParentTools);

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    // Agent constructor's `config.memory ?? null` then turns this into
    // `agent.memory === null` — identical to pre-fix behaviour for the
    // headless path.
    expect(agentConfig['memory']).toBeUndefined();
  });

  it('coerces explicit-null parentMemory to undefined for the Agent constructor', async () => {
    const step: ManifestStep = { id: 'null-mem', agent: 'null-mem', runtime: 'inline', task: 'null mem' };
    await spawnInline(
      step, {}, mockConfig, mockParentTools,
      undefined, undefined, undefined, undefined, undefined,
      null,
    );

    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['memory']).toBeUndefined();
  });
});

describe('INLINE_CORE_TOOLS membership (regression-gate)', () => {
  // Pins the inline-step sandbox allowlist so a future "let me trim a few
  // tools" refactor can't silently break workflows that depend on memory
  // composition (the bug pattern that shipped pre-PR#548).
  it('includes the 4 memory_* tools needed for KG-compounding workflows', () => {
    expect(INLINE_CORE_TOOLS.has('memory_recall')).toBe(true);
    expect(INLINE_CORE_TOOLS.has('memory_store')).toBe(true);
    expect(INLINE_CORE_TOOLS.has('memory_update')).toBe(true);
    expect(INLINE_CORE_TOOLS.has('memory_list')).toBe(true);
  });

  it('excludes destructive / confidence-changing memory ops (opt-in via per-step allowTools)', () => {
    expect(INLINE_CORE_TOOLS.has('memory_delete')).toBe(false);
    expect(INLINE_CORE_TOOLS.has('memory_promote')).toBe(false);
  });

  it('does NOT include `knowledge_search` (stale pre-B1 API, removed post PR #540)', () => {
    expect(INLINE_CORE_TOOLS.has('knowledge_search')).toBe(false);
  });

  it('still includes the foundational core tools', () => {
    for (const name of ['bash', 'read_file', 'write_file', 'http', 'ask_user', 'data_store_query', 'data_store_insert']) {
      expect(INLINE_CORE_TOOLS.has(name)).toBe(true);
    }
  });
});

describe('buildReplayInstruction', () => {
  it('pins the agent to the exact tool + JSON input', () => {
    const out = buildReplayInstruction('data_store_query', { table: 'revenue', client: 'Acme' }, 'Pull revenue');
    expect(out).toContain('Execute exactly this tool call');
    expect(out).toContain('Tool: data_store_query');
    expect(out).toContain('Input (JSON): {"table":"revenue","client":"Acme"}');
    expect(out).toContain('Context — what this step accomplishes: Pull revenue');
  });

  it('omits the context line when there is no description', () => {
    const out = buildReplayInstruction('bash', { cmd: 'ls' }, undefined);
    expect(out).toContain('Tool: bash');
    expect(out).not.toContain('Context —');
  });

  it('omits the context line for a blank description', () => {
    const out = buildReplayInstruction('bash', { cmd: 'ls' }, '   ');
    expect(out).not.toContain('Context —');
  });
});

describe('spawnInline literal replay (captured steps)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  const replayParentTools: ToolEntry[] = [
    ...mockParentTools,
    {
      definition: { name: 'mail_send', description: 'Send mail', input_schema: { type: 'object' } } as ToolEntry['definition'],
      handler: async () => 'sent',
    },
  ];

  it('sends the literal-replay instruction when the captured tool is in the inline set', async () => {
    // read_file is both in INLINE_CORE_TOOLS and in mockParentTools.
    const step: ManifestStep = {
      id: 'q-step', agent: 'q-step', runtime: 'inline',
      task: 'Read the report', tool: 'read_file', input_template: { path: 'reports/x.md' },
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const sent = mockSend.mock.calls[0]![0] as string;
    expect(sent).toContain('Execute exactly this tool call');
    expect(sent).toContain('read_file');
    expect(sent).toContain('Input (JSON):');
    // The instruction is a string inside the outer {task,context} JSON, so the
    // inner template quotes are escaped — assert on the (unescaped) field names.
    expect(sent).toContain('path');
  });

  it('does NOT widen the sandbox — a captured non-core tool is not admitted', async () => {
    const step: ManifestStep = {
      id: 'send-step', agent: 'send-step', runtime: 'inline',
      task: 'Send the report', tool: 'mail_send', input_template: { to: 'a@b.c' },
    };
    await spawnInline(step, {}, mockConfig, replayParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    // mail_send is not in INLINE_CORE_TOOLS and must stay out of the inline set.
    expect(tools.find(t => t.definition.name === 'mail_send')).toBeUndefined();
  });

  it('falls back to the prose task when the captured tool is unavailable (no broken replay)', async () => {
    const step: ManifestStep = {
      id: 'send-step', agent: 'send-step', runtime: 'inline',
      task: 'Send the report to the client', tool: 'mail_send', input_template: { to: 'a@b.c' },
    };
    await spawnInline(step, {}, mockConfig, replayParentTools);
    const sent = mockSend.mock.calls[0]![0] as string;
    // mail_send isn't granted → no replay instruction pinning a tool it lacks.
    expect(sent).not.toContain('Execute exactly this tool call');
    expect(sent).toContain('Send the report to the client');
  });

  it('a hand-authored step (no tool) sends its prose task verbatim', async () => {
    const step: ManifestStep = {
      id: 'prose-step', agent: 'prose-step', runtime: 'inline', task: 'Summarize the findings',
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const sent = mockSend.mock.calls[0]![0] as string;
    expect(sent).toContain('Summarize the findings');
    expect(sent).not.toContain('Execute exactly this tool call');
  });

  it('never replays a recursion-prone captured tool (spawn_agent stays excluded + prose fallback)', async () => {
    const step: ManifestStep = {
      id: 'rec-step', agent: 'rec-step', runtime: 'inline',
      task: 'spawn a helper', tool: 'spawn_agent', input_template: { task: 'x' },
    };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    const tools = agentConfig['tools'] as ToolEntry[];
    expect(tools.find(t => t.definition.name === 'spawn_agent')).toBeUndefined();
    const sent = mockSend.mock.calls[0]![0] as string;
    expect(sent).not.toContain('Execute exactly this tool call');
  });
});

describe('spawnPipeline — autonomy propagation (A1 C1 fix through nesting)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('threads the run autonomy into the nested sub-pipeline steps', async () => {
    const step: ManifestStep = {
      id: 'nested', agent: 'nested', runtime: 'pipeline',
      pipeline: [{ id: 'inner', task: 'do inner thing' }],
    };
    // Headless autonomous run → the nested inner step must also be 'autonomous',
    // otherwise a benign DANGEROUS_BASH op is denied non-interactively (the C1
    // bug leaking through a `runtime:'pipeline'` step).
    await spawnPipeline(step, {}, mockConfig, mockParentTools, 0, undefined, undefined, undefined, null, 'autonomous');

    // The inner step is spawned via the real inner runManifest → spawnInline →
    // new Agent. Assert the constructed inner Agent inherited the posture.
    expect(vi.mocked(Agent).mock.calls.length).toBeGreaterThanOrEqual(1);
    const innerConfig = vi.mocked(Agent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    expect(innerConfig['autonomy']).toBe('autonomous');
  });

  it('passes undefined autonomy through unchanged (in-session inheritance)', async () => {
    const step: ManifestStep = {
      id: 'nested2', agent: 'nested2', runtime: 'pipeline',
      pipeline: [{ id: 'inner2', task: 'do inner thing' }],
    };
    await spawnPipeline(step, {}, mockConfig, mockParentTools, 0);
    const innerConfig = vi.mocked(Agent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    expect(innerConfig['autonomy']).toBeUndefined();
  });
});

describe('createStepStreamHandler — A2 step tool-call capture', () => {
  function toolCall(name: string, input: unknown, subAgent?: string): StreamEvent {
    return { type: 'tool_call', name, input, agent: 'step', ...(subAgent ? { subAgent } : {}) } as StreamEvent;
  }
  function toolResult(name: string, result: string, opts?: { isError?: boolean; subAgent?: string }): StreamEvent {
    return { type: 'tool_result', name, result, agent: 'step', ...(opts?.isError ? { isError: true } : {}), ...(opts?.subAgent ? { subAgent: opts.subAgent } : {}) } as StreamEvent;
  }
  function turnEnd(inT: number, outT: number): StreamEvent {
    return { type: 'turn_end', stop_reason: 'end_turn', agent: 'step', usage: { input_tokens: inT, output_tokens: outT } } as unknown as StreamEvent;
  }

  it('tallies turn_end token usage via onTokens', () => {
    let tin = 0, tout = 0;
    const h = createStepStreamHandler({ onTokens: (i, o) => { tin += i; tout += o; } });
    h(turnEnd(100, 40));
    h(turnEnd(10, 5));
    expect(tin).toBe(110);
    expect(tout).toBe(45);
  });

  it('records a tool call by FIFO-pairing tool_call → tool_result (name, input, output, isError)', () => {
    const calls: Parameters<StepToolRecorder>[0][] = [];
    const h = createStepStreamHandler({ onTokens: () => {}, recordToolCall: (c) => calls.push(c) });
    h(toolCall('bash', { command: 'ls' }));
    h(toolResult('bash', 'file1\nfile2'));
    h(toolCall('http', { url: 'https://x' }));
    h(toolResult('http', 'boom', { isError: true }));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ toolName: 'bash', outputJson: 'file1\nfile2', isError: false });
    expect(JSON.parse(calls[0]!.inputJson)).toEqual({ command: 'ls' });
    expect(calls[1]).toMatchObject({ toolName: 'http', isError: true });
    expect(JSON.parse(calls[1]!.inputJson)).toEqual({ url: 'https://x' });
  });

  it('pairs same-named concurrent calls FIFO (input order preserved)', () => {
    const calls: Parameters<StepToolRecorder>[0][] = [];
    const h = createStepStreamHandler({ onTokens: () => {}, recordToolCall: (c) => calls.push(c) });
    h(toolCall('bash', { command: 'first' }));
    h(toolCall('bash', { command: 'second' }));
    h(toolResult('bash', 'out-first'));
    h(toolResult('bash', 'out-second'));
    expect(calls.map(c => c.outputJson)).toEqual(['out-first', 'out-second']);
    expect(JSON.parse(calls[0]!.inputJson)).toEqual({ command: 'first' });
  });

  it('does NOT record forwarded sub-agent events (only the step agent\'s own calls)', () => {
    const calls: Parameters<StepToolRecorder>[0][] = [];
    const h = createStepStreamHandler({ onTokens: () => {}, recordToolCall: (c) => calls.push(c) });
    h(toolCall('bash', { command: 'x' }, 'child')); // forwarded from a child → skip
    h(toolResult('bash', 'out', { subAgent: 'child' }));
    expect(calls).toHaveLength(0);
  });

  it('with no recorder, only tokens are tallied (tool events are a no-op, never throw)', () => {
    let tin = 0;
    const h = createStepStreamHandler({ onTokens: (i) => { tin += i; } });
    expect(() => { h(toolCall('bash', {})); h(toolResult('bash', 'ok')); h(turnEnd(5, 5)); }).not.toThrow();
    expect(tin).toBe(5);
  });
});
