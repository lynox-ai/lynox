import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isFeatureEnabled, getFeatureFlags, getFeatureEnvVar, registerFeature, clearDynamicFeatures } from './features.js';
import type { FeatureFlag } from './features.js';

describe('features', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envVars = [
    'NODYN_FEATURE_TRIGGERS',
    'NODYN_FEATURE_PLUGINS',
    'NODYN_FEATURE_WORKER_POOL',
    'NODYN_FEATURE_CUSTOM',
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
      expect(isFeatureEnabled('triggers')).toBe(true);
      expect(isFeatureEnabled('plugins')).toBe(true);
      expect(isFeatureEnabled('worker-pool')).toBe(false);
    });

    it('returns true when env var set to "1"', () => {
      process.env['NODYN_FEATURE_TRIGGERS'] = '1';
      expect(isFeatureEnabled('triggers')).toBe(true);
    });

    it('returns true when env var set to "true"', () => {
      process.env['NODYN_FEATURE_PLUGINS'] = 'true';
      expect(isFeatureEnabled('plugins')).toBe(true);
    });

    it('returns false when env var set to "0"', () => {
      process.env['NODYN_FEATURE_TRIGGERS'] = '0';
      expect(isFeatureEnabled('triggers')).toBe(false);
    });

    it('returns false when env var set to "false"', () => {
      process.env['NODYN_FEATURE_WORKER_POOL'] = 'false';
      expect(isFeatureEnabled('worker-pool')).toBe(false);
    });

    it('returns false for unknown flag', () => {
      expect(isFeatureEnabled('nonexistent')).toBe(false);
    });
  });

  describe('getFeatureFlags', () => {
    it('returns all flags with their current state', () => {
      process.env['NODYN_FEATURE_TRIGGERS'] = '1';
      process.env['NODYN_FEATURE_PLUGINS'] = '1';

      const flags = getFeatureFlags();
      expect(flags['triggers']).toBe(true);
      expect(flags['plugins']).toBe(true);
      expect(flags['worker-pool']).toBe(false);
    });

    it('includes dynamic flags', () => {
      registerFeature('custom', 'NODYN_FEATURE_CUSTOM', false);
      process.env['NODYN_FEATURE_CUSTOM'] = '1';

      const flags = getFeatureFlags();
      expect(flags['custom']).toBe(true);
    });
  });

  describe('getFeatureEnvVar', () => {
    it('returns correct env var name for core flags', () => {
      expect(getFeatureEnvVar('triggers')).toBe('NODYN_FEATURE_TRIGGERS');
      expect(getFeatureEnvVar('plugins')).toBe('NODYN_FEATURE_PLUGINS');
      expect(getFeatureEnvVar('worker-pool')).toBe('NODYN_FEATURE_WORKER_POOL');
    });

    it('returns undefined for unknown flag', () => {
      expect(getFeatureEnvVar('nonexistent')).toBeUndefined();
    });

    it('returns env var for dynamic flag', () => {
      registerFeature('custom', 'NODYN_FEATURE_CUSTOM', false);
      expect(getFeatureEnvVar('custom')).toBe('NODYN_FEATURE_CUSTOM');
    });
  });

  describe('registerFeature', () => {
    it('registers a dynamic feature flag', () => {
      registerFeature('custom', 'NODYN_FEATURE_CUSTOM', false);
      expect(isFeatureEnabled('custom')).toBe(false);

      process.env['NODYN_FEATURE_CUSTOM'] = '1';
      expect(isFeatureEnabled('custom')).toBe(true);
    });

    it('respects default value', () => {
      registerFeature('on-by-default', 'NODYN_FEATURE_ON', true);
      expect(isFeatureEnabled('on-by-default')).toBe(true);
    });

    it('env var overrides default', () => {
      registerFeature('on-by-default', 'NODYN_FEATURE_ON', true);
      process.env['NODYN_FEATURE_ON'] = '0';
      expect(isFeatureEnabled('on-by-default')).toBe(false);
      delete process.env['NODYN_FEATURE_ON'];
    });
  });

  describe('clearDynamicFeatures', () => {
    it('removes all dynamic flags', () => {
      registerFeature('custom', 'NODYN_FEATURE_CUSTOM', true);
      expect(isFeatureEnabled('custom')).toBe(true);

      clearDynamicFeatures();
      expect(isFeatureEnabled('custom')).toBe(false);
    });
  });
});
