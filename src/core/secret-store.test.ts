import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
  },
}));

import { SecretStore, SECRET_REF_PATTERN } from './secret-store.js';
import type { NodynUserConfig, SecretScope } from '../types/index.js';
import type { SecretVault } from './secret-vault.js';

/** Create a minimal mock vault with the given entries. */
function mockVault(entries: Array<[string, { value: string; scope: SecretScope; ttlMs: number }]>): SecretVault {
  return {
    getAll: () => new Map(entries),
  } as unknown as SecretVault;
}

describe('SecretStore', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear all NODYN_SECRET_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NODYN_SECRET_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NODYN_SECRET_') && !(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  // === Loading ===

  describe('loading from env vars', () => {
    it('loads secrets from NODYN_SECRET_ prefixed env vars', () => {
      process.env['NODYN_SECRET_GITHUB_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore();
      expect(store.listNames()).toContain('GITHUB_TOKEN');
    });

    it('ignores empty NODYN_SECRET_ values', () => {
      process.env['NODYN_SECRET_EMPTY'] = '';
      const store = new SecretStore();
      expect(store.listNames()).not.toContain('EMPTY');
    });

    it('ignores NODYN_SECRET_ with no suffix', () => {
      process.env['NODYN_SECRET_'] = 'value';
      const store = new SecretStore();
      expect(store.size).toBe(0);
    });
  });

  describe('loading from vault', () => {
    it('loads secrets from vault', () => {
      const vault = mockVault([
        ['MY_KEY', { value: 'sk-secretvalue1234', scope: 'http_header', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      expect(store.listNames()).toContain('MY_KEY');
    });

    it('env vars take precedence over vault', () => {
      process.env['NODYN_SECRET_OVERLAP'] = 'from-env-value';
      const vault = mockVault([
        ['OVERLAP', { value: 'from-vault-value', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      store.recordConsent('OVERLAP');
      expect(store.resolve('OVERLAP')).toBe('from-env-value');
    });
  });

  describe('loading from config', () => {
    it('loads well-known config fields as secrets', () => {
      const config: NodynUserConfig = {
        api_key: 'sk-ant-config-key123',
        voyage_api_key: 'pa-voyage-key1234',
      };
      const store = new SecretStore(config);
      expect(store.listNames()).toContain('ANTHROPIC_API_KEY');
      expect(store.listNames()).toContain('VOYAGE_API_KEY');
    });

    it('skips undefined config values', () => {
      const config: NodynUserConfig = {
        api_key: 'sk-ant-valid-key12',
        // voyage_api_key is undefined
      };
      const store = new SecretStore(config);
      expect(store.listNames()).toContain('ANTHROPIC_API_KEY');
      expect(store.listNames()).not.toContain('VOYAGE_API_KEY');
    });
  });

  // === Masking ===

  describe('masking', () => {
    it('getMasked returns masked version of secret', () => {
      process.env['NODYN_SECRET_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore();
      expect(store.getMasked('TOKEN')).toBe('***f456');
    });

    it('getMasked returns null for unknown secret', () => {
      const store = new SecretStore();
      expect(store.getMasked('UNKNOWN')).toBeNull();
    });

    it('maskSecrets replaces all occurrences in text', () => {
      process.env['NODYN_SECRET_KEY1'] = 'secret-value-1234';
      const store = new SecretStore();
      const input = 'Key is secret-value-1234 and again secret-value-1234 here';
      const masked = store.maskSecrets(input);
      expect(masked).not.toContain('secret-value-1234');
      expect(masked).toContain('***1234');
    });

    it('maskSecrets masks short secrets (>= 2 chars)', () => {
      process.env['NODYN_SECRET_SHORT2'] = 'ab';
      process.env['NODYN_SECRET_SHORT3'] = 'abc';
      const store = new SecretStore();
      expect(store.maskSecrets('has ab here')).not.toContain('ab');
      expect(store.maskSecrets('has abc here')).not.toContain('abc');
      delete process.env['NODYN_SECRET_SHORT2'];
      delete process.env['NODYN_SECRET_SHORT3'];
    });

    it('maskSecrets skips single-char secrets', () => {
      process.env['NODYN_SECRET_TINY'] = 'x';
      const store = new SecretStore();
      const input = 'This contains x in the text';
      expect(store.maskSecrets(input)).toBe(input); // unchanged
      delete process.env['NODYN_SECRET_TINY'];
    });

    it('containsSecret detects secret values in text', () => {
      process.env['NODYN_SECRET_TOKEN'] = 'mysecrettoken123';
      const store = new SecretStore();
      expect(store.containsSecret('Here is mysecrettoken123 in text')).toBe(true);
      expect(store.containsSecret('No secrets here')).toBe(false);
    });

    it('containsSecret detects 2-char secrets', () => {
      process.env['NODYN_SECRET_SHORT'] = 'ab';
      const store = new SecretStore();
      expect(store.containsSecret('has ab here')).toBe(true);
      delete process.env['NODYN_SECRET_SHORT'];
    });

    it('containsSecret ignores single-char secrets', () => {
      process.env['NODYN_SECRET_TINY'] = 'x';
      const store = new SecretStore();
      expect(store.containsSecret('x')).toBe(false);
      delete process.env['NODYN_SECRET_TINY'];
    });
  });

  // === Resolution ===

  describe('resolution', () => {
    it('resolve returns value when consented and not expired', () => {
      process.env['NODYN_SECRET_API'] = 'sk-test-api-key-val';
      const store = new SecretStore();
      store.recordConsent('API');
      expect(store.resolve('API')).toBe('sk-test-api-key-val');
    });

    it('resolve returns null when not consented', () => {
      process.env['NODYN_SECRET_API'] = 'sk-test-api-key-val';
      const store = new SecretStore();
      expect(store.resolve('API')).toBeNull();
    });

    it('resolve returns null for unknown secret', () => {
      const store = new SecretStore();
      store.recordConsent('NONEXISTENT');
      expect(store.resolve('NONEXISTENT')).toBeNull();
    });

    it('resolve returns null for expired secret', () => {
      const vault = mockVault([
        ['EXPIRING', { value: 'will-expire-soon1', scope: 'any', ttlMs: 1 }],
      ]);
      const store = new SecretStore(undefined, vault);
      store.recordConsent('EXPIRING');
      // Wait for TTL to expire
      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      expect(store.resolve('EXPIRING')).toBeNull();
      vi.useRealTimers();
    });

    it('SECRET_REF_PATTERN matches secret references', () => {
      const input = 'Use secret:MY_API_KEY and secret:GITHUB_TOKEN here';
      const matches: string[] = [];
      let match;
      const pattern = new RegExp(SECRET_REF_PATTERN.source, SECRET_REF_PATTERN.flags);
      while ((match = pattern.exec(input)) !== null) {
        matches.push(match[1]!);
      }
      expect(matches).toEqual(['MY_API_KEY', 'GITHUB_TOKEN']);
    });
  });

  // === Consent ===

  describe('consent', () => {
    it('hasConsent returns false initially', () => {
      process.env['NODYN_SECRET_KEY'] = 'secret-value-1234';
      const store = new SecretStore();
      expect(store.hasConsent('KEY')).toBe(false);
    });

    it('recordConsent enables resolution', () => {
      process.env['NODYN_SECRET_KEY'] = 'secret-value-1234';
      const store = new SecretStore();
      store.recordConsent('KEY');
      expect(store.hasConsent('KEY')).toBe(true);
    });

    it('consent is per-secret isolated', () => {
      process.env['NODYN_SECRET_A'] = 'value-a-123456789';
      process.env['NODYN_SECRET_B'] = 'value-b-987654321';
      const store = new SecretStore();
      store.recordConsent('A');
      expect(store.hasConsent('A')).toBe(true);
      expect(store.hasConsent('B')).toBe(false);
    });

    it('listNames returns all loaded secret names', () => {
      process.env['NODYN_SECRET_X'] = 'secret-x-value123';
      process.env['NODYN_SECRET_Y'] = 'secret-y-value456';
      const store = new SecretStore();
      const names = store.listNames();
      expect(names).toContain('X');
      expect(names).toContain('Y');
    });
  });

  // === TTL ===

  describe('TTL', () => {
    it('no TTL means never expired', () => {
      process.env['NODYN_SECRET_PERM'] = 'permanent-secret1';
      const store = new SecretStore();
      expect(store.isExpired('PERM')).toBe(false);
    });

    it('within TTL means not expired', () => {
      const vault = mockVault([
        ['FRESH', { value: 'fresh-secret-val1', scope: 'any', ttlMs: 86400000 }],
      ]);
      const store = new SecretStore(undefined, vault);
      expect(store.isExpired('FRESH')).toBe(false);
    });

    it('past TTL means expired', () => {
      vi.useFakeTimers();
      const vault = mockVault([
        ['OLD', { value: 'old-secret-val123', scope: 'any', ttlMs: 100 }],
      ]);
      const store = new SecretStore(undefined, vault);
      expect(store.isExpired('OLD')).toBe(false);
      vi.advanceTimersByTime(200);
      expect(store.isExpired('OLD')).toBe(true);
      vi.useRealTimers();
    });
  });
});
