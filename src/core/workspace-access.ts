import { closeSync, fstatSync, realpathSync, statSync } from 'node:fs';
import { closeAnchor, openAnchor, type WorkspaceAnchor } from './workspace-fd.js';
import { resolveWorkspaceRoot, WorkspaceRootError, type WorkspaceRoot } from './workspace-root.js';

/**
 * The workspace root, held open. Backup, migration and the Art. 17 erasure reach the workspace
 * only through this anchor (`walk`, `copyOut`, `stageIn`, `emptyDir` in `workspace-fd.ts`), never
 * through a path built from the data directory: the root may live outside it.
 *
 * The anchor is opened BY NAME from `resolveWorkspaceRoot()` and kept. It is reopened only when
 * the resolved root names another path (a test that switches the data directory, a reconfigured
 * root); a root removed or replaced under the same name is not reopened silently — every
 * operation of the primitive checks the anchor and throws `GONE` when its directory was deleted.
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
  if (held !== null && held.root.path === root.path && held.root.mode === root.mode) return held;
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
 * Whether `path` (followed if it is a link) is the anchored root itself. In the default mode the
 * data directory's `workspace` entry IS the root, possibly through a symlink; the erasure empties
 * it through the anchor and must not remove it by name.
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

/** Test seam: drop the held anchor. */
export function _resetWorkspaceAccess(): void {
  if (held !== null) {
    try { closeSync(held.anchor.fd); } catch { /* already closed */ }
  }
  held = null;
}
