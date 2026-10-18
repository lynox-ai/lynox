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

/**
 * A query signed the way Shopify's library signs (`hmac-validator.ts`,
 * `stringifyQueryForAdmin`): sorted with localeCompare, written back through
 * URLSearchParams, `+` as `%20`. It mirrors the code under test, so it shows the
 * procedure is applied consistently; that the procedure is Shopify's rests on the
 * published example above and on the library's source.
 */
function signed(params: Record<string, string>, secret: string): string {
  const message = new URLSearchParams(Object.keys(params).sort((a, b) => a.localeCompare(b)).map((k) => [k, params[k] ?? '']))
    .toString().replace(/\+/g, '%20');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  return new URLSearchParams({ ...params, hmac }).toString();
}

const SECRET = ['test', 'secret', 'value'].join('-');
const NOW = 1_800_000_000_000;
const BASE = { code: 'abc123', shop: 'demo-store.myshopify.com', state: 'st4te', timestamp: String(NOW / 1000) };

describe('verifyShopifyCallback', () => {
  it('accepts the published example and hands back the values it verified', () => {
    const verdict = verifyShopifyCallback(PUBLISHED.query, PUBLISHED.secret, PUBLISHED.nowMs);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.params.get('shop')).toBe('some-shop.myshopify.com');
    expect(verdict.params.get('code')).toBe('0907a61c0c8d55e99db179b68161bc00');
  });

  it('accepts the published example with its parameters in another order, and with a leading ?', () => {
    const reordered = '?timestamp=1337178173&state=0.6784241404160823&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&code=0907a61c0c8d55e99db179b68161bc00';
    expect(verifyShopifyCallback(reordered, PUBLISHED.secret, PUBLISHED.nowMs).ok).toBe(true);
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
    expect(verifyShopifyCallback(upper, SECRET, NOW).ok).toBe(true);
    const lowered = upper.replace('Demo-Store', 'demo-store');
    expect(verifyShopifyCallback(lowered, SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('signs a base64 host re-encoded, as the library does, and not as decoded', () => {
    const host = 'YWRt+aW4/uc2hvcGlmeS5jb20=';
    const query = signed({ ...BASE, host }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW).ok).toBe(true);
    // The same values signed decoded, `name=value` joined: what this module did before.
    const decoded = Object.entries({ ...BASE, host }).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    const naive = new URLSearchParams({ ...BASE, host, hmac: createHmac('sha256', SECRET).update(decoded).digest('hex') }).toString();
    expect(verifyShopifyCallback(naive, SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('signs a space as %20, not as +', () => {
    const query = signed({ ...BASE, state: 'a b' }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW).ok).toBe(true);
    const plus = new URLSearchParams({ ...BASE, state: 'a b' });
    const asPlus = createHmac('sha256', SECRET).update(new URLSearchParams([...plus].sort(([a], [b]) => a.localeCompare(b))).toString()).digest('hex');
    plus.set('hmac', asPlus);
    expect(verifyShopifyCallback(plus.toString(), SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('leaves signature out of the signed text, as it leaves out hmac', () => {
    const query = `${signed(BASE, SECRET)}&signature=anything`;
    expect(verifyShopifyCallback(query, SECRET, NOW).ok).toBe(true);
  });

  it('sorts names the way the library does', () => {
    // Code-unit order puts `B` before `a_b`; localeCompare puts it after.
    const query = signed({ ...BASE, B: '1', a_b: '2' }, SECRET);
    expect(verifyShopifyCallback(query, SECRET, NOW).ok).toBe(true);
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

  it.each(['code', 'shop', 'state'] as const)('refuses a signed callback without %s, or with it empty', (name) => {
    const { [name]: _dropped, ...rest } = BASE;
    expect(verifyShopifyCallback(signed(rest, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'missing-param' });
    expect(verifyShopifyCallback(signed({ ...BASE, [name]: '' }, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'missing-param' });
  });

  it.each([
    ['another domain', 'demo-store.example.com'],
    ['the suffix followed by more', 'demo-store.myshopify.com.attacker.example'],
    ['a leading hyphen', '-demo.myshopify.com'],
    ['a subdomain', 'a.demo.myshopify.com'],
  ])('refuses a signed shop that is %s', (_label, shop) => {
    expect(verifyShopifyCallback(signed({ ...BASE, shop }, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'bad-shop' });
  });

  it.each([
    ['missing', undefined],
    ['a float', '1800000000.0'],
    ['in exponent form', '1.8e9'],
    ['negative', '-1'],
  ])('refuses a signed timestamp that is %s', (_label, timestamp) => {
    const { timestamp: _t, ...rest } = BASE;
    const params = timestamp === undefined ? rest : { ...rest, timestamp };
    expect(verifyShopifyCallback(signed(params, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: 'bad-timestamp' });
  });

  it('checks the signature before the age: a stale callback with a bad hmac is a mismatch, not a stale one', () => {
    const params = new URLSearchParams(signed({ ...BASE, timestamp: String(NOW / 1000 - 3600) }, SECRET));
    params.set('code', 'swapped');
    expect(verifyShopifyCallback(params.toString(), SECRET, NOW)).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it.each([
    ['at the edge in the past', -SHOPIFY_CALLBACK_WINDOW_SECONDS, true],
    ['at the edge in the future', SHOPIFY_CALLBACK_WINDOW_SECONDS, true],
    ['one second too old', -SHOPIFY_CALLBACK_WINDOW_SECONDS - 1, false],
    ['one second too far ahead', SHOPIFY_CALLBACK_WINDOW_SECONDS + 1, false],
  ])('a timestamp %s', (_label, offset, ok) => {
    const verdict = verifyShopifyCallback(signed({ ...BASE, timestamp: String(NOW / 1000 + offset) }, SECRET), SECRET, NOW);
    expect(verdict.ok ? true : verdict.reason).toBe(ok ? true : 'timestamp-outside-window');
  });

  it('refuses when the clock is not a number', () => {
    expect(verifyShopifyCallback(signed(BASE, SECRET), SECRET, Number.NaN)).toEqual({ ok: false, reason: 'timestamp-outside-window' });
  });

  it('keeps the window at the library\'s 90 seconds', () => {
    expect(SHOPIFY_CALLBACK_WINDOW_SECONDS).toBe(90);
  });
});
