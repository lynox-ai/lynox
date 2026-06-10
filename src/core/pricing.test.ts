import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { calculateCost, getPricing, _resetOverridePricingForTests } from './pricing.js';

describe('Pricing', () => {
  it('returns pricing for known models', () => {
    const opus = getPricing('claude-opus-4-6');
    expect(opus.input).toBe(5);
    expect(opus.output).toBe(25);

    const opus47 = getPricing('claude-opus-4-7');
    expect(opus47.input).toBe(5);
    expect(opus47.output).toBe(25);

    const sonnet = getPricing('claude-sonnet-4-6');
    expect(sonnet.input).toBe(3);

    const haiku = getPricing('claude-haiku-4-5-20251001');
    expect(haiku.input).toBe(1);
    expect(haiku.output).toBe(5);
  });

  it('falls back to opus pricing for unknown models', () => {
    const unknown = getPricing('unknown-model');
    // Full fallback shape — verifies the FALLBACK_PRICING constant survives a
    // future registry change that drops claude-opus-4-6 from the registry
    // (which would silently re-route the previous "claude-opus-4-6 fallback"
    // path through the same numbers via a different code path).
    expect(unknown).toEqual({ input: 5, output: 25, cacheWrite: 10, cacheRead: 0.50 });
  });

  describe('override-file precedence', () => {
    // Pin to an explicit empty map so the file-system probe never runs;
    // otherwise a stray `~/.lynox/pricing.json` on the host (or CI cache)
    // would silently bleed into the first override test.
    beforeEach(() => {
      _resetOverridePricingForTests({});
    });
    afterEach(() => {
      _resetOverridePricingForTests({});
    });

    it('override entries win over the registry for the exact model id', () => {
      _resetOverridePricingForTests({
        'claude-opus-4-6': { input: 99, output: 99, cacheWrite: 0, cacheRead: 0 },
      });
      const opus = getPricing('claude-opus-4-6');
      expect(opus.input).toBe(99);
      expect(opus.output).toBe(99);
    });

    it('override entries win via normalizeModelId for @-suffixed ids', () => {
      _resetOverridePricingForTests({
        'claude-sonnet-4-6': { input: 88, output: 88, cacheWrite: 0, cacheRead: 0 },
      });
      // Vertex-style @YYYYMMDD suffix normalises to the base id; override on
      // the base should still apply to the suffixed lookup.
      expect(getPricing('claude-sonnet-4-6@20260101').input).toBe(88);
    });

    it('registry wins when no override entry for the model exists', () => {
      _resetOverridePricingForTests({
        'some-other-model': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      });
      // Unaffected models still resolve through the registry.
      expect(getPricing('claude-sonnet-4-6').input).toBe(3);
    });
  });

  it('calculates cost correctly for opus', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(30); // $5 + $25
  });

  it('includes cache tokens in cost', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(10.50); // $10 cacheWrite (1h TTL = 2×) + $0.50 cacheRead
  });

  it('calculates haiku cost', () => {
    const cost = calculateCost('claude-haiku-4-5-20251001', {
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    expect(cost).toBeCloseTo(0.1 + 0.25); // $0.10 input + $0.25 output
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  describe('Mistral tier-set', () => {
    // Without these entries the cost-display falls through to the
    // `claude-opus-4-6` default ($5/$25), which both over-reports cost AND
    // silently misleads operators inspecting the run-history for an EU-
    // sovereign tenant — observed live on staging mistral-demo 2026-05-16
    // (12 870/17 tokens billed at $0.039 instead of the correct ~$0.026).
    it('returns pinned Mistral pricing', () => {
      expect(getPricing('mistral-small-2603').input).toBe(0.20);
      expect(getPricing('mistral-small-2603').output).toBe(0.60);
      // Mistral Large 3 (Dec 2025): 75% price cut vs Large 2.
      expect(getPricing('mistral-large-2512').input).toBe(0.50);
      expect(getPricing('mistral-large-2512').output).toBe(1.50);
      expect(getPricing('magistral-medium-2509').input).toBe(2);
      expect(getPricing('magistral-medium-2509').output).toBe(5);
      // Gen-3 ministrals (2026-05-24): replaced retired -2410 in tier-map.
      expect(getPricing('ministral-3b-2512').input).toBe(0.10);
      expect(getPricing('ministral-8b-2512').input).toBe(0.15);
    });

    it('calculates mistral-large cost without overcharging', () => {
      // Regression guard: same shape as the staging mistral-demo run that
      // exposed the missing entry. Mistral Large 3 rates ($0.50/$1.50) →
      // 12,870 × $0.50/M + 17 × $1.50/M = $0.0064605.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 12_870,
        output_tokens: 17,
      });
      expect(cost).toBeCloseTo(0.0064605, 7);
    });

    it('charges cache reads at 10% of input rate (Mistral native prompt-cache)', () => {
      // Mistral docs (https://docs.mistral.ai/api/endpoint/chat — 2026-05-24):
      // `prompt_cache_key` enables transparent prompt caching;
      // cached input is billed at 10% of standard input rate.
      // Large 3 input = $0.50/M → cached = $0.05/M → 1M cached = $0.05.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(0.05);
    });
  });
});
