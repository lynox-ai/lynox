/**
 * Workspace access through file descriptors, never by a path name below the anchor.
 *
 * Why: a workspace may be written by another uid at the same time (the shell
 * sidecar). Every access here walks from an open directory and refuses symlinks,
 * so such a writer cannot redirect it.
 *
 * How (Linux): a `WorkspaceAnchor` is an open directory. Every access walks a
 * RELATIVE path component by component; each component is opened relative to the
 * previous open directory, through the `/proc/self/fd/<fd>/<name>` magic link,
 * with O_NOFOLLOW. A symlink anywhere on the way is refused, and the next lookup
 * starts at the already-open object, not at a name. Names are handled as raw bytes
 * internally, so a name that is not valid UTF-8 can still be listed and removed.
 *
 * Off Linux (macOS self-host, which has no sidecar): the same walk runs on path
 * strings from the anchor's name, each component still opened with O_NOFOLLOW.
 * That refuses symlinks but is NOT race-free against a concurrent writer, and
 * mount boundaries are detected by device id only. Windows is not supported.
 *
 * What it does not do: protect against engine code that builds its own
 * `/proc/self/fd/<n>/...` path and lets the kernel resolve the rest. Such a path
 * follows symlinks below the anchor. Engine code that touches a shared workspace
 * has to go through this module; a guard on imports and fd-path literals can
 * enforce that against mistakes, not against intent — the writer this module
 * defends against is another uid, not the engine's own code.
 *
 * Only RELATIVE paths enter here. Mapping a user- or model-supplied absolute path
 * onto a relative one is the caller's job (through the workspace's logical prefix
 * only); an absolute path such as `/proc/self/fd/3/...` must never be opened.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';

const IS_LINUX = process.platform === 'linux';
const SUPPORTED = typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_DIRECTORY === 'number';
/** Linux O_PATH; Node does not export it. Unused off Linux. */
const O_PATH = 0o10000000;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY;
const O_NONBLOCK = constants.O_NONBLOCK;
const DIR_FLAGS = (IS_LINUX ? O_PATH : constants.O_RDONLY) | O_DIRECTORY | O_NOFOLLOW;
const SLASH = Buffer.from('/');

/** An open directory handle. `pathBuf` is for messages and the non-Linux walk only. */
interface DirHandle {
  readonly fd: number;
  readonly pathBuf: Buffer;
}

/** The root of a workspace, held open. Pass it in; never keep it in a module global. */
export interface WorkspaceAnchor extends DirHandle {
  readonly kind: 'anchor';
}

