import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
	createSessionToken,
	verifySessionToken,
	secretEquals,
	SESSION_MAX_AGE_S,
} from './auth.js';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

afterEach(() => {
	vi.useRealTimers();
});

describe('createSessionToken / verifySessionToken — roundtrip', () => {
	it('verifies a token signed with the same secret', () => {
		const tok = createSessionToken(SECRET);
		expect(verifySessionToken(tok, SECRET)).toBe(true);
	});

	it('rejects a token signed with a different secret', () => {
		const tok = createSessionToken(SECRET);
		expect(verifySessionToken(tok, OTHER_SECRET)).toBe(false);
	});

	it('produces tokens in the documented `<nonce>.<ts>.<sig>` shape', () => {
		// Sample 20× — a single-sample regex assertion could pass by luck if
		// nonce randomness ever degenerated. The full shape must hold across
		// every call.
		const SHAPE = /^[0-9a-f]{16}\.\d+\.[0-9a-f]{64}$/;
		const nonces = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const tok = createSessionToken(SECRET);
			expect(tok).toMatch(SHAPE);
			nonces.add(tok.split('.')[0]!);
		}
		// 20 distinct 8-byte nonces — collision probability is ~10^-15, so
		// any duplicate here is a regression in the RNG path, not bad luck.
		expect(nonces.size).toBe(20);
	});

	it('rejects a token with a tampered signature', () => {
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		// Flip the low bit of the last hex char deterministically — guaranteed
		// to stay in [0-9a-f] (XOR within the hex range) and to differ from
		// the original sig regardless of what character it ends in.
		const lastChar = parts[2]!.slice(-1);
		const flippedChar = (parseInt(lastChar, 16) ^ 1).toString(16);
		const tampered = `${parts[0]!}.${parts[1]!}.${parts[2]!.slice(0, -1)}${flippedChar}`;
		expect(verifySessionToken(tampered, SECRET)).toBe(false);
	});

	it('rejects a token with a tampered timestamp', () => {
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		// Use a clearly different ts (not +1) so the rejection is unambiguously
		// caused by HMAC mismatch on the changed payload — a +1 delta keeps
		// the test in the noise floor of "what does ts validation actually
		// check?".
		const tampered = `${parts[0]!}.${(parseInt(parts[1]!, 10) + 12345).toString()}.${parts[2]!}`;
		expect(verifySessionToken(tampered, SECRET)).toBe(false);
	});

	it('rejects an expired token (timestamp > SESSION_MAX_AGE_S in the past)', () => {
		// Use fake timers so the boundary is deterministic — relying on real
		// Date.now() with a 60s "safety margin" silently breaks if
		// SESSION_MAX_AGE_S is ever shortened or CI is slow.
		const fixedNow = 1_777_900_000_000; // arbitrary fixed instant
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);

		const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
		const oldTs = Math.floor(fixedNow / 1000) - SESSION_MAX_AGE_S - 1;
		const payload = `aaaaaaaaaaaaaaaa.${oldTs.toString()}`;
		const sig = createHmac('sha256', key).update(payload).digest('hex');
		const expired = `${payload}.${sig}`;
		expect(verifySessionToken(expired, SECRET)).toBe(false);
	});

	it('locks the expiry boundary at exactly SESSION_MAX_AGE_S', () => {
		// Pin the inequality direction: a token with ts = now - SESSION_MAX_AGE_S
		// is still valid (boundary inclusive); ts - 1 is rejected. An off-by-one
		// in the verifier (`>=` flipping to `>`) would invalidate every
		// 30-day-old session cookie a day early — silent on prod until users
		// notice. This test catches it pre-merge.
		const fixedNow = 1_777_900_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);

		const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
		const mintAt = (ts: number): string => {
			const payload = `0123456789abcdef.${ts.toString()}`;
			const sig = createHmac('sha256', key).update(payload).digest('hex');
			return `${payload}.${sig}`;
		};
		const nowS = Math.floor(fixedNow / 1000);

		// At the exact boundary: still valid.
		expect(verifySessionToken(mintAt(nowS - SESSION_MAX_AGE_S), SECRET)).toBe(true);
		// One second past: rejected.
		expect(verifySessionToken(mintAt(nowS - SESSION_MAX_AGE_S - 1), SECRET)).toBe(false);
	});

	it('rejects malformed tokens (wrong part count)', () => {
		expect(verifySessionToken('only-one-part', SECRET)).toBe(false);
		expect(verifySessionToken('a.b.c.d', SECRET)).toBe(false);
		expect(verifySessionToken('', SECRET)).toBe(false);
	});

	it('rejects a token with a non-numeric timestamp', () => {
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		const bad = `${parts[0]!}.notanumber.${parts[2]!}`;
		expect(verifySessionToken(bad, SECRET)).toBe(false);
	});

	it('accepts the legacy two-part `<ts>.<sig>` token shape (backwards compat)', () => {
		// The verifier supports the pre-nonce token format; this guards against
		// dropping that compatibility branch without a deliberate cookie cycle.
		const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
		const ts = Math.floor(Date.now() / 1000).toString();
		const sig = createHmac('sha256', key).update(ts).digest('hex');
		const legacy = `${ts}.${sig}`;
		expect(verifySessionToken(legacy, SECRET)).toBe(true);
	});

	it('cross-process roundtrip — a forged token using the documented HMAC chain verifies', () => {
		// Sentinel: any external minter (smoke scripts, CP-side cookie signing,
		// staging cookie forging) builds the cookie via:
		//   key  = HMAC-SHA256('lynox-session', LYNOX_HTTP_SECRET).digest()
		//   sig  = HMAC-SHA256(key, '<nonce>.<ts>').hex()
		// If verifySessionToken changes the derive/sign chain in any way that
		// breaks this contract, every active session cookie in the wild is
		// invalidated on deploy. Lock the contract here.
		const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
		const nonce = '0123456789abcdef';
		const ts = Math.floor(Date.now() / 1000).toString();
		const payload = `${nonce}.${ts}`;
		const sig = createHmac('sha256', key).update(payload).digest('hex');
		const forged = `${payload}.${sig}`;
		expect(verifySessionToken(forged, SECRET)).toBe(true);
	});
});

describe('secretEquals', () => {
	it('returns true for matching secrets', () => {
		expect(secretEquals(SECRET, SECRET)).toBe(true);
	});

	it('returns false for different secrets', () => {
		expect(secretEquals(SECRET, OTHER_SECRET)).toBe(false);
	});

	it('returns false for inputs of different lengths (no length oracle)', () => {
		expect(secretEquals('short', SECRET)).toBe(false);
	});
});
