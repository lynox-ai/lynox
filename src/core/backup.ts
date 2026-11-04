/**
 * Backup manager — bulletproof backup and restore for ~/.lynox/.
 *
 * Uses VACUUM INTO for crash-safe SQLite copies, recursive directory copy
 * for Knowledge Graph, and optional AES-256-GCM encryption.
 *
 * All operations are designed to be safe during concurrent lynox operation.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, readdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { computeFileChecksum, computeManifestChecksum, verifyBackup } from './backup-verify.js';
import { deriveBackupKey, deriveManifestKey, encryptFile, decryptBuffer, decryptFileToBuffer, isEncryptedBackupBuffer, isEncryptedBackupFile, manifestMac, manifestMacMatches } from './backup-crypto.js';
import type { BackupFileEntry, VerifyResult } from './backup-verify.js';
import { BACKUP_SQLITE_DBS, BACKUP_COPY_DIRS, BACKUP_COPY_FILES } from './data-dir-inventory.js';
import { leaseWorkspaceFor } from './workspace-access.js';
import { shellIsolation, type ShellIsolation } from './shell-isolation.js';
import { OMITTED_SIDECAR, restoreRefusal } from './sidecar-refusals.js';

export { OMITTED_SIDECAR };
import { closeAnchor, copyOut, FOLD_PROBE_NAME, isStageName, listDir, namesFoldAt, openAnchor, removeStaleStages, stageIn, statEntry, unlinkAt, WorkspaceAccessError, type StageEntry, type StagedWrite, type WorkspaceAnchor } from './workspace-fd.js';

/**
 * The inventory row the workspace root serves. The root may live outside the data dir, so it is
 * copied out of and staged into its anchor (`workspace-access.ts`), never joined onto the data
 * dir; in the archive its files keep the `workspace/` prefix, so a backup taken before the root
 * moved restores the same way.
 */
const WORKSPACE = 'workspace';
const WORKSPACE_PREFIX = `${WORKSPACE}/`;

/**
 * Whether a manifest entry names a path a restore may join onto the backup and the data dir:
 * relative, and every component a plain name. Checked per component, not on the resolved
 * target: `memory/../workspace/x` resolves inside the data dir and still leaves its own
 * entry, past the workspace root's anchor that only takes `workspace/…`.
 */
export function isRestorableEntryPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.includes('\0')) return false;
  // The empty component also refuses '' and an absolute path, whose first component is empty.
  return path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

/** The first entry whose path a restore must not use, or null when every one is plain. */
function unrestorableEntry(files: unknown): string | null {
  if (!Array.isArray(files)) return '(files is not a list)';
  for (const entry of files as Array<{ path?: unknown } | null>) {
    const path = entry?.path;
    if (!isRestorableEntryPath(path)) return JSON.stringify(path) ?? String(path);
  }
  return null;
}

/**
 * Read a backup file once and check THOSE bytes against its entry. The restore verifies the
 * archive first and stages it later, with the safety backup in between; a file swapped in that
 * window would be copied unchecked if it were read again by name. In an encrypted backup every
 * file must be ciphertext: a plaintext one needs no key to plant.
 */
function readEntryBytes(srcFile: string, entry: BackupFileEntry, encrypted: boolean): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(srcFile);
  } catch {
    // The verify pass found it; gone now means changed, not "skip it and report success".
    throw new Error(`Backup file changed after it was verified — refusing to restore: ${entry.path}`);
  }
  if (raw.length !== entry.size_bytes || createHash('sha256').update(raw).digest('hex') !== entry.checksum_sha256) {
    throw new Error(`Backup file changed after it was verified — refusing to restore: ${entry.path}`);
  }
  if (encrypted && !isEncryptedBackupBuffer(raw)) {
    throw new Error(`Backup is encrypted but holds a file that is not — refusing to restore: ${entry.path}`);
  }
  return raw;
}

/** Metadata stored alongside every backup. */
export interface BackupManifest {
  version: string;
  created_at: string;
  lynox_dir: string;
  encrypted: boolean;
  files: BackupFileEntry[];
  checksum: string;
  /**
   * What the backup left out by design. `workspace: 'omitted-sidecar'`: made in shell sidecar
   * mode, where the engine does not walk the shared workspace tree (`copyWorkspaceOut`). Absent
   * means everything was covered, as in every backup made before this field existed. Covered by
   * the MAC like every field but `auth`, so it is authenticated only when `auth` is present.
   */
  coverage?: { workspace: typeof OMITTED_SIDECAR } | undefined;
  /**
   * Proof of origin: an HMAC over the rest of the manifest, keyed from the vault key. Written by
   * every engine that has a vault key, encrypted backup or not. The manifest carries every file's
   * checksum, so the MAC covers the files' bytes as well as their list and the `encrypted` flag.
   */
  auth?: { alg: 'hmac-sha256'; mac: string } | undefined;
}

/**
 * Whether a backup's origin could be shown before a restore. `verified`: its MAC matches this
 * vault key. `none`: it carries no MAC (made before backups were signed, or the MAC was removed).
 * `mismatch`: it carries one that does not match (changed, or made under another vault key).
 * `no-key`: this engine has no vault key to check with.
 */
export type BackupProvenance = 'verified' | 'none' | 'mismatch' | 'no-key';

/** A backup as `listBackups` (and `GET /api/backups`) shows it. */
export type BackupListEntry = BackupManifest & { backup_id: string; provenance: BackupProvenance };

export interface RestoreOptions {
  /**
   * Restore although the backup's origin is not shown. Every restore path needs a way to say this
   * (the HTTP route, the web UI, this API), or old backups and backups of a keyless engine could
   * never be restored at all.
   */
  allowUnverified?: boolean | undefined;
}

const UNVERIFIED_REASON: Record<Exclude<BackupProvenance, 'verified'>, string> = {
  none: 'This backup has no proof of origin: it was made before backups were signed, or its signature was removed.',
  mismatch: 'This backup\'s proof of origin does not match this vault key: the backup was changed, or it was made under another vault key.',
  'no-key': 'No vault key is available, so this backup\'s origin cannot be checked.',
};

