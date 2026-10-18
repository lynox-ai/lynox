import { describe, expect, it } from 'vitest';
import type { ApiProfile } from './api-store.js';
import { slotMayReach } from './profile-secret-view.js';

// Shopify's API runs on the store's own host, which the preset derives from `shop`. Two profiles
// of one store share its grant; a shared grant's access token goes to that store's host only.

function shop(id: string, store: string, base = `https://${store}.myshopify.com/admin/api/2025-10`, over: Record<string, unknown> = {}): ApiProfile {
  return {
    id, name: id, base_url: base, description: id,
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: store }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET', ...over } },
  } as ApiProfile;
}

const storeOf = (profiles: ApiProfile[]) => ({
  unreadableHolds: () => false,
  knownProfiles: () => profiles,
  get: (id: string) => profiles.find((p) => p.id === id),
});

describe('a Shopify grant shared by two profiles of one store', () => {
  const owner = shop('sh-a', 'alpha');
  const reader = shop('sh-b', 'alpha', 'https://alpha.myshopify.com/admin/api/2026-01', { refresh_token_key: 'SH_A_REFRESH_TOKEN', access_token_key: 'SH_A_ACCESS_TOKEN' });

  it('sends the access token to the store\'s own host', () => {
    expect(slotMayReach(storeOf([owner, reader]), 'SH_A_ACCESS_TOKEN', 'request', 'https://alpha.myshopify.com/admin/api/2025-10/shop.json', owner)).toBe(true);
  });

  it('sends it to no other store and to no other host', () => {
    const s = storeOf([owner, reader]);
    expect(slotMayReach(s, 'SH_A_ACCESS_TOKEN', 'request', 'https://beta.myshopify.com/admin/api/2025-10/shop.json', owner)).toBe(false);
    expect(slotMayReach(s, 'SH_A_ACCESS_TOKEN', 'request', 'https://alpha.myshopify.com:8443/x', owner)).toBe(false);
    expect(slotMayReach(s, 'SH_A_ACCESS_TOKEN', 'request', 'http://alpha.myshopify.com/x', owner)).toBe(false);
  });

  it('does not send one store\'s token to another store whose profile names its slots', () => {
    const other = shop('sh-c', 'beta', 'https://beta.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN', access_token_key: 'SH_A_ACCESS_TOKEN' });
    // Two stores derive two token endpoints, so the second profile does not join the grant.
    expect(slotMayReach(storeOf([owner, other]), 'SH_A_ACCESS_TOKEN', 'request', 'https://beta.myshopify.com/x', other)).toBe(false);
  });

  it('shares nothing with a profile whose base names another store than its parameter', () => {
    const astray = shop('sh-d', 'alpha', 'https://beta.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN', access_token_key: 'SH_A_ACCESS_TOKEN' });
    expect(slotMayReach(storeOf([owner, astray]), 'SH_A_ACCESS_TOKEN', 'request', 'https://beta.myshopify.com/x', owner)).toBe(false);
  });
});

describe('the admission of two profiles that name one refresh slot', () => {
  it('registers both when they are of one store, and neither when they are of two', async () => {
    const { ApiStore } = await import('./api-store.js');
    const { vi } = await import('vitest');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const together = new ApiStore();
    together.register(shop('sh-a', 'alpha'));
    together.register(shop('sh-b', 'alpha', 'https://alpha.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN' }));
    expect(together.get('sh-a')).toBeDefined();
    expect(together.get('sh-b')).toBeDefined();
    const apart = new ApiStore();
    apart.register(shop('sh-a', 'alpha'));
    apart.register(shop('sh-b', 'beta', 'https://beta.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN' }));
    expect(apart.get('sh-b')).toBeUndefined();
  });
});
