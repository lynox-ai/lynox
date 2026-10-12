import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve } from 'node:path';
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
  constructor(private readonly cwd: string, readonly runId: string) {}

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
    const abs = resolve(filePath);
    if (this.entries.has(abs)) return; // Already backed up — first write wins

    let originalContent: string | null = null;
    let status: 'added' | 'modified' = 'added';

    if (existsSync(abs)) {
      // The file exists, so it is `modified` whatever fails below. Treating it as `added`
      // would make "Rollback all" delete a file the user had before the run.
      status = 'modified';
      try {
        const bytes = readFileSync(abs);
        originalContent = bytes.toString('utf-8');
        // Held before the copy: a failed copy still leaves the bytes rollback restores.
        this.originalBytes.set(abs, bytes);
        this.backupDir ??= mkdtempSync(join(tmpdir(), 'lynox-changeset-'));
        cpSync(abs, this._backupPathOf(abs)!);
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
  private _changed(): Array<[string, ChangesetEntry, string]> {
    const changed: Array<[string, ChangesetEntry, string]> = [];
    for (const [abs, entry] of this.entries) {
      let currentBytes: Buffer;
      try {
        currentBytes = readFileSync(abs);
      } catch {
        // Deleted during the run, or unreadable — not reported
        continue;
      }
      if (entry.status === 'modified' && this.originalBytes.get(abs)?.equals(currentBytes)) continue;
      const currentContent = currentBytes.toString('utf-8');
      changed.push([abs, entry, currentContent]);
    }
    return changed;
  }

  /**
   * Produce unified diffs for all changed files.
   */
  getChanges(): ChangesetDiff[] {
    const diffs: ChangesetDiff[] = [];

    for (const [abs, entry, currentContent] of this._changed()) {
      const rel = relative(this.cwd, abs);

      let diffText: string;
      if (entry.status === 'added') {
        // New file: show all lines as additions
        const lines = currentContent.split('\n');
        const header = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
        diffText = header + lines.map(l => `+${l}`).join('\n');
      } else {
        // Modified file: use system diff -u
        const backupPath = this._backupPathOf(abs);
        try {
          if (backupPath === null || !existsSync(backupPath)) throw new Error('no backup copy');
          diffText = execFileSync('diff', ['-u', backupPath, abs], {
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
      if (entry.status === 'added' && existsSync(abs)) continue;
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
    try {
      return before.equals(readFileSync(abs));
    } catch {
      return false;
    }
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
    if (entry.status === 'added') {
      // New file — delete it
      try {
        unlinkSync(abs);
        // Try to remove empty parent dirs up to cwd
        let dir = dirname(abs);
        while (dir !== this.cwd && dir !== dirname(dir)) {
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
        try {
          writeFileSync(abs, this.originalBytes.get(abs) ?? entry.originalContent);
        } catch {
          // Best-effort
        }
      }
    }
  }
}