export interface BackupResult {
  success: boolean;
  path: string;
  manifest: BackupManifest;
  duration_ms: number;
  error?: string | undefined;
  /**
   * Workspace entries not in the backup: symlinks, FIFOs, sockets and devices (never followed or
   * copied), and names that are not valid UTF-8 (they cannot be addressed by path). Archive paths,
   * `workspace/...`. Empty when everything was copied.
   */
  skipped?: string[] | undefined;
  /** Set when the workspace was left out because the engine runs in shell sidecar mode; the manifest's `coverage` says the same. */
  workspace?: typeof OMITTED_SIDECAR | undefined;
}

export interface RestoreResult {
  success: boolean;
  pre_restore_backup_path: string;
  files_restored: number;
  duration_ms: number;
  error?: string | undefined;
  /**
   * `unverified_backup`: refused because the backup's origin is not shown; confirm with `allowUnverified`.
   * `workspace_sidecar_mode`: refused because the backup holds workspace files and the engine runs in shell sidecar mode.
   */
  code?: 'unverified_backup' | 'workspace_sidecar_mode' | 'restore_in_progress' | undefined;
  provenance?: BackupProvenance | undefined;
  /**
   * Entries the restore did not write: a name outside the inventory, or one renamed since the
   * backup was made. Archive paths. Empty when every entry was restored. A restore temp that a
   * crashed restore left in a backed-up directory (`STAGING_TEMP`) is neither written nor named
   * here: it is nobody's file.
   */
  skipped?: string[] | undefined;
}

export interface BackupConfig {
  backupDir: string;
  retentionDays: number;
  encrypt: boolean;
  /** Google Drive uploader instance (optional — set when Google auth is available). */
  gdriveUploader?: import('./backup-upload-gdrive.js').GDriveBackupUploader | undefined;
  /**
   * Asked at EVERY upload, not once at wiring: may this backup be uploaded at all?
   *
   * The engine hands in a closure over its live config, so revoking the opt-in takes effect in
   * the running process instead of at the next restart. Omitted means yes, which is the right
   * default for an embedder that attaches an uploader deliberately and has no such setting.
   */
  uploadAllowed?: (() => boolean) | undefined;
}

// DERIVED, not restated. These three lists and the migration set used to be maintained
// independently and drifted: on 2026-08-20 the merge ledger was in neither, `artifacts/`
// was in migration only, and `apis/`, `workspace/` and a hand-placed `files/` holding a
// customer contract were in neither. `data-dir-inventory.ts` is now the single table both
// paths read, and it must state a REASON for anything it does not carry.
const SQLITE_DBS = BACKUP_SQLITE_DBS;
const COPY_DIRS = BACKUP_COPY_DIRS;
const COPY_FILES = BACKUP_COPY_FILES;

/**
 * The temp an earlier restore staged a data-dir entry to, by name, beside its target:
 * `<name>.<16 hex>.restore-staging`. Restores now stage through `stageIn` (`.lynox-stage-…`); this
 * shape is still swept, since a crashed restore of an earlier version may have left one, and still
 * kept out of what a restore writes. Only this exact shape is reserved: a user's own
 * `notes.restore-staging` is restored like any other file.
 */
const STAGING_TEMP = /\.[0-9a-f]{16}\.restore-staging$/;

/**
 * A temp of a write in flight or a crashed one: the older restore temp, or the fd module's stage
 * (`.lynox-stage-<24 hex>`, which the artifact store and the restore both write). A backup taken
 * while one was in flight holds it; it is nobody's file, so it is neither written back nor named.
 */
function isTempName(path: string): boolean {
  return STAGING_TEMP.test(path) || isStageName(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Whether a restore writes this entry: only where `createBackup` writes, a database or file of the
 * inventory under its own name, or a path inside one of its directories. A path that is plain but
 * lands anywhere else (`http-secret`, `vault.key`, `plugins/…`) is what the inventory keeps OUT of
 * a backup, and a manifest anyone with write access to the backup can extend would otherwise bring
 * it back. Exact case on purpose: on a filesystem that folds case, `Workspace/x` would reach the
 * workspace by name, past its root's anchor. A name ending in the staging suffix would collide with
 * the temp of its neighbour.
 */
function isBackedUpEntryPath(path: string): boolean {
  if (isTempName(path)) return false;
  const slash = path.indexOf('/');
  if (slash === -1) return SQLITE_DBS.includes(path) || COPY_FILES.includes(path);
  return COPY_DIRS.includes(path.slice(0, slash));
}

/**
 * The first path the manifest names twice. Both copies pass the check of the archive, and the second
 * staging deletes the first one's temp, so the swap failed halfway, after earlier files were already
 * replaced. Compared as strings.
 */
function duplicateEntry(paths: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) return path;
    seen.add(path);
  }
  return null;
}

/**
 * Every pair of paths that a filesystem folding case or the Unicode form would make collide:
 * two names for one file (`memory/X` and `memory/x`, NFC `é` and NFD `é`), and a file one entry
 * names where another needs a folder (`memory/A` beside `memory/a/b`: staging the second makes the
 * folder, and the swap's rename onto it fails after earlier files were replaced). On a filesystem
 * that does not fold, each is a path of its own. The first path of a pair is the one whose folder
 * decides. (The same string as a file and as a folder cannot both be in an archive.)
 */
function foldedPairs(paths: readonly string[]): Array<[string, string]> {
  const fold = (p: string): string => p.normalize('NFC').toUpperCase().toLowerCase();
  const files = new Map<string, string>();
  const pairs: Array<[string, string]> = [];
  for (const path of paths) {
    const other = files.get(fold(path));
    if (other !== undefined && other !== path) pairs.push([other, path]);
    else files.set(fold(path), path);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const file = files.get(fold(parts.slice(0, i).join('/')));
      if (file !== undefined) pairs.push([file, path]);
    }
  }
  return pairs;
}

/**
 * The folder whose filesystem decides for `relDir`: itself, or the nearest one above it that exists
 * (a folder the restore creates inherits how its parent treats names). Never above `root`.
 */
function nearestExistingDir(root: string, relDir: string): string {
  let dir = join(root, relDir);
  while (dir !== root && dir.startsWith(root + '/')) {
    try { if (lstatSync(dir).isDirectory()) return dir; } catch { /* not there yet: one up */ }
    dir = dirname(dir);
  }
  return root;
}

