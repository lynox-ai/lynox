import type { PageServerLoad, Actions } from './$types.js';
import { redirect, fail, isRedirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
	createSessionToken,
	verifySessionToken,
	secretEquals,
	consumeLinkCode,
	isRateLimited,
	recordFailedLogin,
	clearRateLimit,
	SESSION_MAX_AGE_S,
} from '$lib/server/auth.js';

// ── Managed mode detection ─────────────────────────────────────────

function getManagedConfig() {
	const instanceId = env.LYNOX_MANAGED_INSTANCE_ID;
	const controlPlaneUrl = env.LYNOX_MANAGED_CONTROL_PLANE_URL;
	const customerEmail = env.LYNOX_MANAGED_CUSTOMER_EMAIL;
	if (instanceId && controlPlaneUrl) {
		return { instanceId, controlPlaneUrl, customerEmail };
	}
	return null;
}

/** Get HTTP secret or null. Used as both session secret and instance auth. */
function getSecret(): string | null {
	return env.LYNOX_HTTP_SECRET ?? null;
}

// ── Onboarding token helpers ───────────────────────────────────────

function isOnboardingConsumed(): boolean {
	const dir = env.LYNOX_DATA_DIR ?? join(homedir(), '.lynox');
	return existsSync(join(dir, '.onboarding-consumed'));
}

function consumeOnboardingToken(): void {
	const dir = env.LYNOX_DATA_DIR ?? join(homedir(), '.lynox');
	try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
	writeFileSync(join(dir, '.onboarding-consumed'), new Date().toISOString(), 'utf-8');
}

// ── Session cookie helper ──────────────────────────────────────────

function setSessionCookie(cookies: Parameters<PageServerLoad>[0]['cookies'], secret: string, isSecure: boolean) {
	const session = createSessionToken(secret);
	cookies.set('lynox_session', session, {
		path: '/',
		httpOnly: true,
		secure: isSecure,
		sameSite: 'strict',
		maxAge: SESSION_MAX_AGE_S,
	});
}

// ── Load function ──────────────────────────────────────────────────

export const load: PageServerLoad = async ({ cookies, url, getClientAddress, setHeaders }) => {
	// Prevent caching — login state is dynamic (managed mode, passkey status)
	setHeaders({ 'Cache-Control': 'no-store' });
	const secret = getSecret();
	if (!secret) redirect(303, '/app');

	const token = cookies.get('lynox_session');
	if (token && verifySessionToken(token, secret)) {
		redirect(303, '/app');
	}

	// Auto-login via one-time ?code= parameter (from QR code)
	const codeParam = url.searchParams.get('code');
	if (codeParam) {
		const ip = getClientAddress();
		if (isRateLimited(ip).limited) return { isManaged: false };
		if (!consumeLinkCode(codeParam)) {
			recordFailedLogin(ip);
			return { isManaged: false };
		}
		clearRateLimit(ip);
		setSessionCookie(cookies, secret, url.protocol === 'https:');
		redirect(303, '/app');
	}

	// Auto-login via ?token= parameter (one-time onboarding magic link)
	const tokenParam = url.searchParams.get('token');
	const onboardingToken = env.LYNOX_ONBOARDING_TOKEN;
	if (tokenParam && onboardingToken && !isOnboardingConsumed()) {
		const ip = getClientAddress();
		if (isRateLimited(ip).limited) return { isManaged: false };
		if (!secretEquals(tokenParam, onboardingToken)) {
			recordFailedLogin(ip);
			return { isManaged: false };
		}
		clearRateLimit(ip);
		consumeOnboardingToken();
		setSessionCookie(cookies, secret, url.protocol === 'https:');
		redirect(303, '/app');
	}

	// Return managed mode info for the login form
	const managed = getManagedConfig();
	if (managed) {
		// Check if customer has registered passkeys
		let hasPasskeys = false;
		try {
			const secret = getSecret();
			if (secret) {
				const res = await fetch(`${managed.controlPlaneUrl}/internal/auth/webauthn/status`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-instance-secret': secret,
					},
					body: JSON.stringify({ instanceId: managed.instanceId, email: managed.customerEmail }),
				});
				if (res.ok) {
					const data = await res.json() as { hasPasskeys?: boolean };
					hasPasskeys = data.hasPasskeys === true;
				}
			}
		} catch { /* control plane unreachable — fallback to OTP */ }

		return {
			isManaged: true,
			customerEmail: managed.customerEmail ?? undefined,
			hasPasskeys,
		};
	}

	return { isManaged: false, hasPasskeys: false };
};

// ── Actions ────────────────────────────────────────────────────────

