import { describe, it, expect } from 'vitest';
import { secretsForProfile } from './profile-secret-view.js';
import type { ApiProfile } from './api-store.js';
import type { SecretStoreLike } from '../types/index.js';

// PRD customer-granted-operator-access §3.13 (H2): the vault as the engine reads it for a
// profile a mandate wrote. The owner's profile is the control each time.
const VALUES: Record<string, string> = { SETUP_KEY: 'stored-by-setup', ENV_KEY: 'from-the-environment', SHOP_API_ACCESS_TOKEN: 'shop-token' };
const ENV = new Set(['ENV_KEY']);

function store(over: Partial<SecretStoreLike> = {}): SecretStoreLike {
  const refs = (input: unknown): string[] => [...JSON.stringify(input).matchAll(/secret:([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!);
  return {
    resolve: (n: string) => VALUES[n] ?? null,
    extractSecretNames: refs,
    resolveSecretRefs: (input: unknown) => JSON.parse(JSON.stringify(input).replace(/secret:([A-Z_][A-Z0-9_]*)/g, (m, n: string) => VALUES[n] ?? m)) as unknown,
    isEnvironmentSecret: (n: string) => ENV.has(n),
    listNames: () => Object.keys(VALUES),
    ...over,
  } as unknown as SecretStoreLike;
}

const preset: ApiProfile = {
  id: 'shop-api', name: 'Shop', base_url: 'https://shop.example/admin', description: 'd',
  auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'], oauth: { preset_id: 'example-shop', client_id_key: 'SHOP_CLIENT_ID' } },
};
const own = (created_by?: string): ApiProfile => ({
  id: 'crm-api', name: 'CRM', base_url: 'https://crm.example/v1', description: 'd',
  auth: { type: 'bearer', vault_keys: ['SETUP_KEY'] },
  ...(created_by === undefined ? {} : { created_by }),
});
const apiStore = { getAll: () => [preset] };
const M = 'mandate:setup@example.org';

describe('secretsForProfile', () => {
  it('hands a profile the owner wrote the store itself', () => {
    const s = store();
    expect(secretsForProfile(s, own(), apiStore)).toBe(s);
    expect(secretsForProfile(s, own('owner'), apiStore)).toBe(s);
  });

  it('a profile a mandate wrote does not get a value from the environment', () => {
    const view = secretsForProfile(store(), own(M), apiStore);
    expect(view.resolve('ENV_KEY')).toBeNull();
    expect(view.resolveSecretRefs({ _: 'secret:ENV_KEY' })).toEqual({ _: 'secret:ENV_KEY' });
  });

  it('a profile a mandate wrote does not get what authenticates a preset account', () => {
    const view = secretsForProfile(store(), own(M), apiStore);
    expect(view.resolve('SHOP_API_ACCESS_TOKEN')).toBeNull();
    expect(view.resolve('SHOP_CLIENT_ID')).toBeNull();
    expect(view.resolveSecretRefs({ a: 'secret:SETUP_KEY', b: 'secret:SHOP_API_ACCESS_TOKEN' })).toEqual({ a: 'secret:SETUP_KEY', b: 'secret:SHOP_API_ACCESS_TOKEN' });
  });

  it('control: a profile a mandate wrote still gets what the setup stored', () => {
    const view = secretsForProfile(store(), own(M), apiStore);
    expect(view.resolve('SETUP_KEY')).toBe('stored-by-setup');
    expect(view.resolveSecretRefs({ _: 'secret:SETUP_KEY' })).toEqual({ _: 'stored-by-setup' });
    expect(view.listNames()).toContain('SETUP_KEY');
  });

  it('reads a store that cannot say where a value came from as the environment', () => {
    const view = secretsForProfile(store({ isEnvironmentSecret: undefined }), own(M), apiStore);
    expect(view.resolve('SETUP_KEY')).toBeNull();
  });

  it('reads the preset accounts at each lookup, so one connected later counts', () => {
    const profiles: ApiProfile[] = [];
    const view = secretsForProfile(store(), own(M), { getAll: () => profiles });
    expect(view.resolve('SHOP_API_ACCESS_TOKEN')).toBe('shop-token');
    profiles.push(preset);
    expect(view.resolve('SHOP_API_ACCESS_TOKEN')).toBeNull();
  });
});
