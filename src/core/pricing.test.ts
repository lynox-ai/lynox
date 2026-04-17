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
});
