import type { PageServerLoad, Actions } from './$types.js';
import { redirect, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSessionToken,
	verifySessionToken,
	secretEquals,
	consumeLinkCode,
	isRateLimited,
	recordFailedLogin,
	clearRateLimit,
} from '$lib/server/auth.js';

/** Redirect to /app if already authenticated (or auth disabled). */
export const load: PageServerLoad = async ({ cookies, url, getClientAddress }) => {
	const secret = env.LYNOX_HTTP_SECRET;
	if (!secret) redirect(303, '/app');

	const token = cookies.get('lynox_session');
	if (token && verifySessionToken(token, secret)) {
		redirect(303, '/app');
	}

	// Auto-login via one-time ?code= parameter (from QR code — code is single-use, 5 min TTL)
	const codeParam = url.searchParams.get('code');
	if (codeParam && secret) {
		const ip = getClientAddress();
		if (isRateLimited(ip).limited) return {};
		if (!consumeLinkCode(codeParam)) {
			recordFailedLogin(ip);
			return {};
		}
		clearRateLimit(ip);
		const session = createSessionToken(secret);
		const isSecure = url.protocol === 'https:';
		cookies.set('lynox_session', session, {
			path: '/',
			httpOnly: true,
			secure: isSecure,
			sameSite: 'strict',
			maxAge: 7 * 24 * 60 * 60,
		});
		redirect(303, '/app');
	}

	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const secret = env.LYNOX_HTTP_SECRET;
		if (!secret) redirect(303, '/app');

		// Rate limit by IP (check only — increment on failure)
		const ip = getClientAddress();
		const limit = isRateLimited(ip);
		if (limit.limited) {
			return fail(429, {
				error: `Too many attempts. Try again in ${limit.retryAfter}s.`,
			});
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

		// Create session cookie
		const session = createSessionToken(secret);
		const isSecure = url.protocol === 'https:';

		cookies.set('lynox_session', session, {
			path: '/',
			httpOnly: true,
			secure: isSecure,
			sameSite: 'strict',
			maxAge: 7 * 24 * 60 * 60, // 7 days
		});

		redirect(303, '/app');
	},
};
