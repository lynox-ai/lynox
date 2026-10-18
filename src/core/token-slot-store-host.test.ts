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

  it('sends nothing to a base that names another store than its parameter', () => {
    const astray = shop('sh-d', 'alpha', 'https://beta.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN', access_token_key: 'SH_A_ACCESS_TOKEN' });
    expect(slotMayReach(storeOf([owner, astray]), 'SH_A_ACCESS_TOKEN', 'request', 'https://beta.myshopify.com/x', owner)).toBe(false);
  });
});

describe('the admission of two profiles that name one refresh slot', () => {
  it('registers the second when both are of one store, and not when it is of another', async () => {
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

  it('does not register a second whose base names another store than its parameter', async () => {
    const { ApiStore } = await import('./api-store.js');
    const { vi } = await import('vitest');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const store = new ApiStore();
    store.register(shop('sh-a', 'alpha'));
    store.register(shop('sh-d', 'alpha', 'https://beta.myshopify.com', { refresh_token_key: 'SH_A_REFRESH_TOKEN' }));
    expect(store.get('sh-d')).toBeUndefined();
  });
});

describe('a store profile\'s own token on a base outside its store', () => {
  it('reaches neither that base nor the store', () => {
    // Re-pointed after it was connected: its parameter still names the store, its base does not.
    const moved = shop('sh-e', 'alpha', 'https://evil.example.com');
    const s = storeOf([moved]);
    expect(slotMayReach(s, 'SH_E_ACCESS_TOKEN', 'request', 'https://evil.example.com/x', moved)).toBe(false);
    expect(slotMayReach(s, 'SH_E_ACCESS_TOKEN', 'request', 'https://alpha.myshopify.com/x', moved)).toBe(false);
  });

  it('reaches no host named null when it has no store host', () => {
    const astray = shop('sh-e', 'alpha', 'https://null');
    expect(slotMayReach(storeOf([astray]), 'SH_E_ACCESS_TOKEN', 'request', 'https://null/x', astray)).toBe(false);
  });

  it('reaches the store\'s admin path only', () => {
    const home = shop('sh-e', 'alpha');
    expect(slotMayReach(storeOf([home]), 'SH_E_ACCESS_TOKEN', 'request', 'https://alpha.myshopify.com/apps/x', home)).toBe(false);
  });

  it('reaches the store while the base is on it', () => {
    const home = shop('sh-e', 'alpha');
    expect(slotMayReach(storeOf([home]), 'SH_E_ACCESS_TOKEN', 'request', 'https://alpha.myshopify.com/admin/api/2025-10/shop.json', home)).toBe(true);
  });
});
