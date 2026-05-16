import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-B — `/app/settings/backups` migrated to
 * `/app/settings/workspace/backups` as part of the new tier-conditional
 * Workspace & System section (Self-Host only). SSR-side `redirect()` so
 * cold bookmark loads land on the right page without a client-only flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/workspace/backups');
};
