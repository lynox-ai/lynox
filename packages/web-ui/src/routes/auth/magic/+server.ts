/**
 * Magic-link callback (Settings v3 PR 4.5 companion, 2026-05-19).
 *
 * Thin SvelteKit shell around `decideMagicLinkOutcome` (see
 * `$lib/server/magic-link.ts` for the pure policy + tests). This file owns:
 * - env reads + getManagedConfig
 * - rate-limit increments
 * - cookie writes
 * - turning the outcome enum into a redirect
 *
 * Flow: user taps the link in Mail.app → `<tenant>.lynox.cloud/auth/magic?token=...`
 *   → POST to CP `/internal/auth/verify-magic` → on success mint local cookie + 303 /app
 *   → on failure 303 /login?error=magic_<reason>
 */

import type { RequestHandler } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSessionToken,
	verifySessionToken,
	isRateLimited,
	recordFailedLogin,
	clearRateLimit,
	SESSION_MAX_AGE_S,
} from '$lib/server/auth.js';
import { decideMagicLinkOutcome, type MagicLinkOutcome } from '$lib/server/magic-link.js';

function getManagedConfig(): { instanceId: string; controlPlaneUrl: string } | null {
	const instanceId = env.LYNOX_MANAGED_INSTANCE_ID;
	const controlPlaneUrl = env.LYNOX_MANAGED_CONTROL_PLANE_URL;
	if (instanceId && controlPlaneUrl) {
		return { instanceId, controlPlaneUrl };
	}
	return null;
}

function getSecret(): string | null {
	return env.LYNOX_HTTP_SECRET ?? null;
}

/**
 * Detect whether the request reached us over TLS, accounting for a
 * TLS-terminating reverse proxy (Traefik/Caddy/CF). Without this the
 * `lynox_session` cookie may be set without `Secure` on managed deployments
 * where SvelteKit sees the upstream as `http:`.
 */
function isHttpsRequest(url: URL, request: Request): boolean {
	if (url.protocol === 'https:') return true;
	const xfp = request.headers.get('x-forwarded-proto') ?? '';
	return xfp.split(',')[0]?.trim().toLowerCase() === 'https';
}

function setSessionCookie(
	cookies: Parameters<RequestHandler>[0]['cookies'],
	secret: string,
	isSecure: boolean,
) {
	const session = createSessionToken(secret);
	cookies.set('lynox_session', session, {
		path: '/',
		httpOnly: true,
		secure: isSecure,
		// Lax for the same reason as /login (#469): top-level navigation from
		// Mail.app must allow the cookie to land. State-changing POSTs still
		// need same-site origin so CSRF is unaffected.
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_S,
	});
}

export const GET: RequestHandler = async ({ url, request, cookies, getClientAddress }) => {
	const secret = getSecret();
	if (!secret) redirect(303, '/app');

	const ip = getClientAddress();
	const existing = cookies.get('lynox_session');
	const hasValidSession = !!existing && verifySessionToken(existing, secret);

	const outcome: MagicLinkOutcome = await decideMagicLinkOutcome({
		url,
		hasValidSession,
		rateLimited: isRateLimited(ip).limited,
		managed: getManagedConfig(),
		instanceSecret: secret,
		clientIp: ip,
		fetchImpl: fetch,
		onFailedLogin: () => recordFailedLogin(ip),
	});

	switch (outcome.type) {
		case 'already_logged_in':
			redirect(303, '/app');
		case 'success':
			clearRateLimit(ip);
			setSessionCookie(cookies, secret, isHttpsRequest(url, request));
			redirect(303, '/app');
		case 'redirect_login':
			redirect(303, `/login?error=magic_${outcome.reason}`);
		default: {
			// Exhaustiveness — a future widened union should hit this.
			const _exhaustive: never = outcome;
			redirect(303, '/login?error=magic_invalid');
		}
	}
};
