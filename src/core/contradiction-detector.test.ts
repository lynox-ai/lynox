import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectContradictions, type MemoryRecall } from './contradiction-detector.js';
import type { ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';

// Mock recall that returns configurable similar memories. detectContradictions is
// parametrized on the recall SOURCE (S5b'-a) — legacy AgentMemoryDb.findSimilarMemories
// or engine.db MemoryGraphStore.findSimilarRecall — so the test injects the recall fn
// directly instead of a whole db.
function createMockRecall(similarMemories: ScoredMemoryRow[]): MemoryRecall & { mock: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockReturnValue(similarMemories);
  return Object.assign(((...args: Parameters<MemoryRecall>) => fn(...args)) as MemoryRecall, { mock: fn });
}

function mockMemory(id: string, text: string, similarity: number): ScoredMemoryRow {
  return {
    id, text, namespace: 'knowledge', scope_type: 'context', scope_id: 'test',
    source_run_id: null, source_episode_id: null, provider: 'test',
    embedding: null, confidence: 0.75, is_active: 1, superseded_by: null,
    retrieval_count: 0, confirmation_count: 0, last_retrieved_at: null,
    created_at: '', updated_at: '', source_type: 'agent_inferred', source_tool_name: null,
    _similarity: similarity,
  };
}

function createMockProvider(): EmbeddingProvider {
  return {
    name: 'test',
    dimensions: 384,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
}

describe('detectContradictions', () => {
  let mockProvider: EmbeddingProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  it('skips non-factual namespaces', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'Use technique X', 'methods', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
    expect(recall.mock).not.toHaveBeenCalled();
  });

  it('skips status namespace', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'Project is active', 'status', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty when no similar memories found', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'PostgreSQL is required', 'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('detects negation contradiction (English)', async () => {
    const recall = createMockRecall([mockMemory('old-1', 'The project uses PostgreSQL.', 0.92)]);
    const result = await detectContradictions(
      "The project doesn't use PostgreSQL anymore.",
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
    expect(result[0]!.existingMemoryId).toBe('old-1');
  });

  it('detects negation contradiction (German)', async () => {
    const recall = createMockRecall([mockMemory('old-2', 'Das Projekt nutzt PostgreSQL.', 0.90)]);
    const result = await detectContradictions(
      'Das Projekt nutzt nicht mehr PostgreSQL.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('detects number change', async () => {
    const recall = createMockRecall([mockMemory('old-3', 'Budget is 5000 per month.', 0.88)]);
    const result = await detectContradictions(
      'Budget is 8000 per month.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.existingMemoryId).toBe('old-3');
  });

  it('detects state change', async () => {
    const recall = createMockRecall([mockMemory('old-4', 'The project is active.', 0.91)]);
    const result = await detectContradictions(
      'The project is completed.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('does not flag similar non-contradictory memories', async () => {
    const recall = createMockRecall([mockMemory('old-5', 'The project uses PostgreSQL 16.', 0.95)]);
    const result = await detectContradictions(
      'The project uses PostgreSQL 16 for JSONB queries.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('works with learnings namespace', async () => {
    const recall = createMockRecall([mockMemory('old-6', 'Mocking the database is fine for tests.', 0.85)]);
    const result = await detectContradictions(
      "Don't mock the database in tests.",
      'learnings', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
  });

  it('scopes the similarity query by scope ID so a memory cannot supersede across projects', async () => {
    const recall = createMockRecall([]);
    await detectContradictions(
      'PostgreSQL is required', 'knowledge', { type: 'context', id: 'acme' }, recall, mockProvider,
    );
    // Without scopeIds a `context:acme` memory could supersede a contradicting
    // `context:beta` memory of the same type (cross-project data leak).
    expect(recall.mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ scopeIds: ['acme'] }),
    );
  });
});
