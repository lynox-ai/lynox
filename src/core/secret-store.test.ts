import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
  },
}));

import { SecretStore, SECRET_REF_PATTERN, isInfraSecret } from './secret-store.js';
import type { LynoxUserConfig, SecretScope } from '../types/index.js';
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
    // Clear all LYNOX_SECRET_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LYNOX_SECRET_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LYNOX_SECRET_') && !(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  // === Loading ===

  describe('loading from env vars', () => {
    it('loads secrets from LYNOX_SECRET_ prefixed env vars', () => {
      process.env['LYNOX_SECRET_GITHUB_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore();
      expect(store.listNames()).toContain('GITHUB_TOKEN');
    });

    it('ignores empty LYNOX_SECRET_ values', () => {
      process.env['LYNOX_SECRET_EMPTY'] = '';
      const store = new SecretStore();
      expect(store.listNames()).not.toContain('EMPTY');
    });

    it('ignores LYNOX_SECRET_ with no suffix', () => {
      process.env['LYNOX_SECRET_'] = 'value';
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
      process.env['LYNOX_SECRET_OVERLAP'] = 'from-env-value';
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
      const config: LynoxUserConfig = {
        api_key: 'sk-ant-config-key123',
      };
      const store = new SecretStore(config);
      expect(store.listNames()).toContain('ANTHROPIC_API_KEY');
    });

    it('skips undefined config values', () => {
      const config: LynoxUserConfig = {};
      const store = new SecretStore(config);
      expect(store.listNames()).not.toContain('ANTHROPIC_API_KEY');
    });
  });

  // === Masking ===

  describe('masking', () => {
    it('getMasked returns masked version of secret', () => {
      process.env['LYNOX_SECRET_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore();
      expect(store.getMasked('TOKEN')).toBe('***f456');
    });

    it('getMasked returns null for unknown secret', () => {
      const store = new SecretStore();
      expect(store.getMasked('UNKNOWN')).toBeNull();
    });

    it('maskSecrets replaces all occurrences in text', () => {
      process.env['LYNOX_SECRET_KEY1'] = 'secret-value-1234';
      const store = new SecretStore();
      const input = 'Key is secret-value-1234 and again secret-value-1234 here';
      const masked = store.maskSecrets(input);
      expect(masked).not.toContain('secret-value-1234');
      expect(masked).toContain('***1234');
    });

    it('maskSecrets masks short secrets (>= 2 chars)', () => {
      process.env['LYNOX_SECRET_SHORT2'] = 'ab';
      process.env['LYNOX_SECRET_SHORT3'] = 'abc';
      const store = new SecretStore();
      expect(store.maskSecrets('has ab here')).not.toContain('ab');
      expect(store.maskSecrets('has abc here')).not.toContain('abc');
      delete process.env['LYNOX_SECRET_SHORT2'];
      delete process.env['LYNOX_SECRET_SHORT3'];
    });

    it('maskSecrets does not hang when a value contains its own mask', () => {
      // maskValue('***ab') === '*****ab', which CONTAINS '***ab'. The old
      // `while (result.includes(value))` loop re-scanned the growing output and
      // spun forever (and leaked the value through its own replacement). The fix
      // does a single pass and falls back to a fixed token in this degenerate
      // case. If this regresses, the test fails via vitest's per-test timeout.
      process.env['LYNOX_SECRET_STARVAL'] = '***ab';
      const store = new SecretStore();
      const masked = store.maskSecrets('leak: ***ab end');
      expect(masked).not.toContain('***ab'); // value not leaked through the mask
      expect(masked).toContain('leak:');
      expect(masked).toContain('end');
      delete process.env['LYNOX_SECRET_STARVAL'];
    });

    it('maskSecrets skips single-char secrets', () => {
      process.env['LYNOX_SECRET_TINY'] = 'x';
      const store = new SecretStore();
      const input = 'This contains x in the text';
      expect(store.maskSecrets(input)).toBe(input); // unchanged
      delete process.env['LYNOX_SECRET_TINY'];
    });

    it('containsSecret detects secret values in text', () => {
      process.env['LYNOX_SECRET_TOKEN'] = 'mysecrettoken123';
      const store = new SecretStore();
      expect(store.containsSecret('Here is mysecrettoken123 in text')).toBe(true);
      expect(store.containsSecret('No secrets here')).toBe(false);
    });

    it('containsSecret detects 2-char secrets', () => {
      process.env['LYNOX_SECRET_SHORT'] = 'ab';
      const store = new SecretStore();
      expect(store.containsSecret('has ab here')).toBe(true);
      delete process.env['LYNOX_SECRET_SHORT'];
    });

    it('containsSecret ignores single-char secrets', () => {
      process.env['LYNOX_SECRET_TINY'] = 'x';
      const store = new SecretStore();
      expect(store.containsSecret('x')).toBe(false);
      delete process.env['LYNOX_SECRET_TINY'];
    });
  });

  // === Resolution ===

  describe('resolution', () => {
    it('resolve returns value when consented and not expired', () => {
      process.env['LYNOX_SECRET_API'] = 'sk-test-api-key-val';
      const store = new SecretStore();
      store.recordConsent('API');
      expect(store.resolve('API')).toBe('sk-test-api-key-val');
    });

    it('resolve returns null when not consented', () => {
      process.env['LYNOX_SECRET_API'] = 'sk-test-api-key-val';
      const store = new SecretStore();
      expect(store.resolve('API')).toBeNull();
    });

    it('set() records consent so a just-stored secret resolves in the same process', () => {
      // Pins the fetch_token -> store -> resolve path: without consent-on-store
      // resolve() returns null and the OAuth mint-loop bug returns.
      const vault = { getAll: () => new Map(), set: vi.fn() } as unknown as SecretVault;
      const store = new SecretStore(undefined, vault);
      store.set('OAUTH_TOKEN', 'tok-abc');
      expect(store.hasConsent('OAUTH_TOKEN')).toBe(true);
      expect(store.resolve('OAUTH_TOKEN')).toBe('tok-abc'); // no explicit recordConsent needed
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

  // === Infrastructure secrets (exfil guard) ===

  describe('infrastructure secrets (exfil guard)', () => {
    it('isInfraSecret matches infra prefixes, not integration secrets', () => {
      expect(isInfraSecret('MAIL_ACCOUNT_RAFAEL_GMAIL')).toBe(true);
      expect(isInfraSecret('GOOGLE_OAUTH_TOKENS')).toBe(true);
      // OAuth *app* credentials are CP-provisioned infra (repointing them =
      // OAuth hijacking), same class as the OAuth tokens above.
      expect(isInfraSecret('GOOGLE_CLIENT_ID')).toBe(true);
      expect(isInfraSecret('GOOGLE_CLIENT_SECRET')).toBe(true);
      expect(isInfraSecret('SMTP_PASSWORD')).toBe(true);
      expect(isInfraSecret('IMAP_PASSWORD')).toBe(true);
      expect(isInfraSecret('LYNOX_HTTP_SECRET')).toBe(true);
      expect(isInfraSecret('MANAGED_TOKEN')).toBe(true);
      expect(isInfraSecret('STRIPE_API_KEY')).toBe(false);
      expect(isInfraSecret('ANTHROPIC_API_KEY')).toBe(false);
      expect(isInfraSecret('SHOPIFY_ACCESS_TOKEN')).toBe(false);
    });

    it('listAgentVisibleNames excludes infra secrets but keeps integration secrets', () => {
      const vault = mockVault([
        ['MAIL_ACCOUNT_RAFAEL_GMAIL', { value: '{"user":"r","pass":"app-pw-secret"}', scope: 'any', ttlMs: 0 }],
        ['STRIPE_API_KEY', { value: 'sk_live_xxxxxxxxxx', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      const visible = store.listAgentVisibleNames();
      expect(visible).toContain('STRIPE_API_KEY');
      expect(visible).not.toContain('MAIL_ACCOUNT_RAFAEL_GMAIL');
      // listNames() still returns everything (masking + settings UI rely on it)
      expect(store.listNames()).toContain('MAIL_ACCOUNT_RAFAEL_GMAIL');
    });

    it('resolveSecretRefs never expands an infra secret ref into tool input', () => {
      const vault = mockVault([
        ['MAIL_ACCOUNT_RAFAEL_GMAIL', { value: '{"user":"r","pass":"app-pw-secret"}', scope: 'any', ttlMs: 0 }],
        ['STRIPE_API_KEY', { value: 'sk_live_realstripekey', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      // both are vault-backed → auto-consented; only the infra ref must stay literal
      const out = store.resolveSecretRefs({
        body: 'mail=secret:MAIL_ACCOUNT_RAFAEL_GMAIL key=secret:STRIPE_API_KEY',
      }) as { body: string };
      expect(out.body).toContain('secret:MAIL_ACCOUNT_RAFAEL_GMAIL'); // unresolved literal
      expect(out.body).not.toContain('app-pw-secret');                // credential value never leaks
      expect(out.body).toContain('sk_live_realstripekey');            // integration secret still resolves
    });

    it('maskSecrets still redacts an infra secret value if it surfaces', () => {
      const vault = mockVault([
        ['MAIL_ACCOUNT_RAFAEL_GMAIL', { value: 'app-pw-secret-value', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      const masked = store.maskSecrets('leaked app-pw-secret-value here');
      expect(masked).not.toContain('app-pw-secret-value');
    });
  });

  // === Consent ===

  describe('consent', () => {
    it('hasConsent returns false initially', () => {
      process.env['LYNOX_SECRET_KEY'] = 'secret-value-1234';
      const store = new SecretStore();
      expect(store.hasConsent('KEY')).toBe(false);
    });

    it('recordConsent enables resolution', () => {
      process.env['LYNOX_SECRET_KEY'] = 'secret-value-1234';
      const store = new SecretStore();
      store.recordConsent('KEY');
      expect(store.hasConsent('KEY')).toBe(true);
    });

    it('consent is per-secret isolated', () => {
      process.env['LYNOX_SECRET_A'] = 'value-a-123456789';
      process.env['LYNOX_SECRET_B'] = 'value-b-987654321';
      const store = new SecretStore();
      store.recordConsent('A');
      expect(store.hasConsent('A')).toBe(true);
      expect(store.hasConsent('B')).toBe(false);
    });

    it('listNames returns all loaded secret names', () => {
      process.env['LYNOX_SECRET_X'] = 'secret-x-value123';
      process.env['LYNOX_SECRET_Y'] = 'secret-y-value456';
      const store = new SecretStore();
      const names = store.listNames();
      expect(names).toContain('X');
      expect(names).toContain('Y');
    });
  });

  // === TTL ===

  describe('TTL', () => {
    it('no TTL means never expired', () => {
      process.env['LYNOX_SECRET_PERM'] = 'permanent-secret1';
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

  // Staging 2026-05-18 incident: the resolver silently substituted nothing
  // when a `secret:NAME` referenced a key the vault didn't have. The
  // literal `secret:NAME` then got POSTed to Shopify, which echoed it
  // back in the error message, which the agent mis-diagnosed as a
  // tool-level bug ("http_request doesn't resolve secrets in bodies").
  // The fix is fail-loud: agent.ts checks findUnresolvedSecretRefs and
  // refuses the tool call with a clear error message.
  describe('findUnresolvedSecretRefs (staging-incident regression pin)', () => {
    it('returns empty when all referenced secrets resolve', () => {
      const vault = mockVault([
        ['A', { value: 'a-value', scope: 'any', ttlMs: 0 }],
        ['B', { value: 'b-value', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      expect(store.findUnresolvedSecretRefs({ x: 'secret:A', y: 'secret:B' })).toEqual([]);
    });

    it('returns the names of secrets the vault does NOT have', () => {
      const vault = mockVault([
        ['PRESENT', { value: 'p', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      expect(store.findUnresolvedSecretRefs({
        present: 'secret:PRESENT',
        missing: 'secret:NOT_THERE',
      })).toEqual(['NOT_THERE']);
    });

    it('detects unresolved refs in body strings (the actual staging path)', () => {
      // The Shopify failure mode: client_id + client_secret are JSON-string
      // body fields, not structured object fields. The resolver still walks
      // through JSON.stringify → regex, but the test makes sure body-string
      // matches are reported by findUnresolvedSecretRefs too.
      const vault = mockVault([
        ['CLIENT_SECRET', { value: 'shpss_xyz', scope: 'any', ttlMs: 0 }],
      ]);
      const store = new SecretStore(undefined, vault);
      const input = {
        url: 'https://example.com/oauth/access_token',
        method: 'POST',
        body: '{"client_id": "secret:CLIENT_ID", "client_secret": "secret:CLIENT_SECRET"}',
      };
      expect(store.findUnresolvedSecretRefs(input)).toEqual(['CLIENT_ID']);
    });

    it('deduplicates names that appear multiple times in the input', () => {
      const store = new SecretStore();
      const input = { a: 'secret:MISSING', b: 'also secret:MISSING here', c: 'secret:OTHER' };
      const result = store.findUnresolvedSecretRefs(input);
      expect(result.sort()).toEqual(['MISSING', 'OTHER']);
    });

    it('returns empty for input with no secret refs', () => {
      const store = new SecretStore();
      expect(store.findUnresolvedSecretRefs({ url: 'https://example.com', body: 'plain text' })).toEqual([]);
    });
  });

  describe('findNameMatches (near-identical name reconciliation)', () => {
    it('matches a stored name that normalizes to the requested name', () => {
      process.env['LYNOX_SECRET_ZAI_API_KEY'] = 'sk-zai-1234';
      const store = new SecretStore();
      expect(store.findNameMatches('Z_AI_API_KEY')).toEqual(['ZAI_API_KEY']);
    });

    it('excludes an exact match — that is not a mismatch', () => {
      process.env['LYNOX_SECRET_ZAI_API_KEY'] = 'sk-zai-1234';
      const store = new SecretStore();
      expect(store.findNameMatches('ZAI_API_KEY')).toEqual([]);
    });

    it('returns empty when nothing normalizes to the requested name', () => {
      process.env['LYNOX_SECRET_STRIPE_API_KEY'] = 'sk-live-1';
      const store = new SecretStore();
      expect(store.findNameMatches('OPENAI_API_KEY')).toEqual([]);
    });

    it('never surfaces an infra secret as a near-match (leak guard)', () => {
      const infraName = 'MAIL_ACCOUNT_SHOP';
      expect(isInfraSecret(infraName)).toBe(true);
      process.env['LYNOX_SECRET_MAIL_ACCOUNT_SHOP'] = 'infra-cred';
      const store = new SecretStore();
      expect(store.findNameMatches('MAILACCOUNTSHOP')).toEqual([]);
      expect(store.findNameMatches(infraName)).toEqual([]);
    });
  });
});
