import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSessionToken,
	verifySessionToken,
	isRateLimited,
	recordFailedLogin,
} from '$lib/server/auth.js';
import { DEMO_SESSION_MAX_AGE_S, isDemoMode } from '$lib/server/demo-mode.js';

// Demo-mode auto-session: when LYNOX_DEMO_MODE=true the engine is a public
// playground, so the root route mints a session for any anonymous visitor and
// drops them straight at /app. Defence in depth: only fires when the env var is
// the literal string 'true'; the CP provisioner only injects that on tenants
// whose subdomain matches `*-demo`. Mint is also gated by the per-IP rate
// limiter so a botnet can't churn cookies and exhaust the demo tenant's LLM
// budget — exceeding the limit returns 429 from the standard /login path.
export const load: PageServerLoad = async ({ cookies, url, getClientAddress, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });

	const secret = env.LYNOX_HTTP_SECRET ?? null;

	// Self-hosted without LYNOX_HTTP_SECRET set: /app handles the unsecured
	// landing flow itself. Preserve that path.
	if (!secret) redirect(303, '/app');

	const existing = cookies.get('lynox_session');
	if (existing && verifySessionToken(existing, secret)) redirect(303, '/app');

	if (isDemoMode()) {
		const ip = getClientAddress();
		if (isRateLimited(ip).limited) {
			// Don't mint a session — the visitor needs to back off. Redirecting to
			// /login surfaces the 429 path with a retry-after via the login flow's
			// own rate-limit response. Audit-tag the failure so reviewers can spot
			// the botnet pattern.
			recordFailedLogin(ip);
			redirect(303, '/login?error=rate_limited');
		}
		cookies.set('lynox_session', createSessionToken(secret), {
			path: '/',
			httpOnly: true,
			secure: url.protocol === 'https:',
			sameSite: 'lax',
			maxAge: DEMO_SESSION_MAX_AGE_S,
		});
		redirect(303, '/app');
	}

	redirect(303, '/login');
};
