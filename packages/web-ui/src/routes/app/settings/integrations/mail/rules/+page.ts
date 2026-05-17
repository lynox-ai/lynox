import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { assertChannelTarget } from '$lib/utils/redirect-allowlist.js';

/**
 * PRD-IA-V2 P3-PR-A2 + PRD-UNIFIED-INBOX.md Phase 4 — Inbox rules canonical
 * home is now `/app/settings/channels/mail/rules`. This redirect keeps the
 * old V1 path documented in the Inbox PRD working.
 * Security S2: allowlisted target, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, assertChannelTarget('/app/settings/channels/mail/rules'));
};
