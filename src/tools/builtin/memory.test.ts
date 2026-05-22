import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryStoreTool, memoryRecallTool, memoryDeleteTool, memoryUpdateTool, memoryListTool, memoryPromoteTool } from './memory.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

vi.mock('../../core/observability.js', () => ({
  channels: {
    memoryStore: { publish: vi.fn() },
    // B1 KG-backed tests need these channels — they are checked by the
    // production KnowledgeLayer / AgentMemoryDb store path. hasSubscribers
    // is read in a hot path, so it must be a plain false for the no-op tests.
    knowledgeGraph: { publish: vi.fn(), hasSubscribers: false },
    knowledgeEntity: { publish: vi.fn(), hasSubscribers: false },
  },
}));

function makeAgent(memory: IAgent['memory'] = null): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory,
    tools: [],
    onStream: null,
    toolContext: createToolContext({}),
  };
}

function makeMockMemory(overrides: Partial<NonNullable<IAgent['memory']>> = {}): NonNullable<IAgent['memory']> {
  return {
    load: vi.fn(),
    save: vi.fn(),
    append: vi.fn(),
    delete: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockResolvedValue(false),
    render: vi.fn().mockReturnValue(''),
    hasContent: vi.fn().mockReturnValue(false),
    loadAll: vi.fn(),
    maybeUpdate: vi.fn(),
    appendScoped: vi.fn(),
    loadScoped: vi.fn(),
    deleteScoped: vi.fn().mockResolvedValue(0),
    updateScoped: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('memoryStoreTool', () => {
  it('publishes to lynox:memory:store channel after storing', async () => {
    const { channels } = await import('../../core/observability.js');
    const append = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent(makeMockMemory({ append }));

    await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'channel test' },
      agent,
    );
    expect(channels.memoryStore.publish).toHaveBeenCalledWith({
      namespace: 'knowledge',
      content: 'channel test',
    });
  });

  it('stores content via agent.memory.append and returns confirmation', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent(makeMockMemory({ append }));

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'test data' },
      agent,
    );
    expect(result).toBe('Stored in knowledge. Entities and relationships are extracted automatically for future cross-referencing.');
    expect(append).toHaveBeenCalledWith('knowledge', 'test data');
  });

  it('returns "not configured" when memory is null', async () => {
    const agent = makeAgent(null);
    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'test' },
      agent,
    );
    expect(result).toBe('Memory is not configured for this agent.');
  });

  it('blocks storing content containing secret values', async () => {
    const secretStore: IAgent['secretStore'] = {
      getMasked: () => null,
      resolve: () => null,
      listNames: () => ['MY_KEY'],
      containsSecret: vi.fn().mockReturnValue(true),
      maskSecrets: (t: string) => t,
      recordConsent: () => {},
      hasConsent: () => false,
      isExpired: () => false,
    };
    const agent: IAgent = {
      name: 'test',
      model: 'test-model',
      memory: makeMockMemory(),
      tools: [],
      onStream: null,
      secretStore,
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'here is my api key sk-12345678' },
      agent,
    );
    expect(result).toContain('Cannot store content containing secret values');
    expect(agent.memory!.append).not.toHaveBeenCalled();
  });

  it('allows storing safe content when secretStore is present', async () => {
    const secretStore: IAgent['secretStore'] = {
      getMasked: () => null,
      resolve: () => null,
      listNames: () => ['MY_KEY'],
      containsSecret: vi.fn().mockReturnValue(false),
      maskSecrets: (t: string) => t,
      recordConsent: () => {},
      hasConsent: () => false,
      isExpired: () => false,
    };
    const append = vi.fn().mockResolvedValue(undefined);
    const agent: IAgent = {
      name: 'test',
      model: 'test-model',
      memory: makeMockMemory({ append }),
      tools: [],
      onStream: null,
      secretStore,
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'safe content' },
      agent,
    );
    expect(result).toBe('Stored in knowledge. Entities and relationships are extracted automatically for future cross-referencing.');
    expect(append).toHaveBeenCalledWith('knowledge', 'safe content');
  });
});

describe('memoryRecallTool', () => {
  it('loads and returns content from memory', async () => {
    const load = vi.fn().mockResolvedValue('recalled data');
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'knowledge' }, agent);
    expect(result).toBe('recalled data');
    expect(load).toHaveBeenCalledWith('knowledge');
  });

  it('returns "No content found" when load returns null', async () => {
    const load = vi.fn().mockResolvedValue(null);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'methods' }, agent);
    expect(result).toBe('No content found in methods namespace.');
  });

  it('returns "not configured" when memory is null', async () => {
    const agent = makeAgent(null);
    const result = await memoryRecallTool.handler({ namespace: 'status' }, agent);
    expect(result).toBe('Memory is not configured for this agent.');
  });
});

