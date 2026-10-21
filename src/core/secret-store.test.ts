import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
  },
}));

import { SecretStore, maskEngineEnvSecrets, SECRET_REF_PATTERN, SECRET_SHAPES, isInfraSecret, isProtectedSecretWrite, maskSecretPatterns, matchesSecretPattern, maskCredentialInput, withoutTypedCredentials } from './secret-store.js';
import { MICROSOFT_OAUTH_TOKENS_KEY } from '../integrations/microsoft/vault-keys.js';
import { LLM_CATALOG } from './llm/catalog.js';
import { VAULT_SLOT_BY_PROVIDER } from './llm/provider-keys.js';
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

  // PRD §3.13 B9: the engine sets a check every resolve asks, so a token of a connection whose
  // mandate has ended reaches nobody, whichever way it is asked for.
  describe('resolve guard', () => {
    const vaulted = (): SecretStore => new SecretStore(undefined, mockVault([
      ['BOOKS_API_ACCESS_TOKEN', { value: 'token-value-1234', scope: 'any', ttlMs: 0 }],
      ['OTHER_KEY', { value: 'other-value-1234', scope: 'any', ttlMs: 0 }],
    ]));

    it('withholds what the guard refuses, by resolve and by reference alike, and nothing else', () => {
      const store = vaulted();
      store.setResolveGuard((name) => name !== 'BOOKS_API_ACCESS_TOKEN');
      expect(store.resolve('BOOKS_API_ACCESS_TOKEN')).toBeNull();
      expect(store.resolveSecretRefs({ h: 'secret:BOOKS_API_ACCESS_TOKEN' })).toEqual({ h: 'secret:BOOKS_API_ACCESS_TOKEN' });
      expect(store.resolve('OTHER_KEY')).toBe('other-value-1234');
    });

    it('withholds the value when the guard throws', () => {
      const store = vaulted();
      store.setResolveGuard(() => { throw new Error('no profiles'); });
      expect(store.resolve('OTHER_KEY')).toBeNull();
    });

    it('control: without a guard, or with it removed again, the value is handed out', () => {
      const store = vaulted();
      expect(store.resolve('BOOKS_API_ACCESS_TOKEN')).toBe('token-value-1234');
      store.setResolveGuard(() => false);
      store.setResolveGuard(null);
      expect(store.resolve('BOOKS_API_ACCESS_TOKEN')).toBe('token-value-1234');
    });
  });

  // The connection grants record WHICH credential a name holds (PRD connection-attribution A2),
  // so the fingerprint reads the stored value whether or not it may be handed out now.
  describe('fingerprint', () => {
    const h = (v: string): string => `h(${v})`;

    it('is the hash of the stored value, and empty when nothing is stored', () => {
      const store = new SecretStore(undefined, mockVault([['K', { value: 'vault-value-1234', scope: 'any', ttlMs: 0 }]]));
      expect(store.fingerprint('K', h)).toBe('h(vault-value-1234)');
      expect(store.fingerprint('MISSING', h)).toBe('');
    });

    it('a stored empty value holds no credential', () => {
      const store = new SecretStore(undefined, mockVault([['K', { value: '', scope: 'any', ttlMs: 0 }]]));
      expect(store.fingerprint('K', h)).toBe('');
    });

    it('reads an environment value over the vault, as resolve does', () => {
      process.env['LYNOX_SECRET_K'] = 'env-value-123456';
      const store = new SecretStore(undefined, mockVault([['K', { value: 'vault-value-1234', scope: 'any', ttlMs: 0 }]]));
      expect(store.fingerprint('K', h)).toBe('h(env-value-123456)');
    });

    it('identifies a value resolve withholds — no consent, or refused by the guard', () => {
      process.env['LYNOX_SECRET_K'] = 'env-value-123456';
      const store = new SecretStore();
      store.setResolveGuard(() => false);
      expect(store.resolve('K')).toBeNull();
      expect(store.fingerprint('K', h)).toBe('h(env-value-123456)');
    });

    it('is announced as its own action, never as a resolve', async () => {
      const { channels } = await import('./observability.js');
      const store = new SecretStore(undefined, mockVault([['K', { value: 'vault-value-1234', scope: 'any', ttlMs: 0 }]]));
      store.fingerprint('K', h);
      expect(channels.secretAccess.publish).toHaveBeenCalledWith({ name: 'K', action: 'fingerprint' });
      expect(channels.secretAccess.publish).not.toHaveBeenCalledWith({ name: 'K', action: 'resolve' });
    });
  });

  // === Loading ===

  describe('loading from env vars', () => {
    it('loads secrets from LYNOX_SECRET_ prefixed env vars', () => {
      process.env['LYNOX_SECRET_GITHUB_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore();
      expect(store.listNames()).toContain('GITHUB_TOKEN');
    });

    it('says which values came from the environment (a mandate\'s turn is refused those, PRD D1)', () => {
      process.env['LYNOX_SECRET_GITHUB_TOKEN'] = 'ghp_abc123def456';
      const store = new SecretStore(undefined, mockVault([
        ['SHOP_KEY', { value: 'stored-by-setup-1234', scope: 'any', ttlMs: 0 }],
      ]));
      expect(store.listNames()).toContain('SHOP_KEY');
      expect(store.isEnvironmentSecret('GITHUB_TOKEN')).toBe(true);
      expect(store.isEnvironmentSecret('SHOP_KEY')).toBe(false);
    });

    it('counts a well-known variable the engine reads by its own name as the environment too', () => {
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-from-env-1234');
      try {
        const store = new SecretStore();
        expect(store.isEnvironmentSecret('GOOGLE_CLIENT_SECRET')).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
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

    // A host goes out lower-cased, so a value with capitals is the same value there; the exact
    // check misses it, the host check does not. Each with a control that holds nothing stored.
    it('containsSecretAsHost finds a stored value in a host whatever its case', () => {
      process.env['LYNOX_SECRET_HOSTED'] = 'Sk-Live-Canary';
      const store = new SecretStore();
      expect(store.containsSecret('sk-live-canary.h.example')).toBe(false);
      expect(store.containsSecretAsHost('sk-live-canary.h.example')).toBe(true);
      expect(store.containsSecretAsHost('SK-LIVE-CANARY.h.example')).toBe(true);
      expect(store.containsSecretAsHost('harmless-value.h.example')).toBe(false);
      delete process.env['LYNOX_SECRET_HOSTED'];
    });

    it('containsSecretAsHost reads a value outside ASCII as the parser writes it as a host name', () => {
      process.env['LYNOX_SECRET_UMLAUT'] = 'Straße-K';
      const store = new SecretStore();
      expect(store.containsSecretAsHost('xn--strae-k-3va.h.example')).toBe(true);
      expect(store.containsSecretAsHost('xn--harmlos-3va.h.example')).toBe(false);
      delete process.env['LYNOX_SECRET_UMLAUT'];
    });

    // The parser cuts a value at its first delimiter (`x/y` would be read as `x`), so a value
    // a host name cannot hold is compared only as it is.
    it('containsSecretAsHost does not read a value with a delimiter as the host name it would be cut to', () => {
      process.env['LYNOX_SECRET_SLASHED'] = 'ab/cdefgh';
      const store = new SecretStore();
      expect(store.containsSecretAsHost('ab.h.example')).toBe(false);
      delete process.env['LYNOX_SECRET_SLASHED'];
    });

    it('containsSecretAsHost keeps the floor of single-char values', () => {
      process.env['LYNOX_SECRET_TINY'] = 'X';
      const store = new SecretStore();
      expect(store.containsSecretAsHost('x.h.example')).toBe(false);
      delete process.env['LYNOX_SECRET_TINY'];
    });
  });

  // The engine's own env secrets (env-registry rows marked `secret`) are masked in every
  // text the maskers see, but never become a stored secret: a bar against a value read
  // once by accident staying in the thread.
  describe('engine env secrets', () => {
    const NAMES = ['LYNOX_VAULT_KEY', 'MISTRAL_API_KEY', 'LYNOX_MANAGED_CUSTOMER_EMAIL', 'LYNOX_TIER_SET_JSON'] as const;
    const saved = new Map<string, string | undefined>();
    const vaultValue = ['vault', 'master', 'value', '0123456789'].join('-');

    beforeEach(() => {
      for (const n of NAMES) { saved.set(n, process.env[n]); delete process.env[n]; }
    });
    afterEach(() => {
      for (const n of NAMES) {
        const v = saved.get(n);
        if (v === undefined) delete process.env[n]; else process.env[n] = v;
      }
    });

    it('masks the vault key the engine sets after the store exists, in all three maskers', () => {
      const store = new SecretStore();
      process.env['LYNOX_VAULT_KEY'] = vaultValue;
      const text = `cat says: ${vaultValue}\n`;
      expect(store.maskSecrets(text)).toBe('cat says: ***6789\n');
      expect(store.maskAll(text)).not.toContain(vaultValue);
      expect(store.containsSecret(text)).toBe(true);
    });

    it('masks any registry secret, not only the vault key', () => {
      const mistral = ['mistral', 'value', 'abcdefgh'].join('-');
      process.env['MISTRAL_API_KEY'] = mistral;
      const store = new SecretStore();
      expect(store.maskSecrets(`k=${mistral}`)).toBe('k=***efgh');
    });

    it('keeps them mask-only: nothing lists or resolves them', () => {
      process.env['LYNOX_VAULT_KEY'] = vaultValue;
      const store = new SecretStore();
      expect(store.listNames()).not.toContain('LYNOX_VAULT_KEY');
      expect(store.resolve('LYNOX_VAULT_KEY')).toBeNull();
    });

    it('leaves an identity marked secret in the registry visible (the owner address)', () => {
      const address = ['owner', 'example.org'].join('@');
      process.env['LYNOX_MANAGED_CUSTOMER_EMAIL'] = address;
      const store = new SecretStore();
      expect(store.maskSecrets(`To: ${address}`)).toBe(`To: ${address}`);
      expect(store.containsSecret(`To: ${address}`)).toBe(false);
    });

    it('skips a value too short to be a credential (an operator\'s {})', () => {
      process.env['LYNOX_TIER_SET_JSON'] = '{}';
      const store = new SecretStore();
      expect(store.maskSecrets('a {} b')).toBe('a {} b');
      expect(store.containsSecret('a {} b')).toBe(false);
    });

    it('masks the longer value whole when a shorter secret sits inside it', () => {
      const inner = ['inner', '42'].join('-');
      const outer = `xx-${inner}-tail9876`;
      process.env['LYNOX_SECRET_INNER'] = inner;
      process.env['LYNOX_VAULT_KEY'] = outer;
      const store = new SecretStore();
      expect(store.maskSecrets(`k=${outer}`)).toBe('k=***9876');
    });

    it('masks them without a store, for a caller that holds none', () => {
      process.env['LYNOX_VAULT_KEY'] = vaultValue;
      expect(maskEngineEnvSecrets(`v=${vaultValue}`)).toBe('v=***6789');
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
      // The Microsoft grant's slot, by the constant that names it, not a copy
      // of the string: a rename of the key must still land under the pattern.
      expect(isInfraSecret(MICROSOFT_OAUTH_TOKENS_KEY)).toBe(true);
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

    it('matches a stored name in the same VENDOR namespace (DATAFORSEO class)', () => {
      // The real dogfood failure: stored DATAFORSEO_B64, agent guessed
      // DATAFORSEO_API_LOGIN — they do NOT normalize-collide, but share the vendor.
      process.env['LYNOX_SECRET_DATAFORSEO_B64'] = 'base64creds';
      const store = new SecretStore();
      expect(store.findNameMatches('DATAFORSEO_API_LOGIN')).toEqual(['DATAFORSEO_B64']);
    });

    it('does NOT over-match on a generic leading token (API/KEY/...)', () => {
      process.env['LYNOX_SECRET_API_LOGIN_BETA'] = 'x';
      const store = new SecretStore();
      // First token "API" is generic → no vendor match, only normalization (none here).
      expect(store.findNameMatches('API_KEY_ALPHA')).toEqual([]);
    });

    it('lists the exact (normalized) match before a vendor-namespace match', () => {
      process.env['LYNOX_SECRET_STRIPEAPIKEY'] = 'a'; // normalizes to STRIPEAPIKEY
      process.env['LYNOX_SECRET_STRIPE_WEBHOOK_SECRET'] = 'b'; // same vendor
      const store = new SecretStore();
      // Requesting STRIPE_API_KEY: exact-normalize STRIPEAPIKEY first, then the vendor sibling.
      expect(store.findNameMatches('STRIPE_API_KEY')).toEqual(['STRIPEAPIKEY', 'STRIPE_WEBHOOK_SECRET']);
    });

    it('does not surface an infra secret even when it shares the vendor token', () => {
      // GOOGLE_OAUTH_* is infra; a requested GOOGLE_MAPS_KEY must never pull it in.
      expect(isInfraSecret('GOOGLE_OAUTH_TOKEN')).toBe(true);
      process.env['LYNOX_SECRET_GOOGLE_OAUTH_TOKEN'] = 'infra';
      const store = new SecretStore();
      expect(store.findNameMatches('GOOGLE_MAPS_KEY')).toEqual([]);
    });
  });
});

describe('maskSecretPatterns — prefixed key forms', () => {
  // These are pinned HERE and not on the error-reporting path, deliberately.
  // That path passes `includeGeneric`, whose 40+ char catcher masks these by
  // accident of length — so a test there stays green with the specific patterns
  // deleted. Every OTHER caller runs without `includeGeneric`, and there these
  // rules are the only thing standing between a real key and a log line.
  it('masks an OpenAI project key, whose token contains - and _', () => {
    // The plain `sk-[A-Za-z0-9]{20,}` rule stops at the first dash and matches
    // four characters, so this shipped verbatim until 2026-08-24. The old test
    // fixture (`sk-ant-` + 40 A's) was alnum-only, which is why it looked
    // covered.
    const key = 'sk-proj-Ab1Cd2Ef3Gh4Ij5_Kl6Mn7-Op8Qr9St0Uv1Wx2Yz3';
    expect(maskSecretPatterns(`key=${key}`)).not.toContain(key);
  });

  it('masks a service-account key', () => {
    const key = 'sk-svcacct-Ab1Cd2Ef3_Gh4Ij5-Kl6Mn7Op8Qr9St0';
    expect(maskSecretPatterns(`key=${key}`)).not.toContain(key);
  });

  it('masks a credential embedded in a connection URL', () => {
    const url = 'postgres://lynox:Hunter2Pw@db.internal:5432/lynox';
    const out = maskSecretPatterns(`connect failed: ${url}`);
    expect(out).not.toContain('Hunter2Pw');
  });

  it('leaves an ordinary URL alone', () => {
    // The userinfo rule needs the `:`…`@` shape. Without this the pattern would
    // be a false-positive machine over every URL in every message.
    const url = 'https://api.example.com/v1/users?id=3';
    expect(maskSecretPatterns(`GET ${url}`)).toContain(url);
  });

  it('does not apply the generic catcher unless asked', () => {
    // The default stays conservative for prose surfaces; only the error-report
    // path opts in.
    const hash = 'a'.repeat(64);
    expect(maskSecretPatterns(`sha=${hash}`)).toContain(hash);
    expect(maskSecretPatterns(`sha=${hash}`, { includeGeneric: true })).not.toContain(hash);
  });
});


describe('URL-userinfo rule stays linear', () => {
  it('does not degrade quadratically on a long dotted run', () => {
    // The trigger is specific and the obvious fixture MISSES it: a solid hex or
    // base64 blob is linear (one `\b` start), and a space-broken stack trace is
    // linear (short runs). What degrades is ONE unbroken `[a-z0-9+.-]` run with
    // many internal word boundaries — `a.a.a.…` — because the scheme quantifier
    // restarts at each of them. Unbounded this measured 40 KB -> ~500 ms of
    // blocked event loop, and a regex cannot be interrupted.
    const input = 'a.'.repeat(20_000); // 40 KB
    const started = performance.now();
    maskSecretPatterns(input, { includeGeneric: true });
    const elapsed = performance.now() - started;
    // Headroom, measured inside vitest rather than estimated: bounded runs
    // 3–5 ms idle and 14 ms worst case under load (16 hogs on 8 cores), so the
    // bar sits ~10x above the bad case. Unbounded measures ~960 ms here, so the
    // bar sits ~6x below it. Both gaps are smaller than the "two orders of
    // magnitude" this comment first claimed — a bare wall-clock assertion with
    // no scaling comparison, kept because it demonstrably fails on the real
    // regression and holds under load, not because the margin is generous.
    expect(elapsed).toBeLessThan(150);
  });

  it('still matches the schemes the bound has to keep', () => {
    for (const scheme of ['postgres', 'amqp', 'mongodb+srv', 'https']) {
      expect(maskSecretPatterns(`${scheme}://user:hunter2@host/db`)).not.toContain('hunter2');
    }
  });
});

describe('isProtectedSecretWrite — provider key slots', () => {
  // The slots are read straight from where they are declared — the model catalog and the
  // per-provider map — not from the set the guard uses, so a guard that keeps its own
  // shorter list fails here as soon as the catalog names a slot the list does not.
  const declaredSlots = [
    ...Object.values(VAULT_SLOT_BY_PROVIDER),
    ...LLM_CATALOG.map((e) => e.vault_slot),
  ].filter((s): s is string => typeof s === 'string');

  it('the catalog declares more than the four first-party slots', () => {
    // Guards the test itself: with only the four, a hand-kept list would pass.
    expect(new Set(declaredSlots).size).toBeGreaterThan(4);
  });

  it.each([...new Set(declaredSlots)])('protects %s against an agent write', (slot) => {
    expect(isProtectedSecretWrite(slot)).toBe(true);
  });

  it('protects the SDK alias slot the engine also resolves a provider key from', () => {
    // Declared in neither source above, so it is pinned by name.
    expect(isProtectedSecretWrite('OPENAI_API_KEY')).toBe(true);
  });

  it('does not protect an ordinary API credential name', () => {
    expect(isProtectedSecretWrite('WOO_CS')).toBe(false);
    expect(isProtectedSecretWrite('SHOPIFY_TOKEN')).toBe(false);
    // Same suffix as a provider slot, not a provider slot: a guard keyed on the
    // `_API_KEY` suffix would lock the tenant's own integrations.
    expect(isProtectedSecretWrite('STRIPE_API_KEY')).toBe(false);
  });
});

describe('SECRET_SHAPES — the shared credential shape list', () => {
  // One synthetic value per shape, assembled at runtime so no scanner mistakes
  // the test file for a leak. A shape added to the list without a value here
  // fails the first test, which is the point: every shape carries a witness.
  const WITNESS: Record<string, string> = {
    'Anthropic API key': 'sk-' + 'ant-api03-' + 'A'.repeat(24),
    'OpenAI API key': 'sk-' + 'proj-' + 'Ab12_Cd34-' + 'B'.repeat(16),
    'OpenAI-style API key': 'sk-' + 'C'.repeat(24),
    'credential in URL': 'postgres://' + 'admin:hunter2' + '@db.example.com/app',
    'Stripe API key': 'sk_' + 'live_' + 'D'.repeat(20),
    'GitHub token': 'github_pat_' + 'E'.repeat(24),
    'AWS access key': 'AKIA' + 'F'.repeat(16),
    'Google OAuth token': 'ya29.' + 'G'.repeat(24),
    'Google API key': 'AIza' + 'G'.repeat(35),
    'Slack token': 'xox' + 'b-' + '1234567890-' + 'H'.repeat(12),
    'Shopify token': 'shp' + 'at_' + '0123456789abcdef'.repeat(2),
    'JWT token': 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'I'.repeat(20),
    'private key': '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
    'bearer token': 'Bearer ' + 'J'.repeat(24),
    'long token': 'K'.repeat(44),
  };

  it('every shape has a witness value, and every witness names a shape', () => {
    expect(Object.keys(WITNESS).sort()).toEqual([...new Set(SECRET_SHAPES.map((s) => s.label))].sort());
  });

  // The outbound scan's wider spellings get their own witnesses: values only the
  // wide form catches (glued to a word character, a non-`eyJ` JWT payload).
  const WIDE_WITNESS: Record<string, string> = {
    'Anthropic API key': 'X_' + 'sk-' + 'ant-api03-' + 'L'.repeat(24),
    'OpenAI-style API key': 'TOKEN_' + 'sk-' + 'M'.repeat(24),
    'GitHub token': 'TOKEN_' + 'ghp_' + 'N'.repeat(36),
    'JWT token': 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'O'.repeat(16) + '.' + 'P'.repeat(16),
  };

  it.each(SECRET_SHAPES.map((s) => [`${s.label} (${s.kind})`, s] as const))('the %s shape recognises its witness', (_name, shape) => {
    const witness = shape.kind === 'egress-wide' ? WIDE_WITNESS[shape.label] : WITNESS[shape.label];
    expect(witness).toBeDefined();
    expect(shape.pattern.test(witness!)).toBe(true);
  });

  it('keeps the wide outbound spellings out of detect/mask — they fire inside words', () => {
    expect(matchesSecretPattern('see task-abcdefghij1234567890xyz for details')).toBeNull();
    expect(maskSecretPatterns('see task-abcdefghij1234567890xyz')).toBe('see task-abcdefghij1234567890xyz');
  });

  // The glued-key lead looks ahead for a digit; it must stay linear on long runs.
  it('stays linear on long runs — every vendor shape, 300 KB each', () => {
    const runs = ['_', '_9', '%3D', '\\n', '_sk-ant-', '_ghp_9', '_AKIA'];
    const started = performance.now();
    for (const shape of SECRET_SHAPES.filter((s) => s.kind === 'vendor')) {
      const re = new RegExp(shape.pattern.source, 'g');
      for (const run of runs) run.repeat(Math.ceil(300_000 / run.length)).replace(re, 'x');
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it('keeps the generic catcher last — short-text callers drop the final entry', () => {
    expect(SECRET_SHAPES[SECRET_SHAPES.length - 1]!.kind).toBe('generic');
    expect(SECRET_SHAPES.filter((s) => s.kind === 'generic')).toHaveLength(1);
  });

  it.each(SECRET_SHAPES.filter((s) => s.kind !== 'generic' && s.kind !== 'egress-wide').map((s) => [s.label]))('masks a %s', (label) => {
    const witness = WITNESS[label]!;
    expect(maskSecretPatterns(`value: ${witness} end`)).not.toContain(witness);
  });

  // A key glued to an identifier came back whole from an API error (`LYNOX_sk-ant-…`,
  // 2026-10-06): `\b` counts `_` as part of a word, so there was no boundary to match.
  // Glued after `_`, a JSON escape or a URL escape, a shape matches when its body carries a
  // digit, so the witnesses start their body with two.
  const withDigits = (label: string, w: string): string => {
    const prefix = w.match(/^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|[sr]k_(?:live|test)_|github_pat_|gh[pousr]_|AKIA|AIza|xox[bpoasr]-|shp(?:at|ss|pa|ca)_|ya29\.)/)![0];
    expect(prefix, label).toBeTruthy();
    return prefix + '42' + w.slice(prefix.length + 2);
  };
  it.each(SECRET_SHAPES.filter((s) => s.kind === 'vendor').map((s) => [s.label]))(
    'masks and detects a %s glued to an identifier or an escape', (label) => {
      const key = withDigits(label, WITNESS[label]!);
      for (const text of [`LYNOX_${key}`, `my key:\\n${key}`, `x\\u003e${key}`, `api_key%3D${key}`]) {
        expect(maskSecretPatterns(`value: ${text} end`), text).not.toContain(key);
        expect(matchesSecretPattern(text), text).not.toBeNull();
      }
    },
  );

  it.each([
    'see task-abcdefghij1234567890xyz for details',
    'the risk_test_coverage2026abcdef report',
    'a desk_live_dashboard0123456 view',
    'pip install scikit-learn, then sk-learn',
    // snake_case names that contain a key prefix after a `_`, with no digit in them
    'if has_github_pat_configured then',
    'flag use_ghp_token_for_auth',
    'field user_ghs_enterprise_url',
    'love_xoxo-forever-and-ever',
    // ... and with a digit after the name, which must not count as the key's digit
    'flag use_ghp_token_for_auth.v2',
    'use_ghp_token_for_auth-2',
    'has_github_pat_configured_2fa',
    'config_' + 'xox' + 'b-token-v2-legacy', // assembled so the commit scan does not read it as a key
    // a prefix at a normal word start, followed by `_`: the end is still `\b`
    'the sk_test_integration_suite run',
  ])('leaves a word that only contains a key prefix alone: %s', (text) => {
    expect(maskSecretPatterns(text)).toBe(text);
    expect(matchesSecretPattern(text)).toBeNull();
  });
});

describe('maskCredentialInput', () => {
  const pemHead = '-----BEGIN ' + 'PRIVATE KEY-----';
  const pemTail = '-----END ' + 'PRIVATE KEY-----';

  it('takes a private key out as a whole block, not only its header', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    const { text, labels } = maskCredentialInput(`Key:\n${pemHead}\n${body}\n${pemTail}\nDanke`);
    expect(text).toBe('Key:\n***\nDanke');
    expect(labels).toEqual(['private key']);
  });

  it('takes a key block without its END line out to the end of the text', () => {
    const { text } = maskCredentialInput(`${pemHead}\nMIIEvQIBADANBgkqhkiG9w0`);
    expect(text).toBe('***');
  });

  it('names each kind of value it removed once', () => {
    const stripe = 'sk_' + 'live_' + 'Ab1'.repeat(6);
    const { text, labels } = maskCredentialInput(`${stripe} und ${stripe}`);
    expect(text).not.toContain(stripe);
    expect(labels).toEqual(['Stripe API key']);
  });

  it('takes several key blocks out one by one and keeps the text between them', () => {
    const block = `${pemHead}\nMIIEvQIBADANBgkqhkiG9w0\n${pemTail}`;
    expect(maskCredentialInput(`a ${block} b ${block} c`).text).toBe('a *** b *** c');
  });

  it('finds a key followed directly by a word character, as the web UI does', () => {
    const shopify = 'shp' + 'at_' + 'a1'.repeat(16);
    const stripe = 'sk_' + 'live_' + 'Ab1'.repeat(8);
    const { text } = maskCredentialInput(`${shopify}zz ${stripe}_prod`);
    expect(text).not.toContain(shopify);
    expect(text).not.toContain(stripe);
  });

  it('leaves a hash, a UUID and a plain URL alone', () => {
    const plain = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 9b2e6c1a-4f3d-4e2a-9c1b-7d8e9f0a1b2c https://shop.example/admin';
    expect(maskCredentialInput(plain)).toEqual({ text: plain, labels: [] });
  });
});

describe('withoutTypedCredentials', () => {
  it('masks the value and tells the model what was removed and to use ask_secret', () => {
    const stripe = 'sk_' + 'live_' + 'Ab1'.repeat(6);
    const out = withoutTypedCredentials(`Key ${stripe}`);
    expect(out).toBe(`Key ***${stripe.slice(-4)}\n\n[lynox: removed from this message before it was saved or sent on: Stripe API key. ` +
      'If the user meant to give you a credential, collect it with ask_secret; do not ask for it in chat again.]');
  });

  it('masks a JWT and names every kind it removed, in order', () => {
    // Built at run time: a token-shaped literal in a fixture trips the public-repo pattern scan.
    const jwt = ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    const stripe = 'sk_' + 'live_' + 'Ab1'.repeat(6);
    const out = withoutTypedCredentials(`${stripe} ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('sent on: Stripe API key, JWT token. ');
  });

  it('returns a message without one exactly as typed', () => {
    const plain = 'Wie ist der Umsatz im Q3?';
    expect(withoutTypedCredentials(plain)).toBe(plain);
  });
});
