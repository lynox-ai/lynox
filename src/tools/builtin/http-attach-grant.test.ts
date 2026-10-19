import { describe, expect, it } from 'vitest';
import { accessTokenKey, ApiStore, type ApiProfile } from '../../core/api-store.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';
import { attachStoredCredential } from './http.js';

// PRD connection-attribution A7: `attachStoredCredential` returns the profile whose credential it
// attached — read when the credential was — and null for every other answer.

const TOKEN = 'crm-access-value';

function crmProfile(grantId: string): ApiProfile {
  return {
    id: 'crm', name: 'CRM', base_url: 'https://api.crm.example/v1', description: 'stub',
    auth: { type: 'oauth2', oauth: { client_id_key: 'C_CID', client_secret_key: 'C_CSECRET' } },
    custom_endpoint_ack: { accepted: true, hosts: ['api.crm.example'], accepted_at: '2026-10-19T00:00:00.000Z' },
    oauth_grant: { grant_id: grantId },
  } as ApiProfile;
}

async function attach(store: ApiStore, url: string): Promise<{ attached: ApiProfile | null; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  const attached = await attachStoredCredential(url, headers, false, {
    apiStore: store,
    secretStore: { resolve: (n: string) => (n === accessTokenKey('crm') ? TOKEN : null) } as never,
    principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined, vaultNameBindings: bindingsAsMigrated(store),
  }, { bulkRunId: 'run-1' });
  return { attached, headers };
}

describe('attachStoredCredential returns the profile it attached', () => {
  it('the profile and its grant, when the credential is attached', async () => {
    const store = new ApiStore();
    expect(store.register(crmProfile('g1'))).toBe(true);
    const { attached, headers } = await attach(store, 'https://api.crm.example/v1/contacts');
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(attached?.id).toBe('crm');
    expect(attached?.oauth_grant?.grant_id).toBe('g1');
  });

  it('null, not a profile, when nothing is attached: the request goes to a host no profile holds', async () => {
    const store = new ApiStore();
    expect(store.register(crmProfile('g1'))).toBe(true);
    const { attached, headers } = await attach(store, 'https://api.other.example/v1/contacts');
    expect(headers).toEqual({});
    expect(attached).toBeNull();
  });

  it('null when the attach refuses: an oauth2 profile with no stored token', async () => {
    const store = new ApiStore();
    expect(store.register({ ...crmProfile('g1'), id: 'crm-empty' } as ApiProfile)).toBe(true);
    const { attached, headers } = await attach(store, 'https://api.crm.example/v1/contacts');
    expect(headers).toEqual({});
    expect(attached).toBeNull();
  });

  it('the profile as the store holds it when the token is read, not as the attach first found it', async () => {
    // What a renewal that saved the profile (or an exchange that minted) leaves behind: the store
    // now answers a newer copy. The attach re-reads it after the renewal, before the token.
    const store = new ApiStore();
    expect(store.register(crmProfile('g1'))).toBe(true);
    const renewed = Object.create(store) as ApiStore;
    renewed.get = (id: string) => (id === 'crm' ? crmProfile('g2') : store.get(id));
    const { attached } = await attach(renewed, 'https://api.crm.example/v1/contacts');
    expect(attached?.oauth_grant?.grant_id).toBe('g2');
  });
});
