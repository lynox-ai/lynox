import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolEntry, LynoxUserConfig } from '../types/index.js';
import { getModelId } from '../types/index.js';
import { setTierSetResolver } from '../core/tier-resolver.js';
import type { RoleConfig } from '../core/roles.js';

const mockSend = vi.fn().mockResolvedValue('mock result');

// Mock Agent class — must use function syntax for constructor
vi.mock('../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: {
    send: typeof mockSend;
    abort: ReturnType<typeof vi.fn>;
    noteUntrustedData: ReturnType<typeof vi.fn>;
    restoreConversationTaint: ReturnType<typeof vi.fn>;
  }) {
    this.send = mockSend;
    this.abort = vi.fn();
    // Cross-step taint seed: the spawner calls these on the constructed step
    // agent; a mockSend implementation can set the UntrustedSignals fields on
    // `this` to simulate what the step saw (same trick as spawn.test.ts).
    this.noteUntrustedData = vi.fn();
    this.restoreConversationTaint = vi.fn();
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
import { spawnInline, spawnViaAgent, spawnPipeline, resolveModel, buildSubAgentPromptCallbacks, stripHumanInTheLoopTools, buildReplayInstruction, INLINE_CORE_TOOLS, undeclaredInlineStepTier, createStepStreamHandler, newRunTaint, noteStepTaint, noteStepTaintLive, runTaintArmed, type RunTaint, type SubAgentPromptHandles, type StepToolRecorder } from './runtime-adapter.js';
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
    // F2/D2: a deny-only role never DECLARED bash, so it no longer gets it
    // silently (pre-F2 this asserted bash present). bash needs step.tools or a
    // role allowTools grant — for `operator` ("Read-only") this fixes the
    // role's own stated contract.
    expect(tools.find(t => t.definition.name === 'bash')).toBeUndefined();
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

describe('secretStore propagation into pipeline sub-agents (fail-loud secret resolution)', () => {
  // The orchestrator pipeline path (run_workflow → spawnViaAgent / spawnInline)
  // previously built each step Agent with NO secretStore. That skipped the whole
  // secret block in agent.ts: `secret:NAME` refs were neither resolved NOR
  // fail-loud-guarded, so the literal `secret:NAME` was sent to the external
  // service (401/empty → model fabricates). These tests pin that the parent's
  // SecretStore now threads into the built Agent — the precondition for
  // agent.ts's fail-loud unresolved-secret guard to fire for a sub-agent.
  // Mirrors spawn.ts threading `parentAgent.secretStore` for `spawn_agent`.
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  // A minimal SecretStoreLike stand-in — identity is what we assert (toBe).
  const mockSecretStore = {
    getMasked: vi.fn(),
    resolve: vi.fn(),
    listNames: vi.fn(),
    containsSecret: vi.fn(),
    maskSecrets: vi.fn((t: string) => t),
    recordConsent: vi.fn(),
    hasConsent: vi.fn(),
    isExpired: vi.fn(),
    findUnresolvedSecretRefs: vi.fn(),
    extractSecretNames: vi.fn(),
    resolveSecretRefs: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof spawnInline>[13]>;

  it('spawnInline threads the given secretStore into the built Agent', async () => {
    const step: ManifestStep = { id: 'creds', agent: 'creds', runtime: 'inline', task: 'call api with secret' };
    await spawnInline(
      step, {}, mockConfig, mockParentTools,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      mockSecretStore,
    );
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['secretStore']).toBe(mockSecretStore);
  });

  it('spawnViaAgent threads the given secretStore into the built Agent', async () => {
    const step: ManifestStep = { id: 'n-creds', agent: 'n-creds', runtime: 'agent', model: 'balanced' };
    const agentDef: AgentDef = { name: 'n-creds', version: '1', defaultTier: 'balanced', systemPrompt: 'do it', tools: [] };
    await spawnViaAgent(
      step, agentDef, {}, mockConfig, undefined, 'run-1',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      mockSecretStore,
    );
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['secretStore']).toBe(mockSecretStore);
  });

  it('spawnInline leaves secretStore undefined when none supplied (backward-compat)', async () => {
    const step: ManifestStep = { id: 'no-creds', agent: 'no-creds', runtime: 'inline', task: 'no secret' };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    // Pre-fix behaviour for non-run_workflow callers: no crash, secretStore stays undefined.
    expect(agentConfig['secretStore']).toBeUndefined();
  });

  it('spawnViaAgent leaves secretStore undefined when none supplied (backward-compat)', async () => {
    const step: ManifestStep = { id: 'no-n-creds', agent: 'no-n-creds', runtime: 'agent', model: 'balanced' };
    const agentDef: AgentDef = { name: 'no-n-creds', version: '1', defaultTier: 'balanced', systemPrompt: 'do it', tools: [] };
    await spawnViaAgent(step, agentDef, {}, mockConfig, undefined, 'run-1');
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['secretStore']).toBeUndefined();
  });
});

