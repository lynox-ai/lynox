import type { PageServerLoad } from './$types.js';
import { env } from '$env/dynamic/private';
import { createLinkCode } from '$lib/server/auth.js';

/**
 * PRD-IA-V2 P3-PR-F — `MobileAccess.svelte` relocated from `/app/settings/mobile`
 * to `/app/settings/account/mobile` under the new "Account & Access" section.
 * Behaviour is identical to the old route's server load (issue a single-use
 * link-code derived from LYNOX_HTTP_SECRET); the move is index-only.
 */
export const load: PageServerLoad = async () => {
	const secret = env.LYNOX_HTTP_SECRET ?? '';
	// Generate a one-time code (valid 5 min, single use)
	const linkCode = secret ? createLinkCode() : '';
	return { hasSecret: !!secret, linkCode };
};