export type EntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface EntryInfo {
  /** The name, decoded as UTF-8. When `exactName` is false it is lossy and cannot address the entry. */
  readonly name: string;
  readonly exactName: boolean;
  readonly type: EntryType;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export type WorkspaceErrorCode =
  | 'BAD_PATH' | 'SYMLINK' | 'NOT_DIR' | 'NOT_FILE' | 'LIMIT' | 'MOUNT' | 'OVERLAP' | 'REMAINDER' | 'GONE' | 'PARTIAL' | 'UNSUPPORTED';

/** Thrown for the refusals of this module, with a stable code for callers. */
export class WorkspaceAccessError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) {
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
function at(dir: DirHandle, name: Buffer): Buffer {
  return IS_LINUX
    ? Buffer.concat([Buffer.from(`/proc/self/fd/${dir.fd}/`), name])
    : Buffer.concat([dir.pathBuf, SLASH, name]);
}

/** The path that names the open directory itself. */
function self(dir: DirHandle): Buffer {
  return IS_LINUX ? Buffer.from(`/proc/self/fd/${dir.fd}`) : dir.pathBuf;
}

function show(dir: DirHandle, name?: Buffer): string {
  return (name === undefined ? dir.pathBuf : Buffer.concat([dir.pathBuf, SLASH, name])).toString('utf8');
}

function decode(name: Buffer): { text: string; exact: boolean } {
  const text = name.toString('utf8');
  return { text, exact: Buffer.from(text, 'utf8').equals(name) };
}

function readNames(dir: DirHandle): Buffer[] {
  return readdirSync(self(dir), { encoding: 'buffer' });
}

/**
 * Split a relative path into components. Refuses absolute paths, empty components,
 * `.`, `..` and NUL — `..` would climb out of the magic link. A backslash is an ordinary
 * character on Linux (the only platform with the race-free walk); only `/` separates.
 * The empty string means the anchor itself and yields no components.
 */
export function splitRel(rel: string): string[] {
  if (rel === '') return [];
  if (rel.startsWith('/')) throw new WorkspaceAccessError('BAD_PATH', `absolute path refused: ${JSON.stringify(rel)}`);
  if (rel.includes('\0')) throw new WorkspaceAccessError('BAD_PATH', 'path contains NUL');
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

function info(name: Buffer, st: Stats): EntryInfo {
  const { text, exact } = decode(name);
  return { name: text, exactName: exact, type: classify(st), size: st.size, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}

/** lstat of one entry; null when it is gone (a concurrent writer removed it). */
function lstatOrNull(dir: DirHandle, name: Buffer): Stats | null {
  try {
    return lstatSync(at(dir, name));
  } catch (err) {
    if (errno(err) === 'ENOENT') return null;
    throw err;
  }
}

function openChildDir(parent: DirHandle, name: Buffer): DirHandle {
  try {
    return { fd: openSync(at(parent, name), DIR_FLAGS), pathBuf: Buffer.concat([parent.pathBuf, SLASH, name]) };
  } catch (err) {
    const code = errno(err);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      // ENOTDIR is also what O_DIRECTORY|O_NOFOLLOW gives on a symlink: tell them apart.
      let isLink = code === 'ELOOP';
      if (!isLink) isLink = lstatOrNull(parent, name)?.isSymbolicLink() ?? false;
      throw new WorkspaceAccessError(isLink ? 'SYMLINK' : 'NOT_DIR', `${show(parent, name)} is ${isLink ? 'a symlink' : 'not a directory'}`);
    }
    throw err;
  }
}

function closeDir(dir: DirHandle, anchor: DirHandle): void {
  if (dir.fd !== anchor.fd) closeSync(dir.fd);
}

/**
 * A held fd keeps a deleted directory alive: every operation would then see an
 * empty tree, and a backup or an erase count would report nothing where the real
 * workspace is gone. Refuse instead. ESTALE (a network filesystem) means the same.
 */
function assertLive(anchor: DirHandle): void {
  let nlink: number;
  try {
    nlink = fstatSync(anchor.fd).nlink;
  } catch (err) {
    if (errno(err) === 'ESTALE') throw new WorkspaceAccessError('GONE', `${show(anchor)} is stale`);
    throw err;
  }
  if (nlink === 0) throw new WorkspaceAccessError('GONE', `${show(anchor)} was removed while held open`);
}

/** The set-group-ID bit (not in `fs.constants`). */
const S_ISGID = 0o2000;

/**
 * fchmod needs a real fd; an O_PATH fd gives EBADF, so reopen the directory read-only. A new
 * directory under a set-group-ID parent inherits that bit from mkdir; it is kept, as a mkdir by
 * name keeps it, so files made below stay in the parent's group. With `group`, the directory is
 * given that group first, through the same reopened fd (fchown on O_PATH is EBADF as well).
 */
function setMode(dir: DirHandle, mode: number, group?: number): void {
  const fd = IS_LINUX ? openSync(self(dir), constants.O_RDONLY | O_DIRECTORY) : dir.fd;
  try {
    if (group !== undefined) fchownSync(fd, -1, group);
    fchmodSync(fd, mode | (fstatSync(fd).mode & S_ISGID));
  } finally { if (fd !== dir.fd) closeSync(fd); }
}

/**
 * Walk to the directory named by `parts`, below `anchor`. With `create`, missing
 * components are made and given `dirMode` (with fchmod, not umask-masked; an inherited
 * set-group-ID bit is kept); a
 * directory this call did not create keeps its mode. The caller closes the
 * returned handle with `closeDir` — it may be the anchor.
 */
function walkDir(anchor: DirHandle, parts: readonly string[], create?: { dirMode: number; group?: number | undefined }): DirHandle {
  assertLive(anchor);
  let cur: DirHandle = anchor;
  try {
    for (const part of parts) {
      const name = Buffer.from(part, 'utf8');
      let next: DirHandle;
      try {
        next = openChildDir(cur, name);
      } catch (err) {
        if (create === undefined || errno(err) !== 'ENOENT') throw err;
        let made = false;
        try {
          mkdirSync(at(cur, name), { mode: 0o700 });
          made = true;
        } catch (mkErr) {
          if (errno(mkErr) !== 'EEXIST') throw mkErr;
        }
        next = openChildDir(cur, name);
        if (made) {
          try {
            setMode(next, create.dirMode, create.group);
          } catch (modeErr) {
            // A directory left with mkdir's 0700 would never get its mode or group: the next call
            // finds it and does not count it as made. Removed again, if it is still the one made
            // here and still empty.
            try {
              const ino = fstatSync(next.fd).ino;
              if (lstatOrNull(cur, name)?.ino === ino) rmdirSync(at(cur, name));
            } catch { /* no longer empty, or gone */ }
            closeSync(next.fd);
            throw modeErr;
          }
        }
      }
      closeDir(cur, anchor);
      cur = next;
    }
  } catch (err) {
    closeDir(cur, anchor);
    throw err;
  }
  return cur;
}

function splitLeaf(rel: string): { dirParts: string[]; leaf: Buffer; leafText: string } {
  const parts = splitRel(rel);
  const leafText = parts.pop();
  if (leafText === undefined) throw new WorkspaceAccessError('BAD_PATH', 'a file path needs at least one component');
  return { dirParts: parts, leaf: Buffer.from(leafText, 'utf8'), leafText };
}

function requireSupported(): void {
  if (!SUPPORTED) throw new WorkspaceAccessError('UNSUPPORTED', `fd-based workspace access is not available on ${process.platform}`);
}

// ── Anchors ─────────────────────────────────────────────────────────────────

/**
 * Open a workspace root by name, once, at boot. On Linux the name is resolved
 * here and never again: every later access goes through the returned handle.
 */
export function openAnchor(dir: string): WorkspaceAnchor {
  requireSupported();
  const fd = openSync(dir, DIR_FLAGS);
  return { kind: 'anchor', fd, pathBuf: Buffer.from(dir, 'utf8') };
}

/** Wrap an inherited directory fd (the sidecar entrypoint hands one over). */
export function anchorFromFd(fd: number, label: string): WorkspaceAnchor {
  requireSupported();
  const st = fstatSync(fd);
  if (!st.isDirectory()) throw new WorkspaceAccessError('NOT_DIR', `fd ${fd} (${label}) is not a directory`);
  return { kind: 'anchor', fd, pathBuf: Buffer.from(label, 'utf8') };
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
  return { kind: 'anchor', fd: dir.fd, pathBuf: dir.pathBuf };
}

/** A directory that is not, or could not be made, what the caller asked for. */
export class DirStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirStateError';
  }
}

