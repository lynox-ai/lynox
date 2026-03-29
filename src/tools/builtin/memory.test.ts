import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryStoreTool, memoryRecallTool, memoryDeleteTool, memoryUpdateTool, memoryListTool, memoryPromoteTool } from './memory.js';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

vi.mock('../../core/observability.js', () => ({
  channels: {
    memoryStore: { publish: vi.fn() },
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

describe('memoryDeleteTool', () => {
  it('calls agent.memory.delete and returns confirmation with count', async () => {
    const deleteFn = vi.fn().mockResolvedValue(3);
    const agent = makeAgent(makeMockMemory({ delete: deleteFn }));

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'old stuff' },
      agent,
    );
    expect(result).toBe('Removed 3 line(s) matching "old stuff" from knowledge.');
    expect(deleteFn).toHaveBeenCalledWith('knowledge', 'old stuff');
  });

  it('returns "No lines matching" when delete returns 0', async () => {
    const deleteFn = vi.fn().mockResolvedValue(0);
    const agent = makeAgent(makeMockMemory({ delete: deleteFn }));

    const result = await memoryDeleteTool.handler(
      { namespace: 'methods', pattern: 'nonexistent' },
      agent,
    );
    expect(result).toBe('No lines matching "nonexistent" found in methods.');
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
  it('calls agent.memory.update and returns confirmation', async () => {
    const updateFn = vi.fn().mockResolvedValue(true);
    const agent = makeAgent(makeMockMemory({ update: updateFn }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'status', old_content: 'old val', new_content: 'new val' },
      agent,
    );
    expect(result).toBe('Updated content in status namespace.');
    expect(updateFn).toHaveBeenCalledWith('status', 'old val', 'new val');
  });

  it('returns failure message when update returns false', async () => {
    const updateFn = vi.fn().mockResolvedValue(false);
    const agent = makeAgent(makeMockMemory({ update: updateFn }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'learnings', old_content: 'missing', new_content: 'new' },
      agent,
    );
    expect(result).toBe('Content not found in learnings — nothing updated.');
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
