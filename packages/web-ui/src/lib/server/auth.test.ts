import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
	createSessionToken,
	verifySessionToken,
	isOwnerSession,
	readSessionToken,
	loginSession,
	loginSessionFromBody,
	mandateSessionPrincipal,
	MANDATE_SESSION_MAX_S,
	type SessionPrincipal,
	secretEquals,
	isHttpsRequest,
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
		expect(verifySessionToken('a.b.1.c.d', SECRET)).toBe(false);
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

describe('isHttpsRequest', () => {
	function mkRequest(xfp?: string): Request {
		const headers = new Headers();
		if (xfp !== undefined) headers.set('x-forwarded-proto', xfp);
		return new Request('http://internal', { headers });
	}

	it('returns true when url.protocol is https (direct TLS, no proxy)', () => {
		const url = new URL('https://acme.lynox.cloud/login');
		expect(isHttpsRequest(url, mkRequest())).toBe(true);
	});

	it('returns true when proxy sets x-forwarded-proto=https on an http inner hop', () => {
		// The actual managed-deployment case: Traefik/CF terminates TLS, the
		// inner Node sees http:. Without the XFP fallback the Secure flag
		// would silently drop on managed instances.
		const url = new URL('http://internal-traefik/login');
		expect(isHttpsRequest(url, mkRequest('https'))).toBe(true);
	});

	it('returns false on plain http with no proxy header (self-hosted LAN)', () => {
		const url = new URL('http://my-lynox.local:3000/login');
		expect(isHttpsRequest(url, mkRequest())).toBe(false);
	});

	it('takes the first entry of a comma-separated XFP chain', () => {
		// XFP can stack `client-protocol, proxy-protocol, ...` — only the
		// first is the originating client.
		const url = new URL('http://internal/login');
		expect(isHttpsRequest(url, mkRequest('https, http'))).toBe(true);
		expect(isHttpsRequest(url, mkRequest('http, https'))).toBe(false);
	});

	it('is case-insensitive on the XFP scheme', () => {
		const url = new URL('http://internal/login');
		expect(isHttpsRequest(url, mkRequest('HTTPS'))).toBe(true);
		expect(isHttpsRequest(url, mkRequest('Https'))).toBe(true);
	});

	it('trims surrounding whitespace before comparing', () => {
		// Some proxies emit `x-forwarded-proto:  https` with leading spaces;
		// the trim() must normalize before strict-equality. Lock this in.
		const url = new URL('http://internal/login');
		expect(isHttpsRequest(url, mkRequest(' https'))).toBe(true);
		expect(isHttpsRequest(url, mkRequest('https '))).toBe(true);
		expect(isHttpsRequest(url, mkRequest('  https  '))).toBe(true);
	});

	it('returns false for unexpected XFP values', () => {
		const url = new URL('http://internal/login');
		expect(isHttpsRequest(url, mkRequest('ws'))).toBe(false);
		expect(isHttpsRequest(url, mkRequest(''))).toBe(false);
		expect(isHttpsRequest(url, mkRequest('  '))).toBe(false);
	});

	it('rejects header-smuggled scheme strings (lock against loose-match refactor)', () => {
		// Strict-equality compare today makes these all safe; the test
		// guards against a future "startsWith" or "includes" refactor
		// that would silently accept attacker-crafted values.
		const url = new URL('http://internal/login');
		expect(isHttpsRequest(url, mkRequest('javascript:'))).toBe(false);
		expect(isHttpsRequest(url, mkRequest('https://attacker.example'))).toBe(false);
		expect(isHttpsRequest(url, mkRequest('<script>https</script>'))).toBe(false);
	});

	it.each([
		['https://acme.lynox.cloud:8443/login'],
		['https://acme.lynox.cloud/login?next=%2Fapp'],
		['https://[::1]:3000/login'],
		['https://127.0.0.1/login'],
	])('honours url.protocol short-circuit on %s regardless of XFP', (rawUrl) => {
		const url = new URL(rawUrl);
		// XFP is intentionally not 'https' — the url.protocol short-circuit
		// should still return true because we already terminated TLS at the
		// app boundary.
		expect(isHttpsRequest(url, mkRequest(''))).toBe(true);
		expect(isHttpsRequest(url, mkRequest('http'))).toBe(true);
	});
});

// ── Mandate sessions (PRD customer-granted-operator-access §3.3, §3.5) ──────────

const LOGIN = {
	kind: 'mandate' as const,
	email: 'recipient@example.invalid',
	display: 'TEST-DISPLAY',
	mandate_id: 'TEST-MANDATE-1',
	mandate_expires_at: '2100-01-01T00:00:00.000Z',
};

