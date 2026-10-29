import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, basename, join, relative } from 'node:path';
import type { LynoxContext } from '../types/index.js';
import { ensureDirSync, writeFileAtomicSync } from './atomic-write.js';
import { getLynoxDir } from './config.js';
import { ENGINE_ID, SHARED_GROUP, shellIsolation, type SidecarRoot } from './shell-isolation.js';
import { closeAnchor, ensureSubAnchorWithMode, type WorkspaceAnchor } from './workspace-fd.js';
import { SIDECAR_DIR_MODE } from './workspace-write-modes.js';
import { ensureWorkspaceContextDir, getWorkspaceRoot, namesSidecarLabel, resolveWorkspaceRoot, translateLegacyWorkspacePath, isPathWithin, WorkspaceRootError } from './workspace-root.js';

let _cachedDir: string | null | undefined;
let _tenantOverride: string | null = null;

/** Returns the workspace directory if configured, else null. */
export function getWorkspaceDir(): string | null {
  // Tenant workspace override takes precedence
  if (_tenantOverride !== null) return _tenantOverride;
  if (_cachedDir !== undefined) return _cachedDir;
  const env = process.env['LYNOX_WORKSPACE'];
  _cachedDir = env && existsSync(env) ? realpathSync(resolve(env)) : null;
  return _cachedDir;
}

/** Set a tenant-specific workspace directory override. */
export function setTenantWorkspace(dir: string | null): void {
  _tenantOverride = dir;
}

/** Clear the tenant workspace override. */
export function clearTenantWorkspace(): void {
  _tenantOverride = null;
}

/**
 * Whether workspace isolation is active. Always in shell sidecar mode: the paths taken without
 * isolation reach the workspace root by name, and there they must not (D3). The isolated path
 * refuses instead when no context workspace is set (`workspaceBase`).
 */
export function isWorkspaceActive(): boolean {
  return getWorkspaceDir() !== null || shellIsolation().kind === 'sidecar';
}

/** Working directory: workspace dir if active, else process.cwd(). */
export function getWorkspaceCwd(): string {
  return getWorkspaceDir() ?? process.cwd();
}

/** The tenant's FILE AREA root — the exact directory `GET /api/files/download`
 *  serves from: the isolation workspace when active, else the workspace root. */
export function getFileAreaDir(): string {
  return getWorkspaceDir() ?? getWorkspaceRoot();
}

/**
 * Resolve a file-area-relative (or absolute-in-area) path to an absolute path
 * confined to the tenant's FILE AREA (see getFileAreaDir), rejecting `..`
 * traversal and symlink escape. Returns `null` for anything that resolves
 * outside the area. This is the SINGLE confinement resolver shared by
 * `GET /api/files/download` (http-api.ts) and the media_process tool — so a
 * file read for either path is confined identically. Callers that require an
 * existing file must `stat` the result themselves; a not-yet-existing path
 * is checked through its closest existing ancestor, so a missing leaf under a
 * symlink that points out of the area is refused like an existing one, and a
 * dangling symlink is refused wherever it points.
 */
export function resolveFileAreaPath(filePath: string): string | null {
  const base = getFileAreaDir();
  // A path history names under the old `<data>/workspace` is mapped to the root first, then
  // confined like any other (identity unless the root is external).
  const resolved = translateLegacyWorkspacePath(resolve(base, filePath), resolveWorkspaceRoot());
  // Logical path must be within the file area.
  if (resolved !== base && !resolved.startsWith(base + '/')) return null;
  // Real path (after symlink resolution) must also be within it. Canonicalize
  // the base too: if the base itself contains a symlinked component (macOS
  // /tmp -> /private/tmp, a symlinked $HOME, or a symlinked Docker volume),
  // realpath(resolved) would otherwise mismatch the literal base and
  // false-reject every legitimate in-area path. A base that hasn't been created
  // yet is canonicalized the same way as the path, through its closest ancestor.
  const realBase = realpathOfClosestExisting(base) ?? base;
  const real = realpathOfClosestExisting(resolved);
  if (real === null) return null;
  if (real !== realBase && !real.startsWith(realBase + '/')) return null;
  return resolved;
}

/** True only when `lstat` says the name is not there; any other answer counts as present. */
function isAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * The real path of `path`, or — when its leaf does not exist yet — the real path of its closest
 * existing ancestor with the missing rest re-attached. Null for a dangling symlink and for any
 * other failure (a component that is a file, an unreadable directory, a link loop): accepting
 * the logical path there let a symlink out of the area answer differently for files and
 * directories behind it.
 */
