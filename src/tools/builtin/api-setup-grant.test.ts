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
  resolveSecretRefs(input: unknown): unknown;
  set(name: string, value: string): void;
  deleteSecret?(name: string): boolean;
  peek(name: string): string | undefined;
}

/** The slice of a secret store fetch_token and delete use, over a plain map. */
function makeVault(initial: Record<string, string>, opts: { canDelete?: boolean } = {}): MockVault {
  const store: Record<string, string> = { ...initial };
  const vault: MockVault = {
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
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-1' } }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('as revoked or expired');
    expect(result).toContain('not an expired access token');
    const grant = store.get('crm-api')?.oauth_grant;
    expect(grant?.state).toBe('revoked');
    expect(grant?.revoked_fp).toBe(tokenFingerprint('rt-1'));
    expect(grant?.minted_by).toBe('client-1');
  });

  it('reads invalid_grant as a client problem when a different client minted the token, and keeps the grant', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-OLD' } }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));

    const result = await fetchToken(agent);

    expect(result).toContain('rejected this API\'s client configuration');
    expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
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
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-1' } }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(401, JSON.stringify({ error: code }));

    const result = await fetchToken(agent);

    expect(result).toContain('rejected this API\'s client configuration');
    expect(store.get('crm-api')?.oauth_grant).toEqual({ minted_by: 'client-1' });
  });

  it.each([
    ['a server error', 503, JSON.stringify({ error: 'invalid_grant' })],
    ['a rate limit', 429, JSON.stringify({ error: 'invalid_grant' })],
    ['an HTML error page', 400, '<html>bad gateway</html>'],
    ['a code the engine does not classify', 400, JSON.stringify({ error: 'invalid_request' })],
  ])('changes nothing on %s', async (_label, status, body) => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-1' } }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(status, body);

    const result = await fetchToken(agent);

    expect(result).toContain('Nothing was changed; retry later.');
    expect(store.get('crm-api')?.oauth_grant).toEqual({ minted_by: 'client-1' });
  });

  it('reads invalid_grant as a rotation, not a revocation, when another writer replaced the token mid-flight', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-1' } }));
    const vault = vaultWithRefresh('rt-1');
    const agent = makeAgent(store, vault);
    // The second writer: while the POST is out, the slot is rotated to rt-2, and
    // the provider then rejects the spent rt-1.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vault.set(REFRESH, 'rt-2');
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchToken(agent);

    expect(result).toContain('Nothing was changed; retry later.');
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
});

describe('fetch_token — a revocation verdict and the way back', () => {
  const revoked = (fp: string): OAuthGrantRecord => ({ minted_by: 'client-1', state: 'revoked', revoked_fp: fp, revoked_at: '2026-09-22T00:00:00.000Z' });

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
    expect(grant?.minted_by).toBe('client-1');
  });
});

describe('fetch_token — what a successful exchange records', () => {
  it('stamps the client that minted the token, so a later invalid_grant can be told apart', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.oauth_grant?.minted_by).toBe('client-1');
    expect(store.get('crm-api')?.auth?.oauth?.token_expires_at).toBeGreaterThan(Date.now());
  });

  it('records a caller-chosen access-token slot for the purge trail, and not the derived one', async () => {
    const store = new ApiStore();
    store.register(crmProfile());
    const vault = vaultWithRefresh();
    const agent = makeAgent(store, vault);
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));

    await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: 'CRM_CUSTOM_TOKEN' }, agent);
    expect(store.get('crm-api')?.oauth_grant?.written_keys).toEqual(['CRM_CUSTOM_TOKEN']);

    tokenEndpoint(200, JSON.stringify({ access_token: 'at-2', expires_in: 3600 }));
    await fetchToken(agent);
    // The derived name is in the trail by derivation; recording it would be noise.
    expect(store.get('crm-api')?.oauth_grant?.written_keys).toEqual(['CRM_CUSTOM_TOKEN']);
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

