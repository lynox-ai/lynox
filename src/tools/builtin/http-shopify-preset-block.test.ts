import { describe, expect, it } from 'vitest';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { fetchPinned } from '../../core/network-guard.js';
import { derivePresetEndpoints } from '../../core/oauth-presets.js';
import { exchangeToken, isTokenEndpointRefused, vetTokenEndpoint } from '../../core/oauth-token-exchange.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { SHOPIFY_UNAVAILABLE } from '../../core/shopify-host.js';
import { attachStoredCredential } from './http.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

// The Shopify preset adds a way to connect a store, and the store stays closed until a pass for
// it exists: a connected preset profile, its own store and its own token endpoint are refused at
// the attach, at the token exchange and at the pinned fetch under both, exactly as any other
// request to a store is. (The fourth site, a secret named in a store's host, does not depend on
// a profile and is tested where it lives, in `agent.ts`'s tests.)

const STORE = 'https://acme.myshopify.com';
const endpoints = derivePresetEndpoints('shopify', { shop: 'acme' });
if ('kind' in endpoints) throw new Error(`the Shopify preset no longer derives a store: ${endpoints.kind}`);

const profile: ApiProfile = {
  id: 'shop-acme', name: 'Acme', base_url: STORE, description: 'stub',
  auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'S_CID', client_secret_key: 'S_CSECRET' } },
  oauth_grant: { origin: 'callback', state: 'no-refresh' },
  custom_endpoint_ack: { accepted: true, hosts: ['acme.myshopify.com'], redirect_hosts: ['acme.myshopify.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
} as ApiProfile;

describe('a connected Shopify preset profile is still refused', () => {
  it('at the attach: its token goes nowhere', async () => {
    const store = new ApiStore();
    expect(store.register(profile)).toBe(true);
    const headers: Record<string, string> = {};
    const attached = await attachStoredCredential(`${STORE}/admin/api/2025-10/shop.json`, headers, false, {
      apiStore: store,
      secretStore: { resolve: (n: string) => (n === accessTokenKey(profile.id) ? 'shpat-value' : null) } as never,
      principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined, vaultNameBindings: bindingsAsMigrated(store),
    }, { bulkRunId: 'run-1' });
    expect(attached).toBeNull();
    expect(headers).toEqual({});
  });

  it('at the token exchange: its client secret goes nowhere', async () => {
    const vetted = vetTokenEndpoint(endpoints.tokenUrl, profile.custom_endpoint_ack);
    if (isTokenEndpointRefused(vetted)) throw new Error('fixture endpoint is not vetted');
    const result = await exchangeToken({ endpoint: vetted, params: { client_secret: 's' }, bodyFormat: 'form' }, undefined);
    expect(result).toEqual({ ok: false, message: `token exchange refused: ${SHOPIFY_UNAVAILABLE}` });
  });

  it('at the pinned fetch under both', async () => {
    await expect(fetchPinned(`${STORE}/admin/api/2025-10/shop.json`)).rejects.toThrow(SHOPIFY_UNAVAILABLE);
    await expect(fetchPinned(endpoints.tokenUrl, { method: 'POST' })).rejects.toThrow(SHOPIFY_UNAVAILABLE);
  });
});
