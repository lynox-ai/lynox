/**
 * Google Drive backup upload adapter.
 *
 * Uploads backup files to a dedicated 'nodyn-backups' folder on Google Drive.
 * Each backup gets its own subfolder named by timestamp.
 * Supports binary file upload (SQLite, encrypted files).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { BackupManifest } from './backup.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const BACKUP_FOLDER_NAME = 'nodyn-backups';
const UPLOAD_TIMEOUT_MS = 120_000; // 2 minutes per file

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string | undefined;
}

interface DriveFileList {
  files?: DriveFile[] | undefined;
}

export interface RemoteBackupInfo {
  id: string;
  name: string;
  created_at: string;
  manifest: BackupManifest | null;
}

export interface UploadResult {
  success: boolean;
  folderId: string;
  filesUploaded: number;
  error?: string | undefined;
}

export interface DownloadResult {
  success: boolean;
  localPath: string;
  filesDownloaded: number;
  error?: string | undefined;
}

/** Minimal auth interface — matches GoogleAuth.getAccessToken() + hasScope(). */
export interface BackupAuthProvider {
  getAccessToken(): Promise<string>;
  hasScope(scope: string): boolean;
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Authenticated fetch helper for Drive API. */
async function driveFetch(auth: BackupAuthProvider, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
}

/**
 * Google Drive backup uploader.
 * Creates a folder structure: My Drive / nodyn-backups / <timestamp> / files...
 */
export class GDriveBackupUploader {
  private readonly auth: BackupAuthProvider;
  private rootFolderId: string | null = null;

  constructor(auth: BackupAuthProvider) {
    this.auth = auth;
  }

