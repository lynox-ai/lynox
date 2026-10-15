import {
  mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync, rmSync, realpathSync,
  openSync, closeSync, writeSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { isPathWithin, getWorkspaceCwd, writeRootsBesidesWorkspace } from './workspace.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChangesetEntry, ChangesetDiff } from '../types/index.js';

export class ChangesetManager {
  private entries: Map<string, ChangesetEntry> = new Map();
  /** The pre-run bytes of each `modified` entry. Held here, not read back from the backup
   *  copy: that copy can be a symlink to the live file, or shared with another manager. */
  private originalBytes: Map<string, Buffer> = new Map();
  /** Created by the first backup, not by the constructor: a run that writes nothing leaves
   *  no directory behind. `cleanup()` sets it back to null, so a backup after it makes a new
   *  private (0700) directory instead of re-creating the removed path with default modes. */
  private backupDir: string | null = null;

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
    return this.roots.some((root) => real !== root && isPathWithin(real, root)) ? real : null;
  }

  /** The bytes of a tracked file, read only while it is still inside a root and
   *  not through a symlink at the file itself. Null when it is neither, or unreadable. */
  private _readTracked(abs: string): Buffer | null {
    if (this._confine(abs) !== abs) return null;
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      return readFileSync(fd);
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
   */
  backupBeforeWrite(filePath: string): void {
    // Outside the workspace: not tracked. The write tool refuses such a path; if it is
    // allowed elsewhere (`/tmp`), it is not this review's to show or roll back.
    const abs = this._confine(filePath);
    if (abs === null) return;
    if (this.entries.has(abs)) return; // Already backed up — first write wins

    let originalContent: string | null = null;
    let status: 'added' | 'modified' = 'added';

    if (existsSync(abs)) {
      // The file exists, so it is `modified` whatever fails below. Treating it as `added`
      // would make "Rollback all" delete a file the user had before the run.
      status = 'modified';
      try {
        const bytes = this._readTracked(abs);
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
    }

    this.entries.set(abs, { filePath: abs, originalContent, status });
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
   * them, and that write must still be reviewed.
   */
  private _changed(): Array<[string, ChangesetEntry, string, Buffer]> {
    const changed: Array<[string, ChangesetEntry, string, Buffer]> = [];
    for (const [abs, entry] of this.entries) {
      // Deleted during the run, unreadable, or no longer inside the workspace — not reported
      const currentBytes = this._readTracked(abs);
      if (currentBytes === null) continue;
      if (entry.status === 'modified' && this.originalBytes.get(abs)?.equals(currentBytes)) continue;
      const currentContent = currentBytes.toString('utf-8');
      changed.push([abs, entry, currentContent, currentBytes]);
    }
    return changed;
  }

  /**
   * Produce unified diffs for all changed files.
   */
  getChanges(): ChangesetDiff[] {
    const diffs: ChangesetDiff[] = [];

    for (const [abs, entry, currentContent, currentBytes] of this._changed()) {
      const rel = relative(this.realCwd, abs);

      let diffText: string;
      if (entry.status === 'added') {
        // New file: show all lines as additions
        const lines = currentContent.split('\n');
        const header = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
        diffText = header + lines.map(l => `+${l}`).join('\n');
      } else {
        // Modified file: system diff -u between the backup and the bytes just read, written
        // to a file of our own. `diff` given the tracked path would open it by name again.
        const backupPath = this._backupPathOf(abs);
        const currentPath = backupPath === null ? null : `${backupPath}.current`;
        try {
          if (backupPath === null || currentPath === null || !existsSync(backupPath)) throw new Error('no backup copy');
          // The bytes, as the backup holds bytes: decoded text would turn every line that is
          // not UTF-8 into a change.
          writeFileSync(currentPath, currentBytes, { mode: 0o600 });
          diffText = execFileSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, backupPath, currentPath], {
            encoding: 'utf-8',
            timeout: 5000,
          });
        } catch (err: unknown) {
          // diff returns exit code 1 when files differ — that's normal
          if (err && typeof err === 'object' && 'stdout' in err) {
            diffText = String((err as { stdout: unknown }).stdout);
          } else {
            // Fallback: basic header
            diffText = `--- a/${rel}\n+++ b/${rel}\n(diff unavailable)`;
          }
        } finally {
          if (currentPath !== null) rmSync(currentPath, { force: true });
        }
      }

      diffs.push({
        file: rel,
        absolutePath: abs,
        status: entry.status,
        diff: diffText,
        originalContent: entry.originalContent,
      });
    }

    return diffs;
  }

  /**
   * Restore ALL files to their pre-run state.
   */
  rollbackAll(): void {
    for (const [abs, entry] of this.entries) {
      this._rollbackOne(abs, entry);
    }
  }

  /**
   * Restore specific files (by absolute path) to pre-run state.
   */
  rollbackFiles(files: string[]): void {
    for (const file of files) {
      const abs = resolve(file);
      const entry = this.entries.get(abs);
      if (entry) {
        this._rollbackOne(abs, entry);
      }
    }
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
    }
    if (this.entries.size === 0) this.cleanup();
  }

  private _isUnchanged(abs: string): boolean {
    const before = this.originalBytes.get(abs);
    if (before === undefined) return false;
    return this._readTracked(abs)?.equals(before) ?? false;
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
   * Number of tracked files that differ from their pre-run state.
   */
  get size(): number {
    return this._changed().length;
  }

  private _rollbackOne(abs: string, entry: ChangesetEntry): void {
    // Checked again here: a directory on the way may have become a symlink out of the
    // workspace since the backup. Such a file is left alone.
    if (this._confine(abs) !== abs) return;
    if (entry.status === 'added') {
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
      } catch {
        // File already gone
      }
    } else {
      // Modified file — restore the pre-run bytes; the decoded text loses any that are not UTF-8
      if (entry.originalContent !== null) {
        let fd: number | undefined;
        try {
          // O_NOFOLLOW: a symlink planted at the file since the backup is not written through.
          fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
          const bytes = this.originalBytes.get(abs) ?? Buffer.from(entry.originalContent, 'utf-8');
          let off = 0;
          while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
        } catch {
          // Best-effort
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
    }
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
