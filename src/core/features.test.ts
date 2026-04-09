import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isFeatureEnabled, getFeatureFlags, getFeatureEnvVar, registerFeature, clearDynamicFeatures } from './features.js';
import type { FeatureFlag } from './features.js';

describe('features', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = [
    'LYNOX_FEATURE_TRIGGERS',
    'LYNOX_FEATURE_PLUGINS',
    'LYNOX_FEATURE_CUSTOM',
  ];

  beforeEach(() => {
    for (const key of envVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDynamicFeatures();
  });

  afterEach(() => {
    for (const key of envVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    clearDynamicFeatures();
  });

  describe('isFeatureEnabled', () => {
    it('returns correct defaults for core flags', () => {
      expect(isFeatureEnabled('plugins')).toBe(true);
    });

    it('returns true when env var set to "1"', () => {
      process.env['LYNOX_FEATURE_PLUGINS'] = '1';
      expect(isFeatureEnabled('plugins')).toBe(true);
    });

    it('returns true when env var set to "true"', () => {
      process.env['LYNOX_FEATURE_PLUGINS'] = 'true';
      expect(isFeatureEnabled('plugins')).toBe(true);
    });

    it('returns false when env var set to "0"', () => {
      process.env['LYNOX_FEATURE_PLUGINS'] = '0';
      expect(isFeatureEnabled('plugins')).toBe(false);
    });

    it('returns false for unknown flag', () => {
      expect(isFeatureEnabled('nonexistent')).toBe(false);
    });
  });

  describe('getFeatureFlags', () => {
    it('returns all flags with their current state', () => {
      process.env['LYNOX_FEATURE_PLUGINS'] = '1';

      const flags = getFeatureFlags();
      expect(flags['plugins']).toBe(true);
    });

    it('includes dynamic flags', () => {
      registerFeature('custom', 'LYNOX_FEATURE_CUSTOM', false);
      process.env['LYNOX_FEATURE_CUSTOM'] = '1';

      const flags = getFeatureFlags();
      expect(flags['custom']).toBe(true);
    });
  });

  describe('getFeatureEnvVar', () => {
    it('returns correct env var name for core flags', () => {
      expect(getFeatureEnvVar('plugins')).toBe('LYNOX_FEATURE_PLUGINS');
    });

    it('returns undefined for unknown flag', () => {
      expect(getFeatureEnvVar('nonexistent')).toBeUndefined();
    });

    it('returns env var for dynamic flag', () => {
      registerFeature('custom', 'LYNOX_FEATURE_CUSTOM', false);
      expect(getFeatureEnvVar('custom')).toBe('LYNOX_FEATURE_CUSTOM');
    });
  });

  describe('registerFeature', () => {
    it('registers a dynamic feature flag', () => {
      registerFeature('custom', 'LYNOX_FEATURE_CUSTOM', false);
      expect(isFeatureEnabled('custom')).toBe(false);

      process.env['LYNOX_FEATURE_CUSTOM'] = '1';
      expect(isFeatureEnabled('custom')).toBe(true);
    });

    it('respects default value', () => {
      registerFeature('on-by-default', 'LYNOX_FEATURE_ON', true);
      expect(isFeatureEnabled('on-by-default')).toBe(true);
    });

    it('env var overrides default', () => {
      registerFeature('on-by-default', 'LYNOX_FEATURE_ON', true);
      process.env['LYNOX_FEATURE_ON'] = '0';
      expect(isFeatureEnabled('on-by-default')).toBe(false);
      delete process.env['LYNOX_FEATURE_ON'];
    });
  });

  describe('clearDynamicFeatures', () => {
    it('removes all dynamic flags', () => {
      registerFeature('custom', 'LYNOX_FEATURE_CUSTOM', true);
      expect(isFeatureEnabled('custom')).toBe(true);

      clearDynamicFeatures();
      expect(isFeatureEnabled('custom')).toBe(false);
    });
  });
});
