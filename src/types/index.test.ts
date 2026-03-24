import { describe, it, expect } from 'vitest';
import { MODEL_MAP, NODYN_BETAS } from './index.js';

describe('MODEL_MAP', () => {
  it('has 3 tiers', () => {
    expect(Object.keys(MODEL_MAP)).toHaveLength(3);
  });

  it('contains nodyn, nodyn-fast, nodyn-micro', () => {
    expect(MODEL_MAP['opus']).toBeDefined();
    expect(MODEL_MAP['sonnet']).toBeDefined();
    expect(MODEL_MAP['haiku']).toBeDefined();
  });

  it('uses full model IDs (not short aliases)', () => {
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

describe('NODYN_BETAS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(NODYN_BETAS)).toBe(true);
    expect(NODYN_BETAS.length).toBeGreaterThan(0);
  });

  it('contains token-efficient-tools beta', () => {
    expect(NODYN_BETAS).toContain('token-efficient-tools-2025-02-19');
  });

  it('does not contain outdated prompt-caching beta', () => {
    expect(NODYN_BETAS).not.toContain('prompt-caching-2024-07-31');
  });
});
