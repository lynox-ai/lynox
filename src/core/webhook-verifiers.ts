/**
 * How an inbound webhook delivery is verified, per provider kind, and the route token that
 * selects its trigger.
 *
 * A trigger names its verifier in `condition_json.webhook`. Verification reads the raw request
 * bytes and nothing parsed from them; no header outside the signature is authentication.
 *
 * - `shopify-hmac`: base64 HMAC-SHA256 of the raw body under the Shopify app's client secret,
 *   compared in constant time with `X-Shopify-Hmac-SHA256`. Shopify's other headers (topic,
 *   webhook id, shop domain) are outside the HMAC.
 * - `shared-token`: a random token the provider sends in `X-Lynox-Webhook-Token`, for providers
 *   that sign nothing. The trigger keeps only its SHA-256. Weaker than a signature: whoever has
 *   seen one request can send any body.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type WebhookVerifierKind = 'shopify-hmac' | 'shared-token';

export interface WebhookSpec {
  verifier: WebhookVerifierKind;
  /** `shared-token` only: SHA-256 (hex) of the token the provider sends. */
  sharedTokenHash?: string | undefined;
}

/** 32 random bytes as base64url, no padding: 256 bits in 43 characters. */
export const ROUTE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256';
export const SHOPIFY_SHOP_HEADER = 'x-shopify-shop-domain';
export const SHARED_TOKEN_HEADER = 'x-lynox-webhook-token';

/** A new route token and the hash a trigger stores in its place. */
export function mintRouteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRouteToken(token) };
}

export function hashRouteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The trigger's verifier from its `condition_json`, or `null` when it names none this engine
 * knows or is malformed. A `shared-token` spec without its hash is malformed.
 */
export function parseWebhookSpec(conditionJson: string): WebhookSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conditionJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const spec: unknown = (parsed as Record<string, unknown>)['webhook'];
  if (typeof spec !== 'object' || spec === null) return null;
  const verifier: unknown = (spec as Record<string, unknown>)['verifier'];
  if (verifier === 'shopify-hmac') return { verifier };
  if (verifier === 'shared-token') {
    const hash: unknown = (spec as Record<string, unknown>)['shared_token_hash'];
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    return { verifier, sharedTokenHash: hash };
  }
  return null;
}

/** Whether `header` is the base64 HMAC-SHA256 of `body` under `secret`. */
export function verifyShopifyHmac(body: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || secret === '') return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(header, 'base64');
  // Base64 decoding skips characters it does not know, so re-encode and compare the text too:
  // only the canonical form of the right bytes passes.
  if (given.length !== expected.length || given.toString('base64') !== header) return false;
  return timingSafeEqual(given, expected);
}

/** Whether `header` is the token whose SHA-256 the trigger keeps. */
export function verifySharedToken(header: string | undefined, storedHash: string): boolean {
  if (header === undefined || header === '') return false;
  const given = createHash('sha256').update(header, 'utf8').digest();
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === given.length && timingSafeEqual(given, stored);
}

/**
 * The ledger's dedup key for a verified body: the SHA-256 of its exact bytes, under a scope.
 * Shopify's body carries a resource id, not an event id (`orders/create` and `orders/paid` of
 * one order share it), so an id would turn the second legitimate event into a duplicate.
 *
 * The scope follows who can produce a valid delivery. One Shopify app secret verifies at every
 * Shopify trigger of the instance, so a Shopify body is keyed for the whole instance and starts
 * at most one run there. A shared token belongs to one trigger, and its sender chooses any body:
 * keyed per trigger, so it can neither record the key of a Shopify body nor that of another
 * trigger's sender.
 */
export function bodyDedupKey(kind: WebhookVerifierKind, triggerId: string, body: Buffer): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return kind === 'shopify-hmac' ? `shopify-hmac:sha256:${digest}` : `shared-token:${triggerId}:sha256:${digest}`;
}
