import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLayer } from './knowledge-layer.js';
import type { EmbeddingProvider } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * The dedup gate (knowledge-layer store step 2) confirms a near-duplicate instead
 * of storing it. It is subject-blind: at ≥0.95 similarity a cross-project near-twin
 * carrying the SAME value ("Orion budget is 30000" vs "Vega budget is 30000") trips
 * NO heuristic contradiction (same number) → without the subject-agreement guard it
 * is absorbed as a confirmation of the WRONG project's fact — silent data loss, the
 * same class as the supersede veto but at the dedup gate.
 *
 * A constant-vector embedder forces every pair to cosine 1.0 so the dedup branch is
 * always entered — isolating the guard as the only thing that can prevent the merge.
 */
class ConstantEmbedder implements EmbeddingProvider {
  readonly name = 'const-test';
  readonly dimensions = 8;
  async embed(): Promise<number[]> {
    return [1, 0, 0, 0, 0, 0, 0, 0];
  }
}

describe('KnowledgeLayer — cross-subject dedup veto', () => {
  let layer: KnowledgeLayer;
  let dir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'http-api' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-kl-dedupveto-'));
    layer = new KnowledgeLayer(join(dir, 'test.db'), new ConstantEmbedder());
    await layer.init();
  });

  afterEach(async () => {
    await layer.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('does NOT dedup-merge a same-value fact about a DIFFERENT subject', async () => {
    const first = await layer.store('Orion budget is 30000 per year', 'knowledge', scope);
    expect(first.stored).toBe(true);

    // Same value, different project — cosine 1.0 → dedup candidate, no heuristic
    // contradiction (same number). The guard must send it to store-as-new, not merge.
    const second = await layer.store('Vega budget is 30000 per year', 'knowledge', scope);
    expect(second.deduplicated).toBe(false);
    expect(second.stored).toBe(true);
    expect(second.memoryId).not.toBe(first.memoryId);
  });

  it('still dedups a genuine repeat of the SAME subject', async () => {
    const first = await layer.store('Orion budget is 30000 per year', 'knowledge', scope);
    expect(first.stored).toBe(true);

    const repeat = await layer.store('Orion budget is 30000 per year', 'knowledge', scope);
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.stored).toBe(false);
    expect(repeat.memoryId).toBe(first.memoryId);
  });
});
