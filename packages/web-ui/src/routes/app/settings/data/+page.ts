import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P1-PR-C — `/app/settings/data` was a client-only redirect stub.
 * The Data surface lives in Intelligence (`/app/intelligence?tab=data`) —
 * neighbours: Knowledge, Graph, Contacts, Insights. SSR-side `redirect()` so
 * cold bookmark loads land on the right page without a client-only flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/intelligence?tab=data');
};
