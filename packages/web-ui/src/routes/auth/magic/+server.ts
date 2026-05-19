/**
 * Magic-link callback (Settings v3 PR 4.5 companion, 2026-05-19).
 *
 * Replaces the 6-digit OTP form with a clickable link: the email contains
 * a button → tap → arrive here with `?token=<magic-link>` → we POST to the
 * CP's `/internal/auth/verify-magic` → CP validates the HMAC token (15-min
 * TTL, replay-protected) → we mint the local `lynox_session` cookie → 303 to
 * `/app`.
 *
 * Why a server-route (not a page-server load): the callback is a one-shot
 * action that either sets the cookie or fails. There's no UI to render —
 * either the user lands on `/app` (success) or `/login?error=magic_<reason>`
 * (failure). A SvelteKit server-route gives us the cleanest GET handler.
 *
 * Cookie semantics mirror `/login` exactly (SameSite=Lax, see #469 for the
 * rationale). The magic-link arrival IS a cross-site top-level GET (link is
 * tapped in Mail.app); Lax lets the existing session cookie attach if any,
 * and our `setSessionCookie` write succeeds because top-level navigation
 * always accepts Set-Cookie regardless of Same-Site directive.
 */

import type { RequestHandler } from './$types.js';
import { redirect, isRedirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSessionToken,
	verifySessionToken,
	isRateLimited,
	recordFailedLogin,
	clearRateLimit,
	SESSION_MAX_AGE_S,
} from '$lib/server/auth.js';

function getManagedConfig() {
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

function redirectToLogin(reason: 'missing_token' | 'rate_limited' | 'unmanaged' | 'cp_unreachable' | 'invalid' | 'expired' | 'replay'): never {
	redirect(303, `/login?error=magic_${reason}`);
}

export const GET: RequestHandler = async ({ url, cookies, getClientAddress }) => {
	const secret = getSecret();
	if (!secret) redirect(303, '/app');

	// Already logged in? Skip the round-trip — the magic-link is a no-op
	// for someone who already has a valid session. Same guard as the /login
	// loader uses (post #469).
	const existing = cookies.get('lynox_session');
	if (existing && verifySessionToken(existing, secret)) {
		redirect(303, '/app');
	}

	const token = url.searchParams.get('token');
	if (!token || token.length < 32 || token.length > 4096) {
		redirectToLogin('missing_token');
	}

	const managed = getManagedConfig();
	if (!managed) {
		// Self-host instances don't have a CP — magic-link is managed-only.
		redirectToLogin('unmanaged');
	}

	const ip = getClientAddress();
	const limit = isRateLimited(ip);
	if (limit.limited) {
		redirectToLogin('rate_limited');
	}

	try {
		const res = await fetch(`${managed.controlPlaneUrl}/internal/auth/verify-magic`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-instance-secret': secret,
				'x-login-ip': ip,
			},
			body: JSON.stringify({ token, instanceId: managed.instanceId }),
		});

		if (!res.ok) {
			recordFailedLogin(ip);
			// Translate CP status codes to user-visible reasons.
			// 410 = expired/replay (we don't distinguish over the wire to keep
			// the error response shape minimal — both mean "request a new link").
			// 401 = invalid (tampered, wrong secret, malformed).
			// Any other 4xx/5xx falls into "cp_unreachable" as a generic banner.
			if (res.status === 410) {
				const body = await res.json().catch(() => null) as { error?: string } | null;
				const isReplay = body?.error?.toLowerCase().includes('already used') ?? false;
				redirectToLogin(isReplay ? 'replay' : 'expired');
			}
			if (res.status === 401 || res.status === 403) {
				redirectToLogin('invalid');
			}
			redirectToLogin('cp_unreachable');
		}

		// Magic-link valid — mint local session, clear rate limit.
		clearRateLimit(ip);
		setSessionCookie(cookies, secret, url.protocol === 'https:');
		redirect(303, '/app');
	} catch (err: unknown) {
		if (isRedirect(err)) throw err;
		redirectToLogin('cp_unreachable');
	}
};
