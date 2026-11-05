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
  BROKER_START_VERSION_V2,
  BROKER_START_PROVIDERS,
  BROKER_START_GOLDEN_V2,
  isBrokerStartProvider,
  brokerStartPayloadV2,
  parseBrokerStartTokenV2,
  formatBrokerStartTokenV2,
  parseAnyBrokerStartToken,
  brokerStartAcceptsVersion,
  BROKER_START_GOLDEN,
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

  it('REFUSES a non-integer ts — the collision that survives the separator', () => {
    // The instance id is opaque by contract and may contain the separator, so
    // uniqueness rests on the two fields after it being constrained. A
    // fractional ts breaks exactly that: `{id:'tenant.5', ts:3}` and
    // `{id:'tenant', ts:5.3}` are the same bytes, and one tenant's signature
    // then verifies for another. Found by the refuter on this PR, not by me.
    expect(() => brokerStartPayload({ instanceId: 't', ts: 5.3, nonce: NONCE })).toThrow(/non-negative integer/);
    expect(() => brokerStartPayload({ instanceId: 't', ts: -1, nonce: NONCE })).toThrow(/non-negative integer/);
    expect(() => brokerStartPayload({ instanceId: 't', ts: Number.NaN, nonce: NONCE })).toThrow(/non-negative integer/);
  });

  it('stays unique when the OPAQUE instance id contains the separator', () => {
    // The pair the refuter used, now that ts must be an integer: these must
    // differ, and the one that used to collide cannot be constructed at all.
    const a = brokerStartPayload({ instanceId: 'tenant.5', ts: 3, nonce: NONCE });
    const b = brokerStartPayload({ instanceId: 'tenant', ts: 53, nonce: NONCE });
    expect(a).not.toBe(b);
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

describe('v2 — the provider inside the signed payload (row 1224)', () => {
  it('is the golden string, provider first after the version', () => {
    expect(brokerStartPayloadV2({ provider: 'google', instanceId: 'inst_TEST', ts: 1700000000, nonce: NONCE }))
      .toBe(`v2.google.inst_TEST.1700000000.${NONCE}`);
    expect(brokerStartPayloadV2({ provider: 'microsoft', instanceId: 'inst_TEST', ts: 1700000000, nonce: NONCE }))
      .toBe(`v2.microsoft.inst_TEST.1700000000.${NONCE}`);
  });

  it('BINDS the provider: the same instance, time and nonce sign different bytes per provider', () => {
    const g = brokerStartPayloadV2({ provider: 'google', instanceId: 'inst_A', ts: 1700000000, nonce: NONCE });
    const m = brokerStartPayloadV2({ provider: 'microsoft', instanceId: 'inst_A', ts: 1700000000, nonce: NONCE });
    expect(g).not.toBe(m);
  });

  it('never shares bytes with a v1 payload', () => {
    const v1 = brokerStartPayload({ instanceId: 'google.inst_A', ts: 1700000000, nonce: NONCE });
    const v2 = brokerStartPayloadV2({ provider: 'google', instanceId: 'inst_A', ts: 1700000000, nonce: NONCE });
    expect(v1).not.toBe(v2);
  });

  it('refuses a provider outside the set, and a non-integer ts', () => {
    expect(() => brokerStartPayloadV2({ provider: 'slack' as never, instanceId: 't', ts: 1, nonce: NONCE })).toThrow(/provider/);
    expect(() => brokerStartPayloadV2({ provider: 'google', instanceId: 't', ts: 5.3, nonce: NONCE })).toThrow(/non-negative integer/);
  });

  it('the provider set is closed and pinned', () => {
    expect([...BROKER_START_PROVIDERS]).toEqual(['google', 'microsoft']);
    for (const p of BROKER_START_PROVIDERS) expect(isBrokerStartProvider(p)).toBe(true);
    for (const other of ['Google', 'm365', '', 'google.x', undefined, null, 1]) expect(isBrokerStartProvider(other)).toBe(false);
  });

  it('frames and parses as v2, and the two parsers do not accept each other', () => {
    const token = formatBrokerStartTokenV2({ ts: 1700000000, nonce: NONCE, sig: SIG });
    expect(token).toBe(`v2.1700000000.${NONCE}.${SIG}`);
    expect(parseBrokerStartTokenV2(token)).toEqual({ ts: 1700000000, nonce: NONCE, sig: SIG });
    expect(parseBrokerStartToken(token)).toBeNull();
    expect(parseBrokerStartTokenV2(formatBrokerStartToken({ ts: 1700000000, nonce: NONCE, sig: SIG }))).toBeNull();
  });

  it.each([
    ['wrong part count', `v2.1700000000.${NONCE}`],
    ['non-numeric ts', `v2.x.${NONCE}.${SIG}`],
    ['nonce not hex', `v2.1700000000.${'z'.repeat(32)}.${SIG}`],
    ['signature truncated', `v2.1700000000.${NONCE}.${'b'.repeat(63)}`],
    ['provider in the framing', `v2.google.1700000000.${NONCE}.${SIG}`],
  ])('parseBrokerStartTokenV2 returns null on %s', (_l, token) => {
    expect(parseBrokerStartTokenV2(token)).toBeNull();
  });

  it('the golden pair carries its payloads, and the version is pinned', () => {
    expect(BROKER_START_VERSION_V2).toBe('v2');
    for (const p of BROKER_START_PROVIDERS) {
      expect(BROKER_START_GOLDEN_V2[p].payload).toBe(brokerStartPayloadV2({
        provider: p, instanceId: BROKER_START_GOLDEN_V2.instanceId, ts: BROKER_START_GOLDEN_V2.ts, nonce: BROKER_START_GOLDEN_V2.nonce,
      }));
      expect(parseBrokerStartTokenV2(BROKER_START_GOLDEN_V2[p].token)).not.toBeNull();
    }
  });
});

describe('v2 hardening and the rollout rule (row 1224, security review)', () => {
  it('the v2 payload refuses a nonce that is not fixed-length hex, and an unsafe ts', () => {
    expect(() => brokerStartPayloadV2({ provider: 'google', instanceId: 'a', ts: 1, nonce: '2.n' })).toThrow(/nonce/);
    expect(() => brokerStartPayloadV2({ provider: 'google', instanceId: 'a', ts: 1, nonce: NONCE.toUpperCase() })).toThrow(/nonce/);
    expect(() => brokerStartPayloadV2({ provider: 'google', instanceId: 'a', ts: 1e21, nonce: NONCE })).toThrow(/non-negative integer/);
  });

  it('the v2 parser refuses leading zeros, so one signature has one token string', () => {
    expect(parseBrokerStartTokenV2(`v2.01700000000.${NONCE}.${SIG}`)).toBeNull();
    expect(parseBrokerStartTokenV2(`v2.0.${NONCE}.${SIG}`)).not.toBeNull();
    expect(parseBrokerStartTokenV2(`v2.99999999999999999999.${NONCE}.${SIG}`)).toBeNull();
  });

  it('parseAnyBrokerStartToken says which version parsed', () => {
    expect(parseAnyBrokerStartToken(BROKER_START_GOLDEN.token)?.version).toBe('v1');
    expect(parseAnyBrokerStartToken(BROKER_START_GOLDEN_V2.google.token)?.version).toBe('v2');
    expect(parseAnyBrokerStartToken(`v3.1700000000.${NONCE}.${SIG}`)).toBeNull();
    expect(parseAnyBrokerStartToken('')).toBeNull();
  });

  it('accepts v2 at every route and v1 only at the Google start', () => {
    expect(brokerStartAcceptsVersion('google', 'v2')).toBe(true);
    expect(brokerStartAcceptsVersion('microsoft', 'v2')).toBe(true);
    expect(brokerStartAcceptsVersion('google', 'v1')).toBe(true);
    expect(brokerStartAcceptsVersion('microsoft', 'v1')).toBe(false);
    // An unchecked string from a caller fails closed, at any route.
    expect(brokerStartAcceptsVersion('google', 'v3' as never)).toBe(false);
  });
});
