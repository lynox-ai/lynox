import { describe, it, expect } from 'vitest';
import { connectionTokenAllowed, mandateMayConnect, mandateMayRead, mayServeAsClientId, releaseBinding, releaseObstacle, releaseState, secretsForProfile, withheldFrom, type ReadCtx } from './profile-secret-view.js';
import type { ApiProfile } from './api-store.js';
import type { SecretStoreLike } from '../types/index.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

/** A reader with no releases and no live mandate: what every read had before releases existed. */
const NO_RELEASES: ReadCtx = { principal: OWNER_PRINCIPAL, ends: null, releases: null };

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

/** A fake of the owner's releases: `profileId|author|name` → what was released. */
function releasesOf(rows: Array<{ profile: ApiProfile; name: string; mandateId: string; binding?: string }>): ReadCtx['releases'] {
  const map = new Map(rows.map((r) => [`${r.profile.id}|${r.profile.created_by ?? ''}|${r.name}`, { binding: r.binding ?? releaseBinding(r.profile, r.name)!, mandateId: r.mandateId }]));
  return { releaseOf: (id, author, name) => map.get(`${id}|${author}|${name}`) };
}
const endsOf = (live: string[]): ReadCtx['ends'] => ({ isLive: (id) => live.includes(id) });
/** `name` released to `profile` for the live grant M-1, read by the owner. */
function releasedFor(profile: ApiProfile, name: string, principal: RequestPrincipal = OWNER_PRINCIPAL): ReadCtx {
  return { principal, ends: endsOf(['M-1']), releases: releasesOf([{ profile, name, mandateId: 'M-1' }]) };
}