function realpathOfClosestExisting(path: string): string | null {
  let probe = path;
  let tail = '';
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail === '' ? real : join(real, tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      // ENOENT for a name that exists is a dangling symlink: its target is missing, wherever it
      // points. Refused, or the answer would say whether that target exists outside the area.
      if (!isAbsent(probe)) return null;
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail = tail === '' ? basename(probe) : join(basename(probe), tail);
      probe = parent;
    }
  }
}

// `isPathWithin` lives beside the workspace root's guard, which needs it and which this module
// imports; re-exported so every caller keeps its import.
export { isPathWithin };

/**
 * The roots a write may reach besides the workspace when isolation is active: `/tmp` and the
 * artifacts directory, symlinks resolved. One list for `validatePath` and for the changeset,
 * which tracks exactly the files a write tool can change.
 */
export function writeRootsBesidesWorkspace(): string[] {
  // Resolve /tmp via realpath for macOS /private/tmp
  const realTmp = existsSync('/tmp') ? realpathSync('/tmp') : '/tmp';
  // Artifacts dir is read+write accessible: artifact storage lives outside the
  // per-context workspace (so it's gallery-global across threads/contexts) but
  // on the same persistent volume. Exposing it lets the agent read/edit its own
  // artifacts with the standard file tools instead of full-document rewrites.
  const artRootRaw = join(getLynoxDir(), 'artifacts');
  const realArtRoot = existsSync(artRootRaw) ? realpathSync(artRootRaw) : artRootRaw;
  return [realTmp, realArtRoot];
}

/** Allowed read-only roots (besides workspace + /tmp). Frozen: importers must not widen them. */
export const READ_ONLY_ROOTS: readonly string[] = Object.freeze(['/app']);

/**
 * Resolve a path and validate it's within allowed boundaries.
 * Throws if the path escapes the sandbox.
 * Returns the resolved real path.
 */
export function validatePath(filePath: string, operation: 'read' | 'write'): string {
  const ws = getWorkspaceDir();
  if (!ws) {
    // Isolation is always on in shell sidecar mode (`isWorkspaceActive`); unchecked is not an answer.
    if (shellIsolation().kind === 'sidecar') {
      throw new WorkspaceRootError('In shell sidecar mode no context workspace is set, and the workspace is not reached by name.');
    }
    return resolve(filePath);
  }

  // Resolve the path, following symlinks where possible. A path under the old `<data>/workspace`
  // is mapped to the root first, then confined like any other (identity unless the root is external).
  const resolved = translateLegacyWorkspacePath(resolve(filePath), resolveWorkspaceRoot());
  if (namesSidecarLabel(resolved)) {
    throw new Error(`Path '${filePath}' is in the workspace, which is reached only through its open directory, not by name.`);
  }
  let real: string;
  if (existsSync(resolved)) {
    real = realpathSync(resolved);
  } else if (existsSync(dirname(resolved))) {
    real = join(realpathSync(dirname(resolved)), basename(resolved));
  } else {
    // Walk up to find closest existing ancestor (supports recursive mkdir)
    let ancestor = dirname(resolved);
    let tail = basename(resolved);
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
      tail = join(basename(ancestor), tail);
      ancestor = dirname(ancestor);
    }
    if (!existsSync(ancestor)) {
      throw new Error(
        `Path '${filePath}' cannot be validated: no existing ancestor directory found.`,
      );
    }
    real = join(realpathSync(ancestor), tail);
  }

  // Check workspace + /tmp + the artifacts directory
  const [realTmp, realArtRoot] = writeRootsBesidesWorkspace() as [string, string];

  // Block writes through symlinks pointing outside the allowed roots
  if (existsSync(resolved) && operation === 'write') {
    const stat = lstatSync(resolved);
    if (
      stat.isSymbolicLink() &&
      !isPathWithin(real, ws) &&
      !isPathWithin(real, realTmp) &&
      !isPathWithin(real, realArtRoot)
    ) {
      throw new Error(
        `Path '${filePath}' is a symlink to '${real}' which is outside the workspace. ` +
        `Symlink writes are blocked when workspace isolation is active.`,
      );
    }
  }

  if (isPathWithin(real, ws) || isPathWithin(real, realTmp) || isPathWithin(real, realArtRoot)) {
    return real;
  }

  // Read operations also allowed from read-only roots
  if (operation === 'read') {
    for (const root of READ_ONLY_ROOTS) {
      if (existsSync(root) && isPathWithin(real, realpathSync(root))) {
        return real;
      }
    }
  }

  const allowed = operation === 'write'
    ? `${ws}, /tmp, and ${realArtRoot}`
    : `${ws}, /tmp, ${realArtRoot}, and ${READ_ONLY_ROOTS.join(', ')}`;
  throw new Error(
    `Path '${filePath}' resolves to '${real}' which is outside allowed directories (${allowed}). ` +
    `${operation === 'write' ? 'Write' : 'Read'} operations are restricted when workspace isolation is active.`,
  );
}

