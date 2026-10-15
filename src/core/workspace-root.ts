import { accessSync, closeSync, constants, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureDirSync } from './atomic-write.js';
import { getLynoxDir } from './config.js';

/**
 * The workspace root: the directory that holds one directory per context (`<root>/<ctx.id>`,
 * `http-api` on a server), reached by name.
 *
 * `LYNOX_WORKSPACE_ROOT` names it; unset or empty, it is `<data>/workspace` as before. Whether a
 * root is the default or an EXTERNAL one is decided on the object, not on the variable: the
 * realpath of the named root is compared by device and inode with `stat(<data>/workspace)`, which
 * follows links. So a variable that names the default, or a `<data>/workspace` that is a symlink,
 * is the default.
 *
 * In the default mode the root is returned as the path by name, `<data>/workspace`, exactly the
 * string the engine used before; the realpath only decides identity. An external root is returned
 * as its realpath.
 *
 * Backup, migration and the Art. 17 erasure reach the root through its anchor
 * (`workspace-access.ts`), so an external root is covered by all three. The anchor refuses the
 * roots the erasure must never empty (see `workspaceAccess`).
 */

export type WorkspaceRootMode = 'default' | 'external';

export interface WorkspaceRoot {
  readonly path: string;
  readonly mode: WorkspaceRootMode;
}

/** A root the engine cannot use. The message names the path and the cause. */
export class WorkspaceRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRootError';
  }
}

/**
 * True iff `child` resolves to `parent` itself or a path nested under it.
 * Relative-path based so a `..` that climbs out of `parent` fails. Exported so
 * the non-isolation write path in the fs tools can reuse the exact same
 * containment predicate the isolation path (`validatePath`) enforces.
 */
export function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  // `..` as a whole first component climbs out; a name that merely starts with two dots
  // (`..env`) is a file inside.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why the directory `real` must not be a workspace root of the data directory `dataDir` (both
 * resolved), or `null`: it is the data directory or contains it (`/` among them), or it lies
 * inside it. Emptying the root would then empty the data directory or part of it. Asked by path
 * and by identity (device and inode along both ancestor chains): a case-insensitive file system or
 * a second spelling of the same directory passes the path check alone. One guard for an external
 * root (`resolveWorkspaceRoot`) and for a `<data>/workspace` link (the erasure's scan); the default
 * root itself is inside the data directory by name and is never asked. A bind mount that shows the
 * data directory under an unrelated path is not visible here; the erasure looks for it in its walks.
 */
export function unsafeRoot(real: string, dataDir: string): 'holds-data-dir' | 'inside-data-dir' | null {
  if (isPathWithin(dataDir, real)) return 'holds-data-dir';
  if (isPathWithin(real, dataDir)) return 'inside-data-dir';
  const rootId = identityOf(real);
  const dataId = identityOf(dataDir);
  if (rootId !== null && ancestorsOf(dataDir).some(p => sameIdentity(identityOf(p), rootId))) return 'holds-data-dir';
  if (dataId !== null && ancestorsOf(real).some(p => sameIdentity(identityOf(p), dataId))) return 'inside-data-dir';
  return null;
}

interface Identity { readonly dev: number; readonly ino: number }

/** A directory's identity, or null when it cannot be read (the path check above still holds). */
function identityOf(path: string): Identity | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

const sameIdentity = (a: Identity | null, b: Identity): boolean => a !== null && a.dev === b.dev && a.ino === b.ino;

/** `path` and every directory above it, up to `/`. */
function ancestorsOf(path: string): string[] {
  const out = [path];
  for (let p = path, up = dirname(p); up !== p; p = up, up = dirname(p)) out.push(up);
  return out;
}

/** Whether this engine accepts an external root. Backup, export and erase reach it through its anchor. */
const EXTERNAL_ROOT_SUPPORTED = true;

/** `<data>/workspace`, the default root by name. */
export function defaultWorkspaceRootPath(): string {
  return join(getLynoxDir(), 'workspace');
}

function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code ?? (err instanceof Error ? err.message : String(err));
}

/**
 * `default` when `named` is the same object as `<data>/workspace`, `external` when it is another
 * one or when `<data>/workspace` does not exist. Any other failure to stat the default is not an
 * answer, so it throws.
 */
