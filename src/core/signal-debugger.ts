/**
 * Every node process the image starts runs with the signal-started debugger off
 * (`--disable-sigusr1`): without it, any process of the same user that can signal this one opens
 * a debugger on it. The image sets the flag twice, in the argv of entrypoint-webui.sh and as
 * `NODE_OPTIONS` in the Dockerfile (the egress proxy and the shell sidecar are started by a
 * compose file with their own entrypoint, so the environment is what reaches them).
 *
 * This is the check in each process that the flag took: a process protected only by the
 * environment must not start when an operator's `NODE_OPTIONS` replaced the image's. It reads
 * what this process was started with, `process.execArgv` and the `NODE_OPTIONS` node read at
 * start, and nothing else.
 */

import { realpathSync } from 'node:fs';

export const SIGNAL_DEBUGGER_OFF = '--disable-sigusr1';

/** Where the image puts the compiled code; a process started from here is one the image started. */
export const IMAGE_DIST = '/app/dist/';

/** Whether the flag is in force for a process started with this argv and `NODE_OPTIONS`. */
export function signalDebuggerOff(execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  if (execArgv.includes(SIGNAL_DEBUGGER_OFF)) return true;
  return (nodeOptions ?? '').split(/\s+/).includes(SIGNAL_DEBUGGER_OFF);
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
  throw new Error(`${name} must start with ${SIGNAL_DEBUGGER_OFF} (in its argv or NODE_OPTIONS); it was started without it`);
}
