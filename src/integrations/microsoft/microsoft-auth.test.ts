import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { OAuthHandleClaimResponse, OAuthRefreshRequest } from '../../contract/http.js';
import type { SecretVault } from '../../core/secret-vault.js';
import { MicrosoftAuth, microsoftCardState, type MicrosoftTokenChange } from './microsoft-auth.js';
import { MICROSOFT_OAUTH_TOKENS_KEY } from './vault-keys.js';
import { fakeMicrosoftClaim, fakeMicrosoftRefresh } from './contract-fakes.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

import { installPinnedFetchBridge, dnsLookupStub } from '../../../tests/helpers/pinned-fetch-bridge.js';

// The refresh is a connector call (`cpFetch`), so it rides the pinned
// transport; the bridge hands it back to the stub above. The policy gate is not
// bypassed — see the helper.
let restorePinnedFetchBridge: (() => void) | undefined;
beforeAll(() => { restorePinnedFetchBridge = installPinnedFetchBridge(); });
afterAll(() => { restorePinnedFetchBridge?.(); });

// A placeholder, not the real control-plane hostname: this is the PUBLIC repo.
const CP = 'https://cp.invalid';
const ENV = ['LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_HTTP_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

function setManaged(managed: boolean): void {
  if (managed) {
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = CP;
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst-1';
    process.env['LYNOX_HTTP_SECRET'] = 'instance-secret-value';
  } else {
    for (const k of ENV) delete process.env[k];
  }
}

/** The contract-welded claim (`contract-fakes.ts`, compile-checked in src/). */
function claim(overrides: Partial<OAuthHandleClaimResponse> = {}): OAuthHandleClaimResponse {
  return fakeMicrosoftClaim(Date.now(), overrides);
}

function memoryVault(initial?: string): SecretVault & { raw: () => string | null } {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(MICROSOFT_OAUTH_TOKENS_KEY, initial);
  return {
    get: vi.fn((k: string) => store.get(k) ?? null),
    set: vi.fn((k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn((k: string) => store.delete(k)),
    raw: () => store.get(MICROSOFT_OAUTH_TOKENS_KEY) ?? null,
  } as unknown as SecretVault & { raw: () => string | null };
}

/** A vault holding a grant whose access token is already inside the refresh window. */
function expiringGrant(): SecretVault & { raw: () => string | null } {
  return memoryVault(JSON.stringify({ ...claim(), provider: undefined, expires_at: Date.now() - 1000 }));
}

function refreshOk(accessToken: string, expiresAt: number, refreshHandle?: string): Response {
  return new Response(JSON.stringify(fakeMicrosoftRefresh(accessToken, expiresAt, refreshHandle)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Microsoft's token-endpoint error body, in the shape its Entra reference
 * documents (`error`, `error_description` with the AADSTS text, `error_codes`,
 * trace and correlation ids). Not captured from a live tenant — there is none
 * yet — so this proves the passthrough of the documented shape, not of a body
 * Microsoft was observed to send.
 */
function microsoftErrorBody(error: string, codes: number[], description: string): string {
  return JSON.stringify({
    error,
    error_description: `AADSTS${codes[0] ?? 0}: ${description}\r\nTrace ID: 11111111-1111-1111-1111-111111111111\r\nCorrelation ID: 22222222-2222-2222-2222-222222222222\r\nTimestamp: 2026-10-17 12:00:00Z`,
    error_codes: codes,
    timestamp: '2026-10-17 12:00:00Z',
    trace_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: '22222222-2222-2222-2222-222222222222',
    error_uri: `https://login.microsoftonline.com/error?code=${codes[0] ?? 0}`,
  });
}

/** The control plane's answer when Microsoft refused: Microsoft's status and body, unchanged. */
function passthrough(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  mockFetch.mockReset();
  setManaged(true);
});

afterEach(() => {
  for (const k of ENV) {
    const v = saved[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  mockFetch.mockReset();
  vi.useRealTimers();
});

describe('acceptClaim — the grant handed over by the control plane', () => {
  it('stores the claim in its own vault slot and announces a grant', async () => {
    const vault = memoryVault();
    const changes: MicrosoftTokenChange[] = [];
    const auth = new MicrosoftAuth({ vault, onTokenChange: (e) => changes.push(e) });

    auth.acceptClaim(claim());

    const stored = JSON.parse(vault.raw() ?? '{}') as Record<string, unknown>;
    expect(stored['refresh_handle']).toBe('sealed-handle-1');
    expect(stored['tid']).toBe('00000000-0000-0000-0000-00000000aaaa');
    expect(changes.map((c) => c.reason)).toEqual(['grant']);
    expect(changes[0]?.tokenData?.email).toBe('mailbox@example.test');
    // A fresh token is used as is: no call to anyone.
    expect(await auth.getAccessToken()).toBe('ms-access-token-aaaaaaaa');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('survives a restart: a second instance reads the stored grant', () => {
    const vault = memoryVault();
    new MicrosoftAuth({ vault }).acceptClaim(claim());
    const reloaded = new MicrosoftAuth({ vault });
    expect(reloaded.isConnected()).toBe(true);
    expect(reloaded.getAccountInfo()?.email).toBe('mailbox@example.test');
  });

  it.each([
    ['another provider', { provider: 'google' as unknown as 'microsoft' }, /provider is not microsoft/],
    ['no refresh handle', { refresh_handle: '' }, /refresh_handle missing/],
    ['no tenant', { tid: '' }, /tid missing/],
    ['an expired token', { expires_at: Date.now() - 1 }, /plausible range/],
    ['a token for longer than a day', { expires_at: Date.now() + 25 * 3_600_000 }, /plausible range/],
    ['no scopes', { scopes: [] }, /non-empty array/],
  ])('refuses a claim with %s and stores nothing', (_label, overrides, why) => {
    const vault = memoryVault();
    const auth = new MicrosoftAuth({ vault });
    expect(() => auth.acceptClaim(claim(overrides))).toThrow(why);
    expect(vault.raw()).toBeNull();
    expect(auth.isConnected()).toBe(false);
  });

  it('refuses to hold a grant without a vault', () => {
    expect(() => new MicrosoftAuth({}).acceptClaim(claim())).toThrow(/without a vault/);
  });

  it('keeps an unreadable stored blob rather than deleting it', () => {
    const vault = memoryVault('{"not":"a grant"}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auth = new MicrosoftAuth({ vault });
    expect(auth.isConnected()).toBe(false);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('refresh through the control plane', () => {
  it('posts the handle to the Microsoft refresh route and replaces the rotated handle', async () => {
    const vault = expiringGrant();
    const changes: MicrosoftTokenChange[] = [];
    const auth = new MicrosoftAuth({ vault, onTokenChange: (e) => changes.push(e) });
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-rotated', Date.now() + 3_600_000, 'sealed-handle-2'));

    expect(await auth.getAccessToken()).toBe('ms-access-token-rotated');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CP}/internal/oauth/microsoft/refresh`);
    expect((init.headers as Record<string, string>)['x-instance-secret']).toBe('instance-secret-value');
    expect(JSON.parse(String(init.body))).toEqual({
      instance_id: 'inst-1',
      refresh_handle: 'sealed-handle-1',
    } satisfies OAuthRefreshRequest);

    // Microsoft rotates on every refresh; the old handle must not survive.
    const stored = JSON.parse(vault.raw() ?? '{}') as Record<string, unknown>;
    expect(stored['refresh_handle']).toBe('sealed-handle-2');
    expect(stored['access_token']).toBe('ms-access-token-rotated');
    expect(changes.map((c) => c.reason)).toEqual(['refresh']);

    // Cached until it nears expiry: the next call does not reach the CP.
    expect(await auth.getAccessToken()).toBe('ms-access-token-rotated');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored handle when the control plane sends none', async () => {
    const vault = expiringGrant();
    const auth = new MicrosoftAuth({ vault });
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-new', Date.now() + 3_600_000));
    await auth.getAccessToken();
    expect((JSON.parse(vault.raw() ?? '{}') as Record<string, unknown>)['refresh_handle']).toBe('sealed-handle-1');
  });

  it('runs one refresh for concurrent callers', async () => {
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-once', Date.now() + 3_600_000));
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(tokens).toEqual(['ms-access-token-once', 'ms-access-token-once', 'ms-access-token-once']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('without a control-plane identity it says so, calls no one and keeps the grant', async () => {
    setManaged(false);
    const vault = expiringGrant();
    const auth = new MicrosoftAuth({ vault });
    await expect(auth.getAccessToken()).rejects.toThrow(/cannot reach its control plane/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(auth.isConnected()).toBe(true);
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it('refuses an implausible success body without touching the stored grant', async () => {
    const vault = expiringGrant();
    const before = vault.raw();
    const auth = new MicrosoftAuth({ vault });
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-new', 1_000));
    await expect(auth.getAccessToken()).rejects.toThrow(/Token refresh failed/);
    expect(vault.raw()).toBe(before);
  });
});

describe("a refused refresh: Microsoft's body through the passthrough", () => {
  it('a revoked grant (AADSTS70008) empties the slot and shows the revoked card', async () => {
    const vault = expiringGrant();
    const changes: MicrosoftTokenChange[] = [];
    const auth = new MicrosoftAuth({ vault, onTokenChange: (e) => changes.push(e) });
    mockFetch.mockResolvedValueOnce(passthrough(400, microsoftErrorBody(
      'invalid_grant', [70008],
      'The provided authorization code or refresh token has expired due to inactivity.',
    )));

    const err = await auth.getAccessToken().catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Token refresh failed: 400\./);
    expect(err.message).toContain('(Microsoft error 70008)');
    // Microsoft's prose never reaches the message: it would reach the model.
    expect(err.message).not.toContain('inactivity');
    expect(err.message).not.toContain('Trace ID');
    expect(auth.isConnected()).toBe(false);
    expect(vault.raw()).toBeNull();
    expect(changes.map((c) => c.reason)).toEqual(['disconnect']);
    expect(auth.getLastRefreshFailure()).toMatchObject({ kind: 'grant-revoked', firstErrorCode: 70008, cardState: 'revoked' });
  });

  it.each([
    ['UserDisabled', [50057], 'account-disabled'],
    ['not assigned to the app', [50105], 'not-assigned'],
    ['blocked by conditional access', [53003], 'not-assigned'],
    ['app not in the tenant', [700016], 'app-not-in-tenant'],
    // The deciding code is the one on the needs-admin list, not the first in the body.
    ['an unrelated code first', [90099, 50057], 'account-disabled'],
  ])('needs-admin (%s) keeps the grant and shows %s', async (_label, codes, card) => {
    const vault = expiringGrant();
    const auth = new MicrosoftAuth({ vault });
    mockFetch.mockResolvedValueOnce(passthrough(400, microsoftErrorBody('invalid_grant', codes, 'Admin action needed.')));
    await expect(auth.getAccessToken()).rejects.toThrow(/Only the Microsoft 365 admin/);
    expect(auth.isConnected()).toBe(true);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(auth.getLastRefreshFailure()).toMatchObject({ kind: 'needs-admin', cardState: card });
  });

  it('invalid_grant without a revocation code asks for a sign-in and keeps the grant', async () => {
    const vault = expiringGrant();
    const auth = new MicrosoftAuth({ vault });
    mockFetch.mockResolvedValueOnce(passthrough(400, microsoftErrorBody('invalid_grant', [54005], 'Code already redeemed.')));
    await expect(auth.getAccessToken()).rejects.toThrow(/Microsoft asks for a new sign-in/);
    expect(auth.isConnected()).toBe(true);
    expect(auth.getLastRefreshFailure()).toMatchObject({ kind: 'needs-user', cardState: 'sign-in', firstErrorCode: 54005 });
  });

  it('invalid_client is our fault: grant kept, lynox-error card', async () => {
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(passthrough(401, microsoftErrorBody('invalid_client', [7000222], 'Client secret expired.')));
    await expect(auth.getAccessToken()).rejects.toThrow(/lynox could not complete the refresh/);
    expect(auth.isConnected()).toBe(true);
    expect(auth.getLastRefreshFailure()).toMatchObject({ kind: 'client-misconfigured', cardState: 'lynox-error' });
  });

  it('a verdict retrying cannot fix suppresses the next attempts until a new grant arrives', async () => {
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(passthrough(400, microsoftErrorBody('interaction_required', [50076], 'MFA required.')));
    await expect(auth.getAccessToken()).rejects.toThrow(/Microsoft asks for a new sign-in/);

    // Within the brake: the same answer, and no second call to the CP.
    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed.*Microsoft asks for a new sign-in.*50076/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // A new grant ends the brake and the failure at once.
    auth.acceptClaim(claim());
    expect(auth.getLastRefreshFailure()).toBeNull();
    expect(await auth.getAccessToken()).toBe('ms-access-token-aaaaaaaa');
  });

  it('a 5xx is transient: grant kept, no brake, the next call tries again', async () => {
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(passthrough(503, 'upstream unavailable'));
    await expect(auth.getAccessToken()).rejects.toThrow(/Token refresh failed: 503\..*Retry in a moment/);
    expect(auth.getLastRefreshFailure()).toMatchObject({ kind: 'transient', cardState: 'retrying', firstErrorCode: null });

    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-after', Date.now() + 3_600_000));
    expect(await auth.getAccessToken()).toBe('ms-access-token-after');
    expect(auth.getLastRefreshFailure()).toBeNull();
  });

  it('a 429 with Retry-After holds off for that long', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(passthrough(429, '{}', { 'retry-after': '120' }));
    await expect(auth.getAccessToken()).rejects.toThrow(/429/);

    vi.setSystemTime(Date.now() + 119_000);
    await expect(auth.getAccessToken()).rejects.toThrow(/suppressed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2_000);
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-later', Date.now() + 3_600_000));
    expect(await auth.getAccessToken()).toBe('ms-access-token-later');
  });

  it('a 429 without Retry-After sets no brake', async () => {
    const auth = new MicrosoftAuth({ vault: expiringGrant() });
    mockFetch.mockResolvedValueOnce(passthrough(429, '{}'));
    await expect(auth.getAccessToken()).rejects.toThrow(/429/);
    mockFetch.mockResolvedValueOnce(refreshOk('ms-access-token-now', Date.now() + 3_600_000));
    expect(await auth.getAccessToken()).toBe('ms-access-token-now');
  });
});

describe('disconnect', () => {
  it('drops the local grant and announces it', () => {
    const vault = memoryVault();
    const changes: MicrosoftTokenChange[] = [];
    const auth = new MicrosoftAuth({ vault, onTokenChange: (e) => changes.push(e) });
    auth.acceptClaim(claim());
    auth.disconnect();
    expect(vault.raw()).toBeNull();
    expect(auth.isConnected()).toBe(false);
    expect(changes.map((c) => c.reason)).toEqual(['grant', 'disconnect']);
    expect(changes[1]?.tokenData).toBeNull();
  });

  it('a throwing hook does not undo the write', () => {
    const vault = memoryVault();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auth = new MicrosoftAuth({ vault, onTokenChange: () => { throw new Error('mirror down'); } });
    auth.acceptClaim(claim());
    expect(vault.raw()).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('microsoftCardState', () => {
  it('maps every verdict to a card state', () => {
    expect(microsoftCardState('grant-revoked', [70008])).toBe('revoked');
    expect(microsoftCardState('needs-user', [])).toBe('sign-in');
    expect(microsoftCardState('needs-admin', [50105])).toBe('not-assigned');
    expect(microsoftCardState('client-misconfigured', [])).toBe('lynox-error');
    expect(microsoftCardState('transient', [])).toBe('retrying');
  });
});
