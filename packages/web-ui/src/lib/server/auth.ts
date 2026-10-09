import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readLoginPrincipal, type MandateLoginPrincipal } from '../contract/http.js';

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

/** Derive a purpose-specific key so the raw secret is never used directly. */
function deriveKey(secret: string, purpose: string): Buffer {
	return createHmac('sha256', purpose).update(secret).digest();
}

// ── Session tokens ──────────────────────────────────────────────────

/** A mandate session lasts at most this long; the web-ui does not renew one yet. */
export const MANDATE_SESSION_MAX_S = 15 * 60;
/** A session stamped further than this in the future is refused. */
export const SESSION_FUTURE_SKEW_S = 60;

/**
 * The principal a session carries. Only a mandate session carries one: an owner
 * login still mints the cookie without a principal, as before. The engine reads
 * the same part (`src/server/http-api.ts`, `_verifySessionCookie`); the two must
 * agree on every field here.
 */
export interface SessionPrincipal {
	v: 1;
	kind: 'mandate';
	email: string;
	display: string;
	mandate_id: string;
	/** Unix seconds. The session ends here, signed, whatever the cookie's Max-Age says. */
	exp: number;
	/** Unix seconds. The mandate itself ends here; never earlier than `exp`. The engine keeps
	 *  it for what runs after the session (a connection the mandate made, PRD §3.13 B9). Absent
	 *  in a cookie minted before this field existed. */
	mandate_exp?: number;
}

/**
 * The principal for a mandate login verified now: it ends 15 minutes from now, or
 * when the mandate ends, whichever comes first. `null` when the mandate has
 * already ended or its end cannot be read.
 */
export function mandateSessionPrincipal(p: MandateLoginPrincipal, nowS = Math.floor(Date.now() / 1000)): SessionPrincipal | null {
	const mandateEndS = Math.floor(Date.parse(p.mandate_expires_at) / 1000);
	if (!Number.isFinite(mandateEndS)) return null;
	const exp = Math.min(nowS + MANDATE_SESSION_MAX_S, mandateEndS);
	if (exp <= nowS) return null;
	return { v: 1, kind: 'mandate', email: p.email, display: p.display, mandate_id: p.mandate_id, exp, mandate_exp: mandateEndS };
}

/**
 * Create a signed session token: `<nonce>.<unix_ts>.<hmac_hex>`, or with a
 * principal `<nonce>.<principal>.<unix_ts>.<hmac_hex>`, the principal one
 * base64url part (no dots) covered by the same HMAC.
 */
export function createSessionToken(secret: string, principal?: SessionPrincipal): string {
	const key = deriveKey(secret, 'lynox-session');
	const nonce = randomBytes(8).toString('hex');
	const ts = Math.floor(Date.now() / 1000).toString();
	const payload = principal === undefined
		? `${nonce}.${ts}`
		: `${nonce}.${Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url')}.${ts}`;
	const hmac = createHmac('sha256', key).update(payload).digest('hex');
	return `${payload}.${hmac}`;
}

function parseSessionPrincipal(part: string): SessionPrincipal | null {
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== 'object') return null;
	const p = raw as Record<string, unknown>;
	if (p['v'] !== 1 || p['kind'] !== 'mandate') return null;
	const { email, display, mandate_id: mandateId, exp } = p;
	if (typeof email !== 'string' || email.length === 0) return null;
	if (typeof display !== 'string' || display.length === 0) return null;
	if (typeof mandateId !== 'string' || mandateId.length === 0) return null;
	if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return null;
	const mandateExp = p['mandate_exp'];
	if (mandateExp === undefined) return { v: 1, kind: 'mandate', email, display, mandate_id: mandateId, exp };
	if (typeof mandateExp !== 'number' || !Number.isSafeInteger(mandateExp) || mandateExp < exp) return null;
	return { v: 1, kind: 'mandate', email, display, mandate_id: mandateId, exp, mandate_exp: mandateExp };
}

/**
 * Read a session token: who it is and when it was issued, or `null` when it is
 * not correctly signed, has expired, or carries a principal this reader does not
 * know. Formats: `<ts>.<hmac>` (old), `<nonce>.<ts>.<hmac>`, and
 * `<nonce>.<principal>.<ts>.<hmac>`. A principal session ends at its signed `exp`
 * and is refused when stamped more than a minute in the future.
 */
export function readSessionToken(token: string, secret: string): { iat: number; principal: SessionPrincipal | null } | null {
	const parts = token.split('.');
	if (parts.length < 2 || parts.length > 4) return null;

	const sig = parts[parts.length - 1]!;
	const payload = parts.slice(0, -1).join('.');
	// Timestamp is last element before sig
	const tsStr = parts[parts.length - 2]!;

	const timestamp = parseInt(tsStr, 10);
	if (Number.isNaN(timestamp)) return null;

	// Expired?
	const nowS = Math.floor(Date.now() / 1000);
	if (nowS - timestamp > SESSION_MAX_AGE_S) return null;

	// Verify HMAC (constant-time, derived key)
	const key = deriveKey(secret, 'lynox-session');
	const expected = createHmac('sha256', key).update(payload).digest('hex');
	try {
		const sigBuf = Buffer.from(sig, 'hex');
		const expBuf = Buffer.from(expected, 'hex');
		if (sigBuf.length !== expBuf.length) return null;
		if (!timingSafeEqual(sigBuf, expBuf)) return null;
	} catch {
		return null;
	}

	if (parts.length < 4) return { iat: timestamp, principal: null };
	const principal = parseSessionPrincipal(parts[1]!);
	if (principal === null) return null;
	if (timestamp - nowS > SESSION_FUTURE_SKEW_S) return null;
	if (nowS >= principal.exp) return null;
	return { iat: timestamp, principal };
}

