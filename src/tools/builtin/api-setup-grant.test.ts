import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Same transport seam as api-setup.test.ts: fetchWithValidatedRedirects hands
// the socket to fetchPinned, so DNS is stubbed and the pinned transport forwards
// to globalThis.fetch, where each test's spy sees the token POST.
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]),
  },
}));

import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile, type OAuthGrantRecord } from '../../core/api-store.js';
import { EngineDb } from '../../core/engine-db.js';
import { ConnectionStore } from '../../core/connection-store.js';
import { tokenFingerprint } from '../../core/oauth-refresh-failure.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({
  getLynoxDir: () => mockLynoxDir,
}));

let restorePinnedTransport: (() => void) | undefined;
const tmpDirs: string[] = [];
const engines: EngineDb[] = [];

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-api-grant-test-'));
  tmpDirs.push(mockLynoxDir);
  restorePinnedTransport = setPinnedTransportForTests(async (input) => {
    const init: RequestInit = { method: input.method, headers: input.headers };
    if (input.body !== undefined) init.body = input.body.toString('utf8');
    if (input.signal) init.signal = input.signal;
    return (globalThis.fetch as typeof fetch)(input.url, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  restorePinnedTransport?.();
  restorePinnedTransport = undefined;
  for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface MockVault {
  resolve(name: string): string | null;
  resolveSecretRefs(input: unknown): unknown;
  set(name: string, value: string): void;
  deleteSecret?(name: string): boolean;
  peek(name: string): string | undefined;
}

/** The slice of a secret store fetch_token and delete use, over a plain map. */
function makeVault(initial: Record<string, string>, opts: { canDelete?: boolean } = {}): MockVault {
  const store: Record<string, string> = { ...initial };
  const vault: MockVault = {
    resolve: (name) => store[name] ?? null,
    resolveSecretRefs: (input: unknown): unknown => {
      const text = JSON.stringify(input);
      const resolved = text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (_m, name: string) => {
        const v = store[name];
        return v !== undefined ? v.replace(/["\\]/g, (c) => `\\${c}`) : `secret:${name}`;
      });
      try { return JSON.parse(resolved) as unknown; } catch { return input; }
    },
    set: (name, value) => { store[name] = value; },
    peek: (name) => store[name],
  };
  if (opts.canDelete !== false) {
    vault.deleteSecret = (name) => {
      const had = name in store;
      delete store[name];
      return had;
    };
  }
  return vault;
}

function makeAgent(apiStore: ApiStore, vault: MockVault, promptUser?: () => Promise<string>): never {
  return {
    sessionCounters: { httpRequests: 0, approvedOutboundDomains: new Set<string>(), pendingOutboundPrompts: new Map<string, unknown>() },
    secretStore: vault,
    promptUser,
    toolContext: {
      apiStore,
      dataStore: null,
      taskManager: null,
      knowledgeLayer: null,
      runHistory: null,
      userConfig: {},
      tools: [],
      streamHandler: null,
      networkPolicy: undefined,
      allowedHosts: undefined,
      allowedWildcards: [],
      rateLimitProvider: null,
      hourlyRateLimit: Infinity,
      dailyRateLimit: Infinity,
      isolationEnvOverride: undefined,
      isolationMinimalEnv: false,
    },
  } as never;
}

const ACK = { accepted: true as const, hosts: ['api.crm.example'], accepted_at: '2026-09-22T00:00:00.000Z' };

function crmProfile(over: Partial<ApiProfile> = {}, grantType: 'refresh_token' | 'client_credentials' = 'refresh_token'): ApiProfile {
  return {
    id: 'crm-api',
    name: 'CRM',
    base_url: 'https://api.crm.example/v1',
    description: 'CRM API',
    auth: {
      type: 'oauth2',
      vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET'],
      oauth: { token_url: 'https://api.crm.example/oauth/token', grant_type: grantType, client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' },
    },
    custom_endpoint_ack: ACK,
    endpoints: [{ method: 'GET', path: '/contacts', description: 'List contacts' }],
    guidelines: ['Page with cursor'],
    avoid: ['Do not poll'],
    ...over,
  };
}

// `crm-api` derives these two; nothing configures them.
const ACCESS = 'CRM_API_ACCESS_TOKEN';
const REFRESH = 'CRM_API_REFRESH_TOKEN';

/** The stamp a successful exchange writes: which client, for which refresh token. */
const stamp = (client: string, refreshToken: string): OAuthGrantRecord =>
  ({ minted_by: tokenFingerprint(client), minted_for: tokenFingerprint(refreshToken) });

/** Record entries for values an exchange wrote: name → the value it put there. */
const wrote = (entries: Record<string, string>): OAuthGrantRecord['written'] =>
  Object.entries(entries).map(([name, value]) => ({ name, fp: tokenFingerprint(value) }));

function vaultWithRefresh(token = 'rt-1'): MockVault {
  return makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [REFRESH]: token });
}

function tokenEndpoint(status: number, body: string): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
}

const fetchToken = (agent: never): Promise<string> =>
  apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api' }, agent) as Promise<string>;

describe('fetch_token — what a failed exchange does to the grant', () => {
  it('records a revocation when the provider answers invalid_grant to the client that minted the token', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('as revoked or expired');
    expect(result).toContain('not an expired access token');
    // A revocation is not a client problem: no advice to check the client values.
    expect(result).not.toContain('Check: client_id');
    const grant = store.get('crm-api')?.oauth_grant;
    expect(grant?.state).toBe('revoked');
    expect(grant?.revoked_fp).toBe(tokenFingerprint('rt-1'));
  });

  it('reads invalid_grant as a client problem when a different client minted this token, and keeps the grant', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-OLD', 'rt-1') }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('rejected this API\'s client configuration');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('does not apply a stamp taken with another refresh token — a new token from a new client can still be revoked', async () => {
    const store = new ApiStore();
    // The stamp describes rt-OLD; the user has since stored rt-1 for a re-created app.
    store.register(crmProfile({ oauth_grant: stamp('client-OLD', 'rt-OLD') }));
    const agent = makeAgent(store, vaultWithRefresh('rt-1'));
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.oauth_grant?.state).toBe('revoked');
  });

  it('records a revocation on invalid_grant when nothing recorded which client minted the token', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.oauth_grant?.state).toBe('revoked');
  });

  it.each(['invalid_client', 'unauthorized_client', 'deleted_client'])('reads %s as a client problem and keeps the grant', async (code) => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(401, JSON.stringify({ error: code }));

    const result = await fetchToken(agent);

    expect(result).toContain('rejected this API\'s client configuration');
    expect(result).toContain('Check: client_id');
    expect(store.get('crm-api')?.oauth_grant).toEqual(stamp('client-1', 'rt-1'));
  });

  it.each([
    ['a server error', 503, JSON.stringify({ error: 'invalid_grant' })],
    ['a rate limit', 429, JSON.stringify({ error: 'invalid_grant' })],
    ['an HTML error page', 400, '<html>bad gateway</html>'],
    ['a code the engine does not classify', 400, JSON.stringify({ error: 'invalid_request' })],
  ])('changes nothing on %s', async (_label, status, body) => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(status, body);

    const result = await fetchToken(agent);

    expect(result).toContain('Nothing was changed; retry later.');
    expect(store.get('crm-api')?.oauth_grant).toEqual(stamp('client-1', 'rt-1'));
  });

  it('records no verdict when the refresh token was replaced mid-flight, and claims no more than that', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    const vault = vaultWithRefresh('rt-1');
    const agent = makeAgent(store, vault);
    // Another writer in this process — a concurrent exchange, or a token stored
    // by hand — replaces rt-1 while the POST is out; the provider rejects rt-1.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vault.set(REFRESH, 'rt-2');
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(result).toContain(`the refresh token under "${REFRESH}" was replaced while the request was out`);
    expect(result).toContain('Nothing was recorded. Retry the API request; if it is refused or answers 401, call fetch_token once.');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('records no verdict when the refresh token was removed mid-flight, and sends the model to check the profile', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    const vault = vaultWithRefresh('rt-1');
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vault.deleteSecret?.(REFRESH);
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(result).toContain(`the refresh token it sent is no longer in the vault under "${REFRESH}"`);
    expect(result).toContain('Check with api_setup list that api_profile "crm-api" still exists');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('says the slot changed, not that its refresh token is stale, when a profile\'s own slot changes mid-flight', async () => {
    const store = new ApiStore();
    const base = crmProfile({ oauth_grant: stamp('client-1', 'rt-1') });
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: 'CRM_RT' } } });
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_RT: 'rt-1' });
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vault.set('CRM_RT', 'rt-2');
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(result).toContain('the refresh token under "CRM_RT" was replaced while the request was out');
    expect(result).not.toContain('stores a rotated one');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('records no verdict when the profile reads its refresh token from a slot rotations are not written to', async () => {
    const store = new ApiStore();
    const base = crmProfile({ oauth_grant: stamp('client-1', 'rt-1') });
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: 'CRM_RT' } } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_RT: 'rt-1' }));
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('Nothing was recorded.');
    expect(result).toContain(`stores a rotated one under "${REFRESH}"`);
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('reads invalid_grant on a client-credentials exchange as a client problem — there is no user grant to revoke', async () => {
    const store = new ApiStore();
    store.register(crmProfile({}, 'client_credentials'));
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1' }));
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('rejected this API\'s client configuration');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
  });

  it('records a revocation even while the boot left the host shared — a save in place is not refused', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));
    store.register({ ...crmProfile(), id: 'crm-other', custom_endpoint_ack: ACK });
    expect(store.getHostConflict('api.crm.example')).toEqual(['crm-api', 'crm-other']);
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.oauth_grant?.state).toBe('revoked');
  });
});

