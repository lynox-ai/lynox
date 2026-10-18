import { describe, expect, it } from 'vitest';
import { OAUTH_PRESETS, derivePresetEndpoints, presetClaimsHost, presetNotFollowed, presetRegisterOf, presetScopeRequest, presetStoreHost } from './oauth-presets.js';

const shopify = OAUTH_PRESETS.get('shopify')!;
const bexio = OAUTH_PRESETS.get('bexio')!;

const profile = (base_url: string, shop: unknown, preset_id: string | undefined = 'shopify', type = 'oauth2') => ({
  base_url,
  auth: { type, oauth: { preset_id, preset_params: { shop } } },
});

describe('the Shopify preset', () => {
  it('derives the store host and both endpoints from the shop parameter', () => {
    expect(derivePresetEndpoints('shopify', { shop: 'my-store' })).toEqual({
      host: 'my-store.myshopify.com',
      authorizeUrl: 'https://my-store.myshopify.com/admin/oauth/authorize',
      tokenUrl: 'https://my-store.myshopify.com/admin/oauth/access_token',
    });
  });

  it.each(['My-Store', '-store', 'my_store', 'my.store', 'evil.com#', 'a/b', 'store.myshopify.com'])('refuses the shop value %j', (shop) => {
    expect(derivePresetEndpoints('shopify', { shop })).toMatchObject({ kind: 'bad-param' });
  });

  it('asks for read scopes only and nothing it does not name', () => {
    expect(shopify.requiredScopes).toEqual([]);
    expect(shopify.allowedScopes.every((s) => s.startsWith('read_'))).toBe(true);
    expect(presetScopeRequest(shopify, 'read_products read_orders')).toEqual({ scopes: ['read_products', 'read_orders'] });
    expect(presetScopeRequest(shopify, 'read_products write_products')).toEqual({ refused: ['write_products'] });
    expect(presetScopeRequest(shopify, 'read_all_orders')).toEqual({ refused: ['read_all_orders'] });
  });
});

describe('presetClaimsHost', () => {
  it.each([
    ['my-store.myshopify.com', true],
    ['a.myshopify.com', true],
    ['myshopify.com', false],
    ['.myshopify.com', false],
    ['my.store.myshopify.com', false],
    ['My-Store.myshopify.com', false],
    ['my-store.myshopify.com.evil.com', false],
    ['my-store.myshopify.co', false],
    ['api.bexio.com', false],
  ] as const)('Shopify claims %s: %s', (host, want) => {
    expect(presetClaimsHost(shopify, host)).toBe(want);
  });

  it('claims no derived host for a template preset whose API is not on it', () => {
    const tenant = { ...shopify, id: 'tenant', apiOnDerivedHost: undefined };
    const register = presetRegisterOf([tenant]);
    expect(presetClaimsHost(tenant, 'my-store.myshopify.com', register)).toBe(false);
    expect(presetStoreHost(profile('https://my-store.myshopify.com', 'my-store', 'tenant'), register)).toBeNull();
  });

  it('keeps a constant preset to its apiHosts', () => {
    expect(presetClaimsHost(bexio, 'api.bexio.com')).toBe(true);
    expect(presetClaimsHost(bexio, 'auth.bexio.com')).toBe(false);
    expect(presetClaimsHost(bexio, 'my-store.myshopify.com')).toBe(false);
  });
});

describe('presetStoreHost', () => {
  it('is the derived host when the base url is https on exactly that host', () => {
    expect(presetStoreHost(profile('https://my-store.myshopify.com', 'my-store'))).toBe('my-store.myshopify.com');
    expect(presetStoreHost(profile('https://my-store.myshopify.com/admin/api/2025-10', 'my-store'))).toBe('my-store.myshopify.com');
  });

  it.each([
    ['another store', profile('https://other.myshopify.com', 'my-store')],
    ['http', profile('http://my-store.myshopify.com', 'my-store')],
    ['a port', profile('https://my-store.myshopify.com:8443', 'my-store')],
    ['credentials', profile('https://u:p@my-store.myshopify.com', 'my-store')],
    ['a password alone', profile('https://:p@my-store.myshopify.com', 'my-store')],
    ['a trailing dot', profile('https://my-store.myshopify.com.', 'my-store')],
    ['a refused shop value', profile('https://My-Store.myshopify.com', 'My-Store')],
    ['no shop value', profile('https://my-store.myshopify.com', undefined)],
    ['an unparsable base url', profile('not a url', 'my-store')],
    ['bexio', profile('https://api.bexio.com', 'my-store', 'bexio')],
    ['no preset', { base_url: 'https://my-store.myshopify.com', auth: { type: 'oauth2', oauth: { preset_params: { shop: 'my-store' } } } }],
    ['not oauth2', profile('https://my-store.myshopify.com', 'my-store', 'shopify', 'bearer')],
  ] as const)('is null for %s', (_label, p) => {
    expect(presetStoreHost(p)).toBeNull();
  });
});

describe('presetNotFollowed on a store host', () => {
  it('names Shopify for a profile on a store that does not follow it', () => {
    expect(presetNotFollowed({ base_url: 'https://my-store.myshopify.com', auth: { type: 'bearer' } })?.id).toBe('shopify');
    expect(presetNotFollowed({ base_url: 'https://my-store.myshopify.com' })?.id).toBe('shopify');
  });

  it('is undefined for a profile that follows it, and for a host no provider claims', () => {
    expect(presetNotFollowed(profile('https://my-store.myshopify.com', 'my-store'))).toBeUndefined();
    expect(presetNotFollowed({ base_url: 'https://shopify.com' })).toBeUndefined();
  });
});
