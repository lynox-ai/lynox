/**
 * The file area with isolation (server, managed): the `/api/files` routes and the chat upload reach
 * it only through the context workspace's open directory, one component at a time with
 * O_NOFOLLOW, never by name after a check. A link in the area is not followed, wherever it points.
 * Without isolation every function here answers null and the caller keeps its old path.
 */
import { closeSync, fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIR_MODE_PRIVATE, FILE_MODE_PRIVATE } from './constants.js';
import { chatUploadRel, persistChatUpload } from './workspace.js';
import { toWorkspaceRel, workspaceBase, WorkspacePathRefused } from './workspace-rel.js';
import { sidecarWriteModes } from './workspace-write-modes.js';
import {
  listDir, openRead, statEntry, unlinkAt, writeFileAt, WorkspaceAccessError,
  type EntryInfo, type WorkspaceAnchor,
} from './workspace-fd.js';

export interface AreaTarget {
  readonly anchor: WorkspaceAnchor;
  /** Relative to the area; `''` is the area itself. */
  readonly rel: string;
  /** The path as the area names it, for messages. */
  readonly shown: string;
}

/** Why a route refuses: its HTTP status and the message it answers with. */
export class AreaRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AreaRefusal';
  }
}

const OUTSIDE = (): AreaRefusal => new AreaRefusal(403, 'Outside workspace');

/**
 * Map a path the client sent onto the area: null without isolation; an {@link AreaRefusal} (403)
 * outside it or through a process handle. Resolved against the area, as `resolveFileAreaPath` does.
 */
export function areaTarget(input: string): AreaTarget | null {
  const base = workspaceBase();
  if (base === null) return null;
  let mapped;
  try {
    mapped = toWorkspaceRel(resolve(base.ws, input), base.ws);
  } catch (err) {
    if (err instanceof WorkspacePathRefused || err instanceof WorkspaceAccessError) throw OUTSIDE();
    throw err;
  }
  if (mapped.kind !== 'inside') throw OUTSIDE();
  return { anchor: base.anchor, rel: mapped.rel, shown: mapped.shown };
}

/**
 * A refusal of the walk on the way to an entry. A link anywhere on the way, or a file used as a
 * directory, is answered like a path outside: the answer must not tell what lies behind a link.
 */
function onTheWay(err: unknown): AreaRefusal | null {
  if (err instanceof WorkspaceAccessError && (err.code === 'SYMLINK' || err.code === 'NOT_DIR')) return OUTSIDE();
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new AreaRefusal(404, 'Not found');
  return null;
}

/**
 * The entries of a directory in the area (lstat, no follow). An entry whose name is not exact
 * UTF-8 (`exactName` false) cannot be addressed afterwards; the caller decides how to show it.
 */
export function listArea(t: AreaTarget): EntryInfo[] {
  let st;
  try {
    st = statEntry(t.anchor, t.rel);
  } catch (err) {
    throw onTheWay(err) ?? err;
  }
  if (st === null) throw new AreaRefusal(404, 'Directory not found');
  if (st.type === 'symlink') throw OUTSIDE();
  if (st.type !== 'dir') throw new AreaRefusal(400, 'Not a directory');
  try {
    return listDir(t.anchor, t.rel);
  } catch (err) {
    throw onTheWay(err) ?? err;
  }
}

/**
 * Open a regular file in the area for reading, refusing a link, a non-file and a file with a
 * second name (the other name may be outside the area). The caller closes the fd.
 */
export function openAreaFile(t: AreaTarget, maxBytes: number, tooLarge: string): { fd: number; size: number } {
  // The area itself is a directory.
  if (t.rel === '') throw new AreaRefusal(400, 'Not a file');
  let fd: number;
  try {
    fd = openRead(t.anchor, t.rel);
  } catch (err) {
    if (err instanceof WorkspaceAccessError && err.code === 'NOT_FILE') throw new AreaRefusal(400, 'Not a file');
    throw onTheWay(err) ?? new AreaRefusal(404, 'File not found');
  }
  try {
    const st = fstatSync(fd);
    if (st.nlink > 1) throw new AreaRefusal(403, 'The file has more than one name (a hard link)');
    if (st.size > maxBytes) throw new AreaRefusal(413, tooLarge);
    return { fd, size: st.size };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** A text file in the area, read from the open file and bounded while reading, not only at open. */
export function readAreaText(t: AreaTarget, maxBytes: number, tooLarge: string): string {
  const { fd } = openAreaFile(t, maxBytes, tooLarge);
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, len);
      if (n === 0) break;
      len += n;
      if (len > maxBytes) throw new AreaRefusal(413, tooLarge);
    }
    return buf.subarray(0, len).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove a regular file, or a link itself, from the area. A link is never followed: `unlinkat`
 * removes the name, not what it points to. A file with a second name loses only this one.
 */
export function deleteAreaFile(t: AreaTarget): void {
  let st;
  try {
    st = statEntry(t.anchor, t.rel);
  } catch (err) {
    throw onTheWay(err) ?? new AreaRefusal(404, 'File not found');
  }
  if (st === null) throw new AreaRefusal(404, 'File not found');
  if (st.type !== 'file' && st.type !== 'symlink') throw new AreaRefusal(400, 'Not a file');
  unlinkAt(t.anchor, t.rel);
}

/**
 * {@link persistChatUpload} with isolation: stored through the area's open directory, private as
 * before (0600 in 0700 directories) and atomically (temp file, fsync, rename). In sidecar mode the
 * shell must read it, so it takes the sidecar's modes and group instead (`workspace-write-modes.ts`).
 * Null when it cannot be written, so the caller falls back to inlining the upload, as before.
 */
export function persistChatUploadInArea(fileName: string, text: string): { rel: string; abs: string } | null {
  let t: AreaTarget | null;
  try {
    t = areaTarget(chatUploadRel(fileName));
  } catch {
    return null;
  }
  if (t === null) return persistChatUpload(fileName, text);
  try {
    // In sidecar mode `bash` must read an upload: the layout's modes and group, not private ones.
    const sidecar = sidecarWriteModes();
    writeFileAt(t.anchor, t.rel, text, sidecar ?? { fileMode: FILE_MODE_PRIVATE, dirMode: DIR_MODE_PRIVATE });
  } catch {
    return null;
  }
  return { rel: t.rel, abs: t.shown };
}