describe('F1: undeclared step tier defaults to fast (spawn wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  it('an inline step with no model and no role spawns on the fast tier', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'paginate' };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['model']).toContain('haiku');
  });

  it('the session default_tier does NOT reach an undeclared step', async () => {
    const cfg = { api_key: 'test-key', default_tier: 'deep' } as unknown as LynoxUserConfig;
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'paginate' };
    await spawnInline(step, {}, cfg, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['model']).toContain('haiku');
  });

  it('a declared step.model still wins', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'analyze', model: 'balanced' };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(agentConfig['model']).toContain('sonnet');
  });

  it('undeclaredInlineStepTier: role tier wins over the fast default', () => {
    mockGetRole.mockReturnValue({ model: 'balanced', effort: 'high', autonomy: 'guided', description: 'r' });
    expect(undeclaredInlineStepTier({ role: 'researcher' })).toBe('balanced');
    mockGetRole.mockReturnValue(undefined);
    expect(undeclaredInlineStepTier({})).toBe('fast');
  });
});

describe('F2: declared step tool sets (spawn wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
  });

  const toolNames = (): string[] => {
    const agentConfig = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    return (agentConfig['tools'] as ToolEntry[]).map(t => t.definition.name);
  };

  it('an undeclared step gets the pool WITHOUT bash', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'do' };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toContain('read_file');
    expect(toolNames()).toContain('write_file');
    expect(toolNames()).not.toContain('bash');
  });

  it('a step gets bash ONLY by declaring it', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'run script', tools: ['bash'] };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual(['bash']);
  });

  it('a declared set narrows to exactly the declared names', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'read', tools: ['read_file'] };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual(['read_file']);
  });

  it('a declared name outside the inline pool is not granted', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'spawn', tools: ['spawn_agent', 'read_file'] };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual(['read_file']);
  });

  it('a captured replay step\'s tool is admitted alongside its declared set', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'replay', tools: ['read_file'], tool: 'bash', input_template: { cmd: 'ls' } };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toContain('bash');
    expect(toolNames()).toContain('read_file');
  });

  it('a role allowTools grant still passes the full parent set to the role filter', async () => {
    mockGetRole.mockReturnValue({ model: 'fast', effort: 'high', autonomy: 'autonomous', allowTools: ['bash'], description: 'op' });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', role: 'operator' };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual(['bash']);
  });

  it('a declared EMPTY array grants zero tools (declaration, not absence)', async () => {
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'pure reasoning', tools: [] };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual([]);
  });

  it('role allowTools wins over a step tools declaration (pinned precedence)', async () => {
    // Both present is YAML-author territory (plan_task steps carry no role).
    // The role grant is the wider, deliberate surface — pin that it wins so a
    // refactor can't silently flip the precedence.
    mockGetRole.mockReturnValue({ model: 'fast', effort: 'high', autonomy: 'autonomous', allowTools: ['bash'], description: 'op' });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', role: 'operator', tools: ['read_file'] };
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(toolNames()).toEqual(['bash']);
  });

  it('declared ask_user is still stripped when no parent prompt callback exists', async () => {
    // Belt-and-suspenders pin: the validator blocks autonomous+ask_user at
    // save, but if such a step reaches an autonomous spawn anyway, the strip
    // must win over the declaration — leaving the step with zero tools beats
    // a dispatch-time throw inside an unattended run.
    const withAskUser: ToolEntry[] = [...mockParentTools, {
      definition: { name: 'ask_user', description: 'Ask', input_schema: { type: 'object' } } as ToolEntry['definition'],
      handler: async () => 'answer',
    }];
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', task: 'confirm', tools: ['ask_user'] };
    await spawnInline(step, {}, mockConfig, withAskUser);
    expect(toolNames()).toEqual([]);
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

  it('still includes the foundational core tools + the external-fetch tools a workflow step needs', () => {
    for (const name of ['bash', 'read_file', 'write_file', 'http_request', 'web_research', 'ask_user', 'data_store_query', 'data_store_insert']) {
      expect(INLINE_CORE_TOOLS.has(name)).toBe(true);
    }
    // The old typo: `'http'` matched no registered tool, so http_request was
    // silently stripped from every inline step since v1.2.2. Lock it out.
    expect(INLINE_CORE_TOOLS.has('http')).toBe(false);
  });

  it('every INLINE_CORE_TOOLS name resolves to a real registered tool (catches the http/http_request typo class)', async () => {
    const builtins = await import('../tools/builtin/index.js');
    const builtinNames = new Set(
      Object.values(builtins)
        .filter((v): v is { definition: { name: string } } =>
          typeof v === 'object' && v !== null && 'definition' in v &&
          typeof (v as { definition?: unknown }).definition === 'object')
        .map((t) => t.definition.name),
    );
    // web_research is an INTEGRATION tool (integrations/search/web-search-tool.ts),
    // not a builtin. Resolve its REAL registered name (the definition is provider-
    // independent) rather than hard-coding the string — so a rename of the tool
    // drifts LOUDLY here (INLINE_CORE_TOOLS's 'web_research' would no longer match)
    // instead of being silently blind-allowlisted (the very typo class this guards).
    const { createWebSearchTool } = await import('../integrations/search/web-search-tool.js');
    // The factory interpolates `provider.name` into the description — a minimal
    // stub is enough to read the (provider-independent) definition name.
    const webResearchName = createWebSearchTool({ name: 'stub' } as unknown as never).definition.name;
    const NON_BUILTIN_ALLOWED = new Set([webResearchName]);
    const unknown = [...INLINE_CORE_TOOLS].filter((n) => !builtinNames.has(n) && !NON_BUILTIN_ALLOWED.has(n));
    expect(unknown, `INLINE_CORE_TOOLS names with no registered tool: ${unknown.join(', ')}`).toEqual([]);
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

  it('carries a nested step\'s declared tools into the sub-manifest (F2)', async () => {
    const step: ManifestStep = {
      id: 'nested3', agent: 'nested3', runtime: 'pipeline',
      pipeline: [{ id: 'inner3', task: 'run a script', tools: ['bash'] }],
    };
    await spawnPipeline(step, {}, mockConfig, mockParentTools, 0);
    // Dropping `tools` in the sub-manifest conversion makes the inner step
    // undeclared → bash-less default pool → this assert fails.
    const innerConfig = vi.mocked(Agent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    const innerNames = (innerConfig['tools'] as ToolEntry[]).map(t => t.definition.name);
    expect(innerNames).toEqual(['bash']);
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

// #66: pipeline/workflow steps must follow the hybrid tier_set — the gap that
// let a hybrid-mode step silently run on the BASE provider (or 404 on a
// model/endpoint mismatch). The #1 requirement is BYTE-PARITY in standard mode:
// with no tier_set the built Agent config must be identical to pre-hybrid.
describe('#66 hybrid tier_set steers pipeline step provider/model (runtime-adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRole.mockReturnValue(undefined);
    setTierSetResolver({ routingMode: 'standard', tierSet: null });
  });
  afterEach(() => {
    setTierSetResolver({ routingMode: 'standard', tierSet: null });
  });

  const agentCfg = (): Record<string, unknown> =>
    vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;

  // getActiveProvider() defaults to 'anthropic' in this isolated test file (no
  // initLLMProvider call), so a base-anthropic config resolves models on anthropic.
  const BASE_ANTHROPIC = {
    api_key: 'base-anthropic-key',
    provider: 'anthropic',
    api_base_url: 'https://base.anthropic.example/v1',
    openai_model_id: 'base-openai-model',
  } as unknown as LynoxUserConfig;

  describe('STANDARD mode — byte-parity (Agent config identical to pre-hybrid)', () => {
    it('spawnInline keeps the exact base wire + resolveRunModel model', async () => {
      const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'balanced' };
      await spawnInline(step, {}, BASE_ANTHROPIC, mockParentTools);
      const cfg = agentCfg();
      expect(cfg['provider']).toBe('anthropic');
      expect(cfg['apiKey']).toBe('base-anthropic-key');
      expect(cfg['apiBaseURL']).toBe('https://base.anthropic.example/v1');
      expect(cfg['openaiModelId']).toBe('base-openai-model');
      // Model == getModelId(resolved tier, active provider) == the old runModel.modelId.
      expect(cfg['model']).toBe(getModelId('balanced', 'anthropic'));
    });

    it('spawnViaAgent keeps the exact base wire + resolveRunModel model', async () => {
      const step: ManifestStep = { id: 'a', agent: 'analyst', runtime: 'agent', model: 'balanced' };
      const agentDef: AgentDef = { name: 'analyst', version: '1', defaultTier: 'balanced', systemPrompt: 'x', tools: [] };
      await spawnViaAgent(step, agentDef, {}, BASE_ANTHROPIC, undefined, 'run-1');
      const cfg = agentCfg();
      expect(cfg['provider']).toBe('anthropic');
      expect(cfg['apiKey']).toBe('base-anthropic-key');
      expect(cfg['apiBaseURL']).toBe('https://base.anthropic.example/v1');
      expect(cfg['openaiModelId']).toBe('base-openai-model');
      expect(cfg['model']).toBe(getModelId('balanced', 'anthropic'));
    });

    it('a provider-LESS base config yields provider:undefined (NOT coerced to a default)', async () => {
      // The strongest byte-parity proof: the old code passed `provider: config.provider`
      // verbatim (undefined stays undefined). A naive `provider: creds.provider` would
      // have silently coerced this to 'anthropic'. mockConfig.provider is undefined.
      const step: ManifestStep = { id: 's2', agent: 's2', runtime: 'inline', model: 'fast' };
      await spawnInline(step, {}, mockConfig, mockParentTools);
      const cfg = agentCfg();
      expect(cfg['provider']).toBeUndefined();
      expect(cfg['apiKey']).toBe('test-key');
      expect(cfg['apiBaseURL']).toBeUndefined();
      expect(cfg['openaiModelId']).toBeUndefined();
    });

    it('a genuine pinned model id survives (not overwritten by the tier→provider map)', async () => {
      // resolveRunModel passes a real model id through verbatim; the non-cross
      // branch must keep runModel.modelId, NOT snap.modelId (getModelId(tier,base)).
      const step: ManifestStep = { id: 's3', agent: 's3', runtime: 'inline', model: 'claude-opus-4-7' };
      await spawnInline(step, {}, BASE_ANTHROPIC, mockParentTools);
      expect(agentCfg()['model']).toBe('claude-opus-4-7');
    });
  });

  describe('HYBRID mode — the step follows its cross-provider slot', () => {
    it('spawnInline: a cross openai/Mistral slot drives provider + model + creds', async () => {
      setTierSetResolver({
        routingMode: 'hybrid',
        tierSet: { balanced: { provider: 'openai', model_id: 'ministral-14b-2512', api_key: 'mistral-slot-key', api_base_url: 'https://api.mistral.ai/v1' } },
      });
      const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'balanced' };
      await spawnInline(step, {}, BASE_ANTHROPIC, mockParentTools);
      const cfg = agentCfg();
      expect(cfg['provider']).toBe('openai');
      expect(cfg['model']).toBe('ministral-14b-2512');
      expect(cfg['apiKey']).toBe('mistral-slot-key');
      expect(cfg['apiBaseURL']).toBe('https://api.mistral.ai/v1');
      expect(cfg['openaiModelId']).toBe('ministral-14b-2512');
    });

    it('spawnViaAgent: a cross anthropic slot from a Mistral base drives the slot wire', async () => {
      setTierSetResolver({
        routingMode: 'hybrid',
        tierSet: { deep: { provider: 'anthropic', model_id: 'claude-sonnet-5', api_key: 'sk-ant-slot' } },
      });
      const config = {
        api_key: 'base-mistral-key', provider: 'openai',
        api_base_url: 'https://api.mistral.ai/v1', openai_model_id: 'ministral-8b-2512',
      } as unknown as LynoxUserConfig;
      const step: ManifestStep = { id: 'a', agent: 'analyst', runtime: 'agent', model: 'deep' };
      const agentDef: AgentDef = { name: 'analyst', version: '1', defaultTier: 'deep', systemPrompt: 'x', tools: [] };
      await spawnViaAgent(step, agentDef, {}, config, undefined, 'run-2');
      const cfg = agentCfg();
      expect(cfg['provider']).toBe('anthropic');
      expect(cfg['model']).toBe('claude-sonnet-5');
      expect(cfg['apiKey']).toBe('sk-ant-slot');
      expect(cfg['apiBaseURL']).toBeUndefined();
      expect(cfg['openaiModelId']).toBe('claude-sonnet-5');
    });

    it('a hybrid tier_set with NO slot for the step tier is byte-parity (base wire)', async () => {
      // fast slot unset → crossProviderSlot=false → base anthropic values kept.
      setTierSetResolver({
        routingMode: 'hybrid',
        tierSet: { deep: { provider: 'anthropic', model_id: 'claude-sonnet-5', api_key: 'sk-ant-slot' } },
      });
      const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'fast' };
      await spawnInline(step, {}, BASE_ANTHROPIC, mockParentTools);
      const cfg = agentCfg();
      expect(cfg['provider']).toBe('anthropic');
      expect(cfg['apiKey']).toBe('base-anthropic-key');
      expect(cfg['model']).toBe(getModelId('fast', 'anthropic'));
    });
  });
});

/**
 * A hybrid tier slot may point at a DIFFERENT endpoint than the base config, and
 * since Mistral, Groq, Together, Fireworks and a local Ollama all serialise to
 * `provider: 'openai'`, "same provider" no longer implies "same endpoint".
 * Resolving the slot's key on the provider alone therefore hands the base key to
 * a foreign endpoint — a Groq slot under a Mistral base gets the Mistral key,
 * bearer-tokened over the wire.
 *
 * This is not hypothetical: it shipped once INSIDE the fix for the very same bug.
 * The resolver closure here was declared `(provider)`, TypeScript accepted it
 * where a `(provider, apiBaseURL)` callback was expected — lower arity is always
 * assignable — and the endpoint argument was silently dropped, so every slot
 * resolved against the BASE url. The compiler cannot catch that class of mistake.
 * These tests can.
 */
describe('spawnInline — a foreign-endpoint tier slot never inherits the base key', () => {
  const GROQ = 'https://api.groq.com/openai/v1';
  const MISTRAL = 'https://api.mistral.ai/v1';
  const OLLAMA = 'http://localhost:11434/v1';

  const agentCfg = (): Record<string, unknown> =>
    vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;

  /** A Mistral tenant: its key lives in the shared openai slot, MISTRAL_API_KEY. */
  const BASE_MISTRAL = {
    provider: 'openai',
    api_base_url: MISTRAL,
    openai_model_id: 'mistral-large-2512',
  } as unknown as LynoxUserConfig;

  beforeEach(() => {
    vi.mocked(Agent).mockClear();
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-secret');
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('OLLAMA_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    setTierSetResolver({ routingMode: 'standard', tierSet: null });
    vi.unstubAllEnvs();
  });

  it('does NOT lend the Mistral key to a Groq slot', async () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'openai', model_id: 'llama-3.3-70b-versatile', api_base_url: GROQ } },
    });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'fast' };
    await spawnInline(step, {}, BASE_MISTRAL, mockParentTools);

    const cfg = agentCfg();
    expect(cfg['apiBaseURL']).toBe(GROQ);       // the slot does reach Groq…
    expect(cfg['apiKey']).not.toBe('mistral-secret');  // …without the Mistral key.
  });

  it('uses the Groq slot’s OWN key once it is configured', async () => {
    vi.stubEnv('GROQ_API_KEY', 'groq-secret');
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'openai', model_id: 'llama-3.3-70b-versatile', api_base_url: GROQ } },
    });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'fast' };
    await spawnInline(step, {}, BASE_MISTRAL, mockParentTools);

    expect(agentCfg()['apiKey']).toBe('groq-secret');
  });

  it('does NOT put the Mistral key on the wire to a local Ollama slot', async () => {
    // Plaintext, over http, to whatever process happens to hold that port.
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'openai', model_id: 'qwen2.5', api_base_url: OLLAMA } },
    });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'fast' };
    await spawnInline(step, {}, BASE_MISTRAL, mockParentTools);

    const cfg = agentCfg();
    expect(cfg['apiBaseURL']).toBe(OLLAMA);
    expect(cfg['apiKey']).not.toBe('mistral-secret');
  });

  it('a slot on the BASE endpoint still resolves normally (no regression)', async () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'openai', model_id: 'ministral-8b-2512', api_base_url: MISTRAL } },
    });
    const step: ManifestStep = { id: 's', agent: 's', runtime: 'inline', model: 'fast' };
    await spawnInline(step, {}, BASE_MISTRAL, mockParentTools);

    expect(agentCfg()['apiKey']).toBe('mistral-secret');
  });

  it('B3: INLINE_CORE_TOOLS exposes recall (read) but NOT remember (write)', () => {
    // A pipeline step builds a FRESH Agent with the untrusted-taint latches cleared, so an
    // inline `remember` of an upstream step's external content would write it ACTIVE (an H4
    // pending_review bypass). Only the read side is inline-safe; durable writes stay opt-in.
    expect(INLINE_CORE_TOOLS.has('recall')).toBe(true);
    expect(INLINE_CORE_TOOLS.has('remember')).toBe(false);
  });
});

