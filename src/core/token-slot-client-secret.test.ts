import { describe, it, expect } from 'vitest';
import type { ApiProfile } from './api-store.js';
import { clientlessSlot, slotMayReach } from './profile-secret-view.js';
import { bindingsAsMigrated } from '../../tests/helpers/vault-bindings.js';

// An access token goes only where the client secret it was minted with may go. An owner that names
// no client secret in its oauth block, or that is no longer oauth2 at all, has nothing to bind the
// token to, so the token goes nowhere. An oauth2 label without an oauth block (a legacy or
// human-driven profile, a pasted token) never had a client, and stays as it was.

const BASE = 'https://api.crm.example/v1';
const TARGET = `${BASE}/contacts`;
const SLOT = 'CRM_ACCESS_TOKEN';

const withKey: ApiProfile = {
  id: 'crm', name: 'CRM', description: 'd', base_url: BASE,
  auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://idp.crm.example/token', client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' } },
} as ApiProfile;

function oauthWith(secret: unknown): ApiProfile {
  return { ...withKey, auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { token_url: 'https://idp.crm.example/token', client_id_key: 'CRM_CLIENT_ID', client_secret_key: secret } } } as unknown as ApiProfile;
}

function storeOf(...profiles: ApiProfile[]) {
  return {
    knownProfiles: () => profiles,
    get: (id: string) => profiles.find((p) => p.id === id),
    unreadableHolds: () => false,
  };
}

function reach(store: ReturnType<typeof storeOf>, target = TARGET): boolean {
  return slotMayReach(store as never, SLOT, 'request', target, undefined, { bindings: bindingsAsMigrated(store as never), store: null, read: null });
}

describe('an access token goes nowhere without the client secret it was minted with (901 D)', () => {
  it('control: an owner with its client secret, bound to its base, sends its token there', () => {
    expect(reach(storeOf(withKey))).toBe(true);
  });

  it('control: an owner with its client secret still sends nothing to another host', () => {
    expect(reach(storeOf(withKey), 'https://collector.example.org/x')).toBe(false);
  });

  it.each([
    ['no client_secret_key', oauthWith(undefined)],
    ['an empty client_secret_key', oauthWith('')],
    ['a client_secret_key that is not text', oauthWith(42)],
  ])('refuses an owner whose oauth block has %s', (_label, owner) => {
    expect(reach(storeOf(owner))).toBe(false);
  });

  it('leaves an oauth2 label without an oauth block as it was: a pasted token still reaches the base', () => {
    const legacy = { ...withKey, auth: { type: 'oauth2', vault_keys: [SLOT] } } as ApiProfile;
    expect(reach(storeOf(legacy))).toBe(true);
    expect(reach(storeOf(legacy), 'https://collector.example.org/x')).toBe(false);
  });

  it('refuses an owner that is no longer oauth2 but still holds the slot through what its exchange wrote', () => {
    const bearer = {
      id: 'crm', name: 'CRM', description: 'd', base_url: BASE,
      auth: { type: 'bearer', vault_keys: ['CRM_KEY'] },
      oauth_grant: { written: [{ name: SLOT, fp: 'fp-a' }] },
    } as unknown as ApiProfile;
    expect(reach(storeOf(bearer))).toBe(false);
  });
});

describe('clientlessSlot names the owner and the cause, for the refusal (901 D)', () => {
  it('names an oauth block without a client secret, and an owner that is no longer oauth2', () => {
    expect(clientlessSlot(storeOf(oauthWith(undefined)), SLOT)).toEqual({ owner: 'crm', why: 'no_client_secret' });
    const bearer = { ...withKey, auth: { type: 'bearer', vault_keys: ['CRM_KEY'] }, oauth_grant: { written: [{ name: SLOT, fp: 'f' }] } } as unknown as ApiProfile;
    expect(clientlessSlot(storeOf(bearer), SLOT)).toEqual({ owner: 'crm', why: 'not_oauth2' });
  });

  it('answers null for an owner with its client secret, a legacy label, a free name and a refresh slot', () => {
    expect(clientlessSlot(storeOf(withKey), SLOT)).toBeNull();
    expect(clientlessSlot(storeOf({ ...withKey, auth: { type: 'oauth2', vault_keys: [SLOT] } } as ApiProfile), SLOT)).toBeNull();
    expect(clientlessSlot(storeOf(withKey), 'SOMETHING_ELSE')).toBeNull();
    expect(clientlessSlot(storeOf(oauthWith(undefined)), 'CRM_REFRESH_TOKEN')).toBeNull();
  });

  it('answers null for a slot a profile whose names cannot be read may hold: the owner it would name is not sure', () => {
    const store = { ...storeOf(oauthWith(undefined)), unreadableHolds: (n: string) => n === SLOT };
    expect(clientlessSlot(storeOf(oauthWith(undefined)), SLOT)).not.toBeNull();
    expect(clientlessSlot(store, SLOT)).toBeNull();
  });
});
