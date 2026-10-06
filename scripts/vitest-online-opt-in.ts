/**
 * tests/online/ calls real provider APIs, so it runs only on request.
 *
 * Before 2026-10-06 the online tests ran whenever a key was found — in the
 * environment or in ~/.lynox/config.json — so an ordinary `npx vitest run` on a
 * developer machine spent real tokens, and unsetting the environment variable
 * did not stop it once the config fallback read the field the config carries.
 * Same convention as tests/eval (`LYNOX_EVAL=1`): the switch is explicit.
 */
export const ONLINE_TESTS_GLOB = 'tests/online/**';

/** Why tests/online/ is left out of this run, or null when it was asked for. */
export function onlineTestsSkipReason(env: Record<string, string | undefined>): string | null {
  if (env['LYNOX_ONLINE'] === '1') return null;
  return '[vitest] tests/online/ skipped: these tests call real provider APIs and run only with LYNOX_ONLINE=1 (e.g. `LYNOX_ONLINE=1 npx vitest run tests/online/`).';
}
