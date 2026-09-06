import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { GoogleAuth, SCOPES, STANDARD_SCOPES, SENSITIVE_EXTRA_SCOPES, RESTRICTED_SCOPES, FULL_SCOPES, computeScopeMode } from './google-auth.js';
// The fixture VALUE, not the fixture FILE: `node:fs` is mocked in this file, so
// reading the JSON here would quietly yield the stub's `{}`. The mirror is
// `satisfies`-welded to the contract type and proven byte-equal to the JSON in
// `tests/contract-http.test.ts`, so driving the mirror drives the golden bytes.
import { TYPED_MIRRORS } from '../../contract/fixtures/mirrors.js';

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

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

// §3.8 moved this module's calls onto the connector egress surface, so they now
// go through the pinned transport instead of `globalThis.fetch`. The bridge
// hands them back to the stub these tests already install; the policy gate is
// NOT bypassed. See the helper for why this is adapted rather than rewritten.
let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

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
      expect(authUrl).toContain('calendar.events');
      expect(typeof waitForCode).toBe('function');

      // Clean up server
      mockServerInstance.close.mockImplementation(() => {});
    });
  });

  describe('getAccessToken', () => {
    /**
     * `mintedBy` writes the `client_id` a stored token was minted under.
     * Omitting it is the pre-existing shape — a blob written before the field
     * existed — and every caller that omits it is asserting the UNKNOWN case.
     */
    function makeVaultWithExpiredTokens(mintedBy?: string) {
      const store = new Map<string, string>();
      store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
        access_token: 'old-token-aaaaaaaa',
        refresh_token: 'refresh-token-bbbbbbbb',
        expires_at: Date.now() - 1000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        ...(mintedBy ? { client_id: mintedBy } : {}),
      }));
      return {
        get: vi.fn((key: string) => store.get(key) ?? null),
        set: vi.fn((key: string, value: string) => { store.set(key, value); }),
        delete: vi.fn((key: string) => store.delete(key)),
      };
    }

    it('throws when not authenticated', async () => {
      await expect(auth.getAccessToken()).rejects.toThrow('Not authenticated');
    });

    it('coalesces concurrent refresh calls into a single network request', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });

      let resolveResponse: (value: Response) => void = () => {};
      const responsePromise = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      mockFetch.mockReturnValue(responsePromise);

      const callers = Array.from({ length: 50 }, () => vaultAuth.getAccessToken());
      await new Promise((r) => setImmediate(r));

      resolveResponse(
        new Response(
          JSON.stringify({
            access_token: 'new-token-cccccccc',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const tokens = await Promise.all(callers);

      expect(tokens.every((t) => t === 'new-token-cccccccc')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('clears in-flight guard so a later refresh can proceed', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'first-refresh-dddddddd',
            expires_in: 1,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const t1 = await vaultAuth.getAccessToken();
      expect(t1).toBe('first-refresh-dddddddd');

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'second-refresh-eeeeeeee',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const t2 = await vaultAuth.getAccessToken();
      expect(t2).toBe('second-refresh-eeeeeeee');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // Audit S-CR-M2 / memory fb_oauth_refresh: transient 5xx/429 must NOT
    // wipe the refresh token. `invalid_grant` is the ONLY code that does —
    // `invalid_client` is our own misconfiguration and leaves the user's
    // grant at Google untouched, so wiping it would destroy recoverable data.
    it('keeps the refresh token on a 503 transient failure', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }));
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/503/);
      // Vault still has the token — only a re-tryable error was thrown.
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('keeps the refresh token on a 429 rate limit', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(new Response('quota exceeded', { status: 429 }));
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/429/);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('DOES wipe the vault on invalid_grant — the token is truly dead', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_grant/);
      expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
      // The vault and the in-memory copy must go together — a wipe that
      // leaves `tokenData` set would keep the instance falsely authenticated
      // until the process restarts.
      expect(vaultAuth.isAuthenticated()).toBe(false);
    });

    // The three tests below are ONE claim in three states, and they only mean
    // something together: an `invalid_grant` must delete when the token was
    // minted by the client presenting it, must NOT delete when it was minted by
    // a different one, and must keep deleting when nobody knows. Drop any one
    // and the remaining two are satisfied by a swap in the other direction —
    // "never delete" passes the first alone, "always delete" passes the last two.
    it('KEEPS the token when invalid_grant comes back under a DIFFERENT client id', async () => {
      const vault = makeVaultWithExpiredTokens('minting-client-id');
      const vaultAuth = new GoogleAuth({
        clientId: 'a-different-client-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // Asserting the REMEDY, not merely the absence of a delete: the point is
      // that this is re-read as our misconfiguration. A test that only checked
      // "not deleted" would also pass if the refresh had silently become a
      // transient failure, which would tell the user to retry forever.
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/Your Google connection is intact/);
      expect(vault.delete).not.toHaveBeenCalled();
      expect(vaultAuth.isAuthenticated()).toBe(true);
    });

    it('names BOTH ways out of a foreign grant, because it cannot tell a typo from a rotation', async () => {
      // The generic `client-misconfigured` text says the credentials are not
      // valid and an operator should correct them. After a DELIBERATE client
      // change that is false twice over — the credentials are fine, and the fix
      // is to reconnect. Nothing here can distinguish the two causes, so the
      // text has to carry both; asserting on it is what stops a later edit from
      // collapsing this back onto the generic sentence.
      const vault = makeVaultWithExpiredTokens('the-previous-client');
      const vaultAuth = new GoogleAuth({
        clientId: 'the-current-client',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        }),
      );
      const err = await vaultAuth.getAccessToken().catch((e: unknown) => e as Error);
      expect(err.message).toMatch(/different Google client/);
      expect(err.message).toMatch(/Restore the previous client/);
      expect(err.message).toMatch(/reconnect the account/);
      // And NOT the generic operator text, which would send them after a
      // credential that is not broken.
      expect(err.message).not.toMatch(/are not valid/);
    });

    it('treats an EMPTY stored client id as unknown, not as a mismatch', async () => {
      // Every writer gates its stamp on truthiness, so `''` can only reach the
      // blob by hand or through an older writer. Reading it as "minted by the
      // empty client" makes it differ from every real id and keeps a revoked
      // token for good — the same swap this change exists to avoid, arriving
      // through the comparison instead of through the delete.
      //
      // The stored side, not the configured one: a configured `clientId: ''` is
      // refused by `requireOwnPair` long before the refresh answers, so that
      // direction has no reachable case to pin.
      const store = new Map<string, string>();
      store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
        access_token: 'old-token-aaaaaaaa',
        refresh_token: 'refresh-token-bbbbbbbb',
        expires_at: Date.now() - 1000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        client_id: '',
      }));
      const vault = {
        get: vi.fn((k: string) => store.get(k) ?? null),
        set: vi.fn((k: string, v: string) => { store.set(k, v); }),
        delete: vi.fn((k: string) => store.delete(k)),
      };
      const vaultAuth = new GoogleAuth({
        clientId: 'a-real-client-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_grant/);
      expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
    });

    it('STILL deletes when invalid_grant comes back under the SAME client id', async () => {
      const vault = makeVaultWithExpiredTokens('the-one-client-id');
      const vaultAuth = new GoogleAuth({
        clientId: 'the-one-client-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_grant/);
      expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
      expect(vaultAuth.isAuthenticated()).toBe(false);
    });

    it('records the minting client id on a successful refresh, so an existing token stops being unknown', async () => {
      // Without this the fix reaches only connections made after it shipped:
      // every blob already in a vault predates the field, reads as UNKNOWN, and
      // the comparison stands down for good.
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'the-configured-client-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'fresh-token-cccccccc', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await vaultAuth.getAccessToken();

      const written = vault.set.mock.calls.at(-1)?.[1];
      expect(written).toBeDefined();
      expect(JSON.parse(written as string).client_id).toBe('the-configured-client-id');
    });

    // The two transient tests above send NON-JSON bodies at 5xx/429, so they
    // return at the status check and never enter the parse. These three drive
    // the branches underneath it; without them a flip of either `transient`
    // return survives with a green suite.
    it('keeps the token on a 401 with an HTML error page from a proxy', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response('<html><body>401 Unauthorized</body></html>', {
          status: 401,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/401/);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('keeps the token on a 4xx JSON body naming no code we classify', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_scope' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_scope/);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it.each(['unauthorized_client', 'deleted_client'])(
      'treats %s as our misconfiguration, not as something to retry',
      async (code) => {
        const vault = makeVaultWithExpiredTokens();
        const vaultAuth = new GoogleAuth({
          clientId: 'test-id',
          clientSecret: 'test-secret',
          vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
        });
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: code }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        const err = await vaultAuth.getAccessToken().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/connection is intact/);
        expect(vault.delete).not.toHaveBeenCalled();
      },
    );

    it('does NOT arm the brake on a transient failure', async () => {
      // The brake is `else if (client-misconfigured)`. Weakened to a bare
      // `else`, a single 503 would suppress refreshes for five minutes while
      // still telling the user to "retry in a moment" — and every other test
      // here fires exactly one call, so nothing else would notice.
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockImplementation(() => Promise.resolve(new Response('Service unavailable', { status: 503 })));
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/503/);
      const afterFirst = mockFetch.mock.calls.length;
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/503/);
      expect(mockFetch.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('holds the brake past the 120s mail-watch tick, then lets a retry through', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'wrong-id',
        clientSecret: 'wrong-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ));
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_client/);
      const armed = mockFetch.mock.calls.length;

      // A window shorter than the watch interval is a brake the watcher never
      // feels — this is the assertion that fails if the constant is lowered.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 121_000);
        await expect(vaultAuth.getAccessToken()).rejects.toThrow(/suppressed/);
        expect(mockFetch.mock.calls.length).toBe(armed);

        vi.setSystemTime(Date.now() + 301_000);
        await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_client/);
        expect(mockFetch.mock.calls.length).toBeGreaterThan(armed);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops hammering Google once it has said our credentials are wrong', async () => {
      // Keeping the token removed the accidental circuit breaker the wipe
      // provided. Without a cool-down every caller retries forever — this is
      // the test that fails if the brake is dropped again.
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'wrong-id',
        clientSecret: 'wrong-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ));
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_client/);
      const callsAfterFirst = mockFetch.mock.calls.length;

      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/suppressed/);
      expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('keeps the token when a 5xx carries a JSON invalid_grant body', async () => {
      // Google's 5xx responses ARE JSON, so the status check must win over the
      // body. Without this case, moving the status check below the parse
      // survives every other test in this block.
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/503/);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('does NOT wipe the vault on invalid_client — our credentials are wrong, the grant is not', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'wrong-id',
        clientSecret: 'wrong-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_client/);
      expect(vault.delete).not.toHaveBeenCalled();
    });

    it('tells the user their connection is intact rather than sending them back through consent', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'wrong-id',
        clientSecret: 'wrong-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      // The remedy the user reads must name the real fix. "Re-connect your
      // Google account" would be a lie here — re-consenting changes nothing
      // while the app's own credentials are wrong.
      // ONE call, ONE mocked response, both directions asserted on the same
      // string — a second `getAccessToken()` here would hit an unmocked fetch
      // and any assertion on its message would pass for the wrong reason.
      const err = await vaultAuth.getAccessToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/connection is intact/);
      expect((err as Error).message).not.toMatch(/Re-connect your Google account/);
    });

    // The point of keeping the token: once the credentials are corrected the
    // connection heals with no user action. Under the old behaviour the vault
    // entry was already gone by then, so this could not pass.
    it('recovers on the next refresh once the credentials are fixed', async () => {
      const vault = makeVaultWithExpiredTokens();
      const vaultAuth = new GoogleAuth({
        clientId: 'wrong-id',
        clientSecret: 'wrong-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(vaultAuth.getAccessToken()).rejects.toThrow(/invalid_client/);

      // A FRESH instance over the same vault — the first one still holds the
      // token in memory, so reusing it would pass even if the vault entry had
      // been deleted. Recovery has to come off disk.
      const healed = new GoogleAuth({
        clientId: 'correct-id',
        clientSecret: 'correct-secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'healed-token-cccccccc', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(healed.getAccessToken()).resolves.toBe('healed-token-cccccccc');
    });
  });

  // ── The three minting flows, one test each ──────────────────────────────
  // Three tests rather than one, because the thing being pinned is a call
  // ARGUMENT at three separate sites: `validateTokenResponse(json, clientId)`.
  // A single test kills the mutation "stop stamping inside the helper" but
  // leaves "drop the argument at THIS site" alive at the other two — and the
  // site that rots is never the one that got the test.
  describe('the minting client id is recorded on every flow that mints', () => {
    // Belt for the device-flow case: its `try/finally` restores real timers on a
    // thrown assertion, but not if the test aborts before reaching the block —
    // and a leaked fake clock turns every later test in the file into a mystery.
    afterEach(() => { vi.useRealTimers(); });

    function vaultSpy() {
      const store = new Map<string, string>();
      return {
        get: vi.fn((k: string) => store.get(k) ?? null),
        set: vi.fn((k: string, v: string) => { store.set(k, v); }),
        delete: vi.fn((k: string) => store.delete(k)),
      };
    }
    const okToken = () => new Response(
      JSON.stringify({
        access_token: 'minted-token-dddddddd',
        refresh_token: 'minted-refresh-eeeeeeee',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const storedClientId = (vault: ReturnType<typeof vaultSpy>): unknown => {
      const last = vault.set.mock.calls.at(-1)?.[1];
      return JSON.parse(last as string).client_id;
    };

    it('a fresh grant ends the suppression window, as a claim already did', async () => {
      // `setTokens` clears the cool-down on a fresh grant; the three minting
      // flows did not, and this change makes that gap reachable: a mismatch now
      // ARMS the window, and the self-host way out of a mismatch is to re-consent
      // through exactly these flows. Without this the user's reconnect worked and
      // the next call still answered "suppressed" for up to five minutes.
      // Seeded BEFORE construction: `GoogleAuth` loads the vault in its
      // constructor, so a mock installed afterwards is never read.
      const store = new Map<string, string>();
      store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
        access_token: 'old-token-aaaaaaaa',
        refresh_token: 'refresh-token-bbbbbbbb',
        expires_at: Date.now() - 1000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        client_id: 'the-previous-client',
      }));
      const vault = {
        get: vi.fn((k: string) => store.get(k) ?? null),
        set: vi.fn((k: string, v: string) => { store.set(k, v); }),
        delete: vi.fn((k: string) => store.delete(k)),
      };
      const a = new GoogleAuth({
        clientId: 'the-current-client',
        clientSecret: 's',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      // Arm the window through the foreign-grant path.
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'invalid_grant' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ));
      await expect(a.getAccessToken()).rejects.toThrow(/different Google client/);
      await expect(a.getAccessToken()).rejects.toThrow(/suppressed/);

      // Re-consent, and the window must be gone — not merely expired.
      //
      // The minted token is deliberately SHORT-LIVED. A full-hour token would
      // make the next `getAccessToken()` serve it straight from memory without
      // ever entering `_doRefresh`, so the suppression check would go untouched
      // and this test would pass whether or not the window was cleared. It read
      // as coverage and was measured as a survivor; the expiry is what turns it
      // into an assertion.
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          access_token: 'minted-token-dddddddd',
          refresh_token: 'minted-refresh-eeeeeeee',
          expires_in: 1,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      await a.exchangeRedirectCode('fresh-code', 'https://example.test/cb');

      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          access_token: 'post-reconnect-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      expect(await a.getAccessToken()).toBe('post-reconnect-token');
    });

    it('exchangeRedirectCode — the flow the web UI drives', async () => {
      const vault = vaultSpy();
      const a = new GoogleAuth({
        clientId: 'redirect-flow-client',
        clientSecret: 's',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(okToken());
      await a.exchangeRedirectCode('the-code', 'https://example.test/cb');
      expect(storedClientId(vault)).toBe('redirect-flow-client');
    });

    it('startLocalAuth — the self-host CLI flow', async () => {
      const vault = vaultSpy();
      const a = new GoogleAuth({
        clientId: 'local-flow-client',
        clientSecret: 's',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      const { authUrl, waitForCode } = await a.startLocalAuth();
      const handler = (mockServerInstance as Record<string, unknown>)['_handler'] as (req: unknown, res: unknown) => void;
      const state = new URL(authUrl).searchParams.get('state');
      handler({ url: `/?code=test-code&state=${state}` }, { writeHead: vi.fn(), end: vi.fn() });
      mockFetch.mockResolvedValueOnce(okToken());
      await waitForCode();
      expect(storedClientId(vault)).toBe('local-flow-client');
    });

    it('startDeviceFlow — the headless flow', async () => {
      const vault = vaultSpy();
      const a = new GoogleAuth({
        clientId: 'device-flow-client',
        clientSecret: 's',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          device_code: 'dc', user_code: 'uc',
          verification_url: 'https://example.test/d', expires_in: 300, interval: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      const { waitForAuth } = await a.startDeviceFlow();
      mockFetch.mockResolvedValueOnce(okToken());

      // The poll floor is 5s (`DEVICE_POLL_INTERVAL_MS`), above vitest's default
      // timeout, so the wait is driven rather than slept through.
      vi.useFakeTimers();
      try {
        const pending = waitForAuth();
        await vi.advanceTimersByTimeAsync(6_000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(storedClientId(vault)).toBe('device-flow-client');
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
    /**
     * The claim in the PRD title: the default consent set is CASA-free.
     * CASA attaches to RESTRICTED scopes only, so the assertion is an empty
     * intersection — not "no scope contains the word readonly", which is what
     * the removed READ_ONLY/WRITE pair asserted and which is a statement about
     * spelling rather than about Google's classification.
     */
    it('the default set intersects the restricted set nowhere', () => {
      const restricted = new Set<string>(RESTRICTED_SCOPES);
      const overlap = STANDARD_SCOPES.filter((s) => restricted.has(s));
      expect(overlap).toEqual([]);
      // Positive control: the assertion CAN see an overlap. Without it, an
      // empty STANDARD_SCOPES would pass just as quietly.
      expect([...STANDARD_SCOPES, SCOPES.DRIVE].filter((s) => restricted.has(s)))
        .toEqual([SCOPES.DRIVE]);
    });

    /**
     * The allowlist may not NARROW. `requestScope` throws on anything outside
     * `VALID_SCOPES`, so a tenant whose `google_oauth_scopes` names a scope
     * that used to be accepted breaks on its next re-consent — and no test
     * that only looks at the new sets would ever see it. The twelve are
     * pinned as literals, not derived from the sets they are checking.
     */
    it('still accepts every scope that was valid before the sets were re-cut', async () => {
      const TWELVE_AS_OF_2026_09_06 = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/documents',
      ];
      expect(TWELVE_AS_OF_2026_09_06).toHaveLength(12);
      for (const scope of TWELVE_AS_OF_2026_09_06) {
        expect(FULL_SCOPES).toContain(scope);
      }
      // And the throw is real: an unknown scope still refuses, so the loop
      // above is not passing against a `requestScope` that validates nothing.
      await expect(auth.requestScope(['https://www.googleapis.com/auth/not-a-scope']))
        .rejects.toThrow(/Unknown Google OAuth scope/);
    });

    it('the three sets are disjoint', () => {
      const all = [...STANDARD_SCOPES, ...SENSITIVE_EXTRA_SCOPES, ...RESTRICTED_SCOPES];
      expect(new Set(all).size).toBe(all.length);
      expect(FULL_SCOPES).toHaveLength(all.length);
    });

    it('default auth URL requests the standard set and no restricted scope', async () => {
      const { authUrl } = await auth.startLocalAuth();
      expect(authUrl).toContain('calendar.events');
      expect(authUrl).toContain('drive.file');
      // The scopes that make an app pay for CASA — none of them is requested.
      expect(authUrl).not.toContain('gmail.readonly');
      expect(authUrl).not.toContain('drive.readonly');
      expect(authUrl).not.toContain('gmail.modify');
      // `drive.file` is a substring-neighbour of `drive`; assert the encoded
      // scope parameter does not carry bare `/auth/drive` as its own entry.
      expect(decodeURIComponent(authUrl).split(' ')).not.toContain('https://www.googleapis.com/auth/drive');
      mockServerInstance.close.mockImplementation(() => {});
    });

    describe('computeScopeMode', () => {
      it('reports full only when every full scope is granted', () => {
        expect(computeScopeMode([...FULL_SCOPES])).toBe('full');
        expect(computeScopeMode(FULL_SCOPES.slice(1))).not.toBe('full');
      });

      it('reports standard for exactly the standard grant', () => {
        expect(computeScopeMode([...STANDARD_SCOPES])).toBe('standard');
      });

      it('reports legacy for a grant that satisfies neither set', () => {
        // The old read-only bundle: it is not a mode anyone can choose today.
        expect(computeScopeMode([
          SCOPES.GMAIL_READONLY, SCOPES.SHEETS_READONLY, SCOPES.DRIVE_READONLY,
          SCOPES.CALENDAR_READONLY, SCOPES.DOCS_READONLY,
        ])).toBe('legacy');
      });

      it('treats a per-tenant scope override as the required standard set', () => {
        const override = [SCOPES.CALENDAR_EVENTS];
        // Would be `legacy` against the built-in standard set, because it is
        // missing openid/userinfo/freebusy/drive.file.
        expect(computeScopeMode([SCOPES.CALENDAR_EVENTS])).toBe('legacy');
        expect(computeScopeMode([SCOPES.CALENDAR_EVENTS], override)).toBe('standard');
      });
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

    it('rejects token data with a non-string client_id', () => {
      // Checked like every other field rather than trusted through the cast. A
      // non-string compares unequal to any real client id, so the blob would be
      // read as permanently foreign and its grant kept forever — a corrupt field
      // turning into a policy. Refusing the blob is the same answer the four
      // fields above already give.
      const vault = createMockVault({
        access_token: 'tok', refresh_token: 'ref',
        expires_at: Date.now() + 3_600_000, scopes: [],
        client_id: 42,
      });
      const a = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      expect(a.isAuthenticated()).toBe(false);
    });

    it('accepts token data with no client_id at all — the pre-existing shape', () => {
      // The counterpart, so the check above cannot be "fixed" by rejecting the
      // absent case too: every blob written before this field existed has none,
      // and refusing those would log the whole fleet out.
      const vault = createMockVault({
        access_token: 'tok', refresh_token: 'ref',
        expires_at: Date.now() + 3_600_000, scopes: [],
      });
      const a = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
      });
      expect(a.isAuthenticated()).toBe(true);
    });

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

    it('rejects a service-account key with attacker-controlled token_uri', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        type: 'service_account',
        project_id: 'p',
        private_key: 'k',
        client_email: 'e',
        private_key_id: 'pk',
        client_id: 'ci',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'http://169.254.169.254/latest/meta-data/',
      }));
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow(/unexpected token_uri/i);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    it('rejects a service-account key with missing token_uri (fail-closed)', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        type: 'service_account',
        project_id: 'p',
        private_key: 'k',
        client_email: 'e',
        private_key_id: 'pk',
        client_id: 'ci',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        // token_uri intentionally omitted
      }));
      const saAuth = new GoogleAuth({
        clientId: 'id', clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
      await expect(saAuth.getAccessToken()).rejects.toThrow(/unexpected token_uri/i);
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

  describe('service account token caching', () => {
    // Real RSA keypair so the JWT signing path inside _mintServiceAccountToken
    // actually produces a valid token. ~50-200ms once per file run.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const SA_KEY_JSON = JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      private_key_id: 'k1',
      private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      client_email: 'svc@p.iam.gserviceaccount.com',
      client_id: '0',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    });

    beforeEach(async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValue(SA_KEY_JSON);
    });

    afterEach(async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    function makeSaAuth(): GoogleAuth {
      return new GoogleAuth({
        clientId: 'id',
        clientSecret: 'secret',
        serviceAccountKeyPath: '/tmp/key.json',
      });
    }

    function tokenResponse(token: string, expiresInSeconds = 3600): Response {
      return new Response(
        JSON.stringify({
          access_token: token,
          expires_in: expiresInSeconds,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    it('caches the token across calls within the validity window', async () => {
      const saAuth = makeSaAuth();
      mockFetch.mockResolvedValueOnce(tokenResponse('sa-token-1'));

      const t1 = await saAuth.getAccessToken();
      const t2 = await saAuth.getAccessToken();
      const t3 = await saAuth.getAccessToken();

      expect(t1).toBe('sa-token-1');
      expect(t2).toBe('sa-token-1');
      expect(t3).toBe('sa-token-1');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent mints when cache is empty', async () => {
      const saAuth = makeSaAuth();

      let resolveResponse: (value: Response) => void = () => {};
      const responsePromise = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      mockFetch.mockReturnValue(responsePromise);

      const callers = Array.from({ length: 50 }, () => saAuth.getAccessToken());
      await new Promise((r) => setImmediate(r));

      resolveResponse(tokenResponse('sa-token-coalesce'));
      const tokens = await Promise.all(callers);

      expect(tokens.every((t) => t === 'sa-token-coalesce')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('re-mints once the cached token falls inside the refresh-buffer window', async () => {
      const saAuth = makeSaAuth();

      // First mint: token "expires" in 1s — already inside the 5-minute
      // refresh buffer, so the next call must re-mint.
      mockFetch.mockResolvedValueOnce(tokenResponse('sa-token-old', 1));
      const t1 = await saAuth.getAccessToken();
      expect(t1).toBe('sa-token-old');

      mockFetch.mockResolvedValueOnce(tokenResponse('sa-token-new', 3600));
      const t2 = await saAuth.getAccessToken();
      expect(t2).toBe('sa-token-new');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears in-flight slot on error so the next call can retry', async () => {
      const saAuth = makeSaAuth();

      mockFetch.mockResolvedValueOnce(
        new Response('rate limited', { status: 429 }),
      );
      await expect(saAuth.getAccessToken()).rejects.toThrow('Service account token exchange failed');

      mockFetch.mockResolvedValueOnce(tokenResponse('sa-token-after-recovery'));
      const t = await saAuth.getAccessToken();
      expect(t).toBe('sa-token-after-recovery');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

// ── OAuth claim: the control plane's handoff body ─────────────────────────
//
// `setTokens` is the engine's REAL parser for `/internal/oauth/google/claim`
// (PRD-CORE-PRO-CONTRACT §2.3 #5). The pair partner drives the same golden
// bytes against the control plane's route in the private repo, so a field
// rename fails on whichever side moves first.
//
// The claim is the seam where a rename is most expensive and least visible:
// the HTTP call still returns 200, the tokens land as `undefined`, and the
// failure only surfaces later as an unrelated Google auth error. Hence the
// drop-a-field probes below — the guard must reject, not shrug.
describe('setTokens — OAuth claim fixture (contract §2.3 #5)', () => {
  const fixture = TYPED_MIRRORS['oauth-claim-response.json'] as Record<string, unknown>;

  function makeVaultAuth(): { auth: GoogleAuth; vault: { set: ReturnType<typeof vi.fn> } } {
    const vault = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
    const vaultAuth = new GoogleAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
    });
    return { auth: vaultAuth, vault };
  }

  it('accepts the golden claim body and stores every field', async () => {
    const { auth: vaultAuth, vault } = makeVaultAuth();
    await vaultAuth.setTokens(fixture as unknown as Parameters<GoogleAuth['setTokens']>[0]);
    expect(vaultAuth.isAuthenticated()).toBe(true);
    expect(vaultAuth.getScopes()).toEqual(fixture['scopes']);
    // Round-trips through the vault unchanged — the stored blob IS the claim.
    const stored = JSON.parse(vault.set.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(stored).toEqual(fixture);
  });

  it('a claim WITH an email stores it — driven directly, because the fixture cannot', async () => {
    // The golden fixture carries no `email`: its serializer is the control
    // plane, which does not emit one until W6, and a fixture with a field its
    // serializer does not produce is hand-written (`fixtures/README.md`). So the
    // storing behaviour is driven from a constructed body instead. Without this
    // test, deleting the field from `setTokens` leaves the whole suite green —
    // measured, not assumed: the fixture was the only thing exercising it.
    const { auth: vaultAuth, vault } = makeVaultAuth();
    await vaultAuth.setTokens({
      ...(fixture as Record<string, unknown>),
      email: 'test-user@accounts.invalid',
    } as unknown as Parameters<GoogleAuth['setTokens']>[0]);
    const stored = JSON.parse(vault.set.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(stored['email'], 'a claim that carries an address must keep it').toBe('test-user@accounts.invalid');
  });

  it('a claim WITHOUT an email stores no email key — absent means unknown', async () => {
    // The contract calls `email` optional, and optional here means a grant made
    // before Stage 1 asked for `openid email`.
    //
    // ⚠ What this assert can and cannot see, measured rather than assumed: it
    // reads the SERIALISED blob, and `JSON.stringify` drops an `undefined`
    // value. So writing `email: data.email` unconditionally leaves this test
    // GREEN — the key never reaches the JSON. It is the next test, with an
    // empty string, that kills that mutation, because `''` survives the
    // serialisation. Both are kept: this one pins the blob shape a later reader
    // will diff against, the other one does the catching.
    const { auth: vaultAuth, vault } = makeVaultAuth();
    const { email: _dropped, ...withoutEmail } = fixture as Record<string, unknown>;
    await vaultAuth.setTokens(withoutEmail as unknown as Parameters<GoogleAuth['setTokens']>[0]);
    const stored = JSON.parse(vault.set.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect('email' in stored, 'no email in the claim ⇒ no email key in the blob').toBe(false);
  });

  it('an EMPTY email is unknown too, not an address that happens to be blank', async () => {
    // `''` reaches here the same way any other value does. Storing it would put
    // an empty string on the card where an address belongs; treating it as
    // unknown keeps the fallback that already handles the absent case.
    const { auth: vaultAuth, vault } = makeVaultAuth();
    await vaultAuth.setTokens({ ...(fixture as Record<string, unknown>), email: '' } as unknown as Parameters<GoogleAuth['setTokens']>[0]);
    const stored = JSON.parse(vault.set.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect('email' in stored, 'an empty address is not an address').toBe(false);
  });

  it('records NO minting client id — the control plane minted these, not this instance', async () => {
    // The assertion above already fails if a `client_id` appears here, but it
    // fails as "the blob is not the claim" and invites the repair of adding the
    // field to the fixture. This one names the reason, so that repair reads as
    // wrong: `setTokens` is reached only by `POST /api/google/claim-managed`
    // (the sole non-test caller), where lynox's BROKER client minted the token.
    // Stamping this instance's own `clientId` would assert a provenance nobody
    // measured — and `reclassifyForeignGrant` would then read a real revocation
    // as a client mismatch and keep a dead token forever.
    const { auth: vaultAuth, vault } = makeVaultAuth();
    await vaultAuth.setTokens(fixture as unknown as Parameters<GoogleAuth['setTokens']>[0]);
    const stored = JSON.parse(vault.set.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(stored['client_id']).toBeUndefined();
  });

  for (const field of ['access_token', 'refresh_token', 'expires_at', 'scopes'] as const) {
    it(`rejects the body when \`${field}\` is renamed away (the silent-drift probe)`, async () => {
      const { auth: vaultAuth } = makeVaultAuth();
      const mutated = { ...fixture };
      delete mutated[field];
      // Named field, not just /Invalid token data/: all four guards share that
      // prefix, so the loose form passes even when a DIFFERENT guard fired —
      // which would mean the field under test is unguarded and the probe is
      // reporting someone else's rejection.
      await expect(
        vaultAuth.setTokens(mutated as unknown as Parameters<GoogleAuth['setTokens']>[0]),
      ).rejects.toThrow(new RegExp(`Invalid token data: ${field}`));
    });
  }

  it('rejects a SECONDS-valued expires_at — the field is epoch milliseconds', async () => {
    const { auth: vaultAuth } = makeVaultAuth();
    const seconds = { ...fixture, expires_at: Math.floor((fixture['expires_at'] as number) / 1000) };
    await expect(
      vaultAuth.setTokens(seconds as unknown as Parameters<GoogleAuth['setTokens']>[0]),
    ).rejects.toThrow(/expires_at/);
  });
});

describe('refresh through the control plane (the client secret stays there)', () => {
  // The decision this implements: lynox's Google client secret never leaves the
  // control plane. An engine holding a raw refresh token needs that secret to
  // use it, which is why the secret was going to be emitted into every tenant.
  // With a sealed handle the exchange happens CP-side and the engine never has
  // the secret at all.
  // A placeholder, not the real control-plane hostname: this is the PUBLIC repo,
  // and the test asserts the PATH and headers, which the host does not affect.
  const CP = 'https://cp.invalid';
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_HTTP_SECRET'] as const;

  function setEnv(managed: boolean): void {
    for (const k of ENV) saved[k] = process.env[k];
    if (managed) {
      process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = CP;
      process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
      process.env['LYNOX_HTTP_SECRET'] = 'instance-secret-value';
    } else {
      for (const k of ENV) delete process.env[k];
    }
  }

  // Reset BEFORE each test, not only after. These assertions read
  // `mockFetch.mock.calls[0]`, and this describe sits outside the one whose
  // beforeEach clears the mock — so without this the first "call" is a leftover
  // from an earlier describe and the assertion reads a URL nobody in this test
  // requested. Measured: the CP test passed in isolation and failed in the full
  // file, which is the signature of exactly this.
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    for (const k of ENV) {
      const v = saved[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    mockFetch.mockReset();
  });

  function vaultWith(extra: Record<string, unknown>): {
    get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>;
    stored: () => Record<string, unknown>;
  } {
    const store = new Map<string, string>();
    store.set('GOOGLE_OAUTH_TOKENS', JSON.stringify({
      access_token: 'old-token-aaaaaaaa',
      refresh_token: 'refresh-token-bbbbbbbb',
      expires_at: Date.now() - 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      ...extra,
    }));
    return {
      get: vi.fn((k: string) => store.get(k) ?? null),
      set: vi.fn((k: string, v: string) => { store.set(k, v); }),
      delete: vi.fn((k: string) => store.delete(k)),
      stored: () => JSON.parse(store.get('GOOGLE_OAUTH_TOKENS') ?? '{}') as Record<string, unknown>,
    };
  }

  const authWith = (vault: { get: unknown }): GoogleAuth => new GoogleAuth({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    vault: vault as unknown as import('../../core/secret-vault.js').SecretVault,
  });

  it('calls the control plane, not Google, when a handle is present', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'cp-issued-token', expires_at: Date.now() + 3_600_000 }),
    });

    const token = await authWith(vault).getAccessToken();

    expect(token).toBe('cp-issued-token');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url, 'the refresh must go to the control plane').toBe(`${CP}/internal/oauth/google/refresh`);
    // The negative half, and the one that matters: Google must not be reached at
    // all. Asserting only the CP URL would pass an implementation that called
    // both, which is the shape that leaks the secret while looking correct.
    // `not.toContain` on `url` cannot express that — the line above already
    // pins `url` by equality, so it could never fail on its own. Counting the
    // calls can.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The secret must not be replayed to a redirect target either. This used to
    // assert `init.redirect === 'manual'` — the REQUEST for the property. Since
    // §3.8 the property is enforced by `cpFetch` (which uses `fetchPinned`, a
    // transport with no redirect handling), so the option is gone and asserting
    // it would pin a request nobody honours. The next test drives the EFFECT: a
    // 302 from the control plane surfaces as a 302 instead of being followed,
    // and it fails against any implementation that routes this call through the
    // redirect-following helper.
    expect((init.headers as Record<string, string>)['x-instance-secret']).toBe('instance-secret-value');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ instance_id: 'inst-1', refresh_handle: 'sealed-handle-1' });
    // And the client secret appears nowhere in the request.
    expect(JSON.stringify(init)).not.toContain('test-secret');
  });

  it('calls Google directly when there is no handle (self-host is unchanged)', async () => {
    setEnv(true);
    const vault = vaultWith({});
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'google-token', expires_in: 3600, scope: '', token_type: 'Bearer' }),
    });

    await authWith(vault).getAccessToken();

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('oauth2.googleapis.com');
  });

  // All three env values or none. A half-configured instance must not build a
  // request it cannot authenticate — it would fail at the CP with a 403 that
  // reads like a revoked grant.
  //
  // Parameterised over all three deliberately: with only one of them driven,
  // deleting either of the other two conjuncts from the guard left the whole
  // file green. A three-way `||` needs three tests, not one.
  it.each(ENV)('falls back to Google when %s is missing', async (missing) => {
    setEnv(true);
    delete process.env[missing];
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'google-token', expires_in: 3600, scope: '', token_type: 'Bearer' }),
    });

    await authWith(vault).getAccessToken();

    expect((mockFetch.mock.calls[0] as [string])[0]).toContain('oauth2.googleapis.com');
  });

  // A base URL that carries a query or a fragment does not get a path appended —
  // it gets its query extended, and the request leaves with the instance secret.
  it.each([
    ['a query', 'https://cp.invalid/?to=elsewhere'],
    // An EMPTY query is the case the first version of this guard let through:
    // `new URL('https://cp.invalid/?').search` is '', but `href` keeps the '?',
    // so the endpoint would have been appended into the query string.
    ['an empty query', 'https://cp.invalid/?'],
    ['an empty fragment', 'https://cp.invalid/#'],
    ['a fragment', 'https://cp.invalid/#x'],
    ['embedded credentials', 'https://user:pw@cp.invalid/'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['an unparseable value', 'not a url'],
  ])('falls back to Google when the control-plane URL carries %s', async (_why, raw) => {
    setEnv(true);
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = raw;
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'google-token', expires_in: 3600, scope: '', token_type: 'Bearer' }),
    });

    await authWith(vault).getAccessToken();

    expect((mockFetch.mock.calls[0] as [string])[0]).toContain('oauth2.googleapis.com');
  });

  it('replaces the stored handle when Google rotated it', async () => {
    // Google may rotate the refresh token on any refresh. Keeping the old handle
    // means the NEXT refresh presents one Google already invalidated — an hour
    // later, with nothing pointing back here.
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'cp-issued-token',
        expires_at: Date.now() + 3_600_000,
        refresh_handle: 'sealed-handle-2',
      }),
    });

    await authWith(vault).getAccessToken();

    expect(vault.stored()['refresh_handle']).toBe('sealed-handle-2');
  });

  it('keeps the old handle when the response carries none', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'cp-issued-token', expires_at: Date.now() + 3_600_000 }),
    });

    const token = await authWith(vault).getAccessToken();

    // Asserting the handle UNCHANGED is asserting the pre-state, so an
    // implementation that refreshes nothing at all satisfies it. Measured: with
    // the staleness check disabled so no refresh can fire, this test still
    // passed. Something that DID change has to be asserted alongside, or
    // "preserved" is indistinguishable from "never ran".
    expect(token).toBe('cp-issued-token');
    expect(vault.stored()['access_token']).toBe('cp-issued-token');
    expect(vault.stored()['refresh_handle']).toBe('sealed-handle-1');
  });

  it('does NOT refresh again while the access token is still valid', async () => {
    // With refresh routed through the control plane, caching stops being an
    // optimisation: an uncached engine would reach for the CP on every Google
    // call rather than on every expiry, making it a runtime dependency of the
    // whole integration. This pins the property that makes that safe.
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'cp-issued-token', expires_at: Date.now() + 3_600_000 }),
    });
    const auth = authWith(vault);

    await auth.getAccessToken();
    await auth.getAccessToken();
    await auth.getAccessToken();

    expect(mockFetch, 'one refresh, then the cached token').toHaveBeenCalledTimes(1);
  });

  it('carries the handle from the CLAIM through to the refresh', async () => {
    // The production entry point. Every other case in this describe seeds the
    // vault directly, so `setTokens` — the one path a handle actually arrives
    // by — was covered by nothing: measured, dropping the handle there survived
    // the whole file. A handle lost at the claim sends the next refresh to
    // Google with a client secret this process is not supposed to have, an hour
    // later, with nothing pointing back to the claim.
    setEnv(true);
    const store = new Map<string, string>();
    const vault = {
      get: vi.fn((k: string) => store.get(k) ?? null),
      set: vi.fn((k: string, v: string) => { store.set(k, v); }),
      delete: vi.fn(),
    };
    const auth = authWith(vault);

    await auth.setTokens({
      access_token: 'claimed-access-token',
      refresh_token: 'claimed-refresh-token',
      expires_at: Date.now() - 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      refresh_handle: 'sealed-from-claim',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'cp-issued-token', expires_at: Date.now() + 3_600_000 }),
    });
    await auth.getAccessToken();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url, 'a claimed handle must route the refresh to the CP').toContain('/internal/oauth/google/refresh');
    expect(JSON.parse(String(init.body))['refresh_handle']).toBe('sealed-from-claim');
  });

  it('refuses a control-plane response without a usable token', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/no usable token/);
  });

  // `typeof` alone is not the bar the direct path uses. Each of these passes a
  // typeof check and breaks something downstream: an empty token is served as
  // if it worked, a NaN expiry makes the staleness comparison false FOREVER so
  // the engine never refreshes again, and an out-of-range expiry turns the CP
  // into a dependency of every Google call instead of the hourly refresh.
  it.each([
    ['an empty access token', { access_token: '', expires_at: Date.now() + 3_600_000 }, /no usable token/],
    ['a NaN expiry', { access_token: 'cp-token', expires_at: Number.NaN }, /no usable expiry/],
    ['an infinite expiry', { access_token: 'cp-token', expires_at: Number.POSITIVE_INFINITY }, /no usable expiry/],
    ['an already-past expiry', { access_token: 'cp-token', expires_at: Date.now() - 1 }, /plausible range/],
    ['an absurdly distant expiry', { access_token: 'cp-token', expires_at: Date.now() + 400 * 24 * 3_600_000 }, /plausible range/],
    ['a non-string handle', { access_token: 'cp-token', expires_at: Date.now() + 3_600_000, refresh_handle: 42 }, /unusable refresh handle/],
    ['an empty handle', { access_token: 'cp-token', expires_at: Date.now() + 3_600_000, refresh_handle: '' }, /unusable refresh handle/],
  ])('refuses a control-plane response with %s', async (_why, body, pattern) => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(pattern);
    // And nothing was written: a refused response must not half-update the vault.
    expect(vault.stored()['access_token']).toBe('old-token-aaaaaaaa');
  });

  // Nothing drove a non-ok CP response at all, so the entire error branch was
  // uncovered on this path: `if (!response.ok && !cp)` survived, i.e. skipping
  // error handling on the CP path was invisible. These three pin the split that
  // decides whether a living grant is deleted.
  it('deletes the token when the control plane reports a revoked grant', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }),
    });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/400/);
    expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
  });

  it('still deletes on a CP revocation even if the blob carries a foreign client id', async () => {
    // The foreign-grant comparison must not run on this path. lynox's broker
    // client minted this token, so measuring it against THIS instance's id
    // answers a question nobody asked — and answering it would reclassify a real
    // revocation as a misconfiguration and keep a dead grant for good.
    //
    // The blob below is not reachable in production (a handle-bearing token is
    // only ever written by `setTokens`, which records no client id) — that is
    // the point: the invariant is enforced here rather than argued from Google's
    // behaviour, so a later writer cannot quietly make it reachable.
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1', client_id: 'a-foreign-client-id' });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }),
    });

    // `authWith` configures `test-id`, which differs from the stamped id above.
    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/400/);
    expect(vault.delete).toHaveBeenCalledWith('GOOGLE_OAUTH_TOKENS');
  });

  it('KEEPS the token when the control plane reports a bad client', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }),
    });

    // The invalid client is lynox's own here, so the remedy must not send the
    // user after this instance's credentials.
    const auth = authWith(vault);
    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete the refresh/);
    expect(vault.delete).not.toHaveBeenCalled();
    // And the cool-down armed: the second attempt must not reach the network at
    // all. Without this the breaker that keeps a fleet-wide bad secret from
    // hammering the CP forever was asserted nowhere.
    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the token and stays transient when the control plane is down', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'upstream unavailable' });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/503/);
    expect(vault.delete).not.toHaveBeenCalled();
  });

  // What this pins is the CLASSIFICATION of a 3xx, not that redirects are
  // unfollowed — a mock returns `ok:false` regardless, so it cannot show that;
  // the call-count assertion above is what pins the request itself. The
  // classification still matters: a redirecting CP is an outage, and reading it
  // as a revoked grant would delete the token.
  it('treats a redirect from the control plane as transient, not as a revocation', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 302, text: async () => '' });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/302/);
    expect(vault.delete).not.toHaveBeenCalled();
  });

  // The end state this arc moves toward: the CP holds the refresh token and the
  // engine holds only a handle. A precondition requiring the raw token would
  // make that token unrefreshable, and the failure would read as a lost grant.
  it('refreshes a token that has ONLY a handle and no raw refresh token', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_token: '', refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'cp-issued-token', expires_at: Date.now() + 3_600_000 }),
    });

    await expect(authWith(vault).getAccessToken()).resolves.toBe('cp-issued-token');
  });

  // The precondition that lets a handle-only token refresh opened a way to
  // destroy one: with the control plane unreachable, the direct branch reads an
  // EMPTY refresh_token, Google answers `invalid_grant`, and this code cannot
  // tell that from a revocation — so it would delete the grant because we could
  // not reach our own control plane. Both ways of losing the CP are driven.
  it.each([
    ['the identity is incomplete', () => { delete process.env['LYNOX_HTTP_SECRET']; }],
    ['the URL is refused', () => { process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.invalid/?'; }],
  ])('fails transient, without deleting, when a handle-only token cannot reach the CP because %s', async (_why, breakIt) => {
    setEnv(true);
    breakIt();
    const vault = vaultWith({ refresh_token: '', refresh_handle: 'sealed-handle-1' });

    await expect(authWith(vault).getAccessToken()).rejects.toThrow(/cannot reach its control plane/);
    expect(vault.delete, 'an unreachable control plane must never look like a revoked grant').not.toHaveBeenCalled();
    expect(mockFetch, 'and nothing may be sent to Google with an empty refresh token').not.toHaveBeenCalled();
  });

  // The suppression exists so a fleet-wide bad client secret cannot make every
  // instance hammer Google forever. It must not outlive the reconnect that
  // resolves it — and on the CP path, reconnecting IS the user's remedy, so the
  // window would have blocked exactly the action that fixes it.
  it('a reconnect ENDS the suppression', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    const auth = authWith(vault);
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }),
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete/);
    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed/);

    // The reconnected token is written ALREADY EXPIRED, deliberately. The
    // suppression lives in `_doRefresh`, and `getAccessToken` only goes there
    // past expiry — so a fresh, valid token returns from cache and never
    // reaches the check. Measured: with a future expiry this test passed even
    // when the clear was deleted, which is a test that drives nothing.
    await auth.setTokens({
      access_token: 'reconnected-access-token',
      refresh_token: 'reconnected-refresh-token',
      expires_at: Date.now() - 1_000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      refresh_handle: 'sealed-handle-2',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'post-reconnect-token', expires_at: Date.now() + 3_600_000 }),
    });

    await expect(auth.getAccessToken()).resolves.toBe('post-reconnect-token');
    expect(mockFetch, 'the refresh after a reconnect must actually go out').toHaveBeenCalledTimes(2);
  });

  it('but WITHOUT a reconnect it stays suppressed inside the window', async () => {
    // The counter-direction. Without it, clearing on every call would pass the
    // test above and quietly remove the brake the cool-down exists to be.
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    const auth = authWith(vault);
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }),
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete/);

    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed/);
    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed/);
    expect(mockFetch, 'a suppressed attempt must not reach the network').toHaveBeenCalledTimes(1);
  });

  // Two texts about one situation that contradict each other is worse than
  // either: the first attempt told a managed user lynox could not complete the
  // refresh, and every suppressed attempt after it blamed credentials that user
  // does not have and cannot reach.
  it('repeats the CONTROL-PLANE remedy while suppressed, not the instance one', async () => {
    setEnv(true);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    const auth = authWith(vault);
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }),
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete/);

    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete/);
    await expect(auth.getAccessToken()).rejects.not.toThrow(/an operator corrects them/);
  });

  it('and the INSTANCE remedy on the direct path, which is where it is true', async () => {
    // The counter-direction: a self-host operator genuinely can fix this
    // instance's credentials, and must be told so.
    setEnv(false);
    const vault = vaultWith({});
    const auth = authWith(vault);
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client' }),
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/an operator corrects them/);

    await expect(auth.getAccessToken()).rejects.toThrow(/an operator corrects them/);
  });

  // The direct path and the handle can coexist on a misconfigured instance. If
  // Google rotates the refresh token there, the control plane's sealed copy is
  // stale — presenting it later returns `invalid_grant`, which this code cannot
  // tell from a real revocation, so it would delete a living grant.
  it('drops a stale handle when a DIRECT refresh rotated the refresh token', async () => {
    setEnv(false);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'google-token', refresh_token: 'rotated-cccccccc',
        expires_in: 3600, scope: '', token_type: 'Bearer',
      }),
    });

    await authWith(vault).getAccessToken();

    expect(vault.stored()['refresh_handle'], 'a rotated token invalidates the sealed handle').toBeUndefined();
  });

  // The counter-direction, without which the line above is a one-way swap: when
  // Google returns no new refresh token, the handle still stands for the token
  // the CP sealed, and dropping it would throw away a working credential.
  it('KEEPS the handle when a direct refresh did not rotate the refresh token', async () => {
    setEnv(false);
    const vault = vaultWith({ refresh_handle: 'sealed-handle-1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'google-token', expires_in: 3600, scope: '', token_type: 'Bearer' }),
    });

    const token = await authWith(vault).getAccessToken();

    // Same shape, same guard: pin something the refresh CHANGED next to the
    // thing it left alone.
    expect(token).toBe('google-token');
    expect(vault.stored()['refresh_handle']).toBe('sealed-handle-1');
  });
});
