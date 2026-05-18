import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * v1.5.2 (rafael QA 2026-05-18): 3rd-party API-key CRUD moved out of LLM
 * Settings into the Automation Hub (where API Profile endpoints live), so
 * the two related surfaces — endpoints + their auth — share one home.
 * SSR redirect so bookmarks + the older `/app/settings/keys` chained
 * redirect survive without client-side flicker.
 *
 * Security: hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/hub?section=keys');
};
