import { describe, it, expect } from 'vitest';
import { connectionTokenAllowed, mandateMayConnect, mandateMayRead, mayServeAsClientId, secretsForProfile } from './profile-secret-view.js';
import type { ApiProfile } from './api-store.js';
import type { SecretStoreLike } from '../types/index.js';

// PRD customer-granted-operator-access §3.13: the vault as the engine reads it for a
// profile a mandate wrote. The owner's profile is the control each time.
const VALUES: Record<string, string> = { SETUP_KEY: 'stored-by-setup', ENV_KEY: 'from-the-environment', SHOP_API_ACCESS_TOKEN: 'shop-token', SHOP_CLIENT_ID: 'shop-client' };
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

  it('reads the profiles at each lookup, so an account connected later counts', () => {
    const profiles: ApiProfile[] = [];
    const view = secretsForProfile(store(), own(M), { getAll: () => profiles });
    expect(view.resolve('SHOP_CLIENT_ID')).toBe('shop-client');
    profiles.push(preset);
    expect(view.resolve('SHOP_CLIENT_ID')).toBeNull();
  });
});

// PRD §3.13 (H2i): whose a name is decides who may have it. The same rule
// answers for a profile a mandate wrote and, without a profile, for a `secret:` reference in its
// turn (`mandateMayRead`).
describe('mandateMayRead', () => {
  const VALUES2: Record<string, string> = {
    OWNER_KEY: 'o', MINE_KEY: 'm', BOOKS_CLIENT_ID: 'c', BOOKS_API_ACCESS_TOKEN: 'at', BOOKS_API_REFRESH_TOKEN: 'rt',
    GONE_API_REFRESH_TOKEN: 'g', MINE_API_ACCESS_TOKEN: 'mt', MY_OUTPUT: 'mo', ENV_KEY: 'e',
  };
  const vault = store({ resolve: (n: string) => VALUES2[n] ?? null });
  const OTHER = 'mandate:other@example.org';
  const ownerCrm: ApiProfile = { id: 'owner-crm', name: 'O', base_url: 'https://o.example', description: 'd', auth: { type: 'bearer', vault_keys: ['OWNER_KEY'] } };
  const books = (connected_by?: string, created_by = M): ApiProfile => ({
    id: 'books-api', name: 'Books', base_url: 'https://api.books.example', description: 'd', created_by,
    auth: { type: 'oauth2', vault_keys: ['BOOKS_CLIENT_ID'], oauth: { preset_id: 'bexio', client_id_key: 'BOOKS_CLIENT_ID' } },
    ...(connected_by === undefined ? {} : { oauth_grant: { connected_by } }),
  });
  const mine = (connected_by?: string): ApiProfile => ({
    id: 'mine-api', name: 'Mine', base_url: 'https://mine.example', description: 'd', created_by: M,
    auth: { type: 'oauth2', vault_keys: ['MINE_KEY'], oauth: { client_id_key: 'MINE_KEY' } },
    ...(connected_by === undefined ? {} : { oauth_grant: { connected_by, written: [{ name: 'MY_OUTPUT', fp: 'x' }] } }),
  });
  const may = (profiles: ApiProfile[], name: string, via?: ApiProfile, writing = false): boolean =>
    mandateMayRead(vault, { getAll: () => profiles }, M, name, via, writing);

  it('gives a mandate\'s preset profile its own client pair and the tokens of its own consent', () => {
    const p = books(M);
    expect(may([p], 'BOOKS_CLIENT_ID', p)).toBe(true);
    expect(may([p], 'BOOKS_API_ACCESS_TOKEN', p)).toBe(true);
    expect(may([p], 'BOOKS_API_REFRESH_TOKEN', p)).toBe(true);
  });

  it.each([
    ['the owner', 'owner'],
    ['nobody yet', undefined],
    ['another mandate', OTHER],
  ])('does not give a mandate\'s profile the tokens of a consent by %s', (_label, by) => {
    const p = books(by);
    expect(may([p], 'BOOKS_API_ACCESS_TOKEN', p)).toBe(false);
    expect(may([p], 'BOOKS_CLIENT_ID', p)).toBe(true);
  });

  it('lets the first exchange write into its own slot when no consent is recorded, and nowhere else', () => {
    expect(may([books()], 'BOOKS_API_ACCESS_TOKEN', books(), true)).toBe(true);
    expect(may([books('owner')], 'BOOKS_API_ACCESS_TOKEN', books('owner'), true)).toBe(false);
    expect(may([books(), ownerCrm], 'OWNER_KEY', books(), true)).toBe(false);
  });

  it('does not give a mandate\'s profile a name another author\'s profile reads', () => {
    const own = mine(M);
    expect(may([own, ownerCrm], 'OWNER_KEY', own)).toBe(false);
    expect(may([own, { ...ownerCrm, created_by: OTHER }], 'OWNER_KEY', own)).toBe(false);
    expect(may([own], 'OWNER_KEY', own)).toBe(true);
  });

  it('does not give a second profile of the same mandate the credentials of its preset connection', () => {
    const p = books(M);
    const second = mine(M);
    for (const n of ['BOOKS_CLIENT_ID', 'BOOKS_API_ACCESS_TOKEN', 'BOOKS_API_REFRESH_TOKEN']) {
      expect(may([p, second], n, second)).toBe(false);
    }
  });

  it('does not give a name shaped like another profile\'s token slot, its profile gone', () => {
    const own = mine(M);
    expect(may([own], 'GONE_API_REFRESH_TOKEN', own)).toBe(false);
    expect(may([own], 'GONE_API_REFRESH_TOKEN')).toBe(false);
  });

  it('gives a turn\'s reference the tokens of its own consent on a profile without a preset, and no preset credential at all', () => {
    const own = mine(M);
    expect(may([own], 'MINE_API_ACCESS_TOKEN')).toBe(true);
    expect(may([own], 'MY_OUTPUT')).toBe(true);
    expect(may([mine('owner')], 'MY_OUTPUT')).toBe(false);
    const p = books(M);
    for (const n of ['BOOKS_CLIENT_ID', 'BOOKS_API_ACCESS_TOKEN']) expect(may([p], n)).toBe(false);
  });

  it('gives nothing from the environment, whatever names it', () => {
    expect(may([mine(M)], 'ENV_KEY', mine(M))).toBe(false);
    expect(may([], 'ENV_KEY')).toBe(false);
  });
});