  /**
   * Upload a local backup directory to Google Drive.
   * Creates: nodyn-backups/<timestamp>/manifest.json, history.db, etc.
   */
  async upload(backupDir: string, manifest: BackupManifest): Promise<UploadResult> {
    if (!this.auth.hasScope(DRIVE_FILE_SCOPE)) {
      return { success: false, folderId: '', filesUploaded: 0, error: 'Missing drive.file scope. Run /google auth to grant access.' };
    }

    try {
      // Ensure root folder exists
      const rootId = await this.ensureRootFolder();

      // Create subfolder for this backup
      const folderName = basename(backupDir);
      const folderId = await this.createFolder(folderName, rootId);

      // Upload all files
      let uploaded = 0;
      const filesToUpload = this.collectFiles(backupDir);

      for (const { relPath, fullPath } of filesToUpload) {
        await this.uploadBinaryFile(fullPath, relPath, folderId);
        uploaded++;
      }

      return { success: true, folderId, filesUploaded: uploaded };
    } catch (err: unknown) {
      return { success: false, folderId: '', filesUploaded: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List remote backups from Google Drive. */
  async list(): Promise<RemoteBackupInfo[]> {
    if (!this.auth.hasScope(DRIVE_FILE_SCOPE)) return [];

    try {
      const rootId = await this.findRootFolder();
      if (!rootId) return [];

      // List subfolders in nodyn-backups
      const params = new URLSearchParams({
        q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: '50',
      });

      const response = await driveFetch(this.auth, `${DRIVE_BASE}/files?${params.toString()}`);
      if (!response.ok) return [];

      const data = await response.json() as DriveFileList;
      const folders = data.files ?? [];

      const results: RemoteBackupInfo[] = [];
      for (const folder of folders) {
        // Try to read manifest from this folder
        let manifest: BackupManifest | null = null;
        try {
          manifest = await this.downloadManifest(folder.id);
        } catch { /* manifest might not exist */ }

        results.push({
          id: folder.id,
          name: folder.name,
          created_at: manifest?.created_at ?? folder.modifiedTime,
          manifest,
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  /** Download a remote backup to a local directory. */
  async download(remoteFolderId: string, destDir: string): Promise<DownloadResult> {
    if (!this.auth.hasScope(DRIVE_FILE_SCOPE)) {
      return { success: false, localPath: destDir, filesDownloaded: 0, error: 'Missing drive.file scope.' };
    }

    try {
      mkdirSync(destDir, { recursive: true, mode: 0o700 });

      // List all files in the remote folder (including subfolders)
      const files = await this.listFolderContents(remoteFolderId);
      let downloaded = 0;

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          // Recurse into subfolder
          const subDir = join(destDir, file.name);
          const subResult = await this.download(file.id, subDir);
          downloaded += subResult.filesDownloaded;
        } else {
          const destPath = join(destDir, file.name);
          await this.downloadFile(file.id, destPath);
          downloaded++;
        }
      }

      return { success: true, localPath: destDir, filesDownloaded: downloaded };
    } catch (err: unknown) {
      return { success: false, localPath: destDir, filesDownloaded: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Delete a remote backup folder. */
  async delete(remoteFolderId: string): Promise<boolean> {
    try {
      const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${remoteFolderId}`, {
        method: 'DELETE',
      });
      return response.ok || response.status === 204;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──

  /** Find or create the root 'nodyn-backups' folder. */
  private async ensureRootFolder(): Promise<string> {
    if (this.rootFolderId) return this.rootFolderId;

    const existing = await this.findRootFolder();
    if (existing) {
      this.rootFolderId = existing;
      return existing;
    }

    // Create it
    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: BACKUP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create ${BACKUP_FOLDER_NAME} folder: ${String(response.status)}`);
    }

    const folder = await response.json() as DriveFile;
    this.rootFolderId = folder.id;
    return folder.id;
  }

  /** Find the root 'nodyn-backups' folder (returns null if not found). */
  private async findRootFolder(): Promise<string | null> {
    if (this.rootFolderId) return this.rootFolderId;

    const params = new URLSearchParams({
      q: `name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: '1',
    });

    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files?${params.toString()}`);
    if (!response.ok) return null;

    const data = await response.json() as DriveFileList;
    const id = data.files?.[0]?.id ?? null;
    if (id) this.rootFolderId = id;
    return id;
  }

  /** Create a subfolder inside a parent folder. */
  private async createFolder(name: string, parentId: string): Promise<string> {
    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create folder "${name}": ${String(response.status)}`);
    }

    const folder = await response.json() as DriveFile;
    return folder.id;
  }

  /**
   * Upload a binary file to Google Drive.
   * Uses multipart upload with proper binary encoding.
   */
  private async uploadBinaryFile(localPath: string, remoteName: string, parentFolderId: string): Promise<string> {
    const content = readFileSync(localPath);
    const metadata = JSON.stringify({
      name: remoteName,
      parents: [parentFolderId],
    });

    // Build multipart body with binary content
    const boundary = `---nodyn-backup-${Date.now()}---`;
    const metadataPart = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    );
    const contentHeader = Buffer.from(
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const ending = Buffer.from(`\r\n--${boundary}--`);

    const body = Buffer.concat([metadataPart, contentHeader, content, ending]);

    const response = await driveFetch(this.auth, `${UPLOAD_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed for "${remoteName}": ${String(response.status)} ${text}`);
    }

    const result = await response.json() as DriveFile;
    return result.id;
  }

  /** Download a file from Google Drive to local path. */
  private async downloadFile(fileId: string, destPath: string): Promise<void> {
    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${fileId}?alt=media`);
    if (!response.ok) {
      throw new Error(`Download failed for file ${fileId}: ${String(response.status)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const destDir = join(destPath, '..');
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    writeFileSync(destPath, buffer, { mode: 0o600 });
  }

  /** Download and parse manifest.json from a remote backup folder. */
  private async downloadManifest(folderId: string): Promise<BackupManifest | null> {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and name = 'manifest.json' and trashed = false`,
      fields: 'files(id)',
      pageSize: '1',
    });

    const listResponse = await driveFetch(this.auth, `${DRIVE_BASE}/files?${params.toString()}`);
    if (!listResponse.ok) return null;

    const data = await listResponse.json() as DriveFileList;
    const manifestFileId = data.files?.[0]?.id;
    if (!manifestFileId) return null;

    const dlResponse = await driveFetch(this.auth, `${DRIVE_BASE}/files/${manifestFileId}?alt=media`);
    if (!dlResponse.ok) return null;

    return await dlResponse.json() as BackupManifest;
  }

  /** List all files in a Drive folder. */
  private async listFolderContents(folderId: string): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size)',
      pageSize: '200',
    });

    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files?${params.toString()}`);
    if (!response.ok) return [];

    const data = await response.json() as DriveFileList;
    return data.files ?? [];
  }

  /** Collect all files in a local backup directory (flat list with relative paths). */
  private collectFiles(dir: string, prefix = ''): Array<{ relPath: string; fullPath: string }> {
    const result: Array<{ relPath: string; fullPath: string }> = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        result.push(...this.collectFiles(fullPath, relPath));
      } else {
        result.push({ relPath, fullPath });
      }
    }
    return result;
  }
}
