import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-F — `/app/settings/mobile` relocated to
 * `/app/settings/account/mobile` (new "Account & Access" section). The
 * component (`MobileAccess.svelte`) is mounted unchanged at the new path;
 * this redirect preserves bookmarks during the transition.
 *
 * SSR-side `redirect()` so cold bookmark loads land on the right page
 * without a client-only flash. Hard-coded target path, no user input.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
	throw redirect(301, '/app/settings/account/mobile');
};
