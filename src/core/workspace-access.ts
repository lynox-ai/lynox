import { closeSync, existsSync, fstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { isPathWithin } from './workspace.js';
import { closeAnchor, openAnchor, type WorkspaceAnchor } from './workspace-fd.js';
import { ensureWorkspaceRoot, resolveWorkspaceRoot, WorkspaceRootError, type WorkspaceRoot } from './workspace-root.js';

/**
 * The workspace root, held open. Backup, migration and the Art. 17 erasure reach the workspace
 * only through this anchor (`walk`, `copyOut`, `stageIn`, `emptyDir` in `workspace-fd.ts`), never
 * through a path built from the data directory: the root may live outside it.
 *
 * The anchor is opened BY NAME from `resolveWorkspaceRoot()` and kept. It is reopened only when
 * the resolved root names another path (a test that switches the data directory, a reconfigured
 * root); a root removed, moved away or replaced under the same name (`rm`, `mv`, a re-pointed
 * link) is not reopened silently: this throws, before a backup copies the old directory as if it
 * were the workspace. An anchor already handed out throws `GONE` in every primitive operation
 * once its directory is deleted.
 */
export interface WorkspaceAccess {
  readonly root: WorkspaceRoot;
  readonly anchor: WorkspaceAnchor;
}

let held: WorkspaceAccess | null = null;

/**
 * The anchored root. Throws `WorkspaceRootError` when the root cannot be resolved or opened, so a
 * caller that promises coverage (a backup, an erasure) fails instead of skipping the workspace.
 */
export function workspaceAccess(): WorkspaceAccess {
  const root = resolveWorkspaceRoot();
  if (held !== null && held.root.path === root.path && held.root.mode === root.mode) {
    if (!isAnchoredRoot(held, root.path)) {
      throw new WorkspaceRootError(
        `The workspace root ${root.path} is no longer the directory this engine opened at start: it was moved, replaced or removed. ` +
        'Restart the engine to use the directory now at that path.',
      );
    }
    return held;
  }
  if (root.mode === 'external') refuseUnsafeRoot(root.path);
  let anchor: WorkspaceAnchor;
  try {
    // The resolved path, not the name: the anchor refuses a link at its last component, and a
    // `<data>/workspace` that is a symlink is still the default root (PRD D2).
    anchor = openAnchor(realpathSync(root.path));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new WorkspaceRootError(`The workspace root ${root.path} cannot be opened (${cause}).`);
  }
  if (held !== null) closeAnchor(held.anchor);
  held = { root, anchor };
  return held;
}

/**
 * As `workspaceAccess()`, but `null` for a default root that does not exist and that this engine
 * never opened: there is nothing in it to reach (a CLI or a server that never made one). A root
 * the engine holds and that is gone since stays an error.
 */
export function workspaceAccessIfPresent(): WorkspaceAccess | null {
  const root = resolveWorkspaceRoot();
  const heldHere = held !== null && held.root.path === root.path && held.root.mode === root.mode;
  if (!heldHere && root.mode === 'default' && !existsSync(root.path)) return null;
  return workspaceAccess();
}

/**
 * An external root the erasure must never empty, because it empties the root: the data
 * directory itself or a directory that contains it (`/` among them), and any other directory
 * inside the data directory (a `secrets` there would become the workspace). The default
 * `<data>/workspace` is not external and never gets here.
 */
function refuseUnsafeRoot(real: string): void {
  let dataDir: string;
  try {
    dataDir = realpathSync(getLynoxDir());
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new WorkspaceRootError(`Cannot check the workspace root ${real} against the data directory ${getLynoxDir()} (${cause}).`);
  }
  const unsafe = unsafeRoot(real, dataDir);
  if (unsafe === 'holds-data-dir') {
    throw new WorkspaceRootError(
      `LYNOX_WORKSPACE_ROOT names ${real}, which is the data directory ${dataDir} or contains it. ` +
      'The erasure empties the workspace root, so it must be a directory of its own.',
    );
  }
  if (unsafe === 'inside-data-dir') {
    throw new WorkspaceRootError(
      `LYNOX_WORKSPACE_ROOT names ${real}, which is inside the data directory ${dataDir}. ` +
      'Use the default (unset it) or a directory outside the data directory.',
    );
  }
}

/**
 * Why the directory `real` must not be emptied as a workspace root of the data directory
 * `dataDir` (both resolved), or `null`: it is the data directory or contains it (`/` among
 * them), or it lies inside it. One guard for an external root (refused at boot) and for a
 * `<data>/workspace` that is a link (refused by the erasure, PRD I12d): the default root itself
 * is inside the data directory by name and is never asked.
 */
export function unsafeRoot(real: string, dataDir: string): 'holds-data-dir' | 'inside-data-dir' | null {
  if (isPathWithin(dataDir, real)) return 'holds-data-dir';
  if (isPathWithin(real, dataDir)) return 'inside-data-dir';
  return null;
}

/**
 * Whether `path` (followed if it is a link) is the anchored root itself. In the default mode the
 * data directory's `workspace` entry IS the root; the erasure empties it through the anchor and
 * must not remove it by name. Followed on purpose: a `workspace` entry that is a link or a mount
 * point to the anchored directory is the root too (PRD I12d); the erasure's scan refuses a link
 * whose target `unsafeRoot` rejects.
 */
export function isAnchoredRoot(access: WorkspaceAccess, path: string): boolean {
  let byName;
  try {
    byName = statSync(path);
  } catch {
    return false;
  }
  const own = fstatSync(access.anchor.fd);
  return own.dev === byName.dev && own.ino === byName.ino;
}

/** A workspace reached for one operation; `release()` closes what this lease opened. */
export interface WorkspaceLease {
  readonly access: WorkspaceAccess;
  release(): void;
}

function sameDir(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * The workspace of the data directory `dataDir`, for a caller that names its data directory
 * (backup, migration). The engine's own data directory gets the held anchor and its configured
 * root; any other directory gets `<dataDir>/workspace`, opened for this lease and closed on
 * release — a manager pointed at another data directory never reaches this engine's root.
 *
 * `null` when there is no workspace to reach: a default root that does not exist (a CLI that
 * never made one). With `create`, a missing default root is made first (a restore). An external
 * root that cannot be opened throws: its files exist somewhere this cannot reach.
 */
export function leaseWorkspaceFor(dataDir: string, opts: { readonly create?: boolean } = {}): WorkspaceLease | null {
  if (sameDir(dataDir, getLynoxDir())) {
    const root = resolveWorkspaceRoot();
    if (root.mode === 'default' && !existsSync(root.path)) {
      if (opts.create !== true) return null;
      ensureWorkspaceRoot();
    }
    return { access: workspaceAccess(), release: () => { /* held for the engine's lifetime */ } };
  }
  const path = join(dataDir, 'workspace');
  if (!existsSync(path)) {
    if (opts.create !== true) return null;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  let anchor: WorkspaceAnchor;
  try {
    anchor = openAnchor(realpathSync(path));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new WorkspaceRootError(`The workspace ${path} cannot be opened (${cause}).`);
  }
  return { access: { root: { path, mode: 'default' }, anchor }, release: () => closeAnchor(anchor) };
}

/** Test seam: drop the held anchor. */
export function _resetWorkspaceAccess(): void {
  if (held !== null) {
    try { closeSync(held.anchor.fd); } catch { /* already closed */ }
  }
  held = null;
}
