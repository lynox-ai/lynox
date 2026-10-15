import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { getLynoxDir } from './config.js';
import { getWorkspaceDir } from './workspace.js';
import { workspaceAccess, type WorkspaceAccess } from './workspace-access.js';
import { closeAnchor, openAnchor, openSubAnchor, splitRel, type WorkspaceAnchor } from './workspace-fd.js';
import { resolveWorkspaceRoot, translateLegacyWorkspacePath, isPathWithin, unsafeRoot, WorkspaceRootError } from './workspace-root.js';

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
 * The usual spellings of a path through a process handle (`/proc/<pid>/fd|root|cwd/…`, also below
 * `task/<tid>/`, and `/dev/fd`, `/dev/std*`). Resolving them hands the decision to whatever fd, cwd
 * or root they name, so they are refused by their spelling, before any filesystem call. A spelling
 * this misses is not let in by it: it maps `outside`, `validatePath` resolves it, and a result in
 * the workspace is refused (`isolatedTarget` in fs.ts).
 */
const PROCESS_HANDLE = /^\/(?:proc\/[^/]+\/(?:task\/[^/]+\/)?(?:fd|fdinfo|root|cwd|map_files)|dev\/(?:fd|stdin|stdout|stderr))(?:\/|$)/;

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

/**
 * The context workspace's open directory, or null without isolation.
 *
 * Holds only its OWN fd. The root's anchor is asked for on every call and never kept: a root
 * reconfigured to another path closes the old anchor (`workspaceAccess`), and a kept copy would
 * then hold a closed fd number the kernel may hand to something else. A new `WorkspaceAccess`
 * object means the root was deliberately changed: the sub-anchor is closed and derived again. A
 * workspace directory removed while held is not reopened by name; the primitives throw `GONE`.
 *
 * Below the root is decided by PATH, and the directory is then reached from the root's anchor one
 * component at a time with O_NOFOLLOW, creating nothing: a workspace entry that is a symlink, or a
 * link on the way to it, is refused, not followed to wherever it points. Only a workspace whose
 * path lies outside the root gets an anchor of its own, opened by name once, and only when it
 * neither holds nor lies inside the data directory (the check the root itself gets).
 */
export function workspaceBase(): { readonly ws: string; readonly anchor: WorkspaceAnchor } | null {
  const ws = getWorkspaceDir();
  if (ws === null) {
    dropBase();
    return null;
  }
  const wsPath = resolve(ws);
  const rootPath = resolve(resolveWorkspaceRoot().path);
  const below = isPathWithin(wsPath, rootPath) && wsPath !== rootPath;
  // Below the root needs the root; a root that cannot be reached is the tool's error.
  const from = below ? workspaceAccess() : null;
  if (base !== null && base.ws === ws && base.from === from) return base;

  dropBase();
  let anchor: WorkspaceAnchor;
  if (from !== null) {
    anchor = openSubAnchor(from.anchor, relative(rootPath, wsPath));
  } else {
    const real = realpathSync(wsPath);
    const unsafe = unsafeRoot(real, realOr(resolve(getLynoxDir())));
    if (unsafe !== null) {
      throw new WorkspaceRootError(
        `The workspace ${ws} ${unsafe === 'holds-data-dir' ? 'is the data directory or contains it' : 'is inside the data directory'}; ` +
        'the file tools do not write there. Use a directory of its own.',
      );
    }
    anchor = openAnchor(real);
  }
  base = { ws, from, anchor };
  return base;
}

/** Close the held workspace directory (engine shutdown; tests). */
export function closeWorkspaceBase(): void {
  dropBase();
}