// ===========================================================================
// Cross-step taint (RunTaint) + the DK flag riding to step agents.
// The spawn seam already has both (spawn.ts); these pin the pipeline seam.
// ===========================================================================

describe('RunTaint — cross-step untrusted inheritance', () => {
  const inlineStep: ManifestStep = { id: 's1', agent: 's1', runtime: 'inline', task: 'do work' };

  /** spawnInline's runTaint is the 15th positional arg — keep ONE spelling of the pad. */
  const runInline = (taint: RunTaint | undefined, config = mockConfig) =>
    spawnInline(inlineStep, {}, config, mockParentTools,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taint);

  const lastInstance = () => {
    const instances = vi.mocked(Agent).mock.instances as unknown as Array<{
      noteUntrustedData: ReturnType<typeof vi.fn>;
      restoreConversationTaint: ReturnType<typeof vi.fn>;
    }>;
    return instances[instances.length - 1]!;
  };

  beforeEach(() => {
    vi.mocked(Agent).mockClear();
    // mockReset, not mockClear: a failing test can leak a queued
    // mockImplementationOnce that the next test would silently consume.
    mockSend.mockReset();
    mockSend.mockResolvedValue('mock result');
  });

  it('an armed accumulator seeds the step\'s STICKY latch — never the run marker', async () => {
    // The marker is what the review chip REPORTS as the cause; a step that
    // inherited taint but read nothing itself must not claim it did (the same
    // distinction spawn.test.ts pins for the child seed).
    const taint = { seeded: 'conversation', earned: 'none' } as RunTaint;
    await runInline(taint);
    expect(lastInstance().restoreConversationTaint).toHaveBeenCalled();
    expect(lastInstance().noteUntrustedData).not.toHaveBeenCalled();
  });

  it('a clean accumulator leaves the step clean', async () => {
    await runInline(newRunTaint());
    expect(lastInstance().restoreConversationTaint).not.toHaveBeenCalled();
    expect(lastInstance().noteUntrustedData).not.toHaveBeenCalled();
  });

  it('step 1 reads external content → the SAME accumulator arms step 2 (the H4 cross-step chain)', async () => {
    const taint = newRunTaint();
    // Step 1: reads external content via a non-wrapping tool (web/read_file class).
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      this.sawExternalContentTool = true;
      return 'step 1 result';
    });
    await runInline(taint);
    expect(taint.earned).toBe('external-tool');
    // Step 2: fresh agent, same run — must start with its sticky latch armed,
    // so a durable write inside it routes to pending_review.
    await runInline(taint);
    expect(lastInstance().restoreConversationTaint).toHaveBeenCalled();
  });

  it('a step that read external content and then FAILED still folds its taint (finally-path)', async () => {
    const taint = newRunTaint();
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      this.sawExternalContentTool = true;
      throw new Error('step blew up after the read');
    });
    await expect(runInline(taint)).rejects.toThrow('step blew up');
    // Under on_failure:'continue' later steps still run — they must inherit.
    expect(taint.earned).toBe('external-tool');
  });

  it('spawnViaAgent seeds and folds through the same accumulator', async () => {
    const agentDef: AgentDef = { name: 'named', description: '', tools: [] };
    const taint = { seeded: 'external-tool', earned: 'none' } as RunTaint;
    const namedStep: ManifestStep = { id: 'n1', agent: 'named', runtime: 'agent' };
    // The step itself reads external content — the FOLD half must record it.
    // (Deleting only spawnViaAgent's finally-fold kept every other test green,
    // because the mutation probe removed both copies at once.)
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      this.sawExternalContentTool = true;
      return 'named result';
    });
    await spawnViaAgent(namedStep, agentDef, {}, mockConfig, undefined, 'run-1',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taint);
    expect(lastInstance().restoreConversationTaint).toHaveBeenCalled();
    expect(taint.earned).toBe('external-tool');
  });

  it('a same-phase PARALLEL sibling is armed MID-RUN by another sibling\'s external read', async () => {
    // The spawn-time seed cannot cover this: runner.ts spawns a whole phase via
    // Promise.allSettled before any step folds, so B spawns clean while A is
    // still reading. The mid-run fold (onToolActivity → noteStepTaintLive) must
    // arm B AT A's tool_result event — not at A's finally, which for the
    // store-then-recall chain is after the leaked value is already readable.
    const taint = newRunTaint();
    const cfgAt = (i: number) => vi.mocked(Agent).mock.calls[i]![0] as unknown as Record<string, unknown>;
    const instanceAt = (i: number) => (vi.mocked(Agent).mock.instances as unknown as Array<{
      restoreConversationTaint: ReturnType<typeof vi.fn>;
    }>)[i]!;

    let resolveBSpawned!: () => void;
    const bSpawned = new Promise<void>((r) => { resolveBSpawned = r; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => { releaseB = r; });
    let bCleanAtSpawn: boolean | undefined;
    let bArmedAtEmit: boolean | undefined;

    // Step A: waits until B is spawned (parallel phase), then reads external
    // content — the tool_result stream event is where the mid-run fold runs.
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      await bSpawned;
      bCleanAtSpawn = instanceAt(1).restoreConversationTaint.mock.calls.length === 0;
      this.sawExternalContentTool = true;
      (cfgAt(0)['onStream'] as (e: StreamEvent) => void)(
        { type: 'tool_result', name: 'http_request', result: 'external payload', agent: 's1' },
      );
      bArmedAtEmit = instanceAt(1).restoreConversationTaint.mock.calls.length > 0;
      releaseB();
      return 'A';
    });
    // Step B: spawned clean, still mid-send while A reads.
    mockSend.mockImplementationOnce(async () => {
      resolveBSpawned();
      await bGate;
      return 'B';
    });

    await Promise.all([runInline(taint), runInline(taint)]);
    expect(bCleanAtSpawn).toBe(true);      // B did NOT inherit at spawn (phase was clean)
    expect(taint.earned).toBe('external-tool');
    expect(bArmedAtEmit).toBe(true);       // …and was armed synchronously at A's event
  });

  it('a fully-internal parallel phase leaves every sibling clean (no over-taint)', async () => {
    // Gegenrichtung: the arming must not fire off tool events that carry no
    // taint — two clean siblings exchanging nothing must both stay clean.
    const taint = newRunTaint();
    const cfgAt = (i: number) => vi.mocked(Agent).mock.calls[i]![0] as unknown as Record<string, unknown>;
    mockSend.mockImplementationOnce(async () => {
      (cfgAt(0)['onStream'] as (e: StreamEvent) => void)(
        { type: 'tool_result', name: 'memory_store', result: 'ok', agent: 's1' },
      );
      return 'A';
    });
    mockSend.mockImplementationOnce(async () => 'B');
    await Promise.all([runInline(taint), runInline(taint)]);
    expect(runTaintArmed(taint)).toBe(false);
    const instances = vi.mocked(Agent).mock.instances as unknown as Array<{ restoreConversationTaint: ReturnType<typeof vi.fn> }>;
    expect(instances[0]!.restoreConversationTaint).not.toHaveBeenCalled();
    expect(instances[1]!.restoreConversationTaint).not.toHaveBeenCalled();
  });

  it('a live registration is removed in finally — later arming does not touch finished steps', async () => {
    // The live set must not leak agents across steps: after step 1 finishes
    // clean, an arming caused by step 2 must not call into step 1's agent.
    const taint = newRunTaint();
    await runInline(taint);                              // step 1: clean, finishes
    const first = (vi.mocked(Agent).mock.instances as unknown as Array<{ restoreConversationTaint: ReturnType<typeof vi.fn> }>)[0]!;
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      this.sawExternalContentTool = true;
      return 'step 2';
    });
    await runInline(taint);                              // step 2: arms in finally
    expect(runTaintArmed(taint)).toBe(true);
    expect(first.restoreConversationTaint).not.toHaveBeenCalled();
  });

  it('taint that only surfaces at a step\'s finally still arms live siblings', async () => {
    // Backstop half: an arming source with no tool event (e.g. spawn's child
    // hand-off) reaches the accumulator only at the finally fold — a sibling
    // still mid-send must be armed there too, not just by the stream path.
    const taint = newRunTaint();
    const instanceAt = (i: number) => (vi.mocked(Agent).mock.instances as unknown as Array<{
      restoreConversationTaint: ReturnType<typeof vi.fn>;
    }>)[i]!;
    let resolveBSpawned!: () => void;
    const bSpawned = new Promise<void>((r) => { resolveBSpawned = r; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => { releaseB = r; });
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      await bSpawned;
      this.sawExternalContentTool = true; // no stream event — finally is the only fold
      return 'A';
    });
    mockSend.mockImplementationOnce(async () => {
      resolveBSpawned();
      await bGate;
      return 'B';
    });
    const pA = runInline(taint);
    const pB = runInline(taint);
    await pA;
    expect(instanceAt(1).restoreConversationTaint).toHaveBeenCalled();
    releaseB();
    await pB;
  });

  it('spawnViaAgent: taint that only surfaces at the finally still arms live siblings', async () => {
    // Mirror of the spawnInline finally-backstop test above — proven necessary:
    // mutating ONLY spawnViaAgent's finally fold back to the push-less
    // noteStepTaint kept every other test green (the same both-copies-at-once
    // trap the fold test at the top of this describe documents).
    const agentDef: AgentDef = { name: 'named', description: '', tools: [] };
    const namedStep: ManifestStep = { id: 'n1', agent: 'named', runtime: 'agent' };
    const taint = newRunTaint();
    const peer = { restoreConversationTaint: vi.fn() };
    (taint.live ??= new Set()).add(peer);
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      this.sawExternalContentTool = true; // no stream event — finally is the only fold
      return 'named';
    });
    await spawnViaAgent(namedStep, agentDef, {}, mockConfig, undefined, 'run-1',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taint);
    expect(peer.restoreConversationTaint).toHaveBeenCalled();
  });

  it('a throwing peer does not leave the remaining siblings unarmed', () => {
    // The transition fires exactly once (`earned` is set afterwards), so a peer
    // skipped by an aborted loop would stay clean for good — and the throw
    // would surface inside the emitting step's stream handler.
    const taint = newRunTaint();
    const bad = { restoreConversationTaint: vi.fn(() => { throw new Error('boom'); }) };
    const good = { restoreConversationTaint: vi.fn() };
    taint.live = new Set([bad, good]);
    expect(() => noteStepTaintLive(taint, { sawExternalContentTool: true })).not.toThrow();
    expect(bad.restoreConversationTaint).toHaveBeenCalled();
    expect(good.restoreConversationTaint).toHaveBeenCalled();
  });

  it('spawnPipeline threads the SAME accumulator into the nested run (live arming crosses nesting)', async () => {
    // A nested `runtime:'pipeline'` step runs the real inner runManifest →
    // spawnInline → Agent. Dropping `runTaint` from the threading would sever
    // both the seed AND the live registration for every nested step.
    const step: ManifestStep = {
      id: 'nested-taint', agent: 'nested-taint', runtime: 'pipeline',
      pipeline: [{ id: 'inner-taint', task: 'record something' }],
    };
    const taint = { seeded: 'external-tool', earned: 'none' } as RunTaint;
    await spawnPipeline(step, {}, mockConfig, mockParentTools, 0,
      undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, taint);
    const inner = (vi.mocked(Agent).mock.instances as unknown as Array<{
      restoreConversationTaint: ReturnType<typeof vi.fn>;
    }>).at(-1)!;
    expect(inner.restoreConversationTaint).toHaveBeenCalled();
  });

  it('spawnViaAgent wires the same mid-run arming (the two step paths must not diverge)', async () => {
    const agentDef: AgentDef = { name: 'named', description: '', tools: [] };
    const namedStep: ManifestStep = { id: 'n1', agent: 'named', runtime: 'agent' };
    const taint = newRunTaint();
    const peer = { restoreConversationTaint: vi.fn() };
    (taint.live ??= new Set()).add(peer);
    let selfRegistered: boolean | undefined;
    let peerArmedAtEmit: boolean | undefined;
    mockSend.mockImplementationOnce(async function (this: { sawExternalContentTool?: boolean }) {
      selfRegistered = taint.live!.size === 2; // the peer + this step's own agent
      this.sawExternalContentTool = true;
      const cfg = vi.mocked(Agent).mock.calls[0]![0] as unknown as Record<string, unknown>;
      (cfg['onStream'] as (e: StreamEvent) => void)(
        { type: 'tool_result', name: 'http_request', result: 'x', agent: 'n1' },
      );
      peerArmedAtEmit = peer.restoreConversationTaint.mock.calls.length > 0;
      return 'named';
    });
    await spawnViaAgent(namedStep, agentDef, {}, mockConfig, undefined, 'run-1',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, taint);
    expect(selfRegistered).toBe(true);       // registered itself live at spawn
    expect(peerArmedAtEmit).toBe(true);      // armed the sibling at its own event
    expect(taint.live!.has(peer)).toBe(true);
    expect(taint.live!.size).toBe(1);        // removed itself in finally
  });

  it('helpers: marker outranks external-tool; a reflected conversation cause carries nothing', () => {
    const taint = newRunTaint();
    expect(runTaintArmed(taint)).toBe(false);
    // 'conversation' off a fresh step agent is only our own seed reflected back.
    noteStepTaint(taint, { conversationSawUntrusted: true });
    expect(taint.earned).toBe('none');
    noteStepTaint(taint, { sawExternalContentTool: true });
    expect(taint.earned).toBe('external-tool');
    // marker (wrapped content actually handled) is the more specific claim and wins…
    noteStepTaint(taint, { sawUntrustedData: true });
    expect(taint.earned).toBe('marker');
    // …and is never downgraded by a later external-tool step.
    noteStepTaint(taint, { sawExternalContentTool: true });
    expect(taint.earned).toBe('marker');
    expect(runTaintArmed(taint)).toBe(true);
  });

  it('a caller-tainted seed arms the accumulator without any step earning', () => {
    const taint = newRunTaint({ conversationSawUntrusted: true });
    expect(taint.seeded).toBe('conversation');
    expect(taint.earned).toBe('none');
    expect(runTaintArmed(taint)).toBe(true);
  });
});

