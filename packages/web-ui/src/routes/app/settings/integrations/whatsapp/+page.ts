import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { assertChannelTarget } from '$lib/utils/redirect-allowlist.js';

/**
 * PRD-IA-V2 P3-PR-A2 — WhatsApp channel moved to `/app/settings/channels/whatsapp`.
 * Security S2: allowlisted target, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, assertChannelTarget('/app/settings/channels/whatsapp'));
};