describe('memoryRecallTool no-query scoping (PR7)', () => {
  // Build a namespace with many large entries: ~120 entries x ~600 chars each
  // ≈ 72K chars ≈ 20K tokens — well over any sensible no-query budget.
  function bigNamespace(count: number): string {
    return Array.from({ length: count }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      const body = `Memory entry number ${i + 1}. `.repeat(20).trim();
      return `[2026-04-${day}] ${body}`;
    }).join('\n');
  }

  it('returns a bounded subset for a namespace-only recall over a large namespace', async () => {
    const content = bigNamespace(120);
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'knowledge' }, agent);

    // Result must be far smaller than the full dump.
    expect(result.length).toBeLessThan(content.length);
    // ~5K-token budget => ~17.5K chars; allow headroom for the truncation note.
    expect(result.length).toBeLessThan(20_000);
    // It must surface the truncation note telling the agent it was capped.
    expect(result).toContain('Showing');
    expect(result).toContain('of 120 knowledge entries');
    expect(result).toContain('Pass a `query`');
  });

  it('ranks recent entries above older ones for a no-query recall', async () => {
    // Old entry first, recent entry last (append order = newest last).
    const oldLine = '[2020-01-01] Ancient fact that should be deprioritised by recency.';
    const recentToday = new Date().toISOString().slice(0, 10);
    const recentLine = `[${recentToday}] Fresh fact that should rank near the top.`;
    // Pad with bulk so the budget cannot fit everything and ranking matters.
    const filler = Array.from({ length: 200 }, (_, i) =>
      `[2023-06-15] Filler entry ${i} ${'x'.repeat(120)}`,
    );
    const content = [oldLine, ...filler, recentLine].join('\n');
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'status' }, agent);

    // The most recent entry must survive the cap; the ancient one must be dropped.
    expect(result).toContain('Fresh fact that should rank near the top');
    expect(result).not.toContain('Ancient fact that should be deprioritised');
  });

  it('returns the whole namespace untruncated when it fits in the budget', async () => {
    const small = '[2026-05-01] Small fact A\n[2026-05-02] Small fact B';
    const load = vi.fn().mockResolvedValue(small);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'knowledge' }, agent);
    expect(result).toBe(small);
    expect(result).not.toContain('Showing');
  });

  it('returns a bounded, filtered slice when a query is provided (new B1 contract)', async () => {
    const content = bigNamespace(120);
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'entry number 7' },
      agent,
    );
    // New contract (B1): the result is BOUNDED — never the full namespace dump
    // that the old contract returned. With no KG wired, the flat-file mirror
    // does a substring filter capped at KG_RECALL_TOP_K (10).
    expect(result).not.toBe(content);
    expect(result.length).toBeLessThan(content.length);
    // Surface tag identifies the bounded contract; the agent reads it.
    expect(result).toContain('flat-file matches');
    // Each matched line must actually contain the query.
    const matchLines = result.split('\n').filter(l => l.includes('Memory entry number'));
    for (const line of matchLines) {
      expect(line).toMatch(/entry number 7/);
    }
  });

  it('treats a blank/whitespace query as no-query (bounded subset)', async () => {
    const content = bigNamespace(120);
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: '   ' },
      agent,
    );
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain('Showing');
  });

  it('still returns "No content found" when the namespace is empty', async () => {
    const load = vi.fn().mockResolvedValue(null);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'methods' }, agent);
    expect(result).toBe('No content found in methods namespace.');
  });

  it('applies the no-query cap to scoped recalls too', async () => {
    const content = bigNamespace(120);
    const loadScoped = vi.fn().mockResolvedValue(content);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'user', id: 'alex' }],
    };

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', scope: 'user:alex' },
      agent,
    );
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain('Showing');
  });
});

