import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hybridSlotClientConfig } from './session.js';
import { resolveTierModel, setTierSetResolver } from './tier-resolver.js';

/**
 * Regression for the hybrid hot-path 404 (caught on the v1.14 routing release
 * staging-walk): the main session run dispatched a cross-provider tier through
 * the AMBIENT client with only the model id swapped, so a chat-tier→Mistral slot
 * sent a Mistral model id to the Anthropic endpoint → 404 not_found.
 *
 * `hybridSlotClientConfig` is the seam `_createAgent` now uses to derive the
 * Agent's wire-level client config from the resolved per-tier snapshot. These
 * drive it through the REAL resolution flow (setTierSetResolver → resolveTierModel)
 * so a regression in either the tier-set resolution or the wire mapping fails.
 */
describe('hybridSlotClientConfig — hybrid hot-path routing', () => {
  beforeEach(() => setTierSetResolver({ routingMode: 'standard', tierSet: {} }));
  afterAll(() => setTierSetResolver({ routingMode: 'standard', tierSet: {} }));

  it('standard mode (same provider) → no client switch (byte-parity)', () => {
    const snap = resolveTierModel('balanced', 'anthropic');
    expect(hybridSlotClientConfig(snap, 'anthropic')).toEqual({ crossProviderSlot: false });
  });

  it('hybrid balanced→Mistral → routes to the openai WIRE (not the anthropic fallback) with the slot creds + model', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { balanced: { provider: 'mistral', model_id: 'ministral-14b-2512', api_key: 'sk-test', api_base_url: 'https://api.mistral.ai/v1' } },
    });
    const snap = resolveTierModel('balanced', 'anthropic');
    const cfg = hybridSlotClientConfig(snap, 'anthropic');
    expect(cfg.crossProviderSlot).toBe(true);
    if (!cfg.crossProviderSlot) throw new Error('expected a cross-provider slot');
    // The fix: mistral → 'openai' wire. Pre-fix the dispatch fell back to the
    // ambient anthropic client → the 404.
    expect(cfg.provider).toBe('openai');
    expect(cfg.apiBaseURL).toBe('https://api.mistral.ai/v1');
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.openaiModelId).toBe('ministral-14b-2512');
  });

  it('hybrid cross-provider slot routes by the WIRE even before creds are enriched (provider mismatch alone)', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'mistral', model_id: 'ministral-8b-2512' } },
    });
    const snap = resolveTierModel('fast', 'anthropic');
    const cfg = hybridSlotClientConfig(snap, 'anthropic');
    expect(cfg.crossProviderSlot).toBe(true);
    if (!cfg.crossProviderSlot) throw new Error('expected a cross-provider slot');
    expect(cfg.provider).toBe('openai');
    expect(cfg.openaiModelId).toBe('ministral-8b-2512');
  });

  it('hybrid SAME-provider slot (Anthropic → different Claude model) → no client switch, model-swap only', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-6' } },
    });
    const snap = resolveTierModel('deep', 'anthropic');
    expect(hybridSlotClientConfig(snap, 'anthropic')).toEqual({ crossProviderSlot: false });
  });

  it('standard managed-Mistral base (provider openai) → unchanged, no spurious switch', () => {
    const snap = resolveTierModel('balanced', 'openai');
    expect(hybridSlotClientConfig(snap, 'openai')).toEqual({ crossProviderSlot: false });
  });
});
