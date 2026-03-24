import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: fileMode });
  chmodSync(tmpPath, fileMode);
  renameSync(tmpPath, filePath);
  chmodSync(filePath, fileMode);
}
