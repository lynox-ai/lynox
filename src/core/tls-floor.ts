/**
 * The TLS floor for every connection this process opens: TLS 1.2.
 *
 * Node 22 already defaults `tls.DEFAULT_MIN_VERSION` to TLS 1.2, but the default can be lowered
 * from outside the code. A start flag (`--tls-min-v1.0`, `--tls-min-v1.1`) does it, and so does
 * `NODE_OPTIONS`, which a host or a wrapper script may set. The default is what `fetch`,
 * `https`, `tls.connect` and the libraries built on them use whenever a caller passes no
 * `minVersion` of its own, so lowering it would quietly lower every provider, integration and
 * webhook call. Pinning it at boot makes the floor a property of the code, not of the launch
 * command.
 *
 * Only ever raises: a process started with a higher floor (`--tls-min-v1.3`) keeps it.
 * It is process-wide, so the engine's own HTTPS server (when it is given a certificate) gets
 * the same floor.
 *
 * A caller that passes an explicit lower `minVersion` still goes around this; the source guard
 * in `tls-floor.test.ts` refuses that in this repository's code.
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
