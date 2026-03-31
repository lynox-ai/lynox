import type { PageServerLoad } from './$types.js';
import { redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ cookies }) => {
	// Only delete if the cookie was actually sent (sameSite:strict blocks
	// cross-site requests, so this prevents CSRF-forced logout).
	if (cookies.get('lynox_session')) {
		cookies.delete('lynox_session', { path: '/' });
	}
	redirect(303, '/login');
};