/**
 * Ensure the workspace directory for a context exists.
 * Creates it with mode 0o700 if missing, and throws `WorkspaceRootError` naming the path
 * when it cannot be created, read, written or entered.
 * Returns the workspace directory path.
 *
 * In shell sidecar mode the directory is made from fd 3, never by name, and given the shell
 * sidecar layout's group and mode whether it is new or was there (see {@link ensureSidecarContextDir}).
 */
export function ensureContextWorkspace(context: LynoxContext): string {
  const isolation = shellIsolation();
  if (isolation.kind === 'sidecar') return ensureSidecarContextDir(isolation.root, context.workspaceDir);
  return ensureWorkspaceContextDir(context.workspaceDir);
}

/**
 * The context directory in shell sidecar mode: one component below the label, made or opened from
 * fd 3 and given group `SHARED_GROUP` and mode `0o2770`, so the engine and every pool uid of the
 * sidecar can work in it and nobody else can. The group is passed only here: an engine outside
 * sidecar mode is not in that group, and asking for it would fail with EPERM.
 *
 * The directory must belong to the engine. Start check (h) has established that the engine runs
 * as the layout's uid, so its own uid is the owner to expect. A failed call or another owner stops
 * the start with a message that names the directory and the cause; it never goes on with a group
 * or mode the shell cannot use.
 */
function ensureSidecarContextDir(root: SidecarRoot, workspaceDir: string): string {
  const name = relative(root.label, workspaceDir);
  if (name === '' || name.includes('/') || name.startsWith('..')) {
    throw new WorkspaceRootError(`In shell sidecar mode the context directory ${workspaceDir} must be one directory below ${root.label}.`);
  }
  // Start check (h) has pinned the engine to the layout's uid before sidecar mode exists, so the
  // engine's own uid is the owner to expect; off POSIX there is no fd 3 and no sidecar mode.
  const owner = process.geteuid?.() ?? ENGINE_ID;
  let made: WorkspaceAnchor;
  try {
    made = ensureSubAnchorWithMode(root.anchor, name, SIDECAR_DIR_MODE, SHARED_GROUP, owner);
  } catch (err) {
    throw new WorkspaceRootError(`The context directory ${workspaceDir} cannot be made ready from fd 3 (${err instanceof Error ? err.message : String(err)}). Give it to uid ${owner} or remove it, then start again.`);
  }
  closeAnchor(made);
  return workspaceDir;
}

/** Reset cached workspace dir (for testing). */
export function _resetCache(): void {
  _cachedDir = undefined;
  _tenantOverride = null;
}


/** The file-area-relative path a chat upload is stored under: `uploads/<stamp>-<uniq>-<name>`. */
export function chatUploadRel(fileName: string): string {
  // Normalize the persist name HARD (the display name stays untouched):
  // path separators out (review A2 — a crafted name escaped uploads/ into
  // the area root), quotes/backticks out (review C1 — the name rides an
  // ENGINE INSTRUCTION line `read_file('<rel>')`), length capped so the
  // stamp+name cannot exceed filesystem limits and silently fall back to
  // the full inline path (review A3).
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  // Review A1: millisecond-stamp collisions are a real (if narrow) window
  // with a silent overwrite — a short random suffix makes the doc claim true.
  const uniq = randomBytes(4).toString('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `uploads/${stamp}-${uniq}-${safe}`;
}

/**
 * Persist a chat upload that is too large to inline into the message as a REAL
 * FILE in the tenant's file area (`uploads/<stamp>-<name>`), so the agent works
 * on it with read_file / bash / python instead of echoing the whole content
 * through a tool input (which hit max_tokens mid-tool_use and looped
 * continuations — thread 8c09e50a, 2026-08-14).
 *
 * Returns the file-area-RELATIVE path on success, or null when the area cannot
 * be written (missing dir rights, disk full) — the caller then falls back to
 * the legacy inline path rather than losing the upload. Collision-free via the
 * timestamped prefix; the name is expected to be sanitized already (the upload
 * handler runs sanitizeUploadFilename).
 */
export function persistChatUpload(fileName: string, text: string): { rel: string; abs: string } | null {
  try {
    ensureDirSync(join(getFileAreaDir(), 'uploads'));
    const rel = chatUploadRel(fileName);
    const abs = resolveFileAreaPath(rel);
    if (abs === null) return null; // paranoid: must resolve inside the area
    writeFileAtomicSync(abs, text);
    return existsSync(abs) ? { rel, abs } : null;
  } catch {
    return null;
  }
}
