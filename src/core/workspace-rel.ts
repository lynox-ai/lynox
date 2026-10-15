import { realpathSync, statSync, fstatSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { getWorkspaceDir } from './workspace.js';
import { workspaceAccess, isAnchoredRoot, type WorkspaceAccess } from './workspace-access.js';
import { closeAnchor, ensureSubAnchor, openAnchor, splitRel, WorkspaceAccessError, type WorkspaceAnchor } from './workspace-fd.js';
import { resolveWorkspaceRoot, translateLegacyWorkspacePath, isPathWithin, WorkspaceRootError } from './workspace-root.js';

/**
 * The model-facing half of the workspace's fd access: a path a tool receives is mapped onto a
 * RELATIVE path below the context workspace, and the file is then reached only through that
 * workspace's open directory (`workspace-fd.ts`), never again by name.
 *
 * Only the context workspace of an isolated engine (server, managed) is covered. A path outside
 * it — `/tmp`, the artifacts directory, `/app` — stays on `validatePath`, which the anchor does not
 * carry. Without isolation (CLI) nothing here applies.
 */

/**
 * Paths whose kernel resolution reaches another directory through a process handle. Resolving
 * them (realpath, open) would hand the decision to whatever fd, cwd or root they name, so they are
 * refused by their spelling, before any filesystem call.
 */
const PROCESS_HANDLE = /^\/(?:proc\/[^/]+\/(?:fd|fdinfo|root|cwd|map_files)|dev\/fd)(?:\/|$)/;

export type WorkspaceRel =
  | { readonly kind: 'inside'; readonly rel: string; readonly shown: string }
  | { readonly kind: 'outside'; readonly abs: string };

/** Thrown for a path the model may not name at all. */
export class WorkspacePathRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathRefused';
  }
}

function realOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Map `input` (as a tool received it) onto the context workspace `ws`. Resolved like
 * `validatePath` resolves it — against the process cwd, legacy workspace paths translated — so a
 * path means what it meant before; only how the file is then reached changes.
 *
 * `inside` when the path lies lexically under `ws` or under its real path (tools have always
 * answered with real paths, and the model reuses them). Nothing is resolved through the
 * filesystem below `ws`: whether a component is a symlink is the fd walk's decision, and it
 * refuses one.
 */
export function toWorkspaceRel(input: string, ws: string): WorkspaceRel {
  if (input.includes('\0')) throw new WorkspacePathRefused('the path contains a NUL byte');
  const abs = translateLegacyWorkspacePath(resolve(input), resolveWorkspaceRoot());
  if (PROCESS_HANDLE.test(abs)) {
    throw new WorkspacePathRefused(
      `the path ${input} goes through a process handle (/proc/<pid>/fd, /proc/<pid>/root, /dev/fd, …). Name the file by its workspace path instead.`,
    );
  }
  for (const base of new Set([ws, realOr(ws)])) {
    if (isPathWithin(abs, base)) {
      const rel = relative(base, abs);
      if (rel !== '') splitRel(rel);
      return { kind: 'inside', rel, shown: resolve(ws, rel) };
    }
  }
  return { kind: 'outside', abs };
}

interface Base {
  readonly ws: string;
  /** The `workspaceAccess()` object the sub-anchor came from; null for a workspace outside the root. */
  readonly from: WorkspaceAccess | null;
  readonly anchor: WorkspaceAnchor;
}

let base: Base | null = null;

function dropBase(): void {
  if (base !== null) {
    try { closeAnchor(base.anchor); } catch { /* already closed */ }
  }
  base = null;
}

function sameObject(a: number, path: string): boolean {
  const own = fstatSync(a);
  const byName = statSync(path);
  return own.dev === byName.dev && own.ino === byName.ino;
}

/**
 * The context workspace's open directory, or null without isolation.
 *
 * Holds only its OWN fd. The root's anchor is asked for on every call and never kept: a root
 * reconfigured to another path closes the old anchor (`workspaceAccess`), and a kept copy would
 * then hold a closed fd number the kernel may hand to something else. A new `WorkspaceAccess`
 * object means the root was deliberately changed: the sub-anchor is closed and derived again. A
 * workspace directory removed while held is not reopened by name; the primitives throw `GONE`.
 */
export function workspaceBase(): { readonly ws: string; readonly anchor: WorkspaceAnchor } | null {
  const ws = getWorkspaceDir();
  if (ws === null) {
    dropBase();
    return null;
  }
  const real = realOr(ws);
  const parent = dirname(real);
  const name = basename(real);
  let access: WorkspaceAccess | null = null;
  try {
    access = workspaceAccess();
  } catch (err) {
    // A workspace outside the root does not need the root; one inside it does.
    if (!(err instanceof WorkspaceRootError)) throw err;
    if (isPathWithin(real, realOr(resolveWorkspaceRoot().path))) throw err;
  }
  const underRoot = access !== null && isAnchoredRoot(access, parent);
  const from = underRoot ? access : null;
  if (base !== null && base.ws === ws && base.from === from) return base;

  dropBase();
  let anchor: WorkspaceAnchor;
  if (from !== null) {
    anchor = ensureSubAnchor(from.anchor, name, 0o700);
  } else {
    // A workspace configured outside the root (`LYNOX_WORKSPACE` elsewhere): its own directory
    // is the base, opened once with O_NOFOLLOW on its resolved path.
    anchor = openAnchor(real);
  }
  if (!sameObject(anchor.fd, ws)) {
    closeAnchor(anchor);
    throw new WorkspaceAccessError('GONE', `the workspace ${ws} is not the directory that was opened for it`);
  }
  base = { ws, from, anchor };
  return base;
}

/** Close the held workspace directory (engine shutdown; tests). */
export function closeWorkspaceBase(): void {
  dropBase();
}
