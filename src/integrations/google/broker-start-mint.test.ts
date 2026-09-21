import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  BROKER_START_GOLDEN as golden,
  BROKER_START_NONCE_BYTES,
  BROKER_START_PURPOSE,
  brokerStartPayload,
  formatBrokerStartToken,
  parseBrokerStartToken,
} from '../../contract/broker-start.js';
import {
  deriveBrokerStartKey,
  mintBrokerStartToken,
  signBrokerStartPayload,
} from './broker-start-mint.js';

/**
 * The golden vector is the CONTRACT's, not this file's: `BROKER_START_GOLDEN`
 * lives in `src/contract/broker-start.ts` and reaches the control plane with
 * its vendored copy, where the verifier has to accept the same bytes. This
 * block is the engine's half — the minter must produce them. If a change here
 * makes it fail, the fix is never to re-pick the vector in this repo: that is a
 * wire change, and the other side has to move with it.
 */
describe('the golden broker start token — the bytes the control plane must also compute', () => {
  // The vector is the EXPECTED value; this test is what binds it to the real
  // serializer. A vector nobody drives is a literal, not a control.
  it('is what this repo actually emits, byte for byte', () => {
    const payload = brokerStartPayload({
      instanceId: golden.instanceId,
      ts: golden.ts,
      nonce: golden.nonce,
    });
    expect(payload).toBe(golden.payload);

    const sig = signBrokerStartPayload(payload, golden.signingKey);
    expect(formatBrokerStartToken({ ts: golden.ts, nonce: golden.nonce, sig })).toBe(golden.token);
  });

  // Recomputed from the spec in the contract's own comment rather than by
  // calling the functions under test — otherwise the check is the code
  // agreeing with itself, and any wrong-but-consistent derivation passes.
  it('matches the derivation the contract WRITES DOWN, computed independently here', () => {
    const key = createHmac('sha256', golden.signingKey).update(BROKER_START_PURPOSE).digest();
    const sig = createHmac('sha256', key).update(golden.payload).digest('hex');
    expect(golden.token).toBe(`v1.${golden.ts}.${golden.nonce}.${sig}`);
  });

  it('domain-separates the key — the same secret signing a different purpose differs', () => {
    const proper = deriveBrokerStartKey(golden.signingKey);
    const undomained = createHmac('sha256', golden.signingKey).update('').digest();
    expect(proper.equals(undomained)).toBe(false);
  });
});

describe('mintBrokerStartToken', () => {
  const SECRET = 'TEST-SIGNING-KEY';

  it('produces a token the contract parser accepts', () => {
    const parsed = parseBrokerStartToken(mintBrokerStartToken('inst_TEST', SECRET));
    expect(parsed).not.toBeNull();
    expect(parsed?.nonce).toHaveLength(BROKER_START_NONCE_BYTES * 2);
  });

  it('signs over the instance id — a token for one tenant must not verify for another', () => {
    const token = mintBrokerStartToken('inst_A', SECRET, 1700000000_000);
    const parsed = parseBrokerStartToken(token);
    expect(parsed).not.toBeNull();
    const forB = signBrokerStartPayload(
      brokerStartPayload({ instanceId: 'inst_B', ts: parsed!.ts, nonce: parsed!.nonce }),
      SECRET,
    );
    expect(parsed!.sig).not.toBe(forB);
  });

  // The control plane consumes `${nonce}:${instanceId}` on first use. A minter
  // that repeats a nonce works exactly once per process and then reads to the
  // user as a Connect button that broke for no reason.
  it('mints a FRESH nonce every call', () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () => parseBrokerStartToken(mintBrokerStartToken('inst_TEST', SECRET))?.nonce),
    );
    expect(nonces.size).toBe(20);
  });

  // Named for what this body shows: the flooring. The collision it guards
  // against is proven in `tests/contract-broker-start.test.ts`, which builds the
  // two colliding tenants; claiming it here would borrow that test's evidence.
  it('carries unix SECONDS, floored', () => {
    const parsed = parseBrokerStartToken(mintBrokerStartToken('inst_TEST', SECRET, 1700000000_999));
    expect(parsed?.ts).toBe(1700000000);
  });

  it('binds the secret — the wrong key produces a different signature', () => {
    const token = mintBrokerStartToken('inst_TEST', SECRET, 1700000000_000);
    const parsed = parseBrokerStartToken(token)!;
    const wrong = signBrokerStartPayload(
      brokerStartPayload({ instanceId: 'inst_TEST', ts: parsed.ts, nonce: parsed.nonce }),
      'TEST-OTHER-SECRET',
    );
    expect(parsed.sig).not.toBe(wrong);
  });
});
