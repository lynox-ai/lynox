import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { leaseWorkspaceFor } from './workspace-access.js';
import { copyOutAsync, walk } from './workspace-fd.js';
import { TarWriter, tarNameProblem } from './tar-writer.js';

/**
 * The workspace in the Art. 15 / Art. 20 export. `GET /api/export` carries a manifest (what is
 * there, what was not read and why); `GET /api/export/workspace` streams the files as a tar.
 *
 * No file is left out silently: an entry that is not a regular file, or whose name an extracting
 * tool could read as leaving its directory, is listed under `skipped`, an entry the engine cannot
 * read under `unreadable`, a file that changed while it was read under `changed_during_export`, and
 * any of them sets `may_be_incomplete`. Directories carry no content and are not listed: an empty
 * one is not in the archive. Backup and migration keep
 * failing on an unreadable file; only this export asks the walk to report such a file instead.
 */

/** The data-directory entry the archive is written to before it is streamed (one dir per request). */
export const EXPORT_STAGING_DIR = 'export-staging';
/** Name prefix of a request's own directory inside `EXPORT_STAGING_DIR`. */
const REQUEST_DIR_PREFIX = 'workspace-';
/** The archive's entries sit below this directory; the manifest sits beside it. */
export const ARCHIVE_WORKSPACE_DIR = 'workspace';
export const ARCHIVE_MANIFEST_NAME = 'workspace-manifest.json';
/** Headroom beyond the archive's own size: the manifest, and the disk not running full. */
const SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;
/** What one file costs in the tar beyond its bytes, at most: a pax header block with its record, the ustar header, and padding. */
const PER_FILE_OVERHEAD_BYTES = 3 * 512 + 511;

export interface WorkspaceManifestFile {
  readonly path: string;
  readonly size: number;
  /** Only in the archive's manifest, which hashes what it wrote. */
  readonly sha256?: string;
}

export interface WorkspaceManifest {
  /** False when there is no workspace root (nothing was ever written there). */
  readonly present: boolean;
  readonly files: WorkspaceManifestFile[];
  readonly bytes: number;
  /** Symlinks, FIFOs, sockets, devices, names that are not UTF-8 or not safe to extract: listed, never followed or copied. */
  readonly skipped: string[];
  /** Entries the engine could not read, with the error code. */
  readonly unreadable: Array<{ readonly path: string; readonly code: string }>;
  /** Files that changed while they were copied (shrank, grew, rewritten): the entry may not match the file. */
  readonly changed_during_export: string[];
  /** Set when any of the three lists above is not empty, or when the workspace could not be listed. */
  readonly may_be_incomplete: boolean;
  /** Why the workspace could not be listed at all (a moved root, a mount below it). */
  readonly error?: string;
}

const EMPTY: WorkspaceManifest = { present: false, files: [], bytes: 0, skipped: [], unreadable: [], changed_during_export: [], may_be_incomplete: false };

function dataDirKey(dataDir: string): { dev: number; ino: number } {
  const st = statSync(dataDir);
  return { dev: st.dev, ino: st.ino };
}

/**
 * What the workspace holds, without reading file content: for the JSON export. A mount below the
 * root or the data directory inside it is reported as `error`, like the archive refuses them.
 */
export function describeWorkspace(dataDir: string): WorkspaceManifest {
  const lease = leaseWorkspaceFor(dataDir);
  if (lease === null) return EMPTY;
  try {
    const unreadable: Array<{ path: string; code: string }> = [];
    const listing = walk(lease.access.anchor, '', undefined, dataDirKey(dataDir), (path, code) => unreadable.push({ path, code }));
    if (listing.mountBoundaries.length > 0 || listing.watchedAt.length > 0) {
      return { ...EMPTY, present: true, may_be_incomplete: true, error: listing.mountBoundaries.length > 0 ? 'MOUNT' : 'OVERLAP' };
    }
    const files: WorkspaceManifestFile[] = [];
    const skipped: string[] = [];
    for (const e of listing.entries) {
      if (e.type === 'dir') continue;
      if (e.type === 'file' && e.exactName && tarNameProblem(e.rel) === null) files.push({ path: e.rel, size: e.size });
      else skipped.push(e.rel);
    }
    return {
      present: true, files, bytes: files.reduce((n, f) => n + f.size, 0), skipped, unreadable, changed_during_export: [],
      may_be_incomplete: skipped.length > 0 || unreadable.length > 0,
    };
  } finally {
    lease.release();
  }
}

