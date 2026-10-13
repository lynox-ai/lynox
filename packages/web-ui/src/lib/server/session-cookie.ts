/**
 * The one place the session cookie is written: `/login`, `/auth/magic` and `/auth/renew`.
 */
import type { Cookies } from '@sveltejs/kit';

export const SESSION_COOKIE = 'lynox_session';

export function setSessionCookie(cookies: Cookies, session: { token: string; maxAge: number }, isSecure: boolean): void {
	cookies.set(SESSION_COOKIE, session.token, {
		path: '/',
		httpOnly: true,
		secure: isSecure,
		// Lax, not Strict: with Strict the cookie is not attached on a top-level navigation from
		// another site (a link tapped in a mail app), so `/login` cannot see a session that is
		// already there and `/auth/magic` cannot land one. Lax keeps it off cross-site POSTs.
		sameSite: 'lax',
		maxAge: session.maxAge,
	});
}
