import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// PRD-IA-V2 P3-PR-F — `/app/settings/mobile` relocated to `account/mobile`.
// Hardcoded target (PRD S2).
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/account/mobile');
};
