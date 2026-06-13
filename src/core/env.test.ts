import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ENV_ALIASES, readEnvAlias, envTier } from './env.js';

// All env vars these tests mutate, saved + restored around each case so the
// suite never leaks state into sibling tests.
const TOUCHED = [
  'LYNOX_MAX_MODEL_TIER', 'LYNOX_MAX_TIER',
  'LYNOX_DEFAULT_MODEL_TIER', 'LYNOX_DEFAULT_TIER',
  'LYNOX_API_BASE_URL', 'ANTHROPIC_BASE_URL',
  'LYNOX_DATA_DIR', 'LYNOX_DIR',
] as const;

describe('env alias reader', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('readEnvAlias', () => {
    it('returns the canonical value when only the canonical name is set', () => {
      process.env['LYNOX_API_BASE_URL'] = 'https://canonical.example/v1';
      expect(readEnvAlias('LYNOX_API_BASE_URL')).toBe('https://canonical.example/v1');
    });
    it('falls back to the legacy name when the canonical is unset', () => {
      process.env['ANTHROPIC_BASE_URL'] = 'https://legacy.example/v1';
      expect(readEnvAlias('LYNOX_API_BASE_URL')).toBe('https://legacy.example/v1');
    });
    it('prefers the canonical name when both are set', () => {
      process.env['LYNOX_API_BASE_URL'] = 'https://canonical.example/v1';
      process.env['ANTHROPIC_BASE_URL'] = 'https://legacy.example/v1';
      expect(readEnvAlias('LYNOX_API_BASE_URL')).toBe('https://canonical.example/v1');
    });
    it('skips an empty-string canonical and falls back to the legacy', () => {
      process.env['LYNOX_API_BASE_URL'] = '';
      process.env['ANTHROPIC_BASE_URL'] = 'https://legacy.example/v1';
      expect(readEnvAlias('LYNOX_API_BASE_URL')).toBe('https://legacy.example/v1');
    });
    it('returns undefined when neither name is set', () => {
      expect(readEnvAlias('LYNOX_API_BASE_URL')).toBeUndefined();
    });
  });

  describe('envTier', () => {
    it('reads and normalizes the canonical model-tier name', () => {
      process.env['LYNOX_MAX_MODEL_TIER'] = 'deep';
      expect(envTier('LYNOX_MAX_MODEL_TIER')).toBe('deep');
    });
    it('reads the legacy name and accepts a legacy brand value', () => {
      process.env['LYNOX_MAX_TIER'] = 'opus';
      expect(envTier('LYNOX_MAX_MODEL_TIER')).toBe('deep');
    });
    it('prefers the canonical name over the legacy when both are set', () => {
      process.env['LYNOX_MAX_MODEL_TIER'] = 'fast';
      process.env['LYNOX_MAX_TIER'] = 'deep';
      expect(envTier('LYNOX_MAX_MODEL_TIER')).toBe('fast');
    });
    it('returns undefined for an unrecognized value', () => {
      process.env['LYNOX_DEFAULT_MODEL_TIER'] = 'ultra';
      expect(envTier('LYNOX_DEFAULT_MODEL_TIER')).toBeUndefined();
    });
    it('returns undefined when unset', () => {
      expect(envTier('LYNOX_DEFAULT_MODEL_TIER')).toBeUndefined();
    });
  });

  describe('ENV_ALIASES registry', () => {
    it('every legacy alias is distinct from its canonical name', () => {
      for (const [canonical, legacies] of Object.entries(ENV_ALIASES)) {
        for (const legacy of legacies) expect(legacy).not.toBe(canonical);
      }
    });
    it('legacy alias names are unique across the registry (no var aliases two canonicals)', () => {
      const all = Object.values(ENV_ALIASES).flat();
      expect(new Set(all).size).toBe(all.length);
    });
  });
});
