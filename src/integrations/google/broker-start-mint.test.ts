import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
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
 * The golden vector, and it deliberately does NOT live in `src/contract/fixtures/`.
 *
 * That directory's rules are built for JSON WIRE SHAPES: every file needs a
 * `satisfies`-typed mirror against an `http.ts` type, a generator row in its
 * README, and string leaves that are "obviously fake" (S4 — no realistic
 * tokens). A signature vector fails the last one by construction: the whole
 * point is a value nobody chose, and `isObviouslyFakeSha` is pinned to 40 hex
 * chars, so a 64-hex HMAC fails on length before anyone judges its realism.
 *
 * ⚠ Not an impossibility, though, and the first draft of this comment said so
 * too strongly. `magic-link-verify-request.json` is the precedent: HAND-WRITTEN
 * rather than captured, because its serializer cannot emit an obviously-fake
 * value either, with the key set pinned in its test instead. That lane could
 * have been widened. It was not, because a hand-written signature pins the
 * framing and not the arithmetic — which is the only part worth pinning here.
 *
 * The contract's own comment predicted `fixtures/broker-start-token.json` by
 * name; that comment is corrected in this change rather than obeyed.
 * Cross-repo pinning is filed as its own row instead.
 */
const golden = {
  instance_id: 'inst_TEST',
  signing_key: 'TEST-SIGNING-KEY',
  ts: 1700000000,
  nonce: '00112233445566778899aabbccddeeff',
  payload: 'v1.inst_TEST.1700000000.00112233445566778899aabbccddeeff',
  token:
    'v1.1700000000.00112233445566778899aabbccddeeff.' +
    'de2dbbc230477eb6d6f2d5371045165091c39fae9e12b08fcb3fa8f7a0cb9e08',
} as const;

describe('the golden broker start token — the bytes the control plane must also compute', () => {
  // The fixture is the EXPECTED value; this test is what binds it to the real
  // serializer. A fixture nobody drives is a JSON file, not a control.
  it('is what this repo actually emits, byte for byte', () => {
    const payload = brokerStartPayload({
      instanceId: golden.instance_id,
      ts: golden.ts,
      nonce: golden.nonce,
    });
    expect(payload).toBe(golden.payload);

    const sig = signBrokerStartPayload(payload, golden.signing_key);
    expect(formatBrokerStartToken({ ts: golden.ts, nonce: golden.nonce, sig })).toBe(golden.token);
  });

  // Recomputed from the spec in the contract's own comment rather than by
  // calling the functions under test — otherwise the check is the code
  // agreeing with itself, and any wrong-but-consistent derivation passes.
  it('matches the derivation the contract WRITES DOWN, computed independently here', () => {
    const key = createHmac('sha256', golden.signing_key).update(BROKER_START_PURPOSE).digest();
    const sig = createHmac('sha256', key).update(golden.payload).digest('hex');
    expect(golden.token).toBe(`v1.${golden.ts}.${golden.nonce}.${sig}`);
  });

  it('domain-separates the key — the same secret signing a different purpose differs', () => {
    const proper = deriveBrokerStartKey(golden.signing_key);
    const undomained = createHmac('sha256', golden.signing_key).update('').digest();
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
