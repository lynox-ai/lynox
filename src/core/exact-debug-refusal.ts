/**
 * Once an instance holds an exact (Shopify) connection, its debug paths stay off
 * (PRD-SHOPIFY-CONTAINMENT-ERASURE E4, re-cut against Appendix B, B8).
 *
 * "Holds" is the engine.db marker K2 writes (`exact-clearance.ts`): set before the first store
 * pass, never cleared. It means "an exchange was sent", not "a token is bound" (D3): a failed
 * exchange sets it too, and so it refuses here as well. The refusal keys on the marker alone,
 * never on a profile or a token.
 *
 * It runs twice: at boot, as soon as engine.db is open, and in {@link ExactClearance} directly
 * after the marker is set, which is before the first pass.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getLynoxDir } from './config.js';
import type { ExactMarker } from './exact-clearance.js';
import { stopDebugSubscriber } from './debug-subscriber.js';
import { quietSdkLogs } from './llm-wire-rules.js';
import { closeWireCapture } from './wire-capture.js';
import { refuseErrorReporting } from './error-reporting.js';

/**
 * The variables that open a debug path:
 *  - `ANTHROPIC_LOG`: with `debug`, the SDK logs the full request;
 *  - `LYNOX_DEBUG` / `LYNOX_DEBUG_FILE`: the debug subscriber and its file;
 *  - `LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED`: wire capture on a provisioned instance;
 *  - `LYNOX_DEBUG_WIRE_CAPTURE`: the env form of the owner's `debug_wire_capture` setting.
 *    The setting itself is merged into the config at boot and can be switched on at runtime,
 *    so removing the variable is not enough: `closeWireCapture()` refuses the snapshots;
 *  - `LYNOX_BUGSINK_DSN`: error reporting. The client is built at boot and the user config can
 *    carry a DSN as well, so `refuseErrorReporting()` closes the client and refuses any re-init.
 */
export const DEBUG_ENV_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_LOG',
  'LYNOX_DEBUG',
  'LYNOX_DEBUG_FILE',
  'LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED',
  'LYNOX_DEBUG_WIRE_CAPTURE',
  'LYNOX_BUGSINK_DSN',
]);

/**
 * Whether this instance holds an exact connection. Fail-closed: no marker (engine.db did not
 * open) or a marker that cannot be read counts as held.
 */
export function isExactHeld(marker: ExactMarker | null): boolean {
  if (marker === null) return true;
  try {
    return marker.isSet();
  } catch {
    return true;
  }
}

/**
 * Whether the engine.db at `path` holds the exact marker, read before the engine opens it (for
 * what starts earlier in the boot: error reporting). No file, or a file from before the marker
 * table: not held. A file that exists but cannot be read: held.
 */
export function exactMarkerOnDisk(path: string = join(getLynoxDir(), 'engine.db')): boolean {
  if (!existsSync(path)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return db.prepare('SELECT 1 FROM exact_marker WHERE id = 1').get() !== undefined;
  } catch (err) {
    return !(err instanceof Error && /no such table: exact_marker/.test(err.message));
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

/**
 * Close the debug paths for the rest of the process: remove the variables, stop the debug
 * subscriber, turn the SDK's request log down on every live and future client, close every
 * wire capture, stop error reporting. Reports the
 * names it removed, never their values. Idempotent; returns the names removed by this call.
 */
export function refuseDebug(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = DEBUG_ENV_VARS.filter((name) => env[name] !== undefined);
  for (const name of removed) delete env[name];
  stopDebugSubscriber();
  quietSdkLogs();
  closeWireCapture();
  refuseErrorReporting();
  if (removed.length > 0) {
    process.stderr.write(`[lynox] exact connection held: debug paths are off; removed ${removed.join(', ')}\n`);
  }
  return removed;
}
