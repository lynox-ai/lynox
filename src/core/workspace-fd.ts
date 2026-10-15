/**
 * Workspace access through file descriptors, never by a path name below the anchor.
 *
 * Why: a workspace can be shared with another writer (the shell sidecar's pool
 * uids). Access that checks a path and then opens it by name leaves a window in
 * which that writer can put a symlink in the way. Walking from an open directory
 * leaves none.
 *
 * How: a `WorkspaceAnchor` is an open directory. Every access walks a RELATIVE path
 * component by component; each component is opened relative to the previous open
 * directory with O_NOFOLLOW, so a symlink anywhere on the way is refused, and the
 * walk cannot be swapped under it (the next lookup starts at the already-open
 * object, not at a name). On Linux the relative lookup goes through the
 * `/proc/self/fd/<fd>/<name>` magic link. Elsewhere (macOS self-host: no sidecar,
 * no foreign writer) the same walk runs on path strings, each component still
 * opened with O_NOFOLLOW.
 *
 * What it does not do: protect against engine code that builds its own
 * `/proc/self/fd/<n>/...` path and lets the kernel resolve the rest. Such a path
 * follows symlinks below the anchor. Engine code that touches a shared workspace
 * has to go through this module; a guard on imports and fd-path literals can
 * enforce that against mistakes, not against intent — the writer this module
 * defends against is the pool uid, not the engine's own code.
 *
 * Only RELATIVE paths enter here. Mapping a user- or model-supplied absolute path
 * onto a relative one is the caller's job (through the workspace's logical prefix
 * only); an absolute path such as `/proc/self/fd/3/...` must never be opened.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const IS_LINUX = process.platform === 'linux';
/** Linux O_PATH; Node does not export it. Unused off Linux. */
const O_PATH = 0o10000000;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY;
const O_NONBLOCK = constants.O_NONBLOCK;
const DIR_FLAGS = (IS_LINUX ? O_PATH : constants.O_RDONLY) | O_DIRECTORY | O_NOFOLLOW;

/** An open directory handle. `path` is for messages and the non-Linux walk only. */
interface DirHandle {
  readonly fd: number;
  readonly path: string;
}

/** The root of a workspace, held open. Pass it in; never keep it in a module global. */
export interface WorkspaceAnchor extends DirHandle {
  readonly kind: 'anchor';
}