/**
 * As {@link ensureSubAnchor}, and the directory gets `dirMode` and `group` whether this call made it
 * or it was there already (a context directory left at mkdir's 0700 by an earlier start, or changed
 * since). Set through a reopened fd, as `setMode` does: on the O_PATH anchor fchown and fchmod are
 * EBADF.
 *
 * A directory that does not belong to `owner` is refused before anything is changed. Afterwards
 * the directory is read back: a kernel that drops the set-group-ID bit without an error (fchmod by
 * a process outside `group`) leaves a mode nobody asked for, and that is refused as well. A
 * failed call closes what it opened and throws, naming the call in its errno message.
 */
export function ensureSubAnchorWithMode(anchor: WorkspaceAnchor, name: string, dirMode: number, group: number, owner: number): WorkspaceAnchor {
  const parts = splitRel(name);
  if (parts.length !== 1) throw new WorkspaceAccessError('BAD_PATH', `a sub-anchor is one component, got ${JSON.stringify(name)}`);
  // A new directory gets its mode from the walk; group and mode are set below for new and old alike.
  const dir = walkDir(anchor, parts, { dirMode });
  try {
    const before = fstatSync(dir.fd).uid;
    if (before !== owner) throw new DirStateError(`it belongs to uid ${before}, not to uid ${owner}`);
    setMode(dir, dirMode, group);
    const after = fstatSync(dir.fd);
    if ((after.mode & 0o7777) !== dirMode || after.gid !== group) {
      throw new DirStateError(`after fchown and fchmod it has mode 0o${(after.mode & 0o7777).toString(8)} and group ${after.gid}, not 0o${dirMode.toString(8)} and ${group}`);
    }
    return { kind: 'anchor', fd: dir.fd, pathBuf: dir.pathBuf };
  } catch (err) {
    closeSync(dir.fd);
    throw err;
  }
}

/**
 * Open the directory `rel` below `anchor` as its own anchor, every component with O_NOFOLLOW.
 * Creates nothing: a missing component is ENOENT, a symlink on the way is refused. `rel` must
 * name at least one component (the anchor itself is not handed out twice).
 */
export function openSubAnchor(anchor: WorkspaceAnchor, rel: string): WorkspaceAnchor {
  const parts = splitRel(rel);
  if (parts.length === 0) throw new WorkspaceAccessError('BAD_PATH', 'a sub-anchor needs at least one component');
  const dir = walkDir(anchor, parts);
  return { kind: 'anchor', fd: dir.fd, pathBuf: dir.pathBuf };
}

