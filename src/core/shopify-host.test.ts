import { describe, it, expect } from 'vitest';
import { isShopifyAdminHost, isShopifyAdminUrl, SHOPIFY_UNAVAILABLE } from './shopify-host.js';

describe('isShopifyAdminHost', () => {
  it.each([
    'shop.myshopify.com',
    'SHOP.MyShopify.COM',
    'shop.myshopify.com.',
    'shop.myshopify.com..',
    'a.b.myshopify.com',
    'myshopify.com',
  ])('counts %s as a Shopify store', (host) => {
    expect(isShopifyAdminHost(host)).toBe(true);
  });

  it.each([
    'myshopify.com.example.com',
    'notmyshopify.com',
    'shop-myshopify.com',
    'shop.myshopify.co',
    'shopify.com',
    'example.com',
    '',
  ])('does not count %s', (host) => {
    expect(isShopifyAdminHost(host)).toBe(false);
  });
});

describe('isShopifyAdminUrl', () => {
  it('reads the host the URL parser reads, with trailing dots and any case', () => {
    expect(isShopifyAdminUrl('https://Shop.MYSHOPIFY.com./admin/api/2026-10/graphql.json')).toBe(true);
    expect(isShopifyAdminUrl('https://user@shop.myshopify.com:443/x')).toBe(true);
  });

  it('does not count a store name that is only in the path, the query or the userinfo', () => {
    expect(isShopifyAdminUrl('https://example.com/shop.myshopify.com')).toBe(false);
    expect(isShopifyAdminUrl('https://example.com/?h=shop.myshopify.com')).toBe(false);
    expect(isShopifyAdminUrl('https://shop.myshopify.com@example.com/')).toBe(false);
  });

  it('is false for a value that is not a URL', () => {
    expect(isShopifyAdminUrl('not a url')).toBe(false);
  });
});

// The refusal is read by the model and passed on to the user. It has to say that Shopify as a
// whole is unavailable, so that neither repairs a profile or a credential, and nothing else.
describe('SHOPIFY_UNAVAILABLE', () => {
  it('says Shopify is unavailable for now, that the profile is not at fault, and what to tell the user', () => {
    expect(SHOPIFY_UNAVAILABLE).toBe(
      'Shopify cannot be connected in lynox at the moment: lynox sends no API requests and no credentials to Shopify stores (*.myshopify.com) while it reworks how Shopify connections are set up. This is not a problem with the api_profile or the credential, so do not change either and do not retry; tell the user that Shopify is temporarily unavailable in lynox.',
    );
  });
});
