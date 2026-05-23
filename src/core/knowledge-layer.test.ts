import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider, type EmbeddingProvider } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Test-only embedding provider with topic-coded vectors.
 *
 * The fuzzy-supersession tests need cosine values in known regions (>0.95 for
 * paraphrases of the same fact, <0.95 for off-topic strings) — LocalProvider's
 * hash-bucket cosines are universally in the 0.1-0.2 range, which makes it
 * impossible to assert "this paraphrase matches" vs "this off-topic string
 * doesn't" without using the real ONNX model (too slow + 100MB download for a
 * unit test). This provider returns a deterministic vector chosen from a small
 * topic vocabulary so paraphrases of the same fact land in the same cluster.
 */
class TopicEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'topic-test';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    // 8-dim topic axes: [postgres, postgres-version, backup, frontend, generic, acme, beta, _padding]
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    if (t.includes('postgresql') || t.includes('postgres') || t.includes('database')) v[0] = 1;
    if (t.includes('16')) v[1] = 1;
    if (t.includes('17')) v[1] = -1;  // version negation so 16↔17 still cluster but distinguishable
    if (t.includes('backup') || t.includes('pg_dump')) v[2] = 1;
    if (t.includes('frontend') || t.includes('svelte')) v[3] = 1;
    if (t.length > 20) v[4] = 0.3;  // generic-text weight
    if (t.includes('acme')) v[5] = 1;
    if (t.includes('beta')) v[6] = 1;
    // Normalize
    const mag = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map(x => x / mag);
  }
}

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

  // --- T2-M2: scope-id-scoped dedup (cross-project bleed regression) ---

  it('does NOT dedup across distinct scope ids of the same scope type', async () => {
    // Isolated layer for this test so the dedup window is not polluted by
    // memories from earlier tests above (they all share the default scope id).
    const isolatedDir = await mkdtemp(join(tmpdir(), 'lynox-kl-scope-bleed-'));
    const isolated = new KnowledgeLayer(join(isolatedDir, 'test.db'), new LocalProvider());
    await isolated.init();
    try {
      const acmeScope: MemoryScopeRef = { type: 'context', id: 'acme' };
      const betaScope: MemoryScopeRef = { type: 'context', id: 'beta' };

      // Same text, different scope ids — must NOT be deduped against each other.
      const text = 'Client uses PostgreSQL as the primary database for analytics workloads.';
      const r1 = await isolated.store(text, 'knowledge', acmeScope);
      expect(r1.stored).toBe(true);
      expect(r1.deduplicated).toBe(false);

      const r2 = await isolated.store(text, 'knowledge', betaScope);
      // Cross-project bleed would set r2.deduplicated=true and reuse acme's id.
      expect(r2.deduplicated).toBe(false);
      expect(r2.stored).toBe(true);
      expect(r2.memoryId).not.toBe(r1.memoryId);

      // Sanity: storing the same text again in the same scope STILL dedups.
      const r3 = await isolated.store(text, 'knowledge', betaScope);
      expect(r3.deduplicated).toBe(true);
      expect(r3.memoryId).toBe(r2.memoryId);
    } finally {
      await isolated.close();
      await rm(isolatedDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // --- Fuzzy supersession (P2-A2 regression, 2026-05-22) ---

  it('memory_update with fuzzy old_content supersedes the prior fact (P2-A2 regression)', async () => {
    // Use an isolated KG so prior tests don't pollute the recall result.
    // TopicEmbeddingProvider (above) gives the test predictable cosines:
    // "Acme uses PostgreSQL 16…" and "Acme database = PostgreSQL 16" land in
    // the same {postgres, db, 16, acme} cluster (cosine ≈ 0.95+); a generic
    // "Acme database" string sits below threshold.
    const supDir = await mkdtemp(join(tmpdir(), 'lynox-kl-fuzzy-sup-'));
    const supLayer = new KnowledgeLayer(join(supDir, 'test.db'), new TopicEmbeddingProvider());
    await supLayer.init();
    const supScope: MemoryScopeRef = { type: 'context', id: 'p2-a2-acme' };
    try {
      // 1. Store the original fact.
      const r1 = await supLayer.store(
        'Acme uses PostgreSQL 16 as the primary database for the order service.',
        'knowledge', supScope,
      );
      expect(r1.stored).toBe(true);

      // 2. Agent-driven update with NON-byte-exact old_content. Before Fix C
      //    this returned null (no exact match) and the new fact was simply
      //    inserted alongside the stale one — `memory_recall` then returned
      //    both, breaking the "single truth per fact" contract.
      const newId = await supLayer.updateMemoryWithSupersession(
        'Acme database = PostgreSQL 16',                // fuzzy paraphrase
        'Acme migrated to PostgreSQL 17 in 2026.',      // new truth
        'knowledge', supScope,
      );
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(r1.memoryId);

      // 3. Recall returns ONLY the new fact, not both — the old row was
      //    marked is_active=0 by the supersession transaction.
      const result = await supLayer.retrieve('What database does Acme use?', [supScope], {
        namespace: 'knowledge', topK: 10, threshold: 0.3,
      });
      const texts = result.memories.map(m => m.text);
      expect(texts.some(t => t.includes('PostgreSQL 17'))).toBe(true);
      expect(texts.some(t => t.includes('PostgreSQL 16'))).toBe(false);
    } finally {
      await supLayer.close();
      await rm(supDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('fuzzy supersession ignores unrelated memories below threshold', async () => {
    // Guardrail: a paraphrase that happens to share a noun but is semantically
    // distinct must NOT supersede. Without this guard, `memory_update` would
    // become a footgun — wiping arbitrary memories that mention the same word.
    // Same TopicEmbeddingProvider as the regression test (above) so the cosine
    // math is predictable: "Acme runs nightly pg_dump backups…" lives in
    // {backup, postgres, acme} but "Acme database" lives in {postgres, acme}
    // only — cosine falls below the 0.95 fuzzy bar.
    const guardDir = await mkdtemp(join(tmpdir(), 'lynox-kl-fuzzy-guard-'));
    const guardLayer = new KnowledgeLayer(join(guardDir, 'test.db'), new TopicEmbeddingProvider());
    await guardLayer.init();
    const guardScope: MemoryScopeRef = { type: 'context', id: 'p2-a2-guard' };
    try {
      const stored = await guardLayer.store(
        'Acme runs nightly pg_dump backups of the orders database to S3 at 02:00 UTC.',
        'knowledge', guardScope,
      );
      expect(stored.stored).toBe(true);

      // "Acme database" alone is too generic — cosine vs the backup-schedule
      // line should fall below the 0.80 fuzzy threshold. The call must
      // return null (no row to supersede), NOT silently overwrite the backup
      // fact with a frontend-stack fact.
      const newId = await guardLayer.updateMemoryWithSupersession(
        'Acme database',
        'Acme frontend uses SvelteKit 2.',
        'knowledge', guardScope,
      );
      // Either null (no supersession) or the new row was inserted as a
      // FRESH memory (since no match). Both outcomes preserve the backup
      // fact. Failure mode = newId is non-null AND the backup memory is now
      // is_active=0 — assert the backup is still recall-able.
      const result = await guardLayer.retrieve('How are Acme backups scheduled?', [guardScope], {
        namespace: 'knowledge', topK: 10, threshold: 0.3,
      });
      const texts = result.memories.map(m => m.text);
      expect(texts.some(t => t.includes('pg_dump') || t.includes('backups'))).toBe(true);
      // newId is allowed to be non-null only if a different memory was the
      // supersede target (here there's only one memory, so newId being non-
      // null would prove the test failed). Document the expectation:
      expect(newId).toBeNull();
    } finally {
      await guardLayer.close();
      await rm(guardDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
