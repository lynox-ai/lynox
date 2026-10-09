/**
 * Google Drive backup upload adapter.
 *
 * Uploads backup files to a dedicated 'lynox-backups' folder on Google Drive.
 * Each backup gets its own subfolder named by timestamp.
 * Supports binary file upload (SQLite, encrypted files).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { BackupManifest } from './backup.js';
import { isProvisionedInstance } from './wire-capture.js';
import { googleFetch } from './connector-egress.js';
import type { HostPolicyContext } from './network-guard.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const BACKUP_FOLDER_NAME = 'lynox-backups';
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
  /**
   * The live host-policy view, so the backup upload is subject to the same
   * `network_policy` as every other Google call (PRD Stage 1 §3.8). It lives on
   * the provider rather than on the uploader's constructor because the engine
   * builds this shim per boot and already has the context there — a second
   * constructor parameter would be a second thing to forget.
   *
   * Optional: `undefined` means no policy configured, which is what a caller
   * outside an engine has, and it keeps today's behaviour.
   */
  hostPolicy?: HostPolicyContext | undefined;
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Whether this instance may upload backups to Google Drive at all.
 *
 * Self-hosted only. On a CP-provisioned instance the control plane already runs restic
 * backups, so a second backup path to a third party adds exposure without adding safety —
 * and since core#1240 that exposure is concrete: the backup carries the merge ledger, which
 * embeds email, phone, vat_id and domain.
 *
 * ⚠ The boundary is who HOSTS, not the word "managed". BYOK (`hosted`, the cheapest tier)
 * runs on lynox hosts too and gets the same CP backups; only the LLM key is the customer's.
 * A check written against `managed`/`managed_pro` would leave the redundant path open for
 * BYOK. `LYNOX_BILLING_TIER` is emitted to all three CP tiers and absent on self-host, which
 * is the same signal the managed hook uses.
 *
 * It delegates to `isProvisionedInstance`, which this repo already uses to answer exactly this
 * question — and answers it across THREE markers (`LYNOX_MANAGED_INSTANCE_ID`,
 * `LYNOX_BILLING_TIER`, `LYNOX_MANAGED_MODE`), so a half-provisioned environment still counts as
 * provisioned. The first version here read only `LYNOX_BILLING_TIER` and so failed OPEN on
 * partial env: a CP instance missing that one variable would have uploaded to Drive. Same
 * question, one answer — the earlier claim of "no new concept" was only true after this change.
 *
 * Extracted from the engine's wiring so the DECISION is testable independently of a boot. The
 * one line that CALLS it is covered too, by `engine-init-wiring-boot.test.ts` — both directions,
 * so neither dropping the call nor dropping the `if` around it can pass unnoticed.
 */
export function driveBackupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProvisionedInstance(env);
}

/**
 * Does the USER want backups uploaded to Drive?
 *
 * `driveBackupAllowed` above answers a different question — whether this DEPLOYMENT may upload at
 * all. Both are required, because they are different questions: tier says a deployment may upload,
 * the setting says its owner wants it to. Sending a copy of the whole data directory to a third
 * party is a decision of its own and needs a switch of its own.
 *
 * `backup_gdrive` is not invented here. It is declared in `LynoxUserConfig` and in
 * `LynoxUserConfigSchema`, and documented on two published pages — `features/backup.md`, which
 * states the default as `false`, and `daily-use/configuration.md`, which shows it in an example —
 * while nothing in the codebase read it. A documented setting that no code consults is a promise,
 * not a control. This function is the reader.
 *
 * `=== true` rather than truthiness: the property is an EXPLICIT opt-in. `undefined` — the
 * default, the field being `optional()` — and `false` both mean no, and so does a non-boolean
 * that somehow reached this far.
 *
 * Deliberately NOT added to `PROJECT_SAFE_KEYS` in `config.ts`. That allowlist is what a
 * PROJECT-local config may override, and its own comment says project config cannot override
 * security-sensitive fields. A file sitting in a working directory must not be able to change this
 * setting. It is a user-config setting, which is the path both documented pages show — and, on a
 * self-hosted instance, `PUT /api/config` reaches it too, so API access to an instance is
 * equivalent to config access.
 *
 * Extracted as a pure function for the same reason as the gate above: so the DECISION can be
 * asserted without booting an engine, and — the part that matters here — without a test having
 * to cause the very upload the gate exists to prevent. The lines that CALL it are covered
 * separately, in `engine-init-wiring-boot.test.ts`, because a unit test that hands the setting in
 * cannot see a dropped call.
 */
