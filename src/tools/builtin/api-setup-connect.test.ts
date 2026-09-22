import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

// The register ships empty on purpose, so every test that needs a provider
// hands in its own — through the same parameter production never passes.
vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const register = real.presetRegisterOf([{
    id: 'example-shop',
    label: 'Example Shop',
    host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
  }]);
  return {
    ...real,
    derivePresetEndpoints: (id: string, params: Readonly<Record<string, unknown>> | undefined) =>
      real.derivePresetEndpoints(id, params, register),
    presetIds: () => register.ids(),
  };
});

const tmpDirs: string[] = [];
let originBefore: string | undefined;

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-connect-test-'));
  tmpDirs.push(mockLynoxDir);
  originBefore = process.env['ORIGIN'];
  process.env['ORIGIN'] = 'https://tenant.lynox.example';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originBefore === undefined) delete process.env['ORIGIN'];
  else process.env['ORIGIN'] = originBefore;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shopProfile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'shop-api',
    name: 'Shop',
    base_url: 'https://acme.shops.example.com/admin',
    description: 'Shop API',
    auth: {
      type: 'oauth2',
      vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'],
      oauth: {
        grant_type: 'refresh_token',
        client_id_key: 'SHOP_CLIENT_ID',
        client_secret_key: 'SHOP_CLIENT_SECRET',
        preset_id: 'example-shop',
        preset_params: { shop: 'acme' },
      },
    },
    ...over,
  };
}

function agentWith(store: ApiStore, secrets: Record<string, string> = { SHOP_CLIENT_ID: 'id', SHOP_CLIENT_SECRET: 'secret' }): never {
  return {
    sessionCounters: { httpRequests: 0, approvedOutboundDomains: new Set<string>(), pendingOutboundPrompts: new Map<string, unknown>() },
    secretStore: {
      resolveSecretRefs: (input: unknown): unknown => {
        const text = JSON.stringify(input);
        return JSON.parse(text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, name: string) => secrets[name] ?? m)) as unknown;
      },
    },
    toolContext: { apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
  } as never;
}

const connect = (agent: never, id = 'shop-api'): Promise<string> =>
  apiSetupTool.handler({ action: 'connect', id }, agent) as Promise<string>;

describe('api_setup connect — one answer per shape that can reach it', () => {
  it('A1 · says the web interface is needed when the engine runs without one', async () => {
    delete process.env['ORIGIN'];
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('connecting needs the web interface');
    expect(result).not.toContain('https://tenant.lynox.example');
  });

  it('A2 · refuses an id it does not know', async () => {
    const result = await connect(agentWith(new ApiStore()), 'nope');
    expect(result).toContain('not found');
  });

  it('A3 · refuses a profile that carries a static credential', async () => {
    const store = new ApiStore();
    store.register({ ...shopProfile(), auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] } });

    const result = await connect(agentWith(store));

    expect(result).toContain('not "oauth2"');
    expect(result).toContain('does not need it');
  });

  it('A4 · refuses a profile that names no built-in provider, and says what exists', async () => {
    const store = new ApiStore();
    const base = shopProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, preset_id: 'not-a-provider' } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('names no built-in provider');
    expect(result).toContain('example-shop');
    expect(result).not.toContain('https://tenant.lynox.example/api/oauth/connect');
  });

  it('A4b · names the missing parameter rather than building half a host', async () => {
    const store = new ApiStore();
    const base = shopProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, preset_params: {} } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('the shop name');
    expect(result).toContain('preset_params.shop');
  });

  it('A5 · sends the model to ask_secret when the client credentials are missing', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store, { SHOP_CLIENT_ID: 'id' }));

    expect(result).toContain('ask_secret');
    expect(result).toContain('SHOP_CLIENT_SECRET');
    expect(result).not.toContain('/api/oauth/connect/');
  });

  it('A6 · says a second authorization replaces the stored token', async () => {
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { origin: 'callback', state: 'connected' } }));

    const result = await connect(agentWith(store));

    expect(result).toContain('already connected');
    expect(result).toContain('replaces the stored token');
    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
  });

  it('A7 · says the old access is gone when the provider ended it', async () => {
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { state: 'revoked', revoked_fp: '0123456789abcdef' } }));

    const result = await connect(agentWith(store));

    expect(result).toContain('ended this authorization');
    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
  });

  it('A8 · hands out the link, names the provider host, and forbids the two wrong turns', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(result).toContain('acme.shops.example.com');
    // The two things a model does when left to itself: ask for a pasted token,
    // or assemble the link. Both are said in the reply, because the reply is
    // the only place it reads.
    expect(result).toContain('do not ask them to paste a token');
    expect(result).toContain('do not build this link yourself');
  });

  it('builds one link, whether or not the origin carries a trailing slash', async () => {
    process.env['ORIGIN'] = 'https://tenant.lynox.example/';
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(result).not.toContain('example.com//api');
    expect(result).not.toContain('example//api');
  });

  it('carries no secret and no state into the link', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));
    const link = /https:\/\/tenant\.lynox\.example\S*/.exec(result)?.[0] ?? '';

    expect(link).toBe('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(link).not.toContain('?');
    expect(result).not.toContain('secret');
  });
});