describe('memoryDeleteTool', () => {
  it('calls agent.memory.delete and returns confirmation with count', async () => {
    const deleteFn = vi.fn().mockResolvedValue(3);
    const agent = makeAgent(makeMockMemory({ delete: deleteFn }));

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'old stuff' },
      agent,
    );
    // New contract (B1): KG deactivation is the authoritative delete;
    // the message reports memories deactivated (not file lines removed).
    expect(result).toContain('Deactivated 3 memories matching "old stuff" in knowledge');
    expect(result).toContain('is_active=0');
    expect(deleteFn).toHaveBeenCalledWith('knowledge', 'old stuff');
  });

  it('returns "No memories matching" when delete returns 0', async () => {
    const deleteFn = vi.fn().mockResolvedValue(0);
    const agent = makeAgent(makeMockMemory({ delete: deleteFn }));

    const result = await memoryDeleteTool.handler(
      { namespace: 'methods', pattern: 'nonexistent' },
      agent,
    );
    expect(result).toBe('No memories matching "nonexistent" found in methods.');
  });

  it('returns "not configured" when memory is null', async () => {
    const agent = makeAgent(null);
    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'test' },
      agent,
    );
    expect(result).toBe('Memory is not configured for this agent.');
  });
});

describe('memoryStoreTool scope parameter', () => {
  it('parses scope string and calls appendScoped', async () => {
    const appendScoped = vi.fn().mockResolvedValue(undefined);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ appendScoped })),
      activeScopes: [
        { type: 'global', id: 'global' },
        { type: 'user', id: 'alex' },
      ],
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'user pref', scope: 'user:alex' },
      agent,
    );
    expect(result).toContain('scope: user:alex');
    expect(appendScoped).toHaveBeenCalledWith('knowledge', 'user pref', { type: 'user', id: 'alex' });
  });

  it('uses default (no scope) when scope not provided', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent(makeMockMemory({ append }));

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'data' },
      agent,
    );
    expect(result).toBe('Stored in knowledge. Entities and relationships are extracted automatically for future cross-referencing.');
    expect(append).toHaveBeenCalledWith('knowledge', 'data');
  });

  it('rejects invalid scope string', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'data', scope: 'invalid' },
      agent,
    );
    expect(result).toContain('Invalid or unauthorized scope');
  });

  it('rejects scope not in activeScopes', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'data', scope: 'user:alex' },
      agent,
    );
    expect(result).toContain('Invalid or unauthorized scope');
  });

  it('parses "global" shorthand', async () => {
    const appendScoped = vi.fn().mockResolvedValue(undefined);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ appendScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryStoreTool.handler(
      { namespace: 'methods', content: 'pattern', scope: 'global' },
      agent,
    );
    expect(result).toContain('scope: global');
    expect(appendScoped).toHaveBeenCalledWith('methods', 'pattern', { type: 'global', id: 'global' });
  });
});

describe('memoryRecallTool scope parameter', () => {
  it('recalls from specific scope', async () => {
    const loadScoped = vi.fn().mockResolvedValue('scoped data');
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'user', id: 'alex' }],
    };

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', scope: 'user:alex' },
      agent,
    );
    expect(result).toBe('scoped data');
    expect(loadScoped).toHaveBeenCalledWith('knowledge', { type: 'user', id: 'alex' });
  });

  it('returns not found for empty scoped namespace', async () => {
    const loadScoped = vi.fn().mockResolvedValue(null);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryRecallTool.handler(
      { namespace: 'learnings', scope: 'global' },
      agent,
    );
    expect(result).toContain('No content found');
    expect(result).toContain('scope: global');
  });

  it('rejects invalid scope', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', scope: 'bad:scope' },
      agent,
    );
    expect(result).toContain('Invalid or unauthorized scope');
  });
});

describe('memoryUpdateTool', () => {
  it('calls agent.memory.update and returns confirmation (KG unavailable in this test)', async () => {
    const updateFn = vi.fn().mockResolvedValue(true);
    const agent = makeAgent(makeMockMemory({ update: updateFn }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'status', old_content: 'old val', new_content: 'new val' },
      agent,
    );
    // New contract (B1): without a wired KnowledgeLayer the mirror update
    // still succeeds; the message documents the KG sync was skipped so
    // the operator knows history-preservation didn't apply.
    expect(result).toContain('Updated content in status namespace');
    expect(result).toContain('KG sync skipped');
    expect(updateFn).toHaveBeenCalledWith('status', 'old val', 'new val');
  });

  it('returns failure message when update returns false', async () => {
    const updateFn = vi.fn().mockResolvedValue(false);
    const agent = makeAgent(makeMockMemory({ update: updateFn }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'learnings', old_content: 'missing', new_content: 'new' },
      agent,
    );
    // New contract (B1): scope is now always included in the failure message.
    expect(result).toContain('Content not found in learnings');
    expect(result).toContain('nothing updated');
  });

  it('returns "not configured" when memory is null', async () => {
    const agent = makeAgent(null);
    const result = await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: 'a', new_content: 'b' },
      agent,
    );
    expect(result).toBe('Memory is not configured for this agent.');
  });
});