describe('fetch_token — a revocation verdict and the way back', () => {
  const revoked = (fp: string): OAuthGrantRecord => ({ ...stamp('client-1', 'rt-1'), state: 'revoked', revoked_fp: fp, revoked_at: '2026-09-22T00:00:00.000Z' });

  it('does not resend the refresh token the provider already rejected', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: revoked(tokenFingerprint('rt-1')) }));
    const agent = makeAgent(store, vaultWithRefresh('rt-1'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchToken(agent);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toContain('fetch_token will not resend it');
    expect(result).toContain(REFRESH);
  });

  it('steps aside for a new refresh token, and a successful exchange clears the verdict', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: revoked(tokenFingerprint('rt-1')) }));
    const agent = makeAgent(store, vaultWithRefresh('rt-new'));
    const fetchSpy = tokenEndpoint(200, JSON.stringify({ access_token: 'at-new', expires_in: 3600 }));

    const result = await fetchToken(agent);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toContain('Token exchange OK');
    const grant = store.get('crm-api')?.oauth_grant;
    expect(grant?.state).toBeUndefined();
    expect(grant?.revoked_fp).toBeUndefined();
    expect(grant?.revoked_at).toBeUndefined();
    // No rotated token in the answer: the stamp now names the one that worked.
    expect(grant?.minted_for).toBe(tokenFingerprint('rt-new'));
  });
});

