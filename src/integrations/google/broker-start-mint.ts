// === The engine half of the broker start token ===
//
// The control plane refuses `GET /oauth/google/start` without a signed token.
// Nothing here minted one, so every brokered tenant's "Connect with Google"
// ended on `?google_oauth_error=missing_token` — measured on staging
// 2026-09-07, one day after the control plane began requiring it.
//
// ⚠ The HMAC lives HERE and not in the contract, on purpose. That directory is
// dependency-free so two repos can compile it standalone, and `node:crypto` is
// a dependency. Each side therefore computes the signature in its own code —
// which is exactly the arrangement that let the two sides drift apart in the
// first place.
//
// What keeps them agreeing is the contract's golden vectors, travelling to the
// control plane with the rest of the contract: `BROKER_START_GOLDEN_V2`, one per
// provider, which this repo's signer must produce over the v2 payload
// (`broker-start-mint.test.ts`) and the control plane's verifier must accept.
// The minter mints v2 only; the v1 vector (`BROKER_START_GOLDEN`) stays pinned
// for the control plane's v1 acceptance until the contract step removes v1.

import { createHmac, randomBytes } from 'node:crypto';
import {
  BROKER_START_NONCE_BYTES,
  BROKER_START_PURPOSE,
  brokerStartPayloadV2,
  formatBrokerStartTokenV2,
} from '../../contract/broker-start.js';
import type { BrokerStartProvider } from '../../contract/broker-start.js';

/**
 * The signing key, domain-separated from every other use of the instance secret.
 *
 * `HMAC-SHA256(key = secret, msg = BROKER_START_PURPOSE)`. Without the
 * separation a token minted for one purpose would verify for another; the
 * control plane derives the same key the same way.
 */
export function deriveBrokerStartKey(instanceSecret: string): Buffer {
  return createHmac('sha256', instanceSecret).update(BROKER_START_PURPOSE).digest();
}

/** The signature over an already-assembled payload. Hex, lower case. */
export function signBrokerStartPayload(payload: string, instanceSecret: string): string {
  return createHmac('sha256', deriveBrokerStartKey(instanceSecret)).update(payload).digest('hex');
}

/**
 * Mint a fresh start token for this instance.
 *
 * ⚠ A NEW nonce every call, and that is not politeness. The control plane keys
 * a replay guard on `${nonce}:${instanceId}` and consumes the entry on first
 * use, so a cached token works exactly once and then reads to the user as a
 * Connect button that broke for no reason. The nonce is the reason this returns
 * a value instead of taking one.
 *
 * It mints the provider-bound v2 token (contract `brokerStartPayloadV2`): the
 * control plane verifies it with the provider of the start route it arrives at,
 * so a token minted for one provider's connect cannot start another's. The v1
 * minting this replaced named no provider. Only a control plane that verifies
 * v2 accepts it; an engine minting v2 against an older one gets `bad_signature`
 * on every Connect, which is why this ships only after such a control plane is
 * in production.
 *
 * `now` is injected so the TTL edge is testable without moving the clock.
 */
export function mintBrokerStartToken(
  provider: BrokerStartProvider,
  instanceId: string,
  instanceSecret: string,
  now: number = Date.now(),
): string {
  // Unix SECONDS, floored: `brokerStartPayloadV2` throws on a non-safe-integer `ts`,
  // and it throws rather than rounding because a fractional timestamp there
  // collapses two different tenants onto the same payload bytes.
  const ts = Math.floor(now / 1000);
  const nonce = randomBytes(BROKER_START_NONCE_BYTES).toString('hex');
  const sig = signBrokerStartPayload(brokerStartPayloadV2({ provider, instanceId, ts, nonce }), instanceSecret);
  return formatBrokerStartTokenV2({ ts, nonce, sig });
}
