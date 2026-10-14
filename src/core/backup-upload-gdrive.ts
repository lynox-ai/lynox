/**
 * Google Drive backup upload adapter.
 *
 * Uploads backup files to a dedicated 'lynox-backups' folder on Google Drive.
 * Each backup gets its own subfolder named by timestamp.
 * Supports binary file upload (SQLite, encrypted files).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, basename, isAbsolute, relative, resolve, sep } from 'node:path';
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
 * Where the uploader keeps the id of its `lynox-backups` root across restarts.
 *
 * Once a root is pinned, the uploader takes that folder while the account can see it: a second
 * folder of the same name that later appears in the user's Drive is not taken in its place.
 * The pin is the only way the uploader finds its root again; it never takes a folder by its name.
 * An uploader without one cannot upload, and one whose pin cannot be written fails the upload.
 */
export interface RootFolderPin {
  read(): string | null;
  write(id: string): void;
}

const ROOT_PIN_FILE = 'gdrive-backup-root';
/** A Drive file id as the pin stores it; anything else in the file is not a pin. */
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** A pin kept in a file of its own in `dir`, readable by the owner only. */
export function fileRootPin(dir: string): RootFolderPin {
  const path = join(dir, ROOT_PIN_FILE);
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(path, 'utf8').trim();
      } catch (err: unknown) {
        // Only a missing file is "no pin". Any other failure to read it is an error: taken as no
        // pin, it would create a new root and overwrite the pin of the existing one.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      return DRIVE_ID.test(text) ? text : null;
    },
    write: (id: string) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Beside the file and renamed over it, so a reader never sees a half-written id.
      const tmp = `${path}.${String(process.pid)}.tmp`;
      writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

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
 * A check written against the CP-key tiers would leave the redundant path open for
 * BYOK. `LYNOX_BILLING_TIER` is emitted to every CP tier and absent on self-host, which
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
  /** Without a pin the uploader has nowhere to keep its root, and refuses to upload. */
  private readonly rootPin: RootFolderPin | undefined;
  private rootFolderId: string | null = null;

  constructor(auth: BackupAuthProvider, options: { rootPin?: RootFolderPin | undefined } = {}) {
    this.auth = auth;
    this.rootPin = options.rootPin;
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

  /**
   * Download a remote backup to a local directory that is empty or does not exist yet.
   *
   * Only a backup folder directly under this uploader's own root is downloaded (see
   * `isOwnBackupFolder`); any other id is refused before anything is written. The whole tree is
   * listed and checked first (see `planDownload`), and nothing is written when any entry fails:
   * every file and folder must be one this app wrote for this account, and every Drive name must
   * map to its own path inside `destDir` (see `localPathFor`). The uploader names files by their
   * path relative to the backup (`dir/file`). `destDir` must be empty because the check is on
   * paths, not on what is already there: an existing symlink inside it would lead a checked path
   * elsewhere. A failure while writing (a file that cannot be fetched, or whose path exists by
   * then) leaves the files written so far, and a retry needs an empty target again.
   *
   * What this does not establish is that the content is the backup's: someone who can write into
   * the root can change, rename or move the user's own files there without changing who owns
   * them. Checking content against the manifest is the restore's job.
   */
  async download(remoteFolderId: string, destDir: string): Promise<DownloadResult> {
    if (!this.auth.hasScope(DRIVE_FILE_SCOPE)) {
      return { success: false, localPath: destDir, filesDownloaded: 0, error: 'Missing drive.file scope.' };
    }

    try {
      if (!await this.isOwnBackupFolder(remoteFolderId)) {
        return { success: false, localPath: destDir, filesDownloaded: 0, error: `Not a backup in the ${BACKUP_FOLDER_NAME} folder.` };
      }
      if (!isEmptyOrAbsent(destDir)) {
        return { success: false, localPath: destDir, filesDownloaded: 0, error: `Download target ${destDir} is not empty.` };
      }
      const plan = await this.planDownload(remoteFolderId, destDir);
      mkdirSync(destDir, { recursive: true, mode: 0o700 });
      for (const dir of plan.dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const { id, path } of plan.files) await this.downloadFile(id, path);
      return { success: true, localPath: destDir, filesDownloaded: plan.files.length };
    } catch (err: unknown) {
      return { success: false, localPath: destDir, filesDownloaded: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Delete a remote backup folder. Only a backup folder directly under the own root is deleted. */
  async delete(remoteFolderId: string): Promise<boolean> {
    try {
      if (!await this.isOwnBackupFolder(remoteFolderId)) return false;
      // The id was checked to be a plain Drive id, so this is the same URL the check read.
      const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${remoteFolderId}`, {
        method: 'DELETE',
      });
      return response.ok || response.status === 204;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──

  /**
   * Find or create the root 'lynox-backups' folder.
   *
   * A root that cannot be pinned is not kept: the next start would not find it and would create
   * another, one more folder per start. So without a pin, or when the pin cannot be written, the
   * upload fails, and the folder this call just created is deleted again by its id.
   */
  private async ensureRootFolder(): Promise<string> {
    if (this.rootFolderId) return this.rootFolderId;

    const existing = await this.findRootFolder();
    if (existing) {
      this.rootFolderId = existing;
      return existing;
    }
    if (!this.rootPin) throw new Error(`No place to keep the ${BACKUP_FOLDER_NAME} folder id; not creating one.`);

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
    if (typeof folder.id !== 'string' || !DRIVE_ID.test(folder.id)) {
      throw new Error(`Drive did not return a usable id for the new ${BACKUP_FOLDER_NAME} folder; it may be left in Drive.`);
    }
    try {
      this.rootPin.write(folder.id);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      const removed = await this.removeFolder(folder.id);
      throw new Error(`Could not keep the ${BACKUP_FOLDER_NAME} folder id: ${reason}. `
        + (removed ? 'The folder just created was deleted again.' : `The folder just created (${folder.id}) could not be deleted and is left in Drive.`));
    }
    this.rootFolderId = folder.id;
    return folder.id;
  }

  /** Delete one folder by its id; whether Drive confirmed it. */
  private async removeFolder(id: string): Promise<boolean> {
    try {
      const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The pinned root, while it is still this instance's (null otherwise).
   *
   * It counts while it is a folder the user owns, this app is authorized for and that is not in
   * the bin. Without a pin, when the account does not see the pinned folder (Drive answers 404:
   * it was deleted, or the instance is now connected to another Google account), or when it sees
   * it but it no longer is all of that, the answer is null and the caller creates a new root.
   *
   * There is no lookup by name: a folder of that name is not necessarily one this instance
   * created, so the name is not used to find the root. Never adopting one costs a second root once, on the first start after an
   * update and after a change of Google account; the backups in the earlier root stay where they
   * are, and `deleteUploadedBackups` still finds them by name when Google is disconnected.
   *
   * A Drive that cannot be asked is an error, not a missing root: a new root created on a passing
   * failure would leave the backups split over two.
   */
  private async findRootFolder(): Promise<string | null> {
    if (this.rootFolderId) return this.rootFolderId;

    const pinned = this.rootPin?.read() ?? null;
    if (pinned === null) return null;
    if (await this.pinnedRoot(pinned) !== 'own') return null;
    this.rootFolderId = pinned;
    return pinned;
  }

  /**
   * What the pinned folder is to this account: still its root (`own`), a file it sees that is
   * not its root (`not-own`), or nothing it sees (`unseen`). Throws when Drive cannot say.
   */
  private async pinnedRoot(id: string): Promise<'own' | 'not-own' | 'unseen'> {
    const params = new URLSearchParams({ fields: 'id,mimeType,trashed,ownedByMe,isAppAuthorized' });
    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${encodeURIComponent(id)}?${params.toString()}`);
    if (response.status === 404) return 'unseen';
    if (!response.ok) throw new Error(`Could not read the pinned ${BACKUP_FOLDER_NAME} folder: ${String(response.status)}`);
    const f = await response.json() as {
      mimeType?: string | undefined; trashed?: boolean | undefined;
      ownedByMe?: boolean | undefined; isAppAuthorized?: boolean | undefined;
    };
    // `trashed` is compared against true: a response that leaves it out is not a folder in the bin.
    const own = f.mimeType === FOLDER_MIME && f.trashed !== true && f.ownedByMe === true && f.isAppAuthorized === true;
    return own ? 'own' : 'not-own';
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

  /**
   * Is `id` a backup folder of this account directly under the own root, not in the bin? The
   * id must be a plain Drive id before anything is asked, since it goes into URLs and queries.
   * The root is the one `findRootFolder` accepts, so a folder elsewhere in the account, one
   * another account shared in, and the root itself (not its own parent) are not. The folder must
   * also be the user's and this app's, as the uploader creates it: someone who can write into
   * the root, such as the previous owner of a transferred one, can add folders, but they are
   * theirs. (They can still change the user's own folders and files; see `download`.)
   * No root means no backup folder. Throws when Drive cannot say.
   */
  private async isOwnBackupFolder(id: string): Promise<boolean> {
    if (!DRIVE_ID.test(id)) return false;
    const rootId = await this.findRootFolder();
    if (rootId === null) return false;
    const params = new URLSearchParams({ fields: 'id,mimeType,trashed,parents,ownedByMe,isAppAuthorized' });
    const response = await driveFetch(this.auth, `${DRIVE_BASE}/files/${id}?${params.toString()}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Could not read backup folder ${id}: ${String(response.status)}`);
    const f = await response.json() as {
      mimeType?: string | undefined; trashed?: boolean | undefined; parents?: string[] | undefined;
      ownedByMe?: boolean | undefined; isAppAuthorized?: boolean | undefined;
    };
    return f.mimeType === FOLDER_MIME && f.trashed !== true && f.ownedByMe === true && f.isAppAuthorized === true
      && (f.parents ?? []).includes(rootId);
  }

  /**
   * Every folder and file below `folderId` with its local path, or a thrown error naming the
   * first entry that fails: one not owned by the user or not written by this app (someone who
   * can write into the folder can add entries, but they are theirs), a name that does not map
   * to its own path inside `destDir`, or two entries that map to the same path.
   */
  private async planDownload(folderId: string, destDir: string): Promise<{ dirs: string[]; files: Array<{ id: string; path: string }> }> {
    const plan = { dirs: [] as string[], files: [] as Array<{ id: string; path: string }> };
    const taken = new Set<string>();
    const walk = async (id: string, dir: string): Promise<void> => {
      for (const entry of await this.listFolderContents(id)) {
        if (entry.ownedByMe !== true || entry.isAppAuthorized !== true) {
          throw new Error(`Refusing Drive file ${JSON.stringify(entry.name)}: not one this app wrote for this account`);
        }
        const path = localPathFor(dir, entry.name);
        if (taken.has(path)) throw new Error(`Refusing Drive file ${JSON.stringify(entry.name)}: a second entry for ${path}`);
        taken.add(path);
        if (entry.mimeType === FOLDER_MIME) {
          plan.dirs.push(path);
          await walk(entry.id, path);
        } else {
          plan.files.push({ id: entry.id, path });
        }
      }
    };
    await walk(folderId, destDir);
    return plan;
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
    // `wx`: the file's own entry existing by now, a symlink included, was not there when the
    // target was checked empty, so it is refused rather than written through. This covers the
    // last component only: a directory symlink planted on the way, or a target that is itself a
    // symlink, is still followed.
    writeFileSync(destPath, buffer, { mode: 0o600, flag: 'wx' });
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

  /**
   * Everything in a Drive folder, over all pages. A listing that fails or does not end is an
   * error, not an empty folder: a download would otherwise report success with files missing.
   */
  private async listFolderContents(folderId: string): Promise<DriveListingFile[]> {
    const out: DriveListingFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,ownedByMe,isAppAuthorized)',
        pageSize: '200',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await driveFetch(this.auth, `${DRIVE_BASE}/files?${params.toString()}`);
      if (!response.ok) throw new Error(`Could not list Drive folder ${folderId}: ${String(response.status)}`);
      const data = await response.json() as { nextPageToken?: string | undefined; files?: DriveListingFile[] | undefined };
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
      if (!pageToken) return out;
    }
    throw new Error(`Listing Drive folder ${folderId} did not end after ${String(MAX_LISTING_PAGES)} pages`);
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
/**
 * A listing that needs more pages than this stops rather than looping. The deletion says so in
 * its result; the download refuses the backup.
 */
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

/**
 * The local path a Drive file name maps to below `destDir`, or a thrown error. A name may be a
 * relative path: the uploader names each file by its path inside the backup (`dir/file`), so a
 * separator is not an attack. Taken is exactly that form: the name must be the path from
 * `destDir` to where it lands, spelled with `/`, and must not leave `destDir` or be `destDir`
 * itself. That refuses a parent step, an absolute name, the empty one, and any other spelling
 * (`a/../b`, `./a`, `a//b`) — two of which could otherwise name the same file. Exported for its
 * tests.
 */
export function localPathFor(destDir: string, name: string): string {
  const base = resolve(destDir);
  const path = resolve(base, name);
  const rel = relative(base, path);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside || rel.split(sep).join('/') !== name) {
    throw new Error(`Refusing Drive file name ${JSON.stringify(name)}: not a path inside ${destDir}`);
  }
  return path;
}

/** Is `dir` absent or an empty directory? Anything else that cannot be read is thrown. */
function isEmptyOrAbsent(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
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
 * Every root of that name, not only the pinned one, and this is load-bearing: the uploader never
 * takes a root by its name, so after an update or a change of Google account it creates a new
 * one, and the backups in the earlier root are reached only here. Narrowing this to the pinned
 * root would leave them in Drive after a disconnect.
 *
 * The root itself is not checked: the checks that keep foreign content out are on the level
 * below. The backup folder must be one lynox created and carry a backup-directory name, and
 * the agent's Drive tool cannot create folders (`google-drive.ts`, `upload`). And a file is
 * deleted only when it is the USER's (`ownedByMe`): `isAppAuthorized` is per OAuth app, and one
 * app can serve several users of a deployment — another user's backup in a folder shared in
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
