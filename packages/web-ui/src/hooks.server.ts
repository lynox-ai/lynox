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

const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"font-src 'self'",
			"connect-src 'self'",
			"frame-src blob: data:",
			"frame-ancestors 'self'",
			"base-uri 'self'",
			"form-action 'self'",
		].join('; ')
	);
	return response;
};

export const handle = sequence(handleAuth, handleSecurityHeaders);
