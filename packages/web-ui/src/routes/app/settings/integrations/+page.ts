import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { assertChannelTarget } from '$lib/utils/redirect-allowlist.js';

/**
 * PRD-IA-V2 P3-PR-A2 — `/app/settings/integrations` index split into the
 * new `/app/settings/channels` hub + 5 per-channel sub-routes. Cold bookmark
 * loads land on the new hub via an SSR-side 301.
 *
 * Security (PRD S2 "Open-Redirect via crafted Query/Hash"): target runs
 * through the channel-redirect allowlist; no user-input passthrough, query
 * and hash on the legacy URL are dropped.
 */
export const load: PageLoad = () => {
  throw redirect(301, assertChannelTarget('/app/settings/channels'));
};