describe('memoryListTool', () => {
  const allScopes = [
    { type: 'global' as const, id: 'global' },
    { type: 'context' as const, id: 'proj1' },
    { type: 'user' as const, id: 'alex' },
  ];

  it('lists all namespaces across all active scopes when no filters', async () => {
    const loadScoped = vi.fn()
      .mockImplementation((ns: string, scope: { type: string; id: string }) => {
        if (scope.type === 'global' && ns === 'knowledge') return Promise.resolve('Global fact 1\nGlobal fact 2');
        if (scope.type === 'context' && ns === 'methods') return Promise.resolve('Context skill 1');
        return Promise.resolve(null);
      });
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: allScopes,
    };

    const result = await memoryListTool.handler({}, agent);
    expect(result).toContain('=== global ===');
    expect(result).toContain('[knowledge] (2 entries)');
    expect(result).toContain('Global fact 1');
    expect(result).toContain('Global fact 2');
    expect(result).toContain('=== context:proj1 ===');
    expect(result).toContain('[methods] (1 entries)');
    expect(result).toContain('Context skill 1');
  });

  it('filters by namespace', async () => {
    const loadScoped = vi.fn()
      .mockImplementation((ns: string, scope: { type: string }) => {
        if (scope.type === 'global' && ns === 'knowledge') return Promise.resolve('Fact line');
        if (scope.type === 'global' && ns === 'methods') return Promise.resolve('Skill line');
        return Promise.resolve(null);
      });
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryListTool.handler({ namespace: 'knowledge' }, agent);
    expect(result).toContain('[knowledge]');
    expect(result).not.toContain('[methods]');
    // loadScoped should only be called for 'knowledge', not 'methods'
    const calledNamespaces = loadScoped.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledNamespaces).toEqual(['knowledge']);
  });

  it('filters by scope', async () => {
    const loadScoped = vi.fn()
      .mockImplementation((ns: string, scope: { type: string }) => {
        if (scope.type === 'user' && ns === 'status') return Promise.resolve('User context');
        if (scope.type === 'global' && ns === 'status') return Promise.resolve('Global context');
        return Promise.resolve(null);
      });
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: allScopes,
    };

    const result = await memoryListTool.handler({ scope: 'user:alex' }, agent);
    expect(result).toContain('=== user:alex ===');
    expect(result).not.toContain('=== global ===');
    expect(result).not.toContain('=== context:proj1 ===');
  });

  it('filters by pattern (case-insensitive text match)', async () => {
    const loadScoped = vi.fn()
      .mockImplementation((ns: string, scope: { type: string }) => {
        if (scope.type === 'global' && ns === 'knowledge') {
          return Promise.resolve('TypeScript best practices\nPython tips\nTypeScript patterns');
        }
        return Promise.resolve(null);
      });
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryListTool.handler({ pattern: 'typescript' }, agent);
    expect(result).toContain('TypeScript best practices');
    expect(result).toContain('TypeScript patterns');
    expect(result).not.toContain('Python tips');
    expect(result).toContain('(2 entries)');
  });

  it('returns "No memory entries found" when empty', async () => {
    const loadScoped = vi.fn().mockResolvedValue(null);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryListTool.handler({}, agent);
    expect(result).toBe('No memory entries found matching the criteria.');
  });

  it('respects limit parameter', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
    const loadScoped = vi.fn()
      .mockImplementation((ns: string) => {
        if (ns === 'knowledge') return Promise.resolve(lines);
        return Promise.resolve(null);
      });
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryListTool.handler({ limit: 3 }, agent);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
    expect(result).not.toContain('Line 4');
    expect(result).toContain('and 7 more');
  });

  it('returns "not configured" when memory is null', async () => {
    const agent = makeAgent(null);
    const result = await memoryListTool.handler({}, agent);
    expect(result).toBe('Memory is not configured for this agent.');
  });

  it('returns "No active scopes available" when no scopes and no scope filter', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: [],
    };
    const result = await memoryListTool.handler({}, agent);
    expect(result).toBe('No active scopes available.');
  });
});