describe('fetch_token — what a successful exchange records', () => {
  it('stamps a fingerprint of the client, not the id itself, for the refresh token now in play', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));

    await fetchToken(agent);

    const grant = store.get('crm-api')?.oauth_grant;
    expect(grant?.minted_by).toBe(tokenFingerprint('client-1'));
    expect(JSON.stringify(store.get('crm-api'))).not.toContain('client-1');
    expect(grant?.minted_for).toBe(tokenFingerprint('rt-2'));
    expect(store.get('crm-api')?.auth?.oauth?.token_expires_at).toBeGreaterThan(Date.now());
  });

  it('stamps nothing when no refresh token is in play', async () => {
    const store = new ApiStore();
    store.register(crmProfile({}, 'client_credentials'));
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1' }));
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.oauth_grant?.minted_by).toBeUndefined();
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ [ACCESS]: 'at-1' }));
  });

  it('records every value an exchange wrote, with its name, including a name the caller chose', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));
    await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: 'CRM_CUSTOM_TOKEN' }, agent);
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ CRM_CUSTOM_TOKEN: 'at-1', [REFRESH]: 'rt-2' }));

    // A later write under a recorded name replaces its entry: only the latest value may match.
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-3', expires_in: 3600 }));
    await fetchToken(agent);
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ CRM_CUSTOM_TOKEN: 'at-1', [ACCESS]: 'at-2', [REFRESH]: 'rt-3' }));
  });

  it('records the access token it wrote even when it must refuse to store the refresh token', async () => {
    const store = new ApiStore();
    // `lynox-x` derives LYNOX_X_REFRESH_TOKEN, a platform prefix; the access token goes to a chosen name.
    // Reachable with client credentials: the answer carries a refresh token nobody reads.
    store.register({ ...crmProfile({}, 'client_credentials'), id: 'lynox-x', base_url: 'https://api.l.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.l.example', 'api.crm.example'] }, oauth_grant: { written: wrote({ LX_EARLIER: 'e-1' }) } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', LYNOX_X_REFRESH_TOKEN: 'platform-owned' }));
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'lynox-x', output_secret_name: 'LX_TOKEN' }, agent) as string;

    expect(result).toContain('the refresh token was NOT stored');
    // Added to what the record held, not in place of it.
    expect(store.get('lynox-x')?.oauth_grant?.written).toEqual(wrote({ LX_EARLIER: 'e-1', LX_TOKEN: 'at-1' }));
  });

  it('takes that access token out again when the profile was deleted while the exchange ran', async () => {
    const store = new ApiStore();
    store.register({ ...crmProfile({}, 'client_credentials'), id: 'lynox-x', base_url: 'https://api.l.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.l.example', 'api.crm.example'] } });
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', LYNOX_X_REFRESH_TOKEN: 'platform-owned' });
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      store.unregister('lynox-x');
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'lynox-x', output_secret_name: 'LX_TOKEN' }, agent) as string;

    expect(result).toContain('was deleted while it ran. Removed the tokens its exchanges wrote: LX_TOKEN.');
    expect(vault.peek('LX_TOKEN')).toBeUndefined();
    // A platform slot is not offered to the user for removal.
    expect(result).not.toContain('LYNOX_X_REFRESH_TOKEN');
  });

  it('keeps that access token when only the save of its record fails', async () => {
    const store = new ApiStore();
    store.register({ ...crmProfile({}, 'client_credentials'), id: 'lynox-x', base_url: 'https://api.l.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.l.example', 'api.crm.example'] } });
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', LYNOX_X_REFRESH_TOKEN: 'platform-owned' });
    const agent = makeAgent(store, vault);
    vi.spyOn(store, 'save').mockReturnValue({ ok: false } as never);
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'lynox-x', output_secret_name: 'LX_TOKEN' }, agent) as string;

    expect(result).toContain('the refresh token was NOT stored');
    expect(vault.peek('LX_TOKEN')).toBe('at-1');
  });

  it('neither rewrites nor records a refresh token the provider hands back unchanged, so a delete leaves it', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh('rt-pasted');
    const agent = makeAgent(store, vault);
    const setSpy = vi.spyOn(vault, 'set');
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-pasted', expires_in: 3600 }));

    const result = await fetchToken(agent);

    expect(result).toContain('Token exchange OK');
    expect(result).not.toContain('Refresh token stored as');
    expect(setSpy.mock.calls.map(([name]) => name)).toEqual([ACCESS]);
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ [ACCESS]: 'at-1' }));
    expect(store.get('crm-api')?.oauth_grant?.minted_for).toBe(tokenFingerprint('rt-pasted'));

    const deleted = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(REFRESH)).toBe('rt-pasted');
    expect(deleted).toContain(`Removed the tokens its exchanges wrote: ${ACCESS}.`);
    expect(deleted).toContain(`Still in the vault: CRM_CLIENT_ID, CRM_CLIENT_SECRET, ${REFRESH}.`);
  });

  it('does not copy a refresh token handed back unchanged into the derived slot of a profile that reads its own', async () => {
    const store = new ApiStore();
    const base = crmProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: 'CRM_RT' } } });
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_RT: 'rt-1' });
    const agent = makeAgent(store, vault);
    // The provider hands back the token it was sent.
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }));

    await fetchToken(agent);

    expect(vault.peek(REFRESH)).toBeUndefined();
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ [ACCESS]: 'at-1' }));
    expect(vault.peek('CRM_RT')).toBe('rt-1');
  });

  it('leaves a refresh token stored while the exchange ran, when the answer only hands back the one it sent', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh('rt-1');
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vault.set(REFRESH, 'rt-stored-meanwhile');
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await fetchToken(agent);

    expect(vault.peek(REFRESH)).toBe('rt-stored-meanwhile');
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ [ACCESS]: 'at-1' }));
  });

  it('ignores an empty refresh token in the answer', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh('rt-1');
    const agent = makeAgent(store, vault);
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: '', expires_in: 3600 }));

    await fetchToken(agent);

    expect(vault.peek(REFRESH)).toBe('rt-1');
    expect(store.get('crm-api')?.oauth_grant?.written).toEqual(wrote({ [ACCESS]: 'at-1' }));
  });

  it.each([
    ['the derived refresh slot', REFRESH, undefined, 'is where this profile keeps its refresh token'],
    ['the refresh slot the profile names', 'CRM_RT', 'CRM_RT', 'is where this profile keeps its refresh token'],
    ['the derived refresh slot, while the profile names another', REFRESH, 'CRM_RT', 'is where this profile keeps its refresh token'],
    ['a platform slot', 'LYNOX_ENGINE_KEY', undefined, 'would overwrite a credential the tenant cannot recover'],
    ['a name that is not UPPER_SNAKE_CASE', 'crm-token', undefined, 'is not valid UPPER_SNAKE_CASE'],
  ])('refuses %s as output name before posting anything', async (_label, outputName, refreshTokenKeyName, message) => {
    const store = new ApiStore();
    const base = crmProfile();
    store.register(refreshTokenKeyName
      ? { ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: refreshTokenKeyName } } }
      : base);
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [REFRESH]: 'rt-1', CRM_RT: 'rt-1' });
    const agent = makeAgent(store, vault);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: outputName }, agent) as string;

    expect(result).toContain(message);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vault.peek(REFRESH)).toBe('rt-1');
  });

  it('names the way out of a refresh-slot collision: the default name the attach reads', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: REFRESH }, agent) as string;

    expect(result).toContain(`Leave output_secret_name out, so the access token goes to "${ACCESS}", the slot http_request reads.`);
  });

  it('names the profile\'s own field when its refresh slot is the name the access token would take', async () => {
    const store = new ApiStore();
    const base = crmProfile();
    // The one shape leaving output_secret_name out cannot fix: the profile reads its
    // refresh token from the very name the access token defaults to.
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: ACCESS } } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [ACCESS]: 'rt-1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchToken(agent);

    expect(result).toContain("If that name IS this profile's auth.oauth.refresh_token_key, point that field at a slot that holds only the refresh token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not spend the profile\'s request budget on a refused output name', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ rate_limit: { requests_per_second: 1 } }));
    const agent = makeAgent(store, vaultWithRefresh());

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: REFRESH }, agent) as string;

    expect(result).toContain('is where this profile keeps its refresh token');
    // The one request per second this profile allows is still there — and the
    // second call proves the bucket exists, so the first `null` is an answer
    // and not the silence of a host nothing registered a limit for.
    expect(store.checkRateLimit('api.crm.example')).toBeNull();
    expect(store.checkRateLimit('api.crm.example')).not.toBeNull();
  });

  it('keeps the tokens it wrote when only the save of its record fails', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh();
    const agent = makeAgent(store, vault);
    vi.spyOn(store, 'save').mockReturnValue({ ok: false } as never);
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));

    const result = await fetchToken(agent);

    expect(result).toContain('Token exchange OK');
    expect(vault.peek(ACCESS)).toBe('at-1');
    expect(vault.peek(REFRESH)).toBe('rt-2');
  });

  it('takes the tokens out again when the profile was deleted while its exchange was in flight', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh();
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      store.unregister('crm-api');
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(result).toContain(`was deleted while it ran. Removed the tokens its exchanges wrote: ${ACCESS}, ${REFRESH}.`);
    expect(vault.peek(ACCESS)).toBeUndefined();
    expect(vault.peek(REFRESH)).toBeUndefined();
  });

  it('names what it kept because another profile uses it, when the profile was deleted while its exchange ran', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    // Another profile reads the name this exchange writes its access token to.
    store.register({ id: 'reporting', name: 'Reporting', base_url: 'https://reports.example.com/v1', description: 'Reports', auth: { type: 'bearer', vault_keys: [ACCESS] } });
    const vault = vaultWithRefresh();
    const agent = makeAgent(store, vault);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      store.unregister('crm-api');
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(vault.peek(ACCESS)).toBe('at-1');
    expect(vault.peek(REFRESH)).toBeUndefined();
    expect(result).toContain(`Removed the tokens its exchanges wrote: ${REFRESH}.`);
    expect(result).toContain(`Still in the vault: CRM_CLIENT_ID, CRM_CLIENT_SECRET, ${ACCESS}.`);
    expect(result).not.toContain('Nothing is stored');
  });

  it('writes its record onto the profile as it is after the exchange, not the copy read before it', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    // An update lands while the token POST is out.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      store.register(crmProfile({ description: 'updated mid-exchange' }));
      return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await fetchToken(agent);

    expect(store.get('crm-api')?.description).toBe('updated mid-exchange');
    expect(store.get('crm-api')?.oauth_grant?.minted_by).toBe(tokenFingerprint('client-1'));
  });

  it('does not bring back a profile deleted while its exchange was in flight', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      store.unregister('crm-api');
      return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await fetchToken(agent);

    expect(store.get('crm-api')).toBeUndefined();
  });

  it('asks for a missing refresh token before posting anything', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchToken(agent);

    expect(result).toContain(`missing the OAuth credentials for profile "crm-api": "${REFRESH}"`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projects a revocation into the engine.db status column through the tool path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-api-grant-db-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    const cs = new ConnectionStore(engine);
    const store = new ApiStore();
    store.setConnectionStore(cs);
    store.save(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    await fetchToken(agent);

    expect(cs.get('crm-api')?.status).toBe('revoked');
  });
});

