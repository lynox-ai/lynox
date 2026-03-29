/**
 * Backup manager — bulletproof backup and restore for ~/.lynox/.
 *
 * Uses VACUUM INTO for crash-safe SQLite copies, recursive directory copy
 * for Knowledge Graph, and optional AES-256-GCM encryption.
 *
 * All operations are designed to be safe during concurrent lynox operation.
 */

import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { computeFileChecksum, computeManifestChecksum, verifyBackup } from './backup-verify.js';
import { deriveBackupKey, encryptFile, decryptFile, isEncryptedBackupFile } from './backup-crypto.js';
import type { BackupFileEntry, VerifyResult } from './backup-verify.js';

/** Metadata stored alongside every backup. */
export interface BackupManifest {
  version: string;
  created_at: string;
  lynox_dir: string;
  encrypted: boolean;
  files: BackupFileEntry[];
  checksum: string;
}

export interface BackupResult {
  success: boolean;
  path: string;
  manifest: BackupManifest;
  duration_ms: number;
  error?: string | undefined;
}

export interface RestoreResult {
  success: boolean;
  pre_restore_backup_path: string;
  files_restored: number;
  duration_ms: number;
  error?: string | undefined;
}

export interface BackupConfig {
  backupDir: string;
  retentionDays: number;
  encrypt: boolean;
  /** Google Drive uploader instance (optional — set when Google auth is available). */
  gdriveUploader?: import('./backup-upload-gdrive.js').GDriveBackupUploader | undefined;
}

const SQLITE_DBS = ['history.db', 'vault.db', 'datastore.db', 'agent-memory.db'] as const;
const COPY_DIRS = ['memory', 'sessions'] as const;
const COPY_FILES = ['config.json'] as const;

export class BackupManager {
  private readonly lynoxDir: string;
  private readonly backupDir: string;
  private readonly retentionDays: number;
  private readonly encrypt: boolean;
  private readonly vaultKey: string | null;
  private _gdriveUploader: import('./backup-upload-gdrive.js').GDriveBackupUploader | null;

  constructor(lynoxDir: string, config: BackupConfig, vaultKey: string | null) {
    this.lynoxDir = lynoxDir;
    this.backupDir = config.backupDir;
    this.retentionDays = config.retentionDays;
    this.encrypt = config.encrypt && vaultKey !== null;
    this.vaultKey = vaultKey;
    this._gdriveUploader = config.gdriveUploader ?? null;
  }

  /** Set Google Drive uploader (can be set after construction when auth becomes available). */
  setGDriveUploader(uploader: import('./backup-upload-gdrive.js').GDriveBackupUploader): void {
    this._gdriveUploader = uploader;
  }

  /** Get Google Drive uploader (or null). */
  getGDriveUploader(): import('./backup-upload-gdrive.js').GDriveBackupUploader | null {
    return this._gdriveUploader;
  }

  // ── Create Backup ──

