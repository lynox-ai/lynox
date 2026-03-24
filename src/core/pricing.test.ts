import { describe, it, expect } from 'vitest';
import { calculateCost, getPricing } from './pricing.js';

describe('Pricing', () => {
  it('returns pricing for known models', () => {
    const opus = getPricing('claude-opus-4-6');
    expect(opus.input).toBe(15);
    expect(opus.output).toBe(75);

    const sonnet = getPricing('claude-sonnet-4-6');
    expect(sonnet.input).toBe(3);

    const haiku = getPricing('claude-haiku-4-5-20251001');
    expect(haiku.input).toBe(0.80);
  });

  it('falls back to opus pricing for unknown models', () => {
    const unknown = getPricing('unknown-model');
    expect(unknown.input).toBe(15);
  });

  it('calculates cost correctly for opus', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(90); // $15 + $75
  });

  it('includes cache tokens in cost', () => {
    const cost = calculateCost('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(20.25); // $18.75 + $1.50
  });

  it('calculates haiku cost', () => {
    const cost = calculateCost('claude-haiku-4-5-20251001', {
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    expect(cost).toBeCloseTo(0.08 + 0.2); // $0.08 input + $0.20 output
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost).toBe(0);
  });
});
