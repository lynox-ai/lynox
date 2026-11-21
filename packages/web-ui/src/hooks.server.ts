import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { verifySessionToken } from '$lib/server/auth.js';
import { isPublic } from '$lib/server/public-paths.js';
import { applySecurityHeaders, refuseFraming } from '$lib/server/security-headers.js';

const handleAuth: Handle = async ({ event, resolve }) => {
	const secret = env.LYNOX_HTTP_SECRET;

	// No secret configured → auth gate disabled (localhost-only mode)
	if (!secret) return resolve(event);

	const { pathname } = event.url;

	// Public paths pass through
	if (isPublic(pathname)) return resolve(event);

	// Verify session cookie
	const token = event.cookies.get('lynox_session');
	if (token && verifySessionToken(token, secret)) {
		return resolve(event);
	}

	// Unauthenticated — API/auth routes get 401, pages get redirect
	if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	redirect(303, '/login');
};

/**
 * Bake the engine's BUILD_SHA into every served HTML page via a
 * placeholder substitution. The inline cold-start guard in app.html
 * compares this against /api/health.build_sha BEFORE any SvelteKit
 * chunk loads — the only way to recover an iOS PWA whose cached
 * index.html references chunk hashes that 404 against the new server
 * (the warm-tab StatusBar toast can't help if its own chunk 404s).
 *
 * Empty in local dev → the inline script no-ops (see the placeholder
 * sentinel check there).
 */
const HTML_BUILD_SHA = process.env['BUILD_SHA'] ?? '';
const handleBuildShaInjection: Handle = async ({ event, resolve }) => {
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			HTML_BUILD_SHA ? html.replace('__LYNOX_BUILD_SHA__', HTML_BUILD_SHA) : html,
	});
};

// LYNOX_DEMO_LOCALE locks the served `<html lang="…">` for accessibility and
// screen-reader correctness on demo tenants. Self-hosted / non-demo deployments
// keep the static `en` fallback in app.html.
const handleDemoHtmlLang: Handle = async ({ event, resolve }) => {
	const demoLocale = env['LYNOX_DEMO_LOCALE'] === 'de' ? 'de' : null;
	if (!demoLocale) return resolve(event);
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('<html lang="en">', `<html lang="${demoLocale}">`),
	});
};

// First in the sequence, so a refused request never reaches a route (see refuseFraming).
const handleFrameRefusal: Handle = async ({ event, resolve }) =>
	refuseFraming(event.url.pathname, event.request.headers.get('sec-fetch-dest')) ?? resolve(event);

const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	applySecurityHeaders(event.url.pathname, response.headers);
	return response;
};

export const handle = sequence(handleFrameRefusal, handleAuth, handleBuildShaInjection, handleDemoHtmlLang, handleSecurityHeaders);