export type EntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface EntryInfo {
  readonly name: string;
  readonly type: EntryType;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** Thrown for every refusal of this module, with a stable code for callers. */
export class WorkspaceAccessError extends Error {
  constructor(
    readonly code: 'BAD_PATH' | 'SYMLINK' | 'NOT_DIR' | 'NOT_FILE' | 'LIMIT' | 'MOUNT' | 'REMAINDER' | 'GONE',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

function errno(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** The lookup path for one component below an open directory. */
function at(dir: DirHandle, name: string): string {
  return IS_LINUX ? `/proc/self/fd/${dir.fd}/${name}` : join(dir.path, name);
}

/** The path that names the open directory itself. */
function self(dir: DirHandle): string {
  return IS_LINUX ? `/proc/self/fd/${dir.fd}` : dir.path;
}

/**
 * Split a relative path into components. Refuses absolute paths, empty components,
 * `.`, `..`, NUL and backslashes — `..` would climb out of the magic link.
 * The empty string means the anchor itself and yields no components.
 */
export function splitRel(rel: string): string[] {
  if (rel === '') return [];
  if (rel.startsWith('/')) throw new WorkspaceAccessError('BAD_PATH', `absolute path refused: ${JSON.stringify(rel)}`);
  if (rel.includes('\0') || rel.includes('\\')) throw new WorkspaceAccessError('BAD_PATH', 'path contains NUL or a backslash');
  const parts = rel.split('/');
  // One trailing slash is tolerated ("dir/"); any other empty component is not.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') {
      throw new WorkspaceAccessError('BAD_PATH', `path component ${JSON.stringify(p)} refused in ${JSON.stringify(rel)}`);
    }
  }
  return parts;
}

function classify(st: Stats): EntryType {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

function info(name: string, st: Stats): EntryInfo {
  return { name, type: classify(st), size: st.size, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}

function openChildDir(parent: DirHandle, name: string): DirHandle {
  try {
    return { fd: openSync(at(parent, name), DIR_FLAGS), path: join(parent.path, name) };
  } catch (err) {
    const code = errno(err);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      // ENOTDIR is also what O_DIRECTORY|O_NOFOLLOW gives on a symlink: tell them apart.
      let isLink = code === 'ELOOP';
      if (!isLink) {
        try { isLink = lstatSync(at(parent, name)).isSymbolicLink(); } catch { /* gone meanwhile */ }
      }
      throw new WorkspaceAccessError(isLink ? 'SYMLINK' : 'NOT_DIR', `${join(parent.path, name)} is ${isLink ? 'a symlink' : 'not a directory'}`);
    }
    throw err;
  }
}

function closeDir(dir: DirHandle, anchor: DirHandle): void {
  if (dir.fd !== anchor.fd) closeSync(dir.fd);
}

/**
 * Walk to the directory named by `parts`, below `anchor`. With `create`, missing
 * components are made with `dirMode` (applied with fchmod, not umask-masked).
 * The caller closes the returned handle with `closeDir` — it may be the anchor.
 */
function walkDir(anchor: DirHandle, parts: readonly string[], create?: { dirMode: number }): DirHandle {
  assertLive(anchor);
  let cur: DirHandle = anchor;
  for (const name of parts) {
    let next: DirHandle;
    try {
      next = openChildDir(cur, name);
    } catch (err) {
      if (create === undefined || errno(err) !== 'ENOENT') {
        closeDir(cur, anchor);
        throw err;
      }
      try {
        mkdirSync(at(cur, name), { mode: 0o700 });
      } catch (mkErr) {
        if (errno(mkErr) !== 'EEXIST') {
          closeDir(cur, anchor);
          throw mkErr;
        }
      }
      try {
        next = openChildDir(cur, name);
        setMode(next, create.dirMode);
      } catch (openErr) {
        closeDir(cur, anchor);
        throw openErr;
      }
    }
    closeDir(cur, anchor);
    cur = next;
  }
  return cur;
}

/**
 * A held fd keeps a deleted directory alive: every operation would then see an
 * empty tree, and a backup or an erase count would report nothing where the real
 * workspace is gone. Refuse instead.
 */
function assertLive(anchor: DirHandle): void {
  if (fstatSync(anchor.fd).nlink === 0) {
    throw new WorkspaceAccessError('GONE', `${anchor.path} was removed while held open`);
  }
}

/** fchmod needs a real fd; an O_PATH fd gives EBADF, so reopen the directory read-only. */
function setMode(dir: DirHandle, mode: number): void {
  const fd = IS_LINUX ? openSync(self(dir), constants.O_RDONLY | O_DIRECTORY) : dir.fd;
  try { fchmodSync(fd, mode); } finally { if (fd !== dir.fd) closeSync(fd); }
}

function splitLeaf(rel: string): { dirParts: string[]; leaf: string } {
  const parts = splitRel(rel);
  const leaf = parts.pop();
  if (leaf === undefined) throw new WorkspaceAccessError('BAD_PATH', 'a file path needs at least one component');
  return { dirParts: parts, leaf };
}

// ── Anchors ─────────────────────────────────────────────────────────────────

/**
 * Open a workspace root by name, once, at boot. The name is resolved here and
 * never again: every later access goes through the returned handle.
 */
export function openAnchor(dir: string): WorkspaceAnchor {
  const fd = openSync(dir, DIR_FLAGS);
  return { kind: 'anchor', fd, path: dir };
}

/** Wrap an inherited directory fd (the sidecar entrypoint hands one over). */
export function anchorFromFd(fd: number, label: string): WorkspaceAnchor {
  const st = fstatSync(fd);
  if (!st.isDirectory()) throw new WorkspaceAccessError('NOT_DIR', `fd ${fd} (${label}) is not a directory`);
  return { kind: 'anchor', fd, path: label };
}

export function closeAnchor(anchor: WorkspaceAnchor): void {
  closeSync(anchor.fd);
}

/**
 * Create (if missing) and open the subdirectory `name` as its own anchor — the
 * per-context base. A symlink at that name is refused, never followed.
 */
export function ensureSubAnchor(anchor: WorkspaceAnchor, name: string, dirMode: number): WorkspaceAnchor {
  const parts = splitRel(name);
  if (parts.length !== 1) throw new WorkspaceAccessError('BAD_PATH', `a sub-anchor is one component, got ${JSON.stringify(name)}`);
  const dir = walkDir(anchor, parts, { dirMode });
  return { kind: 'anchor', fd: dir.fd, path: dir.path };
}

/** The Linux mount id of an open fd (from /proc/self/fdinfo), or null off Linux. */
export function mountIdOf(fd: number): number | null {
  if (!IS_LINUX) return null;
  const m = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

// ── Single-entry operations ─────────────────────────────────────────────────

/** lstat of one entry; a symlink is reported as `symlink`, never followed. Null if absent. */
export function statEntry(anchor: WorkspaceAnchor, rel: string): EntryInfo | null {
  const parts = splitRel(rel);
  const leaf = parts.pop();
  if (leaf === undefined) {
    assertLive(anchor);
    return info('', fstatSync(anchor.fd));
  }
  const dir = walkDir(anchor, parts);
  try {
    return info(leaf, lstatSync(at(dir, leaf)));
  } catch (err) {
    if (errno(err) === 'ENOENT') return null;
    throw err;
  } finally {
    closeDir(dir, anchor);
  }
}

/** The entries of a directory, each lstat'ed (no follow). */
export function listDir(anchor: WorkspaceAnchor, rel: string): EntryInfo[] {
  const dir = walkDir(anchor, splitRel(rel));
  try {
    return readdirSync(self(dir)).map((name) => info(name, lstatSync(at(dir, name))));
  } finally {
    closeDir(dir, anchor);
  }
}

/**
 * Open a regular file for reading. Refuses symlinks (O_NOFOLLOW), FIFOs and
 * devices (O_NONBLOCK + fstat). The caller closes the fd.
 */
export function openRead(anchor: WorkspaceAnchor, rel: string): number {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts);
  try {
    let fd: number;
    try {
      fd = openSync(at(dir, leaf), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      if (errno(err) === 'ELOOP') throw new WorkspaceAccessError('SYMLINK', `${join(dir.path, leaf)} is a symlink`);
      throw err;
    }
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new WorkspaceAccessError('NOT_FILE', `${join(dir.path, leaf)} is not a regular file`);
    }
    return fd;
  } finally {
    closeDir(dir, anchor);
  }
}

/** Read a whole regular file, refusing one larger than `maxBytes`. */
export function readFileAt(anchor: WorkspaceAnchor, rel: string, maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
  const fd = openRead(anchor, rel);
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw new WorkspaceAccessError('LIMIT', `${rel} is ${size} bytes, over the ${maxBytes}-byte limit`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface WriteOptions {
  /** Mode set with fchmod on the new file (not umask-masked). */
  readonly fileMode: number;
  /** Mode for directories created on the way; omit to require that they exist. */
  readonly dirMode?: number | undefined;
}

/**
 * Write a file atomically: a temp file beside the target (O_EXCL|O_NOFOLLOW),
 * fsync, fchmod, then rename over the target. A symlink at the target is
 * replaced, never written through; a directory at the target is an error.
 */
export function writeFileAt(anchor: WorkspaceAnchor, rel: string, data: string | Uint8Array, opts: WriteOptions): void {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts, opts.dirMode !== undefined ? { dirMode: opts.dirMode } : undefined);
  try {
    writeIntoDir(dir, leaf, opts.fileMode, (fd) => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    });
  } finally {
    closeDir(dir, anchor);
  }
}

function writeIntoDir(dir: DirHandle, leaf: string, fileMode: number, fill: (fd: number) => void): void {
  const tmp = `.${leaf.slice(0, 64)}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(at(dir, tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  let moved = false;
  try {
    fill(fd);
    fchmodSync(fd, fileMode);
    fsyncSync(fd);
    closeSync(fd);
    try {
      const target = lstatSync(at(dir, leaf));
      if (target.isDirectory()) throw new WorkspaceAccessError('NOT_FILE', `${join(dir.path, leaf)} is a directory`);
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw err;
    }
    renameSync(at(dir, tmp), at(dir, leaf));
    moved = true;
  } finally {
    if (!moved) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(at(dir, tmp)); } catch { /* never created or already gone */ }
    }
  }
}

/** Create a directory path; existing components must be real directories. */
export function mkdirAt(anchor: WorkspaceAnchor, rel: string, dirMode: number): void {
  closeDir(walkDir(anchor, splitRel(rel), { dirMode }), anchor);
}

/** Remove one non-directory entry (a symlink is removed, not its target). */
export function unlinkAt(anchor: WorkspaceAnchor, rel: string): void {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts);
  try { unlinkSync(at(dir, leaf)); } finally { closeDir(dir, anchor); }
}

/** Remove one empty directory. */
export function rmdirAt(anchor: WorkspaceAnchor, rel: string): void {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts);
  try { rmdirSync(at(dir, leaf)); } finally { closeDir(dir, anchor); }
}

/** Rename within one anchor. A symlink at either end is moved as a link. */
export function renameAt(anchor: WorkspaceAnchor, fromRel: string, toRel: string): void {
  const from = splitLeaf(fromRel);
  const to = splitLeaf(toRel);
  const fromDir = walkDir(anchor, from.dirParts);
  try {
    const toDir = walkDir(anchor, to.dirParts);
    try { renameSync(at(fromDir, from.leaf), at(toDir, to.leaf)); } finally { closeDir(toDir, anchor); }
  } finally {
    closeDir(fromDir, anchor);
  }
}

// ── Recursive operations ────────────────────────────────────────────────────

export interface WalkLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface WalkEntry {
  /** Path relative to the walked directory. */
  readonly rel: string;
  readonly type: EntryType;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
}

export interface WalkResult {
  readonly entries: WalkEntry[];
  readonly files: number;
  readonly dirs: number;
  readonly symlinks: number;
  readonly others: number;
  readonly bytes: number;
  /** Directories that sit on a different mount than the walked root (Linux only). */
  readonly mountBoundaries: string[];
}

const NO_LIMITS: WalkLimits = { maxDepth: 64, maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER };

/**
 * List everything below `rel`, depth-first, pre-order. Symlinks are reported and
 * never followed. Exceeding a limit throws (LIMIT) rather than truncating, so a
 * caller can never mistake a cut-off listing for the whole tree.
 */
export function walk(anchor: WorkspaceAnchor, rel: string, limits: WalkLimits = NO_LIMITS): WalkResult {
  const entries: WalkEntry[] = [];
  const mountBoundaries: string[] = [];
  let files = 0, dirs = 0, symlinks = 0, others = 0, bytes = 0;
  const root = walkDir(anchor, splitRel(rel));
  const rootMount = mountIdOf(root.fd);
  const visit = (dir: DirHandle, prefix: string, depth: number): void => {
    for (const name of readdirSync(self(dir))) {
      const st = lstatSync(at(dir, name));
      const childRel = prefix === '' ? name : `${prefix}/${name}`;
      const type = classify(st);
      entries.push({ rel: childRel, type, size: st.size, mode: st.mode & 0o7777, uid: st.uid });
      if (entries.length > limits.maxEntries) throw new WorkspaceAccessError('LIMIT', `more than ${limits.maxEntries} entries below ${JSON.stringify(rel)}`);
      if (type === 'file') {
        files++;
        bytes += st.size;
        if (bytes > limits.maxBytes) throw new WorkspaceAccessError('LIMIT', `more than ${limits.maxBytes} bytes below ${JSON.stringify(rel)}`);
      } else if (type === 'symlink') {
        symlinks++;
      } else if (type === 'other') {
        others++;
      } else {
        dirs++;
        if (depth + 1 > limits.maxDepth) throw new WorkspaceAccessError('LIMIT', `deeper than ${limits.maxDepth} below ${JSON.stringify(rel)}`);
        const child = openChildDir(dir, name);
        try {
          if (rootMount !== null && mountIdOf(child.fd) !== rootMount) {
            mountBoundaries.push(childRel);
            continue;
          }
          visit(child, childRel, depth + 1);
        } finally {
          closeSync(child.fd);
        }
      }
    }
  };
  try {
    visit(root, '', 0);
  } finally {
    closeDir(root, anchor);
  }
  return { entries, files, dirs, symlinks, others, bytes, mountBoundaries };
}

export interface CopyCount {
  readonly files: number;
  readonly dirs: number;
  readonly bytes: number;
  /** Symlinks, FIFOs, sockets, devices: counted, never copied. */
  readonly skipped: string[];
}

/** Receives one regular file of a copy-out; `fd` is open for reading and closed after. */
export type CopyOutSink = (rel: string, fd: number, size: number) => void;

/**
 * Copy every regular file below `rel` out of the workspace. The sink decides
 * where it goes (a directory outside the workspace, an archive, export chunks).
 * Mount boundaries are refused before anything is copied.
 */
export function copyOut(anchor: WorkspaceAnchor, rel: string, sink: CopyOutSink, limits: WalkLimits = NO_LIMITS): CopyCount {
  const listing = walk(anchor, rel, limits);
  if (listing.mountBoundaries.length > 0) {
    throw new WorkspaceAccessError('MOUNT', `mount boundary below ${JSON.stringify(rel)}: ${listing.mountBoundaries.join(', ')}`);
  }
  const base = splitRel(rel);
  const skipped: string[] = [];
  let files = 0, dirs = 0, bytes = 0;
  for (const e of listing.entries) {
    if (e.type === 'dir') { dirs++; continue; }
    if (e.type !== 'file') { skipped.push(e.rel); continue; }
    let fd: number;
    try {
      fd = openRead(anchor, [...base, e.rel].join('/'));
    } catch (err) {
      // Swapped for a link or a FIFO since the walk: skip it, never follow.
      if (err instanceof WorkspaceAccessError && (err.code === 'SYMLINK' || err.code === 'NOT_FILE')) { skipped.push(e.rel); continue; }
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      sink(e.rel, fd, size);
      files++;
      bytes += size;
    } finally {
      closeSync(fd);
    }
  }
  return { files, dirs, bytes, skipped };
}

export interface StageOptions {
  readonly fileMode: number;
  readonly dirMode: number;
}

/** One file to write in: a path relative to the staged directory, and its content. */
export interface StageEntry {
  readonly rel: string;
  readonly data: string | Uint8Array;
}

/** Files written beside their targets, not yet in place. */
export interface StagedWrite {
  readonly files: number;
  readonly bytes: number;
  /** Rename every staged file over its target. Not atomic across files. */
  commit(): void;
  /** Remove every staged file; the targets stay as they were. */
  abort(): void;
}

/** Prefix of a staged file. Fixed, so a temp left by a crashed run is found again. */
export const STAGE_PREFIX = '.lynox-stage-';

function stageName(leaf: string): string {
  return STAGE_PREFIX + createHash('sha256').update(leaf).digest('hex').slice(0, 24);
}

interface Staged {
  readonly dirParts: string[];
  readonly leaf: string;
  readonly tmp: string;
}

/**
 * Write files into the workspace below `rel` in two phases, so a restore can
 * stage everything (databases, config, workspace) and only then swap.
 *
 * Phase 1 (this call): left-over files of the stage pattern below `rel` are
 * removed; each entry is written to a temp beside its target (O_EXCL|O_NOFOLLOW,
 * fchmod, fsync). A target of the wrong kind (a directory where a file goes) or a
 * symlink on the way fails here, and everything staged so far is removed.
 * `commit()` renames the temps over the targets; nothing is ever deleted, so this
 * overlays. A symlink at a target is replaced by the rename, never written through.
 */
export function stageIn(anchor: WorkspaceAnchor, rel: string, source: Iterable<StageEntry>, opts: StageOptions): StagedWrite {
  const base = splitRel(rel);
  const staged: Staged[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const removeStaged = (): void => {
    for (const s of staged) {
      try {
        const dir = walkDir(anchor, s.dirParts);
        try { unlinkSync(at(dir, s.tmp)); } finally { closeDir(dir, anchor); }
      } catch { /* already gone */ }
    }
  };
  try {
    if (statEntry(anchor, rel)?.type === 'dir') {
      for (const e of walk(anchor, rel).entries) {
        const name = e.rel.slice(e.rel.lastIndexOf('/') + 1);
        if (e.type !== 'dir' && name.startsWith(STAGE_PREFIX)) unlinkAt(anchor, [...base, e.rel].join('/'));
      }
    }
    for (const entry of source) {
      const parts = [...base, ...splitRel(entry.rel)];
      const leaf = parts.pop();
      if (leaf === undefined) throw new WorkspaceAccessError('BAD_PATH', 'a staged file needs a path');
      const key = [...parts, leaf].join('/');
      if (seen.has(key)) throw new WorkspaceAccessError('BAD_PATH', `${key} staged twice`);
      seen.add(key);
      const dir = walkDir(anchor, parts, { dirMode: opts.dirMode });
      try {
        try {
          if (lstatSync(at(dir, leaf)).isDirectory()) {
            throw new WorkspaceAccessError('NOT_FILE', `${join(dir.path, leaf)} is a directory`);
          }
        } catch (err) {
          if (errno(err) !== 'ENOENT') throw err;
        }
        const tmp = stageName(leaf);
        const fd = openSync(at(dir, tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        staged.push({ dirParts: parts, leaf, tmp });
        try {
          const buf = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
          let off = 0;
          while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
          bytes += buf.length;
          fchmodSync(fd, opts.fileMode);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } finally {
        closeDir(dir, anchor);
      }
    }
  } catch (err) {
    removeStaged();
    throw err;
  }
  let settled = false;
  return {
    files: staged.length,
    bytes,
    commit(): void {
      if (settled) throw new Error('staged write already committed or aborted');
      settled = true;
      for (const s of staged) {
        const dir = walkDir(anchor, s.dirParts);
        try { renameSync(at(dir, s.tmp), at(dir, s.leaf)); } finally { closeDir(dir, anchor); }
      }
    },
    abort(): void {
      if (settled) return;
      settled = true;
      removeStaged();
    },
  };
}

export interface EmptyResult {
  readonly removed: number;
  /** Entries still present after the pass (counted through the fd). */
  readonly remaining: string[];
}

/**
 * Remove everything below `rel`; `rel` itself stays. Bottom-up, never following
 * a link. Refuses before deleting anything when a mount boundary is below.
 * After the pass it lists again through the fd and THROWS (REMAINDER) if anything
 * is left — a caller that promises erasure must not report success otherwise.
 */
export function emptyDir(anchor: WorkspaceAnchor, rel: string): EmptyResult {
  const listing = walk(anchor, rel);
  if (listing.mountBoundaries.length > 0) {
    throw new WorkspaceAccessError('MOUNT', `mount boundary below ${JSON.stringify(rel)}: ${listing.mountBoundaries.join(', ')}`);
  }
  const base = splitRel(rel);
  let removed = 0;
  // Post-order: deepest first, so every directory is empty when it is removed.
  for (const e of [...listing.entries].reverse()) {
    const target = [...base, e.rel].join('/');
    try {
      if (e.type === 'dir') rmdirAt(anchor, target);
      else unlinkAt(anchor, target);
      removed++;
    } catch (err) {
      // A pool uid may have changed the tree meanwhile; the final count decides.
      if (!(err instanceof WorkspaceAccessError) && errno(err) === undefined) throw err;
    }
  }
  const remaining = listDir(anchor, rel).map((e) => e.name);
  if (remaining.length > 0) {
    throw new WorkspaceAccessError('REMAINDER', `${remaining.length} entries remain below ${JSON.stringify(rel)} after emptying: ${remaining.slice(0, 10).join(', ')}`);
  }
  return { removed, remaining };
}
