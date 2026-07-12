import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryStoreTool, memoryRecallTool, memoryDeleteTool, memoryUpdateTool, memoryListTool, memoryPromoteTool } from './memory.js';
import type { IAgent, IKnowledgeLayer } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

/** A KG stub exposing only the two delete-path methods the memory tools call. */
function makeKg(overrides: Partial<Pick<IKnowledgeLayer, 'eraseByPattern' | 'deactivateByPattern'>> = {}): IKnowledgeLayer {
  return {
    eraseByPattern: vi.fn(async () => 0),
    deactivateByPattern: vi.fn(async () => 0),
    ...overrides,
  } as unknown as IKnowledgeLayer;
}

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
      sourceChannel: 'agent',
    });
  });

  it('force-floors the tier to agent_inferred — an agent cannot self-declare provenance (Wave 0.6, §2.8)', async () => {
    const { channels } = await import('../../core/observability.js');
    const append = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent(makeMockMemory({ append }));

    // Even if a caller smuggles a sourceType — the removed self-declare param, or
    // injected content instructing the agent to claim the tier the system prompt
    // trusts most — the tool publishes agent_inferred. The §2.8 privilege
    // escalation is closed: provenance is no longer agent-declarable.
    await memoryStoreTool.handler(
      { namespace: 'knowledge', content: 'the user told me their budget', sourceType: 'user_asserted' } as unknown as Parameters<typeof memoryStoreTool.handler>[0],
      agent,
    );
    expect(channels.memoryStore.publish).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'the user told me their budget', sourceChannel: 'agent' }),
    );
  });

  it('memory_store and memory_update no longer expose a sourceType/sourceToolName parameter (Wave 0.6)', () => {
    const storeProps = (memoryStoreTool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(storeProps).not.toHaveProperty('sourceType');
    expect(storeProps).not.toHaveProperty('sourceToolName');
    const updateProps = (memoryUpdateTool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(updateProps).not.toHaveProperty('sourceType');
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

describe('memoryRecallTool no-query scoping', () => {
  // Build a namespace large enough to bust the 20K-token no-query budget.
  // ~600 entries × ~600 chars each ≈ 360K chars ≈ 90K tokens.
  function bigNamespace(count: number): string {
    return Array.from({ length: count }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      const body = `Memory entry number ${i + 1}. `.repeat(20).trim();
      return `[2026-04-${day}] ${body}`;
    }).join('\n');
  }

  it('returns a bounded subset for a namespace-only recall over a large namespace', async () => {
    const content = bigNamespace(600);
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler({ namespace: 'knowledge' }, agent);

    // Result must be far smaller than the full dump.
    expect(result.length).toBeLessThan(content.length);
    // 20K-token budget = ~80K chars; allow headroom for the truncation note.
    expect(result.length).toBeLessThan(85_000);
    // It must surface the truncation note telling the agent it was capped.
    expect(result).toContain('Showing');
    expect(result).toContain('of 600 knowledge entries');
    expect(result).toContain('Pass a `query`');
  });

  it('ranks recent entries above older ones for a no-query recall', async () => {
    // Old entry first, recent entry last (append order = newest last).
    const oldLine = '[2020-01-01] Ancient fact that should be deprioritised by recency.';
    const recentToday = new Date().toISOString().slice(0, 10);
    const recentLine = `[${recentToday}] Fresh fact that should rank near the top.`;
    // Pad with bulk so the budget cannot fit everything and ranking matters.
    // ~800 fillers × ~250 chars = ~200K chars ≈ 50K tokens (well over 20K budget).
    const filler = Array.from({ length: 800 }, (_, i) =>
      `[2023-06-15] Filler entry ${i} ${'x'.repeat(200)}`,
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

  it('returns matching lines via substring filter when a query is provided (post-revert)', async () => {
    const content = bigNamespace(120);
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'entry number 7' },
      agent,
    );
    // Post-revert contract: substring filter over the namespace, bounded by
    // the query-path token budget. With only ~12 matches ("entry number 7",
    // "entry number 70..79", "entry number 7." occurring in entry 7), all fit
    // in the budget and no tail-note is added.
    expect(result).not.toBe(content);
    expect(result.length).toBeLessThan(content.length);
    // Each line in the result must actually contain the query substring.
    const lines = result.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('['));
    // (skip the optional [Showing N of M ...] tail-note line)
    for (const line of lines) {
      expect(line.toLowerCase()).toContain('entry number 7');
    }
  });

  it('treats a blank/whitespace query as no-query (bounded subset)', async () => {
    const content = bigNamespace(600);
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
    const content = bigNamespace(600);
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
    // Post-revert: substring delete from the flat-file mirror.
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

  it('SOFT-deactivates the KG (curation, recoverable) — never the hard erase', async () => {
    // The agent tool is least-privilege: it deactivates (is_active = 0), it must NOT
    // call the irreversible eraseByPattern — that is the human-gated UI path only.
    const deactivate = vi.fn().mockResolvedValue(2);
    const erase = vi.fn();
    const agent = makeAgent(makeMockMemory({ delete: vi.fn().mockResolvedValue(2) }));
    agent.toolContext.knowledgeLayer = makeKg({ deactivateByPattern: deactivate, eraseByPattern: erase });

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'old stuff' },
      agent,
    );
    expect(deactivate).toHaveBeenCalledWith('old stuff', 'knowledge');
    expect(erase).not.toHaveBeenCalled();
    expect(result).toBe('Removed 2 entries matching "old stuff" from knowledge.');
  });

  it('deactivates the KG UNCONDITIONALLY — even when the flat-file matched 0 lines (document-ingest rows)', async () => {
    const deactivate = vi.fn().mockResolvedValue(2);
    const agent = makeAgent(makeMockMemory({ delete: vi.fn().mockResolvedValue(0) }));
    agent.toolContext.knowledgeLayer = makeKg({ deactivateByPattern: deactivate });

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'ingested doc fact' },
      agent,
    );
    // The old `if (count > 0)` gate skipped the KG for these rows; now it runs on a
    // 0-line flat-file match and the count falls back to the KG (not "nothing found").
    expect(deactivate).toHaveBeenCalledWith('ingested doc fact', 'knowledge');
    expect(result).toBe('Removed 2 entries matching "ingested doc fact" from knowledge.');
  });

  it('uses the singular "entry" for a single removed memory', async () => {
    const agent = makeAgent(makeMockMemory({ delete: vi.fn().mockResolvedValue(1) }));
    agent.toolContext.knowledgeLayer = makeKg({ deactivateByPattern: vi.fn().mockResolvedValue(1) });

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'one thing' },
      agent,
    );
    expect(result).toBe('Removed 1 entry matching "one thing" from knowledge.');
  });

  it('passes the scope through to the flat-file delete and labels the message', async () => {
    const deleteScoped = vi.fn().mockResolvedValue(1);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ deleteScoped })),
      activeScopes: [{ type: 'user', id: 'alex' }],
    };
    agent.toolContext.knowledgeLayer = makeKg({ deactivateByPattern: vi.fn().mockResolvedValue(1) });

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'personal fact', scope: 'user:alex' },
      agent,
    );
    expect(deleteScoped).toHaveBeenCalledWith('knowledge', 'personal fact', { type: 'user', id: 'alex' });
    expect(result).toBe('Removed 1 entry matching "personal fact" from knowledge (scope: user:alex).');
  });

  it('refuses an empty/whitespace pattern (would substring-match every line)', async () => {
    const deleteFn = vi.fn();
    const agent = makeAgent(makeMockMemory({ delete: deleteFn }));
    agent.toolContext.knowledgeLayer = makeKg();

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: '   ' },
      agent,
    );
    expect(result).toBe('A non-empty pattern is required to delete.');
    expect(deleteFn).not.toHaveBeenCalled(); // never reached the store
  });

  it('reports a partial failure (NOT success) when the recall-mirror reap throws', async () => {
    const deactivate = vi.fn().mockRejectedValue(new Error('engine.db locked'));
    const agent = makeAgent(makeMockMemory({ delete: vi.fn().mockResolvedValue(1) }));
    agent.toolContext.knowledgeLayer = makeKg({ deactivateByPattern: deactivate });

    const result = await memoryDeleteTool.handler(
      { namespace: 'knowledge', pattern: 'stubborn fact' },
      agent,
    );
    // A swallowed reap failure would leave the content recallable — the tool must own up.
    expect(result).toContain('recall mirror could not be updated');
    expect(result).not.toContain('Removed 1');
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
  it('calls agent.memory.update and returns confirmation on exact-substring hit', async () => {
    const updateFn = vi.fn().mockResolvedValue(true);
    const agent = makeAgent(makeMockMemory({ update: updateFn }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'status', old_content: 'old val', new_content: 'new val' },
      agent,
    );
    expect(result).toBe('Updated content in status namespace.');
    expect(updateFn).toHaveBeenCalledWith('status', 'old val', 'new val');
  });

  it('falls back to [SUPERSEDED] marker + append when exact-substring update returns false', async () => {
    // No exact match → falls into the fallback. The mock load returns a line
    // with high token overlap so the fuzzy heuristic marks it.
    const store: string[] = ['important fact about ProjectAlpha launch in November'];
    const load = vi.fn(async () => store.join('\n'));
    const update = vi.fn(async () => false);
    const deleteFn = vi.fn(async (_ns: string, pattern: string) => {
      const i = store.findIndex(l => l.includes(pattern));
      if (i < 0) return 0;
      store.splice(i, 1);
      return 1;
    });
    const append = vi.fn(async (_ns: string, text: string) => {
      store.push(text);
    });
    const agent = makeAgent(makeMockMemory({ load, update, delete: deleteFn, append }));

    const result = await memoryUpdateTool.handler(
      { namespace: 'learnings', old_content: 'ProjectAlpha launch November', new_content: 'ProjectAlpha launch postponed to December' },
      agent,
    );
    // Either marked a line + appended, or just appended honestly — never the
    // pre-revert "nothing updated" silent failure.
    expect(result).toMatch(/Superseded|Appended new content/);
    expect(store).toContain('ProjectAlpha launch postponed to December');
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
    // F4: deletes EXACTLY the promoted line ({exact:true}), not the substring pattern
    // (which would also erase sibling matches that were never promoted).
    expect(deleteScoped).toHaveBeenCalledWith('methods', 'User pattern B', { type: 'user', id: 'alex' }, { exact: true });
    expect(channels.memoryStore.publish).toHaveBeenCalledWith({
      namespace: 'methods',
      content: 'User pattern B',
      scopeType: 'context',
      scopeId: 'proj1',
      sourceChannel: 'agent',
    });
  });

  it('F4: promotes ONE line but does not substring-delete sibling matches from the source', async () => {
    // Two lines both contain the pattern "secret"; only the first-matched line is
    // promoted, so only IT may be removed from the source (the old substring delete
    // erased both — silent data loss of the un-promoted sibling).
    const loadScoped = vi.fn().mockResolvedValue('secret alpha\nsecret beta');
    const appendScoped = vi.fn().mockResolvedValue(undefined);
    const deleteScoped = vi.fn().mockResolvedValue(1);
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped, appendScoped, deleteScoped })),
      activeScopes: allScopes,
    };
    await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: 'secret', from_scope: 'user:alex', to_scope: 'global' },
      agent,
    );
    expect(appendScoped).toHaveBeenCalledWith('knowledge', 'secret alpha', { type: 'global', id: 'global' });
    expect(deleteScoped).toHaveBeenCalledTimes(1);
    expect(deleteScoped).toHaveBeenCalledWith('knowledge', 'secret alpha', { type: 'user', id: 'alex' }, { exact: true });
  });

  it('F4: rejects an empty/whitespace content_pattern (would wipe the namespace)', async () => {
    const loadScoped = vi.fn().mockResolvedValue('a\nb\nc');
    const deleteScoped = vi.fn();
    const agent: IAgent = {
      ...makeAgent(makeMockMemory({ loadScoped, deleteScoped })),
      activeScopes: allScopes,
    };
    const result = await memoryPromoteTool.handler(
      { namespace: 'knowledge', content_pattern: '   ', from_scope: 'user:alex', to_scope: 'global' },
      agent,
    );
    expect(result).toContain('non-empty content_pattern');
    expect(deleteScoped).not.toHaveBeenCalled();
    expect(loadScoped).not.toHaveBeenCalled();
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

// === B1 KG-backed tests removed ============================================
//
// B1 (PR #529) was reverted on 2026-05-23 — the memory_recall/update/delete
// tools are back to the flat-file path. The KG-backed integration tests that
// previously lived in this file exercised a contract no longer held by these
// tools (ranked KG results, supersession via is_active=0). Keeping them
// would assert behaviour that doesn't exist.
//
// The KG-population subscription on `memory_store` is still active, so KG
// retrieval quality is exercised by `scripts/kg-bench/` instead — that's the
// regression gate for Foundation Rework Sprint 5 (the proper fix).
//
// The removed describe block was titled `memory tools — KG-backed (B1)`. It
// covered: query+ranked recall, scope-bleed prevention, KG supersession,
// is_active=0 delete, mirror sync, stale-mirror invisibility, and the 4
// regression guards added during /pr-review (KG-throws fallback, empty
// activeScopes, KG-no-match update, self-supersession blocker).
//
// === Revert-companion tests: bounded query path + supersede fallback ======

describe('memoryRecallTool query path (post-revert bounded behaviour)', () => {
  // Build a namespace where matching lines alone exceed the 20K-token budget.
  // ~250 chars per matching line × 600 matches ≈ 150K chars ≈ 40K tokens.
  function bigMatchingNamespace(matchCount: number, queryWord: string): string {
    const lines: string[] = [];
    for (let i = 0; i < matchCount; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const body = `Detailed note about ${queryWord} number ${i + 1}. `.repeat(8).trim();
      lines.push(`[2026-04-${day}] ${body}`);
    }
    return lines.join('\n');
  }

  it('returns a bounded subset when matches exceed the query-path token budget', async () => {
    const content = bigMatchingNamespace(600, 'gladia');
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'gladia' },
      agent,
    );

    // Result must be far smaller than the full match-set dump.
    expect(result.length).toBeLessThan(content.length);
    // 20K-token budget = ~80K chars; allow headroom for the tail-note.
    expect(result.length).toBeLessThan(85_000);
    // It must surface the tail-note telling the agent the result was capped.
    expect(result).toContain('Showing');
    expect(result).toContain('of 600 matching knowledge entries');
    // Newest matches preferred → entry 600 must be present, entry 1 must not.
    expect(result).toContain('gladia number 600');
    expect(result).not.toContain('gladia number 1.');
  });

  it('returns the full match set untruncated when it fits in the budget', async () => {
    const content = '[2026-05-01] foo apple\n[2026-05-02] foo apple again\n[2026-05-03] bar';
    const load = vi.fn().mockResolvedValue(content);
    const agent = makeAgent(makeMockMemory({ load }));

    const result = await memoryRecallTool.handler(
      { namespace: 'knowledge', query: 'apple' },
      agent,
    );
    // No tail-note → the two matching lines are present in full.
    expect(result).toContain('foo apple');
    expect(result).toContain('foo apple again');
    expect(result).not.toContain('bar');
    expect(result).not.toContain('Showing');
  });
});