describe('durableMemoryEnabled rides to step agents (one flag governs the whole run)', () => {
  const inlineStep: ManifestStep = { id: 's1', agent: 's1', runtime: 'inline', task: 'do work' };

  beforeEach(() => {
    vi.mocked(Agent).mockClear();
    // mockReset, not mockClear: a failing test can leak a queued
    // mockImplementationOnce that the next test would silently consume.
    mockSend.mockReset();
    mockSend.mockResolvedValue('mock result');
  });

  const lastCfg = () => {
    const calls = vi.mocked(Agent).mock.calls;
    return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
  };

  it('an inline step on a DK-on tenant stands the legacy extractor down', async () => {
    // The inline path shares the parent's Memory, so WITHOUT the flag the step
    // ran the legacy end-of-turn extraction the main agent stands down
    // (agent.ts gates maybeUpdate on `durableMemoryEnabled === true`).
    const dkOn = { ...mockConfig, durable_memory_enabled: true } as LynoxUserConfig;
    await spawnInline(inlineStep, {}, dkOn, mockParentTools);
    expect(lastCfg()['durableMemoryEnabled']).toBe(true);
  });

  it('a DK-off tenant\'s inline step keeps the pre-fix behaviour', async () => {
    await spawnInline(inlineStep, {}, mockConfig, mockParentTools);
    expect(lastCfg()['durableMemoryEnabled']).toBe(false);
  });

  it('the named-agent path carries the same flag (the two step paths must not diverge)', async () => {
    const agentDef: AgentDef = { name: 'named', description: '', tools: [] };
    const namedStep: ManifestStep = { id: 'n1', agent: 'named', runtime: 'agent' };
    const dkOn = { ...mockConfig, durable_memory_enabled: true } as LynoxUserConfig;
    await spawnViaAgent(namedStep, agentDef, {}, dkOn, undefined, 'run-1');
    expect(lastCfg()['durableMemoryEnabled']).toBe(true);
  });
});