function mandateAt(nowS: number, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
	return { v: 1, kind: 'mandate', email: LOGIN.email, display: LOGIN.display, mandate_id: LOGIN.mandate_id, exp: nowS + MANDATE_SESSION_MAX_S, ...overrides };
}

/** Sign an arbitrary payload the way createSessionToken does, to forge shapes it never mints. */
function sign(payload: string, secret = SECRET): string {
	const key = createHmac('sha256', 'lynox-session').update(secret).digest();
	return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
}
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

describe('session tokens with a principal', () => {
	it('mints `<nonce>.<principal>.<ts>.<sig>` and reads the principal back', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const tok = createSessionToken(SECRET, mandateAt(nowS));
		expect(tok.split('.')).toHaveLength(4);
		expect(readSessionToken(tok, SECRET)).toEqual({ iat: expect.any(Number), principal: mandateAt(nowS) });
	});

	it('reads a principal minted before the mandate\'s end was signed, without one', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const p = readSessionToken(sign(`aaaaaaaaaaaaaaaa.${b64(mandateAt(nowS))}.${nowS}`), SECRET)?.principal;
		expect(p?.email).toBe(LOGIN.email);
		expect(p?.mandate_exp).toBeUndefined();
	});

	it('reads a token without a principal as the owner (null), as before', () => {
		expect(readSessionToken(createSessionToken(SECRET), SECRET)?.principal).toBeNull();
	});

	it('ends a principal session at its signed exp, not at the 30-day age', () => {
		vi.useFakeTimers();
		const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
		vi.setSystemTime(t0);
		const nowS = Math.floor(t0 / 1000);
		const tok = createSessionToken(SECRET, mandateAt(nowS));
		vi.setSystemTime(t0 + (MANDATE_SESSION_MAX_S - 1) * 1000);
		expect(verifySessionToken(tok, SECRET)).toBe(true);
		// At exp itself the session has ended.
		vi.setSystemTime(t0 + MANDATE_SESSION_MAX_S * 1000);
		expect(verifySessionToken(tok, SECRET)).toBe(false);
	});

	it('refuses a principal session stamped more than a minute in the future', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const principal = b64(mandateAt(nowS, { exp: nowS + 3600 }));
		expect(verifySessionToken(sign(`aaaaaaaaaaaaaaaa.${principal}.${nowS + 60}`), SECRET)).toBe(true);
		expect(verifySessionToken(sign(`aaaaaaaaaaaaaaaa.${principal}.${nowS + 61}`), SECRET)).toBe(false);
	});

	it('refuses a changed principal: the HMAC covers it', () => {
		const nowS = Math.floor(Date.now() / 1000);
		const parts = createSessionToken(SECRET, mandateAt(nowS)).split('.');
		parts[1] = b64(mandateAt(nowS, { email: 'other@example.invalid' }));
		expect(verifySessionToken(parts.join('.'), SECRET)).toBe(false);
	});

	it('refuses a signed principal it does not know, never reading it as the owner', () => {
		const nowS = Math.floor(Date.now() / 1000);
		for (const p of [
			{ ...mandateAt(nowS), kind: 'owner' },
			{ ...mandateAt(nowS), v: 2 },
			{ ...mandateAt(nowS), exp: 'later' },
			{ ...mandateAt(nowS), email: '' },
			{ ...mandateAt(nowS), display: 7 },
			{ ...mandateAt(nowS), mandate_id: null },
			{ ...mandateAt(nowS), mandate_exp: 'later' },
			{ ...mandateAt(nowS), mandate_exp: nowS + MANDATE_SESSION_MAX_S - 1 },
		]) {
			expect(readSessionToken(sign(`aaaaaaaaaaaaaaaa.${b64(p)}.${nowS}`), SECRET), JSON.stringify(p)).toBeNull();
		}
		expect(readSessionToken(sign(`aaaaaaaaaaaaaaaa.not-json.${nowS}`), SECRET)).toBeNull();
	});
});

