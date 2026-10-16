import { describe, it, expect, vi, afterEach } from 'vitest';
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
    // The basic attach falls back to the first two `vault_keys` for the pair.
    ['its basic user through vault_keys on the access name', () => ({ ...bearer('crm', 'api.crm.example', 'SHOP_API_ACCESS_TOKEN'), auth: { type: 'basic', vault_keys: ['SHOP_API_ACCESS_TOKEN', 'CRM_PASSWORD'] } }), 'SHOP_API_ACCESS_TOKEN'],
    ['its basic password through vault_keys on the refresh name', () => ({ ...bearer('crm', 'api.crm.example', 'CRM_USER'), auth: { type: 'basic', vault_keys: ['CRM_USER', 'SHOP_API_REFRESH_TOKEN'] } }), 'SHOP_API_REFRESH_TOKEN'],
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
      // The boot never drops the oauth2 profile, whose connection works: a holder stored before it stays as it was.
      it.each(needs)('keeps the oauth2 profile and the holder when %s was stored first', (_label, other) => {
        const store = new ApiStore();
        expect(store.register(other(), mode)).toBe(true);
        expect(store.register(shop(), mode)).toBe(true);
        expect(store.get('crm')).toBeDefined();
      });

      it('tells the operator how to bring the refused holder back', () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const store = new ApiStore();
        store.register(shop(), mode);
        store.register(needs[0]![1](), mode);
        expect(vi.mocked(process.stderr.write).mock.calls.join('')).toContain('So profile "crm" is not registered and cannot be used. Nothing was deleted');
      });
    }

    it('control: a profile that sends the access token on purpose is admitted, in either order', () => {
      const first = new ApiStore();
      expect(first.register(shop(), mode)).toBe(true);
      expect(first.register(bearer('reporting', 'reports.example', 'SHOP_API_ACCESS_TOKEN'), mode)).toBe(true);
      const second = new ApiStore();
      expect(second.register(bearer('reporting', 'reports.example', 'SHOP_API_ACCESS_TOKEN'), mode)).toBe(true);
      expect(second.register(shop(), mode)).toBe(true);
    });

    it('control: a profile that renews with the other one\'s refresh token on purpose is admitted, in either order', () => {
      const sub = (): ApiProfile => oauth('sub', 'api.sub.example', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' });
      const first = new ApiStore();
      expect(first.register(shop(), mode)).toBe(true);
      expect(first.register(sub(), mode)).toBe(true);
      const second = new ApiStore();
      expect(second.register(sub(), mode)).toBe(true);
      expect(second.register(shop(), mode)).toBe(true);
    });

    it('control: two oauth2 profiles with names of their own are both admitted, and one saves over itself', () => {
      const store = new ApiStore();
      expect(store.register(shop(), mode)).toBe(true);
      expect(store.register(oauth('crm', 'api.crm.example'), mode)).toBe(true);
      expect(store.register(shop(), mode)).toBe(true);
    });
  });

  it('control: a profile that names its own derived refresh slot is not asked against itself', () => {
    const store = new ApiStore();
    const own = oauth('shop-api', 'api.shop.example', { refresh_token_key: 'SHOP_API_REFRESH_TOKEN' });
    expect(store.register(own, 'save')).toBe(true);
    expect(store.register(own, 'save')).toBe(true);
  });

  it('control: a profile that is not oauth2 derives no pair, so its own names are not asked', () => {
    const store = new ApiStore();
    expect(store.register(bearer('feed', 'feed.example', 'FEED_ACCESS_TOKEN'), 'save')).toBe(true);
    expect(store.register(basic('crm', 'api.crm.example', 'FEED_ACCESS_TOKEN', 'FEED_REFRESH_TOKEN'), 'save')).toBe(true);
  });
});