/**
 * Remove every request directory left in the staging directory. A request removes its own when it
 * ends; a process that died mid-export left one behind, and nothing else would ever remove it.
 * Run at start, before any export can be in flight. Returns how many were removed.
 */
export function sweepExportStaging(dataDir: string): number {
  const dir = join(dataDir, EXPORT_STAGING_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    rmSync(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Thrown before anything is written when the staging disk cannot hold the archive. */
export class ExportSpaceError extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super(`not enough disk space to stage the workspace export: about ${needed} bytes needed, ${available} available`);
    this.name = 'ExportSpaceError';
  }
}

/** A request's own staging directory (0700, unique) and the archive path inside it (written 0600). */
export interface StagedArchive {
  readonly dir: string;
  readonly path: string;
}

/**
 * Make a request's staging directory after checking that the disk can hold an archive of `files`
 * files of `bytes` bytes in all, plus headroom. Fails closed with `ExportSpaceError` rather than
 * filling the disk.
 */
export function stageArchive(dataDir: string, bytes: number, files: number): StagedArchive {
  const staging = join(dataDir, EXPORT_STAGING_DIR);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const fs = statfsSync(staging);
  const available = Number(fs.bavail) * Number(fs.bsize);
  const needed = bytes + files * PER_FILE_OVERHEAD_BYTES + SPACE_HEADROOM_BYTES;
  if (needed > available) throw new ExportSpaceError(needed, available);
  const dir = mkdtempSync(join(staging, REQUEST_DIR_PREFIX));
  return { dir, path: join(dir, 'workspace.tar') };
}

/**
 * Write the workspace as a tar to `archivePath` (created 0600, must not exist), the manifest as
 * its last entry. Returns the manifest. A mount below the root or the data directory inside it
 * throws (`WorkspaceAccessError`), as for a backup: the archive would not be the workspace.
 * Yields to the event loop while it copies; the walk before the first file runs in one go.
 */
export async function writeWorkspaceArchive(dataDir: string, archivePath: string): Promise<WorkspaceManifest> {
  const fd = openSync(archivePath, 'wx', 0o600);
  try {
    const tar = new TarWriter(fd);
    const lease = leaseWorkspaceFor(dataDir);
    if (lease === null) {
      tar.addBuffer(ARCHIVE_MANIFEST_NAME, Buffer.from(JSON.stringify(EMPTY, null, 2)), Date.now() / 1000);
      tar.finish();
      return EMPTY;
    }
    try {
      const files: WorkspaceManifestFile[] = [];
      const unreadable: Array<{ path: string; code: string }> = [];
      const unsafe: string[] = [];
      const changed: string[] = [];
      const count = await copyOutAsync(lease.access.anchor, '', async (rel, src, size) => {
        if (tarNameProblem(rel) !== null) { unsafe.push(rel); return; }
        const written = await tar.addFile(`${ARCHIVE_WORKSPACE_DIR}/${rel}`, src, size, fstatSync(src).mtimeMs / 1000);
        files.push({ path: rel, size, sha256: written.sha256 });
        if (!written.unchanged) changed.push(rel);
      }, dataDirKey(dataDir), (path, code) => unreadable.push({ path, code }));
      const skipped = [...count.skipped, ...unsafe];
      const manifest: WorkspaceManifest = {
        present: true, files, bytes: files.reduce((n, f) => n + f.size, 0), skipped, unreadable, changed_during_export: changed,
        may_be_incomplete: skipped.length > 0 || unreadable.length > 0 || changed.length > 0,
      };
      tar.addBuffer(ARCHIVE_MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2)), Date.now() / 1000);
      tar.finish();
      return manifest;
    } finally {
      lease.release();
    }
  } finally {
    closeSync(fd);
  }
}
