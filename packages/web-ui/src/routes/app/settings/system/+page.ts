import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-B — `/app/settings/system` is dead. The old SystemSettings
 * surface owned three concerns (vault/access-token, update-check, HTTP-rate-
 * cap) that have been split across the new Workspace section:
 *   - vault + access-token  → /settings/workspace/security
 *   - update-check          → /settings/workspace/updates
 *   - max_http_requests/hr  → /settings/workspace/limits  (merged with spend)
 *
 * Default landing is `/workspace/security` (highest-friction concern). A
 * `?part=` query lets explicit deeplinks land on the right sub-page.
 *
 * Security mandate (PRD S2 "Open-Redirect"): both the query→target mapping
 * AND the final pathname are checked against a hard-coded allowlist; any
 * unmapped or non-`/app/`-prefixed target falls back to the default.
 */

const PART_TARGETS: Record<string, string> = {
  security: '/app/settings/workspace/security',
  updates: '/app/settings/workspace/updates',
  limits: '/app/settings/workspace/limits',
};

const ALLOWED_PATHS = new Set<string>([
  '/app/settings/workspace/security',
  '/app/settings/workspace/updates',
  '/app/settings/workspace/limits',
]);

const DEFAULT_TARGET = '/app/settings/workspace/security';

export const load: PageLoad = ({ url }) => {
  const part = url.searchParams.get('part');
  const mapped = part && PART_TARGETS[part] ? PART_TARGETS[part] : DEFAULT_TARGET;
  const target = ALLOWED_PATHS.has(mapped) && mapped.startsWith('/app/') ? mapped : DEFAULT_TARGET;
  throw redirect(301, target);
};
