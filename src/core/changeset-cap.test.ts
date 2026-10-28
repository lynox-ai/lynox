import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * After the run's writes, the review reads each tracked file again: to show it, to tell a changed
 * file from an unchanged one, and to tell the run's own added file from one put there since.
 * Another writer can put a file of any size under a tracked path, so none of these reads goes past
 * the file tools' read cap. A file over it is never taken for unchanged: the review shows it as
 * changed, with its size before and now, and a rollback still restores the original. Every case
 * runs through the context workspace's open directory (`anchor`) and by name (`name`).
 */

/** Bytes read from open files, through `readSync` (the capped read) or `readFileSync(fd)` (a whole read). */
const reads = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readSync: ((...args: unknown[]) => {
      const n = (real.readSync as (...a: unknown[]) => number)(...args);
      reads.bytes += n;
      return n;
    }) as typeof real.readSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const out = (real.readFileSync as (...a: unknown[]) => Buffer | string)(path, ...rest);
      if (typeof path === 'number') reads.bytes += out.length;
      return out;
    }) as typeof real.readFileSync,
  };
});

import { ChangesetManager } from './changeset.js';
import { _resetCache as resetWorkspaceCache, clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { FILE_TOOL_READ_CAP_BYTES } from './workspace-fd.js';

type Branch = 'anchor' | 'name';

const CAP = FILE_TOOL_READ_CAP_BYTES;
/** The size of the planted file: twenty times the cap, so a whole read shows in the count. */
const HUGE = CAP * 20;
/** What one capped read may take: the cap, plus the one chunk that crosses it. */
const CAPPED_READ = CAP + 64 * 1024;

let data: string;
let ws: string;
let mgr: ChangesetManager;

function setup(branch: Branch): void {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'cs-cap-')));
  vi.stubEnv('LYNOX_DATA_DIR', data);
  vi.stubEnv('LYNOX_WORKSPACE', '');
  ws = join(data, 'workspace');
  mkdirSync(ws);
  resetWorkspaceCache();
  if (branch === 'anchor') setTenantWorkspace(ws);
  mgr = new ChangesetManager(ws, 'run');
}

/** What write_file does with the review on. */
function writeAsTheRun(path: string, text: string): void {
  mgr.backupBeforeWrite(path);
  writeFileSync(path, text);
  mgr.recordWritten(path);
}

/** Another writer replaces the file at `path` by a new, sparse one of `size` bytes. */
function plant(path: string, size: number): void {
  writeFileSync(`${path}.planted`, '');
  truncateSync(`${path}.planted`, size);
  renameSync(`${path}.planted`, path);
}

/** The bytes `op` read from open files. */
function bytesReadBy(op: () => void): number {
  reads.bytes = 0;
  op();
  return reads.bytes;
}

afterEach(() => {
  mgr.cleanup();
  closeWorkspaceBase();
  clearTenantWorkspace();
  vi.unstubAllEnvs();
  resetWorkspaceCache();
  rmSync(data, { recursive: true, force: true });
});

describe.each<Branch>(['anchor', 'name'])('the reads after a write, %s branch', (branch) => {
  beforeEach(() => setup(branch));

  it(`[${branch}] a modified file swapped for one over the cap is shown as changed, with both sizes, without being read whole`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    let changes: ReturnType<ChangesetManager['getChanges']> = [];
    expect(bytesReadBy(() => { changes = mgr.getChanges(); }), 'getChanges reads at most the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
    expect(changes[0]!.diff).toBe(
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Before the run it was 8 bytes.)',
    );
    expect(bytesReadBy(() => { expect(mgr.hasChanges()).toBe(true); }), 'hasChanges reads at most the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(bytesReadBy(() => { expect(mgr.size).toBe(1); }), 'size reads at most the cap').toBeLessThanOrEqual(CAPPED_READ);
  });

  it(`[${branch}] settle keeps a modified file over the cap, and the rollback restores the original`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    expect(bytesReadBy(() => mgr.settle()), 'settle reads at most the cap per file').toBeLessThanOrEqual(2 * CAPPED_READ);
    expect(mgr.isEmpty(), 'not dropped as unchanged').toBe(false);
    expect(mgr.getChanges().map((c) => c.file)).toEqual(['notes.txt']);

    mgr.rollbackAll();
    expect(readFileSync(path, 'utf-8')).toBe('original');
  });

  it(`[${branch}] an added file swapped for one over the cap is shown as new, and the rollback leaves it`, () => {
    const path = join(ws, 'new.txt');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    let changes: ReturnType<ChangesetManager['getChanges']> = [];
    expect(bytesReadBy(() => { changes = mgr.getChanges(); })).toBeLessThanOrEqual(CAPPED_READ);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('added');
    expect(changes[0]!.diff).toBe(
      '--- /dev/null\n+++ b/new.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. It did not exist before the run.)',
    );

    expect(bytesReadBy(() => mgr.settle())).toBeLessThanOrEqual(2 * CAPPED_READ);
    expect(mgr.isEmpty(), 'not dropped as unchanged').toBe(false);
    expect(bytesReadBy(() => mgr.rollbackAll()), 'the rollback reads at most the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(statSync(path).size, 'another writer\'s file is not deleted').toBe(HUGE);
  });

  it(`[${branch}] a file over the cap when the run's write is recorded is never taken for the run's own`, () => {
    const path = join(ws, 'new.txt');
    mgr.backupBeforeWrite(path);
    writeFileSync(path, 'the run wrote this');
    plant(path, HUGE);

    expect(bytesReadBy(() => mgr.recordWritten(path)), 'recordWritten reads at most the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(bytesReadBy(() => mgr.rollbackAll())).toBeLessThanOrEqual(CAPPED_READ);
    expect(existsSync(path), 'a file whose bytes were not compared is not deleted').toBe(true);
    expect(statSync(path).size).toBe(HUGE);
  });

  it(`[${branch}] a file of exactly the cap is still read and diffed, and the run's added file still rolled back (control)`, () => {
    const modified = join(ws, 'notes.txt');
    writeFileSync(modified, 'original\n');
    writeAsTheRun(modified, 'x'.repeat(CAP - 1) + '\n');
    const added = join(ws, 'new.txt');
    writeAsTheRun(added, 'y'.repeat(CAP));

    const changes = mgr.getChanges();
    expect(changes.map((c) => c.file).sort()).toEqual(['new.txt', 'notes.txt']);
    for (const c of changes) expect(c.diff).not.toContain('Content not compared');
    expect(changes.find((c) => c.file === 'notes.txt')!.diff).toContain('-original');

    mgr.rollbackAll();
    expect(readFileSync(modified, 'utf-8')).toBe('original\n');
    expect(existsSync(added), 'the run\'s own file of exactly the cap is deleted').toBe(false);
  });
});
