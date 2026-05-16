import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-B — `/app/settings/integrations/tools` migrated to
 * `/app/settings/workspace/tools` (Self-Host only home). On Managed,
 * P3-PR-E will mount the same `ToolToggles.svelte` at `/privacy/tools`;
 * the index uses `keepItem()` to hide the tier-wrong entry. Until P3-PR-E
 * lands, both tiers redirect to `/workspace/tools` — Managed users still
 * reach the same component, just under a name that will be renamed
 * cosmetically in the next sprint.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/workspace/tools');
};
