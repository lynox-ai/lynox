import { describe, expect, it, vi } from 'vitest';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';

// What the attach does for a Shopify preset profile once the store is reachable. Today the attach
// refuses every store first (`core/shopify-host.ts`); this file switches that one check off to
// reach the code behind it. That the check holds for a preset profile is tested where it is not
// switched off (`http-shopify-preset-block.test.ts`).
vi.mock('../../core/shopify-host.js', async (importActual) => ({
  ...(await importActual<typeof import('../../core/shopify-host.js')>()),
  isShopifyAdminUrl: () => false,
}));

const { attachStoredCredential } = await import('./http.js');

const TOKEN = 'shpat-store-value';

function shopProfile(base: string, shop: string, over: Record<string, unknown> = {}): ApiProfile {
  const host = new URL(base).hostname;
  return {
    id: 'shop-acme', name: 'Acme', base_url: base, description: 'stub',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET', ...over } },
    custom_endpoint_ack: { accepted: true, hosts: [host], accepted_at: '2026-10-18T00:00:00.000Z' },
  } as ApiProfile;
}

async function attach(url: string, profile: ApiProfile): Promise<{ attached: boolean; headers: Record<string, string>; read: string[] }> {
  const store = new ApiStore();
  expect(store.register(profile)).toBe(true);
  const headers: Record<string, string> = {};
  const read: string[] = [];
  const attached = await attachStoredCredential(url, headers, false, {
    apiStore: store,
    secretStore: { resolve: (n: string) => { read.push(n); return n === accessTokenKey(profile.id) ? TOKEN : null; } } as never,
    principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined,
  }, { bulkRunId: 'run-1' });
  return { attached, headers, read };
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
