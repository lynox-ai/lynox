import type { PageServerLoad } from './$types.js';
import { env } from '$env/dynamic/private';
import { createLinkCode } from '$lib/server/auth.js';

export const load: PageServerLoad = async () => {
	const secret = env.LYNOX_HTTP_SECRET ?? '';
	// Generate a one-time code (valid 5 min, single use)
	const linkCode = secret ? createLinkCode() : '';
	return { hasSecret: !!secret, linkCode };
};
