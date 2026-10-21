import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { leaseWorkspaceFor } from './workspace-access.js';
import { copyOutAsync, walk } from './workspace-fd.js';
import { TarWriter, USTAR_MAX_SIZE, fitsUstarName, paxRecord, tarNameProblem } from './tar-writer.js';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';

/**
 * The workspace in the Art. 15 / Art. 20 export. `GET /api/export` carries a manifest (what is
 * there, what was not read and why); `GET /api/export/workspace` streams the files as a tar.
 *
 * No file is left out silently: an entry that is not a regular file, whose name an extracting
 * tool could read as leaving its directory, or that is a hard link to one of the data directory's
 * credential files, is listed under `skipped`; an entry the engine cannot read under `unreadable`;
 * a file that changed while it was read under `changed_during_export`; and any of them sets
 * `may_be_incomplete`. Directories carry no content and are not listed: an empty one is not in
 * the archive. Backup and migration keep failing on an unreadable file; only this export asks the
 * walk to report such a file instead.
 */

/** The data-directory entry the archive is written to before it is streamed (one dir per request). */
export const EXPORT_STAGING_DIR = 'export-staging';
/** Name prefix of a request's own directory inside `EXPORT_STAGING_DIR`; the sweep removes only these. */
const REQUEST_DIR_PREFIX = 'workspace-';
/** The archive's entries sit below this directory; the manifest sits beside it. */
export const ARCHIVE_WORKSPACE_DIR = 'workspace';
export const ARCHIVE_MANIFEST_NAME = 'workspace-manifest.json';
/** Kept free beyond the archive: the data disk is shared with the stores. */
const SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;
/** Free space below which a running copy stops, for the same reason. */
const SPACE_FLOOR_BYTES = 32 * 1024 * 1024;
/** How many bytes a copy writes between two looks at the free space: below the floor, so no stretch between two looks can reach the floor from above it. */
const SPACE_RECHECK_BYTES = 16 * 1024 * 1024;

const statfsFree = (path: string): number => {
  const fs = statfsSync(path);
  return Number(fs.bavail) * Number(fs.bsize);
};
let freeBytes = statfsFree;
/** Test seam: the free bytes of the disk holding `path`. */
export function _setFreeBytesForTesting(probe: ((path: string) => number) | null): void {
  freeBytes = probe ?? statfsFree;
}

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
  /** Symlinks, FIFOs, sockets, devices, names that are not UTF-8 or not safe to extract, links to credentials: listed, never copied. */
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

/** Yield to the event loop, so a walk over many files does not stall every other request. */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * dev:ino of the data-directory files that hold a credential or a key (`secret` in the inventory).
 * A workspace file that IS one of them (a hard link) is not exported: the workspace is
 * agent-writable, and the export is meant to be handed on.
 */
export function secretInodes(dataDir: string): Set<string> {
  const out = new Set<string>();
  const add = (path: string, depth: number): void => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (st.isFile()) { out.add(`${st.dev}:${st.ino}`); return; }
    // A secret directory (backups, raw captures): its files, a few levels down, never through a link.
    if (st.isDirectory() && depth < 4) {
      let names: string[] = [];
      try { names = readdirSync(path); } catch { /* unreadable: nothing to match */ }
      for (const name of names) add(join(path, name), depth + 1);
    }
  };
  for (const e of DATA_DIR_INVENTORY) {
    if (!e.secret) continue;
    const names = e.kind === 'sqlite' ? [e.name, `${e.name}-wal`, `${e.name}-shm`, `${e.name}-journal`] : [e.name];
    for (const name of names) add(join(dataDir, name), 0);
  }
  return out;
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
    const secrets = secretInodes(dataDir);
    const files: WorkspaceManifestFile[] = [];
    const skipped: string[] = [];
    for (const e of listing.entries) {
      if (e.type === 'dir') continue;
      if (e.type === 'file' && e.exactName && tarNameProblem(e.rel) === null && !secrets.has(`${e.dev}:${e.ino}`)) files.push({ path: e.rel, size: e.size });
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
 * Whether the staging directory `dir` exists, made 0700 when missing (with `create`). Refused when
 * it is anything but a real directory of this process's own uid: a link there would point the
 * archive, and the boot sweep's removals, at whatever it names.
 */
function checkStagingDir(dir: string, create: boolean): boolean {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    if (!create) return false;
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`${EXPORT_STAGING_DIR} in the data directory is not a directory of this process; remove it to export`);
  }
  return true;
}

