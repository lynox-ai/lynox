import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

/** Derive a purpose-specific key so the raw secret is never used directly. */
function deriveKey(secret: string, purpose: string): Buffer {
	return createHmac('sha256', purpose).update(secret).digest();
}

// ── Session tokens ──────────────────────────────────────────────────

/** Create a signed session token: `<unix_ts>.<hmac_hex>`. */
export function createSessionToken(secret: string): string {
	const key = deriveKey(secret, 'lynox-session');
	const ts = Math.floor(Date.now() / 1000).toString();
	const hmac = createHmac('sha256', key).update(ts).digest('hex');
	return `${ts}.${hmac}`;
}

/** Verify a session token is correctly signed and not expired. */
export function verifySessionToken(token: string, secret: string): boolean {
	const dot = token.indexOf('.');
	if (dot === -1) return false;

	const ts = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!ts || !sig) return false;

	const timestamp = parseInt(ts, 10);
	if (Number.isNaN(timestamp)) return false;

	// Expired?
	if (Math.floor(Date.now() / 1000) - timestamp > SESSION_MAX_AGE_S) return false;

	// Verify HMAC (constant-time, derived key)
	const key = deriveKey(secret, 'lynox-session');
	const expected = createHmac('sha256', key).update(ts).digest('hex');
	try {
		const sigBuf = Buffer.from(sig, 'hex');
		const expBuf = Buffer.from(expected, 'hex');
		if (sigBuf.length !== expBuf.length) return false;
		return timingSafeEqual(sigBuf, expBuf);
	} catch {
		return false;
	}
}

/** Constant-time comparison that hashes both sides first (no length oracle). */
export function secretEquals(input: string, secret: string): boolean {
	const a = createHmac('sha256', 'lynox-auth').update(input).digest();
	const b = createHmac('sha256', 'lynox-auth').update(secret).digest();
	return timingSafeEqual(a, b);
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