describe('loginSession', () => {
	it('gives the owner the principal-less 30-day session, unchanged', () => {
		const s = loginSession(SECRET, null)!;
		expect(s.maxAge).toBe(SESSION_MAX_AGE_S);
		expect(s.token.split('.')).toHaveLength(3);
	});

	it('signs the mandate\'s own end beside the session\'s, so the engine can keep it (B9)', () => {
		vi.useFakeTimers();
		const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
		vi.setSystemTime(t0);
		const endsInAWeek = { ...LOGIN, mandate_expires_at: new Date(t0 + 7 * 86_400_000).toISOString() };
		const p = mandateSessionPrincipal(endsInAWeek)!;
		expect(p.exp).toBe(Math.floor(t0 / 1000) + MANDATE_SESSION_MAX_S);
		expect(p.mandate_exp).toBe(Math.floor(t0 / 1000) + 7 * 86_400);
		expect(readSessionToken(loginSession(SECRET, endsInAWeek)!.token, SECRET)?.principal?.mandate_exp).toBe(p.mandate_exp);
	});

	it('gives a mandate login a principal session of at most 15 minutes', () => {
		const s = loginSession(SECRET, LOGIN)!;
		expect(s.maxAge).toBe(MANDATE_SESSION_MAX_S);
		expect(readSessionToken(s.token, SECRET)?.principal?.email).toBe(LOGIN.email);
	});

	it('never lets the session outlive the mandate', () => {
		vi.useFakeTimers();
		const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
		vi.setSystemTime(t0);
		const endsIn5Min = { ...LOGIN, mandate_expires_at: new Date(t0 + 300_000).toISOString() };
		expect(loginSession(SECRET, endsIn5Min)!.maxAge).toBe(300);
		expect(mandateSessionPrincipal(endsIn5Min)!.exp).toBe(Math.floor(t0 / 1000) + 300);
	});

	it('gives no session for a mandate that has already ended', () => {
		vi.useFakeTimers();
		const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
		vi.setSystemTime(t0);
		expect(loginSession(SECRET, { ...LOGIN, mandate_expires_at: new Date(t0).toISOString() })).toBeNull();
		expect(loginSession(SECRET, { ...LOGIN, mandate_expires_at: 'not a date' })).toBeNull();
	});
});

describe('loginSessionFromBody (the CP success body of a code or link login)', () => {
	it('gives the owner session for a body without a principal', () => {
		const s = loginSessionFromBody(SECRET, { valid: true });
		expect(s).not.toBeTypeOf('string');
		if (typeof s === 'string') return;
		expect(readSessionToken(s.token, SECRET)?.principal).toBeNull();
		expect(s.maxAge).toBe(SESSION_MAX_AGE_S);
	});

	it('gives the mandate session for a body naming a live mandate', () => {
		const s = loginSessionFromBody(SECRET, { valid: true, principal: LOGIN });
		if (typeof s === 'string') throw new Error(s);
		expect(readSessionToken(s.token, SECRET)?.principal?.mandate_id).toBe(LOGIN.mandate_id);
	});

	it('refuses a principal it does not know, never giving the owner session', () => {
		expect(loginSessionFromBody(SECRET, { valid: true, principal: { ...LOGIN, kind: 'member' } })).toBe('unknown_principal');
		expect(loginSessionFromBody(SECRET, null)).toBe('unknown_principal');
	});

	it('gives no session for a mandate that has already ended', () => {
		expect(loginSessionFromBody(SECRET, { valid: true, principal: { ...LOGIN, mandate_expires_at: '2000-01-01T00:00:00.000Z' } })).toBe('ended');
	});
});

describe('isOwnerSession (who may create a way back in as the owner)', () => {
	it('is true for the owner\'s session, which carries no principal', () => {
		expect(isOwnerSession(createSessionToken(SECRET), SECRET)).toBe(true);
	});

	it('is false for a valid mandate session', () => {
		const tok = createSessionToken(SECRET, mandateAt(Math.floor(Date.now() / 1000)));
		expect(verifySessionToken(tok, SECRET)).toBe(true);
		expect(isOwnerSession(tok, SECRET)).toBe(false);
	});

	it('is false for an owner token signed with another secret', () => {
		expect(isOwnerSession(createSessionToken(SECRET), OTHER_SECRET)).toBe(false);
	});

	it('is false for an owner token past its 30 days', () => {
		vi.useFakeTimers();
		const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
		vi.setSystemTime(t0);
		const tok = createSessionToken(SECRET);
		vi.setSystemTime(t0 + (SESSION_MAX_AGE_S + 1) * 1000);
		expect(isOwnerSession(tok, SECRET)).toBe(false);
	});

	it('is false without a token or without a secret', () => {
		expect(isOwnerSession(undefined, SECRET)).toBe(false);
		expect(isOwnerSession('', SECRET)).toBe(false);
		expect(isOwnerSession(createSessionToken(SECRET), undefined)).toBe(false);
		expect(isOwnerSession(createSessionToken(SECRET), '')).toBe(false);
	});
});
