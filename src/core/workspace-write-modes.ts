/**
 * The modes and the group of what the engine creates in the context directory when the shell runs
 * in the sidecar. The engine and every pool uid meet only in group `SHARED_GROUP`, so a file the
 * engine writes must be group-readable and -writable for `bash` to use it, and the other way
 * round. The shell sidecar layout fixes them: files `0o660`, directories `0o2770` (set-group-ID,
 * no sticky bit), group `SHARED_GROUP`, rather than taking them from the umask, which the image
 * does not set.
 *
 * Outside sidecar mode every caller keeps the modes it used before; this module answers `null`.
 */
import { SHARED_GROUP, shellIsolation } from './shell-isolation.js';

/** A file the engine creates in the context directory in sidecar mode. */
export const SIDECAR_FILE_MODE = 0o660;
/** A directory the engine creates in the context directory in sidecar mode. */
export const SIDECAR_DIR_MODE = 0o2770;

export interface SidecarWriteModes {
  readonly fileMode: number;
  readonly dirMode: number;
  readonly group: number;
}

/** The modes and group of a new entry in the context directory in sidecar mode; `null` outside it. */
export function sidecarWriteModes(): SidecarWriteModes | null {
  return shellIsolation().kind === 'sidecar'
    ? { fileMode: SIDECAR_FILE_MODE, dirMode: SIDECAR_DIR_MODE, group: SHARED_GROUP }
    : null;
}

/**
 * The mode of a file that replaces an existing one in sidecar mode: the owner's and the group's
 * bits kept, group read and write added, nothing for others and no set-ID bit. A pool file
 * written under `umask 022` (`0o644`) thus stays writable for the pool after the engine replaced it.
 */
export function sidecarReplaceMode(existing: number): number {
  return (existing & 0o770) | SIDECAR_FILE_MODE;
}
