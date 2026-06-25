import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Legacy `/app/settings/integrations/tools` → the unified ToolToggles route.
 * IA reorg (M6): the two tier-split mounts (`/workspace/tools`,
 * `/privacy/tools`) collapsed into one all-tier `/app/settings/policy-tools`;
 * this legacy path 301s straight there (no redirect chain).
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/policy-tools');
};
