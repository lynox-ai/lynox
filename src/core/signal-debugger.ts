/**
 * Every node process the image starts runs with the signal-started debugger off
 * (`--disable-sigusr1`): without it, any process of the same user that can signal this one opens
 * a debugger on it. The image sets the flag twice, in the argv of entrypoint-webui.sh and as
 * `NODE_OPTIONS` in the Dockerfile (the egress proxy and the shell sidecar are started by a
 * compose file with their own entrypoint, so the environment is what reaches them).
 *
 * This is the check in each process that the flag took: a process protected only by the
 * environment must not start when an operator's `NODE_OPTIONS` replaced the image's. It reads
 * what this process was started with, `process.execArgv` and the `NODE_OPTIONS` value, and
 * nothing else.
 *
 * It does not rebuild node's option parser. It passes only what it can read for certain and
 * refuses every other form:
 * - the flag exactly as `--disable-sigusr1` in the argv (the entrypoint's), or in a `NODE_OPTIONS`
 *   without quotes, backslashes or line breaks;
 * - and no other spelling of it anywhere (`--no-disable-sigusr1`, `_` for `-`, `=value`), and no
 *   option that opens a debugger without a signal (`--inspect…` but the port settings).
 * To find those two, `NODE_OPTIONS` is read wider than node reads it (quotes and backslashes
 * dropped, split at any whitespace, `_` read as `-`): that can only refuse more, never less.
 */

import { realpathSync } from 'node:fs';

export const SIGNAL_DEBUGGER_OFF = '--disable-sigusr1';

/** Where the image puts the compiled code; a process started from here is one the image started. */
export const IMAGE_DIST = '/app/dist/';

/** An option that opens a debugger at start; the two port settings open nothing by themselves. */
function opensDebugger(option: string): boolean {
  return option.startsWith('--inspect') && !/^--inspect-(port|publish-uid)(=|$)/.test(option);
}

/** Every fragment of `NODE_OPTIONS` that node could read as an option, and more. */
function widerFragments(nodeOptions: string | undefined): string[] {
  return (nodeOptions ?? '').replace(/["'\\]/g, '').split(/\s+/).filter((t) => t !== '').map((t) => t.replace(/_/g, '-'));
}

/** `NODE_OPTIONS` that node splits at spaces only and that holds nothing to unquote. */
function plainOptions(nodeOptions: string | undefined): string[] | null {
  const raw = nodeOptions ?? '';
  if (/["'\\\t\n\r]/.test(raw)) return null;
  return raw.split(' ').filter((t) => t !== '');
}

/** Whether the flag is in force, and no debugger opened, for a process started with this argv and `NODE_OPTIONS`. */
export function signalDebuggerOff(execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  const argv = execArgv.map((t) => t.replace(/_/g, '-'));
  const every = [...widerFragments(nodeOptions), ...argv];
  if (every.some(opensDebugger)) return false;
  if (every.some((t) => /sigusr1/i.test(t) && t !== SIGNAL_DEBUGGER_OFF)) return false;
  if (execArgv.includes(SIGNAL_DEBUGGER_OFF)) return true;
  return plainOptions(nodeOptions)?.includes(SIGNAL_DEBUGGER_OFF) ?? false;
}

/** Whether the main module was started from the image's code, after symlinks. */
export function startedFromImage(mainArg: string | undefined): boolean {
  if (!mainArg) return false;
  let path = mainArg;
  try { path = realpathSync(mainArg); } catch { /* the literal path stands */ }
  return path.startsWith(IMAGE_DIST);
}

/**
 * Throws unless the flag is in force. `name` is the process the message names. The caller
 * decides when to ask: always in a process only the image starts, and in the engine when it
 * was started from the image's code.
 */
export function assertSignalDebuggerOff(
  name: string,
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env['NODE_OPTIONS'],
): void {
  if (signalDebuggerOff(execArgv, nodeOptions)) return;
  throw new Error(`${name} must start with ${SIGNAL_DEBUGGER_OFF} in its argv (or in a plain NODE_OPTIONS), with no other spelling of it and no option that opens a debugger; start it with ${SIGNAL_DEBUGGER_OFF} in its argv`);
}
