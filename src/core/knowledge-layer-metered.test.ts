import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { MemoryScopeRef } from '../types/index.js';

// Control the pool-key extractor so we assert the managed gate + debit around it
// WITHOUT a real provider call. shouldExtractV2 forced true so store() takes the
// V2 path; extractEntitiesV2 returns a known cost.
const mockExtractV2 = vi.hoisted(() => vi.fn());
vi.mock('./entity-extractor-v2.js', async (importActual) => ({
  ...(await importActual<typeof import('./entity-extractor-v2.js')>()),
  shouldExtractV2: () => true,
  extractEntitiesV2: mockExtractV2,
}));

import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';

describe('KnowledgeLayer — managed KG-extraction gate + debit', () => {
  let dir: string;
  let layer: KnowledgeLayer;
  const scope: MemoryScopeRef = { type: 'context', id: 'meter-test' };
  // Contradiction detection is heuristic/embedding-based (no LLM), and the only
  // client consumer in store() is the mocked extractor, so an empty stub is safe.
  const fakeClient = {} as unknown as Anthropic;
  const text = 'Acme Corp is our new enterprise customer in Zurich.';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-kl-meter-'));
    layer = new KnowledgeLayer(join(dir, 'test.db'), new LocalProvider(), fakeClient);
    await layer.init();
    mockExtractV2.mockReset();
    mockExtractV2.mockResolvedValue({
      entities: [{ canonicalName: 'Acme', type: 'organization', confidence: 0.9, aliases: [], evidenceSpan: 'Acme' }],
      relations: [],
      costUsd: 0.0005,
    });
  });

  afterEach(async () => {
    await layer.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('gates before extraction and debits the reported cost, keyed on the gate run id', async () => {
    const onBeforeRun = vi.fn();
    const onAfterRun = vi.fn();
    layer.setMeteredHost({ getHooks: () => [{ onBeforeRun, onAfterRun }], getContext: () => undefined });

    const res = await layer.store(text, 'knowledge', scope);

    expect(onBeforeRun).toHaveBeenCalledOnce();
    expect(mockExtractV2).toHaveBeenCalledOnce();
    expect(onAfterRun).toHaveBeenCalledOnce();
    const debitRunId = onAfterRun.mock.calls[0]?.[0] as string;
    const cost = onAfterRun.mock.calls[0]?.[1] as number;
    expect(cost).toBeCloseTo(0.0005, 6);
    // Same run id as the gate → the CP dedups the debit against the gate.
    expect(debitRunId).toBe(onBeforeRun.mock.calls[0]?.[0]);
    expect(res.entities.length).toBe(1);
  });

  it('skips extraction entirely when the gate blocks (exhausted tenant) — no spend, no debit', async () => {
    const onBeforeRun = vi.fn().mockRejectedValue(new Error('AI budget for this period reached.'));
    const onAfterRun = vi.fn();
    layer.setMeteredHost({ getHooks: () => [{ onBeforeRun, onAfterRun }], getContext: () => undefined });

    const res = await layer.store(text, 'knowledge', scope);

    expect(onBeforeRun).toHaveBeenCalledOnce();
    // Blocked → the pool-key extractor is never invoked and nothing is debited.
    expect(mockExtractV2).not.toHaveBeenCalled();
    expect(onAfterRun).not.toHaveBeenCalled();
    expect(res.entities.length).toBe(0);
    // The memory itself is still stored — extraction is best-effort enrichment.
    expect(res.stored).toBe(true);
  });

  it('runs extraction ungated + undebited when no metered host is set (self-host)', async () => {
    const res = await layer.store(text, 'knowledge', scope);
    expect(mockExtractV2).toHaveBeenCalledOnce();
    expect(res.entities.length).toBe(1);
  });
});
