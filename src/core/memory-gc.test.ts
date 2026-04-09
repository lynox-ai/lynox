import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMemoryGc } from './memory-gc.js';
import type { GcResult } from './memory-gc.js';
import type { IMemory, MemoryScopeRef, MemoryNamespace } from '../types/index.js';
import type { EmbeddingProvider } from './embedding.js';
import { embedToBlob } from './embedding.js';
import type { RunHistory } from './run-history.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockMemory(data: Map<string, string>): IMemory {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockResolvedValue(false),
    render: vi.fn().mockReturnValue(''),
    loadAll: vi.fn().mockResolvedValue(undefined),
    hasContent: vi.fn().mockReturnValue(false),
    maybeUpdate: vi.fn().mockResolvedValue(undefined),
    loadScoped: vi.fn().mockImplementation(
      async (ns: MemoryNamespace, scope: MemoryScopeRef) => {
        return data.get(`${scope.type}:${scope.id}:${ns}`) ?? null;
      },
    ),
    appendScoped: vi.fn().mockResolvedValue(undefined),
    deleteScoped: vi.fn().mockImplementation(
      async (_ns: MemoryNamespace, pattern: string, _scope: MemoryScopeRef) => {
        return pattern.length > 0 ? 1 : 0;
      },
    ),
    updateScoped: vi.fn().mockResolvedValue(false),
  };
}

function createMockProvider(): EmbeddingProvider {
  const cache = new Map<string, number[]>();
  return {
    name: 'mock',
    dimensions: 4,
    embed: vi.fn().mockImplementation(async (text: string) => {
      if (cache.has(text)) return cache.get(text)!;
      // Deterministic pseudo-embedding from text hash
      const hash = Array.from(text).reduce((h, c) => h * 31 + c.charCodeAt(0), 0);
      const vec = [
        Math.sin(hash),
        Math.cos(hash),
        Math.sin(hash * 2),
        Math.cos(hash * 2),
      ];
      cache.set(text, vec);
      return vec;
    }),
  };
}

