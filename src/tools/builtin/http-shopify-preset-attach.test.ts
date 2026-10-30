import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

// What the attach does for a Shopify preset profile once the store is reachable. Today the attach
// refuses every store first (`core/shopify-host.ts`); this file switches that one check off to
// reach the code behind it. That the check holds for a preset profile is tested where it is not
// switched off (`http-shopify-preset-block.test.ts`).
vi.mock('../../core/shopify-host.js', async (importActual) => ({
  ...(await importActual<typeof import('../../core/shopify-host.js')>()),
  isShopifyAdminUrl: () => false,
}));

const { attachStoredCredential, httpRequestTool } = await import('./http.js');

const TOKEN = 'shpat-store-value';

const STORE_PATH_REFUSAL = 'Error: api_profile "shop-acme" is the connection of a Shopify store, and its token goes only to the store\'s API: paths under /admin/, with no encoded slash or backslash (%2F, %5C) in the path. '
  + 'This request goes to another path on the store, so nothing was sent. Other paths there are served by others than the store\'s API (an app\'s pages under /apps/, for example), '
  + 'and lynox does not send the store\'s token to them. Do not retry it, and do not set a credential yourself; make the request to the API path for what you need.';

function shopProfile(base: string, shop: string, over: Record<string, unknown> = {}): ApiProfile {
  const host = new URL(base).hostname;
  return {
    id: 'shop-acme', name: 'Acme', base_url: base, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET', ...over } },
    custom_endpoint_ack: { accepted: true, hosts: [host], accepted_at: '2026-10-18T00:00:00.000Z' },
  } as ApiProfile;
}

async function attach(url: string, profile: ApiProfile): Promise<{ attached: Awaited<ReturnType<typeof attachStoredCredential>>; headers: Record<string, string>; read: string[] }> {
  const store = new ApiStore();
  expect(store.register(profile)).toBe(true);
  const headers: Record<string, string> = {};
  const read: string[] = [];
  const attached = await attachStoredCredential(url, headers, false, {
    apiStore: store,
    secretStore: { resolve: (n: string) => { read.push(n); return n === accessTokenKey(profile.id) ? TOKEN : null; } } as never,
    principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined, vaultNameBindings: bindingsAsMigrated(store),
  }, { bulkRunId: 'run-1' });
  return { attached, headers, read };
}

