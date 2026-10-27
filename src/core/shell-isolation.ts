/**
 * Where `bash` runs, decided once per process: in the engine's own container (`local`), or in the
 * shell sidecar (`sidecar`), which reaches the shared workspace tree through fd 3 (PRD
 * shell-sidecar-activation, D1).
 *
 * Why an object and not the env: the object exists only if its checks passed. An env value exists
 * whether they passed or not, so each reader of `LYNOX_SHELL_EXEC_SOCKET` was a chance to read a
 * broken value as "local" — and the readers disagreed: `bash` took `'   '` as a socket, the Shopify
 * gates as unset. This module is the only place outside the env registry that names the variable
 * (a test pins it); every consumer reads `ToolContext.shellIsolation`.
 *
 * Built once, held for the process. `createToolContext` hands the held object to every context, so
 * a context made without an engine (a standalone agent) cannot read "local" where the process is in
 * sidecar mode.
 */
import { fstatSync } from 'node:fs';
import { anchorFromFd, type WorkspaceAnchor } from './workspace-fd.js';


/** The fd the entrypoint's root stage hands over: the workspace tree, opened under a `0700` parent. */
export const SIDECAR_ROOT_FD = 3;

/**
 * The workspace root as user, model and shell see it (D0). A label, built from this constant and
 * never from the root object: it is meant for showing and for the sidecar's cwd, never for opening.
 * The engine reaches the tree only through {@link SidecarRoot.anchor}.
 */
export const WORKSPACE_LABEL = '/workspace';

/** A context's workspace as user, model and shell see it: `/workspace/<ctx.id>` (D0). */
export function contextLabel(contextId: string): string {
  return `${WORKSPACE_LABEL}/${contextId}`;
}

/** The workspace tree in sidecar mode: the handle the engine opens through, and the label it shows. */
export interface SidecarRoot {
  readonly mode: 'sidecar';
  readonly anchor: WorkspaceAnchor;
  readonly label: typeof WORKSPACE_LABEL;
}

export type ShellIsolation =
  | { readonly kind: 'local' }
  | { readonly kind: 'sidecar'; readonly socket: string; readonly root: SidecarRoot };

/** A start check that failed. The message names the check; the engine does not start. */
export class ShellIsolationError extends Error {
  constructor(readonly check: string, message: string) {
    super(`Shell sidecar start check (${check}) failed: ${message}`);
    this.name = 'ShellIsolationError';
  }
}

/** What building the object reads; a test hands its own. */
export interface ShellIsolationInputs {
  /** `LYNOX_SHELL_EXEC_SOCKET` as the process has it, read once. */
  readonly socket: string | undefined;
  /** Whether `fd` is an open directory; false for a closed fd or any other kind. */
  readonly isDirFd: (fd: number) => boolean;
  /** Wrap the inherited fd as the workspace anchor. */
  readonly anchorFromFd: (fd: number, label: string) => WorkspaceAnchor;
}

function isDirFd(fd: number): boolean {
  try {
    return fstatSync(fd).isDirectory();
  } catch {
    return false;
  }
}

/** The process's own inputs. The one read of the socket env in the engine (a test pins it). */
function processInputs(): ShellIsolationInputs {
  return { socket: process.env['LYNOX_SHELL_EXEC_SOCKET'], isDirFd, anchorFromFd };
}

/**
 * Read the env once and build the mode, running the checks that decide whether the object may
 * exist. Throws {@link ShellIsolationError} naming the check.
 *
 * - Socket unset and no directory on fd 3: `local` (self-host, unchanged).
 * - Socket set but empty or blank: a broken config, never "run here" — exits.
 * - Socket set and fd 3 not a directory (check (a)): exits. A sidecar without the anchor would
 *   leave the engine reaching the workspace by name.
 * - fd 3 a directory but the socket unset: exits. That is a misconfigured template, not self-host.
 *
 * The remaining start checks of D2 run here too once they are built; until then the object says
 * only that the anchor is there.
 */
export function buildShellIsolation(inputs: ShellIsolationInputs = processInputs()): ShellIsolation {
  const socket = inputs.socket;
  const anchored = inputs.isDirFd(SIDECAR_ROOT_FD);
  if (socket === undefined) {
    if (anchored) {
      throw new ShellIsolationError('a', `fd ${SIDECAR_ROOT_FD} is a directory but LYNOX_SHELL_EXEC_SOCKET is not set: the template hands over the workspace without the sidecar.`);
    }
    return { kind: 'local' };
  }
  if (socket.trim() === '') {
    throw new ShellIsolationError('socket', `LYNOX_SHELL_EXEC_SOCKET is set but empty.`);
  }
  if (!anchored) {
    throw new ShellIsolationError('a', `LYNOX_SHELL_EXEC_SOCKET is set but fd ${SIDECAR_ROOT_FD} is not an open directory: the sidecar's workspace anchor is missing.`);
  }
  const anchor = inputs.anchorFromFd(SIDECAR_ROOT_FD, WORKSPACE_LABEL);
  return { kind: 'sidecar', socket, root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } };
}

let held: ShellIsolation | null = null;

/**
 * The process's mode, built on first use and held. The engine calls it while it is constructed, so
 * a failed check stops the start there.
 */
export function shellIsolation(): ShellIsolation {
  held ??= buildShellIsolation();
  return held;
}

/** Tests only: forget the held object, so the next {@link shellIsolation} builds it again. */
export function resetShellIsolationForTest(): void {
  held = null;
}

/** Tests only: hold `isolation` as the process's mode, as a boot in sidecar mode would. */
export function setShellIsolationForTest(isolation: ShellIsolation): void {
  held = isolation;
}