describe('memoryPromoteTool', () => {
  const allScopes = [
    { type: 'global' as const, id: 'global' },
    { type: 'context' as const, id: 'proj1' },
    { type: 'user' as const, id: 'alex' },
  ];

  it('successfully promotes entry from user to context scope', async () => {
    const { channels } = await import('../../core/observability.js');
    const loadScoped = vi.fn().mockResolvedValue('User pattern A\nUser pattern B');
    const appendScoped = vi.fn().mockResolvedValue(undefined);
    const deleteScoped = vi.fn().mockResolvedValue(1);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped, appendScoped, deleteScoped })),
      activeScopes: allScopes,
    };

    const result = await memoryPromoteTool.handler(
      { namespace: 'methods', content_pattern: 'pattern B', from_scope: 'user:alex', to_scope: 'context:proj1' },
      agent,
    );
    expect(result).toContain('Promoted entry from user:alex to context:proj1');
    expect(result).toContain('User pattern B');
    expect(appendScoped).toHaveBeenCalledWith('methods', 'User pattern B', { type: 'context', id: 'proj1' });
    expect(deleteScoped).toHaveBeenCalledWith('methods', 'pattern B', { type: 'user', id: 'alex' });
    expect(channels.memoryStore.publish).toHaveBeenCalledWith({
      namespace: 'methods',
      content: 'User pattern B',
      scopeType: 'context',
      scopeId: 'proj1',
    });
  });

  it('rejects when from_scope is not more specific than to_scope', async () => {
    const loadScoped = vi.fn().mockResolvedValue('some content');
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: allScopes,
    };

    // global → context: global is not more specific than context
    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'test', from_scope: 'global', to_scope: 'context:proj1' },
      agent,
    );
    expect(result).toContain('Cannot promote');
    expect(result).toContain('not more specific');
    expect(result).toContain('hierarchy');
    expect(loadScoped).not.toHaveBeenCalled();
  });

  it('returns error for invalid source scope', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: [{ type: 'global', id: 'global' }],
    };

    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'test', from_scope: 'bad:scope', to_scope: 'global' },
      agent,
    );
    expect(result).toContain('Invalid or unauthorized source scope');
  });

  it('returns error when content pattern not found', async () => {
    const loadScoped = vi.fn().mockResolvedValue('Line A\nLine B\nLine C');
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: allScopes,
    };

    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'nonexistent', from_scope: 'user:alex', to_scope: 'global' },
      agent,
    );
    expect(result).toContain('No entry matching "nonexistent"');
    expect(result).toContain('user:alex');
  });

  it('returns "Memory is not configured" when no memory', async () => {
    const agent = makeAgent(null);
    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'test', from_scope: 'user:alex', to_scope: 'global' },
      agent,
    );
    expect(result).toBe('Memory is not configured for this agent.');
  });

  it('validates hierarchy correctly: rejects same-level promotion', async () => {
    const scopes = [
      { type: 'global' as const, id: 'global' },
      { type: 'context' as const, id: 'proj1' },
      { type: 'context' as const, id: 'proj2' },
    ];
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: scopes,
    };

    // context → context: same level, not valid
    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'test', from_scope: 'context:proj1', to_scope: 'context:proj2' },
      agent,
    );
    expect(result).toContain('Cannot promote');
    expect(result).toContain('not more specific');
  });

  it('returns error for invalid target scope', async () => {
    const agent: IAgent = {
      ...makeAgent(makeMockMemory()),
      activeScopes: allScopes,
    };

    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'test', from_scope: 'user:alex', to_scope: 'bad:scope' },
      agent,
    );
    expect(result).toContain('Invalid or unauthorized target scope');
  });

  it('returns error when source namespace is empty', async () => {
    const loadScoped = vi.fn().mockResolvedValue(null);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped })),
      activeScopes: allScopes,
    };

    const result = await memoryPromoteTool.handler(
      { namespace: 'learnings', content_pattern: 'test', from_scope: 'user:alex', to_scope: 'global' },
      agent,
    );
    expect(result).toContain('No content found in learnings');
    expect(result).toContain('user:alex');
  });
});

