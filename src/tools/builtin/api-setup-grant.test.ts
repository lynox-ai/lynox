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
import { TOKEN_EXCHANGE_TIMEOUT_MS } from '../../core/oauth-token-exchange.js';
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

/**
 * The slice of a secret store fetch_token and delete use, over a plain map.
 *
 * `opts.reads` makes it a MEASURING instrument as well as a stub, and that is not
 * a convenience. Without it this vault resolves silently, so a mutant that adds
 * vault reads on a path that should touch none changes nothing this file can
 * output — which is exactly how the revoked-order mutant below was first
 * mis-scored as equivalent. The real `SecretStore` publishes a `secretAccess`
 * event per resolve; an array is the cheapest stand-in that has the same
 * granularity, and it records the name whether or not the slot exists, because
 * "asked for the client secret" is the event, not "got one".
 */
function makeVault(
  initial: Record<string, string>,
  opts: { canDelete?: boolean; reads?: string[] } = {},
): MockVault {
  const store: Record<string, string> = { ...initial };
  const note = (name: string): void => { opts.reads?.push(name); };
  const vault: MockVault = {
    resolve: (name) => { note(name); return store[name] ?? null; },
    resolveSecretRefs: (input: unknown): unknown => {
      const text = JSON.stringify(input);
      const resolved = text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (_m, name: string) => {
        note(name);
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

/**
 * `granted` models the agent's TOOL SURFACE, and it has to be modelled because
 * the renewal is gated on it.
 *
 * The default holds `api_setup`, which is what an ordinary session has: the tool
 * is registered unconditionally and a session with no role gets the whole
 * registry. Passing `[]` (or a list without it) builds the other real case — a
 * role-scoped child or a workflow step, neither of which can hold `api_setup`.
 *
 * ⚠ Without this the fixture had no tool surface at all, so every "does NOT
 * renew" test would have gone green for the wrong reason: the gate would have
 * refused everything and the assertions would have proved nothing.
 */
function makeAgent(
  apiStore: ApiStore,
  vault: MockVault,
  promptUser?: () => Promise<string>,
  granted: readonly string[] = ['http_request', 'api_setup'],
): never {
  return {
    sessionCounters: { httpRequests: 0, approvedOutboundDomains: new Set<string>(), pendingOutboundPrompts: new Map<string, unknown>() },
    secretStore: vault,
    getAvailableTools: () => granted.map((name) => ({ definition: { name } })),
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

  /**
   * A response with no usable `expires_in` must CLEAR the stored expiry, not keep
   * the previous one.
   *
   * This is a latch if it keeps it, and the latch is what makes it worth a test
   * rather than a comment. The old value describes a token that has just been
   * replaced. Leave it in place and the profile permanently claims an expiry in
   * the past — so a lazy refresh, which reads exactly this field, exchanges a
   * token on every single request from then on: one secret write, one profile
   * save and one outbound POST each time, against a session budget of 100, and on
   * a provider that rotates its refresh token, a burned refresh token per request.
   *
   * `expires_in` is RECOMMENDED, not REQUIRED, in RFC 6749 §5.1, so a provider
   * that omits it is conformant and this is not an exotic response. The absent
   * field is the honest state: the reader in `http.ts` renews only for a numeric
   * expiry, so "unknown" correctly means "do not plan against this".
   */
  it('clears a stale expiry when the response carries no expires_in', async () => {
    const store = new ApiStore();
    const past = Date.now() - 60_000;
    store.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
    }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2' }));

    await fetchToken(agent);

    const vaulted = (agent as unknown as { secretStore: MockVault }).secretStore;
    expect(vaulted.peek('CRM_API_ACCESS_TOKEN'), 'the new token was not stored, so this says nothing about the expiry').toBe('at-2');
    expect(store.get('crm-api')?.auth?.oauth?.token_expires_at, 'the expiry of the REPLACED token was kept, which reads as "already expired" forever').toBeUndefined();
  });

  /**
   * The same, for a value that is present but unusable. `expires_in` arriving as
   * the JSON string `"3600"` is the shape that made this worth splitting out: it
   * is truthy, it looks right in a log, and it fails `Number.isSafeInteger`, so it
   * takes the identical path as a missing field.
   */
  it('clears a stale expiry when expires_in is present but not a usable number', async () => {
    const store = new ApiStore();
    store.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: Date.now() - 60_000 } },
    }));
    const agent = makeAgent(store, vaultWithRefresh());
    tokenEndpoint(200, JSON.stringify({ access_token: 'at-3', expires_in: '3600' }));

    await fetchToken(agent);

    expect(store.get('crm-api')?.auth?.oauth?.token_expires_at).toBeUndefined();
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

    expect(result).toContain('Leaving output_secret_name out does not help');
    expect(result).toContain('Point auth.oauth.refresh_token_key at a slot that holds only the refresh token');
    expect(result).not.toContain(`goes to "${ACCESS}"`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers the same way when that profile is asked for the derived refresh name as well', async () => {
    const store = new ApiStore();
    const base = crmProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: ACCESS } } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', [ACCESS]: 'rt-1' }));

    // The refusal is reached through the derived refresh name, but the profile's
    // own slot is still what blocks the way out.
    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: REFRESH }, agent) as string;

    expect(result).toContain('Leaving output_secret_name out does not help');
    expect(result).not.toContain(`goes to "${ACCESS}"`);
  });

  it('tells a client-credentials profile to drop the refresh slot it does not read', async () => {
    const store = new ApiStore();
    const base = crmProfile({}, 'client_credentials');
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: ACCESS } } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchToken(agent);

    expect(result).toContain('Remove auth.oauth.refresh_token_key with api_setup update: a client-credentials profile does not read one.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends an id whose derived access name is protected to a rename, not to a name it cannot use', async () => {
    const store = new ApiStore();
    // `lynox-y` derives LYNOX_Y_ACCESS_TOKEN, a platform prefix. The profile reads its
    // refresh token from a slot of its own, so the refusal is about the output name.
    const base = crmProfile();
    store.register({ ...base, id: 'lynox-y', base_url: 'https://api.l.example/v1', custom_endpoint_ack: { ...ACK, hosts: ['api.l.example', 'api.crm.example'] }, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, refresh_token_key: 'CRM_RT' } } });
    const agent = makeAgent(store, makeVault({ CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_RT: 'rt-1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'lynox-y', output_secret_name: 'CRM_RT' }, agent) as string;

    expect(result).toContain('is a protected slot, so its id leaves no name for the access token: rename the api_profile');
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

describe('fetch_token — the wall-clock ceiling on a dripping body', () => {
  // ── Why this test is added BEFORE the exchange moves ──────────────────
  //
  // `oauth-token-exchange.ts` extracts this exchange out of the tool so the
  // OAuth callback route can reach it too. The proof that the extraction is
  // faithful is "the existing fetch_token tests stay green" — and that proof
  // is only as wide as those tests.
  //
  // Measured before writing this: `timed out` occurred **0 times** across the
  // whole fetch_token suite. So the one property the extraction could silently
  // drop — the wall-clock guard that an AbortController alone does not give —
  // was the one the proof could not see. Characterised here against the
  // CURRENT code, green before the move, so the move has something to be
  // measured against.
  //
  // The hazard the guard exists for, from the code's own comment: an
  // `AbortController.signal` aborts `fetch()` but NOT `response.body.getReader()`
  // once headers have arrived. A token endpoint that answers 200 and then drips
  // bytes would hold the read open indefinitely.

  it('rejects a response whose body never completes, instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const store = new ApiStore();
      store.register(crmProfile());
      const agent = makeAgent(store, vaultWithRefresh());

      // Headers arrive; the body never does. `cancel` is a no-op on purpose:
      // a body that honoured cancellation would not exercise the guard.
      const neverEnds = new ReadableStream<Uint8Array>({ start() { /* nothing, ever */ } });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(neverEnds, { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      const pending = fetchToken(agent);
      // Past the WALL timer, not merely past the abort timer — the second
      // ceiling is the point. Derived from the constant rather than written as
      // 17_000: this is the only test that depends on that value, and a
      // hard-coded number means grepping the live constant does not lead here.
      // (It said `DOCS_FETCH_TIMEOUT_MS` for one commit, which stopped being the
      // constant on this path the moment the exchange moved — a comment that
      // went stale inside its own pull request.)
      await vi.advanceTimersByTimeAsync(TOKEN_EXCHANGE_TIMEOUT_MS + 1_500);
      const result = await pending;

      expect(result).toContain('timed out');
      // And the grant is untouched: a timeout is not a revocation.
      expect(store.get('crm-api')?.oauth_grant?.state).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an expiring oauth2 token is renewed before the request that needs it', () => {
  /**
   * The renewal runs `api_setup` action=fetch_token through a DYNAMIC import,
   * because `api-setup.ts` imports `http.ts` and a static back-import is a
   * cycle. A dynamic import moves a load failure out of the build and into the
   * first renewal — at a customer, a day after a deploy, in a path that writes
   * secrets.
   *
   * So this asserts the import itself, not a mock of it. A test that mocks
   * `api-setup` proves that the caller makes a call; it cannot prove the module
   * resolves or still exports what the caller reaches for.
   */
  it('the module the renewal imports resolves, and exports the handler it calls', async () => {
    const mod = await import('./api-setup.js');
    expect(mod.apiSetupTool).toBeDefined();
    expect(typeof mod.apiSetupTool.handler).toBe('function');
  });

  /**
   * The buffer is derived rather than chosen, so it is pinned against the two
   * numbers it was derived from. If either grows past it, a token can die
   * between the check and its use and the failure reads as a revocation.
   */
  it('the refresh buffer outlasts a maximum request plus an exchange', async () => {
    const { OAUTH_REFRESH_BUFFER_MS } = await import('./http.js');
    const HTTP_TIMEOUT_HARD_CAP_MS = 60_000; // http_request's documented ceiling
    expect(OAUTH_REFRESH_BUFFER_MS).toBeGreaterThan(HTTP_TIMEOUT_HARD_CAP_MS + TOKEN_EXCHANGE_TIMEOUT_MS);
  });

  /**
   * The property the design rests on: the renewal cannot trigger itself. The
   * exchange runs through `exchangeToken` → `fetchWithValidatedRedirects` rather
   * than through the `http_request` handler, so it cannot come back round to the
   * attach.
   *
   * ⚠ An earlier version of this test counted mentions of
   * `attachEngineManagedAuth` in the SOURCE and required exactly three. It was
   * labelled a proxy, and it behaved like one: `core#1407` added a second,
   * entirely legitimate caller (`attachStoredCredential`, the bulk worker
   * effect's entry point) and the count went to four. **The test went red for a
   * change that is not the defect it exists to catch, and it would have stayed
   * green for one that is** — re-entry through `httpRequestTool.handler` reaches
   * the attach without ever naming it.
   *
   * So it counts EXCHANGES now, which is the property itself. Recursion would
   * mint more than one token for one request; nothing else would.
   */
  it('one renewed request mints exactly one token, so the renewal cannot re-enter', async () => {
    const past = Date.now() - 1000;
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
    }));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'FRESH', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { httpRequestTool } = await import('./http.js');
    await httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      makeAgent(apiStore, makeVault({
        CRM_CLIENT_ID: 'id', CRM_CLIENT_SECRET: 'sec',
        CRM_API_ACCESS_TOKEN: 'OLD_TOKEN', CRM_API_REFRESH_TOKEN: 'REFRESH',
      })),
    );

    const exchanges = calls.filter((u) => u.includes('/oauth/token')).length;
    expect(exchanges, `one request minted ${String(exchanges)} tokens — the renewal re-entered the attach`).toBe(1);
  });
});

describe('the renewal fires on expiry and not otherwise', () => {
  /** One fetch spy that answers the token endpoint and the API separately. */
  function stubBoth(newAccessToken: string): { calls: string[] } {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: newAccessToken, expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { calls };
  }

  async function callApi(profile: ApiProfile, vaultSeed: Record<string, string>): Promise<{ calls: string[]; vault: MockVault }> {
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(profile);
    const vault = makeVault(vaultSeed);
    const { calls } = stubBoth('MINTED_BY_RENEWAL');
    const { httpRequestTool } = await import('./http.js');
    await httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      makeAgent(apiStore, vault),
    );
    return { calls, vault };
  }

  const SEED = {
    CRM_CLIENT_ID: 'id', CRM_CLIENT_SECRET: 'sec',
    CRM_API_ACCESS_TOKEN: 'OLD_TOKEN', CRM_API_REFRESH_TOKEN: 'REFRESH',
  };

  it('renews a token inside the buffer, through the real dynamic import', async () => {
    const past = Date.now() - 1000; // already expired
    const { calls, vault } = await callApi(
      crmProfile({ auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } } }),
      SEED,
    );
    expect(calls.some((u) => u.includes('/oauth/token')), `no token POST went out; calls were ${calls.join(', ')}`).toBe(true);
    // The exchange ran for real: the vault holds what the stub minted.
    expect(vault.peek('CRM_API_ACCESS_TOKEN')).toBe('MINTED_BY_RENEWAL');
  });

  it('leaves a token alone while it is outside the buffer', async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    const { calls, vault } = await callApi(
      crmProfile({ auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: farFuture } } }),
      SEED,
    );
    expect(calls.some((u) => u.includes('/oauth/token')), 'a token POST went out for a token that is nowhere near expiry').toBe(false);
    expect(vault.peek('CRM_API_ACCESS_TOKEN')).toBe('OLD_TOKEN');
  });

  it('carries no expiry at all the way it always did — no renewal, no refusal', async () => {
    const { calls } = await callApi(crmProfile(), SEED);
    expect(calls.some((u) => u.includes('/oauth/token'))).toBe(false);
    expect(calls.some((u) => u.includes('/v1/contacts'))).toBe(true);
  });

  /**
   * The fall-through contract. A provider hiccup during renewal must not fail a
   * request whose stored token is still valid — the buffer exists precisely so
   * that it is. Nothing is recorded either: this path writes no verdict, and the
   * handler it calls writes no revocation it has not proven.
   */
  it('attaches the stored token when the renewal itself fails', async () => {
    const past = Date.now() - 1000;
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(crmProfile({ auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } } }));
    const vault = makeVault(SEED);

    const seen: { authorization?: string } = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/oauth/token')) return new Response('{"error":"server_error"}', { status: 500 });
      const h = new Headers(init?.headers);
      seen.authorization = h.get('authorization') ?? undefined;
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const { httpRequestTool } = await import('./http.js');
    const out = await httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      makeAgent(apiStore, vault),
    );
    expect(String(out)).not.toMatch(/^Error:/);
    expect(seen.authorization, 'the stored token was not attached after a failed renewal').toBe('Bearer OLD_TOKEN');
    expect(vault.peek('CRM_API_ACCESS_TOKEN')).toBe('OLD_TOKEN');
  });
});

