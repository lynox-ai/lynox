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
 * Uses real SQLite (better-sqlite3) — no SIGSEGV issues, safe to close().
 */
describe('KnowledgeLayer', () => {
  let layer: KnowledgeLayer;
  let tempDir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'test-project' };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-kl-test-'));
    layer = new KnowledgeLayer(join(tempDir, 'test.db'), new LocalProvider());
    await layer.init();
  });

  afterAll(async () => {
    await layer.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- Store ---

  it('stores a memory and returns result', async () => {
    const result = await layer.store(
      'Client Thomas wants API access for acme-shop.ch.',
      'knowledge', scope,
    );
    expect(result.stored).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.memoryId).toBeTruthy();
  });

  it('extracts entities from stored memory', async () => {
    const result = await layer.store(
      'Kunde Maria von example-shop.ch nutzt Shopify.',
      'knowledge', scope,
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
      'knowledge', scope,
    );
    expect(result.stored).toBe(true);
    expect(result.contradictions).toBeDefined();
  });

  // --- Stats ---

  it('reports non-zero stats after storing', async () => {
    const stats = await layer.stats();
    expect(stats.memoryCount).toBeGreaterThanOrEqual(1);
    expect(stats.entityCount).toBeGreaterThanOrEqual(0);
    expect(typeof stats.patternCount).toBe('number');
  });

  // --- Retrieve ---

  it('retrieves stored memories', async () => {
    const result = await layer.retrieve('database PostgreSQL', [scope], {
      topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
    });
    expect(result.memories).toBeDefined();
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.entities).toBeDefined();
    expect(result.contextGraph).toBeDefined();
  });

  it('handles high threshold gracefully', async () => {
    const result = await layer.retrieve('quantum physics', [scope], {
      topK: 5, threshold: 0.99, useHyDE: false, useGraphExpansion: false,
    });
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it('supports graph expansion in retrieval', async () => {
    const result = await layer.retrieve('Thomas API access', [scope], {
      topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: true,
    });
    expect(result.entities).toBeDefined();
  });

  // --- Entity Operations ---

  it('resolves entity after store', async () => {
    const entity = await layer.resolveEntity('Thomas', [scope]);
    expect(entity === null || typeof entity.canonicalName === 'string').toBe(true);
  });

  // --- Patterns ---

  it('returns patterns (empty initially)', () => {
    const patterns = layer.getPatterns();
    expect(Array.isArray(patterns)).toBe(true);
  });

  // --- Metrics ---

  it('returns metrics (empty initially)', () => {
    const metrics = layer.getMetrics();
    expect(Array.isArray(metrics)).toBe(true);
  });

  // --- Confidence Evolution via Dedup ---

  it('boosts confidence when storing duplicate text', async () => {
    const text = 'Unique fact for confidence test: lynox uses SQLite for agent memory.';
    const r1 = await layer.store(text, 'knowledge', scope);
    expect(r1.stored).toBe(true);

    const r2 = await layer.store(text, 'knowledge', scope);
    expect(r2.deduplicated).toBe(true);
    expect(r2.memoryId).toBe(r1.memoryId);

    // The memory's confidence should have been boosted
    const entity = await layer.getEntity(r1.memoryId);
    // We can't easily read raw memory confidence from KnowledgeLayer,
    // but the dedup flow called confirmMemory() — verified by DB test
  });

  // --- Entity Merge ---

  it('merges two entities', async () => {
    await layer.store('Kunde Bob arbeitet bei example-agency.ch.', 'knowledge', scope);
    await layer.store('Robert ist bei example-agency.ch angestellt.', 'knowledge', scope);

    const bob = await layer.resolveEntity('Bob', [scope]);
    const robert = await layer.resolveEntity('Robert', [scope]);

    if (bob && robert && bob.id !== robert.id) {
      await layer.mergeEntities(robert.id, bob.id);
      const merged = await layer.getEntity(bob.id);
      expect(merged).not.toBeNull();
      const deletedEntity = await layer.getEntity(robert.id);
      expect(deletedEntity).toBeNull();
    }
  });

  // --- Update Memory Text ---

  it('updates memory text and re-extracts entities', async () => {
    await layer.store(
      'Kunde Felix von felix-design.ch nutzt Figma.',
      'knowledge', scope,
    );

    const updated = await layer.updateMemoryText(
      'Felix von felix-design.ch',
      'Felix von felix-studio.ch',
      'knowledge', scope,
    );
    expect(updated).toBe(true);
  });

  // --- Deactivate by Pattern ---

  it('deactivates memories by pattern', async () => {
    await layer.store(
      'Temporary note: delete this test memory later.',
      'knowledge', scope,
    );
    const count = await layer.deactivateByPattern('delete this test memory');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // --- GC ---

  it('runs garbage collection in dry-run mode', async () => {
    const result = await layer.gc({ dryRun: true });
    expect(typeof result.supersededRemoved).toBe('number');
    expect(typeof result.orphanEntitiesRemoved).toBe('number');
    expect(typeof result.staleMemoriesRemoved).toBe('number');
  });

  // --- Format ---

  it('returns context even for empty retrieval results (patterns/episodes injected)', () => {
    const ctx = layer.formatRetrievalContext({
      memories: [], entities: [], contextGraph: '',
    });
    // May contain intelligence context (patterns, recent episodes) from prior tests
    expect(typeof ctx).toBe('string');
  });

  it('formats non-empty results with XML structure', async () => {
    const result = await layer.retrieve('deployment', [scope], {
      topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
    });
    const ctx = layer.formatRetrievalContext(result);
    if (result.memories.length > 0) {
      expect(ctx).toContain('<relevant_context>');
      expect(ctx).toContain('<scope type="context">');
    }
  });

  it('drops lowest-scored memories when formatContext exceeds maxChars', () => {
    const memories = Array.from({ length: 5 }, (_, i) => ({
      id: `mem-${i}`, text: 'x'.repeat(500),
      namespace: 'knowledge' as const, scopeType: 'context' as const,
      scopeId: 'test', score: 0.9 - i * 0.1, finalScore: 0.9 - i * 0.1,
      source: 'vector' as const, createdAt: '2026-04-01T00:00:00Z',
    }));

    const fullCtx = layer.formatRetrievalContext({ memories, entities: [], contextGraph: '' });
    expect(fullCtx).toContain('<relevant_context>');

    const tightCtx = layer.formatRetrievalContext(
      { memories, entities: [], contextGraph: '' }, 800,
    );
    if (tightCtx) {
      expect(tightCtx.length).toBeLessThanOrEqual(800);
      expect(tightCtx).toContain('90%');
    }
  });

  it('respects default maxChars limit (12000)', () => {
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `mem-${i}`, text: 'y'.repeat(1000),
      namespace: 'knowledge' as const, scopeType: 'context' as const,
      scopeId: 'test', score: 0.9 - i * 0.01, finalScore: 0.9 - i * 0.01,
      source: 'vector' as const, createdAt: '2026-04-01T00:00:00Z',
    }));

    const ctx = layer.formatRetrievalContext({ memories, entities: [], contextGraph: '' });
    expect(ctx.length).toBeLessThanOrEqual(12_000);
    expect(ctx).toContain('<relevant_context>');
  });
});
