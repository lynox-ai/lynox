import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleAuth, SCOPES, READ_ONLY_SCOPES, WRITE_SCOPES } from './google-auth.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs for token persistence
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  statSync: vi.fn().mockReturnValue({ mode: 0o100600 }),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

// Mock http server for localhost redirect flow
const mockServerInstance = {
  listen: vi.fn().mockImplementation((_port: number, _host: string, cb: () => void) => {
    // Simulate server starting on port 12345
    cb();
  }),
  address: vi.fn().mockReturnValue({ port: 12345 }),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock('node:http', () => ({
  createServer: vi.fn().mockImplementation((handler: (req: unknown, res: unknown) => void) => {
    // Store handler for tests to invoke
    (mockServerInstance as Record<string, unknown>)['_handler'] = handler;
    return mockServerInstance;
  }),
}));

vi.mock('../../core/config.js', () => ({
  getLynoxDir: () => '/tmp/test-lynox',
}));

vi.mock('../../core/atomic-write.js', () => ({
  writeFileAtomicSync: vi.fn(),
  ensureDirSync: vi.fn().mockReturnValue('/tmp/test-lynox'),
}));

describe('GoogleAuth', () => {
  let auth: GoogleAuth;

  beforeEach(() => {
    mockFetch.mockReset();
    mockServerInstance.listen.mockClear();
    mockServerInstance.close.mockClear();
    auth = new GoogleAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with client credentials', () => {
      expect(auth).toBeDefined();
      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('startLocalAuth', () => {
    it('returns auth URL with correct params', async () => {
      const { authUrl, waitForCode } = await auth.startLocalAuth();

      expect(authUrl).toContain('accounts.google.com');
      expect(authUrl).toContain('client_id=test-client-id');
      expect(authUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A12345');
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain('access_type=offline');
      expect(authUrl).toContain('gmail.readonly');
      expect(typeof waitForCode).toBe('function');

      // Clean up server
      mockServerInstance.close.mockImplementation(() => {});
    });
  });

  describe('getAccessToken', () => {
    it('throws when not authenticated', async () => {
      await expect(auth.getAccessToken()).rejects.toThrow('Not authenticated');
    });
  });

  describe('getAccountInfo', () => {
    it('returns empty info when not authenticated', () => {
      const info = auth.getAccountInfo();
      expect(info.scopes).toEqual([]);
      expect(info.expiresAt).toBeNull();
      expect(info.hasRefreshToken).toBe(false);
    });
  });

  describe('revoke', () => {
    it('handles revocation gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await auth.revoke();
      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('SCOPES', () => {
    it('exports all scope constants', () => {
      expect(SCOPES.GMAIL_READONLY).toBe('https://www.googleapis.com/auth/gmail.readonly');
      expect(SCOPES.SHEETS).toBe('https://www.googleapis.com/auth/spreadsheets');
      expect(SCOPES.DRIVE_READONLY).toBe('https://www.googleapis.com/auth/drive.readonly');
      expect(SCOPES.CALENDAR_EVENTS).toBe('https://www.googleapis.com/auth/calendar.events');
      expect(SCOPES.DOCS).toBe('https://www.googleapis.com/auth/documents');
    });
  });

  describe('scope defaults', () => {
    it('READ_ONLY_SCOPES contains only readonly scopes', () => {
      for (const scope of READ_ONLY_SCOPES) {
        expect(scope).toMatch(/readonly/);
      }
    });

    it('WRITE_SCOPES contains no readonly scopes', () => {
      for (const scope of WRITE_SCOPES) {
        expect(scope).not.toMatch(/readonly/);
      }
    });

    it('default auth URL contains only readonly scopes', async () => {
      const { authUrl } = await auth.startLocalAuth();
      expect(authUrl).toContain('gmail.readonly');
      expect(authUrl).toContain('drive.readonly');
      expect(authUrl).toContain('spreadsheets.readonly');
      expect(authUrl).not.toContain('gmail.send');
      expect(authUrl).not.toContain('gmail.modify');
      mockServerInstance.close.mockImplementation(() => {});
    });

    it('custom scopes override defaults', async () => {
      const customAuth = new GoogleAuth({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        scopes: [SCOPES.GMAIL_READONLY, SCOPES.GMAIL_SEND],
      });
      const { authUrl } = await customAuth.startLocalAuth();
      expect(authUrl).toContain('gmail.readonly');
      expect(authUrl).toContain('gmail.send');
      expect(authUrl).not.toContain('drive');
      mockServerInstance.close.mockImplementation(() => {});
    });
  });

  describe('token response validation', () => {
    it('rejects response without access_token', async () => {
      const { authUrl, waitForCode } = await auth.startLocalAuth();

      // Simulate callback with valid code
      const handler = (mockServerInstance as Record<string, unknown>)['_handler'] as (req: unknown, res: unknown) => void;
      const mockRes = { writeHead: vi.fn(), end: vi.fn() };
      const authUrlObj = new URL(authUrl);
      const state = authUrlObj.searchParams.get('state');
      handler({ url: `/?code=test-code&state=${state}` }, mockRes);

      // Mock token exchange returning invalid response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ expires_in: 3600, scope: 'email' }),
      });

      await expect(waitForCode()).rejects.toThrow('missing access_token');
    });

    it('rejects response with invalid expires_in', async () => {
      const { authUrl, waitForCode } = await auth.startLocalAuth();
      const handler = (mockServerInstance as Record<string, unknown>)['_handler'] as (req: unknown, res: unknown) => void;
      const mockRes = { writeHead: vi.fn(), end: vi.fn() };
      const authUrlObj = new URL(authUrl);
      const state = authUrlObj.searchParams.get('state');
      handler({ url: `/?code=test-code&state=${state}` }, mockRes);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'tok', expires_in: -1, scope: 'email' }),
      });

      await expect(waitForCode()).rejects.toThrow('invalid expires_in');
    });
  });

  describe('requestScope validation', () => {
    it('rejects unknown scope strings', async () => {
      await expect(auth.requestScope(['invalid.scope'])).rejects.toThrow('Unknown Google OAuth scope');
    });

    it('accepts known scopes', async () => {
      // Not authenticated, so requestScope returns auth flow
      const result = await auth.requestScope([SCOPES.GMAIL_SEND]);
      expect(result).not.toBeNull();
      expect(result!.authUrl).toContain('gmail.send');
      mockServerInstance.close.mockImplementation(() => {});
    });
  });

  describe('parseTokenData validation', () => {
    function createMockVault(data: Record<string, unknown>) {
      const store = new Map<string, string>();
      store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify(data));
      return {
        get: vi.fn((key: string) => store.get(key) ?? null),
        set: vi.fn(),
        delete: vi.fn(),
      };
    }

    it('rejects token data with non-number expires_at', () => {
      const vault = createMockVault({
        access_token: 'tok', refresh_token: 'ref',
        expires_at: 'invalid', scopes: [],
      });
      const a = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      expect(a.isAuthenticated()).toBe(false);
    });

    it('rejects token data with non-array scopes', () => {
      const vault = createMockVault({
        access_token: 'tok', refresh_token: 'ref',
        expires_at: Date.now() + 3600_000, scopes: 'not-array',
      });
      const a = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      expect(a.isAuthenticated()).toBe(false);
    });

    it('accepts valid token data', () => {
      const vault = createMockVault({
        access_token: 'tok', refresh_token: 'ref',
        expires_at: Date.now() + 3600_000, scopes: ['email'],
      });
      const a = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      expect(a.isAuthenticated()).toBe(true);
    });
  });

  describe('hasScope', () => {
    it('returns false when not authenticated', () => {
      expect(auth.hasScope(SCOPES.GMAIL_READONLY)).toBe(false);
    });
  });

  describe('getScopes', () => {
    it('returns empty array when not authenticated', () => {
      expect(auth.getScopes()).toEqual([]);
    });
  });

  describe('service account key validation', () => {
    it('rejects relative path', async () => {
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: 'relative/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow('must be absolute');
    });

    it('rejects missing file', async () => {
      const { existsSync: mockExists } = await import('node:fs');
      vi.mocked(mockExists).mockReturnValue(false);
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/nonexistent.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow('not found');
      vi.mocked(mockExists).mockReturnValue(false); // restore default
    });

    it('rejects invalid JSON', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow('invalid JSON');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    it('rejects missing required fields', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ type: 'service_account' }));
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow('missing required field');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    it('rejects wrong type field', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        type: 'authorized_user', project_id: 'p', private_key: 'k', client_email: 'e',
      }));
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow('unexpected type');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    it('warns on loose permissions', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100644 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e',
        private_key_id: 'pk', client_id: 'ci', auth_uri: 'au', token_uri: 'tu',
      }));
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      // getAccessToken will fail at JWT signing (dummy key), but the warning is already emitted
      await saAuth.getAccessToken().catch(() => {});
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('loose permissions'));
      spy.mockRestore();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });
  });

  // === Vault-backed Token Storage ===

  describe('vault token storage', () => {
    function createMockVault() {
      const store = new Map<string, string>();
      return {
        get: vi.fn((key: string) => store.get(key) ?? null),
        set: vi.fn((key: string, value: string) => { store.set(key, value); }),
        delete: vi.fn((key: string) => store.delete(key)),
        _store: store,
      };
    }

    it('loads tokens from vault when available', () => {
      const vault = createMockVault();
      vault._store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
        access_token: 'vault-access-token',
        refresh_token: 'vault-refresh-token',
        expires_at: Date.now() + 3600_000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }));

      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });

      expect(vaultAuth.isAuthenticated()).toBe(true);
      expect(vault.get).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
    });

    it('falls back to file when vault has no tokens', () => {
      const vault = createMockVault();
      // vault is empty, file mock returns false for existsSync
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });

      expect(vaultAuth.isAuthenticated()).toBe(false);
      expect(vault.get).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
    });

    it('revoke clears vault and file', async () => {
      const vault = createMockVault();
      vault._store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
        access_token: 'to-revoke',
        refresh_token: 'refresh-to-revoke',
        expires_at: Date.now() + 3600_000,
        scopes: [],
      }));

      mockFetch.mockResolvedValueOnce({ ok: true });

      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });

      await vaultAuth.revoke();
      expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
      expect(vaultAuth.isAuthenticated()).toBe(false);
    });

    it('without vault uses file storage (existing behavior)', () => {
      const noVaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
      });
      expect(noVaultAuth.isAuthenticated()).toBe(false);
    });
  });
});
