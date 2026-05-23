import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ cookies, request }) => {
	// Two guards: cross-site clicks (CSRF nuisance) AND same-origin SvelteKit
	// data-prefetches (hovering a logout link triggers __data.json fetch which
	// runs this load() — would silently log the user out, observed in staging
	// at 17:29 UTC on 2026-05-23). Only act when this is a real top-level
	// navigation: sec-fetch-dest === 'document'. Data-loads send 'empty'.
	const fetchSite = request.headers.get('sec-fetch-site');
	const fetchDest = request.headers.get('sec-fetch-dest');
	const isCrossSite = fetchSite === 'cross-site';
	const isTopLevelNavigation = fetchDest === 'document';
	if (cookies.get('lynox_session') && !isCrossSite && isTopLevelNavigation) {
		cookies.delete('lynox_session', { path: '/' });
	}
	redirect(303, '/login');
};