function createMockHistory(): RunHistory {
  return {
    getStaleEmbeddings: vi.fn().mockReturnValue([]),
    getEmbeddingsByScope: vi.fn().mockReturnValue([]),
    deleteEmbedding: vi.fn().mockReturnValue(true),
  } as unknown as RunHistory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMemoryGc', () => {
  const projectScope: MemoryScopeRef = { type: 'context', id: 'proj-1' };
  const userScope: MemoryScopeRef = { type: 'user', id: 'user-1' };

  let memory: IMemory;
  let provider: EmbeddingProvider;
  let history: RunHistory;

  beforeEach(() => {
    memory = createMockMemory(new Map());
    provider = createMockProvider();
    history = createMockHistory();
  });

  it('returns zero counts when memory is empty', async () => {
    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result).toStrictEqual<GcResult>({
      deduplicated: 0,
      pruned: 0,
      scopesProcessed: 0,
      namespacesProcessed: 0,
    });
  });

  it('dedup: removes near-duplicate lines (cosine > 0.95)', async () => {
    const data = new Map<string, string>();
    // Two lines that we will make appear as near-duplicates via embedding mock
    data.set('context:proj-1:knowledge', 'This is a line about TypeScript patterns\nThis is a line about TypeScript patterns too');
    memory = createMockMemory(data);

    // Return near-identical vectors for both lines
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])        // line 1
      .mockResolvedValueOnce([0.999, 0.01, 0, 0]); // line 2 — near-duplicate

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result.deduplicated).toBe(1);
    expect(memory.deleteScoped).toHaveBeenCalledTimes(1);
  });

  it('dedup: keeps distinct lines', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'Alpha line content here\nBeta totally different content');
    memory = createMockMemory(data);

    // Return orthogonal vectors — cosine similarity 0
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])
      .mockResolvedValueOnce([0, 1, 0, 0]);

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result.deduplicated).toBe(0);
    expect(memory.deleteScoped).not.toHaveBeenCalled();
  });

  it('dedup: keeps longest line in duplicate cluster', async () => {
    const shortLine = 'Short line text here';                     // 20 chars
    const longLine = 'This is a much longer line that contains more detail'; // 52 chars
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', `${shortLine}\n${longLine}`);
    memory = createMockMemory(data);

    // Near-identical embeddings → triggers dedup
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])
      .mockResolvedValueOnce([0.999, 0.005, 0, 0]);

    await runMemoryGc(memory, [projectScope], provider, history);

    // The shorter line should be removed, the longer kept
    expect(memory.deleteScoped).toHaveBeenCalledWith('knowledge', shortLine, projectScope);
    expect(memory.deleteScoped).not.toHaveBeenCalledWith('knowledge', longLine, projectScope);
  });

  it('prune: removes stale entries from flat file and SQLite', async () => {
    const staleLine = 'This is a stale memory entry for pruning';
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', staleLine);
    memory = createMockMemory(data);

    // Make getStaleEmbeddings return an entry matching the flat-file line
    (history.getStaleEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'emb-1', text: staleLine, namespace: 'knowledge', created_at: '2025-01-01', last_retrieved_at: null },
    ]);

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result.pruned).toBe(1);
    expect(history.deleteEmbedding).toHaveBeenCalledWith('emb-1');
    expect(memory.deleteScoped).toHaveBeenCalledWith('knowledge', staleLine, projectScope);
  });

  it('prune: keeps entries that were recently retrieved', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'A recently retrieved memory entry');
    memory = createMockMemory(data);

    // No stale embeddings → nothing to prune
    (history.getStaleEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result.pruned).toBe(0);
    expect(history.deleteEmbedding).not.toHaveBeenCalled();
  });

  it('prune: keeps recent entries regardless', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'A fresh entry just created yesterday');
    memory = createMockMemory(data);

    // getStaleEmbeddings returns nothing for recent entries
    (history.getStaleEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    expect(result.pruned).toBe(0);
    expect(memory.deleteScoped).not.toHaveBeenCalled();
  });

  it('dry run: returns counts but makes no changes', async () => {
    const staleLine = 'This is a stale line to prune in dry run';
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', `${staleLine}\n${staleLine} duplicate version`);
    memory = createMockMemory(data);

    // Near-identical embeddings for dedup
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])
      .mockResolvedValueOnce([0.999, 0.005, 0, 0]);

    // Stale embedding for pruning — match the non-deduped line
    (history.getStaleEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'emb-dry', text: `${staleLine} duplicate version`, namespace: 'knowledge', created_at: '2025-01-01', last_retrieved_at: null },
    ]);

    const result = await runMemoryGc(memory, [projectScope], provider, history, { dryRun: true });

    // Counts should be reported
    expect(result.deduplicated).toBe(1);
    // No mutations should have occurred
    expect(memory.deleteScoped).not.toHaveBeenCalled();
    expect(history.deleteEmbedding).not.toHaveBeenCalled();
  });

  it('processes all namespaces across all scopes', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'A context fact with enough chars');
    data.set('user:user-1:learnings', 'A user error with enough detail');
    memory = createMockMemory(data);

    const result = await runMemoryGc(memory, [projectScope, userScope], provider, history);

    // Both namespaces had content, so namespacesProcessed >= 2
    expect(result.namespacesProcessed).toBe(2);
    // loadScoped should have been called for all 4 namespaces x 2 scopes = 8
    expect(memory.loadScoped).toHaveBeenCalledTimes(8);
  });

  it('handles empty scopes gracefully', async () => {
    const result = await runMemoryGc(memory, [], provider, history);

    expect(result).toStrictEqual<GcResult>({
      deduplicated: 0,
      pruned: 0,
      scopesProcessed: 0,
      namespacesProcessed: 0,
    });
    expect(memory.loadScoped).not.toHaveBeenCalled();
  });

  it('respects custom dedupThreshold', async () => {
    // Two lines with moderate similarity — not near-duplicate at default 0.95
    // but near-duplicate at a lowered threshold of 0.5
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'First distinct memory entry\nSecond distinct memory entry');
    memory = createMockMemory(data);

    // Cosine similarity of [1,0,0,0] and [0.7,0.7,0,0] is ~0.707
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])
      .mockResolvedValueOnce([0.7, 0.7, 0, 0]);

    // At default threshold (0.95) — no dedup
    const resultDefault = await runMemoryGc(memory, [projectScope], provider, history);
    expect(resultDefault.deduplicated).toBe(0);

    // Reset mocks
    memory = createMockMemory(data);
    provider.embed = vi.fn()
      .mockResolvedValueOnce([1, 0, 0, 0])
      .mockResolvedValueOnce([0.7, 0.7, 0, 0]);

    // At lowered threshold (0.5) — dedup triggered
    const resultLow = await runMemoryGc(memory, [projectScope], provider, history, { dedupThreshold: 0.5 });
    expect(resultLow.deduplicated).toBe(1);
  });

  it('respects custom ageDays', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'A memory entry for age test here');
    memory = createMockMemory(data);

    await runMemoryGc(memory, [projectScope], provider, history, { ageDays: 30 });

    // getStaleEmbeddings should have been called with the custom ageDays
    expect(history.getStaleEmbeddings).toHaveBeenCalledWith('context', 'proj-1', 30);
  });

  // --- Embedding reuse tests ---

  it('reuses existing embeddings from DB instead of calling embed()', async () => {
    const line1 = 'This line has an existing embedding in DB';
    const line2 = 'This line does not have a cached embedding';
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', `${line1}\n${line2}`);
    memory = createMockMemory(data);

    // Provide a cached embedding for line1 from the DB
    const cachedVec = [1, 0, 0, 0];
    (history.getEmbeddingsByScope as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'emb-cached',
        project_id: 'proj-1',
        namespace: 'knowledge',
        text: line1,
        embedding: embedToBlob(cachedVec),
        embedding_dim: 4,
        provider: 'mock',
        source_run_id: null,
        last_retrieved_at: null,
        created_at: '2025-06-01',
        scope_type: 'context',
        scope_id: 'proj-1',
      },
    ]);

    // embed() should only be called for line2 (line1 is cached)
    provider.embed = vi.fn()
      .mockResolvedValueOnce([0, 1, 0, 0]); // only line2

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    // embed() called exactly once (for the uncached line)
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith(line2);
    // Vectors are orthogonal → no dedup
    expect(result.deduplicated).toBe(0);
  });

  it('skips embed() entirely when all lines have cached embeddings', async () => {
    const line1 = 'First line with cached embedding';
    const line2 = 'Second line with cached embedding';
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', `${line1}\n${line2}`);
    memory = createMockMemory(data);

    // Both lines have cached embeddings — orthogonal vectors
    (history.getEmbeddingsByScope as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'emb-1',
        project_id: 'proj-1',
        namespace: 'knowledge',
        text: line1,
        embedding: embedToBlob([1, 0, 0, 0]),
        embedding_dim: 4,
        provider: 'mock',
        source_run_id: null,
        last_retrieved_at: null,
        created_at: '2025-06-01',
        scope_type: 'context',
        scope_id: 'proj-1',
      },
      {
        id: 'emb-2',
        project_id: 'proj-1',
        namespace: 'knowledge',
        text: line2,
        embedding: embedToBlob([0, 1, 0, 0]),
        embedding_dim: 4,
        provider: 'mock',
        source_run_id: null,
        last_retrieved_at: null,
        created_at: '2025-06-01',
        scope_type: 'context',
        scope_id: 'proj-1',
      },
    ]);

    provider.embed = vi.fn();

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    // embed() should never be called — all embeddings served from cache
    expect(provider.embed).not.toHaveBeenCalled();
    expect(result.deduplicated).toBe(0);
  });

  it('dedup still works correctly with cached embeddings', async () => {
    const line1 = 'This is a line about TypeScript patterns';
    const line2 = 'This is a line about TypeScript patterns also';
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', `${line1}\n${line2}`);
    memory = createMockMemory(data);

    // Both lines cached with near-identical vectors → should trigger dedup
    (history.getEmbeddingsByScope as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'emb-1',
        project_id: 'proj-1',
        namespace: 'knowledge',
        text: line1,
        embedding: embedToBlob([1, 0, 0, 0]),
        embedding_dim: 4,
        provider: 'mock',
        source_run_id: null,
        last_retrieved_at: null,
        created_at: '2025-06-01',
        scope_type: 'context',
        scope_id: 'proj-1',
      },
      {
        id: 'emb-2',
        project_id: 'proj-1',
        namespace: 'knowledge',
        text: line2,
        embedding: embedToBlob([0.999, 0.01, 0, 0]),
        embedding_dim: 4,
        provider: 'mock',
        source_run_id: null,
        last_retrieved_at: null,
        created_at: '2025-06-01',
        scope_type: 'context',
        scope_id: 'proj-1',
      },
    ]);

    provider.embed = vi.fn();

    const result = await runMemoryGc(memory, [projectScope], provider, history);

    // embed() not called, but dedup still detected via cached vectors
    expect(provider.embed).not.toHaveBeenCalled();
    expect(result.deduplicated).toBe(1);
    // The shorter line should be removed
    expect(memory.deleteScoped).toHaveBeenCalledWith('knowledge', line1, projectScope);
  });

  it('loads embeddings once per scope, not per namespace', async () => {
    const data = new Map<string, string>();
    data.set('context:proj-1:knowledge', 'A fact line for scope cache test');
    data.set('context:proj-1:learnings', 'An error line for scope cache test');
    memory = createMockMemory(data);

    await runMemoryGc(memory, [projectScope], provider, history);

    // getEmbeddingsByScope called once per scope, not once per namespace
    expect(history.getEmbeddingsByScope).toHaveBeenCalledTimes(1);
    expect(history.getEmbeddingsByScope).toHaveBeenCalledWith('context', 'proj-1');
  });
});
