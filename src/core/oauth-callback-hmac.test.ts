import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SHOPIFY_CALLBACK_WINDOW_SECONDS, verifyShopifyCallback } from './oauth-callback-hmac.js';

// The example several third-party Shopify libraries carry in their docs (shopify_rest,
// shopify_oauth, exshopify on hexdocs.pm), with the secret `hush`. Not computed here: the
// signature is theirs, so a message built in another order or with another join fails it.
const PUBLISHED = {
  query: 'code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173',
  secret: 'hush',
  nowMs: 1337178173 * 1000,
};

/** A query signed the way Shopify signs, for shapes the published example does not have. */
function signed(params: Record<string, string>, secret: string): string {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams({ ...params, hmac }).toString();
}

const SECRET = ['test', 'secret', 'value'].join('-');
const NOW = 1_800_000_000_000;
const BASE = { code: 'abc123', shop: 'demo-store.myshopify.com', state: 'st4te', timestamp: String(NOW / 1000) };

describe('verifyShopifyCallback', () => {
  it('accepts the published example', () => {
    expect(verifyShopifyCallback(PUBLISHED.query, PUBLISHED.secret, PUBLISHED.nowMs)).toEqual({ ok: true });
  });

  it('accepts the published example with its parameters in another order', () => {
    const reordered = 'timestamp=1337178173&state=0.6784241404160823&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&code=0907a61c0c8d55e99db179b68161bc00';
    expect(verifyShopifyCallback(reordered, PUBLISHED.secret, PUBLISHED.nowMs)).toEqual({ ok: true });
  });

  it('refuses the published example under another secret', () => {
    expect(verifyShopifyCallback(PUBLISHED.query, 'hushh', PUBLISHED.nowMs)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('refuses the published example with another shop', () => {
    const forged = PUBLISHED.query.replace('some-shop', 'other-shop');
    expect(verifyShopifyCallback(forged, PUBLISHED.secret, PUBLISHED.nowMs)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('checks the shop as received: an upper-case shop signed as such passes, and lower-casing it breaks the signature', () => {
    const upper = signed({ ...BASE, shop: 'Demo-Store.myshopify.com' }, SECRET);
    expect(verifyShopifyCallback(upper, SECRET, NOW)).toEqual({ ok: true });
    const lowered = upper.replace('Demo-Store', 'demo-store');
    expect(verifyShopifyCallback(lowered, SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('signs the decoded value: a value sent percent-encoded verifies against its decoded form', () => {
    const query = signed({ ...BASE, host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZGVtbw==' }, SECRET);
    expect(query).toContain('%3D%3D');
    expect(verifyShopifyCallback(query, SECRET, NOW)).toEqual({ ok: true });
  });

  it('refuses without a secret, before anything else', () => {
    expect(verifyShopifyCallback(PUBLISHED.query, '', PUBLISHED.nowMs)).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('refuses a callback without hmac', () => {
    const query = new URLSearchParams(BASE).toString();
    expect(verifyShopifyCallback(query, SECRET, NOW)).toEqual({ ok: false, reason: 'missing-hmac' });
  });

  it.each([
    ['upper-case hex', (h: string) => h.toUpperCase()],
    ['one character short', (h: string) => h.slice(1)],
    ['one character long', (h: string) => `${h}0`],
    ['not hex', (h: string) => `${h.slice(1)}g`],
  ])('refuses an hmac that is %s', (_label, change) => {
    const params = new URLSearchParams(signed(BASE, SECRET));
    params.set('hmac', change(params.get('hmac') ?? ''));
    expect(verifyShopifyCallback(params.toString(), SECRET, NOW)).toEqual({ ok: false, reason: 'malformed-hmac' });
  });

  it('refuses a parameter given twice, the hmac included', () => {
    const good = signed(BASE, SECRET);
    expect(verifyShopifyCallback(`${good}&shop=other.myshopify.com`, SECRET, NOW)).toEqual({ ok: false, reason: 'repeated-param' });
    const hmac = new URLSearchParams(good).get('hmac') ?? '';
    expect(verifyShopifyCallback(`${good}&hmac=${hmac}`, SECRET, NOW)).toEqual({ ok: false, reason: 'repeated-param' });
  });

  it.each([
    ['a & in a value', { state: 'a&b' }],
    ['a % in a value', { state: 'a%b' }],
    ['a = in a name', { 'x=y': 'z' }],
    ['a & in a name', { 'x&y': 'z' }],
    ['a % in a name', { 'x%y': 'z' }],
  ])('refuses %s, even when it is signed', (_label, extra) => {
    const query = signed({ ...BASE, ...extra }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW)).toEqual({ ok: false, reason: 'unsignable-param' });
  });

  it('still accepts a = in a value', () => {
    const query = signed({ ...BASE, state: 'a=b' }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW)).toEqual({ ok: true });
  });

  it('refuses a signed callback without a timestamp, or with one that is not a number', () => {
    const { timestamp: _t, ...noTimestamp } = BASE;
    expect(verifyShopifyCallback(signed(noTimestamp, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'missing-timestamp' });
    expect(verifyShopifyCallback(signed({ ...BASE, timestamp: '1e9' }, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'missing-timestamp' });
  });

  it('checks the signature before the age: a forged fresh timestamp is a mismatch', () => {
    const params = new URLSearchParams(signed({ ...BASE, timestamp: String(NOW / 1000 - 3600) }, SECRET));
    params.set('timestamp', String(NOW / 1000));
    expect(verifyShopifyCallback(params.toString(), SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it.each([
    ['at the edge in the past', -SHOPIFY_CALLBACK_WINDOW_SECONDS, true],
    ['at the edge in the future', SHOPIFY_CALLBACK_WINDOW_SECONDS, true],
    ['one second too old', -SHOPIFY_CALLBACK_WINDOW_SECONDS - 1, false],
    ['one second too far ahead', SHOPIFY_CALLBACK_WINDOW_SECONDS + 1, false],
  ])('a timestamp %s', (_label, offset, ok) => {
    const query = signed({ ...BASE, timestamp: String(NOW / 1000 + offset) }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW)).toEqual(ok ? { ok: true } : { ok: false, reason: 'timestamp-outside-window' });
  });

  it('keeps the window at five minutes', () => {
    expect(SHOPIFY_CALLBACK_WINDOW_SECONDS).toBe(300);
  });
});
