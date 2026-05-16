import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// PRD-IA-V2 P3-PR-F — Settings-side stub forwards to canonical wizard at
// `/app/migration` so the Account & Access index can link into the Settings
// namespace. Hardcoded target (PRD S2).
export const load: PageLoad = () => {
  throw redirect(301, '/app/migration');
};
