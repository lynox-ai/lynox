import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DIR_MODE_PRIVATE, FILE_MODE_PRIVATE } from './constants.js';

export interface AtomicWriteOptions {
  fileMode?: number | undefined;
  dirMode?: number | undefined;
}

export function ensureDirSync(dir: string, mode = DIR_MODE_PRIVATE): string {
  mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export async function ensureDir(dir: string, mode = DIR_MODE_PRIVATE): Promise<string> {
  await mkdir(dir, { recursive: true, mode });
  return dir;
}

export function writeFileAtomicSync(
  filePath: string,
  content: string,
  options?: AtomicWriteOptions,
): void {
  const fileMode = options?.fileMode ?? FILE_MODE_PRIVATE;
  const dirMode = options?.dirMode ?? DIR_MODE_PRIVATE;
  ensureDirSync(dirname(filePath), dirMode);

  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  // Write AND fsync the temp file's data before the rename. `writeFileSync`
  // alone does not flush to disk, so a crash/power-loss between the write and
  // the OS flush could leave a zero-length or torn file that the atomic rename
  // then promotes — defeating the durability the atomic write promises.
  const fd = openSync(tmpPath, 'w', fileMode);
  try {
    writeFileSync(fd, content, { encoding: 'utf-8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, fileMode);
  renameSync(tmpPath, filePath);
  chmodSync(filePath, fileMode);
  // Durably flush the parent directory entry so the rename itself survives a
  // crash. Best-effort: some platforms/filesystems reject a directory fsync
  // (EINVAL/EPERM/EISDIR); a failure here doesn't undo the write, so ignore it.
  try {
    const dirFd = openSync(dirname(filePath), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync unsupported on this platform — ignore */ }
}
