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
   * Produce unified diffs for all changed files.
   */
  getChanges(): ChangesetDiff[] {
    const diffs: ChangesetDiff[] = [];

    for (const [abs, entry] of this.entries) {
      const rel = relative(this.cwd, abs);
      let currentContent: string;
      try {
        currentContent = readFileSync(abs, 'utf-8');
      } catch {
        // File was deleted during run — skip
        continue;
      }

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
   * Whether any file writes were tracked.
   */
  hasChanges(): boolean {
    return this.entries.size > 0;
  }

  /**
   * Whether this manager is active.
   */
  get active(): boolean {
    return true;
  }

  /**
   * Number of tracked files.
   */
  get size(): number {
    return this.entries.size;
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
