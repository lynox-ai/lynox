import { describe, it, expect } from 'vitest';
import { calculateCost, getPricing } from './pricing.js';

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
    expect(unknown.input).toBe(5);
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
    expect(cost).toBeCloseTo(6.75); // $6.25 cacheWrite + $0.50 cacheRead
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
      expect(getPricing('mistral-large-2512').input).toBe(2);
      expect(getPricing('mistral-large-2512').output).toBe(6);
      expect(getPricing('magistral-medium-2509').input).toBe(2);
      expect(getPricing('magistral-medium-2509').output).toBe(5);
    });

    it('calculates mistral-large cost without overcharging', () => {
      // Regression guard: same shape as the staging mistral-demo run that
      // exposed the missing entry. Mistral rates → $0.025842, not the
      // $0.038865 Sonnet fallback that shipped before this fix.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 12_870,
        output_tokens: 17,
      });
      expect(cost).toBeCloseTo(0.025842, 6);
    });

    it('charges cache reads at the input rate (no native cache discount)', () => {
      // Mistral docs: `prompt_cache_key` enables transparent prompt caching
      // but does not discount the cached prefix — bill it as input.
      const cost = calculateCost('mistral-large-2512', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(2);
    });
  });
});
