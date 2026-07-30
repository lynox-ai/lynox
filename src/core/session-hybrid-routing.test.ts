import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hybridSlotClientConfig } from './session.js';
import { resolveTierModel, setTierSetResolver, effectiveProviderForRun } from './tier-resolver.js';
import { modelIdentityContext, providerFamilyLabel } from './prompts.js';

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

/**
 * The identity prompt has TWO writers — the live agent prompt and the run-snapshot
 * mirror that records what the agent saw — and they disagreed on the hybrid case.
 * The mirror named the BASE config's provider, so a `balanced→Mistral` slot on an
 * Anthropic base recorded "You are running on Anthropic (Claude family) as model
 * `mistral-medium-2604`". Wrong, self-contradicting (its own tier map said
 * Mistral), and wrong in the exact artifact used to diagnose provider behaviour —
 * found in a real prod snapshot (rafael, 2026-07-30).
 *
 * These drive the shared resolver through the REAL tier-set flow. The last case is
 * the one that matters: it asserts the two writers AGREE, which is the property
 * that broke — a per-writer assertion would have passed on the broken code.
 */
describe('effectiveProviderForRun — which provider the identity prompt names', () => {
  beforeEach(() => setTierSetResolver({ routingMode: 'standard', tierSet: {} }));
  afterAll(() => setTierSetResolver({ routingMode: 'standard', tierSet: {} }));

  const noOverride = { hasProfileOverride: false, profileOverrideProvider: undefined } as const;

  it('standard mode → the base config provider', () => {
    const snap = resolveTierModel('balanced', 'anthropic');
    expect(effectiveProviderForRun(snap, 'anthropic', { ...noOverride, configProvider: 'anthropic' })).toBe('anthropic');
  });

  it('hybrid balanced→Mistral on an Anthropic base → names the SLOT (openai wire), not the base', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { balanced: { provider: 'mistral', model_id: 'mistral-medium-2604', api_key: 'sk-test', api_base_url: 'https://api.mistral.ai/v1' } },
    });
    const snap = resolveTierModel('balanced', 'anthropic');
    // Pre-fix the snapshot mirror returned 'anthropic' here → "Anthropic (Claude family)".
    expect(effectiveProviderForRun(snap, 'anthropic', { ...noOverride, configProvider: 'anthropic' })).toBe('openai');
  });

  it('an explicit sub-agent profile pins its own provider and ignores the slot', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { balanced: { provider: 'mistral', model_id: 'mistral-medium-2604' } },
    });
    const snap = resolveTierModel('balanced', 'anthropic');
    expect(effectiveProviderForRun(snap, 'anthropic', {
      hasProfileOverride: true,
      profileOverrideProvider: 'anthropic',
      configProvider: 'anthropic',
    })).toBe('anthropic');
  });

  // Scope note: this checks ONE rendered block against itself — the sentence vs
  // the tier line below it, which is the self-contradiction the prod snapshot
  // showed. It does NOT prove the two WRITERS agree; that is now true by
  // construction (`Session._identityContext` is the only expression building it),
  // because a test asserting the agreement passed even with the mirror reverted.
  it('the rendered identity line and its own tier map name the SAME provider family', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { balanced: { provider: 'mistral', model_id: 'mistral-medium-2604', api_key: 'sk-test', api_base_url: 'https://api.mistral.ai/v1' } },
    });
    const snap = resolveTierModel('balanced', 'anthropic');
    const identityProvider = effectiveProviderForRun(snap, 'anthropic', { ...noOverride, configProvider: 'anthropic' });
    const tierMap = (['fast', 'balanced', 'deep'] as const).map((tier) => {
      const s = resolveTierModel(tier, 'anthropic');
      return { tier, modelId: s.modelId, providerLabel: providerFamilyLabel(s.provider) };
    });
    const out = modelIdentityContext(identityProvider, snap.modelId, tierMap);
    // The self-contradiction the prod snapshot showed: the sentence said Anthropic
    // while the balanced line right below it said Mistral.
    expect(out).toContain('You are running on Mistral');
    expect(out).not.toContain('You are running on Anthropic');
    expect(out).toContain('`mistral-medium-2604` — the `balanced` tier (Mistral');
  });
});
