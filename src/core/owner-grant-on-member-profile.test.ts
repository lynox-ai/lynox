import { describe, it, expect } from 'vitest';
import { profileForReader, secretsForProfile, type ReadCtx } from './profile-secret-view.js';
import { accessTokenKey, ownerConnectionCarries, type ApiProfile } from './api-store.js';
import type { SecretStoreLike } from '../types/index.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

// An owner's connection made on a profile a person with access set up, before the owner's connect
// was refused there: the profile's view hides its tokens from every reader, the owner included.
// It is shown as no connection and no read through the profile uses it, until the owner takes the profile over (the
// owner's save drops `created_by`); from then on it carries.
const M = 'mandate:setup@example.org';
const TOKEN = accessTokenKey('crm-api');
const VALUES: Record<string, string> = { [TOKEN]: 'owners-token' };

function vault(): SecretStoreLike {
  return {
    resolve: (n: string) => VALUES[n] ?? null,
    extractSecretNames: () => [],
    resolveSecretRefs: (input: unknown) => input,
    isEnvironmentSecret: () => false,
    listNames: () => Object.keys(VALUES),
  } as unknown as SecretStoreLike;
}

const crm = (created_by?: string): ApiProfile => ({
  id: 'crm-api', name: 'CRM', base_url: 'https://crm.example/v1', description: 'd',
  auth: { type: 'oauth2', oauth: { token_url: 'https://crm.example/oauth/token', client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' } },
  oauth_grant: { origin: 'callback', state: 'connected', connected_by: 'owner' },
  ...(created_by === undefined ? {} : { created_by }),
} as ApiProfile);

const OWNER_READS: ReadCtx = { principal: OWNER_PRINCIPAL, ends: { isLive: (id) => id === 'M-1' }, releases: null };

describe('an owner\'s connection on a profile a person with access set up', () => {
  it('is said to be unused, and no read through the profile reaches its token', () => {
    const p = crm(M);
    expect(ownerConnectionCarries(p)).toBe(false);
    expect(profileForReader(p, OWNER_PRINCIPAL).oauth_grant?.unused).toBe(true);
    const apis = { knownProfiles: () => [p] };
    expect(secretsForProfile(vault(), p, apis, OWNER_READS).resolve(TOKEN)).toBeNull();
  });

  it('carries once the owner has taken the profile over', () => {
    const p = crm();
    expect(ownerConnectionCarries(p)).toBe(true);
    expect(profileForReader(p, OWNER_PRINCIPAL).oauth_grant?.unused).toBeUndefined();
    const apis = { knownProfiles: () => [p] };
    expect(secretsForProfile(vault(), p, apis, OWNER_READS).resolve(TOKEN)).toBe('owners-token');
  });

  it('control: the author\'s own connection on that profile is not said to be unused', () => {
    const p = { ...crm(M), oauth_grant: { origin: 'callback', state: 'connected', connected_by: M, connected_mandate_id: 'M-1' } } as ApiProfile;
    expect(profileForReader(p, OWNER_PRINCIPAL).oauth_grant?.unused).toBeUndefined();
  });
});
