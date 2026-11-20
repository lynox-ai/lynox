import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A provider removed from the register leaves profiles whose grant a user gave through it.
// The shipped retired list is empty, so this file brings its own: one provider still in the
// register, one retired, and an id that was never shipped as the control.

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]),
  },
}));

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const register = real.presetRegisterOf([{
    id: 'example-shop',
    label: 'Example Shop',
    host: { kind: 'constant', host: 'shops.example.com' },
    apiHosts: [], authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [],
    requiredScopes: [],
    allowedScopes: [],
  }]);
  const retired = Object.freeze(['gone-shop']);
  return {
    ...real,
    // Their default register and list are bound inside the real module, so they are handed these.
    builtInPresetOf: (profile: Parameters<typeof real.builtInPresetOf>[0]) => real.builtInPresetOf(profile, register),
    retiredPresetIdOf: (profile: Parameters<typeof real.retiredPresetIdOf>[0]) => real.retiredPresetIdOf(profile, retired),
    derivePresetEndpoints: (id: string, params: Readonly<Record<string, unknown>> | undefined) =>
      real.derivePresetEndpoints(id, params, register),
    presetIds: () => register.ids(),
    isPresetClientSecretName: (name: string) => real.isPresetClientSecretName(name, register, retired),
    OAUTH_PRESETS: register,
    RETIRED_PRESET_IDS: retired,
  };
});

const { apiSetupTool } = await import('./api-setup.js');
const { declinedFacts, httpRequestTool, oauthGrantIsUserDelegated, renderDeclinedFact } = await import('./http.js');
const { isPresetClientSecretName } = await import('../../core/oauth-presets.js');
const { slotMayReach } = await import('../../core/profile-secret-view.js');
const { refreshTokenKey } = await import('../../core/api-store.js');
const { tokenFingerprint } = await import('../../core/oauth-refresh-failure.js');
const { ApiStore } = await import('../../core/api-store.js');
const { setPinnedTransportForTests } = await import('../../core/network-guard.js');
const { bindingsAsMigrated } = await import('../../../tests/helpers/vault-bindings.js');
const { testAuditLog } = await import('../../../tests/helpers/audit-log.js');
type ApiProfile = import('../../core/api-store.js').ApiProfile;
type ApiStoreT = InstanceType<typeof ApiStore>;

const tmpDirs: string[] = [];
let restorePinnedTransport: (() => void) | undefined;

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-retired-preset-test-'));
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
  vi.unstubAllEnvs();
  restorePinnedTransport?.();
  restorePinnedTransport = undefined;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRETS: Record<string, string> = {
  SHOP_CLIENT_ID: 'not-a-real-client-id-only-a-fixture',
  SHOP_CLIENT_SECRET: 'not-a-real-client-secret-only-a-fixture',
};

function agentWith(store: ApiStoreT): never {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    promptUser: async () => 'allow',
    secretStore: {
      resolve: (name: string): string | null => SECRETS[name] ?? null,
      extractSecretNames: (input: unknown): string[] => [...JSON.stringify(input).matchAll(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g)].map((m) => m[1]!),
      resolveSecretRefs: (input: unknown): unknown => {
        const text = JSON.stringify(input);
        return JSON.parse(text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, name: string) => SECRETS[name] ?? m)) as unknown;
      },
      set: (): void => undefined,
      listNames: (): string[] => Object.keys(SECRETS),
      containsSecretAsHost: (): boolean => false,
    },
    toolContext: { auditLog: testAuditLog().log, vaultNameBindings: bindingsAsMigrated(store), apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
  } as never;
}

/**
 * A profile set up through `presetId`, with no grant record: one that re-entered the store as a
 * file. A provider's profile in its real shape carries no `vault_keys`: the provider's sign-in
 * reads the two client keys itself.
 */
function profileNaming(presetId: string): ApiProfile {
  return {
    id: 'shop-api',
    name: 'Shop',
    base_url: 'http://shop.local/api',
    description: 'Preset profile',
    endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    auth: { type: 'oauth2', oauth: {
      client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET',
      preset_id: presetId,
    } },
  };
}

/** A profile naming an id that was never shipped: an app-only profile with its own token endpoint. */
function appOnlyNaming(presetId: string): ApiProfile {
  const base = profileNaming(presetId);
  return { ...base, auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: {
    ...base.auth!.oauth!, token_url: 'https://api.openai.com/oauth/token',
  } } };
}

