/**
 * Backup integrity verification.
 * SHA-256 checksums for all files, SQLite integrity checks for .db files.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface VerifyResult {
  valid: boolean;
  errors: string[];
  files_checked: number;
}

export interface BackupFileEntry {
  path: string;
  size_bytes: number;
  checksum_sha256: string;
  type: 'sqlite' | 'file' | 'directory';
}

/** Compute SHA-256 checksum of a file (synchronous — backup files are small). */
export function computeFileChecksum(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/** Compute overall backup checksum from individual file checksums. */
export function computeManifestChecksum(entries: BackupFileEntry[]): string {
  const combined = entries.map(e => e.checksum_sha256).sort().join(':');
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Verify SQLite database integrity.
 * Opens a read-only connection and runs PRAGMA integrity_check.
 * Returns true only if the result is exactly 'ok'.
 */
export function verifySqliteIntegrity(dbPath: string): boolean {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return result.length === 1 && result[0]?.integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Verify a complete backup against its manifest.
 * Checks: file existence, size, checksum, and SQLite integrity.
 */
export function verifyBackup(backupDir: string, files: BackupFileEntry[]): VerifyResult {
  const errors: string[] = [];
  let filesChecked = 0;

  for (const entry of files) {
    const fullPath = `${backupDir}/${entry.path}`;

    // Skip directory entries (checked via their contents)
    if (entry.type === 'directory') {
      if (!existsSync(fullPath)) {
        errors.push(`Missing directory: ${entry.path}`);
      }
      filesChecked++;
      continue;
    }

    // Check file exists
    if (!existsSync(fullPath)) {
      errors.push(`Missing file: ${entry.path}`);
      filesChecked++;
      continue;
    }

    // Check size
    const stat = statSync(fullPath);
    if (stat.size !== entry.size_bytes) {
      errors.push(`Size mismatch: ${entry.path} (expected ${String(entry.size_bytes)}, got ${String(stat.size)})`);
    }

    // Check checksum
    const actualChecksum = computeFileChecksum(fullPath);
    if (actualChecksum !== entry.checksum_sha256) {
      errors.push(`Checksum mismatch: ${entry.path}`);
    }

    // SQLite integrity check
    if (entry.type === 'sqlite') {
      if (!verifySqliteIntegrity(fullPath)) {
        errors.push(`SQLite integrity check failed: ${entry.path}`);
      }
    }

    filesChecked++;
  }

  return {
    valid: errors.length === 0,
    errors,
    files_checked: filesChecked,
  };
}
