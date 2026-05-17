import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-X — Final CostLimits-Page delete. The legacy
 * `/app/hub/cost-limits` route is retired in favour of the canonical homes:
 *   - Spend-limits + HTTP-cap → `/app/settings/workspace/limits` (Self-Host)
 *   - Context-window radio    → `/app/settings/llm/advanced`
 *   - Usage / dashboard       → `/app/activity`
 *
 * We 301-redirect to `/app/settings/workspace/limits` — the form-edit target.
 * On Managed the page mounts (WorkspaceLimitsView) and shows the
 * "managed_notice" support-link section, so the redirect is safe for both
 * tiers. Hard-coded literal — never feed a query-derived path into
 * `redirect()` (PRD Risks "Open-Redirect via crafted Query/Hash" S2).
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/settings/workspace/limits');
};