describe('a profile of a provider this engine no longer has', () => {
  it('still counts as a user\'s grant, while an id that was never shipped does not', () => {
    expect(oauthGrantIsUserDelegated(profileNaming('gone-shop'))).toBe(true);
    expect(oauthGrantIsUserDelegated(appOnlyNaming('never-shipped'))).toBe(false);
    // The provider binds an oauth2 profile only, as for one still in the register.
    expect(oauthGrantIsUserDelegated({ auth: { type: 'bearer', oauth: { preset_id: 'gone-shop' } } })).toBe(false);
  });

  it('names the provider as the reason a refused renewal was refused, in the fact and in its text', () => {
    const fact = declinedFacts(profileNaming('gone-shop'), 'empty')[0]!;
    expect(fact).toEqual({ kind: 'consent', consent: 'preset', preset: 'gone-shop' });
    expect(renderDeclinedFact(fact)).toBe('no consent flow is recorded behind it, but it goes through the built-in provider "gone-shop", whose tokens only a user\'s authorization issues');
    const control = declinedFacts(appOnlyNaming('never-shipped'), 'empty')[0]!;
    expect(control).toEqual({ kind: 'consent', consent: 'none', preset: undefined });
    expect(renderDeclinedFact(control)).toBe('no consent flow is recorded behind it');
  });

  it('keeps its client secret a built-in provider\'s, so it stays off the list and out of references', () => {
    expect(isPresetClientSecretName('GONE_SHOP_CLIENT_SECRET')).toBe(true);
    expect(isPresetClientSecretName('EXAMPLE_SHOP_CLIENT_SECRET')).toBe(true);
    // A name nobody shipped is an operator's own.
    expect(isPresetClientSecretName('NEVER_SHIPPED_CLIENT_SECRET')).toBe(false);
  });

  it('lets no refresh slot reach the token_url such a profile names, while an app-only profile\'s still does', () => {
    const url = 'https://api.openai.com/oauth/token';
    const retired = { ...profileNaming('gone-shop'), auth: { ...profileNaming('gone-shop').auth!, oauth: { ...profileNaming('gone-shop').auth!.oauth!, token_url: url } } };
    const store = new ApiStore();
    store.register(retired);
    expect(slotMayReach(store, refreshTokenKey('shop-api'), 'exchange', url, retired)).toBe(false);
    const appOnly = appOnlyNaming('never-shipped');
    const control = new ApiStore();
    control.register(appOnly);
    expect(slotMayReach(control, refreshTokenKey('shop-api'), 'exchange', url, appOnly)).toBe(true);
  });

  it('answers a revoked grant with the way that exists, not with a token to paste or a consent that cannot run', async () => {
    const store = new ApiStore();
    const base = profileNaming('gone-shop');
    store.register({
      ...base, base_url: 'https://shop.example.com/api',
      custom_endpoint_ack: { accepted: true, hosts: ['shop.example.com'], accepted_at: '2026-10-01T00:00:00.000Z' },
      auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, grant_type: 'refresh_token' } },
      oauth_grant: { origin: 'callback', state: 'revoked', revoked_fp: tokenFingerprint('rt-revoked') } as never,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const agent = {
      principal: OWNER_PRINCIPAL,
      toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store },
      sessionCounters: { httpRequests: 0 },
      secretStore: { resolve: (n: string) => (n === 'SHOP_API_REFRESH_TOKEN' ? 'rt-revoked' : n === 'SHOP_API_ACCESS_TOKEN' ? 'at-stale' : null) },
    } as never;
    let result: string;
    try {
      result = String(await httpRequestTool.handler({ url: 'https://shop.example.com/api/x', method: 'GET' }, agent));
    } catch (err) {
      result = (err as { agentVisibleResult?: string }).agentVisibleResult ?? String(err);
    }

    expect(result).toContain('this profile was set up through a built-in provider this engine no longer has, so it cannot be renewed here. Do not ask the user for a token, and do not call api_setup fetch_token or connect for it.');
    expect(result).not.toContain('ask_secret');
    expect(result).not.toContain('consent again');
    expect(fetchSpy).not.toHaveBeenCalled();
  });



  it.each([
    ['update', 'switches to a bearer token', { type: 'bearer', vault_keys: ['SHOP_CLIENT_ID'] }],
    ['update', 'drops preset_id for its own OAuth app', { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'], oauth: {
      client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET', token_url: 'https://api.openai.com/oauth/token',
    } }],
    ['update', 'names a provider still in the register', { type: 'oauth2', oauth: {
      client_id_key: 'EXAMPLE_SHOP_CLIENT_ID', client_secret_key: 'EXAMPLE_SHOP_CLIENT_SECRET', preset_id: 'example-shop',
    } }],
    ['create', 'overwrites the same id without the provider', { type: 'bearer', vault_keys: ['SHOP_CLIENT_ID'] }],
  ] as const)('refuses a %s that %s, and leaves the stored profile as it was', async (action, _label, auth) => {
    const store = new ApiStore();
    store.register(profileNaming('gone-shop'));
    const prior = profileNaming('gone-shop');
    const reply = await apiSetupTool.handler({ action, profile: { ...prior, description: 'changed', auth: auth as ApiProfile['auth'] } }, agentWith(store)) as string;

    expect(reply).toContain('is set up through the built-in "gone-shop" provider, which this engine no longer has, and a save cannot remove or change auth.oauth.preset_id or auth.type');
    expect(reply).toContain('Nothing was saved.');
    expect(store.get('shop-api')?.auth?.oauth?.preset_id).toBe('gone-shop');
    expect(store.get('shop-api')?.description).toBe('Preset profile');
  });

  it('still saves a change that keeps the provider, in the shape such a profile has', async () => {
    const store = new ApiStore();
    store.register(profileNaming('gone-shop'));
    const reply = await apiSetupTool.handler({ action: 'update', profile: { ...profileNaming('gone-shop'), description: 'changed' } }, agentWith(store)) as string;

    expect(reply).not.toMatch(/error/i);
    expect(store.get('shop-api')?.description).toBe('changed');
    expect(store.get('shop-api')?.auth?.oauth?.preset_id).toBe('gone-shop');
  });

  it.each([
    ['an app-level exchange in place of the user\'s grant', {}],
    ['a refresh at a token_url the profile names', { grant_type: 'refresh_token', token_url: 'https://api.openai.com/oauth/token' }],
  ] as const)('refuses %s, before anything is sent', async (_label, over) => {
    const store = new ApiStore();
    const base = profileNaming('gone-shop');
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, ...over } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reply = await apiSetupTool.handler({ action: 'fetch_token', id: 'shop-api' }, agentWith(store)) as string;

    expect(reply).toContain('Error: profile "shop-api" was set up through the built-in "gone-shop" provider, which this engine no longer has, so no token is requested for it. Nothing was sent.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['with', 'https://tenant.lynox.example'],
    ['without', ''],
  ] as const)('sends connect %s a public address to the way that exists, not to an update or a fetch_token that is refused', async (_label, origin) => {
    const store = new ApiStore();
    store.register(profileNaming('gone-shop'));
    vi.stubEnv('ORIGIN', origin);
    const reply = await apiSetupTool.handler({ action: 'connect', id: 'shop-api' }, agentWith(store)) as string;

    expect(reply).toContain('Error: profile "shop-api" was set up through the built-in "gone-shop" provider, which this engine no longer has, so there is no authorization page to send the user to.');
    expect(reply).toContain('ask the user first, then delete this profile and create the new one.');
    expect(reply).not.toContain('Set auth.oauth.preset_id');
    expect(reply).not.toContain('fetch_token');
  });

  it.each([
    ['without a grant type', {}],
    ['with a refresh grant and a token_url', { grant_type: 'refresh_token', token_url: 'https://shop.example.com/oauth/token' }],
  ] as const)('answers a 401 %s with the reminder that names no renewal', async (_label, over) => {
    const store = new ApiStore();
    const base = profileNaming('gone-shop');
    store.register({
      ...base, base_url: 'https://shop.example.com/api',
      custom_endpoint_ack: { accepted: true, hosts: ['shop.example.com'], accepted_at: '2026-10-01T00:00:00.000Z' },
      auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, ...over } },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const agent = {
      principal: OWNER_PRINCIPAL,
      toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store },
      sessionCounters: { httpRequests: 0 },
      secretStore: { resolve: (n: string) => (n === 'SHOP_API_ACCESS_TOKEN' ? 'at-stale' : null) },
    } as never;
    const result = String(await httpRequestTool.handler({ url: 'https://shop.example.com/api/x', method: 'GET' }, agent));

    expect(result).toContain('**[Agent reminder: OAuth2 401, and this connection cannot be renewed here]**\nThis URL maps to api_profile "shop-api". It was set up through a built-in provider this engine no longer has, so no token is requested for it: do not call api_setup fetch_token or connect for it');
    expect(result).not.toContain('Recover with');
    expect(result).not.toContain('needs re-authorizing');
  });

  it('sends the exchange for a profile naming an id that was never shipped', async () => {
    // The control: such a profile is an app-only profile and keeps its exchange.
    const store = new ApiStore();
    store.register(appOnlyNaming('never-shipped'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const reply = await apiSetupTool.handler({ action: 'fetch_token', id: 'shop-api' }, agentWith(store)) as string;

    expect(reply).toContain('invalid_client');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
