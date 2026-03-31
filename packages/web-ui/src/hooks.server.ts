import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { verifySessionToken } from '$lib/server/auth.js';

/** Paths that never require authentication. */
const PUBLIC_PATHS = ['/login', '/logout', '/health'];

function isPublic(pathname: string): boolean {
	return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export const handle: Handle = async ({ event, resolve }) => {
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

	// Unauthenticated — API routes get 401, pages get redirect
	if (pathname.startsWith('/api/')) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	redirect(303, '/login');
};
