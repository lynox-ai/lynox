import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveTierModel, setTierSetResolver, getActiveRoutingMode } from './tier-resolver.js';
import { getModelId, getBetasForProvider, type ModelTier, type LLMProvider } from '../types/index.js';

const TIERS: ModelTier[] = ['fast', 'balanced', 'deep'];
const PROVIDERS: LLMProvider[] = ['anthropic', 'vertex', 'custom', 'openai'];

// PR-2: resolveTierModel is the provider snapshot every direct LLM-call site
// resolves through. These assert byte-parity with the previous inline
// `getModelId(tier, provider)` + `isCustomProvider() ? {} : { betas }`.
describe('resolveTierModel — provider snapshot (PR-2)', () => {
  it('modelId matches getModelId for every tier x provider', () => {
    for (const tier of TIERS) {
      for (const p of PROVIDERS) {
        expect(resolveTierModel(tier, p).modelId).toBe(getModelId(tier, p));
      }
    }
  });

  it('carries the resolved provider through', () => {
    for (const p of PROVIDERS) expect(resolveTierModel('fast', p).provider).toBe(p);
  });

  it('Anthropic + Vertex carry beta headers (the old non-custom branch)', () => {
    expect(resolveTierModel('fast', 'anthropic').betas).toEqual(getBetasForProvider('anthropic'));
    expect(resolveTierModel('deep', 'vertex').betas).toEqual(getBetasForProvider('vertex'));
  });

  it('custom + openai omit betas (undefined — the old isCustomProvider() omission)', () => {
    expect(resolveTierModel('fast', 'custom').betas).toBeUndefined();
    expect(resolveTierModel('fast', 'openai').betas).toBeUndefined();
  });

  it('the betas spread reproduces the old conditional exactly', () => {
    // Anthropic → { betas: [...] }; openai → {} (key entirely omitted).
    const a = resolveTierModel('balanced', 'anthropic');
    const o = resolveTierModel('balanced', 'openai');
    expect({ ...(a.betas ? { betas: a.betas } : {}) }).toEqual({ betas: getBetasForProvider('anthropic') });
    expect({ ...(o.betas ? { betas: o.betas } : {}) }).toEqual({});
  });
});

// PR-3a: hybrid Tier-Set resolution. A configured slot overrides the base
// provider/model/creds for its tier; standard mode ignores the set entirely.
describe('resolveTierModel — hybrid Tier-Set (PR-3a)', () => {
  afterEach(() => setTierSetResolver({ routingMode: 'standard', tierSet: null }));

  it('standard mode ignores a configured tier_set (byte-parity)', () => {
    setTierSetResolver({
      routingMode: 'standard',
      tierSet: { fast: { provider: 'mistral', model_id: 'ministral-8b-2512' } },
    });
    const snap = resolveTierModel('fast', 'anthropic');
    expect(snap.provider).toBe('anthropic');
    expect(snap.modelId).toBe(getModelId('fast', 'anthropic'));
    expect(snap.apiKey).toBeUndefined();
  });

  it('a hybrid slot overrides provider + model + per-slot creds', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: {
        fast: {
          provider: 'mistral',
          model_id: 'ministral-8b-2512',
          api_key: 'slot-key',
          api_base_url: 'https://api.mistral.ai/v1',
        },
      },
    });
    const snap = resolveTierModel('fast', 'anthropic');
    expect(snap.provider).toBe('mistral');
    expect(snap.modelId).toBe('ministral-8b-2512');
    expect(snap.betas).toBeUndefined(); // mistral = openai wire → no betas
    expect(snap.apiKey).toBe('slot-key');
    expect(snap.apiBaseURL).toBe('https://api.mistral.ai/v1');
  });

  it('a tier with no slot falls back to the base provider', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'mistral', model_id: 'ministral-8b-2512' } },
    });
    const snap = resolveTierModel('deep', 'anthropic');
    expect(snap.provider).toBe('anthropic');
    expect(snap.modelId).toBe(getModelId('deep', 'anthropic'));
    expect(snap.apiKey).toBeUndefined();
  });

  it('an Anthropic hybrid slot keeps beta headers', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-6' } },
    });
    const snap = resolveTierModel('deep', 'openai');
    expect(snap.provider).toBe('anthropic');
    expect(snap.modelId).toBe('claude-opus-4-6');
    expect(snap.betas).toEqual(getBetasForProvider('anthropic'));
  });

  it('an unknown hybrid slot provider gets no betas (safe default, not wrong ones)', () => {
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: { fast: { provider: 'unregistered-x', model_id: 'some-model' } },
    });
    const snap = resolveTierModel('fast', 'anthropic');
    expect(snap.provider).toBe('unregistered-x');
    expect(snap.betas).toBeUndefined();
  });

  it('getActiveRoutingMode reflects the configured mode', () => {
    setTierSetResolver({ routingMode: 'hybrid' });
    expect(getActiveRoutingMode()).toBe('hybrid');
    setTierSetResolver({ routingMode: 'standard' });
    expect(getActiveRoutingMode()).toBe('standard');
  });
});
