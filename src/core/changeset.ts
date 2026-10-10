import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChangesetEntry, ChangesetDiff } from '../types/index.js';

export class ChangesetManager {
  private entries: Map<string, ChangesetEntry> = new Map();
  private readonly backupDir: string;

  constructor(private readonly cwd: string, _runId: string) {
    this.backupDir = mkdtempSync(join(tmpdir(), 'lynox-changeset-'));
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
      try {
        originalContent = readFileSync(abs, 'utf-8');
        status = 'modified';
        // Copy original to backup dir preserving relative structure
        const rel = relative(this.cwd, abs);
        const backupPath = join(this.backupDir, rel);
        mkdirSync(dirname(backupPath), { recursive: true });
        cpSync(abs, backupPath);
      } catch {
        // Best-effort — if we can't read, treat as new file
        originalContent = null;
        status = 'added';
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
   * An unchanged entry is also dropped, with its backup copy. Otherwise a later edit of
   * that file — by the user or another run — would be reverted by `rollbackAll` without
   * ever having been shown in the review. Dropping it is safe at any point: a further
   * write backs the file up again, and its content is still the pre-run content.
   */
  private _changed(): Array<[string, ChangesetEntry, string]> {
    const changed: Array<[string, ChangesetEntry, string]> = [];
    for (const [abs, entry] of [...this.entries]) {
      let currentContent: string;
      try {
        currentContent = readFileSync(abs, 'utf-8');
      } catch {
        // A new file that was never created is unchanged. A modified file that can no
        // longer be read is not reported, but stays tracked so a rollback restores it.
        if (entry.status === 'added') this.entries.delete(abs);
        continue;
      }
      if (entry.status === 'modified' && currentContent === entry.originalContent) {
        this.entries.delete(abs);
        try { rmSync(join(this.backupDir, relative(this.cwd, abs)), { force: true }); } catch { /* best-effort, like cleanup() */ }
        continue;
      }
      changed.push([abs, entry, currentContent]);
    }
    if (this.entries.size === 0) this.cleanup();
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
        const backupPath = join(this.backupDir, relative(this.cwd, abs));
        try {
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
   * Remove the temporary backup directory.
   */
  cleanup(): void {
    try {
      rmSync(this.backupDir, { recursive: true, force: true });
    } catch {
      // Best-effort — OS cleans tmpdir on reboot
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
      // Modified file — restore original content
      if (entry.originalContent !== null) {
        try {
          writeFileSync(abs, entry.originalContent, 'utf-8');
        } catch {
          // Best-effort
        }
      }
    }
  }
}