/** The Linux mount id of an open fd (from /proc/self/fdinfo), or null off Linux. */
export function mountIdOf(fd: number): number | null {
  if (!IS_LINUX) return null;
  const m = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/**
 * The Linux mount id of the entry at `path`, a link not followed, or null off Linux. For a check
 * by path where no anchor is held (the data directory's own entries); the anchor walk uses the fd.
 */
export function mountIdAt(path: string): number | null {
  if (!IS_LINUX) return null;
  const fd = openSync(path, O_PATH | O_NOFOLLOW);
  try {
    return mountIdOf(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The Linux mount id of the directory at `path`, links followed; null where it cannot be opened
 * or its fdinfo read (off Linux, no `/proc`). The one other fdinfo reader, `workspace-root.ts`'s
 * own copy, was folded into this one (PRD shell-sidecar-activation D2 (c)).
 */
export function mountIdOfDir(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_DIRECTORY);
  } catch {
    return null;
  }
  try {
    return mountIdOf(fd);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The fds this process holds open, from `/proc/self/fd`. Throws where that cannot be read. */
export function openFds(): number[] {
  return readdirSync('/proc/self/fd').map(Number).filter(Number.isInteger);
}

/** What identifies "the same mount": the mount id on Linux, the device id elsewhere. */
function mountKey(fd: number): string {
  const id = mountIdOf(fd);
  return id !== null ? `m${id}` : `d${fstatSync(fd).dev}`;
}

// ── Single-entry operations ─────────────────────────────────────────────────

/** lstat of one entry; a symlink is reported as `symlink`, never followed. Null if absent. */
export function statEntry(anchor: WorkspaceAnchor, rel: string): EntryInfo | null {
  const parts = splitRel(rel);
  const leaf = parts.pop();
  if (leaf === undefined) {
    assertLive(anchor);
    return info(Buffer.alloc(0), fstatSync(anchor.fd));
  }
  const dir = walkDir(anchor, parts);
  try {
    const name = Buffer.from(leaf, 'utf8');
    const st = lstatOrNull(dir, name);
    return st === null ? null : info(name, st);
  } finally {
    closeDir(dir, anchor);
  }
}

/** The entries of a directory, each lstat'ed (no follow). Entries that vanish meanwhile are left out. */
export function listDir(anchor: WorkspaceAnchor, rel: string): EntryInfo[] {
  const dir = walkDir(anchor, splitRel(rel));
  try {
    const out: EntryInfo[] = [];
    for (const name of readNames(dir)) {
      const st = lstatOrNull(dir, name);
      if (st !== null) out.push(info(name, st));
    }
    return out;
  } finally {
    closeDir(dir, anchor);
  }
}

/**
 * Open a regular file for reading. Refuses symlinks (O_NOFOLLOW), FIFOs, sockets
 * and devices (O_NONBLOCK + fstat). The caller closes the fd.
 */
export function openRead(anchor: WorkspaceAnchor, rel: string): number {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts);
  try {
    let fd: number;
    try {
      fd = openSync(at(dir, leaf), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      const code = errno(err);
      if (code === 'ELOOP') throw new WorkspaceAccessError('SYMLINK', `${show(dir, leaf)} is a symlink`);
      if (code === 'ENXIO' || code === 'ENODEV' || code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        throw new WorkspaceAccessError('NOT_FILE', `${show(dir, leaf)} is not a regular file`);
      }
      throw err;
    }
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new WorkspaceAccessError('NOT_FILE', `${show(dir, leaf)} is not a regular file`);
    }
    return fd;
  } finally {
    closeDir(dir, anchor);
  }
}

/**
 * The most a file tool reads of one file in a single piece: read_file refuses a larger
 * file, and the reads before a write (the diff preview, the review's backup, edit_file)
 * stop at it, so a write to a file of any size cannot make the engine read all of it.
 */
export const FILE_TOOL_READ_CAP_BYTES = 5 * 1024 * 1024;

/** Whether `err` is this module's refusal of a file over a read limit. */
export function isReadLimit(err: unknown): boolean {
  return err instanceof WorkspaceAccessError && err.code === 'LIMIT';
}

/**
 * Read the rest of an open file, refusing one larger than `maxBytes` with a `LIMIT`
 * error. The limit holds while reading, not only at open: a file another writer keeps
 * growing is cut off. `label` names the file in the error. The caller closes the fd.
 */
export function readFdCapped(fd: number, maxBytes: number, label: string): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(1 << 16);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > maxBytes) throw new WorkspaceAccessError('LIMIT', `${label} is over the ${maxBytes}-byte limit`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a whole regular file, refusing one larger than `maxBytes`, as {@link readFdCapped}.
 */
export function readFileAt(anchor: WorkspaceAnchor, rel: string, maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
  const fd = openRead(anchor, rel);
  try {
    return readFdCapped(fd, maxBytes, rel);
  } finally {
    closeSync(fd);
  }
}

export interface OpenWriteOptions {
  /** Create the file with this mode (fchmod, not umask-masked) when it does not exist; omit to require it. */
  readonly createMode?: number | undefined;
  /** Mode for directories created on the way; omit to require that they exist. */
  readonly dirMode?: number | undefined;
  /** Group given (fchown) to the file and the directories this call creates; omit to keep the default. */
  readonly group?: number | undefined;
}

function refuseWriteOpen(dir: DirHandle, leaf: Buffer, err: unknown): never {
  const code = errno(err);
  if (code === 'ELOOP') throw new WorkspaceAccessError('SYMLINK', `${show(dir, leaf)} is a symlink`);
  if (code === 'ENXIO' || code === 'ENODEV' || code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EISDIR') {
    throw new WorkspaceAccessError('NOT_FILE', `${show(dir, leaf)} is not a regular file`);
  }
  throw err;
}

/**
 * Open a regular file for writing IN PLACE, without truncating it: the same inode, so its owner,
 * mode, ACLs and the kernel's permission check stay as they are (a read-only file is EACCES, as
 * with a plain write by name). A symlink at the file is refused (O_NOFOLLOW), and so are FIFOs,
 * sockets and devices — a device is refused only after its open, which may have an effect of its
 * own; making one in the workspace needs root. With `createMode`, a missing file is created with
 * O_EXCL. The caller truncates, writes and closes the fd.
 */
export function openWrite(anchor: WorkspaceAnchor, rel: string, opts: OpenWriteOptions = {}): { fd: number; created: boolean } {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts, opts.dirMode !== undefined ? { dirMode: opts.dirMode, group: opts.group } : undefined);
  try {
    let fd: number;
    let created = false;
    try {
      fd = openSync(at(dir, leaf), constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      if (errno(err) !== 'ENOENT' || opts.createMode === undefined) refuseWriteOpen(dir, leaf, err);
      try {
        fd = openSync(at(dir, leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        created = true;
      } catch (createErr) {
        refuseWriteOpen(dir, leaf, createErr);
      }
    }
    try {
      if (!fstatSync(fd).isFile()) throw new WorkspaceAccessError('NOT_FILE', `${show(dir, leaf)} is not a regular file`);
      if (created && opts.group !== undefined) fchownSync(fd, -1, opts.group);
      if (created && opts.createMode !== undefined) fchmodSync(fd, opts.createMode);
    } catch (err) {
      // A file made here and left 0600 would be written later as it is, since it then exists:
      // removed again, if the name still holds the file made here.
      if (created) {
        try {
          if (lstatOrNull(dir, leaf)?.ino === fstatSync(fd).ino) unlinkSync(at(dir, leaf));
        } catch { /* already gone */ }
      }
      closeSync(fd);
      throw err;
    }
    return { fd, created };
  } finally {
    closeDir(dir, anchor);
  }
}

export interface WriteOptions {
  /** Mode set with fchmod on the new file (not umask-masked). */
  readonly fileMode: number;
  /** Mode for directories created on the way; omit to require that they exist. */
  readonly dirMode?: number | undefined;
  /** Group given (fchown) to the new file and the directories this call creates; omit to keep the default. */
  readonly group?: number | undefined;
}

/** Prefix of a staged or temp file: `.lynox-stage-` plus 24 hex characters. */
export const STAGE_PREFIX = '.lynox-stage-';
const STAGE_NAME = /^\.lynox-stage-[0-9a-f]{24}$/;

function tempName(): Buffer {
  return Buffer.from(STAGE_PREFIX + randomBytes(12).toString('hex'), 'utf8');
}

function writeAll(fd: number, data: string | Uint8Array): number {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  return buf.length;
}

/** Refuse a directory at `leaf` before anything is renamed over it. */
function assertNotDir(dir: DirHandle, leaf: Buffer): void {
  if (lstatOrNull(dir, leaf)?.isDirectory() === true) {
    throw new WorkspaceAccessError('NOT_FILE', `${show(dir, leaf)} is a directory`);
  }
}

/** Write a new temp file in `dir` (O_EXCL|O_NOFOLLOW), fill, fchown (with `group`), fchmod, fsync. Returns its name. */
function writeTemp(dir: DirHandle, fileMode: number, data: string | Uint8Array, group?: number): { tmp: Buffer; bytes: number } {
  const tmp = tempName();
  const fd = openSync(at(dir, tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  let open = true;
  try {
    const bytes = writeAll(fd, data);
    if (group !== undefined) fchownSync(fd, -1, group);
    fchmodSync(fd, fileMode);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    return { tmp, bytes };
  } catch (err) {
    if (open) closeSync(fd);
    try { unlinkSync(at(dir, tmp)); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Write a file atomically: a temp file beside the target, fsync, fchmod, then
 * rename over the target. A symlink at the target is replaced, never written
 * through; a directory at the target is an error.
 */
export function writeFileAt(anchor: WorkspaceAnchor, rel: string, data: string | Uint8Array, opts: WriteOptions): void {
  const { dirParts, leaf } = splitLeaf(rel);
  const dir = walkDir(anchor, dirParts, opts.dirMode !== undefined ? { dirMode: opts.dirMode, group: opts.group } : undefined);
  try {
    const { tmp } = writeTemp(dir, opts.fileMode, data, opts.group);
    try {
      assertNotDir(dir, leaf);
      renameSync(at(dir, tmp), at(dir, leaf));
    } catch (err) {
      try { unlinkSync(at(dir, tmp)); } catch { /* already gone */ }
      throw err;
    }
  } finally {
    closeDir(dir, anchor);
  }
}

/** Create a directory path; existing components must be real directories. With `group`, the directories it creates get that group. */
export function mkdirAt(anchor: WorkspaceAnchor, rel: string, dirMode: number, group?: number): void {
  closeDir(walkDir(anchor, splitRel(rel), { dirMode, group }), anchor);
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
  /** Path relative to the walked directory; lossy when `exactName` is false. */
  readonly rel: string;
  /** False when a name on the path is not valid UTF-8: `rel` cannot address it. */
  readonly exactName: boolean;
  readonly type: EntryType;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  /** Device and inode, to recognise a second name (a hard link) for a file elsewhere. */
  readonly dev: number;
  readonly ino: number;
}

export interface WalkResult {
  readonly entries: WalkEntry[];
  readonly files: number;
  readonly dirs: number;
  readonly symlinks: number;
  readonly others: number;
  readonly bytes: number;
  /** Directories that sit on a different mount than the walked root. Not descended into. */
  readonly mountBoundaries: string[];
  /**
   * Directories (`''` for the walked one itself) that ARE the directory `watch` names, by device
   * and inode: a bind mount shows a directory under a second path on the same mount, which no
   * mount boundary reveals.
   */
  readonly watchedAt: string[];
}

const DEFAULT_LIMITS: WalkLimits = { maxDepth: 1024, maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER };

/**
 * Receives an entry below the walked directory that cannot be read (EACCES, EPERM), with the
 * error code. Without it such an entry fails the walk or copy, which is what a backup needs.
 * A caller that passes it promises to NAME what it was told about, never to drop it: the export
 * lists these entries as unreadable instead of failing the whole answer.
 */
export type UnreadableSink = (rel: string, code: string) => void;

function isUnreadable(err: unknown): string | null {
  const code = errno(err);
  return code === 'EACCES' || code === 'EPERM' ? code : null;
}

/**
 * List everything below `rel`, depth-first, pre-order. Symlinks are reported and
 * never followed. Entries that vanish while the walk runs are left out. Exceeding
 * a limit throws (LIMIT) rather than truncating, so a caller can never mistake a
 * cut-off listing for the whole tree. With `onUnreadable`, a directory below `rel`
 * that cannot be listed or entered, and an entry that cannot be stat'ed, go to it
 * and the walk goes on; `rel` itself unreadable still throws.
 */
export function walk(
  anchor: WorkspaceAnchor,
  rel: string,
  limits: WalkLimits = DEFAULT_LIMITS,
  watch?: { readonly dev: number; readonly ino: number },
  onUnreadable?: UnreadableSink,
): WalkResult {
  const entries: WalkEntry[] = [];
  const mountBoundaries: string[] = [];
  const watchedAt: string[] = [];
  let files = 0, dirs = 0, symlinks = 0, others = 0, bytes = 0;
  const root = walkDir(anchor, splitRel(rel));
  const rootMount = mountKey(root.fd);
  const isWatched = (fd: number): boolean => {
    if (watch === undefined) return false;
    const st = fstatSync(fd);
    return st.dev === watch.dev && st.ino === watch.ino;
  };
  if (isWatched(root.fd)) watchedAt.push('');
  const visit = (dir: DirHandle, prefix: string, prefixExact: boolean, depth: number): void => {
    let names: Buffer[];
    try {
      names = readNames(dir);
    } catch (err) {
      const code = isUnreadable(err);
      if (code === null || onUnreadable === undefined || prefix === '') throw err;
      onUnreadable(prefix, code);
      return;
    }
    for (const name of names) {
      const { text, exact } = decode(name);
      const childRel = prefix === '' ? text : `${prefix}/${text}`;
      let st: Stats | null;
      try {
        st = lstatOrNull(dir, name);
      } catch (err) {
        const code = isUnreadable(err);
        if (code === null || onUnreadable === undefined) throw err;
        onUnreadable(childRel, code);
        continue;
      }
      if (st === null) continue;
      const childExact = prefixExact && exact;
      const type = classify(st);
      entries.push({ rel: childRel, exactName: childExact, type, size: st.size, mode: st.mode & 0o7777, uid: st.uid, dev: st.dev, ino: st.ino });
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
        let child: DirHandle;
        try {
          child = openChildDir(dir, name);
        } catch (err) {
          // Removed or swapped since the lstat: leave it out, never follow.
          if (errno(err) === 'ENOENT' || err instanceof WorkspaceAccessError) continue;
          const code = isUnreadable(err);
          if (code !== null && onUnreadable !== undefined) { onUnreadable(childRel, code); continue; }
          throw err;
        }
        try {
          if (mountKey(child.fd) !== rootMount) {
            mountBoundaries.push(childRel);
            continue;
          }
          if (isWatched(child.fd)) watchedAt.push(childRel);
          visit(child, childRel, childExact, depth + 1);
        } finally {
          closeSync(child.fd);
        }
      }
    }
  };
  try {
    visit(root, '', true, 0);
  } finally {
    closeDir(root, anchor);
  }
  return { entries, files, dirs, symlinks, others, bytes, mountBoundaries, watchedAt };
}

export interface CopyCount {
  readonly files: number;
  readonly dirs: number;
  readonly bytes: number;
  /** Symlinks, FIFOs, sockets, devices, names that are not UTF-8, entries gone since the walk: counted, never copied. */
  readonly skipped: string[];
}

/** Receives one regular file of a copy-out; `fd` is open for reading and closed after. */
export type CopyOutSink = (rel: string, fd: number, size: number) => void;

/** One regular file of a copy-out: `fd` is open for reading while the consumer holds it. */
interface CopyOutFile {
  readonly rel: string;
  readonly fd: number;
  readonly size: number;
}

/**
 * The walk behind `copyOut` and `copyOutAsync`: yields each regular file below `rel` with its fd
 * open, and closes the fd when the consumer moves on (or throws). Returns the count.
 */
function* copyOutFiles(
  anchor: WorkspaceAnchor,
  rel: string,
  limits: WalkLimits,
  refuse: { readonly dev: number; readonly ino: number } | undefined,
  onUnreadable: UnreadableSink | undefined,
): Generator<CopyOutFile, CopyCount, void> {
  const listing = walk(anchor, rel, limits, refuse, onUnreadable);
  if (listing.mountBoundaries.length > 0) {
    throw new WorkspaceAccessError('MOUNT', `mount boundary below ${JSON.stringify(rel)}: ${listing.mountBoundaries.join(', ')}`);
  }
  if (listing.watchedAt.length > 0) {
    throw new WorkspaceAccessError('OVERLAP', `the data directory is inside ${JSON.stringify(rel)} (at ${listing.watchedAt.map(p => p === '' ? '.' : p).join(', ')}), e.g. through a bind mount`);
  }
  const base = splitRel(rel);
  const skipped: string[] = [];
  let files = 0, dirs = 0, bytes = 0;
  for (const e of listing.entries) {
    if (e.type === 'dir') { dirs++; continue; }
    if (e.type !== 'file' || !e.exactName) { skipped.push(e.rel); continue; }
    let fd: number;
    try {
      fd = openRead(anchor, [...base, e.rel].join('/'));
    } catch (err) {
      // Swapped for a link, a FIFO or a socket since the walk, or removed: skip it, never follow.
      if (errno(err) === 'ENOENT' || (err instanceof WorkspaceAccessError && (err.code === 'SYMLINK' || err.code === 'NOT_FILE' || err.code === 'NOT_DIR'))) {
        skipped.push(e.rel);
        continue;
      }
      const code = isUnreadable(err);
      if (code !== null && onUnreadable !== undefined) { onUnreadable(e.rel, code); continue; }
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      yield { rel: e.rel, fd, size };
      files++;
      bytes += size;
    } finally {
      closeSync(fd);
    }
  }
  return { files, dirs, bytes, skipped };
}

const NOTHING: CopyCount = { files: 0, dirs: 0, bytes: 0, skipped: [] };

/** Drive the generator to its end, handing each file to `take`; a throwing `take` closes the open fd. */
function drain(gen: Generator<CopyOutFile, CopyCount, void>, take: (f: CopyOutFile) => void): CopyCount {
  // run-group-starter: a synchronous loop that ends with the walk, or with a throw from the walk or the sink, inside its caller's call; it reports no spend.
  for (;;) {
    const step = gen.next();
    if (step.done === true) return step.value;
    try {
      take(step.value);
    } catch (err) {
      gen.return(NOTHING);
      throw err;
    }
  }
}

/**
 * Copy every regular file below `rel` out of the workspace. The sink decides
 * where it goes (a directory outside the workspace, an archive, export chunks).
 * Mount boundaries are refused before anything is copied. A file that cannot be
 * read (EACCES) fails the copy: a backup must not be silently incomplete. Only a
 * caller that names what it was not given (the export) passes `onUnreadable`;
 * the copy then hands such an entry to it and goes on.
 */
export function copyOut(
  anchor: WorkspaceAnchor,
  rel: string,
  sink: CopyOutSink,
  limits: WalkLimits = DEFAULT_LIMITS,
  /** A directory that must not be inside (the data directory): copying it would copy it into itself. */
  refuse?: { readonly dev: number; readonly ino: number },
  onUnreadable?: UnreadableSink,
): CopyCount {
  return drain(copyOutFiles(anchor, rel, limits, refuse, onUnreadable), f => sink(f.rel, f.fd, f.size));
}

/**
 * As `copyOut`, with a sink that may await: for a copy large enough that holding the event loop
 * for all of it would stall every other request (the export). The walk itself still runs in one
 * go before the first file.
 */
export async function copyOutAsync(
  anchor: WorkspaceAnchor,
  rel: string,
  sink: (rel: string, fd: number, size: number) => Promise<void>,
  refuse?: { readonly dev: number; readonly ino: number },
  onUnreadable?: UnreadableSink,
): Promise<CopyCount> {
  const gen = copyOutFiles(anchor, rel, DEFAULT_LIMITS, refuse, onUnreadable);
  // run-group-starter: awaited by its caller and ends with the walk, or with a throw from the walk or the sink; it reports no spend.
  for (;;) {
    const step = gen.next();
    if (step.done === true) return step.value;
    try {
      await sink(step.value.rel, step.value.fd, step.value.size);
    } catch (err) {
      // Closes the open fd through the generator's `finally`, then rethrows.
      gen.return(NOTHING);
      throw err;
    }
  }
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
  /**
   * Rename every staged file over its target. If one rename fails, the temps not
   * yet renamed are removed and PARTIAL is thrown, naming how far it got.
   */
  commit(): void;
  /** Remove every staged file; the targets stay as they were. Directories made in phase 1 stay. */
  abort(): void;
}

interface Staged {
  readonly key: string;
  readonly dirParts: string[];
  readonly leaf: Buffer;
  readonly tmp: Buffer;
}

/**
 * Remove temp files of the stage pattern below `rel` — what a crashed write or
 * restore left behind. Only regular files and links with exactly that name shape
 * are removed. Call it before a restore, never while another stageIn on the same
 * tree is open (it would remove that one's temps).
 */
export function removeStaleStages(anchor: WorkspaceAnchor, rel: string): number {
  if (statEntry(anchor, rel)?.type !== 'dir') return 0;
  const base = splitRel(rel);
  let removed = 0;
  for (const e of walk(anchor, rel).entries) {
    if (e.type === 'dir' || !e.exactName) continue;
    const name = e.rel.slice(e.rel.lastIndexOf('/') + 1);
    if (!STAGE_NAME.test(name)) continue;
    try {
      unlinkAt(anchor, [...base, e.rel].join('/'));
      removed++;
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw err;
    }
  }
  return removed;
}

/**
 * Write files into the workspace below `rel` in two phases, so a restore can
 * stage everything (databases, config, workspace) and only then swap.
 *
 * Phase 1 (this call): each entry is written to a temp with a random name beside
 * its target (O_EXCL|O_NOFOLLOW, fchmod, fsync). A target of the wrong kind (a
 * directory where a file goes), a symlink on the way, the same path twice, or a
 * path that is both a file and a directory of another entry fails here, and
 * everything staged so far is removed. `commit()` renames the temps over the
 * targets; nothing is ever deleted, so this overlays. A symlink at a target is
 * replaced by the rename, never written through.
 */
export function stageIn(anchor: WorkspaceAnchor, rel: string, source: Iterable<StageEntry>, opts: StageOptions): StagedWrite {
  const base = splitRel(rel);
  const staged: Staged[] = [];
  const fileKeys = new Set<string>();
  const dirKeys = new Set<string>();
  let bytes = 0;
  const removeTemps = (from: number): void => {
    for (const s of staged.slice(from)) {
      try {
        const dir = walkDir(anchor, s.dirParts);
        try { unlinkSync(at(dir, s.tmp)); } finally { closeDir(dir, anchor); }
      } catch { /* already gone */ }
    }
  };
  try {
    for (const entry of source) {
      const parts = [...base, ...splitRel(entry.rel)];
      const leafText = parts.pop();
      if (leafText === undefined) throw new WorkspaceAccessError('BAD_PATH', 'a staged file needs a path');
      const key = [...parts, leafText].join('/');
      if (fileKeys.has(key)) throw new WorkspaceAccessError('BAD_PATH', `${key} staged twice`);
      if (dirKeys.has(key)) throw new WorkspaceAccessError('BAD_PATH', `${key} is staged as a file and as a directory`);
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (fileKeys.has(prefix)) throw new WorkspaceAccessError('BAD_PATH', `${prefix} is staged as a file and as a directory`);
        dirKeys.add(prefix);
      }
      fileKeys.add(key);
      const leaf = Buffer.from(leafText, 'utf8');
      const dir = walkDir(anchor, parts, { dirMode: opts.dirMode });
      try {
        assertNotDir(dir, leaf);
        const written = writeTemp(dir, opts.fileMode, entry.data);
        staged.push({ key, dirParts: parts, leaf, tmp: written.tmp });
        bytes += written.bytes;
      } finally {
        closeDir(dir, anchor);
      }
    }
  } catch (err) {
    removeTemps(0);
    throw err;
  }
  let settled = false;
  return {
    files: staged.length,
    bytes,
    commit(): void {
      if (settled) throw new Error('staged write already committed or aborted');
      settled = true;
      for (let i = 0; i < staged.length; i++) {
        const s = staged[i] as Staged;
        try {
          const dir = walkDir(anchor, s.dirParts);
          try {
            assertNotDir(dir, s.leaf);
            renameSync(at(dir, s.tmp), at(dir, s.leaf));
          } finally {
            closeDir(dir, anchor);
          }
        } catch (err) {
          removeTemps(i);
          const cause = err instanceof Error ? err.message : String(err);
          throw new WorkspaceAccessError('PARTIAL', `committed ${i} of ${staged.length}; ${s.key} failed (${cause}); the rest was not written`);
        }
      }
    },
    abort(): void {
      if (settled) return;
      settled = true;
      removeTemps(0);
    },
  };
}

export interface EmptyResult {
  readonly removed: number;
}

/** How deep emptyDir descends. Deeper trees are refused (LIMIT) before anything is deleted. */
export const EMPTY_MAX_DEPTH = 4096;

/**
 * Remove everything below `rel`; `rel` itself stays. `rel` is opened once and
 * everything — the mount check, the removal, the final count — runs from that
 * held directory, so renaming `rel` meanwhile changes nothing. Bottom-up, never
 * following a link, names as raw bytes. Refuses before deleting anything when a
 * mount boundary is below or the tree is deeper than `maxDepth`. After the
 * pass it lists again and THROWS (REMAINDER) if anything is left — a caller that
 * promises erasure must not report success otherwise.
 */
export function emptyDir(anchor: WorkspaceAnchor, rel: string, maxDepth = EMPTY_MAX_DEPTH): EmptyResult {
  const top = walkDir(anchor, splitRel(rel));
  try {
    const topMount = mountKey(top.fd);
    const boundaries: string[] = [];
    // Pass 1: nothing is deleted until the whole tree is known to sit on one mount.
    const scan = (dir: DirHandle, depth: number): void => {
      let names: Buffer[];
      try { names = readNames(dir); } catch { return; } // unreadable: pass 2 cannot empty it either; the count says so
      for (const name of names) {
        const st = lstatOrNull(dir, name);
        if (st === null || !st.isDirectory()) continue;
        if (depth + 1 > maxDepth) throw new WorkspaceAccessError('LIMIT', `deeper than ${maxDepth} below ${JSON.stringify(rel)}`);
        let child: DirHandle;
        try { child = openChildDir(dir, name); } catch { continue; }
        try {
          if (mountKey(child.fd) !== topMount) boundaries.push(show(child));
          else scan(child, depth + 1);
        } finally {
          closeSync(child.fd);
        }
      }
    };
    scan(top, 0);
    if (boundaries.length > 0) {
      throw new WorkspaceAccessError('MOUNT', `mount boundary below ${JSON.stringify(rel)}: ${boundaries.join(', ')}`);
    }
    // Pass 2: post-order removal. Every failure is left to the final count.
    let removed = 0;
    const clear = (dir: DirHandle): void => {
      let names: Buffer[];
      try { names = readNames(dir); } catch { return; }
      for (const name of names) {
        const st = lstatOrNull(dir, name);
        if (st === null) continue;
        if (st.isDirectory()) {
          let child: DirHandle | null = null;
          try { child = openChildDir(dir, name); } catch { /* swapped: unlink below handles a link */ }
          if (child !== null) {
            try {
              if (mountKey(child.fd) === topMount) clear(child);
            } finally {
              closeSync(child.fd);
            }
          }
          try { rmdirSync(at(dir, name)); removed++; continue; } catch { /* not empty, or not a dir any more */ }
        }
        try { unlinkSync(at(dir, name)); removed++; } catch { /* the final count decides */ }
      }
    };
    clear(top);
    const remaining = readNames(top);
    if (remaining.length > 0) {
      const shown = remaining.slice(0, 10).map((n) => decode(n).text).join(', ');
      throw new WorkspaceAccessError('REMAINDER', `${remaining.length} entries remain below ${JSON.stringify(rel)} after emptying: ${shown}`);
    }
    return { removed };
  } finally {
    closeDir(top, anchor);
  }
}
