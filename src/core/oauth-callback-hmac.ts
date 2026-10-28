/**
 * The signature Shopify puts on the redirect back from its authorize page.
 *
 * Shopify's documentation says only: remove `hmac`, sort, HMAC-SHA256 under the
 * app's client secret, compare in constant time. How the values are written into
 * the signed text it does not say, so this follows Shopify's own library
 * (`@shopify/shopify-api`, `lib/utils/hmac-validator.ts` with
 * `processed-query.ts`, read at shopify-app-js `d282da59`): drop `hmac`, sort
 * the names with `localeCompare`, write the pairs back with `URLSearchParams`
 * and turn its `+` into `%20`. The values are re-encoded, not signed as decoded:
 * a base64 `host` ending in `==` is signed as `%3D%3D`.
 *
 * One deliberate difference: the library also drops a `signature` parameter.
 * Here it is signed like any other, so a callback that carries one is refused
 * unless the signature covers it. Dropping it would let an unsigned value through
 * in the map this returns.
 *
 * This is a check ON TOP of the state cookie, not instead of it. The cookie says
 * lynox started this flow; the signature says a party holding the secret sent
 * these parameters. It does NOT say they are about the profile's store: an app
 * installed on several stores gets genuine signatures for each of them. The
 * caller compares `shop` with the store the profile names before it uses the
 * code, and reads the values from the map this returns, not from a second parse.
 * Every entry in that map is covered by the signature except `hmac` itself.
 *
 * Fail-closed on a name given twice: a callback has no reason to repeat one, and
 * readers differ on which copy counts.
 *
 * Tested against one published example (a third-party library's docs) and
 * vectors built with the library's procedure. No redirect from a real Shopify
 * store had gone through it before October 2026. Why one is refused goes to the
 * server log ({@link shopifyCallbackRefusalLine}); the page does not say.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How far `timestamp` may lie from the instance's clock, in seconds, either way.
 * Shopify's library uses the same 90 seconds
 * (`HMAC_TIMESTAMP_PERMITTED_CLOCK_TOLERANCE_SEC`).
 */
export const SHOPIFY_CALLBACK_WINDOW_SECONDS = 90;

/**
 * The store domain as Shopify's OAuth documentation checks it, anchored at both
 * ends. Stricter than the library's `sanitizeShop`, which also takes `_` and
 * other Shopify domains.
 */
const SHOPIFY_SHOP = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** What the authorize redirect has to carry beyond the signature. */
const REQUIRED = ['code', 'shop', 'state'] as const;

export type ShopifyCallbackVerdict =
  | { readonly ok: true; readonly params: ReadonlyMap<string, string> }
  | {
    readonly ok: false;
    readonly reason:
      | 'no-secret'
      | 'missing-hmac'
      | 'malformed-hmac'
      | 'repeated-param'
      | 'signature-mismatch'
      | 'missing-param'
      | 'bad-shop'
      | 'bad-timestamp'
      | 'timestamp-outside-window';
  };

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Check the redirect's signature, the parameters a code exchange needs, and the
 * redirect's age.
 *
 * `rawQuery` is the query as it arrived, with or without the leading `?`.
 * `nowMs` is the instance's clock; a parameter so the window can be tested at
 * its edges.
 */
