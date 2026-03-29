import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectContradictions } from './contradiction-detector.js';
import type { AgentMemoryDb, ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';

// Mock db that returns configurable similar memories
function createMockDb(similarMemories: ScoredMemoryRow[]): AgentMemoryDb {
  return {
    findSimilarMemories: vi.fn().mockReturnValue(similarMemories),
  } as unknown as AgentMemoryDb;
}

function mockMemory(id: string, text: string, similarity: number): ScoredMemoryRow {
  return {
    id, text, namespace: 'knowledge', scope_type: 'context', scope_id: 'test',
    source_run_id: null, source_episode_id: null, provider: 'test',
    embedding: null, confidence: 0.75, is_active: 1, superseded_by: null,
    retrieval_count: 0, confirmation_count: 0, last_retrieved_at: null,
    created_at: '', updated_at: '', _similarity: similarity,
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
    const db = createMockDb([]);
    const result = await detectContradictions(
      'Use technique X', 'methods', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(0);
    expect(db.findSimilarMemories).not.toHaveBeenCalled();
  });

  it('skips project-state namespace', async () => {
    const db = createMockDb([]);
    const result = await detectContradictions(
      'Project is active', 'project-state', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty when no similar memories found', async () => {
    const db = createMockDb([]);
    const result = await detectContradictions(
      'PostgreSQL is required', 'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('detects negation contradiction (English)', async () => {
    const db = createMockDb([mockMemory('old-1', 'The project uses PostgreSQL.', 0.92)]);
    const result = await detectContradictions(
      "The project doesn't use PostgreSQL anymore.",
      'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
    expect(result[0]!.existingMemoryId).toBe('old-1');
  });

  it('detects negation contradiction (German)', async () => {
    const db = createMockDb([mockMemory('old-2', 'Das Projekt nutzt PostgreSQL.', 0.90)]);
    const result = await detectContradictions(
      'Das Projekt nutzt nicht mehr PostgreSQL.',
      'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('detects number change', async () => {
    const db = createMockDb([mockMemory('old-3', 'Budget is 5000 per month.', 0.88)]);
    const result = await detectContradictions(
      'Budget is 8000 per month.',
      'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.existingMemoryId).toBe('old-3');
  });

  it('detects state change', async () => {
    const db = createMockDb([mockMemory('old-4', 'The project is active.', 0.91)]);
    const result = await detectContradictions(
      'The project is completed.',
      'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('does not flag similar non-contradictory memories', async () => {
    const db = createMockDb([mockMemory('old-5', 'The project uses PostgreSQL 16.', 0.95)]);
    const result = await detectContradictions(
      'The project uses PostgreSQL 16 for JSONB queries.',
      'knowledge', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('works with learnings namespace', async () => {
    const db = createMockDb([mockMemory('old-6', 'Mocking the database is fine for tests.', 0.85)]);
    const result = await detectContradictions(
      "Don't mock the database in tests.",
      'learnings', { type: 'context', id: 'test' }, db, mockProvider,
    );
    expect(result).toHaveLength(1);
  });
});
