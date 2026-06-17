import { describe, it, expect } from 'vitest';
import { resolveRunModel } from './tier-resolver.js';
import { getModelId, type ModelTier, type LLMProvider } from '../types/index.js';

type AccountTier = 'standard' | 'pro' | undefined;

describe('resolveRunModel — gate → clamp → provider, the single chokepoint', () => {
  // Exhaustive tier-resolution table. modelId is asserted indirectly via
  // getModelId(expectedTier, provider) so the test survives model-id refreshes.
  const cases: Array<{
    name: string;
    requested: string | undefined;
    defaultTier: ModelTier;
    accountTier: AccountTier;
    maxTier: ModelTier | undefined;
    expectTier: ModelTier;
  }> = [
    // ── OVERRIDE GATE: retired to a pass-through (D8) — any account, any tier ──
    { name: 'standard requesting deep → NOT gated (gate retired), stays deep', requested: 'deep', defaultTier: 'balanced', accountTier: 'standard', maxTier: undefined, expectTier: 'deep' },
    { name: 'unset account (self-host/BYOK) requesting deep → stays deep', requested: 'deep', defaultTier: 'balanced', accountTier: undefined, maxTier: undefined, expectTier: 'deep' },
    { name: 'pro requesting deep → stays deep', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: undefined, expectTier: 'deep' },

    // ── CLAMP: cost ceiling ──────────────────────────────────────────────
    { name: 'pro deep clamped down to balanced by max_tier', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'balanced', expectTier: 'balanced' },
    { name: 'pro deep clamped down to fast by max_tier', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'fast', expectTier: 'fast' },
    { name: 'balanced unaffected by a deep ceiling', requested: 'balanced', defaultTier: 'fast', accountTier: 'standard', maxTier: 'deep', expectTier: 'balanced' },

    // ── CLAMP is now the ONLY cap (the NEW-1 / F7 repro) ─────────────────
    // The fast ceiling must clamp a deep request. The bug was the spawn path
    // skipping the clamp → delivering deep past the cap. With the gate retired
    // the clamp is the sole cost cap, so covering it matters more, not less.
    { name: 'max_tier fast + requested deep → clamped to fast (NOT deep)', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'fast', expectTier: 'fast' },
    // A deep request under a deep ceiling stays deep for ANY account — no gate
    // downgrades it and the ceiling permits it.
    { name: 'standard + max_tier deep + hint deep → stays deep (no gate; ceiling permits)', requested: 'deep', defaultTier: 'balanced', accountTier: 'standard', maxTier: 'deep', expectTier: 'deep' },

    // ── DEFAULT path (no request) ────────────────────────────────────────
    { name: 'no request → uses defaultTier (clamped)', requested: undefined, defaultTier: 'balanced', accountTier: 'standard', maxTier: undefined, expectTier: 'balanced' },
    { name: 'no request, fast default', requested: undefined, defaultTier: 'fast', accountTier: 'pro', maxTier: undefined, expectTier: 'fast' },
    // A role/config DEFAULT with no override stays as configured — a role
    // configured for deep is trusted (and, post-D8, an explicit deep override is
    // equally trusted; only the clamp can lower either).
    { name: 'deep DEFAULT (no override) → stays deep', requested: undefined, defaultTier: 'deep', accountTier: 'standard', maxTier: undefined, expectTier: 'deep' },
    // …but the cost CEILING still clamps the default — this is the clamp the spawn
    // path skipped (the NEW-1 mechanism), and it applies regardless of the gate.
    { name: 'deep default + max_tier balanced → clamped to balanced', requested: undefined, defaultTier: 'deep', accountTier: 'standard', maxTier: 'balanced', expectTier: 'balanced' },

    // ── LEGACY aliases accepted at the boundary ──────────────────────────
    { name: 'legacy opus + pro → deep', requested: 'opus', defaultTier: 'balanced', accountTier: 'pro', maxTier: undefined, expectTier: 'deep' },
    { name: 'legacy sonnet → balanced', requested: 'sonnet', defaultTier: 'fast', accountTier: 'standard', maxTier: undefined, expectTier: 'balanced' },
    { name: 'legacy haiku → fast', requested: 'haiku', defaultTier: 'balanced', accountTier: 'pro', maxTier: undefined, expectTier: 'fast' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = resolveRunModel({
        requested: c.requested,
        defaultTier: c.defaultTier,
        accountTier: c.accountTier,
        maxTier: c.maxTier,
        provider: 'anthropic',
      });
      expect(r.tier).toBe(c.expectTier);
      expect(r.modelId).toBe(getModelId(c.expectTier, 'anthropic'));
    });
  }

  it('passes a genuine model id through verbatim, deriving a tier from the default', () => {
    const r = resolveRunModel({
      requested: 'claude-opus-4-7',
      defaultTier: 'balanced',
      accountTier: 'pro',
      maxTier: 'fast',
      provider: 'anthropic',
    });
    expect(r.modelId).toBe('claude-opus-4-7'); // pinned id, not gated/clamped
    expect(r.tier).toBe('fast'); // derived from default: gate(balanced)=balanced → clamp(fast)
  });

  it('treats an empty-string request as absent (falls back to the default tier)', () => {
    // `model: ''` is type-legal on a manifest step; it must coalesce to the
    // default, not pass through as an empty model id.
    const r = resolveRunModel({ requested: '', defaultTier: 'balanced', accountTier: 'standard', maxTier: undefined, provider: 'anthropic' });
    expect(r.tier).toBe('balanced');
    expect(r.modelId).toBe(getModelId('balanced', 'anthropic'));
  });

  it('threads the active provider into the model id', () => {
    for (const provider of ['anthropic', 'openai'] as LLMProvider[]) {
      const r = resolveRunModel({ requested: 'balanced', defaultTier: 'fast', accountTier: 'pro', maxTier: undefined, provider });
      expect(r.modelId).toBe(getModelId('balanced', provider));
    }
  });
});
