import { describe, it, expect } from 'vitest';
import { clampTier } from './models.js';

describe('clampTier', () => {
  it('returns requested tier when no cap is set', () => {
    expect(clampTier('opus', undefined)).toBe('opus');
    expect(clampTier('sonnet', undefined)).toBe('sonnet');
    expect(clampTier('haiku', undefined)).toBe('haiku');
  });

  it('clamps opus to sonnet when max_tier is sonnet', () => {
    expect(clampTier('opus', 'sonnet')).toBe('sonnet');
  });

  it('clamps opus to haiku when max_tier is haiku', () => {
    expect(clampTier('opus', 'haiku')).toBe('haiku');
  });

  it('clamps sonnet to haiku when max_tier is haiku', () => {
    expect(clampTier('sonnet', 'haiku')).toBe('haiku');
  });

  it('allows sonnet when max_tier is sonnet', () => {
    expect(clampTier('sonnet', 'sonnet')).toBe('sonnet');
  });

  it('allows haiku when max_tier is sonnet', () => {
    expect(clampTier('haiku', 'sonnet')).toBe('haiku');
  });

  it('allows haiku when max_tier is haiku', () => {
    expect(clampTier('haiku', 'haiku')).toBe('haiku');
  });

  it('allows any tier when max_tier is opus', () => {
    expect(clampTier('opus', 'opus')).toBe('opus');
    expect(clampTier('sonnet', 'opus')).toBe('sonnet');
    expect(clampTier('haiku', 'opus')).toBe('haiku');
  });
});
