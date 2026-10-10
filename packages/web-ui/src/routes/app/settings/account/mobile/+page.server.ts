import type { PageServerLoad } from './$types.js';
import { env } from '$env/dynamic/private';
import { createLinkCode, isOwnerSession } from '$lib/server/auth.js';

// PRD-IA-V2 P3-PR-F — relocated from /app/settings/mobile; behaviour identical.
export const load: PageServerLoad = async ({ cookies }) => {
	const secret = env.LYNOX_HTTP_SECRET ?? '';
	// A link code logs a device in as the owner, so only the owner's own session gets one.
	const ownerOnly = !!secret && !isOwnerSession(cookies.get('lynox_session'), secret);
	// Generate a one-time code (valid 5 min, single use)
	const linkCode = secret && !ownerOnly ? createLinkCode() : '';
	return { hasSecret: !!secret, linkCode, ownerOnly };
};
