import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';

/**
 * An oauth2 profile writes every token it gets to its derived pair (`<ID>_ACCESS_TOKEN`,
 * `<ID>_REFRESH_TOKEN`). A name in that pair that another profile signs in with would be
 * replaced by the next token, so the store does not admit the two together — whichever
 * of them arrives second.
 */
describe('ApiStore — a derived token pair another profile signs in with', () => {
  afterEach(() => vi.restoreAllMocks());

  const oauth = (id: string, host: string, over: Partial<NonNullable<NonNullable<ApiProfile['auth']>['oauth']>> = {}): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id,
    auth: { type: 'oauth2', oauth: { token_url: `https://${host}/oauth/token`, grant_type: 'refresh_token', client_id_key: `${id.toUpperCase().replace(/-/g, '_')}_CID`, client_secret_key: `${id.toUpperCase().replace(/-/g, '_')}_CSECRET`, ...over } },
  });
  const bearer = (id: string, host: string, key: string): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id, auth: { type: 'bearer', vault_keys: [key] },
  });
  const basic = (id: string, host: string, username_key: string, password_key: string): ApiProfile => ({
    id, name: id, base_url: `https://${host}/v1`, description: id, auth: { type: 'basic', username_key, password_key },
  });

  const shop = (): ApiProfile => oauth('shop-api', 'api.shop.example');
  // Each a profile that needs a name in shop-api's derived pair.
  const needs: Array<[string, () => ApiProfile, string]> = [
    ['its client secret on the access name', () => oauth('crm', 'api.crm.example', { client_secret_key: 'SHOP_API_ACCESS_TOKEN' }), 'SHOP_API_ACCESS_TOKEN'],
    ['its client id on the refresh name', () => oauth('crm', 'api.crm.example', { client_id_key: 'SHOP_API_REFRESH_TOKEN' }), 'SHOP_API_REFRESH_TOKEN'],
    ['its basic password on the access name', () => basic('crm', 'api.crm.example', 'CRM_USER', 'SHOP_API_ACCESS_TOKEN'), 'SHOP_API_ACCESS_TOKEN'],
    ['its basic user on the refresh name', () => basic('crm', 'api.crm.example', 'SHOP_API_REFRESH_TOKEN', 'CRM_PASSWORD'), 'SHOP_API_REFRESH_TOKEN'],
    // A user_pass_split profile without its own keys signs in with the first two `vault_keys`.
    ['its basic user through vault_keys on the access name', () => ({ ...bearer('crm', 'api.crm.example', 'X'), auth: { type: 'basic', basic_format: 'user_pass_split', vault_keys: ['SHOP_API_ACCESS_TOKEN', 'CRM_PASSWORD'] } }), 'SHOP_API_ACCESS_TOKEN'],
    ['its basic password through vault_keys on the refresh name', () => ({ ...bearer('crm', 'api.crm.example', 'X'), auth: { type: 'basic', basic_format: 'user_pass_split', vault_keys: ['CRM_USER', 'SHOP_API_REFRESH_TOKEN'] } }), 'SHOP_API_REFRESH_TOKEN'],
    // One key of its own: the other comes from its `vault_keys` position, as the attach takes it.
    ['its basic password through vault_keys beside its own username_key', () => ({ ...bearer('crm', 'api.crm.example', 'X'), auth: { type: 'basic', basic_format: 'user_pass_split', username_key: 'CRM_USER', vault_keys: ['CRM_OTHER', 'SHOP_API_ACCESS_TOKEN'] } }), 'SHOP_API_ACCESS_TOKEN'],
    ['its basic user through vault_keys beside its own password_key', () => ({ ...bearer('crm', 'api.crm.example', 'X'), auth: { type: 'basic', basic_format: 'user_pass_split', password_key: 'CRM_PASSWORD', vault_keys: ['SHOP_API_REFRESH_TOKEN', 'CRM_OTHER'] } }), 'SHOP_API_REFRESH_TOKEN'],
  ];

  describe.each(['save', 'load'] as const)('in %s mode', (mode) => {
    it.each(needs)('refuses %s when the oauth2 profile came first', (_label, other, name) => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const store = new ApiStore();
      expect(store.register(shop(), mode)).toBe(true);
      expect(store.register(other(), mode)).toBe(false);
      expect(store.get('crm')).toBeUndefined();
      expect(store.get('shop-api')).toBeDefined();
      expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain(`writes its tokens to ${name}, which api_profile "crm"`);
    });

    if (mode === 'save') {
      it.each(needs)('refuses the oauth2 profile when %s came first', (_label, other, name) => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const store = new ApiStore();
        expect(store.register(other(), mode)).toBe(true);
        expect(store.register(shop(), mode)).toBe(false);
        expect(store.get('shop-api')).toBeUndefined();
        expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain(`api_profile "shop-api" is oauth2 and writes its tokens to ${name}`);
      });
    } else {
      // The boot refuses the profile signing in with the names, never the one whose pair they are.
      // In the other order the holder is registered first, and leaves memory when the oauth2
      // profile arrives: the boot ends the same either way.
      it.each(needs)('keeps the oauth2 profile at boot and drops the holder when %s was loaded first', (_label, other, name) => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const store = new ApiStore();
        expect(store.register(other(), mode)).toBe(true);
        expect(store.register(shop(), mode)).toBe(true);
        expect(store.get('shop-api')).toBeDefined();
        expect(store.get('crm')).toBeUndefined();
        expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain(`Skipping profile "crm": api_profile "shop-api" is oauth2 and writes its tokens to ${name}, which api_profile "crm" signs in with`);
      });

      it('tells the operator how to bring the refused holder back', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const store = new ApiStore();
        store.register(shop(), mode);
        store.register(needs[0]![1](), mode);
        expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain('So profile "crm" is not registered and cannot be used. Nothing was deleted');
      });
    }

    // Sending another profile's token as a key of one's own was a pinned, wanted behaviour until
    // the admission check: it is the profile that sends the name that goes, in either order —
    // refused when it arrives at a save, held back at the boot.
    it('a profile that sends the access token as its key is not admitted beside it, in either order', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const first = new ApiStore();
      expect(first.register(shop(), mode)).toBe(true);
      expect(first.register(bearer('reporting', 'reports.example', 'SHOP_API_ACCESS_TOKEN'), mode)).toBe(false);
      expect(first.get('shop-api')).toBeDefined();
      const second = new ApiStore();
      expect(second.register(bearer('reporting', 'reports.example', 'SHOP_API_ACCESS_TOKEN'), mode)).toBe(true);
      expect(second.register(shop(), mode)).toBe(mode === 'load');
      expect(second.get('reporting') === undefined).toBe(mode === 'load');
    });

    // Renewing with another profile's refresh token without a built-in provider between them is a
    // second claim on the slot (P1): neither is registered at the boot, and a save refuses the one
    // that arrives.
    it('a profile that renews with the other one\'s refresh token is not admitted beside it, in either order', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const sub = (): ApiProfile => oauth('sub', 'api.sub.example', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' });
      const first = new ApiStore();
      expect(first.register(shop(), mode)).toBe(true);
      expect(first.register(sub(), mode)).toBe(false);
      expect(first.get('shop-api') === undefined).toBe(mode === 'load');
      const second = new ApiStore();
      expect(second.register(sub(), mode)).toBe(true);
      expect(second.register(shop(), mode)).toBe(false);
      expect(second.get('sub') === undefined).toBe(mode === 'load');
    });

    it('control: two oauth2 profiles with names of their own are both admitted, and one saves over itself', () => {
      const store = new ApiStore();
      expect(store.register(shop(), mode)).toBe(true);
      expect(store.register(oauth('crm', 'api.crm.example'), mode)).toBe(true);
      expect(store.register(shop(), mode)).toBe(true);
    });
  });

  it('counts a vault_keys position for a key stored as null, as the attach falls back on it', () => {
    const store = new ApiStore();
    expect(store.register(shop(), 'save')).toBe(true);
    const nulled = { type: 'basic', basic_format: 'user_pass_split', username_key: null, vault_keys: ['SHOP_API_ACCESS_TOKEN', 'CRM_PASSWORD'] } as unknown as NonNullable<ApiProfile['auth']>;
    expect(store.register({ ...bearer('crm', 'api.crm.example', 'X'), auth: nulled }, 'save')).toBe(false);
  });

  it('control: a profile that names its own derived refresh slot is not asked against itself', () => {
    const store = new ApiStore();
    const own = oauth('shop-api', 'api.shop.example', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' });
    expect(store.register(own, 'save')).toBe(true);
    expect(store.register(own, 'save')).toBe(true);
  });

  // Every `vault_keys` position counts, not only the ones a basic profile signs in with: the attach
  // and a `secret:` reference send the others. These two were controls ("admitted") until the
  // admission check.
  it.each([
    ['names its own pair, but keeps the oauth2 profile\'s names in vault_keys', { type: 'basic', basic_format: 'user_pass_split', username_key: 'CRM_USER', password_key: 'CRM_PASSWORD', vault_keys: ['SHOP_API_ACCESS_TOKEN', 'SHOP_API_REFRESH_TOKEN'] }],
    ['is pre-encoded, with the oauth2 profile\'s names in vault_keys', { type: 'basic', basic_format: 'pre_encoded_b64', vault_keys: ['SHOP_API_ACCESS_TOKEN', 'SHOP_API_REFRESH_TOKEN'] }],
  ] as const)('refuses a basic profile that %s', (_label, auth) => {
    const store = new ApiStore();
    expect(store.register(shop(), 'save')).toBe(true);
    expect(store.register({ ...bearer('crm', 'api.crm.example', 'X'), auth: { ...auth, vault_keys: [...auth.vault_keys] } }, 'save')).toBe(false);
  });

  it('control: a profile that is not oauth2 derives no pair, so its own names are not asked', () => {
    const store = new ApiStore();
    expect(store.register(bearer('feed', 'feed.example', 'FEED_ACCESS_TOKEN'), 'save')).toBe(true);
    expect(store.register(basic('crm', 'api.crm.example', 'FEED_ACCESS_TOKEN', 'FEED_REFRESH_TOKEN'), 'save')).toBe(true);
  });
});

