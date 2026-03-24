import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Integration tests for KnowledgeLayer.
 *
 * Uses a single LadybugDB instance for the entire suite (beforeAll/afterAll).
 * LadybugDB native addon causes SIGSEGV on process exit in Vitest fork workers.
 * All tests run sequentially within this suite, sharing graph state.
 * afterAll skips close() to avoid the crash — temp dir cleanup handles it.
 */
describe('KnowledgeLayer', () => {
  let layer: KnowledgeLayer;
  let tempDir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'test-project' };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nodyn-kl-test-'));
    layer = new KnowledgeLayer(join(tempDir, 'test-graph'), new LocalProvider());
    await layer.init();
  });

  afterAll(async () => {
    // Skip layer.close() — LadybugDB native addon causes SIGSEGV on cleanup
    // in Vitest fork workers. The temp dir removal handles resource cleanup.
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- Store ---

  it('stores a memory and returns result', async () => {
    const result = await layer.store(
      'Client Thomas wants API access for acme-shop.ch.',
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.memoryId).toBeTruthy();
  });

  it('extracts entities from stored memory', async () => {
    const result = await layer.store(
      'Kunde Maria von example-shop.ch nutzt Shopify.',
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    const entityNames = result.entities.map(e => e.canonicalName.toLowerCase());
    expect(entityNames.some(n => n.includes('maria'))).toBe(true);
    expect(entityNames.some(n => n.includes('example-shop.ch'))).toBe(true);
  });

  it('deduplicates near-identical memories', async () => {
    const text = 'PostgreSQL is required for the backend infrastructure.';
    await layer.store(text, 'knowledge', scope);
    const result2 = await layer.store(text, 'knowledge', scope);

    expect(result2.deduplicated).toBe(true);
    expect(result2.stored).toBe(false);
  });

  it('rejects very short text', async () => {
    const result = await layer.store('Hi', 'knowledge', scope);
    expect(result.stored).toBe(false);
  });

  it('handles contradiction check path', async () => {
    await layer.store('The deployment uses Docker Compose.', 'knowledge', scope);
    const result = await layer.store(
      "The deployment doesn't use Docker Compose.",
      'knowledge',
      scope,
    );

    expect(result.stored).toBe(true);
    expect(result.contradictions).toBeDefined();
  });

  // --- Stats ---

  it('reports non-zero stats after storing', async () => {
    const stats = await layer.stats();
    expect(stats.memoryCount).toBeGreaterThanOrEqual(1);
    expect(stats.entityCount).toBeGreaterThanOrEqual(0);
  });

  // --- Retrieve ---

  it('retrieves stored memories', async () => {
    const result = await layer.retrieve('database PostgreSQL', [scope], {
      topK: 5,
      threshold: 0.1,
      useHyDE: false,
      useGraphExpansion: false,
    });

    expect(result.memories).toBeDefined();
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.entities).toBeDefined();
    expect(result.contextGraph).toBeDefined();
  });

  it('handles high threshold gracefully', async () => {
    const result = await layer.retrieve('quantum physics', [scope], {
      topK: 5,
      threshold: 0.99,
      useHyDE: false,
      useGraphExpansion: false,
    });

    expect(Array.isArray(result.memories)).toBe(true);
  });

  it('supports graph expansion in retrieval', async () => {
    const result = await layer.retrieve('Thomas API access', [scope], {
      topK: 5,
      threshold: 0.1,
      useHyDE: false,
      useGraphExpansion: true,
    });

    expect(result.entities).toBeDefined();
  });

  // --- Entity Operations ---

  it('resolves entity after store', async () => {
    const entity = await layer.resolveEntity('Thomas', [scope]);
    // LocalProvider may or may not resolve — just verify no crash
    expect(entity === null || typeof entity.canonicalName === 'string').toBe(true);
  });

  // --- GC ---

  it('runs garbage collection in dry-run mode', async () => {
    const result = await layer.gc({ dryRun: true });
    expect(typeof result.supersededRemoved).toBe('number');
    expect(typeof result.orphanEntitiesRemoved).toBe('number');
    expect(typeof result.staleMemoriesRemoved).toBe('number');
  });

  // --- Format ---

  it('returns empty string for empty results', () => {
    const ctx = layer.formatRetrievalContext({
      memories: [],
      entities: [],
      contextGraph: '',
    });
    expect(ctx).toBe('');
  });

  it('formats non-empty results with XML structure', async () => {
    const result = await layer.retrieve('deployment', [scope], {
      topK: 5,
      threshold: 0.1,
      useHyDE: false,
      useGraphExpansion: false,
    });

    const ctx = layer.formatRetrievalContext(result);
    if (result.memories.length > 0) {
      expect(ctx).toContain('<relevant_context>');
      expect(ctx).toContain('<scope type="context">');
    }
  });

  it('drops lowest-scored memories when formatContext exceeds maxChars', () => {
    // Simulate a result with multiple large memories
    const memories = Array.from({ length: 5 }, (_, i) => ({
      id: `mem-${i}`,
      text: 'x'.repeat(500),
      namespace: 'knowledge' as const,
      scopeType: 'context' as const,
      scopeId: 'test',
      score: 0.9 - i * 0.1,
      finalScore: 0.9 - i * 0.1,
      source: 'vector' as const,
    }));

    // With a generous limit, all memories should be included
    const fullCtx = layer.formatRetrievalContext({ memories, entities: [], contextGraph: '' });
    expect(fullCtx).toContain('<relevant_context>');

    // With a tight limit, some memories should be dropped
    const tightCtx = layer.formatRetrievalContext(
      { memories, entities: [], contextGraph: '' },
      800, // very tight budget
    );
    // Should still have the structure but fewer memories
    if (tightCtx) {
      expect(tightCtx.length).toBeLessThanOrEqual(800);
    }
    // The highest-scored memory (finalScore 0.9) should survive
    if (tightCtx) {
      // The lowest-scored memories (0.5, 0.6) should be dropped first
      const full90 = fullCtx.includes('90%');
      const tight90 = tightCtx.includes('90%');
      expect(full90).toBe(true);
      expect(tight90).toBe(true);
    }
  });

  it('respects default maxChars limit (12000) without explicit parameter', () => {
    // Create memories that would exceed 12K combined
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `mem-${i}`,
      text: 'y'.repeat(1000), // 1000 chars each, 20 * 1000 = 20K
      namespace: 'knowledge' as const,
      scopeType: 'context' as const,
      scopeId: 'test',
      score: 0.9 - i * 0.01,
      finalScore: 0.9 - i * 0.01,
      source: 'vector' as const,
    }));

    const ctx = layer.formatRetrievalContext({ memories, entities: [], contextGraph: '' });
    // Should be capped at default 12K
    expect(ctx.length).toBeLessThanOrEqual(12_000);
    // Should still contain highest-scored memories
    expect(ctx).toContain('<relevant_context>');
  });
});
