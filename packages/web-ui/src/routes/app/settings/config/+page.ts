import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P1-PR-A2 — `/app/settings/config` is dead. The old ConfigView was
 * deleted; this `+page.ts` only redirects to the extracted page that owns the
 * setting the user was looking for.
 *
 * Security mandate (PRD Risks "Open-Redirect via crafted Query/Hash"): we
 * never feed a query-derived path into `redirect()`. Both the tab→target
 * mapping AND the final pathname are checked against a hard-coded allowlist;
 * any unmapped or non-`/app/`-prefixed target falls back to `/app/settings/llm`.
 */

// Allowlist of valid redirect targets — every value here is statically known.
// Map keys are the legacy `?tab=` query strings from the old ConfigView.
const TAB_TARGETS: Record<string, string> = {
  provider: '/app/settings/llm',
  // Phase-3 will route `?tab=ai` to `/app/settings/llm/advanced`; until then
  // the LLM-page Advanced section (backfilled in P1-PR-A1) is the closest home.
  ai: '/app/settings/llm',
  compliance: '/app/settings/privacy',
  // Workspace/Limits lands Phase 3; cost-limits page stays the interim home.
  budget: '/app/hub/cost-limits',
  system: '/app/settings/system',
};

// Final allowlist — pathname must literally appear here. Defence in depth
// against a future TAB_TARGETS edit accidentally introducing a non-/app/ path.
const ALLOWED_PATHS = new Set<string>([
  '/app/settings/llm',
  '/app/settings/privacy',
  '/app/settings/system',
  '/app/hub/cost-limits',
]);

const DEFAULT_TARGET = '/app/settings/llm';

export const load: PageLoad = ({ url }) => {
  const tab = url.searchParams.get('tab');
  const mapped = tab && TAB_TARGETS[tab] ? TAB_TARGETS[tab] : DEFAULT_TARGET;
  // Belt-and-braces: only redirect to a path that is (a) in the allowlist and
  // (b) starts with `/app/`. Otherwise fall back to the default.
  const target = ALLOWED_PATHS.has(mapped) && mapped.startsWith('/app/') ? mapped : DEFAULT_TARGET;
  throw redirect(301, target);
};