/**
 * The session a verified login gets: the token and the cookie's Max-Age. The
 * owner (`null`) gets the principal-less 30-day session as before; a mandate
 * login gets a principal session that ends at its `exp`. `null` when the
 * mandate has already ended, and then there is no session.
 */
export function loginSession(secret: string, login: MandateLoginPrincipal | null): { token: string; maxAge: number } | null {
	if (login === null) return ownerSession(secret);
	const nowS = Math.floor(Date.now() / 1000);
	const principal = mandateSessionPrincipal(login, nowS);
	if (principal === null) return null;
	return { token: createSessionToken(secret, principal), maxAge: principal.exp - nowS };
}

/** The owner's session: no principal, 30 days, as every login minted it before mandates. */
export function ownerSession(secret: string): { token: string; maxAge: number } {
	return { token: createSessionToken(secret), maxAge: SESSION_MAX_AGE_S };
}

/**
 * The session for the success body of a code or link login. `unknown_principal`
 * when the body names a principal this reader does not know, which is refused,
 * never read as the owner; `ended` when the mandate it names has already ended.
 */
export function loginSessionFromBody(secret: string, body: unknown): { token: string; maxAge: number } | 'unknown_principal' | 'ended' {
	const login = readLoginPrincipal(body);
	if (login === 'invalid') return 'unknown_principal';
	return loginSession(secret, login) ?? 'ended';
}

/** Verify a session token is correctly signed and not expired (see `readSessionToken`). */
export function verifySessionToken(token: string, secret: string): boolean {
	return readSessionToken(token, secret) !== null;
}

/** Constant-time comparison that hashes both sides first (no length oracle). */
export function secretEquals(input: string, secret: string): boolean {
	const a = createHmac('sha256', 'lynox-auth').update(input).digest();
	const b = createHmac('sha256', 'lynox-auth').update(secret).digest();
	return timingSafeEqual(a, b);
}

/**
 * Decide whether the originating request was over HTTPS. Behind a TLS-
 * terminating reverse proxy (Traefik / Cloudflare), `url.protocol` reflects
 * the proxy→app inner hop and is always `http:`; the trustworthy signal is
 * the `x-forwarded-proto` header the proxy sets. Falls back to
 * `url.protocol` for direct connections (self-hosted localhost / LAN dev).
 *
 * Used to set the `Secure` flag on session cookies — missing the flag on
 * managed deployments lets the browser send the cookie over plaintext if
 * an HTTPS-downgrade can be coerced. Previously inlined as
 * `url.protocol === 'https:'` at six call sites in login + magic; the
 * inline form silently dropped the flag behind every reverse proxy.
 */
export function isHttpsRequest(url: URL, request: Request): boolean {
	if (url.protocol === 'https:') return true;
	const xfp = request.headers.get('x-forwarded-proto') ?? '';
	return xfp.split(',')[0]?.trim().toLowerCase() === 'https';
}

// ── Rate limiting (in-memory, per-IP) ───────────────────────────────

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const attempts = new Map<string, RateLimitEntry>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Check if an IP is rate-limited (does NOT increment — call recordFailedLogin on failure). */
export function isRateLimited(ip: string): { limited: boolean; retryAfter?: number } {
	const now = Date.now();
	const entry = attempts.get(ip);

	if (!entry || now >= entry.resetAt) return { limited: false };

	if (entry.count >= MAX_ATTEMPTS) {
		const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
		return { limited: true, retryAfter };
	}

	return { limited: false };
}

/** Record a failed login attempt for rate limiting. */
export function recordFailedLogin(ip: string): void {
	const now = Date.now();
	const entry = attempts.get(ip);

	if (!entry || now >= entry.resetAt) {
		attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
	} else {
		entry.count++;
	}
}

/** Clear rate limit for an IP after successful login. */
export function clearRateLimit(ip: string): void {
	attempts.delete(ip);
}

// Cleanup stale entries every 60 s
setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of attempts) {
		if (now >= entry.resetAt) attempts.delete(ip);
	}
}, 60_000).unref();

// ── One-time link codes (for QR login) ────────────────────────────

interface LinkCode {
	code: string;
	expiresAt: number;
}

const linkCodes = new Map<string, LinkCode>();
const LINK_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Create a one-time link code that can be used once to authenticate. */
export function createLinkCode(): string {
	const code = randomBytes(32).toString('base64url');
	linkCodes.set(code, { code, expiresAt: Date.now() + LINK_CODE_TTL_MS });
	return code;
}

/** Validate and consume a one-time link code. Returns true if valid. */
export function consumeLinkCode(code: string): boolean {
	const entry = linkCodes.get(code);
	if (!entry) return false;
	linkCodes.delete(code);
	return Date.now() < entry.expiresAt;
}

// Cleanup expired codes
setInterval(() => {
	const now = Date.now();
	for (const [code, entry] of linkCodes) {
		if (now >= entry.expiresAt) linkCodes.delete(code);
	}
}, 60_000).unref();
