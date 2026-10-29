import type { PageServerLoad } from './$types.js';
import { env } from '$env/dynamic/private';
import { isOwnerSession } from '$lib/server/auth.js';

// UX-031: the bulk-runs switch is the owner's. Without a secret there is no login and no mandate,
// so the one who reaches the page is the owner. The server refuses a mandate's config write anyway.
export const load: PageServerLoad = async ({ cookies }) => {
	const secret = env.LYNOX_HTTP_SECRET ?? '';
	return { owner: !secret || isOwnerSession(cookies.get('lynox_session'), secret) };
};
