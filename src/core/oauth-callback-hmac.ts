/**
 * The signature Shopify puts on the redirect back from its authorize page.
 *
 * Shopify signs the callback's query: every parameter but `hmac`, sorted by name,
 * joined as `name=value` with `&`, HMAC-SHA256 under the app's client secret, hex.
 * The values are taken as received, URL-decoded once and nothing else: in
 * particular `shop` is not lower-cased before the check, because Shopify signed
 * what it sent, not what lynox would store.
 *
 * This is a check ON TOP of the state cookie, not instead of it. The cookie says
 * lynox started this flow; the signature says the provider, holding the secret,
 * sent this redirect, so a forged `shop` cannot ride along with a genuine code.
 *
 * Fail-closed on every shape the message cannot be rebuilt from without a
 * choice: a name given twice, and a `&` or `%` in a name or value, or a `=` in a
 * name, which would make two different queries sign the same text. Shopify's
 * documented callback carries `code`, `hmac`, `host`, `shop`, `state` and
 * `timestamp`; whether a real one ever carries such a character is not measured,
 * and if it does, the callback is refused rather than guessed at.
 *
 * Tested with constructed vectors only, built with the secret the test holds. No
 * redirect from a real Shopify store has gone through it yet.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How far `timestamp` may lie from the instance's clock, in seconds, either way.
 * The redirect comes right after the merchant's click, so its age is the time the
 * browser took to follow it; five minutes leaves room for a slow clock on either
 * side without keeping a captured redirect usable for long. A lynox choice, not a
 * number Shopify names.
 */
export const SHOPIFY_CALLBACK_WINDOW_SECONDS = 300;

export type ShopifyCallbackVerdict =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason:
      | 'no-secret'
      | 'missing-hmac'
      | 'malformed-hmac'
      | 'repeated-param'
      | 'unsignable-param'
      | 'signature-mismatch'
      | 'missing-timestamp'
      | 'timestamp-outside-window';
  };

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Check the redirect's signature and its age.
 *
 * `rawQuery` is the query as it arrived, without the leading `?`. `nowMs` is the
 * instance's clock; a parameter so the window can be tested at its edges.
 */
export function verifyShopifyCallback(
  rawQuery: string,
  clientSecret: string,
  nowMs: number,
): ShopifyCallbackVerdict {
  if (clientSecret === '') return { ok: false, reason: 'no-secret' };

  const params = new URLSearchParams(rawQuery);
  const seen = new Set<string>();
  const signed: [string, string][] = [];
  let hmac: string | undefined;
  for (const [name, value] of params) {
    if (seen.has(name)) return { ok: false, reason: 'repeated-param' };
    seen.add(name);
    if (name === 'hmac') {
      hmac = value;
      continue;
    }
    if (/[&%=]/.test(name) || /[&%]/.test(value)) return { ok: false, reason: 'unsignable-param' };
    signed.push([name, value]);
  }

  if (hmac === undefined) return { ok: false, reason: 'missing-hmac' };
  // Lower-case hex only, the form Shopify's samples show; anything else is
  // refused rather than normalised. The length check is also what keeps
  // `timingSafeEqual` below from throwing.
  if (!HEX_SHA256.test(hmac)) return { ok: false, reason: 'malformed-hmac' };

  // Sorted by code unit, as Shopify's own samples sort: the comparison is on the
  // names, which are ASCII.
  signed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = signed.map(([name, value]) => `${name}=${value}`).join('&');
  const expected = createHmac('sha256', clientSecret).update(message, 'utf8').digest();
  if (!timingSafeEqual(expected, Buffer.from(hmac, 'hex'))) return { ok: false, reason: 'signature-mismatch' };

  // The age is checked on a signed value only: before the signature, `timestamp`
  // is whatever the sender wrote.
  const timestamp = params.get('timestamp');
  if (timestamp === null || !/^[0-9]{1,15}$/.test(timestamp)) return { ok: false, reason: 'missing-timestamp' };
  const ageSeconds = nowMs / 1000 - Number(timestamp);
  if (Math.abs(ageSeconds) > SHOPIFY_CALLBACK_WINDOW_SECONDS) return { ok: false, reason: 'timestamp-outside-window' };

  return { ok: true };
}
