import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ cookies, request }) => {
	// Only delete if the cookie was actually sent. Under SameSite=Lax, a
	// malicious cross-site link to /logout WOULD now carry the cookie (top-
	// level GET nav), so this no longer blocks CSRF-forced logout on its own
	// — accept the trade-off because forced-logout is only a nuisance (user
	// re-logins), not a security breach. Belt-and-braces: cross-site link
	// clicks generally set a non-same-origin Referer or Sec-Fetch-Site=
	// cross-site; reject obviously cross-site triggers when the header is
	// trustworthy. Same-app navigation (Sec-Fetch-Site=same-origin) passes.
	const fetchSite = request.headers.get('sec-fetch-site');
	const isCrossSite = fetchSite === 'cross-site';
	if (cookies.get('lynox_session') && !isCrossSite) {
		cookies.delete('lynox_session', { path: '/' });
	}
	redirect(303, '/login');
};