function classify(named: Stats, byName: string): WorkspaceRootMode {
  let dflt: Stats;
  try {
    dflt = statSync(byName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'external';
    throw new WorkspaceRootError(`Cannot tell whether LYNOX_WORKSPACE_ROOT is the default root: ${byName} cannot be read (${errnoOf(err)}).`);
  }
  return dflt.dev === named.dev && dflt.ino === named.ino ? 'default' : 'external';
}

/**
 * The root, classified. Creates nothing. Throws `WorkspaceRootError` when the variable names a
 * path that does not resolve or is not a directory, and when it names an external root that
 * `unsafeRoot` rejects. Every reader goes through here (the server's anchor, the CLI, the tools'
 * confinement), so none of them can work in a root the erasure would refuse to empty.
 * (`allowExternal: false` refuses any external root; a test seam.)
 */
export function resolveWorkspaceRoot(opts: { allowExternal?: boolean } = {}): WorkspaceRoot {
  const byName = defaultWorkspaceRootPath();
  const raw = process.env['LYNOX_WORKSPACE_ROOT'];
  if (raw === undefined || raw === '') return { path: byName, mode: 'default' };

  let real: string;
  let st: Stats;
  try {
    real = realpathSync(raw);
    st = statSync(real);
  } catch (err) {
    throw new WorkspaceRootError(`LYNOX_WORKSPACE_ROOT names ${raw}, which cannot be used (${errnoOf(err)}).`);
  }
  if (!st.isDirectory()) throw new WorkspaceRootError(`LYNOX_WORKSPACE_ROOT names ${raw}, which is not a directory.`);

  if (classify(st, byName) === 'default') return { path: byName, mode: 'default' };
  if (!(opts.allowExternal ?? EXTERNAL_ROOT_SUPPORTED)) {
    throw new WorkspaceRootError(
      `LYNOX_WORKSPACE_ROOT names ${raw}, a workspace root other than ${byName}. This engine version does not support that: ` +
      'its backup, export and erasure would not reach the files there. Unset LYNOX_WORKSPACE_ROOT, or run an engine version that supports it.',
    );
  }
  refuseUnsafeRoot(real);
  return { path: real, mode: 'external' };
}

function refuseUnsafeRoot(real: string): void {
  let dataDir: string;
  try {
    dataDir = realpathSync(getLynoxDir());
  } catch (err) {
    throw new WorkspaceRootError(`Cannot check the workspace root ${real} against the data directory ${getLynoxDir()} (${errnoOf(err)}).`);
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

/** The root's path (see `resolveWorkspaceRoot`). */
export function getWorkspaceRoot(): string {
  return resolveWorkspaceRoot().path;
}

/**
 * Boot check: the root exists (the default is created by name, `0700`), is a directory and can be
 * read and entered. Throws `WorkspaceRootError` naming the path and the cause, so the engine
 * refuses to start instead of falling back somewhere at runtime.
 */
export function ensureWorkspaceRoot(): WorkspaceRoot {
  const root = resolveWorkspaceRoot();
  if (root.mode === 'default') {
    try {
      ensureDirSync(root.path);
    } catch (err) {
      // A dangling symlink at the default path lands here (Node reports ENOENT): it names a root that is gone.
      throw new WorkspaceRootError(`The workspace root ${root.path} cannot be created (${errnoOf(err)}).`);
    }
  }
  assertUsableDir(root.path, 'The workspace root', constants.R_OK | constants.X_OK);
  return root;
}

/**
 * Boot check for a context directory under the root: creates it (`0700`) and requires that it
 * can be read, written and entered — a root owned by another user (e.g. a bare `docker volume
 * create`, `root:root 0755`) fails here instead of at the first upload.
 */
export function ensureWorkspaceContextDir(dir: string): string {
  try {
    ensureDirSync(dir);
  } catch (err) {
    throw new WorkspaceRootError(`The workspace directory ${dir} cannot be created (${errnoOf(err)}).`);
  }
  assertUsableDir(dir, 'The workspace directory', constants.R_OK | constants.W_OK | constants.X_OK);
  return dir;
}

function assertUsableDir(path: string, what: string, mode: number): void {
  let st: Stats;
  try {
    st = statSync(path);
  } catch (err) {
    throw new WorkspaceRootError(`${what} ${path} cannot be used (${errnoOf(err)}).`);
  }
  if (!st.isDirectory()) throw new WorkspaceRootError(`${what} ${path} is not a directory.`);
  try {
    accessSync(path, mode);
  } catch (err) {
    throw new WorkspaceRootError(`${what} ${path} cannot be used (${errnoOf(err)}).`);
  }
}

/** The Linux mount id of a directory, from `/proc/self/fdinfo`; null where that cannot be read. */
function mountIdOfDir(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch {
    return null;
  }
  try {
    const m = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${String(fd)}`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the root is a mount point of its own: its mount id differs from its parent's. Not the
 * device number, which is the same for two Docker named volumes on one filesystem. null where the
 * mount id cannot be read (no `/proc`, e.g. macOS).
 */
export function workspaceRootIsMount(rootPath: string): boolean | null {
  let real: string;
  try { real = realpathSync(rootPath); } catch { return null; }
  const own = mountIdOfDir(real);
  const parent = mountIdOfDir(dirname(real));
  if (own === null || parent === null) return null;
  return own !== parent;
}

/**
 * Whether files are still waiting under `<data>/workspace` while the root is elsewhere: an
 * external root and a non-empty `<data>/workspace`. Always false in the default mode, where
 * `<data>/workspace` IS the root.
 */
export function workspaceLegacyPending(root: WorkspaceRoot): boolean {
  if (root.mode === 'default') return false;
  try {
    return readdirSync(defaultWorkspaceRootPath()).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Unreadable is not empty: report it as pending, so the leftover is looked at.
    return true;
  }
}

/**
 * Maps a path under `<data>/workspace/` to the same relative path under an external root, for
 * paths that history (threads, tool calls) still names the old way. Identity in the default mode
 * and for paths outside `<data>/workspace`. The caller confines the result as usual; a path is
 * normalised before it is matched, so `..` cannot climb out of the prefix and land in the root.
 * Refuses while a leftover is pending: the old path may then name a file that still lives there.
 */
export function translateLegacyWorkspacePath(absPath: string, root: WorkspaceRoot): string {
  if (root.mode === 'default') return absPath;
  const legacy = defaultWorkspaceRootPath();
  if (absPath !== legacy && !absPath.startsWith(legacy + '/')) return absPath;
  if (workspaceLegacyPending(root)) {
    throw new WorkspaceRootError(
      `The path ${absPath} is in the old workspace location ${legacy}, which still holds files while the workspace root is ${root.path}. ` +
      'Move or erase the files in the old location first.',
    );
  }
  return root.path + absPath.slice(legacy.length);
}

