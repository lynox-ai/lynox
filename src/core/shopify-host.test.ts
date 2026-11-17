import { describe, it, expect } from 'vitest';
import * as host from './shopify-host.js';
import { clearanceRefusalText, isShopifyAdminHost, isShopifyAdminUrl, SHOPIFY_NOT_CLEARED, SHOPIFY_NOT_SET_UP, SHOPIFY_UNCONFIRMED } from './shopify-host.js';
import type { ExactClearanceRefusal } from './exact-clearance.js';

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

// Each refusal is read by the model and passed on to the user, so each names its own cause. None
// says "temporarily": no refusal here has an end the engine knows of.
describe('the refusals of a request to a Shopify store', () => {
  const sentences = Object.entries(host).filter(([name, v]) => name.startsWith('SHOPIFY_') && typeof v === 'string') as Array<[string, string]>;

  it('are nine distinct sentences, none of them "temporarily" or about a rework', () => {
    expect(sentences.map(([n]) => n).sort()).toEqual([
      'SHOPIFY_CREDENTIAL_REFERENCE', 'SHOPIFY_FETCH_TOKEN', 'SHOPIFY_HOST_HEADER', 'SHOPIFY_NOT_CLEARED', 'SHOPIFY_NOT_SET_UP',
      'SHOPIFY_PAGES', 'SHOPIFY_REDIRECT', 'SHOPIFY_SELF_HOSTED', 'SHOPIFY_UNCONFIRMED',
    ]);
    expect(new Set(sentences.map(([, v]) => v)).size).toBe(sentences.length);
    for (const [, v] of sentences) expect(v).not.toMatch(/temporar|rework/i);
  });

  it('the credential sentence tells the model to send again without the reference', () => {
    expect(host.SHOPIFY_CREDENTIAL_REFERENCE).toBe('a request to a Shopify store may not carry a credential reference (secret:…). Remove it and send the request again; the engine attaches the store connection itself.');
  });
});

// The control plane's answer decides which sentence a refused clearance gets, never the time: a
// refusal and an unanswered ask back off for the same 60 s.
describe('clearanceRefusalText', () => {
  const unconfirmed: ExactClearanceRefusal[] = ['busy', 'rate_limited', 'unreachable', 'timeout', 'server_error', 'no_answer'];
  const refused: ExactClearanceRefusal[] = ['not_tenant_host', 'below_floor', 'no_floor'];

  it.each(unconfirmed)('%s: could not confirm, try again later', (reason) => {
    expect(clearanceRefusalText(reason)).toBe(SHOPIFY_UNCONFIRMED);
    expect(clearanceRefusalText('backoff', reason)).toBe(SHOPIFY_UNCONFIRMED);
  });

  it.each(refused)('%s: not cleared, retrying changes nothing', (reason) => {
    expect(clearanceRefusalText(reason)).toBe(SHOPIFY_NOT_CLEARED);
    expect(clearanceRefusalText('backoff', reason)).toBe(SHOPIFY_NOT_CLEARED);
  });

  it('an unprovisioned engine and an unwritable marker read as not set up, held or not', () => {
    expect(clearanceRefusalText('not_provisioned')).toBe(SHOPIFY_NOT_SET_UP);
    expect(clearanceRefusalText('marker_unwritable')).toBe(SHOPIFY_NOT_SET_UP);
    expect(clearanceRefusalText('backoff', 'marker_unwritable')).toBe(SHOPIFY_NOT_SET_UP);
  });

  it('a backoff whose cause ran out between the two reads reads as one to ask again later', () => {
    expect(clearanceRefusalText('backoff', null)).toBe(SHOPIFY_UNCONFIRMED);
    expect(clearanceRefusalText('backoff')).toBe(SHOPIFY_UNCONFIRMED);
  });
});

// The sentences as they were measured with models (both providers): a change to one is a change
// to measured behaviour, and has to be measured again before this test is updated.
describe('the refusal sentences, verbatim', () => {
  it.each([
    ['SHOPIFY_CREDENTIAL_REFERENCE', "a request to a Shopify store may not carry a credential reference (secret:\u2026). Remove it and send the request again; the engine attaches the store connection itself."],
    ['SHOPIFY_SELF_HOSTED', "lynox reaches Shopify stores (*.myshopify.com) only on an instance that lynox runs, and this instance is self-hosted, so nothing was sent. Retrying, another profile, credential or address does not change that. Tell the user that Shopify stores can be reached only on an instance run by lynox."],
    ['SHOPIFY_NOT_SET_UP', "Shopify is not set up on this instance: a part lynox needs for store requests is missing, so nothing was sent. This is not a problem with the store, a profile or a credential, and retrying does not help. Tell the user that Shopify is not set up on their instance and that lynox has to fix this, not them. Do not offer another way to reach the store."],
    ['SHOPIFY_UNCONFIRMED', "lynox could not confirm that this instance may reach Shopify stores right now, so nothing was sent. Try once more in a few minutes; if it is refused again, tell the user that Shopify cannot be reached from their instance right now and to try again later."],
    ['SHOPIFY_NOT_CLEARED', "lynox has not cleared this instance for Shopify stores right now, so nothing was sent. Retrying does not change that, and do not try to reach the store another way. Tell the user that Shopify is not cleared for their instance right now and that only lynox can clear it."],
    ['SHOPIFY_REDIRECT', "the server redirected this request to a Shopify store, and lynox does not follow a redirect to a store, so nothing was sent there. Do not request the address the redirect named; tell the user the page leads to a Shopify store, and ask what they want to read from their own store."],
    ['SHOPIFY_HOST_HEADER', "a Host header may not name a Shopify store. Remove the Host header; to reach a store, put its address in the URL."],
    ['SHOPIFY_PAGES', "lynox does not open pages on Shopify store hosts (*.myshopify.com), public store pages included. Read a connected store's data with http_request to the store's address; the engine attaches its connection."],
    ['SHOPIFY_FETCH_TOKEN', "lynox gets a Shopify store's token only through api_setup action \"connect\", not through fetch_token. Use connect for this store."],
  ] as const)('%s', (name, text) => {
    expect((host as Record<string, unknown>)[name]).toBe(text);
  });
});