describe('who may have a token renewed on their behalf', () => {
  /**
   * The gate is asserted DIRECTLY, on the exported predicate, because the effect
   * it guards writes secrets and posts a client secret. A test that could only
   * reach this judgement by running the renewal would have to run that too.
   */
  function agentWith(over: Record<string, unknown>): never {
    return {
      sessionCounters: { httpRequests: 0, approvedOutboundDomains: new Set<string>(), pendingOutboundPrompts: new Map<string, unknown>() },
      toolContext: { apiStore: null },
      getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
      ...over,
    } as never;
  }

  it('permits a caller that holds api_setup and carries both guards', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    expect(mayRenewOAuthUnattended(agentWith({}))).toBe(true);
  });

  it('refuses a caller that does not hold api_setup', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    // The two real populations: a role-scoped child, and a workflow step whose
    // tools are filtered to a set that never admits `api_setup`.
    expect(mayRenewOAuthUnattended(agentWith({
      getAvailableTools: () => [{ definition: { name: 'http_request' } }],
    }))).toBe(false);
    expect(mayRenewOAuthUnattended(agentWith({ getAvailableTools: () => [] }))).toBe(false);
  });

  it('pins the literal tool name against the tool itself', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    // `http.ts` cannot import `api-setup.ts` statically — that is a cycle — so it
    // carries the name as a literal. A rename would fail OPEN: the gate would
    // stop finding the tool and every renewal would quietly refuse. This is the
    // only thing tying the two together, and it does it behaviourally rather
    // than by exporting the constant.
    expect(mayRenewOAuthUnattended(agentWith({
      getAvailableTools: () => [{ definition: { name: apiSetupTool.definition.name } }],
    }))).toBe(true);
  });

  it('refuses a caller with no session counters, and does not throw reaching that answer', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    // `fetch_token` dereferences `agent.sessionCounters.httpRequests` with no
    // guard, so this is the difference between a clean refusal and a TypeError.
    expect(mayRenewOAuthUnattended(agentWith({ sessionCounters: undefined }))).toBe(false);
    expect(mayRenewOAuthUnattended(agentWith({ sessionCounters: {} }))).toBe(false);
  });

  it('refuses a caller with no tool context', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    // `toolContext` is what `exchangeToken` is handed as the carrier of the
    // egress controls. Absent, the POST would go out past them.
    expect(mayRenewOAuthUnattended(agentWith({ toolContext: undefined }))).toBe(false);
  });

  /**
   * The fabricated agent that actually exists: a bulk run's worker effect builds
   * `{ secretStore } as IAgent` and hands it to the attach. It satisfies the
   * compiler and carries neither guard nor tool surface.
   *
   * ⚠ This is the test that catches a revert. The temptation on the other side
   * is to make the fake MORE complete so the renewal works — and each field
   * added there removes one barrier here, in an order that matters: without
   * `sessionCounters` the exchange throws BEFORE its POST, so the missing field
   * is currently what stops an unguarded egress. A fake that gained
   * `sessionCounters` would post past the egress controls instead of failing.
   */
  it('refuses a fabricated agent that carries only a secret store', async () => {
    const { mayRenewOAuthUnattended } = await import('./http.js');
    const fabricated = { secretStore: makeVault({}) } as never;
    expect(() => mayRenewOAuthUnattended(fabricated)).not.toThrow();
    expect(mayRenewOAuthUnattended(fabricated)).toBe(false);
  });
});

