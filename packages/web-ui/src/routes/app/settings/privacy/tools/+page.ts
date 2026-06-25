import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * IA reorg (M6): ToolToggles had two identical mounts (this Managed route +
 * `/workspace/tools` on Self-Host). Unified to one all-tier route
 * `/app/settings/policy-tools`; this legacy path 301-redirects there.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/policy-tools');
};