// PRD §3.13 B9: a token of a connection a mandate consented to is handed out to nobody once that
// mandate is not live, keyed by the vault name so every way of reaching it is covered.
describe('connectionTokenAllowed', () => {
  const grantOf = (connected_by: string | undefined, connected_mandate_id?: string): ApiProfile => ({
    id: 'books-api', name: 'Books', base_url: 'https://api.books.example', description: 'd', created_by: M,
    auth: { type: 'oauth2', vault_keys: ['BOOKS_CLIENT_ID'], oauth: { preset_id: 'bexio', client_id_key: 'BOOKS_CLIENT_ID' } },
    oauth_grant: {
      ...(connected_by === undefined ? {} : { connected_by }),
      ...(connected_mandate_id === undefined ? {} : { connected_mandate_id }),
      written: [{ name: 'BOOKS_EXTRA', fp: 'x' }],
    },
  });
  const ends = (live: string[]): { isLive: (id: string) => boolean } => ({ isLive: (id) => live.includes(id) });
  const allowed = (p: ApiProfile, live: string[] | null, name: string): boolean =>
    connectionTokenAllowed({ getAll: () => [p] }, live === null ? null : ends(live), name);

  it('hands out a live mandate\'s tokens, and none once it has ended', () => {
    const p = grantOf(M, 'M-1');
    for (const n of ['BOOKS_API_ACCESS_TOKEN', 'BOOKS_API_REFRESH_TOKEN', 'BOOKS_EXTRA']) {
      expect(allowed(p, ['M-1'], n)).toBe(true);
      expect(allowed(p, [], n)).toBe(false);
    }
  });

  it('keys the end by the mandate id: a later mandate for the same address does not revive it', () => {
    expect(allowed(grantOf(M, 'M-1'), ['M-2'], 'BOOKS_API_ACCESS_TOKEN')).toBe(false);
  });

  it('withholds a mandate\'s tokens without its id, or without any record of ends', () => {
    expect(allowed(grantOf(M), ['M-1'], 'BOOKS_API_ACCESS_TOKEN')).toBe(false);
    expect(allowed(grantOf(M, 'M-1'), null, 'BOOKS_API_ACCESS_TOKEN')).toBe(false);
  });

  it('control: leaves the owner\'s consent, an unstamped grant, other names and a missing API store alone', () => {
    expect(allowed(grantOf('owner'), [], 'BOOKS_API_ACCESS_TOKEN')).toBe(true);
    expect(allowed(grantOf(undefined), [], 'BOOKS_API_ACCESS_TOKEN')).toBe(true);
    expect(allowed(grantOf(M, 'M-1'), [], 'BOOKS_CLIENT_ID')).toBe(true);
    expect(connectionTokenAllowed(null, null, 'BOOKS_API_ACCESS_TOKEN')).toBe(true);
  });
});