/**
 * Whether the filesystem holding `dir` folds names: one file written under a lower-case name with an
 * accent in NFC form, then looked up in upper case and in NFD form. Either lookup that finds it folds.
 */
export function filesystemFoldsNames(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  const base = `.lynox-fold-probe-${randomBytes(6).toString('hex')}-\u00e9a`;
  const probe = join(dir, base);
  writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  try {
    return exists(join(dir, base.toUpperCase())) || exists(join(dir, base.normalize('NFD')));
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * Why a live path cannot take an entry, checked before anything is staged: a symbolic link on the
 * way inside the data directory (writing through it would land outside), or a directory where the
 * backup has a file (the swap's rename would fail after earlier files were already replaced).
 */
/**
 * Remove what a crashed restore of an earlier version left in the folder `relDir` below the anchor,
 * without following a link: files and links of exactly `STAGING_TEMP`'s or the fold probe's shape.
 * Not recursive. Not the fd module's `.lynox-stage-` temps: the artifact store writes those in
 * `artifacts/` while it runs, and a restore's own are removed by `stageIn` when it fails. A folder
 * that is not there yet, or whose parent is not, holds nothing to remove.
 */
function removeStagingTemps(anchor: WorkspaceAnchor, relDir: string): void {
  if (relDir !== '') {
    let type: string | undefined;
    try {
      type = statEntry(anchor, relDir)?.type;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (type !== 'dir') return;
  }
  for (const e of listDir(anchor, relDir)) {
    if (e.type === 'dir') continue;
    if (!STAGING_TEMP.test(e.name) && !FOLD_PROBE_NAME.test(e.name)) continue;
    try {
      unlinkAt(anchor, relDir === '' ? e.name : `${relDir}/${e.name}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * The first pair of `paths` (relative to one root) that the filesystem takes for one name, asked in
 * the folder of each pair (a filesystem can fold per folder: ext4 `chattr +F`, per-directory case
 * sensitivity on NTFS). `folds(relDir)` answers for the nearest folder that exists; when it throws,
 * the pair comes back with the error's code. Null when no pair folds.
 */
function foldedPairOn(
  paths: readonly string[],
  nearest: (relDir: string) => string,
  folds: (dir: string) => boolean,
): { a: string; b: string; code?: string | null } | null {
  const seen = new Map<string, boolean>();
  for (const [a, b] of foldedPairs(paths)) {
    let foldsHere: boolean;
    try {
      const dir = nearest(dirname(a) === '.' ? '' : dirname(a));
      const known = seen.get(dir);
      foldsHere = known ?? folds(dir);
      seen.set(dir, foldsHere);
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      return { a, b, code: typeof code === 'string' ? code : null };
    }
    if (foldsHere) return { a, b };
  }
  return null;
}

/** The refusal for a pair `foldedPairOn` found: the filesystem folds them, or it could not be asked. */
function foldRefusal(pair: { a: string; b: string; code?: string | null }): string {
  const a = JSON.stringify(pair.a);
  const b = JSON.stringify(pair.b);
  if (pair.code !== undefined) {
    return `Could not check whether this machine's filesystem tells ${a} and ${b} apart${pair.code !== null ? ` (${pair.code})` : ''}, so the restore was refused; nothing was replaced. ` +
      `Check that lynox can create a file in the folder of ${a} (a full disk or a missing permission are the usual causes), then start the restore again.`;
  }
  return `This backup holds ${a} and ${b}, and this machine's filesystem takes them for one name: it does not tell upper from lower case, or two ways of writing the same letter, apart. ` +
    'Restoring would fail halfway, so the restore was refused; nothing was replaced. ' +
    'To restore this backup, use a machine whose filesystem tells these names apart (Linux usually does), or rename one of the two where the backup was made and back up again.';
}

/**
 * Stage `source` below `root` by name, where the platform has no fd-relative open (Windows): what a
 * restore did before it wrote through an anchor. Each file to a fresh temp beside its target
 * (exclusive), renamed over it on commit. A link set after the checks is followed here.
 */
function stageByName(root: string, source: Iterable<StageEntry>): StagedWrite {
  const staged: Array<{ tmp: string; dest: string }> = [];
  const removeTemps = (from: number): void => {
    for (const { tmp } of staged.slice(from)) { try { rmSync(tmp, { force: true }); } catch { /* best-effort */ } }
  };
  let bytes = 0;
  // Each folder is swept once, before this restore writes a temp into it: its own temps have the
  // shape the sweep removes.
  const swept = new Set<string>();
  try {
    for (const entry of source) {
      const dest = join(root, entry.rel);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (!swept.has(dirname(dest))) {
        swept.add(dirname(dest));
        for (const name of readdirSync(dirname(dest))) {
          if (STAGING_TEMP.test(name) && !lstatSync(join(dirname(dest), name)).isDirectory()) rmSync(join(dirname(dest), name), { force: true });
        }
      }
      const tmp = `${dest}.${randomBytes(8).toString('hex')}.restore-staging`;
      writeFileSync(tmp, entry.data, { mode: 0o600, flag: 'wx' });
      staged.push({ tmp, dest });
      bytes += entry.data.length;
    }
  } catch (err) {
    removeTemps(0);
    throw err;
  }
  let settled = false;
  return {
    files: staged.length,
    bytes,
    commit(): void {
      if (settled) throw new Error('staged write already committed or aborted');
      settled = true;
      for (let i = 0; i < staged.length; i++) {
        const { tmp, dest } = staged[i] as { tmp: string; dest: string };
        try {
          renameSync(tmp, dest);
        } catch (err) {
          removeTemps(i);
          throw err;
        }
      }
    },
    abort(): void {
      if (settled) return;
      settled = true;
      removeTemps(0);
    },
  };
}

/** An error's text without the fd paths the anchored writes go through: the user reads it, and they name no file. */
function withoutFdPaths(message: string): string {
  return message.replace(/\/(?:proc\/(?:self|thread-self|\d+)|dev)\/fd\/\d+(?:\/|(?=['"\s)]|$))/g, '');
}

/** The nearest folder below the anchor that exists, from `relDir` up; '' is the anchor itself. */
function nearestExistingRel(anchor: WorkspaceAnchor, relDir: string): string {
  let rel = relDir;
  while (rel !== '' && rel !== '.') {
    let type: string | undefined;
    try {
      type = statEntry(anchor, rel)?.type;
    } catch (err) {
      // A folder further up is missing too: one up.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (type === 'dir') return rel;
    const up = dirname(rel);
    rel = up === '.' ? '' : up;
  }
  return '';
}

/** The text of a restore refused because another one is running. */
export const RESTORE_RUNNING = 'A restore is already running, so this one was not started. Wait for the running restore: when it succeeds, the instance restarts. ' +
  'If the instance does not restart, the running restore did not succeed, and you can start a restore again.';

function liveTargetProblem(lynoxDir: string, entryPath: string): string | null {
  const parts = entryPath.split('/');
  let at = lynoxDir;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i] as string);
    let st;
    try {
      st = lstatSync(at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const last = i === parts.length - 1;
    if (!last && st.isSymbolicLink()) return `${parts.slice(0, i + 1).join('/')} is a link on this machine; the restore does not write through it`;
    if (!last && !st.isDirectory()) return `${parts.slice(0, i + 1).join('/')} is a file on this machine, the backup has a folder there`;
    if (last && st.isDirectory()) return `${entryPath} is a folder on this machine, the backup has a file there`;
  }
  return null;
}

export class BackupManager {
  private readonly lynoxDir: string;
  private readonly backupDir: string;
  private readonly retentionDays: number;
  private readonly encrypt: boolean;
  private readonly vaultKey: string | null;
  private _gdriveUploader: import('./backup-upload-gdrive.js').GDriveBackupUploader | null;
  private readonly _uploadAllowed: () => boolean;
  /** Backups and restores running now; read by the Art. 17 erasure, which refuses while one is. */
  private _running = 0;
  /**
   * Whether a restore is running. A second one is refused, not queued: it would take a second safety
   * backup of a data dir the first is about to replace, then replace it again, and the first one's
   * restart would cut it off. (Staging and swapping run without an await, so two restores in one
   * process do not interleave there; another process is not covered.)
   */
  private _restoring = false;
  /**
   * The list's provenance per backup, so `listBackups` does not canonicalize and MAC every manifest
   * on every call. Keyed by the backup's folder name; valid while the manifest's bytes hash to the
   * digest they were checked under. Bound to the content, not to the file's times: a write through
   * `mmap` into a page already dirty, or a write in the same tick of a coarse clock, changes
   * neither mtime nor ctime. Only the list reads it: a restore checks the manifest it is about to
   * act on afresh.
   */
  private readonly _listProvenance = new Map<string, { digest: string; provenance: BackupProvenance }>();

  constructor(lynoxDir: string, config: BackupConfig, vaultKey: string | null) {
    this.lynoxDir = lynoxDir;
    this.backupDir = config.backupDir;
    this.retentionDays = config.retentionDays;
    // `!!vaultKey`, not `vaultKey !== null`. The two differ on exactly one value — the empty
    // string — and they used to sit in different places: this line said `!== null`, while the
    // encryption pass in `createBackup` asks for a truthy key. `LYNOX_VAULT_KEY=` (set, empty)
    // survives the `?? null` in the engine as `''`, so with an explicit `backup_encrypt: true`
    // this field went true while nothing was encrypted. An empty string is not key material.
    this.encrypt = config.encrypt && !!vaultKey;
    this.vaultKey = vaultKey;
    this._gdriveUploader = config.gdriveUploader ?? null;
    this._uploadAllowed = config.uploadAllowed ?? (() => true);
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

  /**
   * Whether a backup or a restore is running. Both await between copying and finishing, so
   * one that started before the erasure would write the stores' old content back after it:
   * a backup into `backups/`, a restore into the data dir itself.
   */
  get busy(): boolean { return this._running > 0; }

  private _uploading = 0;
  private _uploadsPaused = 0;

  /** Whether a Drive upload is in flight right now — not a backup that might reach one later. */
  get uploading(): boolean { return this._uploading > 0; }

  /**
   * Hold back Drive uploads until the returned release is called. Disconnecting Google
   * deletes the uploaded backups and then revokes the token; a backup that uploaded in
   * between — after its folder was listed, before the token was gone — would leave a copy
   * the deletion never saw. A backup that reaches the upload step while this is held keeps
   * its local copy and skips the upload. Counted, so overlapping holds release correctly.
   */
  pauseUploads(): () => void {
    this._uploadsPaused++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._uploadsPaused--;
    };
  }

  async createBackup(): Promise<BackupResult> {
    this._running++;
    try {
      return await this._createBackup();
    } finally {
      this._running--;
    }
  }

  private async _createBackup(): Promise<BackupResult> {
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
    const skipped: string[] = [];
    let workspace: typeof OMITTED_SIDECAR | undefined;

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
        if (dirName === WORKSPACE) {
          const copied = this.copyWorkspaceOut(tmpDir, files);
          if (copied === OMITTED_SIDECAR) workspace = OMITTED_SIDECAR;
          else skipped.push(...copied);
          continue;
        }
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
      //
      // `this.encrypt` is safe to read as "this archive IS ciphertext" only because the
      // constructor derives it with the same predicate this branch asks for. An earlier draft
      // also carried a separate `didEncrypt`, set inside this branch, so the manifest would
      // record the pass rather than the intent. It was removed: with one predicate the two are
      // identical, no mutation could tell them apart, and a redundancy no test can see is worse
      // than none — it makes the coverage look larger than it is. The `&& this.vaultKey` below is
      // type narrowing for `deriveBackupKey`, not a second condition.
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
        ...(workspace !== undefined ? { coverage: { workspace } } : {}),
      };
      // Truthy, not `!== null`, as in the constructor: an empty string is not key material.
      if (this.vaultKey) {
        manifest.auth = { alg: 'hmac-sha256', mac: manifestMac({ ...manifest }, deriveManifestKey(this.vaultKey)) };
      }

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
      //
      // The conditions, each asked where it can change:
      //
      //   `_uploadAllowed()`   — the user's opt-in, evaluated HERE rather than at boot.
      //   `manifest.encrypted` — whether this archive is ciphertext.
      //   (tier)               — asked where `driveBackupAllowed()` is called, in `Engine.init`,
      //                          because it is derived from the environment and cannot change in
      //                          a running process. Deliberately NOT in `_uploadAllowed()` too:
      //                          checking it in both places was a compensating pair that no
      //                          single mutant could expose.
      //
      // ⚠ BEFORE REUSING THIS CLASS: an uploader attached by an EMBEDDER is gated by NEITHER of
      // them. Not by tier, which lives at the engine's wiring; and not by consent, because
      // `uploadAllowed` defaults to `() => true` for a caller that does not pass one — which is
      // the right default for someone who attaches an uploader deliberately, and the more
      // dangerous half to not know. What makes it safe inside this product is that the engine
      // passes the predicate and attaches nothing on a provisioned instance. An embedder gets
      // only the encryption condition for free.
      //
      // Why the opt-in is asked at upload time and not once at wiring: the engine's `init()` runs
      // once, so a gate there enforces "the setting was true at the last boot", not "the user
      // wants this now". Revoking `backup_gdrive` would have kept uploading until the process
      // restarted — fail-open, and the same class `_reconcileBugsink` exists to close for the
      // privacy toggle. A predicate handed in at construction reads the engine's live config on
      // every call, so a RELOAD takes effect at once and in both directions.
      //
      // ⚠ "A reload", precisely: nothing watches `config.json`. `Engine.reloadUserConfig` is what
      // makes a change live, and `PUT /api/config` is the route that calls it — so a change made
      // that way takes effect at once, and a HAND-EDITED file does not until something calls that
      // route or the process restarts. `features/backup.md` states both halves for users.
      //
      // Deliberately named rather than counted: every stale claim this file has carried was a
      // COUNT or a POSITION ("three ways", "exactly two callers", "the wiring below"). A sentence
      // that names a symbol can go incomplete; one that counts goes false.
      //
      // `manifest.encrypted` is the property and not a correlate because ONE predicate decides
      // encryption: the constructor's `config.encrypt && !!vaultKey` is exactly what step 5 acts
      // on. Reading the environment variable here would be the proxy — that answers whether a key
      // exists somewhere, not whether THIS archive was encrypted.
      //
      // ⚠ What "encrypted" does NOT cover: `manifest.json` is written in step 7, AFTER the
      // encryption pass, and the uploader walks the directory rather than `files[]`, so the
      // manifest goes up in the clear — file paths, sizes, checksums and the data directory's
      // absolute path. `features/backup.md` says so under "What Drive can see"; it is a property
      // of the design (the remote listing parses that manifest), not an oversight.
      if (this._gdriveUploader) {
        if (this._uploadsPaused > 0) {
          process.stderr.write(
            '[lynox:backup] Google Drive upload skipped — Google is being disconnected. '
            + 'The local backup is intact.\n',
          );
        } else if (!this._uploadAllowed()) {
          // Nothing to say: not opting in is the normal state, and a line here would fire on
          // every backup of every instance that never asked for an upload.
        } else if (!manifest.encrypted) {
          process.stderr.write(
            '[lynox:backup] Google Drive upload skipped — this backup is not encrypted. '
            + 'Set LYNOX_VAULT_KEY to a non-empty value (and do not set backup_encrypt to false) '
            + 'to upload. The local backup is intact.\n',
          );
        } else {
          // The result is NOT discarded, and that is the point: the real uploader does not throw
          // on a refusal — a missing `drive.file` scope, an API error and a network failure all
          // come back as `{ success: false, error }`. Discarding it made every genuine upload
          // failure silent while the code claimed its refusals were written, which is the same
          // defect one level up.
          this._uploading++;
          try {
            const result = await this._gdriveUploader.upload(finalDir, manifest);
            if (!result.success) {
              process.stderr.write(
                `[lynox:backup] Google Drive upload failed — local backup is intact: ${result.error ?? 'unknown error'}\n`,
              );
            }
          } catch (err: unknown) {
            // A throw is the unexpected path; the uploader reports refusals by return value.
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[lynox:backup] Google Drive upload failed — local backup is intact: ${msg}\n`);
          } finally {
            this._uploading--;
          }
        }
      }

      if (skipped.length > 0) {
        process.stderr.write(`[lynox:backup] ${String(skipped.length)} workspace entries are not in this backup (links, special files or names that are not UTF-8): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}\n`);
      }
      if (workspace !== undefined) {
        process.stderr.write('[lynox:backup] The workspace files are not in this backup: in shell sidecar mode lynox does not read the shared workspace tree. Back them up where the workspace is managed.\n');
      }
      return {
        success: true, path: finalDir, manifest, duration_ms: Date.now() - start,
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
      };
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

  /** Whether the filesystem holding `dir` folds names (`filesystemFoldsNames`); a seam for tests on one that does not. */
  protected namesFold(dir: string): boolean {
    return filesystemFoldsNames(dir);
  }

  async restoreBackup(backupPath: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    if (this._restoring) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: 0, code: 'restore_in_progress', error: RESTORE_RUNNING };
    }
    this._restoring = true;
    this._running++;
    try {
      return await this._restoreBackup(backupPath, options);
    } finally {
      this._running--;
      this._restoring = false;
    }
  }

  /** Whether the filesystem holding the workspace folder `relDir` folds names (`namesFoldAt`); a seam for tests. */
  protected workspaceNamesFold(anchor: WorkspaceAnchor, relDir: string): boolean {
    return namesFoldAt(anchor, relDir);
  }

  private async _restoreBackup(backupPath: string, options: RestoreOptions): Promise<RestoreResult> {
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

    if (manifest === null || typeof manifest !== 'object') {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: 'Invalid manifest.json' };
    }

    // Before anything reads or writes by an entry's path: the manifest is not authenticated, and
    // a backup downloaded from Drive carries whatever its root's writers put there.
    const unrestorable = unrestorableEntry(manifest.files);
    if (unrestorable !== null) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: `Backup manifest names a path outside the backup — refusing to restore: ${unrestorable}` };
    }

    // Written only where `isBackedUpEntryPath` allows. The rest is named in the result, not refused: a
    // backup holding a name the inventory has since renamed must stay restorable.
    const isWritten = (entry: BackupFileEntry): boolean => entry.type !== 'directory' && isBackedUpEntryPath(entry.path);
    const written = manifest.files.filter(isWritten);
    // A restore temp left in a backed-up directory is nobody's file: not written, not named.
    const skipped = manifest.files.filter(entry => entry.type !== 'directory' && !isWritten(entry) && !isTempName(entry.path)).map(entry => entry.path);
    const duplicate = duplicateEntry(written.map(entry => entry.path));
    if (duplicate !== null) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: `Backup manifest names a path twice — refusing to restore: ${JSON.stringify(duplicate)}` };
    }

    // The manifest decides what is written and whether it is decrypted, and anyone who can write
    // into the backup (or the Drive folder it came from) can write the manifest. Without a MAC
    // under this vault key, the restore needs the caller's explicit word.
    const provenance = this.provenanceOf(manifest);
    if (provenance !== 'verified' && options.allowUnverified !== true) {
      return {
        success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start,
        code: 'unverified_backup', provenance,
        error: `${UNVERIFIED_REASON[provenance]} Restore it only if you know where it came from, and confirm the restore without proof of origin.`,
      };
    }

    // In shell sidecar mode nothing is staged into the shared tree (PRD D7, walker 4). Decided by
    // CONTENT, on the manifest whose origin was just checked: a backup made in this mode holds no
    // workspace entries (walker 1) and stays restorable. Entries outside the manifest are never
    // staged, so a backup cannot hide workspace files from this check.
    if (shellIsolation().kind === 'sidecar' && written.some(entry => entry.path.startsWith(WORKSPACE_PREFIX))) {
      return {
        success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start,
        code: 'workspace_sidecar_mode', error: restoreRefusal(),
      };
    }

    // Refuse to restore an encrypted backup with no key: the decrypt branch
    // below would be skipped and the raw ciphertext copied OVER the live
    // plaintext DBs, silently corrupting them. Fail before touching anything.
    if (manifest.encrypted && !this.vaultKey) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: 'Backup is encrypted but no vault key is available — refusing to restore (would overwrite live data with ciphertext).' };
    }

    // Verify the backup's own integrity (size + checksum + SQLite integrity)
    // BEFORE overwriting any live file — a truncated/corrupt archive must never
    // be promoted over good data. Mirror createBackup's verify: skip the SQLite
    // integrity check for encrypted files (they are ciphertext on disk).
    const verifiableFiles = manifest.files.filter(f => f.type !== 'directory');
    const verifyFiles = manifest.encrypted
      ? verifiableFiles.map(f => (f.type === 'sqlite' ? { ...f, type: 'file' as const } : f))
      : verifiableFiles;
    const preVerify = verifyBackup(backupPath, verifyFiles);
    if (!preVerify.valid) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: `Backup verification failed — refusing to restore: ${preVerify.errors.slice(0, 3).join('; ')}` };
    }

    // Validate the decryption key BEFORE the destructive loop. All files share
    // one derived key, so a WRONG/rotated key (present, but not matching) fails
    // AES-GCM auth on the first decrypt — but only MID-loop, after earlier files
    // were already written over live DBs. Pre-flight one decrypt in memory
    // and refuse on failure, so a wrong key can't partially corrupt
    // live data. (checksum verify above can't detect this — the ciphertext is
    // intact; only the key is wrong.)
    if (manifest.encrypted && this.vaultKey) {
      const probe = manifest.files.find(
        e => e.type !== 'directory' && existsSync(join(backupPath, e.path)) && isEncryptedBackupFile(join(backupPath, e.path)),
      );
      if (probe) {
        try {
          // In memory: no plaintext beside the backup, and a read-only backup is not taken for a wrong key.
          decryptFileToBuffer(join(backupPath, probe.path), deriveBackupKey(this.vaultKey)).fill(0);
        } catch {
          return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: 'Backup decryption failed — the vault key does not match this backup; refusing to restore (avoids partially overwriting live data).' };
        }
      }
    }

    // Before the safety backup and before anything is staged: a target the swap could not take
    // would fail it halfway, after earlier files were already replaced. Both sets: `stageIn`
    // compares its paths as written.
    const dataDirEntries = written.filter(entry => !entry.path.startsWith(WORKSPACE_PREFIX));
    const workspaceEntries = written.filter(entry => entry.path.startsWith(WORKSPACE_PREFIX));
    const dataPair = foldedPairOn(
      dataDirEntries.map(entry => entry.path),
      relDir => nearestExistingDir(this.lynoxDir, relDir),
      dir => this.namesFold(dir),
    );
    if (dataPair !== null) {
      return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: foldRefusal(dataPair) };
    }
    // The workspace set is asked inside its root, through the root's anchor: the root may live
    // outside the data dir, on another filesystem. Only when a pair exists is the root made.
    const workspaceRels = workspaceEntries.map(entry => entry.path.slice(WORKSPACE_PREFIX.length));
    if (foldedPairs(workspaceRels).length > 0) {
      let workspacePair: ReturnType<typeof foldedPairOn>;
      try {
        const lease = leaseWorkspaceFor(this.lynoxDir, { create: true });
        if (lease === null) throw new Error('the workspace root could not be made');
        try {
          const anchor = lease.access.anchor;
          workspacePair = foldedPairOn(workspaceRels, relDir => nearestExistingRel(anchor, relDir), relDir => this.workspaceNamesFold(anchor, relDir));
        } finally {
          lease.release();
        }
      } catch (err: unknown) {
        const [a, b] = foldedPairs(workspaceRels)[0] as [string, string];
        const code = (err as { code?: unknown } | null)?.code;
        workspacePair = { a, b, code: typeof code === 'string' ? code : null };
      }
      if (workspacePair !== null) {
        const named = { ...workspacePair, a: `${WORKSPACE_PREFIX}${workspacePair.a}`, b: `${WORKSPACE_PREFIX}${workspacePair.b}` };
        return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: foldRefusal(named) };
      }
    }
    for (const entry of dataDirEntries) {
      const problem = liveTargetProblem(this.lynoxDir, entry.path);
      if (problem !== null) {
        return { success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: Date.now() - start, error: `Refusing to restore: ${problem}. Nothing was replaced.` };
      }
    }

    // Safety: attempt backup of current state before restore (best-effort, don't block restore on failure)
    let safetyPath = '';
    try {
      const safetyBackup = await this.createBackup();
      if (safetyBackup.success) {
        safetyPath = safetyBackup.path;
      }
      // If safety backup fails (e.g. corrupted DB from previous failed restore), proceed anyway
    } catch { /* safety backup is best-effort */ }

    try {
      let filesRestored = 0;
      const needsDecrypt = manifest.encrypted && this.vaultKey;
      const key = needsDecrypt ? deriveBackupKey(this.vaultKey!) : null;

      // Two-phase restore: STAGE every file to a sibling temp path first, then
      // SWAP them into place with atomic renames. The failure-prone work (decrypt
      // of a bad chunk, a copy hitting a full disk / I/O error) all runs in the
      // staging phase BEFORE any live file is touched — if staging throws, no
      // live file was written and the pre-restore safety backup remains the
      // recovery point. Each swap is atomic PER FILE (rename on the same
      // filesystem), so no single DB is ever left partial or half-written. A
      // crash between two renames could leave the SET half old / half new, but
      // every file stays individually consistent and the safety backup covers a
      // full recovery.
      // The data-dir set is written through a handle on the data dir, every folder on the way and
      // every file opened without following a link (`stageIn`), so a link set after the checks
      // above is refused, not written through. The handle is the data dir as resolved now.
      let dataStaged: StagedWrite | null = null;
      let workspaceStaged: { staged: StagedWrite; release: () => void } | null = null;
      let dataAnchor: WorkspaceAnchor | null;
      try {
        dataAnchor = openAnchor(realpathSync(this.lynoxDir));
      } catch (err) {
        if (!(err instanceof WorkspaceAccessError && err.code === 'UNSUPPORTED')) throw err;
        dataAnchor = null;
      }
      try {
        try {
          // Checked again here: the safety backup ran in between, and so may anything else.
          for (const entry of dataDirEntries) {
            const problem = liveTargetProblem(this.lynoxDir, entry.path);
            if (problem !== null) throw new Error(`Refusing to restore: ${problem}. Nothing was replaced.`);
          }
          const swept = new Set<string>();
          for (const entry of dataDirEntries) {
            const relDir = dirname(entry.path) === '.' ? '' : dirname(entry.path);
            if (dataAnchor !== null && !swept.has(relDir)) { removeStagingTemps(dataAnchor, relDir); swept.add(relDir); }
          }
          const source = function* (): Iterable<StageEntry> {
            for (const entry of dataDirEntries) {
              const raw = readEntryBytes(join(backupPath, entry.path), entry, manifest.encrypted === true);
              yield { rel: entry.path, data: key !== null ? decryptBuffer(raw, key, entry.path) : raw };
            }
          };
          dataStaged = dataAnchor !== null
            ? stageIn(dataAnchor, '', source(), { fileMode: 0o600, dirMode: 0o700 })
            : stageByName(this.lynoxDir, source());
          // Staged only once the data-dir set is, and committed only after it is swapped: a
          // failure in staging EITHER set leaves every live file as it was.
          if (workspaceEntries.length > 0) workspaceStaged = this.stageWorkspaceIn(backupPath, workspaceEntries, key);
        } catch (stageErr) {
          // Staging failed before any live file was touched: drop the data-dir set's temps
          // (`stageIn` removes its own when it fails) and abort the whole restore.
          dataStaged?.abort();
          throw stageErr;
        }

        // Swap phase: one rename per file over the live files, in their folders' handles. All
        // bytes are already staged on the same filesystem, so each rename is atomic.
        try {
          dataStaged.commit();
          filesRestored += dataStaged.files;
        } catch (swapErr) {
          // The workspace set was never committed: its temps go, its live files stay.
          workspaceStaged?.staged.abort();
          workspaceStaged?.release();
          throw swapErr;
        }
      } finally {
        if (dataAnchor !== null) closeAnchor(dataAnchor);
      }
      if (workspaceStaged !== null) {
        try {
          workspaceStaged.staged.commit();
          filesRestored += workspaceStaged.staged.files;
        } finally {
          workspaceStaged.release();
        }
      }

      // The view shows these once; a reload loses them, so they are also in the log.
      if (skipped.length > 0) {
        process.stderr.write(`[lynox:backup] restore did not write back ${String(skipped.length)} of the backup's entries (no current area matches their name; they stay in the backup): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}\n`);
      }
      return {
        success: true,
        pre_restore_backup_path: safetyPath,
        files_restored: filesRestored,
        duration_ms: Date.now() - start,
        skipped,
      };
    } catch (err: unknown) {
      return {
        success: false,
        pre_restore_backup_path: safetyPath,
        files_restored: 0,
        duration_ms: Date.now() - start,
        error: withoutFdPaths(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /**
   * The provenance the list shows for one backup: from the cache while the manifest's bytes hash to
   * `digest`, the digest they were checked under; checked afresh and kept otherwise. The digest and
   * the manifest come from the same read.
   */
  private listProvenance(name: string, digest: string, manifest: BackupManifest): BackupProvenance {
    const cached = this._listProvenance.get(name);
    if (cached !== undefined && cached.digest === digest) return cached.provenance;
    const provenance = this.provenanceOf(manifest);
    this._listProvenance.set(name, { digest, provenance });
    return provenance;
  }

  private provenanceOf(manifest: BackupManifest): BackupProvenance {
    if (!this.vaultKey) return 'no-key';
    const auth: unknown = manifest.auth;
    if (auth === undefined) return 'none';
    const mac = (auth as { alg?: unknown; mac?: unknown } | null)?.mac;
    if ((auth as { alg?: unknown } | null)?.alg !== 'hmac-sha256' || typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return 'mismatch';
    return manifestMacMatches(manifest as unknown as Record<string, unknown>, mac, deriveManifestKey(this.vaultKey)) ? 'verified' : 'mismatch';
  }

  // ── List ──

  /**
   * Every backup's manifest, newest first, with its `provenance`: the same check a restore makes,
   * so the list can say whether a backup's `coverage` (or its absence) is shown at all. An unsigned
   * manifest's `coverage` is whatever its writer put there.
   */
  listBackups(): BackupListEntry[] {
    if (!existsSync(this.backupDir)) return [];

    const entries = readdirSync(this.backupDir, { withFileTypes: true });
    const manifests: BackupListEntry[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.tmp')) continue; // skip incomplete backups
      const manifestPath = join(this.backupDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = readFileSync(manifestPath);
        const manifest = JSON.parse(raw.toString('utf-8')) as BackupManifest;
        const digest = createHash('sha256').update(raw).digest('hex');
        seen.add(entry.name);
        manifests.push({ ...manifest, backup_id: entry.name, provenance: this.listProvenance(entry.name, digest, manifest) });
      } catch {
        // Skip corrupt manifests
      }
    }
    // A backup that is gone takes its cached answer with it.
    for (const name of this._listProvenance.keys()) if (!seen.has(name)) this._listProvenance.delete(name);

    // Sort newest first
    manifests.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return manifests;
  }

  /** Resolve a backup ID (directory name) to its full path, or null if not found. */
  getBackupPath(backupId: string): string | null {
    const dir = join(this.backupDir, backupId);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    return dir;
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
      const unrestorable = unrestorableEntry(manifest.files);
      if (unrestorable !== null) return { valid: false, errors: [`Path outside the backup: ${unrestorable}`], files_checked: 0 };
      const verifiableFiles = manifest.files.filter(f => f.type !== 'directory');
      // The sqlite→file relabel, which this method used to omit while `createBackup` step 9 and
      // `restoreBackup` both carried it. One question asked in several places, and the one that
      // did not ask reported EVERY encrypted backup as invalid: `PRAGMA integrity_check` throws
      // "file is not a database". Public API (`src/index.ts`) with no in-repo caller, and BEFORE
      // this change its only tests RAN on an unencrypted manager, where the relabel is a no-op —
      // so nothing saw it. `backup-upload-opt-in.test.ts` now runs it on an encrypted archive.
      const checkFiles = manifest.encrypted
        ? verifiableFiles.map(f => (f.type === 'sqlite' ? { ...f, type: 'file' as const } : f))
        : verifiableFiles;
      return verifyBackup(backupPath, checkFiles);
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
      // Symlinks are skipped, not followed, and this is deliberately fixed HERE rather
      // than in one caller: it applies to every COPY_DIRS entry at once. Following one
      // would (a) copy whatever it points at INTO the backup as a plain file — and
      // backups are optionally uploaded to Google Drive — and (b) hard-fail the whole
      // backup on a dangling link or a link to a directory (ENOENT / ENOTSUP from
      // copyFileSync), losing every other file in the run. `isDirectory()` is dirent-
      // based, so a symlink-to-directory takes the file branch and hits exactly that.
      if (entry.isSymbolicLink()) continue;
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

  /**
   * Copy the workspace root into `<tmpDir>/workspace` through its anchor, appending the manifest
   * entries. Returns what was not copied (archive paths). A mount below the root or a file that
   * cannot be read fails the backup: it must not be silently incomplete.
   *
   * In shell sidecar mode it walks nothing and returns `OMITTED_SIDECAR` (PRD D7, walker 1): the
   * tree is shared with the pool uids, and the walk throws on the first directory one of them
   * closed, which would fail the data dir's backup with it. It never throws for the mode, so the
   * pre-update backup and the worker-loop tasks go on with the rest; the caller records it.
   */
  private copyWorkspaceOut(tmpDir: string, files: BackupFileEntry[], isolation: ShellIsolation = shellIsolation()): string[] | typeof OMITTED_SIDECAR {
    if (isolation.kind === 'sidecar') return OMITTED_SIDECAR;
    const lease = leaseWorkspaceFor(this.lynoxDir);
    if (lease === null) return [];
    try {
      const destDir = join(tmpDir, WORKSPACE);
      mkdirSync(destDir, { recursive: true, mode: 0o700 });
      files.push({ path: WORKSPACE, size_bytes: 0, checksum_sha256: '', type: 'directory' });
      // The data directory inside the root (a bind mount) would put every earlier backup into this one.
      const data = statSync(this.lynoxDir);
      const count = copyOut(lease.access.anchor, '', (rel, fd) => {
        const dest = join(destDir, rel);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFdToFile(fd, dest);
        files.push(this.fileEntry(tmpDir, `${WORKSPACE_PREFIX}${rel}`, 'file'));
      }, undefined, { dev: data.dev, ino: data.ino });
      return count.skipped.map(rel => `${WORKSPACE_PREFIX}${rel}`);
    } finally {
      lease.release();
    }
  }

  /**
   * Phase 1 of restoring the workspace set: every file is written as a temp beside its target
   * inside the root, nothing replaced yet. Stale temps of a crashed restore are removed first.
   */
  private stageWorkspaceIn(backupPath: string, entries: readonly BackupFileEntry[], key: Buffer | null, isolation: ShellIsolation = shellIsolation()): { staged: StagedWrite; release: () => void } {
    // Defence in depth behind the check in `_restoreBackup`: in sidecar mode nothing is staged
    // into the shared tree. Thrown in the staging phase, so no live file is touched.
    if (isolation.kind === 'sidecar') throw new Error(restoreRefusal());
    const lease = leaseWorkspaceFor(this.lynoxDir, { create: true });
    if (lease === null) throw new Error('the workspace root could not be made');
    const anchor = lease.access.anchor;
    const source = function* (): Iterable<StageEntry> {
      for (const entry of entries) {
        const srcFile = join(backupPath, entry.path);
        // Decrypted in memory: no plaintext beside the backup, which may be synced elsewhere.
        const raw = readEntryBytes(srcFile, entry, key !== null);
        const data = key !== null ? decryptBuffer(raw, key, entry.path) : raw;
        yield { rel: entry.path.slice(WORKSPACE_PREFIX.length), data };
      }
    };
    try {
      removeStaleStages(anchor, '');
      return { staged: stageIn(anchor, '', source(), { fileMode: 0o600, dirMode: 0o700 }), release: () => lease.release() };
    } catch (err) {
      lease.release();
      throw err;
    }
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

/** Copy an open file to a new file at `dest`, in chunks. */
function copyFdToFile(fd: number, dest: string): void {
  const out = openSync(dest, 'wx', 0o600);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      let off = 0;
      while (off < n) off += writeSync(out, buf, off, n - off);
      pos += n;
    }
  } finally {
    closeSync(out);
  }
}
