/**
 * The broker start token's FRAMING — the half both repos must agree on byte for
 * byte (`src/contract/broker-start.ts`, PRD Stage 1 §3.4, wave W5).
 *
 * What these tests are for, stated because the split is easy to misread: the
 * signature is deliberately NOT in the contract (the directory is
 * dependency-free, `node:crypto` is a dependency), so nothing here can check an
 * HMAC. What they pin is the part a mismatch would break silently — the exact
 * payload bytes and the framing — because a verifier that recomputes over a
 * different string does not error, it just refuses every valid token, and the
 * symptom is a Connect button that does nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  BROKER_START_VERSION,
  BROKER_START_TTL_SEC,
  BROKER_START_SKEW_SEC,
  BROKER_START_PURPOSE,
  BROKER_START_NONCE_BYTES,
  brokerStartPayload,
  parseBrokerStartToken,
  formatBrokerStartToken,
} from '../src/contract/broker-start.js';

const NONCE = 'a'.repeat(BROKER_START_NONCE_BYTES * 2);
const SIG = 'b'.repeat(64);

describe('brokerStartPayload — the exact bytes both sides sign', () => {
  it('is the golden string, field order included', () => {
    // A literal, not a re-derivation: re-deriving it from the same function the
    // test is checking would pass against any field order.
    expect(brokerStartPayload({ instanceId: 'inst_TEST', ts: 1700000000, nonce: NONCE }))
      .toBe(`v1.inst_TEST.1700000000.${NONCE}`);
  });

  it('BINDS the instance — the whole reason the id is inside the payload', () => {
    const a = brokerStartPayload({ instanceId: 'inst_A', ts: 1700000000, nonce: NONCE });
    const b = brokerStartPayload({ instanceId: 'inst_B', ts: 1700000000, nonce: NONCE });
    expect(a, 'a token minted for one instance must not sign for another').not.toBe(b);
  });

  it('separates its fields — without a separator two tenants share one payload', () => {
    // The pair is chosen so the CONCATENATION collides and the separated form
    // does not: 'a' + '11' and 'a1' + '1' are both `a11`. An earlier version of
    // this test used ('a', 1) vs ('a.1', 1), which stays distinct even with the
    // separators removed — it asserted a difference that survives the defect,
    // and the mutation that deletes the separators left it green.
    const one = brokerStartPayload({ instanceId: 'a', ts: 11, nonce: NONCE });
    const two = brokerStartPayload({ instanceId: 'a1', ts: 1, nonce: NONCE });
    expect(one, 'a payload that concatenates lets one tenant sign for another').not.toBe(two);
  });
});

describe('parseBrokerStartToken — framing only, never a verdict on the signature', () => {
  it('round-trips what formatBrokerStartToken emits', () => {
    const token = formatBrokerStartToken({ ts: 1700000000, nonce: NONCE, sig: SIG });
    expect(token).toBe(`v1.1700000000.${NONCE}.${SIG}`);
    expect(parseBrokerStartToken(token)).toEqual({ ts: 1700000000, nonce: NONCE, sig: SIG });
  });

  it.each([
    ['wrong part count (3)', `v1.1700000000.${NONCE}`],
    ['wrong part count (5)', `v1.1700000000.${NONCE}.${SIG}.extra`],
    ['unknown version', `v2.1700000000.${NONCE}.${SIG}`],
    ['non-numeric ts', `v1.notatime.${NONCE}.${SIG}`],
    ['nonce too short', `v1.1700000000.${'a'.repeat(30)}.${SIG}`],
    ['nonce not hex', `v1.1700000000.${'z'.repeat(32)}.${SIG}`],
    ['signature truncated', `v1.1700000000.${NONCE}.${'b'.repeat(63)}`],
    ['signature not hex', `v1.1700000000.${NONCE}.${'z'.repeat(64)}`],
    ['empty', ''],
  ])('returns null on %s', (_label, token) => {
    expect(parseBrokerStartToken(token)).toBeNull();
  });

  it('returns null rather than throwing — every caller answers in a redirect', () => {
    // A throw on this path becomes a 500 instead of a named decline, and the
    // user sees a broken page rather than "that link expired".
    expect(() => parseBrokerStartToken('....')).not.toThrow();
    expect(() => parseBrokerStartToken('v1')).not.toThrow();
  });
});

describe('the constants are the contract, so they are pinned as literals', () => {
  it('holds the values both repos compile against', () => {
    // Pinned rather than referenced: a test that asserts `X === X` moves with
    // any edit and reports nothing. These fail when someone changes the wire.
    expect(BROKER_START_VERSION).toBe('v1');
    expect(BROKER_START_TTL_SEC).toBe(300);
    expect(BROKER_START_SKEW_SEC).toBe(60);
    expect(BROKER_START_PURPOSE).toBe('lynox-broker-start-v1');
    expect(BROKER_START_NONCE_BYTES).toBe(16);
  });

  it('keeps the skew well under the TTL — otherwise the window is not what it says', () => {
    expect(BROKER_START_SKEW_SEC * 2).toBeLessThan(BROKER_START_TTL_SEC);
  });
});
