import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-D — `/app/settings/voice` was the top-level Voice page
 * extracted from the dissolved Compliance tab (PRD-SETTINGS-REFACTOR
 * Principle 5). Phase-3 nests it under the Privacy & Compliance section at
 * `/app/settings/privacy/voice` — same `VoiceSettings` component, new home.
 * SSR redirect so bookmarks (rare — only ~3 days post-v1.5.0 launch) survive
 * cold-load without a client-only `goto()` flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/privacy/voice');
};
