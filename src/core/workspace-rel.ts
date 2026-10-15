import { fstatSync, readFileSync, realpathSync } from 'node:fs';
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

function isLive(anchor: WorkspaceAnchor): boolean {
  try {
    return fstatSync(anchor.fd).nlink > 0;
  } catch {
    return false;
  }
}

/**
 * The context workspace's open directory, or null without isolation.
 *
 * Holds only its OWN fd. The root's anchor is asked for on every call and never kept: a root
 * reconfigured to another path closes the old anchor (`workspaceAccess`), and a kept copy would
 * then hold a closed fd number the kernel may hand to something else. A new `WorkspaceAccess`
 * object means the root was deliberately changed: the sub-anchor is closed and derived again.
 *
 * Below the root is decided by PATH (the root's path or its real path), and the directory is then
 * reached from the root's anchor one component at a time with O_NOFOLLOW, creating nothing: a
 * symlink on the way is refused, not followed to wherever it points. A workspace below the root
 * that is removed and made again (the Art. 17 erasure empties the root and makes the context
 * directory again) is reached again the same way, from the root's anchor, never by name. A
 * workspace that reaches the root only through a link is refused. Only a workspace outside the
 * root gets an anchor of its own, opened by name once, and only when it neither holds nor lies
 * inside the data directory (the check an external root gets); one that is removed stays an error.
 */
export function workspaceBase(): { readonly ws: string; readonly anchor: WorkspaceAnchor } | null {
  const ws = getWorkspaceDir();
  if (ws === null) {
    dropBase();
    return null;
  }
  const wsPath = resolve(ws);
  const rootPath = resolve(resolveWorkspaceRoot().path);
  const rootReal = realOr(rootPath);
  let rel: string | null = null;
  for (const r of new Set([rootPath, rootReal])) {
    if (isPathWithin(wsPath, r)) {
      rel = relative(r, wsPath);
      break;
    }
  }
  if (rel === null && isPathWithin(realOr(wsPath), rootReal)) {
    throw new WorkspaceRootError(
      `The workspace ${ws} reaches the workspace root ${rootPath} only through a link. Name it by the root's own path.`,
    );
  }
  // Below the root needs the root; a root that cannot be reached is the tool's error.
  const from = rel !== null ? workspaceAccess() : null;
  if (base !== null && base.ws === ws && base.from === from && (from === null || isLive(base.anchor))) return base;

  dropBase();
  let anchor: WorkspaceAnchor;
  if (from !== null && rel !== null && rel !== '') {
    anchor = openSubAnchor(from.anchor, rel);
  } else if (from !== null) {
    // The workspace is the root itself: an fd of its own on the same directory, checked against
    // the held anchor by identity, so closing it never closes the root's.
    anchor = openAnchor(realpathSync(rootPath));
    const own = fstatSync(anchor.fd);
    const held = fstatSync(from.anchor.fd);
    if (own.dev !== held.dev || own.ino !== held.ino) {
      closeAnchor(anchor);
      throw new WorkspaceRootError(`The workspace root ${rootPath} is no longer the directory this engine opened.`);
    }
  } else {
    const real = realpathSync(wsPath);
    const unsafe = unsafeRoot(real, realOr(resolve(getLynoxDir())));
    if (unsafe !== null) {
      throw new WorkspaceRootError(
        `The workspace ${ws} ${unsafe === 'holds-data-dir' ? 'is the data directory or contains it' : 'is inside the data directory'}; ` +
        'the file tools do not work there. Use a directory of its own.',
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

/**
 * The process umask, as a write by name applies it: a new file is `0o666 & ~umask`, a new
 * directory `0o777 & ~umask`. Read from /proc, because `process.umask()` without an argument sets
 * it to 0 for a moment. If it cannot be read — a kernel before 4.7, or a system without /proc,
 * such as macOS — the closed answer: owner only, where a write by name would follow the umask.
 */
export function processUmask(): number {
  try {
    const m = /^Umask:\s*([0-7]{1,4})$/m.exec(readFileSync('/proc/self/status', 'utf8'));
    if (m?.[1] !== undefined) return parseInt(m[1], 8);
  } catch { /* fall through */ }
  return 0o077;
}
