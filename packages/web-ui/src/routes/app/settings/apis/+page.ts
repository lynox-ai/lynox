import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P1-PR-C — `/app/settings/apis` was a client-only redirect stub.
 * API Profiles live in Automation Hub (`/app/hub?section=apis`) — their
 * conceptual home alongside Workflows + Tasks. SSR-side `redirect()` so cold
 * bookmark loads land on the right page without a client-only flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/hub?section=apis');
};