/**
 * The same rule through the boot's own loaders, which read profiles in an order of their own
 * (file name; created_at, then id). Whichever of the two the boot reads first, it keeps the
 * oauth2 profile and leaves the holder stored but unregistered.
 */
describe('ApiStore — the boot keeps the same profile of a derived-pair clash in either load order', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  const oauth = (id: string): ApiProfile => {
    const slot = id.toUpperCase().replace(/-/g, '_');
    return {
      id, name: id, base_url: `https://${id}.example/v1`, description: id,
      auth: { type: 'oauth2', oauth: { token_url: `https://${id}.example/oauth/token`, grant_type: 'refresh_token', client_id_key: `${slot}_CID`, client_secret_key: `${slot}_CSECRET` } },
    };
  };
  const holder = (id: string, password_key: string): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example/v1`, description: id,
    auth: { type: 'basic', username_key: `${id.toUpperCase().replace(/-/g, '_')}_USER`, password_key },
  });

  // [order, oauth2 id, holder id]: ids chosen so the loaders read them in the named order.
  const orders = [
    ['the holder first', 'shop-api', 'aaa-crm'],
    ['the oauth2 profile first', 'shop-api', 'zzz-crm'],
  ] as const;

  type Booted = { store: ApiStore; loaded: number; stored: (id: string) => boolean };
  const fromDirectory = (profiles: ApiProfile[]): Booted => {
    const dir = tmp('lynox-boot-order-');
    for (const p of profiles) writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p));
    const store = new ApiStore();
    const loaded = store.loadFromDirectory(dir);
    return { store, loaded, stored: (id) => existsSync(join(dir, `${id}.json`)) };
  };
  const fromConnections = (profiles: ApiProfile[]): Booted => {
    const engine = new EngineDb(join(tmp('lynox-boot-order-db-'), 'engine.db'), '');
    engines.push(engine);
    const cs = new ConnectionStore(engine);
    // Written in id order, so created_at and the id tiebreaker agree on the read order.
    for (const p of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
      const { id, name, ...rest } = p;
      cs.upsert({ id, kind: 'api', name, subjectId: null, direction: 'outbound', configJson: JSON.stringify(rest), vaultKeys: [], status: 'active' });
    }
    const store = new ApiStore();
    store.setConnectionStore(cs);
    const loaded = store.loadFromConnections(cs);
    return { store, loaded, stored: (id) => cs.get(id) !== undefined };
  };

  it('registers neither of two files that carry one id', () => {
    // Only the directory can hold this: a connections row is keyed by its id. Neither file is the
    // stored profile, so the boot registers neither; both stay on disk.
    const dir = tmp('lynox-boot-dup-');
    for (const file of ['a.json', 'b.json']) writeFileSync(join(dir, file), JSON.stringify(oauth('shop-api')));
    const store = new ApiStore();
    expect(store.loadFromDirectory(dir)).toBe(0);
    expect(store.size).toBe(0);
    expect(existsSync(join(dir, 'a.json')) && existsSync(join(dir, 'b.json'))).toBe(true);
  });

  describe.each([['loadFromDirectory', fromDirectory], ['loadFromConnections', fromConnections]] as const)('through %s', (_loader, boot) => {
    it.each(orders)('reading %s: keeps the oauth2 profile, leaves the holder stored and unregistered', (_order, deriver, held) => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { store, loaded, stored } = boot([oauth(deriver), holder(held, 'SHOP_API_ACCESS_TOKEN')]);
      expect(store.get(deriver)).toBeDefined();
      // The loader reports what the store holds at the end, not what landed on the way.
      expect(loaded).toBe(1);
      expect(store.get(held)).toBeUndefined();
      // Its host is released with it: no request resolves to the unregistered profile, and a
      // profile saved for that host later is not refused as a second one there.
      expect(store.getByHostname(`${held}.example`)).toBeUndefined();
      const successor: ApiProfile = { id: 'successor', name: 'successor', base_url: `https://${held}.example/v2`, description: 'successor', auth: { type: 'bearer', vault_keys: ['SUCCESSOR_KEY'] } };
      expect(store.register(successor, 'save')).toBe(true);
      expect(stored(held)).toBe(true);
      expect(stored(deriver)).toBe(true);
      const logged = vi.mocked(process.stderr.write).mock.calls.join('');
      expect(logged).toContain(`Skipping profile "${held}": api_profile "${deriver}" is oauth2 and writes its tokens to SHOP_API_ACCESS_TOKEN, which api_profile "${held}" signs in with`);
      expect(logged).toContain('Nothing was deleted');
    });

    it('drops every holder loaded before it, not only the first', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { store } = boot([holder('aaa-crm', 'SHOP_API_ACCESS_TOKEN'), holder('bbb-erp', 'SHOP_API_REFRESH_TOKEN'), oauth('shop-api')]);
      expect(store.get('shop-api')).toBeDefined();
      expect(store.get('aaa-crm')).toBeUndefined();
      expect(store.get('bbb-erp')).toBeUndefined();
    });

    // Until the admission check this read "drops no one": the holder stayed registered. A profile
    // held back for a reason of its own is still stored and still claims its pair, so its partner
    // goes as well.
    it('drops the holder of an oauth2 profile the boot refuses on its own account, in either order', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      for (const id of ['aaa-crm', 'zzz-crm']) {
        const { store } = boot([holder(id, 'MAIL_ACCOUNT_FOO_ACCESS_TOKEN'), oauth('mail-account-foo')]);
        expect(store.get('mail-account-foo')).toBeUndefined();
        expect(store.get(id)).toBeUndefined();
        expect(store.getByHostname(`${id}.example`)).toBeUndefined();
      }
    });

    // Was a control ("stays registered") until the admission check.
    it('holds back a profile that sends the access token as its key, in either order', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      for (const sender of ['aaa-report', 'zzz-report']) {
        const { store } = boot([oauth('shop-api'), { ...holder(sender, 'X'), auth: { type: 'bearer', vault_keys: ['SHOP_API_ACCESS_TOKEN'] } }]);
        expect(store.get('shop-api')).toBeDefined();
        expect(store.get(sender)).toBeUndefined();
      }
    });
  });
});

