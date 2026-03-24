import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectContradictions } from './contradiction-detector.js';
import type { KuzuGraph } from './knowledge-graph.js';
import type { EmbeddingProvider } from './embedding.js';

// Mock graph that returns configurable similar memories
function createMockGraph(similarMemories: Array<{
  'm.id': string;
  'm.text': string;
  _similarity: number;
}>): KuzuGraph {
  return {
    findSimilarMemories: vi.fn().mockResolvedValue(similarMemories),
  } as unknown as KuzuGraph;
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
    const graph = createMockGraph([]);
    const result = await detectContradictions(
      'Use technique X',
      'methods',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );
    expect(result).toHaveLength(0);
    expect(graph.findSimilarMemories).not.toHaveBeenCalled();
  });

  it('skips project-state namespace', async () => {
    const graph = createMockGraph([]);
    const result = await detectContradictions(
      'Project is active',
      'project-state',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty when no similar memories found', async () => {
    const graph = createMockGraph([]);
    const result = await detectContradictions(
      'PostgreSQL is required',
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('detects negation contradiction (English)', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-1',
      'm.text': 'The project uses PostgreSQL.',
      _similarity: 0.92,
    }]);

    const result = await detectContradictions(
      "The project doesn't use PostgreSQL anymore.",
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
    expect(result[0]!.existingMemoryId).toBe('old-1');
  });

  it('detects negation contradiction (German)', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-2',
      'm.text': 'Das Projekt nutzt PostgreSQL.',
      _similarity: 0.90,
    }]);

    const result = await detectContradictions(
      'Das Projekt nutzt nicht mehr PostgreSQL.',
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('detects number change', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-3',
      'm.text': 'Budget is 5000 per month.',
      _similarity: 0.88,
    }]);

    const result = await detectContradictions(
      'Budget is 8000 per month.',
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.existingMemoryId).toBe('old-3');
  });

  it('detects state change', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-4',
      'm.text': 'The project is active.',
      _similarity: 0.91,
    }]);

    const result = await detectContradictions(
      'The project is completed.',
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('does not flag similar non-contradictory memories', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-5',
      'm.text': 'The project uses PostgreSQL 16.',
      _similarity: 0.95,
    }]);

    const result = await detectContradictions(
      'The project uses PostgreSQL 16 for JSONB queries.',
      'knowledge',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    // High similarity but no negation/number change/state change → not a contradiction
    expect(result).toHaveLength(0);
  });

  it('works with learnings namespace', async () => {
    const graph = createMockGraph([{
      'm.id': 'old-6',
      'm.text': 'Mocking the database is fine for tests.',
      _similarity: 0.85,
    }]);

    const result = await detectContradictions(
      "Don't mock the database in tests.",
      'learnings',
      { type: 'context', id: 'test' },
      graph,
      mockProvider,
    );

    expect(result).toHaveLength(1);
  });
});
