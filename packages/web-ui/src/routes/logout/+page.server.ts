import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ cookies, request }) => {
	// Two guards: cross-site clicks (CSRF nuisance) AND same-origin SvelteKit
	// data-loads (`/logout/__data.json` from hover-prefetch OR click intercepted
	// by the client router — both would silently log the user out without
	// reaching the redirect). Real top-level navigations send sec-fetch-dest=
	// 'document'; data-loads send 'empty'. We treat the absent header as a
	// real navigation (older browsers, curl, server-side fetches) — better to
	// honour an intended logout than to silently fail one.
	const fetchSite = request.headers.get('sec-fetch-site');
	const fetchDest = request.headers.get('sec-fetch-dest');
	const isCrossSite = fetchSite === 'cross-site';
	const isDataLoad = fetchDest !== null && fetchDest !== 'document';
	if (cookies.get('lynox_session') && !isCrossSite && !isDataLoad) {
		cookies.delete('lynox_session', { path: '/' });
	}
	redirect(303, '/login');
};