  async createBackup(): Promise<BackupResult> {
    const start = Date.now();
    const now = new Date();
    let timestamp = now.toISOString().replace(/[:.]/g, '').slice(0, 19) + 'Z';
    // Avoid collision if two backups run within the same second
    let finalDir = join(this.backupDir, timestamp);
    let suffix = 1;
    while (existsSync(finalDir)) {
      timestamp = `${now.toISOString().replace(/[:.]/g, '').slice(0, 19)}Z-${String(suffix)}`;
      finalDir = join(this.backupDir, timestamp);
      suffix++;
    }
    const tmpDir = join(this.backupDir, `${timestamp}.tmp`);
    const files: BackupFileEntry[] = [];

    try {
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      // 1. SQLite databases — VACUUM INTO for crash-safe copies
      for (const dbName of SQLITE_DBS) {
        const srcPath = join(this.lynoxDir, dbName);
        if (!existsSync(srcPath)) continue;

        const destPath = join(tmpDir, dbName);
        this.vacuumInto(srcPath, destPath);
        files.push(this.fileEntry(tmpDir, dbName, 'sqlite'));
      }

      // 2. Memory + Sessions — recursive copy
      for (const dirName of COPY_DIRS) {
        const srcDir = join(this.lynoxDir, dirName);
        if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;

        const destDir = join(tmpDir, dirName);
        this.copyDirRecursive(srcDir, destDir);
        files.push({ path: dirName, size_bytes: 0, checksum_sha256: '', type: 'directory' });
        for (const entry of this.walkDir(destDir)) {
          const relPath = `${dirName}/${relative(destDir, entry)}`;
          files.push(this.fileEntry(tmpDir, relPath, 'file'));
        }
      }

      // 4. Config file
      for (const fileName of COPY_FILES) {
        const srcFile = join(this.lynoxDir, fileName);
        if (!existsSync(srcFile)) continue;
        copyFileSync(srcFile, join(tmpDir, fileName));
        files.push(this.fileEntry(tmpDir, fileName, 'file'));
      }

      // 5. Encryption (optional)
      if (this.encrypt && this.vaultKey) {
        const key = deriveBackupKey(this.vaultKey);
        for (const entry of files) {
          if (entry.type === 'directory') continue;
          const filePath = join(tmpDir, entry.path);
          if (!existsSync(filePath)) continue;
          encryptFile(filePath, filePath, key);
          // Update checksum and size after encryption
          entry.checksum_sha256 = computeFileChecksum(filePath);
          entry.size_bytes = statSync(filePath).size;
        }
      }

      // 6. Read version
      let version = 'unknown';
      try {
        const { fileURLToPath } = await import('node:url');
        const { dirname } = await import('node:path');
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(thisDir, '..', '..', 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
          if (pkg.version) version = pkg.version;
        }
      } catch { /* best effort */ }

      // 7. Build manifest
      const checksum = computeManifestChecksum(files.filter(f => f.type !== 'directory'));
      const manifest: BackupManifest = {
        version,
        created_at: new Date().toISOString(),
        lynox_dir: this.lynoxDir,
        encrypted: this.encrypt,
        files,
        checksum,
      };

      writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

      // 8. Atomic rename tmp → final
      renameSync(tmpDir, finalDir);

      // 9. Verify (skip SQLite integrity for encrypted backups — files are ciphertext)
      const verifiableFiles = files.filter(f => f.type !== 'directory');
      const verifyFiles = this.encrypt
        ? verifiableFiles.map(f => f.type === 'sqlite' ? { ...f, type: 'file' as const } : f)
        : verifiableFiles;
      const verification = verifyBackup(finalDir, verifyFiles);
      if (!verification.valid) {
        return {
          success: false,
          path: finalDir,
          manifest,
          duration_ms: Date.now() - start,
          error: `Verification failed: ${verification.errors.join('; ')}`,
        };
      }

      // 10. Upload to Google Drive (best-effort — local backup is the primary)
      if (this._gdriveUploader) {
        try {
          await this._gdriveUploader.upload(finalDir, manifest);
        } catch {
          // GDrive upload failure does not fail the backup
          process.stderr.write('[lynox:backup] Google Drive upload failed — local backup is intact\n');
        }
      }

      return { success: true, path: finalDir, manifest, duration_ms: Date.now() - start };
    } catch (err: unknown) {
      // Cleanup temp dir on failure
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        path: '',
        manifest: { version: 'unknown', created_at: '', lynox_dir: this.lynoxDir, encrypted: false, files: [], checksum: '' },
        duration_ms: Date.now() - start,
        error: msg,
      };
    }
  }

  // ── Restore ──

  async restoreBackup(backupPath: string): Promise<RestoreResult> {
    const start = Date.now();

    // Load and validate manifest
    const manifestPath = join(backupPath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: 'Missing manifest.json' };
    }

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
    } catch {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: 'Invalid manifest.json' };
    }

    // Safety: create backup of current state before restore
    const safetyBackup = await this.createBackup();
    if (!safetyBackup.success) {
      return {
        success: false,
        pre_restore_backup_path: '',
        files_restored: 0,
        duration_ms: Date.now() - start,
        error: `Cannot create safety backup before restore: ${safetyBackup.error ?? 'unknown'}`,
      };
    }

    try {
      let filesRestored = 0;
      const needsDecrypt = manifest.encrypted && this.vaultKey;
      const key = needsDecrypt ? deriveBackupKey(this.vaultKey!) : null;

      for (const entry of manifest.files) {
        if (entry.type === 'directory') continue;

        const srcFile = join(backupPath, entry.path);
        const destFile = join(this.lynoxDir, entry.path);

        if (!existsSync(srcFile)) continue;

        // Ensure parent directory exists
        const destDir = join(destFile, '..');
        mkdirSync(destDir, { recursive: true, mode: 0o700 });

        if (needsDecrypt && key && isEncryptedBackupFile(srcFile)) {
          decryptFile(srcFile, destFile, key);
        } else {
          copyFileSync(srcFile, destFile);
        }
        filesRestored++;
      }

      return {
        success: true,
        pre_restore_backup_path: safetyBackup.path,
        files_restored: filesRestored,
        duration_ms: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        success: false,
        pre_restore_backup_path: safetyBackup.path,
        files_restored: 0,
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── List ──

  listBackups(): BackupManifest[] {
    if (!existsSync(this.backupDir)) return [];

    const entries = readdirSync(this.backupDir, { withFileTypes: true });
    const manifests: BackupManifest[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.tmp')) continue; // skip incomplete backups
      const manifestPath = join(this.backupDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
        manifests.push(manifest);
      } catch {
        // Skip corrupt manifests
      }
    }

    // Sort newest first
    manifests.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return manifests;
  }

  // ── Prune ──

  pruneBackups(retentionDays?: number | undefined): number {
    const days = retentionDays ?? this.retentionDays;
    if (days <= 0) return 0;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    if (!existsSync(this.backupDir)) return 0;

    const entries = readdirSync(this.backupDir, { withFileTypes: true });
    const backups: Array<{ name: string; createdAt: Date }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith('.tmp')) continue;
      const manifestPath = join(this.backupDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
        backups.push({ name: entry.name, createdAt: new Date(manifest.created_at) });
      } catch {
        continue;
      }
    }

    // Sort oldest first
    backups.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Never delete the most recent backup
    let pruned = 0;
    for (let i = 0; i < backups.length - 1; i++) {
      const backup = backups[i]!;
      if (backup.createdAt < cutoff) {
        try {
          rmSync(join(this.backupDir, backup.name), { recursive: true, force: true });
          pruned++;
        } catch { /* best effort */ }
      }
    }
    return pruned;
  }

  // ── Verify ──

  verifyBackup(backupPath: string): VerifyResult {
    const manifestPath = join(backupPath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { valid: false, errors: ['Missing manifest.json'], files_checked: 0 };
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
      const verifiableFiles = manifest.files.filter(f => f.type !== 'directory');
      return verifyBackup(backupPath, verifiableFiles);
    } catch (err: unknown) {
      return { valid: false, errors: [err instanceof Error ? err.message : String(err)], files_checked: 0 };
    }
  }

  /** Get the backup directory path. */
  getBackupDir(): string {
    return this.backupDir;
  }

  // ── Private helpers ──

  /**
   * VACUUM INTO — crash-safe SQLite copy.
   * Creates a consistent snapshot even during concurrent writes (WAL mode).
   */
  private vacuumInto(srcPath: string, destPath: string): void {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(srcPath, { readonly: true });
      // VACUUM INTO creates a complete, defragmented copy
      // Escape single quotes in path to prevent SQL injection
      const safePath = destPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${safePath}'`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  /** Recursive directory copy preserving structure. */
  private copyDirRecursive(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /** Walk a directory and return all file paths. */
  private walkDir(dir: string): string[] {
    const result: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this.walkDir(fullPath));
      } else {
        result.push(fullPath);
      }
    }
    return result;
  }

  /** Create a file entry with checksum and size. */
  private fileEntry(backupDir: string, relPath: string, type: 'sqlite' | 'file'): BackupFileEntry {
    const fullPath = join(backupDir, relPath);
    return {
      path: relPath,
      size_bytes: statSync(fullPath).size,
      checksum_sha256: computeFileChecksum(fullPath),
      type,
    };
  }
}