describe('the two properties the comments claim, which nothing was checking', () => {
  // Module-scoped so a THROWN refusal does not take the record with it: `run`
  // never returns in that case, and the calls are exactly what has to be
  // asserted then.
  let lastCalls: string[] = [];

  function stubBoth(): { calls: string[] } {
    const calls: string[] = [];
    lastCalls = calls;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'FRESH', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { calls };
  }

  const SEED = {
    CRM_CLIENT_ID: 'id', CRM_CLIENT_SECRET: 'sec',
    CRM_API_ACCESS_TOKEN: 'OLD_TOKEN', CRM_API_REFRESH_TOKEN: 'REFRESH',
  };

  async function run(
    profile: ApiProfile,
    vault?: MockVault,
    granted?: readonly string[],
  ): Promise<{ calls: string[]; out: string }> {
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(profile);
    const { calls } = stubBoth();
    const { httpRequestTool } = await import('./http.js');
    const out = await httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      makeAgent(apiStore, vault ?? makeVault(SEED), undefined, granted),
    );
    return { calls, out: String(out) };
  }

  /**
   * The BUFFER, not merely expiry. A token two minutes from dying is still
   * valid, and renewing it is the whole point: the request it is about to carry
   * may run for a minute, and the exchange before it for fifteen seconds.
   *
   * Without this, setting the buffer to zero was caught only by the test that
   * pins the constant — so changing the number and that test together would
   * have removed the behaviour invisibly.
   */
  it('renews a token that is inside the buffer but has NOT expired yet', async () => {
    const twoMinutesLeft = Date.now() + 2 * 60 * 1000;
    const { calls } = await run(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: twoMinutesLeft } },
    }));
    expect(calls.some((u) => u.includes('/oauth/token')), 'a still-valid token inside the buffer was not renewed').toBe(true);
  });

  /**
   * That a revoked grant costs no exchange — which holds for BOTH reasons and
   * is worth pinning for that: this path checks before renewing, and
   * `fetch_token` short-circuits on a revoked grant before it posts anything.
   *
   * ⚠ This one does NOT pin the order, and the next one does. An earlier note
   * here said the order was not worth pinning because the swap mutant survived.
   * It survived this assertion because an exchange is refused either way; what it
   * changes is which SECRETS get read first, and that is the test below.
   */
  it('refuses a revoked grant without spending an exchange on it', async () => {
    const past = Date.now() - 1000;
    const grant: OAuthGrantRecord = {
      state: 'revoked',
      revoked_fp: tokenFingerprint('REFRESH'),
      revoked_at: '2026-09-30T00:00:00.000Z',
    };
    // The refusal is THROWN as a soft failure, not returned — so the assertion
    // has to catch it. Getting that wrong is how this test first failed, and the
    // failure was the harness rather than the behaviour.
    let refusal = '';
    let calls: string[] = [];
    try {
      const r = await run(crmProfile({
        auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
        oauth_grant: grant,
      }));
      calls = r.calls;
      expect.unreachable('a revoked grant was not refused');
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
      calls = lastCalls;
    }
    expect(refusal).toMatch(/revoked or expired/);
    expect(calls.some((u) => u.includes('/oauth/token')), 'an exchange was spent on a grant already known to be revoked').toBe(false);
  });

  /**
   * Through the REAL seam, not a hand-made fake: `attachStoredCredential` is the
   * bulk run's worker-effect entry point (core#1407), and it builds
   * `{ secretStore } as IAgent` by design — a worker effect has no agent to hand
   * over. It therefore reaches the attach with no tool surface and no session
   * counters.
   *
   * ⚠ This is the test that catches a revert, and it could not be written until
   * that entry point landed on main — nothing on its own branch reads the field
   * the gate is about. It is worth more than the predicate test above because it
   * asserts the interaction at the seam where the two pieces actually meet.
   *
   * The temptation on the other side is to make the fabricated agent MORE
   * complete so the renewal works. Each field added there removes one barrier
   * here, and the ORDER matters: without `sessionCounters` the exchange throws
   * before its POST, so today the missing field is what stops an unguarded
   * egress. A fake that gained `sessionCounters` while still carrying a partial
   * `toolContext` would POST past the egress controls instead of failing. The
   * durable answer is an authorization recorded when the run is PLANNED, not
   * inferred at runtime from an object's shape.
   */
  it('spends no exchange for the bulk worker effect, which has no agent at all', async () => {
    const past = Date.now() - 1000;
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
    }));
    const { calls } = stubBoth();
    const { attachStoredCredential } = await import('./http.js');

    const headers: Record<string, string> = {};
    const attached = await attachStoredCredential(
      'https://api.crm.example/v1/contacts',
      headers,
      { apiStore, secretStore: makeVault(SEED) as never },
    );

    expect(calls.some((u) => u.includes('/oauth/token')), 'a caller with no agent had a token minted on its behalf').toBe(false);
    // It still attaches the stored token — the run continues and a dead token
    // shows up as the provider's own 401, which is what that path reports.
    expect(attached, 'the stored credential was not attached, so the run lost a capability rather than a renewal').toBe(true);
    expect(headers['Authorization']).toBe('Bearer OLD_TOKEN');
  });

  /**
   * The gate at the EFFECT level, not only on the predicate: a caller without
   * `api_setup` spends no exchange, and still gets its stored token attached.
   *
   * The second half is what makes this a degradation rather than a regression —
   * the request goes out exactly as it did before the renewal existed, and the
   * existing 401 path says what to do if the token is truly dead.
   */
  it('spends no exchange for a caller that does not hold api_setup', async () => {
    const past = Date.now() - 1000;
    const { calls, out } = await run(
      crmProfile({
        auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
      }),
      undefined,
      ['http_request'],
    );
    expect(calls.some((u) => u.includes('/oauth/token')), 'a caller without api_setup had a token minted on its behalf').toBe(false);
    expect(calls.some((u) => u.includes('/v1/contacts')), 'the request itself did not go out, so this is a regression rather than a degradation').toBe(true);
    expect(out).not.toMatch(/^Error:/);
  });

  /**
   * ONE exchange for N concurrent requests on one expiring profile.
   *
   * `api_setup` has no in-flight guard: what its concurrency re-read guarantees
   * is that an overlapping exchange cannot record a FALSE revocation, not that
   * overlap does not happen. Without coalescing, three requests present the same
   * refresh token three times; a rotating provider rejects two, and one with
   * reuse detection kills the grant. Precedent: `google-auth.ts › refreshInFlight`.
   *
   * The token endpoint is made slow on purpose so the three overlap; with the
   * coalescer removed this sees three POSTs.
   */
  it('coalesces concurrent renewals for one profile into a single exchange', async () => {
    const past = Date.now() - 1000;
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    apiStore.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
    }));

    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('/oauth/token')) {
        await new Promise((r) => setTimeout(r, 60));
        return new Response(JSON.stringify({ access_token: 'FRESH', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const { httpRequestTool } = await import('./http.js');
    const agent = makeAgent(apiStore, makeVault(SEED));
    await Promise.all([1, 2, 3].map(() => httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      agent,
    )));

    const exchanges = calls.filter((u) => u.includes('/oauth/token'));
    expect(exchanges.length, `three overlapping requests minted ${String(exchanges.length)} tokens instead of one`).toBe(1);
    expect(calls.filter((u) => u.includes('/v1/contacts')).length, 'all three requests still went out').toBe(3);
  });

  /**
   * A REFUSED renewal reaches stderr.
   *
   * This is a correction, not an addition. The first version discarded the
   * handler's return value while a comment claimed the two catches meant a
   * non-transient failure "must not be quiet". The `fetch_token` branch throws
   * nowhere — every failure is a returned string — so discarding it made every
   * real refusal silent, including "the per-session HTTP budget is exhausted".
   */
  it('writes a refused renewal to stderr instead of discarding it', async () => {
    const past = Date.now() - 1000;
    const db = new EngineDb(join(mockLynoxDir, 'engine.db'));
    engines.push(db);
    const apiStore = new ApiStore(join(mockLynoxDir, 'apis'), new ConnectionStore(db));
    // No client_secret in the vault: `fetch_token` RETURNS a refusal naming the
    // missing key and never posts.
    apiStore.register(crmProfile({
      auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
    }));
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const { calls } = stubBoth();
    const { httpRequestTool } = await import('./http.js');
    const out = await httpRequestTool.handler(
      { url: 'https://api.crm.example/v1/contacts', method: 'GET' } as never,
      makeAgent(apiStore, makeVault({ CRM_API_ACCESS_TOKEN: 'OLD_TOKEN', CRM_API_REFRESH_TOKEN: 'REFRESH' })),
    );

    expect(calls.some((u) => u.includes('/oauth/token')), 'the refusal came from the provider rather than from fetch_token').toBe(false);
    expect(written.join(''), 'a refused renewal left no trace at all').toMatch(/oauth token renewal refused for profile "crm-api"/);
    expect(String(out)).not.toMatch(/^Error:/);
  });

  /**
   * The ORDER, pinned by the only thing it changes: which secrets a refused
   * request reads.
   *
   * This test exists because the claim it checks was first measured wrong and
   * written into three comments as settled. `fetch_token` returns before it
   * POSTs when the grant is revoked, so no test that counts requests can tell
   * the two orders apart. But it returns AFTER resolving client_id, client_secret
   * and the refresh token — so with the renewal placed above the revoked-grant
   * check, a request that is going to be refused pulls the client secret out of
   * the vault first, and in the real store that is three `secretAccess` audit
   * events for a credential on a request that was never sent.
   *
   * So the order is least-secret-exposure, a correctness property, and the
   * mutation that proves it is: move the `token_expires_at` block in `http.ts`
   * above the `hasRevokedGrant` block. The refresh key IS expected here — the
   * attach reads it itself to decide whether the revocation still applies —
   * which is why the assertion names the client secret rather than counting.
   */
  it('does not read the client secret on a request it is going to refuse', async () => {
    const past = Date.now() - 1000;
    const reads: string[] = [];
    let refusal = '';
    try {
      await run(
        crmProfile({
          auth: { ...crmProfile().auth!, oauth: { ...crmProfile().auth!.oauth!, token_expires_at: past } },
          oauth_grant: {
            state: 'revoked',
            revoked_fp: tokenFingerprint('REFRESH'),
            revoked_at: '2026-09-30T00:00:00.000Z',
          },
        }),
        makeVault(SEED, { reads }),
      );
      expect.unreachable('a revoked grant was not refused');
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }
    expect(refusal).toMatch(/revoked or expired/);
    expect(reads, 'a refused request resolved the client secret out of the vault').not.toContain('CRM_CLIENT_SECRET');
    expect(reads, 'a refused request resolved the client id out of the vault').not.toContain('CRM_CLIENT_ID');
    // The positive control: without this the assertions above would also pass if
    // the recorder were simply not wired up, which is the failure that produced
    // the wrong verdict in the first place.
    expect(reads, 'the read recorder captured nothing at all, so the two assertions above prove nothing').toContain('CRM_API_REFRESH_TOKEN');
  });
});