describe('create — vault_keys is a list of names', () => {
  it.each([
    ['an object', { 0: 'CRM_KEY' }],
    ['a string', 'CRM_KEY'],
    ['a list holding a non-string', ['CRM_KEY', 5]],
  ])('refuses %s', async (_label, vaultKeys) => {
    const store = new ApiStore();
    const agent = makeAgent(store, makeVault({}), async () => 'allow');
    const result = await apiSetupTool.handler({ action: 'create', profile: {
      ...crmProfile(), auth: { type: 'bearer', vault_keys: vaultKeys as unknown as string[] },
    } }, agent) as string;

    expect(result).toContain('Invalid auth.vault_keys: must be a list of vault key names');
    expect(result).toContain('fixed with api_setup update');
    expect(store.get('crm-api')).toBeUndefined();
  });

  it('reads a null vault_keys as absent', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, makeVault({}), async () => 'allow');
    const result = await apiSetupTool.handler({ action: 'create', profile: {
      ...crmProfile(), auth: { type: 'bearer', vault_keys: null as unknown as string[] },
    } }, agent) as string;

    expect(result).not.toContain('Invalid auth.vault_keys');
    expect(store.get('crm-api')).toBeDefined();
  });
});

describe('create/update — the grant record belongs to the engine', () => {
  const allow = async (): Promise<string> => 'allow';

  it('drops a grant record that arrives with a create', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    const forged = crmProfile({ oauth_grant: { minted_by: 'attacker', state: 'revoked', revoked_fp: 'ffffffffffffffff' } });

    const result = await apiSetupTool.handler({ action: 'create', profile: forged }, agent) as string;

    expect(store.get('crm-api')).toBeDefined();
    expect(store.get('crm-api')?.oauth_grant).toBeUndefined();
    expect(result).toContain('The oauth_grant sent with this call was ignored');
  });

  it('keeps the stored record when an update carries a different one, and says so', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    const engineRecord: OAuthGrantRecord = { ...stamp('client-1', 'rt-1'), state: 'revoked', revoked_fp: tokenFingerprint('rt-1'), revoked_at: '2026-09-22T00:00:00.000Z' };
    store.register(crmProfile({ oauth_grant: engineRecord }));

    // A model clearing the revocation by echoing an edited record back.
    const result = await apiSetupTool.handler({ action: 'update', profile: crmProfile({ description: 'edited', oauth_grant: {} }) }, agent) as string;

    expect(store.get('crm-api')?.description).toBe('edited');
    expect(store.get('crm-api')?.oauth_grant).toEqual(engineRecord);
    expect(result).toContain('The oauth_grant sent with this call was ignored');
  });

  it('says nothing when an update echoes the stored record unchanged', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));

    // The view → edit → update round trip carries the record back as it was.
    const result = await apiSetupTool.handler({ action: 'update', profile: crmProfile({ description: 'edited', oauth_grant: stamp('client-1', 'rt-1') }) }, agent) as string;

    expect(store.get('crm-api')?.description).toBe('edited');
    expect(result).not.toContain('oauth_grant');
  });

  it('keeps the stored record when an update omits the field, without a note', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    store.register(crmProfile({ oauth_grant: stamp('client-1', 'rt-1') }));

    const result = await apiSetupTool.handler({ action: 'update', profile: crmProfile({ description: 'edited' }) }, agent) as string;

    expect(store.get('crm-api')?.oauth_grant).toEqual(stamp('client-1', 'rt-1'));
    expect(result).not.toContain('oauth_grant');
  });
});