export function driveUploadOptedIn(
  config: { backup_gdrive?: boolean | undefined } = {},
): boolean {
  return config.backup_gdrive === true;
}


/** Authenticated fetch helper for Drive API. */
async function driveFetch(auth: BackupAuthProvider, url: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  return googleFetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  }, auth.hostPolicy);
}

/**
 * Google Drive backup uploader.
 * Creates a folder structure: My Drive / lynox-backups / <timestamp> / files...
 */
export class GDriveBackupUploader {
  private readonly auth: BackupAuthProvider;
  private rootFolderId: string | null = null;

  constructor(auth: BackupAuthProvider) {
    this.auth = auth;
  }

  /**
   * Upload a local backup directory to Google Drive.
   * Creates: lynox-backups/<timestamp>/manifest.json, history.db, etc.
   */
  async upload(backupDir: string, _manifest: BackupManifest): Promise<UploadResult> {
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

      // List subfolders in lynox-backups
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

  /** Find or create the root 'lynox-backups' folder. */
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

  /** Find the root 'lynox-backups' folder (returns null if not found). */
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
    const boundary = `---lynox-backup-${Date.now()}---`;
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

const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DELETE_CALL_TIMEOUT_MS = 30_000;
/** The whole deletion stops here and says so, rather than holding the disconnect open. */
const DELETE_DEADLINE_MS = 120_000;
/** A listing that needs more pages than this stops and says so, rather than looping. */
const MAX_LISTING_PAGES = 500;
/**
 * The name `BackupManager.createBackup` gives a backup directory, which the uploader reuses
 * for the Drive folder (`basename(backupDir)`): `2026-10-08T19301234Z`, plus `-<n>` when two
 * backups fall into the same instant.
 */
const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{8}Z(?:-\d+)?$/;

/** Is this the name `BackupManager.createBackup` gives a backup directory? Exported for the test that derives one. */
export function isBackupDirName(name: string): boolean {
  return BACKUP_DIR_NAME.test(name);
}

interface DriveListingFile {
  id: string;
  name: string;
  mimeType: string;
  isAppAuthorized?: boolean | undefined;
  ownedByMe?: boolean | undefined;
}

interface DriveListingPage {
  files?: DriveListingFile[] | undefined;
  nextPageToken?: string | undefined;
}

export interface DriveBackupDeletion {
  /**
   * `unchecked`: this grant cannot list Drive (no `drive.file` and no `drive` scope), so
   * nothing was looked at. `none`: no backup file lynox uploaded was found. `deleted`: every
   * one found is gone. `degraded`: at least one may remain — `problems` says which and why.
   */
  status: 'unchecked' | 'none' | 'deleted' | 'degraded';
  deleted: number;
  /**
   * Folders left standing: the `lynox-backups` roots and the backup folders inside them that
   * were walked. Always all of them, on purpose: Google deletes a folder together with every
   * descendant the user owns, and that includes a copy the user made inside it — which this
   * app cannot see under `drive.file` and must not destroy.
   */
  foldersKept: number;
  problems: string[];
}

/**
 * The credential view the deletion needs, built from a Google connection. It asks for a USER
 * scope (`hasUserScope`): a service account's Drive is its own, not where a user's backups
 * were uploaded. Built here rather than at the route so the token is taken in a module that
 * sends it only through `googleFetch` — a route file that called `getAccessToken()` itself
 * would join the egress source test's scope with every unrelated `fetch` it makes.
 */
export function driveAuthFrom(google: {
  getAccessToken(): Promise<string>;
  hasUserScope(scope: string): boolean;
  readonly hostPolicy?: HostPolicyContext | undefined;
}): BackupAuthProvider {
  return {
    getAccessToken: () => google.getAccessToken(),
    hasScope: (scope: string) => google.hasUserScope(scope),
    hostPolicy: google.hostPolicy,
  };
}

/**
 * Delete the backup files lynox uploaded to the user's Drive — the half of "disconnect
 * Google" that `POST /api/google/revoke` owes before it gives up the token it needs.
 *
 * It deletes along the structure `GDriveBackupUploader.upload` builds, and nothing else:
 * any folder named `lynox-backups` → a folder in it named like a backup directory that lynox
 * created → the files in that folder that lynox created. "Created by lynox" is
 * `isAppAuthorized === true` ("created or opened by the requesting app").
 *
 * The root itself is not checked: the checks that keep foreign content out are on the level
 * below. The backup folder must be one lynox created and carry a backup-directory name, and
 * the agent's Drive tool cannot create folders (`google-drive.ts`, `upload`). And a file is
 * deleted only when it is the USER's (`ownedByMe`): `isAppAuthorized` is per OAuth app, and the
 * managed client is one app for every tenant — another tenant's backup in a folder shared in
 * would pass every other check.
 *
 * Why the structure and not "anything of ours under a folder of that name": lynox creates
 * files in Drive for other reasons too — the agent's Drive, Docs and Sheets tools write under
 * the same grant — and under the full `drive` scope such a file can be moved anywhere. A walk
 * that took every app file below any `lynox-backups` folder would destroy those the moment one
 * ended up there. The uploader never writes deeper than root/backup/file, so nothing deeper,
 * nothing directly in the root and no folder of another name is touched. A file lynox made
 * for another reason and then PLACED inside a backup folder (the agent's tools accept a
 * `folder_id`) is indistinguishable from a backup file and is deleted with it.
 *
 * - Never a folder. `files.delete` on a folder removes "all descendants owned by the user",
 *   and a copy the user made of a backup lands in the same folder.
 * - Trashed files too: the queries do not exclude the bin, and a backup there is still a copy.
 *
 * Every failure is reported, never swallowed into a smaller count. A listing that does not
 * answer means the files under it were not looked at, and that is `degraded`, not `none` —
 * the opposite of `list()` above, which may return `[]` on error because nothing destroys
 * anything on the strength of it.
 *
 * Independent of `driveBackupAllowed` and `backup_gdrive` on purpose. Both decide whether
 * NEW uploads happen; neither says whether OLD ones exist. A user who opted out, or an
 * instance that uploaded before the tier gate existed, still has copies to remove.
 */
export async function deleteUploadedBackups(
  auth: BackupAuthProvider,
  isUploading: () => boolean = () => false,
  now: () => number = Date.now,
): Promise<DriveBackupDeletion> {
  const result: DriveBackupDeletion = { status: 'none', deleted: 0, foldersKept: 0, problems: [] };
  if (!auth.hasScope(DRIVE_FILE_SCOPE) && !auth.hasScope(DRIVE_FULL_SCOPE)) {
    return { ...result, status: 'unchecked' };
  }
  // The caller holds new uploads back for the whole deletion (`BackupManager.pauseUploads`);
  // what that cannot stop is one already under way.
  const uploadingAtStart = isUploading();
  if (uploadingAtStart) {
    result.problems.push('A backup was being uploaded when the deletion started; files it uploads may remain.');
  }
  const deadline = now() + DELETE_DEADLINE_MS;
  let outOfTime = false;
  /** False once the deadline has passed — recorded once, and every later step stops. */
  const inTime = (): boolean => {
    if (outOfTime) return false;
    if (now() <= deadline) return true;
    outOfTime = true;
    result.problems.push(`Stopped after ${String(DELETE_DEADLINE_MS / 1000)} s; backup files not reached by then remain.`);
    return false;
  };

  const call = (url: string, init?: RequestInit) =>
    driveFetch(auth, url, { ...init, signal: AbortSignal.timeout(DELETE_CALL_TIMEOUT_MS) });

  /** Every page of a query, or null with a problem recorded. */
  const listAll = async (q: string, what: string): Promise<DriveListingFile[] | null> => {
    const out: DriveListingFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      if (!inTime()) return null;
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,isAppAuthorized,ownedByMe)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      let response: Response;
      try {
        response = await call(`${DRIVE_BASE}/files?${params.toString()}`);
      } catch (err: unknown) {
        result.problems.push(`Could not list ${what}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (!response.ok) {
        result.problems.push(`Could not list ${what}: Google answered ${String(response.status)}`);
        return null;
      }
      let data: DriveListingPage;
      try {
        data = await response.json() as DriveListingPage;
      } catch (err: unknown) {
        result.problems.push(`Could not read the listing of ${what}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
      if (!pageToken) return out;
    }
    result.problems.push(`Stopped listing ${what} after ${String(MAX_LISTING_PAGES)} pages`);
    return null;
  };

  /**
   * Did lynox create this? `false` is the user's own (or another app's): left alone, silently.
   * ABSENT is not `false`. Google not saying would otherwise read as "nothing of ours here"
   * and report `none` over files that are still there.
   */
  const ours = (f: DriveListingFile, path: string): boolean => {
    if (f.isAppAuthorized === undefined) {
      result.problems.push(`Google did not say whether ${path} was created by lynox; left in place`);
      return false;
    }
    return f.isAppAuthorized;
  };

  const roots = await listAll(
    `name = '${BACKUP_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}'`,
    `the ${BACKUP_FOLDER_NAME} folders`,
  );
  if (roots === null) return { ...result, status: 'degraded' };

  for (const root of roots) {
    result.foldersKept++;
    const backups = await listAll(`'${root.id}' in parents`, `the folder ${root.name}`);
    if (backups === null) continue;
    for (const backup of backups) {
      // Only what the uploader creates here: a folder named like a backup directory.
      if (backup.mimeType !== FOLDER_MIME || !isBackupDirName(backup.name)) continue;
      const backupPath = `${root.name}/${backup.name}`;
      if (!ours(backup, backupPath)) continue;
      result.foldersKept++;
      const files = await listAll(`'${backup.id}' in parents`, `the folder ${backupPath}`);
      if (files === null) continue;
      for (const file of files) {
        // The uploader writes nested paths as flat names, so a folder here is not its own.
        if (file.mimeType === FOLDER_MIME) continue;
        const path = `${backupPath}/${file.name}`;
        if (!ours(file, path)) continue;
        // Someone else's file, even one lynox created for them: theirs, left alone silently.
        // ABSENT is reported, as for `isAppAuthorized` — not read as "not mine".
        if (file.ownedByMe === undefined) {
          result.problems.push(`Google did not say whether ${path} is yours; left in place`);
          continue;
        }
        if (!file.ownedByMe) continue;
        if (!inTime()) break;
        let response: Response;
        try {
          response = await call(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
        } catch (err: unknown) {
          result.problems.push(`Could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        // 404 right after a listing that showed the file: it went in between, which is the
        // outcome asked for. Counted as deleted, so the count is "no longer there", not
        // "removed by this call".
        if (response.ok || response.status === 404) result.deleted++;
        else result.problems.push(`Could not delete ${path}: Google answered ${String(response.status)}`);
      }
    }
  }

  // Only reachable when the hold above was not taken: a caller that did not pause uploads.
  if (!uploadingAtStart && isUploading()) {
    result.problems.push('A backup was being uploaded when the deletion finished; files it uploaded may remain.');
  }
  if (result.problems.length > 0) return { ...result, status: 'degraded' };
  return { ...result, status: result.deleted > 0 ? 'deleted' : 'none' };
}
