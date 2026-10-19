import { describe, it, expect, vi } from 'vitest';
import type { ApiProfile } from './api-store.js';
import type { OAuthPreset } from './oauth-presets.js';

// Two profiles of one built-in provider share a grant only when the provider derives the same
// token endpoint for both. The one provider registered today derives a fixed endpoint, so its
// profiles always agree and nothing in the real register can tell the comparison is there. This
// file adds a second provider whose endpoint depends on a parameter, next to the real one, and
// asks the predicate over it.

vi.mock('./oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./oauth-presets.js')>();
  const bexio = real.OAUTH_PRESETS.get('bexio');
  if (bexio === undefined) throw new Error('the real register no longer has bexio; rebuild this fixture');
  const tenanted: OAuthPreset = Object.freeze({
    ...bexio,
    id: 'tenanted',
    host: { kind: 'template', param: 'tenant', template: '{tenant}.auth.tenanted.example' },
    params: [{ name: 'tenant', pattern: /[a-z]+/, describe: 'the tenant name' }],
    apiHosts: ['api.tenanted.example'],
  });
  const backing = new Map<string, OAuthPreset>(real.OAUTH_PRESETS.ids().map((id) => [id, real.OAUTH_PRESETS.get(id)!] as const));
  backing.set('tenanted', tenanted);
  const register = Object.freeze({ get: (id: string) => backing.get(id), ids: () => [...backing.keys()].sort() });
  return {
    ...real,
    OAUTH_PRESETS: register,
    derivePresetEndpoints: (presetId: string, params: Readonly<Record<string, unknown>> | undefined) =>
      real.derivePresetEndpoints(presetId, params, register),
  };
});

const { slotMayReach } = await import('./profile-secret-view.js');
const { derivePresetEndpoints } = await import('./oauth-presets.js');

function tenanted(id: string, tenant: string, over: Record<string, unknown> = {}): ApiProfile {
  return {
    id, name: id, base_url: 'https://api.tenanted.example/v1', description: id,
    auth: { type: 'oauth2', oauth: { preset_id: 'tenanted', preset_params: { tenant }, grant_type: 'refresh_token', client_id_key: 'T_CID', client_secret_key: 'T_CSECRET', ...over } },
  } as ApiProfile;
}

const endpointOf = (tenant: string): string => {
  const e = derivePresetEndpoints('tenanted', { tenant });
  if ('kind' in e) throw new Error(`fixture preset refused: ${e.kind}`);
  return e.tokenUrl;
};

describe('a grant is shared only between profiles whose provider derives the same token endpoint', () => {
  it('does not let a reader whose parameters derive another endpoint exchange the owner\'s refresh token', () => {
    const owner = tenanted('tn-a', 'alpha');
    const reader = tenanted('tn-b', 'beta', { refresh_token_key: 'TN_A_REFRESH_TOKEN' });
    const store = { unreadableHolds: () => false, knownProfiles: () => [owner, reader], get: (id: string) => [owner, reader].find((p) => p.id === id) };
    // The fixture really does derive two endpoints, or this test proves nothing.
    expect(endpointOf('alpha')).not.toBe(endpointOf('beta'));
    expect(slotMayReach(store, 'TN_A_REFRESH_TOKEN', 'exchange', endpointOf('alpha'), reader)).toBe(false);
    expect(slotMayReach(store, 'TN_A_REFRESH_TOKEN', 'exchange', endpointOf('alpha'), owner)).toBe(true);
  });

  it('control: a reader of the same tenant shares the grant and exchanges at the owner\'s endpoint', () => {
    const owner = tenanted('tn-a', 'alpha');
    const reader = tenanted('tn-b', 'alpha', { refresh_token_key: 'TN_A_REFRESH_TOKEN' });
    const store = { unreadableHolds: () => false, knownProfiles: () => [owner, reader], get: (id: string) => [owner, reader].find((p) => p.id === id) };
    expect(slotMayReach(store, 'TN_A_REFRESH_TOKEN', 'exchange', endpointOf('alpha'), reader)).toBe(true);
  });
});

describe('the admission shares a refresh slot only between profiles whose provider derives the same token endpoint', () => {
  it('registers neither when the reader\'s parameters derive another endpoint, and both when they derive the same', async () => {
    const { ApiStore } = await import('./api-store.js');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const apart = new ApiStore();
    apart.register(tenanted('tn-a', 'alpha'));
    apart.register(tenanted('tn-b', 'beta', { refresh_token_key: 'TN_A_REFRESH_TOKEN' }));
    expect(apart.get('tn-a')).toBeUndefined();
    expect(apart.get('tn-b')).toBeUndefined();
    const together = new ApiStore();
    together.register(tenanted('tn-a', 'alpha'));
    together.register(tenanted('tn-b', 'alpha', { refresh_token_key: 'TN_A_REFRESH_TOKEN' }));
    expect(together.get('tn-a')).toBeDefined();
    expect(together.get('tn-b')).toBeDefined();
    vi.restoreAllMocks();
  });
});
