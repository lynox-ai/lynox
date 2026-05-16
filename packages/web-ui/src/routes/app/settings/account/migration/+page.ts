import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-F — `/app/settings/account/migration` is a Settings-side
 * stub that forwards to the canonical wizard at `/app/migration`. We keep a
 * consistent Settings URL ("Account & Access > Migration") so the index tile
 * can link into the Settings namespace, while the actual wizard route stays
 * untouched — bookmarks to `/app/migration` (incl. Managed users who land on
 * the wizard's "you're already managed" empty-state) keep working.
 *
 * Tier-gating happens in `SettingsIndex.svelte` via `keepItem(selfHostOnly)`;
 * Managed users never see the tile, so this redirect is only reachable for
 * self-host users in normal flows. SSR-side `redirect()` so cold bookmark
 * loads land on the wizard without a client-only flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
	throw redirect(301, '/app/migration');
};