// A mutation of `purgeRecordedTokens` survives on purpose: dropping
// `!removed.includes(k)` from the kept filter changes nothing, because a name the
// purge just deleted no longer resolves — `deleteSecret` drops it from the same map
// `resolve` reads (`secret-store.ts`) — so the value check already excludes it.
// Killing it would need a store that reports a delete as done and keeps handing the
// value out, i.e. a broken store, and the test would then pin that contract breach
// as expected behaviour. The redundancy stays because it states the intent at the
// place a reader looks; do not delete it, and do not add a lying-vault fixture to
// make it fail.
describe('delete — only what the profile\'s exchanges wrote leaves the vault', () => {
  it('removes the recorded tokens and names what stays', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1', [REFRESH]: 'rt-1', CRM_CUSTOM_TOKEN: 'at-custom' }) } }));
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [ACCESS]: 'at-1', [REFRESH]: 'rt-1', CRM_CUSTOM_TOKEN: 'at-custom' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(ACCESS)).toBeUndefined();
    expect(vault.peek(REFRESH)).toBeUndefined();
    expect(vault.peek('CRM_CUSTOM_TOKEN')).toBeUndefined();
    expect(vault.peek('CRM_CLIENT_ID')).toBe('client-1');
    expect(vault.peek('CRM_CLIENT_SECRET')).toBe('secret-1');
    expect(result).toContain(`Removed the tokens its exchanges wrote: ${ACCESS}, ${REFRESH}, CRM_CUSTOM_TOKEN.`);
    expect(result).toContain('Still in the vault: CRM_CLIENT_ID, CRM_CLIENT_SECRET.');
  });

  it('lists as still in the vault only names that actually hold a value', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    // The client secret was never stored.
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', [ACCESS]: 'at-1' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain('Still in the vault: CRM_CLIENT_ID.');
    expect(result).not.toContain('CRM_CLIENT_SECRET');
  });

  it('never removes a credential the user stored under a name the id happens to derive', async () => {
    const store = new ApiStore();
    // A header profile named `shopify`, holding the user's own token under the
    // exact name `accessTokenKey('shopify')` derives. No exchange wrote it.
    store.register({ id: 'shopify', name: 'Shopify', base_url: 'https://shop.example.com/admin', description: 'Shop', auth: { type: 'header', header_name: 'X-Token', vault_keys: ['SHOPIFY_ACCESS_TOKEN'] } });
    const vault = makeVault({ SHOPIFY_ACCESS_TOKEN: 'shown-once' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'shopify' }, agent) as string;

    expect(vault.peek('SHOPIFY_ACCESS_TOKEN')).toBe('shown-once');
    expect(result).toContain('Still in the vault: SHOPIFY_ACCESS_TOKEN.');
  });

  it('never removes a refresh token the user pasted into the derived slot, which no exchange recorded', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh('pasted-by-the-user');
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent);

    expect(vault.peek(REFRESH)).toBe('pasted-by-the-user');
  });

  it('keeps a recorded token another profile still reads', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'shared' }) } }));
    store.register({ id: 'reporting', name: 'Reporting', base_url: 'https://reports.example.com/v1', description: 'Reports', auth: { type: 'bearer', vault_keys: [ACCESS] } });
    const vault = makeVault({ [ACCESS]: 'shared' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(ACCESS)).toBe('shared');
    expect(result).not.toContain('Removed');
    expect(result).toContain(`Still in the vault: ${ACCESS}.`);
  });

  it('keeps a recorded token a neighbour reads through an array-like vault_keys', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'shared' }) } }));
    // Not an array, but the attach reads `vault_keys?.[0]` from it all the same.
    store.register({ id: 'reporting', name: 'Reporting', base_url: 'https://reports.example.com/v1', description: 'Reports', auth: { type: 'bearer', vault_keys: { 0: ACCESS } as unknown as string[] } });
    const vault = makeVault({ [ACCESS]: 'shared' });
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent);

    expect(vault.peek(ACCESS)).toBe('shared');
  });

  it('cannot be used to delete an unrelated secret by creating and deleting a profile of the same name', async () => {
    const store = new ApiStore();
    const vault = makeVault({ GITHUB_ACCESS_TOKEN: 'the-users-github-token' });
    const agent = makeAgent(store, vault);
    // A host on the private LAN saves with no confirmation prompt.
    await apiSetupTool.handler({ action: 'create', profile: {
      id: 'github', name: 'x', base_url: 'https://x.local/api', description: 'x',
      auth: { type: 'bearer', vault_keys: ['X_KEY'] },
      endpoints: [{ method: 'GET', path: '/', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    } }, agent);
    expect(store.get('github')).toBeDefined();

    await apiSetupTool.handler({ action: 'delete', id: 'github' }, agent);

    expect(vault.peek('GITHUB_ACCESS_TOKEN')).toBe('the-users-github-token');
  });

  it('never removes a recorded name whose value the user has replaced since', async () => {
    const store = new ApiStore();
    // The exchange wrote at-1; the user has since put their own token under the name.
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const vault = makeVault({ [ACCESS]: 'the-users-own-token' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(ACCESS)).toBe('the-users-own-token');
    expect(result).not.toContain('Removed');
    expect(result).toContain(`Still in the vault: ${ACCESS}.`);
  });

  it('keeps a recorded token another profile reads as its basic password', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'shared' }) } }));
    store.register({ id: 'legacy', name: 'Legacy', base_url: 'https://legacy.example.com/v1', description: 'Legacy', auth: { type: 'basic', basic_format: 'user_pass_split', username_key: 'LEGACY_USER', password_key: ACCESS } });
    const vault = makeVault({ [ACCESS]: 'shared' });
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent);

    expect(vault.peek(ACCESS)).toBe('shared');
  });

  it('keeps a recorded token another profile names as its oauth client secret', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'shared' }) } }));
    store.register({ ...crmProfile(), id: 'other-oauth', base_url: 'https://other.example.com/v1', custom_endpoint_ack: { ...ACK, hosts: ['other.example.com'] }, auth: { type: 'oauth2', vault_keys: ['OTHER_ID'], oauth: { token_url: 'https://other.example.com/token', grant_type: 'client_credentials', client_id_key: 'OTHER_ID', client_secret_key: ACCESS } } });
    const vault = makeVault({ [ACCESS]: 'shared' });
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent);

    expect(vault.peek(ACCESS)).toBe('shared');
  });

  it('keeps a recorded token that another profile has on its own record', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ SHARED_TOKEN: 'v' }) } }));
    store.register({ ...crmProfile(), id: 'second', base_url: 'https://second.example.com/v1', custom_endpoint_ack: { ...ACK, hosts: ['second.example.com'] }, oauth_grant: { written: wrote({ SHARED_TOKEN: 'v' }) } });
    const vault = makeVault({ SHARED_TOKEN: 'v' });
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent);

    expect(vault.peek('SHARED_TOKEN')).toBe('v');
  });

  it('never removes a protected name, even when it is on the record', async () => {
    const store = new ApiStore();
    store.register({ ...crmProfile(), id: 'google-oauth-x', base_url: 'https://api.g.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.g.example'] }, oauth_grant: { written: wrote({ GOOGLE_OAUTH_X_ACCESS_TOKEN: 'platform-owned' }) } });
    const vault = makeVault({ GOOGLE_OAUTH_X_ACCESS_TOKEN: 'platform-owned' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'google-oauth-x' }, agent) as string;

    expect(vault.peek('GOOGLE_OAUTH_X_ACCESS_TOKEN')).toBe('platform-owned');
    // Nor offered to the user for removal: it is not theirs to decide.
    expect(result).toBe('Deleted API profile "google-oauth-x".');
  });

  it('purges nothing for a row the boot refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-api-grant-slot-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    const cs = new ConnectionStore(engine);
    // Two rows whose ids differ only in `-` vs `_`, as an old database can hold them.
    const writer = new ApiStore();
    writer.setConnectionStore(cs);
    writer.save({ ...crmProfile(), id: 'x-y', base_url: 'https://api.one.example/v1', oauth_grant: { written: wrote({ X_Y_ACCESS_TOKEN: 'the-holders-token' }) } });
    const lone = new ApiStore();
    lone.setConnectionStore(cs);
    lone.save({ ...crmProfile(), id: 'x_y', base_url: 'https://api.two.example/v1', oauth_grant: { written: wrote({ X_Y_ACCESS_TOKEN: 'the-holders-token' }) } });

    const booted = new ApiStore();
    booted.setConnectionStore(cs);
    booted.loadFromConnections(cs);
    const holder = booted.get('x-y') ? 'x-y' : 'x_y';
    const refused = holder === 'x-y' ? 'x_y' : 'x-y';
    expect(booted.get(refused)).toBeUndefined();

    const vault = makeVault({ X_Y_ACCESS_TOKEN: 'the-holders-token' });
    const agent = makeAgent(booted, vault);
    const result = await apiSetupTool.handler({ action: 'delete', id: refused }, agent) as string;

    expect(result).toBe(`Deleted API profile "${refused}".`);
    expect(vault.peek('X_Y_ACCESS_TOKEN')).toBe('the-holders-token');
  });

  it('says so when the vault cannot delete, instead of implying the tokens are gone', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const vault = makeVault({ [ACCESS]: 'at-1' }, { canDelete: false });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain(`Could NOT remove ${ACCESS}`);
    // Named once, as not removable — not also as something the user may keep.
    expect(result).not.toContain('Still in the vault');
    expect(vault.peek(ACCESS)).toBe('at-1');
  });

  it('names as not removable only a recorded value that is still there', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const vault = makeVault({ [ACCESS]: 'the-users-own-token' }, { canDelete: false });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).not.toContain('Could NOT remove');
    expect(result).toContain(`Still in the vault: ${ACCESS}.`);
  });

  it('says so when the vault throws on a delete', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const vault = makeVault({ [ACCESS]: 'at-1' });
    vault.deleteSecret = () => { throw new Error('vault locked'); };
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain(`Could NOT remove ${ACCESS}`);
  });

  it('finishes the delete when reading one name throws', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', [ACCESS]: 'at-1' });
    const plain = vault.resolve;
    vault.resolve = (name) => { if (name === 'CRM_CLIENT_ID') throw new Error('expired'); return plain(name); };
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toBe(`Deleted API profile "crm-api". Removed the tokens its exchanges wrote: ${ACCESS}.`);
  });

  it('passes over a recorded name that holds nothing any more', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const agent = makeAgent(store, makeVault({}));

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toBe('Deleted API profile "crm-api".');
  });

  it('says so when no vault is available, instead of a bare delete', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: wrote({ [ACCESS]: 'at-1' }) } }));
    const agent = makeAgent(store, null as never);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toBe('Deleted API profile "crm-api". No vault is available here, so no token was checked or removed.');
  });

  it('tolerates a record whose written field is not a list at all', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: ACCESS as unknown as OAuthGrantRecord['written'] } }));
    const vault = makeVault({ [ACCESS]: 'at-1' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain('Deleted API profile "crm-api".');
    expect(vault.peek(ACCESS)).toBe('at-1');
  });

  it('tolerates a record whose written list is not an array of entries', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written: [null, ACCESS, { name: ACCESS }] as unknown as OAuthGrantRecord['written'] } }));
    const vault = makeVault({ [ACCESS]: 'at-1' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain('Deleted API profile "crm-api".');
    expect(vault.peek(ACCESS)).toBe('at-1');
  });
});