/** One `http_request` from a chat, through the tool's handler: the answer the model reads. */
async function chatRequest(url: string, profile: ApiProfile | null, method = 'GET'): Promise<string> {
  const store = new ApiStore();
  if (profile !== null) expect(store.register(profile)).toBe(true);
  const vault: Record<string, string> = { [accessTokenKey('shop-acme')]: TOKEN };
  const agent = {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore: { resolve: (n: string) => vault[n] ?? null, resolveSecretRefs: (x: unknown) => x, listNames: () => Object.keys(vault) },
    promptUser: async () => 'Allow',
    getAvailableTools: () => [{ definition: { name: 'http_request' } }],
    toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, vaultNameBindings: bindingsAsMigrated(store), userConfig: {}, tools: [], allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
  };
  try {
    return String(await httpRequestTool.handler({ url, method }, agent as never));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('a Shopify preset profile behind the store check', () => {
  it('sends the token bare in the provider\'s own header, not as Bearer', async () => {
    const { headers } = await attach('https://acme.myshopify.com/admin/api/2025-10/shop.json', shopProfile('https://acme.myshopify.com', 'acme'));
    expect(headers['X-Shopify-Access-Token']).toBe(TOKEN);
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')).toBe(false);
  });

  it('attaches nothing when the base names another store than the parameter', async () => {
    const { headers } = await attach('https://other.myshopify.com/admin/api/2025-10/shop.json', shopProfile('https://other.myshopify.com', 'acme'));
    expect(headers).toEqual({});
  });

  it('reads no vault value, and attaches nothing, when the base is re-pointed off the store', async () => {
    const { headers, read } = await attach('https://evil.example.com/admin/api/2025-10/shop.json', shopProfile('https://evil.example.com', 'acme'));
    expect(read).toEqual([]);
    expect(headers).toEqual({});
  });

  it('reads the token when the base is on the store (control for the case above)', async () => {
    const { read } = await attach('https://acme.myshopify.com/admin/api/2025-10/shop.json', shopProfile('https://acme.myshopify.com', 'acme'));
    expect(read).toContain(accessTokenKey('shop-acme'));
  });

  it.each([
    ['an app proxy path', 'https://acme.myshopify.com/apps/some-app/x'],
    ['the storefront', 'https://acme.myshopify.com/products/x'],
    ['admin without its slash', 'https://acme.myshopify.com/admin'],
    ['a path that climbs out of admin', 'https://acme.myshopify.com/admin/../apps/x'],
    ['admin in other case', 'https://acme.myshopify.com/ADMIN/api/2025-10/shop.json'],
    ['an encoded climb out of admin', 'https://acme.myshopify.com/admin/%2E%2E%2Fapps/x'],
    ['an encoded climb in lower case', 'https://acme.myshopify.com/admin/..%2fapps/x'],
    ['an encoded backslash', 'https://acme.myshopify.com/admin/..%5Capps/x'],
  ])('attaches nothing to %s of the store', async (_label, url) => {
    const { headers } = await attach(url, shopProfile('https://acme.myshopify.com', 'acme'));
    expect(headers).toEqual({});
  });

  // What the model reads in a chat: the general text says the token goes "to its base_url", and
  // these paths are on the base.
  it.each([
    ['an app proxy path', 'https://acme.myshopify.com/apps/some-app/x'],
    ['admin without its slash', 'https://acme.myshopify.com/admin'],
    ['admin in other case', 'https://acme.myshopify.com/ADMIN/api/2025-10/shop.json'],
    ['an encoded climb out of admin', 'https://acme.myshopify.com/admin/..%2fapps/x'],
    ['an encoded backslash', 'https://acme.myshopify.com/admin/..%5Capps/x'],
  ])('tells a chat that the store\'s token goes to its API paths only, for %s', async (_label, url) => {
    expect(await chatRequest(url, shopProfile('https://acme.myshopify.com', 'acme'))).toBe(STORE_PATH_REFUSAL);
  });

  it('keeps the reason a store\'s /admin/ path is refused for, which is not the path', async () => {
    // Its OAuth names no client secret, so its token goes nowhere: that is said, not the path.
    const answer = await chatRequest('https://acme.myshopify.com/admin/api/2025-10/shop.json', shopProfile('https://acme.myshopify.com', 'acme', { client_secret_key: undefined }));
    expect(answer).toContain('its OAuth settings name no client secret');
    expect(answer).not.toContain('paths under /admin/');
  });
});

// A store host counts as the store provider's while the exchange is on (`providerNotFollowed`).
describe('a write to a store, while the store exchange is on', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('with no profile on the store, is pointed at the preset with its parameter', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
    const answer = await chatRequest('https://acme.myshopify.com/admin/api/2025-10/products.json', null, 'POST');
    expect(answer).toContain('writes to Shopify, which goes through this engine\'s built-in "shopify" provider');
    expect(answer).toContain('auth.oauth.preset_id "shopify" and auth.oauth.preset_params {"shop": "<shop>"}');
  });

  it('with no profile on the store, is not pointed at the preset while the exchange is off', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '0');
    const answer = await chatRequest('https://acme.myshopify.com/admin/api/2025-10/products.json', null, 'POST');
    expect(answer).not.toContain('built-in "shopify" provider');
  });

  const pasted = { id: 'shop-pasted', name: 'Shop', base_url: 'https://acme.myshopify.com', description: 'stub', auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] }, custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' } } as ApiProfile;
  const writeThrough = async (profile: ApiProfile): Promise<Record<string, string>> => {
    const store = new ApiStore();
    expect(store.register(profile)).toBe(true);
    const headers: Record<string, string> = {};
    await attachStoredCredential('https://acme.myshopify.com/admin/api/2025-10/products.json', headers, true, {
      apiStore: store, secretStore: { resolve: (n: string) => (n === 'SHOP_TOKEN' ? TOKEN : null) } as never,
      principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined, vaultNameBindings: bindingsAsMigrated(store),
    }, { bulkRunId: 'run-1' });
    return headers;
  };

  it('through a profile with a pasted token, sends nothing', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
    expect(await writeThrough(pasted)).toEqual({});
  });

  it('through a profile with a pasted token, attaches it while the exchange is off (control)', async () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '0');
    expect(Object.values(await writeThrough(pasted))).toContain(`Bearer ${TOKEN}`);
  });


  it('attaches nothing to another port of the store', async () => {
    const { headers } = await attach('https://acme.myshopify.com:8443/admin/api/2025-10/shop.json', shopProfile('https://acme.myshopify.com', 'acme'));
    expect(headers).toEqual({});
  });

  it('attaches nothing over http to the store', async () => {
    const { headers } = await attach('http://acme.myshopify.com/admin/api/2025-10/shop.json', shopProfile('https://acme.myshopify.com', 'acme'));
    expect(headers).toEqual({});
  });

  it('keeps refusing a header the profile names itself', async () => {
    const p = shopProfile('https://acme.myshopify.com', 'acme');
    const { headers } = await attach('https://acme.myshopify.com/admin/api/2025-10/shop.json', { ...p, auth: { ...p.auth!, header_name: 'X-Other-Token' } } as ApiProfile);
    expect(headers).toEqual({});
  });
});
