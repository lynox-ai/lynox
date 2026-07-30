import { describe, it, expect } from 'vitest';
import { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey } from './billing-tier.js';
import { CANONICAL_BILLING_TIERS, LEGACY_BILLING_TIER_ALIASES } from '../contract/vocab.js';

// Behaviour spec for the shim. The old hand-maintained TRUTH table (one of
// three wordgleiche copies across core/pro/web-ui) is gone: the vocabulary now
// has ONE source of truth (`src/contract/vocab.ts`); the semantic literals are
// pinned in tests/doc-drift.test.ts and the copies are guarded structurally
// (tests/contract-drift.test.ts + pro's contract-sync job).
describe('src/server/billing-tier.ts shim', () => {
  it('accepts every canonical tier as itself', () => {
    for (const tier of CANONICAL_BILLING_TIERS) {
      expect(normalizeBillingTier(tier)).toBe(tier);
      expect(isHostedInstance(tier)).toBe(true);
    }
  });

  it('maps every legacy alias to its canonical tier', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_BILLING_TIER_ALIASES)) {
      expect(normalizeBillingTier(legacy)).toBe(canonical);
      expect(isHostedInstance(legacy)).toBe(true);
    }
  });

  it('cpSuppliesLLMKey is true exactly for the CP-key tiers', () => {
    expect(cpSuppliesLLMKey('managed')).toBe(true);
    expect(cpSuppliesLLMKey('managed_pro')).toBe(true);
    expect(cpSuppliesLLMKey('hosted')).toBe(false); // BYOK
    expect(cpSuppliesLLMKey('eu')).toBe(true); // legacy alias of managed
    expect(cpSuppliesLLMKey('starter')).toBe(false); // legacy alias of hosted
  });

  it('empty / null / unknown values mean self-host (incl. Object.prototype keys — hasOwn guard)', () => {
    for (const input of ['', undefined, null, 'garbage', 'toString', '__proto__'] as const) {
      expect(normalizeBillingTier(input)).toBeUndefined();
      expect(isHostedInstance(input)).toBe(false);
      expect(cpSuppliesLLMKey(input)).toBe(false);
    }
  });
});
