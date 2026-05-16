import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-H — IntelligenceHub shrinks 5 → 4 top-tabs. The legacy
 * `?tab=insights` top-tab is folded as a sub-tab under `graph` (both Beta,
 * both AgentMemoryDb-aggregate). This handler 301-redirects inbound
 * `?tab=insights` to `?tab=graph&sub=insights` so deeplink bookmarks survive.
 *
 * Hub visits without `?tab=insights` fall through to `+page.svelte` and
 * render normally — this load only fires the redirect when the legacy
 * top-tab is requested.
 *
 * Security mandate (PRD Risks "Open-Redirect via crafted Query/Hash" + S2):
 *   - Target path is a hard-coded literal `/app/intelligence?...`; no
 *     user-input passthrough into the redirect target.
 *   - Defence-in-depth allowlist asserts the literal target before throw.
 */

const REDIRECT_TARGET = '/app/intelligence?tab=graph&sub=insights';

// Defence-in-depth allowlist: a future edit to REDIRECT_TARGET must keep the
// target inside the `/app/` namespace and inside the known literal set.
const ALLOWED_TARGETS = new Set<string>([REDIRECT_TARGET]);

export const load: PageLoad = ({ url }) => {
  if (url.searchParams.get('tab') !== 'insights') return;
  if (!ALLOWED_TARGETS.has(REDIRECT_TARGET) || !REDIRECT_TARGET.startsWith('/app/')) return;
  throw redirect(301, REDIRECT_TARGET);
};
