import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P1-PR-C — `/app/settings/keys` was a redirect-only stub pointing
 * at the deleted `/app/settings/config?tab=provider`. Generic API-Key CRUD
 * (Tavily / Brevo / custom) now lives in `SecretsView.svelte` mounted at
 * `/app/settings/llm/keys` (shipped in P1-PR-A1). SSR redirect so bookmarks
 * survive cold-load (no client-only `goto()` flash).
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/llm/keys');
};
