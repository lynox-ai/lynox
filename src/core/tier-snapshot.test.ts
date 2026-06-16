import { describe, it, expect } from 'vitest';
import { resolveTierModel } from './tier-resolver.js';
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