describe('secretsForProfile', () => {
  it('hands a profile the owner wrote the store itself', () => {
    const s = store();
    expect(secretsForProfile(s, own(), apiStore, NO_RELEASES)).toBe(s);
    expect(secretsForProfile(s, own('owner'), apiStore, NO_RELEASES)).toBe(s);
  });

  it('a profile a mandate wrote does not get a value from the environment', () => {
    const view = secretsForProfile(store(), own(M), apiStore, NO_RELEASES);
    expect(view.resolve('ENV_KEY')).toBeNull();
    expect(view.resolveSecretRefs({ _: 'secret:ENV_KEY' })).toEqual({ _: 'secret:ENV_KEY' });
  });

  it('a profile a mandate wrote does not get what authenticates a preset account', () => {
    const view = secretsForProfile(store(), own(M), apiStore, NO_RELEASES);
    expect(view.resolve('SHOP_API_ACCESS_TOKEN')).toBeNull();
    expect(view.resolve('SHOP_CLIENT_ID')).toBeNull();
    expect(view.resolveSecretRefs({ a: 'secret:SETUP_KEY', b: 'secret:SHOP_API_ACCESS_TOKEN' })).toEqual({ a: 'secret:SETUP_KEY', b: 'secret:SHOP_API_ACCESS_TOKEN' });
  });

  it('a profile a mandate wrote does not get a name of the owner\'s it was not released', () => {
    const view = secretsForProfile(store(), own(M), apiStore, NO_RELEASES);
    expect(view.resolve('SETUP_KEY')).toBeNull();
    expect(view.resolveSecretRefs({ _: 'secret:SETUP_KEY' })).toEqual({ _: 'secret:SETUP_KEY' });
    expect(view.listNames()).toContain('SETUP_KEY');
  });

  it('control: once released to it, a profile a mandate wrote gets the owner\'s name', () => {
    const view = secretsForProfile(store(), own(M), apiStore, releasedFor(own(M), 'SETUP_KEY'));
    expect(view.resolve('SETUP_KEY')).toBe('stored-by-setup');
    expect(view.resolveSecretRefs({ _: 'secret:SETUP_KEY' })).toEqual({ _: 'stored-by-setup' });
  });

  it('reads a store that cannot say where a value came from as the environment', () => {
    const view = secretsForProfile(store({ isEnvironmentSecret: undefined }), own(M), apiStore, releasedFor(own(M), 'SETUP_KEY'));
    expect(view.resolve('SETUP_KEY')).toBeNull();
  });

  it('reads the profiles at each lookup, so an account connected later counts, a release notwithstanding', () => {
    const profiles: ApiProfile[] = [];
    const named: ApiProfile = { ...own(M), auth: { type: 'bearer', vault_keys: ['SHOP_CLIENT_ID'] } };
    const view = secretsForProfile(store(), named, { getAll: () => profiles }, releasedFor(named, 'SHOP_CLIENT_ID'));
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
  const may = (profiles: ApiProfile[], name: string, via?: ApiProfile, writing = false, ctx: ReadCtx = NO_RELEASES): boolean =>
    mandateMayRead(vault, { getAll: () => profiles }, M, name, via, ctx, writing);

  it('gives a mandate\'s preset profile the tokens of its own consent, and its client pair once released', () => {
    const p = books(M);
    expect(may([p], 'BOOKS_API_ACCESS_TOKEN', p)).toBe(true);
    expect(may([p], 'BOOKS_API_REFRESH_TOKEN', p)).toBe(true);
    expect(may([p], 'BOOKS_CLIENT_ID', p)).toBe(false);
    expect(may([p], 'BOOKS_CLIENT_ID', p, false, releasedFor(p, 'BOOKS_CLIENT_ID'))).toBe(true);
  });

  it.each([
    ['the owner', 'owner'],
    ['nobody yet', undefined],
    ['another mandate', OTHER],
  ])('does not give a mandate\'s profile the tokens of a consent by %s', (_label, by) => {
    const p = books(by);
    expect(may([p], 'BOOKS_API_ACCESS_TOKEN', p)).toBe(false);
    expect(may([p], 'BOOKS_CLIENT_ID', p, false, releasedFor(p, 'BOOKS_CLIENT_ID'))).toBe(true);
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
    // Read by no other profile, it is still the owner's: a mandate stores no value.
    expect(may([own], 'OWNER_KEY', own)).toBe(false);
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

  it('gives a bare reference nothing, the tokens of its own consent included: no profile holds the grant for it', () => {
    const own = mine(M);
    expect(may([own], 'MINE_API_ACCESS_TOKEN', own)).toBe(true);
    expect(may([own], 'MY_OUTPUT', own)).toBe(true);
    expect(may([own], 'MINE_API_ACCESS_TOKEN')).toBe(false);
    expect(may([own], 'MY_OUTPUT')).toBe(false);
    const p = books(M);
    for (const n of ['BOOKS_CLIENT_ID', 'BOOKS_API_ACCESS_TOKEN']) expect(may([p], n)).toBe(false);
  });

  it('gives a second profile of the same mandate none of the tokens of a connection without a preset', () => {
    const holder = mine(M);
    const second: ApiProfile = { id: 'second-api', name: 'S', base_url: 'https://second.example', description: 'd', created_by: M, auth: { type: 'bearer', vault_keys: ['MINE_API_ACCESS_TOKEN'] } };
    expect(may([holder, second], 'MINE_API_ACCESS_TOKEN', second)).toBe(false);
    expect(may([holder, second], 'MY_OUTPUT', second)).toBe(false);
    expect(may([holder, second], 'MINE_API_ACCESS_TOKEN', holder)).toBe(true);
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
    expect(mandateMayConnect(store(), { getAll: () => [mine] }, M, mine, NO_RELEASES)).toBe(true);
  });

  it('refuses when a profile of the owner reads a slot the connection would write', () => {
    expect(mandateMayConnect(store(), { getAll: () => [mine, ownersPat] }, M, mine, NO_RELEASES)).toBe(false);
  });

  it('refuses when the refresh slot is read by another author, the access slot alone being free', () => {
    const readsRefresh: ApiProfile = { ...ownersPat, id: 'crm-refresh', auth: { type: 'bearer', vault_keys: ['CRM_REFRESH_TOKEN'] } };
    expect(mandateMayConnect(store(), { getAll: () => [mine, readsRefresh] }, M, mine, NO_RELEASES)).toBe(false);
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

// PRD customer-granted-operator-access §3.13: a profile a mandate wrote
// reads a name of the owner's only once the owner released it to exactly that profile, for the
// grant that asked and for where the value goes then.
describe('releases of the owner\'s names to a profile a mandate wrote', () => {
  const VALUES3: Record<string, string> = { OWNER_KEY: 'owner-value', OWNER_SECRET: 'owner-secret', USER_A: 'a', PASS_B: 'b', ENV_KEY: 'e' };
  const vault = store({ resolve: (n: string) => VALUES3[n] ?? null });
  const OTHER = 'mandate:other@example.org';
  const mb = (over: Partial<ApiProfile> = {}): ApiProfile => ({
    id: 'mb-api', name: 'MB', base_url: 'https://mb.example/v1', description: 'd', created_by: M,
    auth: { type: 'bearer', vault_keys: ['OWNER_KEY'] }, ...over,
  });
  const ownerCrm: ApiProfile = { id: 'owner-crm', name: 'O', base_url: 'https://o.example', description: 'd', auth: { type: 'bearer', vault_keys: ['OWNER_KEY'] } };
  const mandateP = (mandateId?: string): RequestPrincipal => ({ kind: 'mandate', email: 'setup@example.org', ...(mandateId === undefined ? {} : { mandateId }) });
  const read = (profiles: ApiProfile[], via: ApiProfile, name: string, ctx: ReadCtx): boolean =>
    mandateMayRead(vault, { getAll: () => profiles }, via.created_by!, name, via, ctx);

  it('withholds the owner\'s name until it is released, and gives it once it is', () => {
    const p = mb();
    expect(read([p], p, 'OWNER_KEY', NO_RELEASES)).toBe(false);
    expect(secretsForProfile(vault, p, { getAll: () => [p] }, NO_RELEASES).resolve('OWNER_KEY')).toBeNull();
    expect(withheldFrom(vault, p, { getAll: () => [p] }, ['OWNER_KEY'], NO_RELEASES)).toEqual(['OWNER_KEY']);
    const ctx = releasedFor(p, 'OWNER_KEY');
    expect(read([p], p, 'OWNER_KEY', ctx)).toBe(true);
    expect(secretsForProfile(vault, p, { getAll: () => [p] }, ctx).resolve('OWNER_KEY')).toBe('owner-value');
  });

  it('a release opens a name a profile of the owner reads as well, and nothing opens it without one', () => {
    const p = mb();
    expect(read([p, ownerCrm], p, 'OWNER_KEY', NO_RELEASES)).toBe(false);
    expect(read([p, ownerCrm], p, 'OWNER_KEY', releasedFor(p, 'OWNER_KEY'))).toBe(true);
  });

  it('lapses when a host changes, and the state says so', () => {
    const given = mb();
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'OWNER_KEY', mandateId: 'M-1' }]) };
    const moved = mb({ base_url: 'https://elsewhere.example/v1' });
    expect(read([moved], moved, 'OWNER_KEY', ctx)).toBe(false);
    expect(releaseState(vault, { getAll: () => [moved] }, moved, 'OWNER_KEY', ctx)).toBe('lapsed');
    // A path on the same host is not another destination.
    const samehost = mb({ base_url: 'https://mb.example/v2' });
    expect(read([samehost], samehost, 'OWNER_KEY', ctx)).toBe(true);
    // Plain http, or another port, on the same host is.
    for (const base_url of ['http://mb.example/v1', 'https://mb.example:8443/v1']) {
      const moved2 = mb({ base_url });
      expect(read([moved2], moved2, 'OWNER_KEY', ctx)).toBe(false);
    }
  });

  it('lapses when only the name of the header it goes in changes', () => {
    const given = mb({ auth: { type: 'header', header_name: 'X-Key', vault_keys: ['OWNER_KEY'] } });
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'OWNER_KEY', mandateId: 'M-1' }]) };
    expect(read([given], given, 'OWNER_KEY', ctx)).toBe(true);
    const renamed = mb({ auth: { type: 'header', header_name: 'X-Other', vault_keys: ['OWNER_KEY'] } });
    expect(read([renamed], renamed, 'OWNER_KEY', ctx)).toBe(false);
  });

  it.each([
    ['the header it goes in', (p: ApiProfile): ApiProfile => ({ ...p, auth: { type: 'header', header_name: 'X-Other', vault_keys: ['OWNER_KEY'] } })],
    ['the auth type', (p: ApiProfile): ApiProfile => ({ ...p, auth: { type: 'header', vault_keys: ['OWNER_KEY'] } })],
  ])('lapses when %s changes', (_label, change) => {
    const given = mb();
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'OWNER_KEY', mandateId: 'M-1' }]) };
    const changed = change(given);
    expect(read([changed], changed, 'OWNER_KEY', ctx)).toBe(false);
  });

  const oauthP = (oauth: NonNullable<NonNullable<ApiProfile['auth']>['oauth']> = {}, over: Partial<ApiProfile> = {}): ApiProfile => ({
    id: 'oa-api', name: 'OA', base_url: 'https://oa.example', description: 'd', created_by: M,
    auth: { type: 'oauth2', vault_keys: ['OWNER_SECRET'], oauth: { token_url: 'https://oa.example/token', client_secret_key: 'OWNER_SECRET', grant_type: 'client_credentials', ...oauth } },
    ...over,
  });

  it.each([
    ['the scope', { scope: 'admin' }],
    ['the audience', { audience: 'https://other.example' }],
    ['the token endpoint', { token_url: 'https://elsewhere.example/token' }],
    ['the path of the token endpoint', { token_url: 'https://oa.example/other-token' }],
    ['the scheme of the token endpoint', { token_url: 'http://oa.example/token' }],
  ])('lapses when %s of an OAuth profile changes', (_label, change) => {
    const given = oauthP();
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'OWNER_SECRET', mandateId: 'M-1' }]) };
    expect(read([given], given, 'OWNER_SECRET', ctx)).toBe(true);
    const changed = oauthP(change);
    expect(read([changed], changed, 'OWNER_SECRET', ctx)).toBe(false);
  });

  it('holds when only what the engine rewrites by itself changes', () => {
    const given = oauthP();
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'OWNER_SECRET', mandateId: 'M-1' }]) };
    const renewed = oauthP({ grant_type: 'refresh_token', token_expires_at: 123 }, {
      oauth_grant: { state: 'connected' },
      custom_endpoint_ack: { acked_at: '2026-10-09T00:00:00.000Z' } as unknown as ApiProfile['custom_endpoint_ack'],
    });
    expect(read([renewed], renewed, 'OWNER_SECRET', ctx)).toBe(true);
  });

  it('lapses when a released half of a split Basic credential moves to the other slot', () => {
    const split = (keys: string[]): ApiProfile => mb({ auth: { type: 'basic', basic_format: 'user_pass_split', vault_keys: keys } });
    const given = split(['USER_A', 'PASS_B']);
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf(['M-1']), releases: releasesOf([{ profile: given, name: 'PASS_B', mandateId: 'M-1' }]) };
    expect(read([given], given, 'PASS_B', ctx)).toBe(true);
    const swapped = split(['PASS_B', 'USER_A']);
    expect(read([swapped], swapped, 'PASS_B', ctx)).toBe(false);
  });

  it('holds for one profile: another profile of the same mandate naming the name gets nothing', () => {
    const given = mb();
    const second = mb({ id: 'mb2-api', base_url: 'https://mb2.example' });
    const ctx = releasedFor(given, 'OWNER_KEY');
    expect(read([given, second], second, 'OWNER_KEY', ctx)).toBe(false);
  });

  it('holds for the profile\'s author only: another mandate reading through that profile gets nothing', () => {
    const given = mb();
    const ctx = releasedFor(given, 'OWNER_KEY');
    expect(mandateMayRead(vault, { getAll: () => [given] }, OTHER, 'OWNER_KEY', given, ctx)).toBe(false);
    expect(mandateMayRead(vault, { getAll: () => [given] }, M, 'OWNER_KEY', given, ctx)).toBe(true);
  });

  it('holds for one author: another mandate under the same id gets nothing', () => {
    const given = mb();
    const ctx = releasedFor(given, 'OWNER_KEY');
    const usurper = mb({ created_by: OTHER });
    expect(read([usurper], usurper, 'OWNER_KEY', ctx)).toBe(false);
  });

  it('holds for one grant: a later mandate of the same address reads nothing while the first is still live', () => {
    const given = mb();
    const ctx = (principal: RequestPrincipal): ReadCtx => ({ principal, ends: endsOf(['M-1', 'M-2']), releases: releasesOf([{ profile: given, name: 'OWNER_KEY', mandateId: 'M-1' }]) });
    expect(read([given], given, 'OWNER_KEY', ctx(mandateP('M-2')))).toBe(false);
    expect(read([given], given, 'OWNER_KEY', ctx(mandateP('M-1')))).toBe(true);
    // A mandate's run without its grant id (a run resumed after a restart) reads none.
    expect(read([given], given, 'OWNER_KEY', ctx(mandateP()))).toBe(false);
  });

  it('ends with the grant: once it is no longer live, not even the owner\'s run reads it', () => {
    const given = mb();
    const ctx: ReadCtx = { principal: OWNER_PRINCIPAL, ends: endsOf([]), releases: releasesOf([{ profile: given, name: 'OWNER_KEY', mandateId: 'M-1' }]) };
    expect(read([given], given, 'OWNER_KEY', ctx)).toBe(false);
    expect(read([given], given, 'OWNER_KEY', { ...ctx, ends: null })).toBe(false);
  });

  it.each([
    ['a token slot', 'OTHER_API_ACCESS_TOKEN', 'token'],
    ['a value from the environment', 'ENV_KEY', 'environment'],
    ['a provider key', 'ANTHROPIC_API_KEY', 'protected'],
  ] as const)('never releases %s, whatever a release row says', (_label, name, why) => {
    const p = mb({ auth: { type: 'bearer', vault_keys: [name] } });
    expect(releaseObstacle(vault, { getAll: () => [p] }, p, name)).toBe(why);
    expect(read([p], p, name, releasedFor(p, name))).toBe(false);
  });

  it('never releases a name a connection\'s exchange wrote to, whatever its shape', () => {
    const p = mb({ auth: { type: 'bearer', vault_keys: ['CRM_TOKEN'] } });
    const connected: ApiProfile = { ...ownerCrm, oauth_grant: { state: 'connected', written: [{ name: 'CRM_TOKEN', fp: 'f' }] } as unknown as ApiProfile['oauth_grant'] };
    expect(releaseObstacle(vault, { getAll: () => [p, connected] }, p, 'CRM_TOKEN')).toBe('token');
    expect(releaseObstacle(vault, { getAll: () => [p] }, p, 'CRM_TOKEN')).toBeNull();
  });

  it('never releases a name a profile of another mandate, or a preset profile of the owner, reads', () => {
    const p = mb();
    const other = { ...ownerCrm, id: 'other-crm', created_by: OTHER };
    expect(releaseObstacle(vault, { getAll: () => [p, other] }, p, 'OWNER_KEY')).toBe('other-mandate');
    const ownersPreset: ApiProfile = { ...preset, auth: { type: 'oauth2', vault_keys: ['OWNER_KEY'], oauth: { preset_id: 'example-shop', client_id_key: 'OWNER_KEY' } } };
    expect(releaseObstacle(vault, { getAll: () => [p, ownersPreset] }, p, 'OWNER_KEY')).toBe('preset');
    expect(read([p, ownersPreset], p, 'OWNER_KEY', releasedFor(p, 'OWNER_KEY'))).toBe(false);
  });

  it.each([
    ['a query parameter', { type: 'query', query_param: 'key', vault_keys: ['OWNER_KEY'] }],
    ['a pre-encoded Basic credential', { type: 'basic', basic_format: 'pre_encoded_b64', vault_keys: ['OWNER_KEY'] }],
    ['a second key of a bearer profile', { type: 'bearer', vault_keys: ['FIRST_KEY', 'OWNER_KEY'] }],
  ] as const)('never releases a name the engine does not send itself: %s', (_label, auth) => {
    const p = mb({ auth: { ...auth, vault_keys: [...auth.vault_keys] } });
    expect(releaseObstacle(vault, { getAll: () => [p] }, p, 'OWNER_KEY')).toBe('not-sent');
    expect(releaseBinding(p, 'OWNER_KEY')).toBeNull();
  });

  it('control: a profile the owner wrote reads its name with no release at all', () => {
    expect(secretsForProfile(vault, ownerCrm, { getAll: () => [ownerCrm] }, NO_RELEASES).resolve('OWNER_KEY')).toBe('owner-value');
    expect(withheldFrom(vault, ownerCrm, { getAll: () => [ownerCrm] }, ['OWNER_KEY'], NO_RELEASES)).toEqual([]);
  });
});