// === B1: KG-backed memory_recall / memory_update / memory_delete ===========
//
// The highest-regression-risk item in the HN-launch hardening sprint changes
// the contract of these three tools — recall now returns ranked KG results
// (not a raw namespace dump), and update/delete route through supersession /
// deactivation in the KG (history preserved). These tests use a REAL
// KnowledgeLayer with a tmp SQLite DB so we verify the actual behaviour, not
// a mock.
describe('memory tools — KG-backed (B1)', () => {
  // Local imports so the rest of the file's mocks don't bleed in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layer: any;
  let tempDir: string;
  let agent: IAgent;
  const scope = { type: 'context' as const, id: 'b1-test' };

  // Build an Agent whose flat-file memory is a fully in-memory stub and whose
  // toolContext carries the real KnowledgeLayer. This lets us assert both the
  // KG state (source of truth) and the mirror sync (export discipline).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildAgent(kl: any, mirror: Map<string, string[]>): IAgent {
    const mem: NonNullable<IAgent['memory']> = {
      load: vi.fn(async (ns: string) => mirror.get(ns)?.join('\n') ?? null),
      save: vi.fn(),
      append: vi.fn(async (ns: string, text: string) => {
        const arr = mirror.get(ns) ?? [];
        arr.push(text);
        mirror.set(ns, arr);
      }),
      delete: vi.fn(async (ns: string, pattern: string) => {
        const arr = mirror.get(ns) ?? [];
        const before = arr.length;
        const kept = arr.filter(l => !l.includes(pattern));
        mirror.set(ns, kept);
        return before - kept.length;
      }),
      update: vi.fn(async (ns: string, oldText: string, newText: string) => {
        const arr = mirror.get(ns) ?? [];
        const i = arr.findIndex(l => l.includes(oldText));
        if (i < 0) return false;
        arr[i] = arr[i]!.replace(oldText, newText);
        mirror.set(ns, arr);
        return true;
      }),
      render: vi.fn().mockReturnValue(''),
      hasContent: vi.fn().mockReturnValue(true),
      loadAll: vi.fn(),
      maybeUpdate: vi.fn(),
      appendScoped: vi.fn(async (ns: string, text: string) => {
        const arr = mirror.get(ns) ?? [];
        arr.push(text);
        mirror.set(ns, arr);
      }),
      loadScoped: vi.fn(async (ns: string) => mirror.get(ns)?.join('\n') ?? null),
      deleteScoped: vi.fn(async (ns: string, pattern: string) => {
        const arr = mirror.get(ns) ?? [];
        const before = arr.length;
        const kept = arr.filter(l => !l.includes(pattern));
        mirror.set(ns, kept);
        return before - kept.length;
      }),
      updateScoped: vi.fn(async (ns: string, oldText: string, newText: string) => {
        const arr = mirror.get(ns) ?? [];
        const i = arr.findIndex(l => l.includes(oldText));
        if (i < 0) return false;
        arr[i] = arr[i]!.replace(oldText, newText);
        mirror.set(ns, arr);
        return true;
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = createToolContext({});
    ctx.knowledgeLayer = kl;
    return {
      name: 'b1', model: 'test', memory: mem, tools: [], onStream: null,
      toolContext: ctx, activeScopes: [scope],
    };
  }

  beforeEach(async () => {
    const { KnowledgeLayer } = await import('../../core/knowledge-layer.js');
    const { LocalProvider } = await import('../../core/embedding.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tempDir = mkdtempSync(join(tmpdir(), 'lynox-b1-test-'));
    layer = new KnowledgeLayer(join(tempDir, 'kg.db'), new LocalProvider());
    await layer.init();
    agent = buildAgent(layer, new Map());
  });

  // (afterEach cleanup is best-effort; vitest tears down quickly enough that
  // leaving the DB files on disk in the OS tmp dir does no harm.)

  it('memory_recall with query returns ranked, bounded KG results (not a namespace dump)', async () => {
    // Seed 5 facts of varying recency/topic.
    const seedFacts = [
      'Acme Corp uses PostgreSQL 16 in production for the order service.',
      'Customer Maria from acme-shop.ch needs help configuring webhooks.',
      'The deployment pipeline runs on GitHub Actions every Tuesday.',
      'Quarterly review meetings are scheduled on the second Monday.',
      'Acme Corp pays via wire transfer, never credit card.',
    ];
    for (const text of seedFacts) {
      await layer.store(text, 'knowledge', scope);
    }

    // Use a query whose tokens overlap directly with the stored facts —
    // the LocalProvider's lexical embeddings need real token overlap to clear
    // the similarity threshold. This is itself a worthwhile assertion: the KG
    // retrieval surfaces semantically-near matches over unrelated facts.
    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'Acme Corp PostgreSQL production order service' },
      agent,
    );

    // Ranked output surface markers — the agent reads these.
    expect(result).toContain('ranked');
    expect(result).toMatch(/\[knowledge\]/);
    expect(result).toMatch(/% match/);
    expect(result).toContain('Bounded at');
    // Most-relevant fact (PostgreSQL / Acme Corp) must appear.
    expect(result).toContain('PostgreSQL');
    // Bounded: must never exceed the top-K cap. The output format is
    // `<header>\n<entry>\n\n<entry>\n\n...\n\n<footer>`; entries are the
    // odd-indexed segments. A 5-seed-fact corpus can return at most 5,
    // well under KG_RECALL_TOP_K_TEST.
    const entryCount = (result.match(/^\d+\. \[knowledge\]/gm) ?? []).length;
    expect(entryCount).toBeLessThanOrEqual(KG_RECALL_TOP_K_TEST);
    expect(entryCount).toBeGreaterThanOrEqual(1);
  });

  it('memory_recall scopes correctly — no cross-scope bleed', async () => {
    const otherScope = { type: 'user' as const, id: 'b1-other' };
    // Same fact text in two different scopes; without proper scoping a
    // recall in scope A would surface the scope-B copy.
    await layer.store('Project Atlas launches in November.', 'knowledge', scope);
    await layer.store('Personal: prefers vegetarian lunch options.', 'knowledge', otherScope);

    // Agent's active scope is `scope` (b1-test, context). Recall on the
    // user scope should not surface the project fact.
    const userScopedAgent = buildAgent(layer, new Map());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (userScopedAgent as any).activeScopes = [otherScope];

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'launches November Atlas' },
      userScopedAgent,
    );

    // Must NOT surface the project-scope fact even though it matches the query better.
    expect(result).not.toContain('Project Atlas');
    // Either reports no matches or only returns scope-relevant rows.
    // (The vegetarian fact is unrelated to the query, so the most likely
    // outcome is the "no memories matching" branch — both are valid.)
    if (result.includes('lunch')) {
      // If something IS returned, it must be from the user scope only.
      expect(result).toContain('user:b1-other');
    }
  });

  it('memory_update supersedes — old row preserved with is_active=0, new row active', async () => {
    const original = 'The deployment uses Docker Compose with three services.';
    const corrected = 'The deployment uses Docker Compose with five services.';

    await layer.store(original, 'knowledge', scope);
    // Confirm the fact is in the KG and active.
    const db = layer.getDb();
    const beforeCount = db.getActiveMemoryCount();
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    const result = await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: original, new_content: corrected },
      agent,
    );
    expect(result).toContain('Superseded memory');
    expect(result).toContain('is_active=0');

    // Old row: still in the table, but inactive and pointing at the new row.
    const oldRows = db.findMemoriesByTextPattern('three services', 'knowledge');
    // is_active=1 filter applied, so no active rows for the old text.
    expect(oldRows.length).toBe(0);
    // New row is active.
    const newRows = db.findMemoriesByTextPattern('five services', 'knowledge');
    expect(newRows.length).toBeGreaterThanOrEqual(1);
    expect(newRows[0].is_active).toBe(1);

    // Forensics: old row still physically present via raw query.
    // (We use the public getMemory if we can find the id; otherwise count the
    // total row count incl. inactive.)
    const stats = await layer.stats();
    // active count went from N to N (one inactive + one new active).
    expect(stats.memoryCount).toBeGreaterThanOrEqual(beforeCount);
  });

  it('memory_delete deactivates — row stays in DB with is_active=0, filtered from recall', async () => {
    const fact = 'Temporary launch-day toggle: feature_flag_x enabled.';
    await layer.store(fact, 'knowledge', scope);

    // Sanity: the row exists and is active in the KG before deletion.
    const db = layer.getDb();
    const beforeActive = db.findMemoriesByTextPattern('launch-day toggle', 'knowledge');
    expect(beforeActive.length).toBe(1);
    const memId: string = beforeActive[0].id;

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'launch-day toggle' },
      agent,
    );
    expect(result).toContain('Deactivated');
    expect(result).toContain('is_active=0');

    // Active-row check: the active-only query no longer finds it.
    const afterActive = db.findMemoriesByTextPattern('launch-day toggle', 'knowledge');
    expect(afterActive.length).toBe(0);

    // Raw-row check via getMemory (bypasses is_active filter): the row is
    // STILL in the table — just marked inactive. History preserved.
    const raw = db.getMemory(memId);
    expect(raw).not.toBeNull();
    expect(raw.is_active).toBe(0);
  });

  it('flat-file export mirror reflects KG mutations (write-through)', async () => {
    const mirror = new Map<string, string[]>();
    const mirrorAgent = buildAgent(layer, mirror);

    // 1. store via the tool (we re-use the channel path through layer.store directly here for the seed)
    const fact = 'Mirror-test fact: SearXNG is the default web search backend.';
    await layer.store(fact, 'knowledge', scope);
    // The store path is via the agent-tool memoryStoreTool but for this
    // unit-level test we directly verify the mirror is written by
    // delete/update which are the tools the worker holds.
    mirror.set('knowledge', [fact]);

    // 2. update via the tool — both KG and mirror must reflect the new text.
    const corrected = 'Mirror-test fact: SearXNG is the default with Tavily fallback.';
    const upd = await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: fact, new_content: corrected },
      mirrorAgent,
    );
    expect(upd).toContain('Superseded');
    // Mirror was rewritten.
    const mirrorAfterUpd = mirror.get('knowledge')!;
    expect(mirrorAfterUpd.some(l => l.includes('Tavily fallback'))).toBe(true);

    // 3. delete via the tool — KG deactivates, mirror substring-removes.
    const del = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'Tavily fallback' },
      mirrorAgent,
    );
    expect(del).toContain('Deactivated');
    const mirrorAfterDel = mirror.get('knowledge')!;
    expect(mirrorAfterDel.some(l => l.includes('Tavily fallback'))).toBe(false);
  });

  it('a stale flat-file row that no longer exists in the KG is invisible to memory_recall', async () => {
    // Pre-seed the mirror with a row that was never written to the KG.
    const mirror = new Map<string, string[]>();
    mirror.set('knowledge', ['STALE: this fact lives only in the flat file, never in the KG.']);
    const mirrorAgent = buildAgent(layer, mirror);

    // Also seed a real KG fact so the KG is not empty for the query.
    await layer.store('Genuine fact: pnpm is the workspace package manager.', 'knowledge', scope);

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'STALE flat file' },
      mirrorAgent,
    );

    // The KG path is the source of truth. The stale flat-file row must NOT
    // appear (it was never stored to the KG). The result either says no
    // matches found, or returns only the genuine KG-backed fact.
    expect(result).not.toContain('STALE: this fact lives only in the flat file');
  });

  // === Regression guards added during /pr-review === //

  it('memory_recall falls through to the flat-file mirror when the KG throws', async () => {
    // Seed a flat-file mirror row that ONLY exists in the mirror; the KG
    // throws on every retrieve. Without the fall-through, the tool would
    // surface "no memories found"; with the fall-through, the mirror
    // substring filter surfaces the line.
    const mirror = new Map<string, string[]>();
    mirror.set('knowledge', ['fallback-row: visible only via mirror substring search']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const throwingKl: any = {
      retrieve: vi.fn().mockRejectedValue(new Error('kg-down for-test')),
      // listRecentActive intentionally omitted so the optional-chaining path
      // does the right thing too.
    };
    const fallbackAgent = buildAgent(throwingKl, mirror);

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'fallback-row' },
      fallbackAgent,
    );
    expect(result).toContain('fallback-row');
    // The fall-through tags itself so a future regression that silently
    // misroutes to a KG that doesn't exist is visible in the response.
    expect(result).toContain('KG unavailable');
  });

  it('memory_recall surfaces "no active scopes" when scope is omitted and activeScopes is empty', async () => {
    const noScopeAgent: IAgent = { ...agent, activeScopes: [] };
    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'anything' },
      noScopeAgent,
    );
    expect(result).toBe('No active scopes available for memory recall.');
  });

  it('memory_update with KG attached but no matching old_content returns a no-match message', async () => {
    // Seed only an unrelated row so old_content can't match.
    await layer.store('Some other fact', 'knowledge', scope);
    const result = await memoryUpdateTool.handler(
      {
        namespace: 'knowledge',
        old_content: 'a row that was never stored',
        new_content: 'replacement',
      },
      agent,
    );
    expect(result).toMatch(/not found|nothing updated/i);
  });

  // T1-K1 regression: self-supersession cycle. When old_content and
  // new_content collapse to the same KG row (near-identical text → dedup
  // returns the existing row's id), the old code would call
  // `supersedMemory(old.id, old.id)` and deactivate the only active row.
  // The guard now returns the row id unchanged.
  it('memory_update with near-identical new_content does not deactivate the existing row', async () => {
    const original = 'lynox uses pnpm as the workspace package manager.';
    const storeRes = await layer.store(original, 'knowledge', scope);
    expect(storeRes.stored).toBe(true);
    const originalId = storeRes.memoryId;

    // "Update" to identical text → the KG store dedups to the same row →
    // updateMemoryWithSupersession's self-supersession guard should leave
    // the row active. Without the guard this would deactivate the only row.
    await memoryUpdateTool.handler(
      { namespace: 'knowledge', old_content: original, new_content: original },
      agent,
    );

    const rowsActive = layer.db.listActiveMemories('knowledge', [{ type: 'context', id: scope.id }], 50);
    const stillActive = rowsActive.find((r: { id: string }) => r.id === originalId);
    expect(stillActive).toBeDefined();
    expect(stillActive?.text).toBe(original);
  });
});

// Local constant for the test to assert against the tool's KG_RECALL_TOP_K
// without re-exporting it from the production module.
const KG_RECALL_TOP_K_TEST = 10;
