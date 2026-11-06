/**
 * The TLS floor for the connections the engine opens: TLS 1.2.
 *
 * Node 22 already defaults `tls.DEFAULT_MIN_VERSION` to TLS 1.2, but the default can be lowered
 * from outside the code. A start flag (`--tls-min-v1.0`, `--tls-min-v1.1`) does it, and so does
 * `NODE_OPTIONS`, which a host or a wrapper script may set. The default is what `fetch`,
 * `https`, `tls.connect` and the libraries built on them use whenever a caller passes no
 * `minVersion` of its own, so lowering it would quietly lower every provider, integration and
 * webhook call. Pinning it at boot makes the floor a property of the code, not of the launch
 * command.
 *
 * Called first in the CLI entry (`runCLI` in `src/index.ts`) and first in `Engine.init()`, so
 * it holds for the CLI, the HTTP server and anything that boots an engine. Only ever raises: a
 * process started with a higher floor (`--tls-min-v1.3`) keeps it. It is process-wide, so the
 * engine's own HTTPS server (when it is given a certificate) gets the same floor.
 *
 * What it does not reach:
 *  - a connection opened before the call and kept alive, which keeps its protocol;
 *  - a program that uses this package's modules without either entry point;
 *  - a caller that passes an explicit lower `minVersion`. The source guard in `tls-floor.test.ts`
 *    refuses that in this repository's code, for the forms it can see.
 */
import tls from 'node:tls';

/** The floor this process holds for TLS, in and out. */
export const TLS_FLOOR = 'TLSv1.2' as const;

const ORDER = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const;

/** Raise `tls.DEFAULT_MIN_VERSION` to {@link TLS_FLOOR} if it is lower. Idempotent. */
export function pinTlsFloor(): void {
  const current = ORDER.indexOf(tls.DEFAULT_MIN_VERSION as (typeof ORDER)[number]);
  // An unknown value (not one of the four) is treated as below the floor.
  if (current < ORDER.indexOf(TLS_FLOOR)) tls.DEFAULT_MIN_VERSION = TLS_FLOOR;
}