describe('create/update — the grant record belongs to the engine', () => {
  const allow = async (): Promise<string> => 'allow';

  it('drops a grant record that arrives with a create', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    const forged = crmProfile({ oauth_grant: { minted_by: 'attacker', state: 'revoked', revoked_fp: 'ffffffffffffffff' } });

    await apiSetupTool.handler({ action: 'create', profile: forged }, agent);

    expect(store.get('crm-api')).toBeDefined();
    expect(store.get('crm-api')?.oauth_grant).toBeUndefined();
  });

  it('keeps the stored record when an update carries a different one', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    const engineRecord: OAuthGrantRecord = { minted_by: 'client-1', state: 'revoked', revoked_fp: tokenFingerprint('rt-1'), revoked_at: '2026-09-22T00:00:00.000Z' };
    store.register(crmProfile({ oauth_grant: engineRecord }));

    // A model clearing the revocation by echoing an edited record back.
    await apiSetupTool.handler({ action: 'update', profile: crmProfile({ description: 'edited', oauth_grant: { minted_by: 'client-1' } }) }, agent);

    expect(store.get('crm-api')?.description).toBe('edited');
    expect(store.get('crm-api')?.oauth_grant).toEqual(engineRecord);
  });

  it('keeps the stored record when an update omits the field', async () => {
    const store = new ApiStore();
    const agent = makeAgent(store, vaultWithRefresh(), allow);
    store.register(crmProfile({ oauth_grant: { minted_by: 'client-1' } }));

    await apiSetupTool.handler({ action: 'update', profile: crmProfile({ description: 'edited' }) }, agent);

    expect(store.get('crm-api')?.oauth_grant).toEqual({ minted_by: 'client-1' });
  });
});

describe('delete — what leaves the vault with a profile', () => {
  it('removes the tokens the profile minted and names the credentials it keeps', async () => {
    const store = new ApiStore();
    store.register(crmProfile({ oauth_grant: { written_keys: ['CRM_CUSTOM_TOKEN'] } }));
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [ACCESS]: 'at-1', [REFRESH]: 'rt-1', CRM_CUSTOM_TOKEN: 'at-custom' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(ACCESS)).toBeUndefined();
    expect(vault.peek(REFRESH)).toBeUndefined();
    // What the user stored, and a slot a caller chose, stay: another profile may use them.
    expect(vault.peek('CRM_CLIENT_ID')).toBe('client-1');
    expect(vault.peek('CRM_CLIENT_SECRET')).toBe('secret-1');
    expect(vault.peek('CRM_CUSTOM_TOKEN')).toBe('at-custom');
    expect(result).toContain(`Removed its tokens from the vault: ${ACCESS}, ${REFRESH}.`);
    expect(result).toContain('CRM_CLIENT_ID, CRM_CLIENT_SECRET, CRM_CUSTOM_TOKEN');
  });

  it('does not list a removed token among the kept ones when the profile names it explicitly', async () => {
    const store = new ApiStore();
    const base = crmProfile();
    // refresh_token_key pointed at the derived slot by hand — it is still the
    // profile's own token, so it goes, and the message must not claim it stayed.
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: REFRESH } } });
    const vault = makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [REFRESH]: 'rt-1' });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(vault.peek(REFRESH)).toBeUndefined();
    const kept = result.slice(result.indexOf('Kept in the vault'));
    expect(kept).toContain('CRM_CLIENT_ID, CRM_CLIENT_SECRET —');
    expect(kept).not.toContain(REFRESH);
  });

  it('never removes a derived name that falls into a protected prefix', async () => {
    const store = new ApiStore();
    // `google-oauth-x` derives into GOOGLE_OAUTH_, a platform prefix.
    store.register({ ...crmProfile(), id: 'google-oauth-x', base_url: 'https://api.g.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.g.example'] } });
    const vault = makeVault({ GOOGLE_OAUTH_X_ACCESS_TOKEN: 'platform-owned' });
    const agent = makeAgent(store, vault);

    await apiSetupTool.handler({ action: 'delete', id: 'google-oauth-x' }, agent);

    expect(vault.peek('GOOGLE_OAUTH_X_ACCESS_TOKEN')).toBe('platform-owned');
  });

  it('purges nothing for a row the boot refused — its derived names are a neighbour\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-api-grant-slot-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    const cs = new ConnectionStore(engine);
    // Two rows whose ids differ only in `-` vs `_`, as an old database can hold them.
    const writer = new ApiStore();
    writer.setConnectionStore(cs);
    writer.save({ ...crmProfile(), id: 'x-y', base_url: 'https://api.one.example/v1' });
    const lone = new ApiStore();
    lone.setConnectionStore(cs);
    lone.save({ ...crmProfile(), id: 'x_y', base_url: 'https://api.two.example/v1' });

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
    store.register(crmProfile());
    const vault = makeVault({ [ACCESS]: 'at-1' }, { canDelete: false });
    const agent = makeAgent(store, vault);

    const result = await apiSetupTool.handler({ action: 'delete', id: 'crm-api' }, agent) as string;

    expect(result).toContain(`so ${ACCESS} and ${REFRESH} were NOT removed`);
    expect(vault.peek(ACCESS)).toBe('at-1');
  });
});