describe('memoryUpdateTool fallback ([SUPERSEDED] marker)', () => {
  it('marks the closest matching line with [SUPERSEDED YYYY-MM-DD] when oldText is not an exact substring', async () => {
    // Mirror state: 3 lines, one is the closest semantic match to old_content.
    const store: string[] = [
      'Acme uses PostgreSQL 16 as primary DB',
      'Beta uses MySQL 8 as primary DB',
      'Gamma uses MongoDB 7 for caching',
    ];
    const load = vi.fn(async () => store.join('\n'));
    // update() returns false because "PostgreSQL 16 database" is NOT a
    // substring of the seeded "Acme uses PostgreSQL 16 as primary DB" line.
    const update = vi.fn(async () => false);
    const deleteFn = vi.fn(async (_ns: string, pattern: string) => {
      const i = store.findIndex(l => l.includes(pattern));
      if (i < 0) return 0;
      store.splice(i, 1);
      return 1;
    });
    const append = vi.fn(async (_ns: string, text: string) => {
      store.push(text);
    });
    const agent = makeAgent(makeMockMemory({ load, update, delete: deleteFn, append }));

    const result = await memoryUpdateTool.handler(
      {
        namespace: 'knowledge',
        old_content: 'PostgreSQL 16 database',
        new_content: 'Acme uses PostgreSQL 17 as primary DB',
      },
      agent,
    );

    // Exact path failed → fallback ran → at least one line marked + new line appended.
    expect(result).toContain('Superseded');
    expect(result).toContain('added new content to knowledge');

    const today = new Date().toISOString().slice(0, 10);
    const markedLine = store.find(l => l.startsWith(`[SUPERSEDED ${today}] `));
    expect(markedLine).toBeDefined();
    // The marked line must be the Acme/PostgreSQL one (highest token overlap).
    expect(markedLine).toContain('Acme uses PostgreSQL 16');
    // New line was appended.
    expect(store.some(l => l === 'Acme uses PostgreSQL 17 as primary DB')).toBe(true);
    // Unrelated lines untouched.
    expect(store.some(l => l === 'Beta uses MySQL 8 as primary DB')).toBe(true);
    expect(store.some(l => l === 'Gamma uses MongoDB 7 for caching')).toBe(true);
  });

  it('appends new content with an honest message when no prior line shares enough tokens with old_content', async () => {
    const store: string[] = ['Completely unrelated fact about widgets'];
    const load = vi.fn(async () => store.join('\n'));
    const update = vi.fn(async () => false);
    const deleteFn = vi.fn(async () => 0);
    const append = vi.fn(async (_ns: string, text: string) => {
      store.push(text);
    });
    const agent = makeAgent(makeMockMemory({ load, update, delete: deleteFn, append }));

    const result = await memoryUpdateTool.handler(
      {
        namespace: 'knowledge',
        old_content: 'PostgreSQL 16 database production cluster',
        new_content: 'Now using PostgreSQL 17',
      },
      agent,
    );

    expect(result).toContain('Appended new content to knowledge');
    expect(result).toContain('no prior memory matched');
    // The widget line stays exactly as it was — no false-positive marker.
    expect(store[0]).toBe('Completely unrelated fact about widgets');
    expect(store).toContain('Now using PostgreSQL 17');
  });
});
