import { describe, it, expect } from 'vitest';
import { MODEL_MAP, LYNOX_BETAS } from './index.js';

describe('MODEL_MAP', () => {
  it('has 3 tiers', () => {
    expect(Object.keys(MODEL_MAP)).toHaveLength(3);
  });

  it('contains opus, sonnet, haiku', () => {
    expect(MODEL_MAP['opus']).toBeDefined();
    expect(MODEL_MAP['sonnet']).toBeDefined();
    expect(MODEL_MAP['haiku']).toBeDefined();
  });

  it('uses full model IDs', () => {
    for (const [, value] of Object.entries(MODEL_MAP)) {
      expect(value).toMatch(/^claude-/);
      expect(value.length).toBeGreaterThan(10);
    }
  });

  it('has non-empty string values', () => {
    for (const [, value] of Object.entries(MODEL_MAP)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe('LYNOX_BETAS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(LYNOX_BETAS)).toBe(true);
    expect(LYNOX_BETAS.length).toBeGreaterThan(0);
  });

  it('contains token-efficient-tools beta', () => {
    expect(LYNOX_BETAS).toContain('token-efficient-tools-2025-02-19');
  });

  it('contains extended-cache-ttl beta', () => {
    expect(LYNOX_BETAS).toContain('extended-cache-ttl-2025-04-11');
  });

  it('does not contain outdated prompt-caching beta', () => {
    expect(LYNOX_BETAS).not.toContain('prompt-caching-2024-07-31');
  });
});
