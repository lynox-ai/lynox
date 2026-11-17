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
const mockShouldExtractV2 = vi.hoisted(() => vi.fn(() => true));
vi.mock('./entity-extractor-v2.js', async (importActual) => ({
  ...(await importActual<typeof import('./entity-extractor-v2.js')>()),
  shouldExtractV2: mockShouldExtractV2,
  extractEntitiesV2: mockExtractV2,
}));
// The V1 extractor, used by the pre-cutover text-update re-extraction. Its gate test
// (`shouldUseLLMExtraction`) stays real.
const mockExtractV1 = vi.hoisted(() => vi.fn());
vi.mock('./entity-extractor.js', async (importActual) => ({
  ...(await importActual<typeof import('./entity-extractor.js')>()),
  extractEntities: mockExtractV1,
}));

import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { configurePersistentBudget, resetPersistentBudget } from './session-budget.js';

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
    mockShouldExtractV2.mockReset();
    mockShouldExtractV2.mockReturnValue(true);
    mockExtractV1.mockReset();
    mockExtractV1.mockResolvedValue({ entities: [], relations: [], costUsd: 0.0001 });
    mockExtractV2.mockResolvedValue({
      entities: [{ canonicalName: 'Acme', type: 'organization', confidence: 0.9, aliases: [], evidenceSpan: 'Acme' }],
      relations: [],
      costUsd: 0.0005,
    });
  });

  afterEach(async () => {
    resetPersistentBudget();
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

  it('runs extraction undebited when no metered host is set (self-host, under the caps)', async () => {
    const res = await layer.store(text, 'knowledge', scope);
    expect(mockExtractV2).toHaveBeenCalledOnce();
    expect(res.entities.length).toBe(1);
  });

  it('skips extraction but still stores the memory when the daily cap is reached with no host', async () => {
    const today = new Date().toISOString().slice(0, 10);
    configurePersistentBudget({
      costProvider: { getCostByDay: () => [{ day: today, cost_usd: 5, run_count: 1 }] },
      dailyCapUSD: 5, monthlyCapUSD: 500,
    });

    const res = await layer.store(text, 'knowledge', scope);

    expect(mockExtractV2).not.toHaveBeenCalled();
    expect(res.entities.length).toBe(0);
    expect(res.stored).toBe(true);
  });

  it('runs extraction with no host when spend is under the cap', async () => {
    const today = new Date().toISOString().slice(0, 10);
    configurePersistentBudget({
      costProvider: { getCostByDay: () => [{ day: today, cost_usd: 4.99, run_count: 1 }] },
      dailyCapUSD: 5, monthlyCapUSD: 500,
    });

    const res = await layer.store(text, 'knowledge', scope);

    expect(mockExtractV2).toHaveBeenCalledOnce();
    expect(res.entities.length).toBe(1);
  });

  describe('the gate runs only for an extraction that calls a model', () => {
    const today = new Date().toISOString().slice(0, 10);
    const atCap = () => configurePersistentBudget({
      costProvider: { getCostByDay: () => [{ day: today, cost_usd: 5, run_count: 1 }] },
      dailyCapUSD: 5, monthlyCapUSD: 500,
    });

    it('a text the extractors read without a model is not gated, and its extraction still runs at the cap', async () => {
      atCap();
      mockShouldExtractV2.mockReturnValue(false);
      const onBeforeRun = vi.fn();
      layer.setMeteredHost({ getHooks: () => [{ onBeforeRun }], getContext: () => undefined });

      // `status` is a namespace the V1 extractor never sends to a model.
      const res = await layer.store('Acme Corp signed with Beta GmbH in Zurich last week.', 'status', scope);

      expect(onBeforeRun).not.toHaveBeenCalled();
      expect(mockExtractV2).not.toHaveBeenCalled();
      expect(res.stored).toBe(true);
      // The extraction runs (its regex step is free); it is only the model call that the cap stops.
      expect(mockExtractV1).toHaveBeenCalledOnce();
    });

    it('a V1 extraction that would call a model is gated and blocked at the cap', async () => {
      atCap();
      mockShouldExtractV2.mockReturnValue(false);

      // `knowledge`, at least 30 characters: the V1 extractor would send this to a model.
      const res = await layer.store(text, 'knowledge', scope);

      expect(res.stored).toBe(true);
      expect(mockExtractV1).not.toHaveBeenCalled();
      expect(mockExtractV2).not.toHaveBeenCalled();
    });

    it('a text update the extractor reads without a model still runs its extraction at the cap', async () => {
      const original = 'Acme Corp signed with Beta GmbH in Zurich last week.';
      await layer.store(original, 'status', scope);
      mockExtractV1.mockClear();
      atCap();

      const changed = await layer.updateMemoryText(original, `${original} Renewed.`, 'status', scope);

      expect(changed).toBe(true);
      expect(mockExtractV1).toHaveBeenCalledOnce();
    });

    it('the text-update re-extraction is not made at the cap, with no host', async () => {
      const stored = await layer.store(text, 'knowledge', scope);
      expect(stored.stored).toBe(true);
      atCap();

      const changed = await layer.updateMemoryText(text, `${text} They renewed for two years.`, 'knowledge', scope);

      expect(changed).toBe(true);
      expect(mockExtractV1).not.toHaveBeenCalled();
    });

    it('the text-update re-extraction is made under the cap, with no host', async () => {
      await layer.store(text, 'knowledge', scope);

      const changed = await layer.updateMemoryText(text, `${text} They renewed for two years.`, 'knowledge', scope);

      expect(changed).toBe(true);
      expect(mockExtractV1).toHaveBeenCalledOnce();
    });
  });
});
