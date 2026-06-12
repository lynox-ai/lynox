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
    // ── GATE: deep is Pro-only ───────────────────────────────────────────
    { name: 'standard requesting deep → downgraded to balanced', requested: 'deep', defaultTier: 'balanced', accountTier: 'standard', maxTier: undefined, expectTier: 'balanced' },
    { name: 'unset account (self-host/BYOK) requesting deep → NOT gated, stays deep', requested: 'deep', defaultTier: 'balanced', accountTier: undefined, maxTier: undefined, expectTier: 'deep' },
    { name: 'pro requesting deep → deep survives the gate', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: undefined, expectTier: 'deep' },

    // ── CLAMP: cost ceiling ──────────────────────────────────────────────
    { name: 'pro deep clamped down to balanced by max_tier', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'balanced', expectTier: 'balanced' },
    { name: 'pro deep clamped down to fast by max_tier', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'fast', expectTier: 'fast' },
    { name: 'balanced unaffected by a deep ceiling', requested: 'balanced', defaultTier: 'fast', accountTier: 'standard', maxTier: 'deep', expectTier: 'balanced' },

    // ── COMBINED: the NEW-1 / F7 repro — both gates must apply ────────────
    // Pro opens the gate, but the fast ceiling must still clamp. The bug was
    // the spawn path applying ONLY the gate → delivering deep past the cap.
    { name: 'pro + max_tier fast + requested deep → clamped to fast (NOT deep)', requested: 'deep', defaultTier: 'balanced', accountTier: 'pro', maxTier: 'fast', expectTier: 'fast' },
    // A non-pro session step-hint requesting deep must be gated even though the
    // ceiling alone (deep) would let it through — the session path applied only
    // the clamp before.
    { name: 'standard + max_tier deep + hint deep → gated to balanced', requested: 'deep', defaultTier: 'balanced', accountTier: 'standard', maxTier: 'deep', expectTier: 'balanced' },

    // ── DEFAULT path (no request) ────────────────────────────────────────
    { name: 'no request → uses defaultTier (gated+clamped)', requested: undefined, defaultTier: 'balanced', accountTier: 'standard', maxTier: undefined, expectTier: 'balanced' },
    { name: 'no request, fast default', requested: undefined, defaultTier: 'fast', accountTier: 'pro', maxTier: undefined, expectTier: 'fast' },
    // A role/config DEFAULT is NOT gated (only explicit overrides are) — a role
    // configured for deep is trusted; this preserves applyTierGate's contract.
    { name: 'deep DEFAULT is not gated (no override) → stays deep', requested: undefined, defaultTier: 'deep', accountTier: 'standard', maxTier: undefined, expectTier: 'deep' },
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
