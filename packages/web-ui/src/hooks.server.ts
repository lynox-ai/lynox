import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { verifySessionToken } from '$lib/server/auth.js';

/** Exact paths that never require authentication. */
const PUBLIC_EXACT = new Set(['/login', '/logout', '/health']);
/** Prefixes that never require authentication (with trailing slash enforced). */
const PUBLIC_PREFIXES = ['/auth/passkey'];

function isPublic(pathname: string): boolean {
	if (PUBLIC_EXACT.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

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

const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://static.cloudflareinsights.com",
			"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
			"img-src 'self' data: blob:",
			"media-src 'self' blob:",
			"font-src 'self' https://fonts.gstatic.com",
			"connect-src 'self' https://cloudflareinsights.com",
			"frame-src blob: data:",
			"frame-ancestors 'self'",
			"base-uri 'self'",
			"form-action 'self'",
		].join('; ')
	);
	return response;
};

export const handle = sequence(handleAuth, handleBuildShaInjection, handleSecurityHeaders);
