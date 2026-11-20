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
    isPresetClientSecretName: (name: string) => real.isPresetClientSecretName(name, register),
    OAUTH_PRESETS: register,
    RETIRED_PRESET_IDS: retired,
  };
});

const { apiSetupTool } = await import('./api-setup.js');
const { declinedFacts, oauthGrantIsUserDelegated } = await import('./http.js');
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

  it('names the provider as the reason a refused renewal was refused', () => {
    expect(declinedFacts(profileNaming('gone-shop'), 'empty')[0]).toEqual({ kind: 'consent', consent: 'preset', preset: 'gone-shop' });
    expect(declinedFacts(appOnlyNaming('never-shipped'), 'empty')[0]).toEqual({ kind: 'consent', consent: 'none', preset: undefined });
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
