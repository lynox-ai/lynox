/**
 * The environment one call runs with (PRD 152 v2 §4.1; W1 plan, refute S7).
 *
 * The client builds the allowlisted env with `buildSafeEnv`, which passes through names
 * that carry ENGINE paths (`TMP`, `PWD`, `XDG_*`, `LYNOX_WORKSPACE`, …). Inside the
 * sidecar those paths are wrong at best and a pointer back into the engine's layout at
 * worst, so the daemon drops them and sets the per-call ones itself. It never adds its
 * own environment.
 */

export const CALL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const DROPPED_EXACT = new Set(['HOME', 'TMPDIR', 'PATH', 'TMP', 'TEMP', 'PWD', 'OLDPWD', 'LYNOX_WORKSPACE', 'BASH_ENV', 'ENV']);
const DROPPED_PREFIXES = ['XDG_', 'LD_'];

export function isDroppedEnvName(name: string): boolean {
  return DROPPED_EXACT.has(name) || DROPPED_PREFIXES.some((p) => name.startsWith(p));
}

/** The env a call gets: the client's names minus the dropped ones, plus the call's own. */
export function buildCallEnv(clientEnv: Readonly<Record<string, string>>, callDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(clientEnv)) {
    if (!isDroppedEnvName(name)) env[name] = value;
  }
  env['HOME'] = callDir;
  env['TMPDIR'] = callDir;
  env['PATH'] = CALL_PATH;
  return env;
}
