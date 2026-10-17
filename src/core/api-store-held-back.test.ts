import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// fetch_token's transport, as in api-setup-grant.test.ts: DNS stubbed, the pinned transport
// forwarded to globalThis.fetch.
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));
let mockLynoxDir: string;
vi.mock('./config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, accessTokenKey, purgeRecordedTokens, refreshTokenKey, type ApiProfile } from './api-store.js';
import { connectionTokenAllowed, mandateMayRead, mayServeAsClientId, releaseObstacle, type ReadCtx } from './profile-secret-view.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { setPinnedTransportForTests } from './network-guard.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { resetOAuthRenewalBackoffForTests } from '../tools/builtin/http.js';
import type { SecretStoreLike } from '../types/index.js';

/**
 * A profile the boot read but did not register is still stored, and its names are its own again
 * once it is corrected and admitted. Every check whether ANOTHER profile uses a name or a slot
 * reads it through `knownProfiles()`; each test here holds one back and shows the check sees it,
 * and a control where it is gone (or never stored) and the check answers "free".
 */
describe('ApiStore — profiles the boot held back', () => {
  let restorePinned: (() => void) | undefined;
  const dirs: string[] = [];
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-held-back-'));
    dirs.push(mockLynoxDir);
  });
  afterEach(() => {
    resetOAuthRenewalBackoffForTests();
    vi.restoreAllMocks();
    restorePinned?.();
    restorePinned = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  type OAuth = NonNullable<NonNullable<ApiProfile['auth']>['oauth']>;
  const oauth = (id: string, host: string, over: Partial<OAuth> = {}, extra: Partial<ApiProfile> = {}): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${id.toUpperCase().replace(/-/g, '_')}_CID`, client_secret_key: `${id.toUpperCase().replace(/-/g, '_')}_CSECRET`, ...over } },
    ...extra,
  });
  const bearer = (id: string, host: string, key: string, extra: Partial<ApiProfile> = {}): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] }, ...extra,
  });
  const basic = (id: string, host: string, username_key: string, password_key: string): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id, auth: { type: 'basic', username_key, password_key },
  });
  const ids = (ps: ApiProfile[]): string[] => ps.map((p) => p.id).sort();
  const stderr = (): string => vi.mocked(process.stderr.write).mock.calls.join('');

  // Held back by `clientSlotOnDerivedName`: its client secret sits under its own refresh name.
  const shopOnOwnSlot = (): ApiProfile => oauth('shop-api', 'api.shop.example', { client_secret_key: 'SHOP_API_REFRESH_TOKEN' });
  const shop = (): ApiProfile => oauth('shop-api', 'api.shop.example');
  // Signs in with shop-api's derived access name.
  const crm = (): ApiProfile => basic('crm', 'api.crm.example', 'CRM_USER', 'SHOP_API_ACCESS_TOKEN');
  /** A store where `profile` is held back by a slot collision: `<sibling>` with `-` was loaded first. */
  const heldBySlot = (profile: ApiProfile): ApiStore => {
    const store = new ApiStore();
    expect(store.register(bearer(profile.id.replace(/_/g, '-'), 'sibling.example', 'SIBLING_KEY'), 'load')).toBe(true);
    expect(store.register(profile, 'load')).toBe(false);
    return store;
  };

  describe('what the store lists', () => {
    it('getAll and get leave a held-back profile out; knownProfiles has it', () => {
      const store = new ApiStore();
      expect(store.register(shopOnOwnSlot(), 'load')).toBe(false);
      expect(store.getAll()).toEqual([]);
      expect(store.get('shop-api')).toBeUndefined();
      expect(ids(store.knownProfiles())).toEqual(['shop-api']);
    });

    it('a refused save is not held back: it stored nothing', () => {
      const store = new ApiStore();
      expect(store.register(shopOnOwnSlot(), 'save')).toBe(false);
      expect(store.knownProfiles()).toEqual([]);
    });

    it('remove drops a held-back profile', () => {
      const store = new ApiStore();
      store.register(shopOnOwnSlot(), 'load');
      store.remove('shop-api');
      expect(store.knownProfiles()).toEqual([]);
    });

    it('forgetAll drops held-back profiles with the registered ones', () => {
      const store = new ApiStore();
      store.register(bearer('feed', 'feed.example', 'FEED_KEY'), 'load');
      store.register(shopOnOwnSlot(), 'load');
      store.forgetAll();
      expect(store.knownProfiles()).toEqual([]);
    });

    it('a save of the corrected profile moves it from held back to registered, once', () => {
      const store = new ApiStore();
      store.register(shopOnOwnSlot(), 'load');
      expect(store.save(shop()).ok).toBe(true);
      expect(ids(store.getAll())).toEqual(['shop-api']);
      const known = store.knownProfiles();
      expect(ids(known)).toEqual(['shop-api']);
      expect(known[0]!.auth?.oauth?.client_secret_key).toBe('SHOP_API_CSECRET');
      // The held-back copy went with the admission: it does not come back when the profile leaves memory.
      expect(store.unregister('shop-api')).toBe(true);
      expect(store.knownProfiles()).toEqual([]);
    });

    it('lists an id that is both registered and held back once, as registered', () => {
      const store = new ApiStore();
      store.register(shop(), 'load');
      expect(store.register(shopOnOwnSlot(), 'load')).toBe(false);
      const known = store.knownProfiles();
      expect(ids(known)).toEqual(['shop-api']);
      expect(known[0]!.auth?.oauth?.client_secret_key).toBe('SHOP_API_CSECRET');
    });
  });

  describe('_admit', () => {
    it('refuses a profile on the vault slot of a held-back one', () => {
      const store = new ApiStore();
      expect(store.register(oauth('my-shop', 'api.shop.example', { client_secret_key: 'MY_SHOP_ACCESS_TOKEN' }), 'load')).toBe(false);
      const saved = store.save(bearer('my_shop', 'other.example', 'OTHER_KEY'));
      expect(saved.ok).toBe(false);
      expect(saved.ok ? '' : saved.reason).toContain('derives the vault slot MY_SHOP, which api_profile "my-shop" already holds');
      // The boot is asked against the registered profiles only, as before this change.
      expect(store.register(bearer('my_shop', 'other.example', 'OTHER_KEY'), 'load')).toBe(true);
    });

    it('control: the same save is admitted once the held-back profile is removed, or was never stored', () => {
      const store = new ApiStore();
      store.register(oauth('my-shop', 'api.shop.example', { client_secret_key: 'MY_SHOP_ACCESS_TOKEN' }), 'load');
      store.remove('my-shop');
      expect(store.save(bearer('my_shop', 'other.example', 'OTHER_KEY')).ok).toBe(true);
      expect(new ApiStore().save(bearer('my_shop', 'other.example', 'OTHER_KEY')).ok).toBe(true);
    });

    it('refuses a profile signing in with the derived access name of a held-back oauth2 profile', () => {
      const store = new ApiStore();
      store.register(shopOnOwnSlot(), 'load');
      const saved = store.save(crm());
      expect(saved.ok).toBe(false);
      expect(saved.ok ? '' : saved.reason).toContain('api_profile "shop-api" is oauth2 and writes its tokens to SHOP_API_ACCESS_TOKEN, which api_profile "crm" signs in with');
      // The boot keeps it in either order, as before this change: a held-back rival does not
      // decide what the boot registers.
      expect(store.register(crm(), 'load')).toBe(true);
    });

    it('control: the same profile is admitted once the oauth2 profile is removed', () => {
      const store = new ApiStore();
      store.register(shopOnOwnSlot(), 'load');
      store.remove('shop-api');
      expect(store.save(crm()).ok).toBe(true);
    });
  });

  // The boot keeps the oauth2 profile and holds back the one signing in with its pair, in either
  // load order; the checks over other profiles see the holder both ways.
  describe.each([
    ['holder loaded first, then unregistered by the deriver', [crm, shop], [true, true]],
    ['deriver loaded first, holder refused', [shop, crm], [true, false]],
  ] as const)('a holder the boot dropped: %s', (_label, order, landed) => {
    const boot = (): ApiStore => {
      const store = new ApiStore();
      order.forEach((p, i) => expect(store.register(p(), 'load')).toBe(landed[i]));
      return store;
    };

    it('is held back, not registered', () => {
      const store = boot();
      expect(ids(store.getAll())).toEqual(['shop-api']);
      expect(ids(store.knownProfiles())).toEqual(['crm', 'shop-api']);
      expect(stderr()).toContain('Skipping profile "crm"');
    });

    it('its username is no client id for a sign-in link', () => {
      expect(mayServeAsClientId(boot(), 'CRM_USER')).toBe(false);
      const control = new ApiStore();
      control.register(shop(), 'load');
      expect(mayServeAsClientId(control, 'CRM_USER')).toBe(true);
    });

    it('a deleted profile\'s recorded token under its username stays', () => {
      const vault = purgeVault({ CRM_USER: 'u-1' });
      const gone = written('gone-api', 'CRM_USER', 'u-1');
      expect(purgeRecordedTokens(boot(), gone, vault).removed).toEqual([]);
      expect(vault.resolve('CRM_USER')).toBe('u-1');
      const store = boot();
      store.remove('crm');
      expect(purgeRecordedTokens(store, gone, vault).removed).toEqual(['CRM_USER']);
    });
  });

  // The boot kept one profile of each conflict over the other. The kept one's next save (an edit,
  // an exchange, a consent) is not refused for the conflict it won; the held-back one, unchanged,
  // still is.
  const slotA = (): ApiProfile => bearer('my-shop', 'a.example', 'A_KEY');
  const slotB = (): ApiProfile => bearer('my_shop', 'b.example', 'B_KEY');
  describe.each([
    ['holder then deriver', [crm, shop], 'shop-api', 'crm'],
    ['deriver then holder', [shop, crm], 'shop-api', 'crm'],
    ['my-shop then my_shop', [slotA, slotB], 'my-shop', 'my_shop'],
    ['my_shop then my-shop', [slotB, slotA], 'my_shop', 'my-shop'],
  ] as const)('after a boot of %s', (_label, order, kept, held) => {
    const boot = (): ApiStore => {
      const store = new ApiStore();
      for (const p of order) store.register(p(), 'load');
      expect(ids(store.getAll())).toEqual([kept]);
      expect(ids(store.knownProfiles())).toEqual([kept, held].sort());
      return store;
    };

    it('the kept profile saves', () => {
      const store = boot();
      const saved = store.save({ ...store.get(kept)!, description: 'edited' });
      expect(saved).toEqual({ ok: true, isNew: false });
      expect(store.get(kept)?.description).toBe('edited');
    });

    it('the held-back one, unchanged, is still refused', () => {
      const store = boot();
      const stored = store.knownProfiles().find((p) => p.id === held)!;
      expect(store.save(stored).ok).toBe(false);
      expect(store.get(held)).toBeUndefined();
    });
  });

  /** A deleted profile whose exchange recorded `value` under `name`. */
  const written = (id: string, name: string, value: string): ApiProfile =>
    ({ ...bearer(id, 'gone.example', 'GONE_KEY'), oauth_grant: { written: [{ name, fp: tokenFingerprint(value) }] } });
  const purgeVault = (initial: Record<string, string>): SecretStoreLike & { resolve(n: string): string | null } => {
    const values = { ...initial };
    return {
      resolve: (n: string) => values[n] ?? null,
      deleteSecret: (n: string) => { const had = n in values; delete values[n]; return had; },
    } as unknown as SecretStoreLike & { resolve(n: string): string | null };
  };

  describe('purgeRecordedTokens', () => {
    it('keeps a recorded token under a name a held-back profile reads', () => {
      const store = heldBySlot(bearer('feed_x', 'feed.example', 'SHARED_TOKEN'));
      const vault = purgeVault({ SHARED_TOKEN: 'v-1' });
      const result = purgeRecordedTokens(store, written('gone-api', 'SHARED_TOKEN', 'v-1'), vault);
      expect(result.removed).toEqual([]);
      expect(result.kept).toContain('SHARED_TOKEN');
      expect(vault.resolve('SHARED_TOKEN')).toBe('v-1');
    });

    it('control: removes it once the held-back profile is removed', () => {
      const store = heldBySlot(bearer('feed_x', 'feed.example', 'SHARED_TOKEN'));
      store.remove('feed_x');
      const vault = purgeVault({ SHARED_TOKEN: 'v-1' });
      expect(purgeRecordedTokens(store, written('gone-api', 'SHARED_TOKEN', 'v-1'), vault).removed).toEqual(['SHARED_TOKEN']);
      expect(vault.resolve('SHARED_TOKEN')).toBeNull();
    });
  });

  describe('the mandate checks over other profiles', () => {
    const M = 'mandate:setup@example.org';
    const OTHER = 'mandate:other@example.org';
    const vault = {
      resolve: (n: string) => `value-of-${n}`,
      isEnvironmentSecret: () => false,
      extractSecretNames: () => [],
      resolveSecretRefs: (x: unknown) => x,
      listNames: () => [],
    } as unknown as SecretStoreLike;
    const NO_RELEASES: ReadCtx = { principal: OWNER_PRINCIPAL, ends: null, releases: null };
    const via = bearer('mb-api', 'mb.example', 'OWNER_KEY', { created_by: M });

    it('releaseObstacle: a name a held-back profile of another mandate reads is not releasable', () => {
      const store = heldBySlot(bearer('other_crm', 'other.example', 'OWNER_KEY', { created_by: OTHER }));
      expect(releaseObstacle(vault, store, via, 'OWNER_KEY')).toBe('other-mandate');
      store.remove('other_crm');
      expect(releaseObstacle(vault, store, via, 'OWNER_KEY')).toBeNull();
    });

    it('releaseObstacle: nor a name a held-back preset profile reads', () => {
      const preset = oauth('pre_set', 'api.preset.example', { preset_id: 'example-shop', client_id_key: 'OWNER_KEY' });
      const store = heldBySlot(preset);
      expect(releaseObstacle(vault, store, via, 'OWNER_KEY')).toBe('preset');
      store.remove('pre_set');
      expect(releaseObstacle(vault, store, via, 'OWNER_KEY')).toBeNull();
    });

    it('mandateMayRead: a mandate\'s own token is not its to read while a held-back profile of the owner reads it', () => {
      const mine = oauth('mine-api', 'mine.example', { client_id_key: 'MINE_CID' }, { created_by: M, oauth_grant: { connected_by: M } });
      const store = heldBySlot(bearer('reader_a', 'reader.example', accessTokenKey('mine-api')));
      expect(store.register(mine, 'load')).toBe(true);
      expect(mandateMayRead(vault, store, M, accessTokenKey('mine-api'), mine, NO_RELEASES)).toBe(false);
      store.remove('reader_a');
      expect(mandateMayRead(vault, store, M, accessTokenKey('mine-api'), mine, NO_RELEASES)).toBe(true);
    });

    it('mayServeAsClientId: a held-back profile\'s key is no client id', () => {
      const store = heldBySlot(bearer('feed_x', 'feed.example', 'FEED_KEY'));
      expect(mayServeAsClientId(store, 'FEED_KEY')).toBe(false);
      store.remove('feed_x');
      expect(mayServeAsClientId(store, 'FEED_KEY')).toBe(true);
    });

    it('connectionTokenAllowed: a held-back connection of a mandate that is not live hands out no token', () => {
      const books = oauth('books-api', 'api.books.example', { client_secret_key: 'BOOKS_API_REFRESH_TOKEN' }, {
        created_by: M, oauth_grant: { connected_by: M, connected_mandate_id: 'M-1', written: [{ name: 'BOOKS_EXTRA', fp: 'x' }] },
      });
      const store = new ApiStore();
      expect(store.register(books, 'load')).toBe(false);
      const ends = (live: string[]): { isLive: (id: string) => boolean } => ({ isLive: (id) => live.includes(id) });
      for (const n of [accessTokenKey('books-api'), refreshTokenKey('books-api'), 'BOOKS_EXTRA']) {
        expect(connectionTokenAllowed(store, ends([]), n)).toBe(false);
        expect(connectionTokenAllowed(store, ends(['M-1']), n)).toBe(true);
      }
      store.remove('books-api');
      expect(connectionTokenAllowed(store, ends([]), 'BOOKS_EXTRA')).toBe(true);
    });
  });

  describe('fetch_token output_secret_name', () => {
    const crmApi = (): ApiProfile => ({
      ...oauth('crm-api', 'api.crm.example', { client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' }),
      custom_endpoint_ack: { accepted: true, hosts: ['api.crm.example'], accepted_at: '2026-09-22T00:00:00.000Z' },
    });
    const tokenVault = (): { resolve(n: string): string | null; resolveSecretRefs(x: unknown): unknown; set(n: string, v: string): void; listNames(): string[] } => {
      const values: Record<string, string> = { CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_API_REFRESH_TOKEN: 'rt-1' };
      return {
        resolve: (n) => values[n] ?? null,
        resolveSecretRefs: (x) => JSON.parse(JSON.stringify(x).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, n: string) => values[n] ?? m)) as unknown,
        set: (n, v) => { values[n] = v; },
        listNames: () => Object.keys(values),
      };
    };
    const agentFor = (apiStore: ApiStore, vault: ReturnType<typeof tokenVault>): never => ({
      principal: OWNER_PRINCIPAL,
      sessionCounters: { httpRequests: 0 },
      secretStore: vault,
      getAvailableTools: () => ['http_request', 'api_setup'].map((name) => ({ definition: { name } })),
      toolContext: {
        apiStore, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [],
        streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null,
        hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false,
        secretReleases: null, mandateEnds: null,
      },
    }) as never;
    const storeWithHeldFeed = (): ApiStore => {
      const store = heldBySlot(bearer('feed_x', 'feed.example', 'FEED_KEY'));
      expect(store.register(crmApi(), 'load')).toBe(true);
      return store;
    };

    // The token endpoint answers in both tests, so a refusal that does not happen shows as a stored token.
    beforeEach(() => {
      restorePinned = setPinnedTransportForTests(async (input) => {
        const init: RequestInit = { method: input.method, headers: input.headers };
        if (input.body !== undefined) init.body = input.body.toString('utf8');
        return (globalThis.fetch as typeof fetch)(input.url, init);
      });
    });
    const tokenEndpoint = (): ReturnType<typeof vi.spyOn> => vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    it('refuses a name a held-back profile uses, before posting anything', async () => {
      const vault = tokenVault();
      const fetchSpy = tokenEndpoint();
      const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: 'FEED_KEY' }, agentFor(storeWithHeldFeed(), vault)) as string;
      expect(result).toContain('output_secret_name "FEED_KEY" is a name API profile "feed_x" uses');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vault.resolve('FEED_KEY')).toBeNull();
    });

    it('control: once the held-back profile is removed, the token goes there', async () => {
      const store = storeWithHeldFeed();
      store.remove('feed_x');
      const vault = tokenVault();
      tokenEndpoint();
      const result = await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api', output_secret_name: 'FEED_KEY' }, agentFor(store, vault)) as string;
      expect(result).not.toContain('Error');
      expect(vault.resolve('FEED_KEY')).toBe('at-1');
    });
  });

  // The two paths that need the grant ledger: the foreign marking of a new consent, and a save
  // whose write throws.
  describe('with a grant ledger', () => {
    let dir: string;
    let db: EngineDb;
    let conn: ConnectionStore;
    let store: ApiStore;
    const vault = new Map<string, string>();
    const fp = (v: string): string => (v === '' ? '' : `k-${tokenFingerprint(v)}`);
    const tok = (v: string): string => (v === '' ? '' : `t-${tokenFingerprint(v)}`);
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'lynox-held-back-ledger-'));
      db = new EngineDb(join(dir, 'engine.db'));
      conn = new ConnectionStore(db);
      vault.clear();
      store = new ApiStore();
      store.setConnectionStore(conn);
      store.setGrantLedger(new GrantLedger(db.getDb()));
      store.setFingerprinter({ keyCheck: 'check-k', ofValue: fp, tokenOfValue: tok, read: (name, hash) => hash(vault.get(name) ?? '') });
    });
    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const crmOn = (refreshSlot: string): ApiProfile => {
      const p = oauth('crm', 'crm.example', { client_id_key: 'C_ID', client_secret_key: 'C_SECRET', refresh_token_key: refreshSlot });
      return { ...p, auth: { ...p.auth!, vault_keys: [] } };
    };
    const consent = (id: string, access: string, refresh: string): void => {
      vault.set(accessTokenKey(id), access);
      vault.set(refreshTokenKey(id), refresh);
      const current = store.get(id)!;
      expect(store.save({ ...current, oauth_grant: { ...current.oauth_grant, written: [{ name: accessTokenKey(id), fp: fp(access) }, { name: refreshTokenKey(id), fp: fp(refresh) }] } }, undefined,
        { newConsent: true, consentRefresh: refresh }).ok).toBe(true);
    };
    const foreignOf = (id: string): string[] | undefined => store.get(id)?.oauth_grant?.foreign;

    it('a refresh slot a held-back profile configures for a password is never marked', () => {
      vault.set('SHOP_PASSWORD', 'hunter2');
      expect(store.register(bearer('shop-a', 'sibling.example', 'SIBLING_KEY'), 'load')).toBe(true);
      expect(store.register(basic('shop_a', 'shop.example', 'SHOP_USER', 'SHOP_PASSWORD'), 'load')).toBe(false);
      expect(store.save(crmOn('SHOP_PASSWORD')).ok).toBe(true);
      consent('crm', 'acc-B', 'ref-B');
      expect(foreignOf('crm')).toBeUndefined();
    });

    it('control: with no profile configuring it for a password, the value there is marked foreign', () => {
      vault.set('SHOP_PASSWORD', 'hunter2');
      expect(store.save(crmOn('SHOP_PASSWORD')).ok).toBe(true);
      consent('crm', 'acc-B', 'ref-B');
      expect(foreignOf('crm')).toEqual([tok('hunter2')]);
    });

    // The write throws after the corrected profile was admitted; the previous version goes back
    // as the registered profile it was, not measured against the profile the boot held back.
    const failedSave = (): void => {
      const corrected = basic('crm', 'api.crm.example', 'CRM_USER', 'CRM_PASSWORD');
      vi.spyOn(conn, 'upsert').mockImplementation(() => { throw new Error('disk full'); });
      expect(() => store.save(corrected)).toThrow('disk full');
    };

    it('a save whose write throws registers the previous version again, beside a held-back rival', () => {
      expect(store.register(crm(), 'load')).toBe(true);
      expect(store.register(shopOnOwnSlot(), 'load')).toBe(false);
      failedSave();
      expect(store.get('crm')?.auth?.password_key).toBe('SHOP_API_ACCESS_TOKEN');
      expect(store.knownProfiles().filter((p) => p.id === 'crm')).toHaveLength(1);
    });

    it('control: without the held-back oauth2 profile the previous version is registered again', () => {
      expect(store.register(crm(), 'load')).toBe(true);
      failedSave();
      expect(store.get('crm')?.auth?.password_key).toBe('SHOP_API_ACCESS_TOKEN');
    });

    it.each([
      ['holder then deriver', [crm, shop]],
      ['deriver then holder', [shop, crm]],
    ] as const)('the kept oauth2 profile takes a new consent after a boot of %s', (_label, order) => {
      for (const p of order) store.register(p(), 'load');
      expect(store.get('crm')).toBeUndefined();
      consent('shop-api', 'acc-1', 'ref-1');
      expect(store.get('shop-api')?.oauth_grant?.written?.map((w) => w.name).sort()).toEqual(['SHOP_API_ACCESS_TOKEN', 'SHOP_API_REFRESH_TOKEN']);
    });

    it('a held-back profile whose corrected save throws in the write stays known as it was stored', () => {
      expect(store.register(shopOnOwnSlot(), 'load')).toBe(false);
      vi.spyOn(conn, 'upsert').mockImplementation(() => { throw new Error('disk full'); });
      expect(() => store.save(shop())).toThrow('disk full');
      expect(store.getAll()).toEqual([]);
      const known = store.knownProfiles();
      expect(ids(known)).toEqual(['shop-api']);
      expect(known[0]!.auth?.oauth?.client_secret_key).toBe('SHOP_API_REFRESH_TOKEN');
    });

    it('control: a new profile whose save throws in the write is not known afterwards', () => {
      vi.spyOn(conn, 'upsert').mockImplementation(() => { throw new Error('disk full'); });
      expect(() => store.save(shop())).toThrow('disk full');
      expect(store.knownProfiles()).toEqual([]);
    });
  });
});
