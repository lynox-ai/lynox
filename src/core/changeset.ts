import {
  mkdtempSync, writeFileSync, existsSync, unlinkSync, rmdirSync, rmSync, realpathSync,
  openSync, closeSync, writeSync, constants, fstatSync, ftruncateSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { isPathWithin, getWorkspaceCwd, writeRootsBesidesWorkspace } from './workspace.js';
import { processUmask, toWorkspaceRel, workspaceBase } from './workspace-rel.js';
import {
  FILE_TOOL_READ_CAP_BYTES, isReadLimit, openRead, openWrite, readFdCapped, rmdirAt, statEntry, unlinkAt,
  WorkspaceAccessError, type WorkspaceAnchor,
} from './workspace-fd.js';

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Whether nothing is at `p`, not even a link. Anything else, an error included, counts as there. */
function isMissing(p: string): boolean {
  try {
    lstatSync(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** The context workspace's open directory, or null without isolation or when it cannot be reached. */
function heldBase(): ReturnType<typeof workspaceBase> {
  try {
    return workspaceBase();
  } catch {
    return null;
  }
}

/** A tracked file over {@link FILE_TOOL_READ_CAP_BYTES}, with its size: its bytes are not read.
 *  The size is null when it could not be read once the file was found over the cap. */
type OverCap = { overCap: number | null };

/** A size as the review shows it: bytes below 1 MB, MB to one decimal above. `up` rounds up,
 *  so a file one byte over the cap does not read as the cap itself. */
const shownSize = (bytes: number, up = false): string => {
  if (bytes < 1024 * 1024) return `${bytes} bytes`;
  const tenths = (bytes / (1024 * 1024)) * 10;
  return `${(up ? Math.ceil(tenths) : Math.round(tenths)) / 10} MB`;
};

/** The review's line for a file over the cap, in place of a diff: what is known, and what the
 *  person deciding without the content can do. `before` is null for a file the run added,
 *  undefined when the original could not be read (then nothing was saved to restore). */
function notComparedNote(before: number | null | undefined, now: number | null): string {
  const was = before === null
    ? 'It did not exist before the run. Look at the file yourself before you keep it; Rollback removes it unless it was changed or replaced after the run wrote it.'
    : before === undefined
      ? 'Its size before the run is not known. Look at the file yourself before you keep the change; Rollback cannot restore it, because the original could not be read.'
      : `Before the run it was ${shownSize(before)}. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.`;
  const size = now === null ? 'now larger than' : `${shownSize(now, true)} now, larger than`;
  return `(Content not compared: the file is ${size} the ${shownSize(FILE_TOOL_READ_CAP_BYTES)} the review reads. ${was})`;
}
/** The most of a diff the review shows (Node's default `maxBuffer`, now named), and how long
 *  `diff` may take. A diff stopped by either is shown cut, with {@link DIFF_CUT_NOTE}. */
const DIFF_MAX_BYTES = 1024 * 1024;
const DIFF_TIMEOUT_MS = 5000;
const DIFF_CUT_NOTE = `(Diff cut: only its start is shown, as it is longer than ${shownSize(DIFF_MAX_BYTES)} or took longer than ${DIFF_TIMEOUT_MS / 1000} seconds. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.)`;
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChangesetEntry, ChangesetDiff } from '../types/index.js';

export class ChangesetManager {
  private entries: Map<string, ChangesetEntry> = new Map();
  /** The pre-run bytes of each `modified` entry. Held here, not read back from the backup
   *  copy: that copy can be a symlink to the live file, or shared with another manager. */
  private originalBytes: Map<string, Buffer> = new Map();
  /** The tracked files in the context workspace (isolation), each with the workspace it was
   *  backed up in: reached only through that workspace's open directory, one component at a
   *  time without following a link, never by name. */
  private anchored: Map<string, string> = new Map();
  /** What each `added` file was when the run last wrote it: its inode and a hash of its bytes.
   *  A rollback deletes an added file only while it is still that file. Another writer can have
   *  put a different file under the name since (`bash`, or the user), and that one is the
   *  user's: deleting it was the loss this guards against. No record, no delete. */
  private written: Map<string, { dev: number; ino: number; hash: string }> = new Map();
  /** Created by the first backup, not by the constructor: a run that writes nothing leaves
   *  no directory behind. `cleanup()` sets it back to null, so a backup after it makes a new
   *  private (0700) directory instead of re-creating the removed path with default modes. */
  private backupDir: string | null = null;
  /** Whether the last {@link backupBeforeWrite} refused because the file is too large to save,
   *  so the caller's refusal can say so and name the way out. */
  refusedTooLarge = false;

  /** `runId` names the session run this manager belongs to (one per user run, not the HTTP
   *  run registry's id). The review shows it and its answer carries it back, so an answer to
   *  one run's review never reaches the next run's files. */
  constructor(private readonly cwd: string, readonly runId: string, otherRoots: readonly string[] = []) {
    const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
    this.realCwd = real(cwd);
    this.roots = [this.realCwd, ...otherRoots.map(real)];
  }

  /** `cwd` with symlinks resolved: the workspace, which names in the review are relative to. */
  private readonly realCwd: string;
  /** Every directory a tracked file may be inside: the workspace and the other roots a write
   *  tool may reach (`writeRootsBesidesWorkspace`), symlinks resolved. */
  private readonly roots: readonly string[];

  /**
   * The real path of `filePath` if it lies inside one of the roots, else null. Symlinks
   * are resolved on the file, or on its closest existing ancestor when the file does not
   * exist yet. The manager tracks, reads, copies, restores and deletes only paths this
   * returns, and checks again right before each of those: the path it is handed comes from
   * the model and has not been through the write tool's own check yet, and a directory on
   * the way can change between the backup and the rollback.
   */
  private _confine(filePath: string): string | null {
    const abs = resolve(filePath);
    let ancestor = abs;
    let tail = '';
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      tail = tail === '' ? basename(ancestor) : join(basename(ancestor), tail);
      ancestor = parent;
    }
    let real: string;
    try {
      real = tail === '' ? realpathSync(ancestor) : join(realpathSync(ancestor), tail);
    } catch {
      return null;
    }
    // A root itself is a directory, never a tracked file: reading it fails, and nothing is shown or restored.
    return this.roots.some((root) => isPathWithin(real, root)) ? real : null;
  }

  /**
   * Where a write to `filePath` is tracked. With isolation, a path in the context workspace is
   * tracked through its open directory, keyed by its path under the workspace's real path (the
   * key the review shows and a rollback names). A path in another root is tracked by its
   * confined real path, as without isolation, unless it reaches the workspace through a link:
   * that one is not tracked by name. Null when it is not tracked.
   */
  private _locate(filePath: string): { abs: string; ws: string | null } | null | 'unreachable' {
    let base: ReturnType<typeof workspaceBase>;
    try {
      base = workspaceBase();
    } catch {
      // Isolation is on and its directory cannot be reached: nothing is tracked by name instead,
      // and the caller learns it, so the write does not go ahead unsaved.
      return 'unreachable';
    }
    if (base !== null) {
      let mapped;
      try {
        mapped = toWorkspaceRel(filePath, base.ws);
      } catch {
        return null;
      }
      if (mapped.kind === 'inside') return mapped.rel === '' ? null : { abs: resolve(realOr(base.ws), mapped.rel), ws: base.ws };
    }
    const abs = this._confine(filePath);
    if (abs === null) return null;
    // With isolation, neither the context workspace nor the one this manager was made for is
    // reached by name, also not by a path that leads there through a link.
    if (base !== null && [resolve(base.ws), realOr(base.ws), this.realCwd].some((d) => isPathWithin(abs, d))) return null;
    return { abs, ws: null };
  }

  /**
   * The open directory and the path in it of a file tracked through it, while its key still
   * names a file in the CURRENT context workspace, and that is the workspace it was backed up
   * in. A run whose workspace changed since the backup reaches nothing, also when the new
   * workspace holds the old one.
   */
  private _at(abs: string): { anchor: WorkspaceAnchor; rel: string } | null {
    const base = heldBase();
    if (base === null || base.ws !== this.anchored.get(abs)) return null;
    let mapped;
    try {
      mapped = toWorkspaceRel(abs, base.ws);
    } catch {
      return null;
    }
    return mapped.kind === 'inside' && mapped.rel !== '' ? { anchor: base.anchor, rel: mapped.rel } : null;
  }

  /**
   * Whether a file in the workspace is there, reached through the open directory. Null when a
   * link is on the way or at the file: such a path is not tracked, as a path out of the
   * workspace is not, so a later backup of the same path once it is a real file records it.
   * Anything else but a missing name counts as there, so a rollback never deletes a file it
   * could not see.
   */
  private _presentAnchored(abs: string): boolean | null {
    const at = this._at(abs);
    if (at === null) return null;
    try {
      const st = statEntry(at.anchor, at.rel);
      return st === null ? false : st.type === 'symlink' ? null : true;
    } catch (err) {
      if (err instanceof WorkspaceAccessError && (err.code === 'SYMLINK' || err.code === 'NOT_DIR')) return null;
      return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  /** The bytes of a tracked file, read only while it is still inside a root and
   *  not through a symlink at the file itself. Null when it is neither, or unreadable.
   *  A file over {@link FILE_TOOL_READ_CAP_BYTES} is not read whole: only its size is
   *  returned. Another writer can put a file of any size under a tracked path. */
  private _readTracked(abs: string): Buffer | OverCap | null {
    return this._withTracked(abs, (fd) => {
      // The size first, so a file known to be over the cap is not read at all.
      const size = fstatSync(fd).size;
      if (size > FILE_TOOL_READ_CAP_BYTES) return { overCap: size };
      try {
        return readFdCapped(fd, FILE_TOOL_READ_CAP_BYTES, abs);
      } catch (err) {
        if (!isReadLimit(err)) throw err;
        // Grown past the cap since the fstat. A size that cannot be read now leaves it unknown:
        // the file is still shown as changed, never left out of the review as if it were gone.
        try {
          return { overCap: fstatSync(fd).size };
        } catch {
          return { overCap: null };
        }
      }
    });
  }

  /** Which file a tracked path names now: its inode and a hash of its bytes, read as
   *  {@link _readTracked} reads them. A file over the cap is not read: it is known by its size
   *  and its ctime instead, which every write changes and no caller can set back. So the run's
   *  own large file is still rolled back, and one changed or put there since is not. A kernel
   *  with coarse timestamps can leave ctime as it was for a write in the same tick; multigrain
   *  timestamps (Linux 6.13 on, for the filesystems that use them) do not, after the fstat here.
   *  Null when a file grows past the cap while it is read: never taken for the run's own. */
  private _identityOf(abs: string): { dev: number; ino: number; hash: string } | null {
    return this._withTracked(abs, (fd) => {
      const st = fstatSync(fd, { bigint: true });
      const id = { dev: Number(st.dev), ino: Number(st.ino) };
      if (st.size > BigInt(FILE_TOOL_READ_CAP_BYTES)) return { ...id, hash: `over-cap:${st.size}:${st.ctimeNs}` };
      const bytes = readFdCapped(fd, FILE_TOOL_READ_CAP_BYTES, abs);
      return { ...id, hash: createHash('sha256').update(bytes).digest('hex') };
    });
  }

  /** `use` on the open file a tracked path names, or null when it cannot be opened as one. */
  private _withTracked<T>(abs: string, use: (fd: number) => T): T | null {
    if (this.anchored.has(abs)) {
      const at = this._at(abs);
      if (at === null) return null;
      let fd: number;
      try {
        fd = openRead(at.anchor, at.rel);
      } catch {
        return null;
      }
      try {
        // A file with a second name may be a file outside the workspace: not read, as the file tools do not.
        if (fstatSync(fd).nlink > 1) return null;
        return use(fd);
      } catch {
        return null;
      } finally {
        closeSync(fd);
      }
    }
    if (this._confine(abs) !== abs) return null;
    let fd: number;
    try {
      // O_NONBLOCK: a FIFO at the file must not hold the process until a writer comes.
      fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      if (!fstatSync(fd).isFile()) return null;
      return use(fd);
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** One flat file per tracked path, named by its hash. Never a path relative to `cwd`: a
   *  file outside `cwd` would give `../…` and land outside the directory `cleanup()` removes. */
  private _backupPathOf(abs: string): string | null {
    if (this.backupDir === null) return null;
    return join(this.backupDir, createHash('sha256').update(abs).digest('hex').slice(0, 32));
  }

  /**
   * Called BEFORE writing a file. Backs up the original content.
   * If the file has already been backed up (second write), this is a no-op —
   * we only need the original pre-run content.
   *
   * False when isolation is on and its directory cannot be reached: nothing could be saved,
   * and the caller does not write. A write that went ahead would be in neither the review
   * nor the rollback, and nothing would say it is missing. False also for a file over
   * {@link FILE_TOOL_READ_CAP_BYTES}, which is not read whole and so cannot be saved; then
   * {@link refusedTooLarge} is true. True otherwise, also for a path this review does not track.
   */
  backupBeforeWrite(filePath: string): boolean {
    this.refusedTooLarge = false;
    // Outside the workspace: not tracked. The write tool refuses such a path; if it is
    // allowed elsewhere (`/tmp`), it is not this review's to show or roll back.
    const loc = this._locate(filePath);
    if (loc === 'unreachable') return false;
    if (loc === null) return true;
    const abs = loc.abs;
    if (this.entries.has(abs)) return true; // Already backed up — first write wins
    if (loc.ws !== null) this.anchored.set(abs, loc.ws);
    const present = loc.ws !== null ? this._presentAnchored(abs) : existsSync(abs);
    if (present === null) {
      // Not tracked: no key is left marked as reached through a workspace, so a later backup of
      // the same path by name (isolation turned off within the run) is read and restored by name.
      this.anchored.delete(abs);
      return true;
    }

    let originalContent: string | null = null;
    let status: 'added' | 'modified' = 'added';

    if (present) {
      // The file exists, so it is `modified` whatever fails below. Treating it as `added`
      // would make "Rollback all" delete a file the user had before the run.
      status = 'modified';
      const read = { tooLarge: false };
      try {
        // Read only up to the file tools' cap: a file of any size must not be read whole
        // because a write names it.
        const bytes = this._withTracked(abs, (fd) => {
          try {
            return readFdCapped(fd, FILE_TOOL_READ_CAP_BYTES, abs);
          } catch (err) {
            read.tooLarge = isReadLimit(err);
            throw err;
          }
        });
        if (bytes === null) throw new Error('unreadable');
        originalContent = bytes.toString('utf-8');
        // Held before the copy: a failed copy still leaves the bytes rollback restores.
        this.originalBytes.set(abs, bytes);
        this.backupDir ??= mkdtempSync(join(tmpdir(), 'lynox-changeset-'));
        // The held bytes, not a copy of the path: copying the path would copy a symlink as one.
        writeFileSync(this._backupPathOf(abs)!, bytes, { mode: 0o600, flag: 'wx' });
      } catch {
        // Unreadable: rollback cannot restore it and leaves it alone (no original content).
        // Copy failed: rollback restores the held bytes; the diff is unavailable.
      }
      if (read.tooLarge) {
        // Too large to save: the write is refused, as for an unreachable workspace. Going ahead
        // would change a file the rollback cannot restore. Nothing of it is kept.
        this.anchored.delete(abs);
        this.refusedTooLarge = true;
        return false;
      }
    }

    this.entries.set(abs, { filePath: abs, originalContent, status });
    return true;
  }

  /**
   * Called AFTER a write to a tracked path succeeded: remembers which file the run left there,
   * so a rollback of an `added` entry deletes that file and no other.
   */
  recordWritten(filePath: string): void {
    const loc = this._locate(filePath);
    if (loc === null || loc === 'unreachable') return;
    const entry = this.entries.get(loc.abs);
    if (entry?.status !== 'added') return;
    const id = this._identityOf(loc.abs);
    if (id === null) this.written.delete(loc.abs);
    else this.written.set(loc.abs, id);
  }

  /** Whether an `added` path still names the file the run last wrote there. */
  private _isRunsOwn(abs: string): boolean {
    const rec = this.written.get(abs);
    if (rec === undefined) return false;
    const now = this._identityOf(abs);
    return now !== null && now.dev === rec.dev && now.ino === rec.ino && now.hash === rec.hash;
  }

  /**
   * The tracked files that differ from their pre-run state, with their current content.
   * The backup is taken before the write tool runs, so a write that failed or wrote the
   * same text leaves an entry behind. Such a file is unchanged and not reported: an
   * empty entry would open a review with nothing in it, and the review holds the next
   * message until it is answered. `getChanges`, `hasChanges` and `size` all read this.
   *
   * "Same" is decided on the bytes read before the run, never on decoded text: a file with
   * bytes that are not valid UTF-8 decodes to the same string after a write that changed
   * them, and that write must still be reviewed. A file over the cap is never "same": its
   * bytes were not read, so it is reported, with its size instead of its content.
   */
  private _changed(): Array<[string, ChangesetEntry, Buffer | OverCap]> {
    const changed: Array<[string, ChangesetEntry, Buffer | OverCap]> = [];
    for (const [abs, entry] of this.entries) {
      // Deleted during the run, unreadable, or no longer inside the workspace — not reported
      const current = this._readTracked(abs);
      if (current === null) continue;
      if (entry.status === 'modified' && Buffer.isBuffer(current) && this.originalBytes.get(abs)?.equals(current)) continue;
      changed.push([abs, entry, current]);
    }
    return changed;
  }

  /** Every tracked file by the name the review shows it under, changed now or not. A file replaced
   *  by a link since the review is no longer among {@link getChanges}, but an answer to that review
   *  still names it, and a rollback that leaves it has to name it back. */
  reviewNames(): Map<string, string> {
    return new Map([...this.entries.keys()].map((abs) => [relative(this.realCwd, abs), abs]));
  }

  /**
   * Produce unified diffs for all changed files.
   */
  getChanges(): ChangesetDiff[] {
    const diffs: ChangesetDiff[] = [];

    for (const [abs, entry, current] of this._changed()) {
      const rel = relative(this.realCwd, abs);

      let diffText: string;
      // False when the review shows a note instead of a diff: no line count says anything then.
      let compared = Buffer.isBuffer(current);
      if (!Buffer.isBuffer(current)) {
        // Over the cap: shown as changed, with both sizes, and its content not compared.
        const before = entry.status === 'added' ? null : this.originalBytes.get(abs)?.length;
        diffText = `--- ${entry.status === 'added' ? '/dev/null' : `a/${rel}`}\n+++ b/${rel}\n${notComparedNote(before, current.overCap)}`;
      } else if (entry.status === 'added') {
        const currentContent = current.toString('utf-8');
        // New file: show all lines as additions
        const lines = currentContent.split('\n');
        const header = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
        diffText = header + lines.map(l => `+${l}`).join('\n');
      } else {
        // Modified file: system diff -u between the backup and the bytes just read, written
        // to a file of our own. `diff` given the tracked path would open it by name again.
        const backupPath = this._backupPathOf(abs);
        const currentPath = backupPath === null ? null : `${backupPath}.current`;
        let cut = false;
        try {
          if (backupPath === null || currentPath === null || !existsSync(backupPath)) throw new Error('no backup copy');
          // The bytes, as the backup holds bytes: decoded text would turn every line that is
          // not UTF-8 into a change.
          writeFileSync(currentPath, current, { mode: 0o600 });
          diffText = execFileSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, backupPath, currentPath], {
            encoding: 'utf-8',
            timeout: DIFF_TIMEOUT_MS,
            maxBuffer: DIFF_MAX_BYTES,
          });
        } catch (err: unknown) {
          const e = (err && typeof err === 'object' ? err : {}) as { stdout?: unknown; status?: unknown; code?: unknown };
          const out = typeof e.stdout === 'string' ? e.stdout : '';
          if (e.status === 1 && e.code === undefined) {
            // diff exits 1 when the files differ: its output is the whole diff.
            diffText = out !== '' ? out : `--- a/${rel}\n+++ b/${rel}\n(diff unavailable)`;
          } else if ((e.code === 'ENOBUFS' || e.code === 'ETIMEDOUT') && out.includes('\n')) {
            // Stopped part-way, by DIFF_MAX_BYTES or the timeout: what it printed is only the start
            // of the diff, and must not read as the whole. Its last line may be cut mid-line, and
            // would show as a change of its own, so it is dropped.
            diffText = `${out.slice(0, out.lastIndexOf('\n') + 1)}${DIFF_CUT_NOTE}`;
            cut = true;
          } else {
            // Fallback: basic header, for a diff that printed nothing, failed to start, or stopped
            // for any other reason (a signal, exit 2): its output is not known to be the start.
            diffText = `--- a/${rel}\n+++ b/${rel}\n(diff unavailable)`;
          }
        } finally {
          if (currentPath !== null) rmSync(currentPath, { force: true });
        }
        // A diff without a hunk shows no changed line: binary files ("Binary files … differ"), or a
        // diff that failed or printed nothing. Its +0 -0 would read as unchanged. A cut diff's
        // counts are those of its start only.
        compared = /^@@ /m.test(diffText) && !cut;
      }

      diffs.push({
        file: rel,
        absolutePath: abs,
        status: entry.status,
        diff: diffText,
        compared,
        originalContent: entry.originalContent,
      });
    }

    return diffs;
  }

  /**
   * Restore ALL files to their pre-run state. Returns the files it left as they are: the
   * caller names them, so a rollback that skipped one does not read as done.
   */
  rollbackAll(): string[] {
    const notRestored: string[] = [];
    for (const [abs, entry] of this.entries) {
      if (!this._rollbackOne(abs, entry)) notRestored.push(abs);
    }
    return notRestored;
  }

  /**
   * Restore specific files (by absolute path) to pre-run state. Returns those it left as they
   * are, as {@link rollbackAll} does.
   */
  rollbackFiles(files: string[]): string[] {
    const notRestored: string[] = [];
    for (const file of files) {
      const abs = resolve(file);
      const entry = this.entries.get(abs);
      if (entry) {
        if (!this._rollbackOne(abs, entry)) notRestored.push(abs);
      }
    }
    return notRestored;
  }

  /**
   * Accept all changes — no-op on files, just cleans up.
   */
  acceptAll(): void {
    this.cleanup();
  }

  /**
   * The changeset is over: the review was answered, or its run is gone. The backup
   * directory is removed and the tracked files are forgotten, so a second answer to the
   * same review (another tab, a reload) finds nothing to roll back instead of resetting
   * changes the first answer accepted.
   */
  cleanup(): void {
    this.entries.clear();
    this.originalBytes.clear();
    this.anchored.clear();
    this.written.clear();
    if (this.backupDir === null) return;
    try {
      rmSync(this.backupDir, { recursive: true, force: true });
    } catch {
      // Best-effort — OS cleans tmpdir on reboot
    }
    this.backupDir = null;
  }

  /**
   * The end of the run that owns this manager. Called once, after the run stops writing.
   * A tracked file that did not change is dropped here, with its backup copy, so "Rollback
   * all" cannot reset it later, after the user (or another run) changed it. A manager with
   * nothing left removes its directory. One kind of entry stays although the review does
   * not show it: a file the run deleted or made unreadable. It did change, and "Rollback
   * all" restores it.
   *
   * Never in a query: a `GET /changeset` between a backup and its write would drop the
   * entry, and the write that follows would be in neither the review nor the rollback.
   */
  settle(): void {
    const changed = new Set(this._changed().map(([abs]) => abs));
    for (const [abs, entry] of this.entries) {
      if (changed.has(abs)) continue;
      // Kept: a tracked file that is gone or unreadable is not "unchanged".
      if (entry.status === 'modified' && !this._isUnchanged(abs)) continue;
      if (entry.status === 'added' && this._readTracked(abs) !== null) continue;
      const backupPath = this._backupPathOf(abs);
      if (backupPath !== null) rmSync(backupPath, { force: true });
      this.entries.delete(abs);
      this.originalBytes.delete(abs);
      this.anchored.delete(abs);
      this.written.delete(abs);
    }
    if (this.entries.size === 0) this.cleanup();
  }

  private _isUnchanged(abs: string): boolean {
    const before = this.originalBytes.get(abs);
    if (before === undefined) return false;
    const now = this._readTracked(abs);
    return Buffer.isBuffer(now) && now.equals(before);
  }

  /**
   * Whether any tracked file differs from its pre-run state.
   */
  hasChanges(): boolean {
    return this._changed().length > 0;
  }

  /**
   * Whether this manager is active.
   */
  get active(): boolean {
    return true;
  }

  /**
   * Whether the review holds anything: a file backed up for a write, changed or not. A move
   * or rename is refused while it does (`batch_files`): the rollback restores and deletes files
   * by path, and cannot follow a file to where it was moved.
   */
  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /**
   * Number of tracked files that differ from their pre-run state.
   */
  get size(): number {
    return this._changed().length;
  }

  /** Puts one file back as it was before the run. True when it now is: the original written
   *  back, or a file the run added gone. False when the file was left as it is: replaced, linked
   *  or moved out of reach since, not a regular file, or the write failed. */
  private _rollbackOne(abs: string, entry: ChangesetEntry): boolean {
    if (this.anchored.has(abs)) return this._rollbackAnchored(abs, entry);
    // Checked again here: a directory on the way may have become a symlink out of the
    // workspace since the backup. Such a file is left alone.
    if (this._confine(abs) !== abs) return false;
    if (entry.status === 'added') {
      // Another file under the name since the run's last write is left alone. One that is gone
      // is as it was before the run.
      if (!this._isRunsOwn(abs)) return isMissing(abs);
      // New file — delete it (unlink removes a symlink itself, never its target)
      try {
        unlinkSync(abs);
        // Try to remove empty parent dirs up to the root the file is in, never the root itself
        let dir = dirname(abs);
        while (!this.roots.includes(dir) && dir !== dirname(dir)) {
          try {
            rmdirSync(dir);
            dir = dirname(dir);
          } catch {
            break; // Dir not empty
          }
        }
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT';
      }
      return true;
    }
    // Modified file — restore the pre-run bytes; the decoded text loses any that are not UTF-8.
    // Without them (the original could not be read) there is nothing to put back.
    if (entry.originalContent === null) return false;
    let fd: number | undefined;
    try {
      // O_NOFOLLOW: a symlink planted at the file since the backup is not written through.
      // O_NONBLOCK: a FIFO at the file does not hold the process. ftruncate refuses anything
      // but a regular file (EINVAL), so a FIFO or device is never written.
      fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
      ftruncateSync(fd, 0);
      const bytes = this.originalBytes.get(abs) ?? Buffer.from(entry.originalContent, 'utf-8');
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    } catch {
      // Left as it is: a symlink or something other than a regular file at the name, or the
      // write failed. The caller names it.
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return true;
  }

  /** {@link _rollbackOne} through the workspace's open directory: nothing on the way is followed. */
  private _rollbackAnchored(abs: string, entry: ChangesetEntry): boolean {
    const at = this._at(abs);
    if (at === null) return false;
    if (entry.status === 'added') {
      // Another file under the name since the run's last write is left alone. One that is gone
      // is as it was before the run.
      if (!this._isRunsOwn(abs)) return this._presentAnchored(abs) === false;
      try {
        // New file — delete it (unlinkat removes a link itself, never its target)
        unlinkAt(at.anchor, at.rel);
        // Empty parent directories up to the workspace, never the workspace itself
        const parts = at.rel.split('/');
        for (let n = parts.length - 1; n > 0; n--) {
          try {
            rmdirAt(at.anchor, parts.slice(0, n).join('/'));
          } catch {
            break; // Dir not empty
          }
        }
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT';
      }
      return true;
    }
    if (entry.originalContent === null) return false;
    let fd: number | undefined;
    try {
      // In place, as before: the file keeps its inode, owner and mode; one that is gone is made
      // again with the mode a write by name gives it. Its directories are not made again.
      ({ fd } = openWrite(at.anchor, at.rel, { createMode: 0o666 & ~processUmask() }));
      // A file with a second name may be a file outside the workspace: not written.
      if (fstatSync(fd).nlink > 1) return false;
      const bytes = this.originalBytes.get(abs) ?? Buffer.from(entry.originalContent, 'utf-8');
      ftruncateSync(fd, 0);
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
    } catch {
      // Left as it is, as in {@link _rollbackOne}.
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return true;
  }
}

/**
 * The changeset of one session run: the current workspace, plus the other roots a write tool
 * may reach while isolation is active (`/tmp`, the artifacts directory). An artifact edited
 * with `edit_file` is reviewed and can be rolled back like a workspace file; the file tools
 * bypass the artifact store's version ring, so nothing else could undo it.
 */
export function workspaceChangeset(runId: string): ChangesetManager {
  return new ChangesetManager(getWorkspaceCwd(), runId, writeRootsBesidesWorkspace());
}
