import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
	createSessionToken,
	verifySessionToken,
	secretEquals,
	SESSION_MAX_AGE_S,
} from './auth.js';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

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
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		expect(parts).toHaveLength(3);
		expect(parts[0]!).toMatch(/^[0-9a-f]{16}$/); // 8-byte hex nonce
		expect(parts[1]!).toMatch(/^\d+$/); // unix timestamp
		expect(parts[2]!).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
	});

	it('rejects a token with a tampered signature', () => {
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		const flipped = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('0') ? '1' : '0');
		const tampered = `${parts[0]!}.${parts[1]!}.${flipped}`;
		expect(verifySessionToken(tampered, SECRET)).toBe(false);
	});

	it('rejects a token with a tampered timestamp', () => {
		const tok = createSessionToken(SECRET);
		const parts = tok.split('.');
		const tampered = `${parts[0]!}.${(parseInt(parts[1]!, 10) + 1).toString()}.${parts[2]!}`;
		expect(verifySessionToken(tampered, SECRET)).toBe(false);
	});

	it('rejects an expired token (timestamp > SESSION_MAX_AGE_S in the past)', () => {
		// Hand-forge a token with an old timestamp using the same algorithm.
		// This is the cookie-mint recipe — exercising it here doubles as a
		// regression sentinel against algorithm drift between createSessionToken
		// and verifySessionToken.
		const key = createHmac('sha256', 'lynox-session').update(SECRET).digest();
		const oldTs = Math.floor(Date.now() / 1000) - SESSION_MAX_AGE_S - 60;
		const payload = `aaaaaaaaaaaaaaaa.${oldTs.toString()}`;
		const sig = createHmac('sha256', key).update(payload).digest('hex');
		const expired = `${payload}.${sig}`;
		expect(verifySessionToken(expired, SECRET)).toBe(false);
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
		// Sentinel: any external minter (smoke scripts, Lucia's CP-side cookie
		// signing, the staging-cookie-forge recipe in
		// reference_session_cookie_mint.md) builds the cookie via:
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