/**
 * Remove every request directory left in the staging directory. A request removes its own when it
 * ends; a process that died mid-export left one behind, and nothing else would ever remove it.
 * Run at start, before any export can be in flight. Only names a request made are removed, and
 * nothing at all when the staging directory is not this process's own. Returns how many were removed.
 */
export function sweepExportStaging(dataDir: string): number {
  const dir = join(dataDir, EXPORT_STAGING_DIR);
  if (!checkStagingDir(dir, false)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(REQUEST_DIR_PREFIX)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Thrown when the staging disk cannot hold the archive: before anything is written, or mid-copy. */
export class ExportSpaceError extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super(`not enough disk space to stage the workspace export: about ${needed} bytes needed, ${available} available`);
    this.name = 'ExportSpaceError';
  }
}

/** What the tar spends on one file beyond its bytes, at most, as `TarWriter` writes it: pax header and records, ustar header, padding. */
export function tarOverheadFor(path: string, size: number): number {
  const name = `${ARCHIVE_WORKSPACE_DIR}/${path}`;
  let records = 0;
  if (!fitsUstarName(name)) records += paxRecord('path', name).length;
  if (size > USTAR_MAX_SIZE) records += paxRecord('size', String(size)).length;
  const pax = records === 0 ? 0 : 512 + Math.ceil(records / 512) * 512;
  return pax + 512 + 511;
}

/** An upper bound on the archive for a described workspace: every entry with its overhead, the manifest, the end blocks. */
export function archiveBound(described: WorkspaceManifest): number {
  let n = 1024;
  let perFile = 0;
  for (const f of described.files) {
    n += f.size + tarOverheadFor(f.path, f.size);
    // The written manifest adds a sha256 with its key to every file, and may list it again under
    // `changed_during_export`.
    perFile += 96 + Buffer.byteLength(JSON.stringify(f.path), 'utf8') + 8;
  }
  const manifest = Buffer.byteLength(JSON.stringify(described, null, 2), 'utf8') + perFile;
  return n + manifest + 512 + 511 + 2048;
}

/** A request's own staging directory (0700, unique) and the archive path inside it (written 0600). */
export interface StagedArchive {
  readonly dir: string;
  readonly path: string;
}

/**
 * Make a request's staging directory after checking that the disk can hold `bound` bytes (see
 * `archiveBound`) plus headroom. Fails closed with `ExportSpaceError` rather than filling the disk.
 */
export function stageArchive(dataDir: string, bound: number): StagedArchive {
  const staging = join(dataDir, EXPORT_STAGING_DIR);
  checkStagingDir(staging, true);
  const available = freeBytes(staging);
  const needed = bound + SPACE_HEADROOM_BYTES;
  if (needed > available) throw new ExportSpaceError(needed, available);
  const dir = mkdtempSync(join(staging, REQUEST_DIR_PREFIX));
  return { dir, path: join(dir, 'workspace.tar') };
}

/**
 * Write the workspace as a tar to `archivePath` (created 0600, must not exist), the manifest as
 * its last entry. Returns the manifest. A mount below the root or the data directory inside it
 * throws (`WorkspaceAccessError`), as for a backup: the archive would not be the workspace. Yields
 * to the event loop for every file and every chunk; the walk before the first file runs in one go.
 * Looks at the free space again as it writes, and stops with `ExportSpaceError` before the disk
 * the stores share runs full (files may grow after the check before the copy).
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
      const secrets = secretInodes(dataDir);
      const files: WorkspaceManifestFile[] = [];
      const unreadable: Array<{ path: string; code: string }> = [];
      const withheld: string[] = [];
      const changed: string[] = [];
      let sinceCheck = 0;
      const count = await copyOutAsync(lease.access.anchor, '', async (rel, src, size) => {
        await turn();
        const st = fstatSync(src);
        if (tarNameProblem(rel) !== null || secrets.has(`${st.dev}:${st.ino}`)) { withheld.push(rel); return; }
        sinceCheck += size + tarOverheadFor(rel, size);
        if (sinceCheck >= SPACE_RECHECK_BYTES) {
          sinceCheck = 0;
          const available = freeBytes(archivePath);
          if (available < SPACE_FLOOR_BYTES + size) throw new ExportSpaceError(SPACE_FLOOR_BYTES + size, available);
        }
        const written = await tar.addFile(`${ARCHIVE_WORKSPACE_DIR}/${rel}`, src, size, st.mtimeMs / 1000);
        files.push({ path: rel, size, sha256: written.sha256 });
        if (!written.unchanged) changed.push(rel);
      }, dataDirKey(dataDir), (path, code) => unreadable.push({ path, code }));
      const skipped = [...count.skipped, ...withheld];
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
