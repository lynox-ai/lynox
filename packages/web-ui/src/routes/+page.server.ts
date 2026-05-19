import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSessionToken,
	verifySessionToken,
	SESSION_MAX_AGE_S,
} from '$lib/server/auth.js';
import { isDemoMode } from '$lib/server/demo-mode.js';

// Demo-mode auto-session: when LYNOX_DEMO_MODE=true the engine is a public
// playground, so the root route mints a session for any anonymous visitor and
// drops them straight at /app. Defence in depth: only fires when the env var is
// the literal string 'true'; the CP provisioner only injects that on tenants
// whose subdomain matches `*-demo`.
export const load: PageServerLoad = async ({ cookies, url, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });

	const secret = env.LYNOX_HTTP_SECRET ?? null;

	// Self-hosted without LYNOX_HTTP_SECRET set: /app handles the unsecured
	// landing flow itself. Preserve that path.
	if (!secret) redirect(303, '/app');

	const existing = cookies.get('lynox_session');
	if (existing && verifySessionToken(existing, secret)) redirect(303, '/app');

	if (isDemoMode()) {
		cookies.set('lynox_session', createSessionToken(secret), {
			path: '/',
			httpOnly: true,
			secure: url.protocol === 'https:',
			sameSite: 'lax',
			maxAge: SESSION_MAX_AGE_S,
		});
		redirect(303, '/app');
	}

	redirect(303, '/login');
};