export const actions: Actions = {
	/** Self-hosted: token-based login (unchanged). */
	token: async ({ request, cookies, url, getClientAddress }) => {
		const secret = getSecret();
		if (!secret) redirect(303, '/app');

		const ip = getClientAddress();
		const limit = isRateLimited(ip);
		if (limit.limited) {
			return fail(429, { error: `Too many attempts. Try again in ${limit.retryAfter}s.` });
		}

		const data = await request.formData();
		const input = data.get('token');

		if (typeof input !== 'string' || !input) {
			recordFailedLogin(ip);
			return fail(400, { error: 'Token is required.' });
		}

		if (!secretEquals(input, secret)) {
			recordFailedLogin(ip);
			return fail(401, { error: 'Invalid token.' });
		}

		clearRateLimit(ip);
		setSessionCookie(cookies, secret, url.protocol === 'https:');
		redirect(303, '/app');
	},

	/** Managed: request OTP code via control plane. */
	requestOtp: async ({ request, getClientAddress }) => {
		const secret = getSecret();
		if (!secret) return fail(500, { error: 'Instance not configured.' });

		const managed = getManagedConfig();
		if (!managed) return fail(400, { error: 'Not a managed instance.' });

		const ip = getClientAddress();
		const limit = isRateLimited(ip);
		if (limit.limited) {
			return fail(429, { error: `Too many attempts. Try again in ${limit.retryAfter}s.` });
		}

		const data = await request.formData();
		const email = (data.get('email') as string ?? '').trim().toLowerCase();

		if (!email) {
			return fail(400, { error: 'Email is required.' });
		}

		try {
			const res = await fetch(`${managed.controlPlaneUrl}/internal/auth/request`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-instance-secret': secret,
				},
				body: JSON.stringify({ email, instanceId: managed.instanceId }),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Request failed' })) as { error?: string };
				if (res.status === 429) {
					return fail(429, { error: body.error ?? 'Please wait before requesting a new code.' });
				}
				// Don't reveal whether email mismatch or other auth failure
				if (res.status === 403) {
					recordFailedLogin(ip);
					return fail(403, { error: 'Could not send verification code. Please check your email address.' });
				}
				return fail(res.status, { error: body.error ?? 'Could not send verification code.' });
			}

			return { otpSent: true, email };
		} catch {
			return fail(502, { error: 'Could not reach the control plane. Please try again.' });
		}
	},

	/** Managed: verify OTP code via control plane, create local session. */
	verifyOtp: async ({ request, cookies, url, getClientAddress }) => {
		const secret = getSecret();
		if (!secret) redirect(303, '/app');

		const managed = getManagedConfig();
		if (!managed) return fail(400, { error: 'Not a managed instance.' });

		const ip = getClientAddress();
		const limit = isRateLimited(ip);
		if (limit.limited) {
			return fail(429, { error: `Too many attempts. Try again in ${limit.retryAfter}s.` });
		}

		const data = await request.formData();
		const email = (data.get('email') as string ?? '').trim().toLowerCase();
		const code = (data.get('code') as string ?? '').replace(/[\s\-]/g, '').trim();

		if (!email || !code) {
			return fail(400, { error: 'Email and code are required.' });
		}

		try {
			const userAgent = request.headers.get('user-agent') ?? '';
			const res = await fetch(`${managed.controlPlaneUrl}/internal/auth/verify`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-instance-secret': secret,
					'x-login-user-agent': userAgent,
					'x-login-ip': ip,
				},
				body: JSON.stringify({ email, code, instanceId: managed.instanceId }),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Verification failed' })) as { error?: string };
				recordFailedLogin(ip);
				return fail(res.status, { error: body.error ?? 'Invalid code.' });
			}

			// OTP valid — create local session
			clearRateLimit(ip);
			setSessionCookie(cookies, secret, url.protocol === 'https:');
			redirect(303, '/app');
		} catch (err: unknown) {
			if (isRedirect(err)) throw err;
			return fail(502, { error: 'Could not reach the control plane. Please try again.' });
		}
	},

	/** Managed: complete passkey authentication, create local session. */
	passkeyAuth: async ({ request, cookies, url, getClientAddress }) => {
		const secret = getSecret();
		if (!secret) redirect(303, '/app');

		const managed = getManagedConfig();
		if (!managed) return fail(400, { error: 'Not a managed instance.' });

		const ip = getClientAddress();
		const limit = isRateLimited(ip);
		if (limit.limited) {
			return fail(429, { error: `Too many attempts. Try again in ${limit.retryAfter}s.` });
		}

		const data = await request.formData();
		const valid = data.get('valid');

		if (valid !== 'true') {
			recordFailedLogin(ip);
			return fail(401, { error: 'Passkey verification failed.' });
		}

		// Passkey verified client-side via /api/passkey → control plane
		clearRateLimit(ip);
		setSessionCookie(cookies, secret, url.protocol === 'https:');
		redirect(303, '/app');
	},
};