describe('mandateMayConnect — where a connection stores its tokens', () => {
  const mine: ApiProfile = {
    id: 'crm', name: 'CRM', base_url: 'https://crm.example/v1', description: 'd', created_by: M,
    auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID'], oauth: { preset_id: 'example-crm', client_id_key: 'CRM_CLIENT_ID' } },
  };
  // The owner's bearer profile reads a personal token stored under the very name the mandate's
  // connection would write its access token to.
  const ownersPat: ApiProfile = {
    id: 'crm-pat', name: 'CRM PAT', base_url: 'https://crm.example/v1', description: 'd',
    auth: { type: 'bearer', vault_keys: ['CRM_ACCESS_TOKEN'] },
  };

  it('lets a mandate connect its own profile when no one else reads the slots', () => {
    expect(mandateMayConnect(store(), { getAll: () => [mine] }, M, mine)).toBe(true);
  });

  it('refuses when a profile of the owner reads a slot the connection would write', () => {
    expect(mandateMayConnect(store(), { getAll: () => [mine, ownersPat] }, M, mine)).toBe(false);
  });

  it('refuses when the refresh slot is read by another author, the access slot alone being free', () => {
    const readsRefresh: ApiProfile = { ...ownersPat, id: 'crm-refresh', auth: { type: 'bearer', vault_keys: ['CRM_REFRESH_TOKEN'] } };
    expect(mandateMayConnect(store(), { getAll: () => [mine, readsRefresh] }, M, mine)).toBe(false);
  });
});

describe('mayServeAsClientId — what may go into a sign-in link', () => {
  const app = (over: Partial<NonNullable<NonNullable<ApiProfile['auth']>['oauth']>>): ApiProfile => ({
    id: 'books', name: 'Books', base_url: 'https://books.example/v2', description: 'd',
    auth: { type: 'oauth2', vault_keys: ['BOOKS_CLIENT_ID', 'BOOKS_CLIENT_SECRET'], oauth: { preset_id: 'example-books', client_id_key: 'BOOKS_CLIENT_ID', client_secret_key: 'BOOKS_CLIENT_SECRET', ...over } },
  });

  it('allows a client id, also one a second profile uses as its client id', () => {
    const twin: ApiProfile = { ...app({}), id: 'books-2' };
    expect(mayServeAsClientId({ getAll: () => [app({}), twin] }, 'BOOKS_CLIENT_ID')).toBe(true);
  });

  it('refuses the name a profile reads as its client secret, even its own', () => {
    expect(mayServeAsClientId({ getAll: () => [app({ client_id_key: 'BOOKS_CLIENT_SECRET' })] }, 'BOOKS_CLIENT_SECRET')).toBe(false);
  });

  it('refuses a token slot and a bearer key', () => {
    expect(mayServeAsClientId({ getAll: () => [app({})] }, 'BOOKS_ACCESS_TOKEN')).toBe(false);
    expect(mayServeAsClientId({ getAll: () => [own()] }, 'SETUP_KEY')).toBe(false);
  });

  it('refuses a key the engine guards, named by no profile', () => {
    expect(mayServeAsClientId({ getAll: () => [] }, 'ANTHROPIC_API_KEY')).toBe(false);
  });
});
