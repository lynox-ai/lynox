import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P2-PR-D — `/app/hub?section=activity*` is dead. The Activity tab
 * was stripped from AutomationHub; daily-frequency content lives at
 * `/app/activity` (P2-PR-A). This handler 301-redirects any inbound
 * `?section=activity` (with or without `&tab=`) to the new root and strips
 * the legacy `section=` param before re-emitting (per PRD U12).
 *
 * Hub visits without `?section=activity` fall through to `+page.svelte` and
 * render normally — this load only fires the redirect when the section
 * matches the allowlist.
 *
 * Security mandate (PRD Risks "Open-Redirect via crafted Query/Hash" + S2):
 *   - SECTION_REDIRECT_MAP values are hard-coded `/app/`-prefixed paths.
 *   - Tab is validated against TAB_REWRITE_MAP (legacy ActivityHub tabs).
 *   - Unknown / unmapped tabs are dropped (target = bare section path).
 *   - We never feed a query-derived path or fragment into `redirect()`.
 */

// Hard-coded section → new-root mapping. Only keys present here trigger a
// redirect; everything else falls through to the SPA render.
const SECTION_REDIRECT_MAP: Readonly<Record<string, string>> = {
  activity: '/app/activity',
};

// Legacy ActivityHub sub-tabs (when it lived under the Hub) → new Activity-root
// tabs (`overview` / `history` / `workflows`). `dashboard` and `usage` both
// rendered the same "metrics dashboard" surface, which is the new `overview`.
// Any tab not listed here is silently dropped (lands on the section default).
const TAB_REWRITE_MAP: Readonly<Record<string, 'overview' | 'history' | 'workflows'>> = {
  overview: 'overview',
  dashboard: 'overview',
  usage: 'overview',
  history: 'history',
  workflows: 'workflows',
};

// Defence-in-depth allowlist: a future SECTION_REDIRECT_MAP edit must not
// emit a non-`/app/` target. Final pathname must literally appear here.
const ALLOWED_PATHS = new Set<string>(['/app/activity']);

export const load: PageLoad = ({ url }) => {
  const section = url.searchParams.get('section');
  if (!section) return;

  const target = SECTION_REDIRECT_MAP[section];
  if (!target) return;

  // Belt-and-braces: only redirect to a path that is (a) in the allowlist and
  // (b) starts with `/app/`. If the map is ever edited to point elsewhere,
  // we abort the redirect and let the hub render normally.
  if (!ALLOWED_PATHS.has(target) || !target.startsWith('/app/')) return;

  const rawTab = url.searchParams.get('tab');
  const rewrittenTab = rawTab && TAB_REWRITE_MAP[rawTab] ? TAB_REWRITE_MAP[rawTab] : null;

  // `overview` is the default tab on ActivityOverview — emit a bare URL when
  // it's the target, matching what `setTab('overview')` produces (no query).
  const destination =
    rewrittenTab && rewrittenTab !== 'overview' ? `${target}?tab=${rewrittenTab}` : target;

  throw redirect(301, destination);
};