export function verifyShopifyCallback(
  rawQuery: string,
  clientSecret: string,
  nowMs: number,
): ShopifyCallbackVerdict {
  if (clientSecret === '') return { ok: false, reason: 'no-secret' };

  const params = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(rawQuery)) {
    if (params.has(name)) return { ok: false, reason: 'repeated-param' };
    params.set(name, value);
  }

  const hmac = params.get('hmac');
  if (hmac === undefined) return { ok: false, reason: 'missing-hmac' };
  // Lower-case hex only, which is what Shopify's library produces (`HashFormat.Hex`);
  // anything else is refused rather than normalised. The length check is also what
  // keeps `timingSafeEqual` below from throwing.
  if (!HEX_SHA256.test(hmac)) return { ok: false, reason: 'malformed-hmac' };

  const signed = new URLSearchParams();
  for (const name of [...params.keys()].filter((n) => n !== 'hmac').sort((a, b) => a.localeCompare(b))) {
    signed.append(name, params.get(name) ?? '');
  }
  const message = signed.toString().replace(/\+/g, '%20');
  const expected = createHmac('sha256', clientSecret).update(message, 'utf8').digest();
  if (!timingSafeEqual(expected, Buffer.from(hmac, 'hex'))) return { ok: false, reason: 'signature-mismatch' };

  // Everything below reads signed values only.
  if (REQUIRED.some((name) => (params.get(name) ?? '') === '')) return { ok: false, reason: 'missing-param' };
  if (!SHOPIFY_SHOP.test(params.get('shop') ?? '')) return { ok: false, reason: 'bad-shop' };

  const timestamp = params.get('timestamp');
  if (timestamp === undefined || !/^[0-9]{1,15}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  // Written as "inside", so a clock that is not a number fails it.
  const ageSeconds = nowMs / 1000 - Number(timestamp);
  if (!(Math.abs(ageSeconds) <= SHOPIFY_CALLBACK_WINDOW_SECONDS)) return { ok: false, reason: 'timestamp-outside-window' };

  return { ok: true, params };
}

/**
 * A Shopify callback that passed {@link verifyShopifyCallback} and names the store of the profile
 * it lands on. Made only by {@link bindShopifyCallback}. `origin` is `https://<shop>.myshopify.com`,
 * lower case and without a trailing dot.
 */
export interface VerifiedStoreCallback {
  readonly profileId: string;
  readonly origin: string;
}

export type ShopifyCallbackBinding =
  | { readonly ok: true; readonly binding: VerifiedStoreCallback; readonly code: string }
  | { readonly ok: false; readonly reason: Extract<ShopifyCallbackVerdict, { ok: false }>['reason'] | 'not-a-store-profile' | 'other-store' };

/**
 * Verify a Shopify callback and bind it to the profile it lands on: the signed `shop`, in lower
 * case, has to be the host the profile's own parameter derives (`storeHost`, from
 * `presetStoreHost`, `null` when the profile has none). The code the caller exchanges comes from
 * the signed values, not from a second parse of the query.
 */
export function bindShopifyCallback(
  rawQuery: string,
  clientSecret: string,
  nowMs: number,
  profileId: string,
  storeHost: string | null,
): ShopifyCallbackBinding {
  const verdict = verifyShopifyCallback(rawQuery, clientSecret, nowMs);
  if (!verdict.ok) return verdict;
  if (storeHost === null) return { ok: false, reason: 'not-a-store-profile' };
  const shop = (verdict.params.get('shop') ?? '').toLowerCase();
  if (shop !== storeHost) return { ok: false, reason: 'other-store' };
  return {
    ok: true,
    binding: { profileId, origin: `https://${shop}` },
    code: verdict.params.get('code') ?? '',
  };
}

/** A query parameter name that is written into the log as it is; anything else is only counted. */
const LOGGABLE_PARAM = /^[a-z_]{1,32}$/;
/** A profile id written into the log as it is; anything else is replaced. */
const LOGGABLE_PROFILE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The server-log line for a refused Shopify callback: the reason, the profile and the NAMES of the
 * query parameters, sorted. Never a value: the query carries the code, the state and the signature,
 * and none of them belongs in a log. A name outside a plain lower-case pattern is counted, not
 * written, since the query is whatever the browser was sent to, and the line must stay one line.
 */
export function shopifyCallbackRefusalLine(
  reason: Extract<ShopifyCallbackBinding, { ok: false }>['reason'],
  profileId: string,
  rawQuery: string,
): string {
  const names = new Set<string>();
  let other = 0;
  for (const name of new URLSearchParams(rawQuery).keys()) {
    if (LOGGABLE_PARAM.test(name)) names.add(name);
    else other++;
  }
  const listed = [...names].sort((a, b) => a.localeCompare(b)).join(',');
  const profile = LOGGABLE_PROFILE.test(profileId) ? profileId : '(unprintable)';
  const extra = other > 0 ? ` +${String(other)} other` : '';
  return `[lynox] shopify callback refused: reason=${reason} profile=${profile} params=${listed === '' ? '(none)' : listed}${extra}\n`;
}
