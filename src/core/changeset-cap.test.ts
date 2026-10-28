import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, openSync, writeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
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

/** Bytes read, through `readSync` (the capped read) or `readFileSync` (a whole read, by fd or by path). */
const reads = vi.hoisted(() => ({ bytes: 0 }));
/** While on, `fstatSync` reports a size of 1 byte, until the first `readSync`: as a file that
 *  grows past the cap between the size check and the read would. */
const grows = vi.hoisted(() => ({ on: false, seen: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readSync: ((...args: unknown[]) => {
      grows.on = false;
      const n = (real.readSync as (...a: unknown[]) => number)(...args);
      reads.bytes += n;
      return n;
    }) as typeof real.readSync,
    fstatSync: ((...args: unknown[]) => {
      const st = (real.fstatSync as (...a: unknown[]) => import('node:fs').Stats)(...args);
      if (!grows.on) return st;
      grows.seen++;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as import('node:fs').Stats, st, { size: 1 });
    }) as typeof real.fstatSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const out = (real.readFileSync as (...a: unknown[]) => Buffer | string)(path, ...rest);
      reads.bytes += out.length;
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
  grows.on = false;
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
    expect(bytesReadBy(() => { changes = mgr.getChanges(); }), 'getChanges does not read a file over the cap').toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
    expect(changes[0]!.diff).toBe(
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Before the run it was 8 bytes.)',
    );
    expect(bytesReadBy(() => { expect(mgr.hasChanges()).toBe(true); }), 'hasChanges does not read it').toBe(0);
    expect(bytesReadBy(() => { expect(mgr.size).toBe(1); }), 'size does not read it').toBe(0);
  });

  it(`[${branch}] settle keeps a modified file over the cap, and the rollback restores the original`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    expect(bytesReadBy(() => mgr.settle()), 'settle does not read it').toBe(0);
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
    expect(bytesReadBy(() => { changes = mgr.getChanges(); })).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('added');
    expect(changes[0]!.diff).toBe(
      '--- /dev/null\n+++ b/new.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. It did not exist before the run.)',
    );

    expect(bytesReadBy(() => mgr.settle())).toBe(0);
    expect(mgr.isEmpty(), 'not dropped as unchanged').toBe(false);
    expect(bytesReadBy(() => mgr.rollbackAll()), 'the rollback does not read it').toBe(0);
    expect(statSync(path).size, 'another writer\'s file is not deleted').toBe(HUGE);
  });

  it(`[${branch}] a file that grows past the cap while it is read is shown as changed, read only up to the cap`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    let changes: ReturnType<ChangesetManager['getChanges']> = [];
    grows.on = true;
    grows.seen = 0;
    const read = bytesReadBy(() => { changes = mgr.getChanges(); });
    expect(grows.seen, 'the size check saw the small size').toBeGreaterThan(0);
    expect(read, 'the read stops at the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(read, 'and did read up to it').toBeGreaterThan(CAP);
    expect(changes.map((c) => c.diff)).toEqual([
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Before the run it was 8 bytes.)',
    ]);
  });

  it(`[${branch}] the run's own added file over the cap is shown without being read, and rolled back`, () => {
    const path = join(ws, 'big.txt');
    mgr.backupBeforeWrite(path);
    writeFileSync(path, 'b'.repeat(CAP + 1));
    expect(bytesReadBy(() => mgr.recordWritten(path)), 'recordWritten does not read a file over the cap').toBe(0);

    let changes: ReturnType<ChangesetManager['getChanges']> = [];
    expect(bytesReadBy(() => { changes = mgr.getChanges(); })).toBe(0);
    expect(changes[0]!.diff).toBe(
      '--- /dev/null\n+++ b/big.txt\n'
      + '(Content not compared: the file is 5.1 MB now, larger than the 5 MB the review reads. It did not exist before the run.)',
    );
    expect(bytesReadBy(() => mgr.rollbackAll())).toBe(0);
    expect(existsSync(path), 'the run\'s own file is deleted').toBe(false);
  });

  it(`[${branch}] the run's own added file over the cap, changed in place since, is not deleted`, () => {
    const path = join(ws, 'big.txt');
    mgr.backupBeforeWrite(path);
    writeFileSync(path, 'b'.repeat(CAP + 1));
    mgr.recordWritten(path);
    // Another writer changes one byte in place: same inode, same size.
    const fd = openSync(path, 'r+');
    writeSync(fd, 'X', 0);
    closeSync(fd);

    mgr.rollbackAll();
    expect(existsSync(path), 'changed since the run wrote it').toBe(true);
    expect(readFileSync(path, 'utf-8').slice(0, 2)).toBe('Xb');
  });

  it.skipIf(process.getuid?.() === 0)(`[${branch}] a modified file whose original could not be read shows that its size before is not known`, () => {
    const path = join(ws, 'locked.txt');
    writeFileSync(path, 'original');
    chmodSync(path, 0o000);
    mgr.backupBeforeWrite(path);
    chmodSync(path, 0o644);
    plant(path, HUGE);

    expect(mgr.getChanges().map((c) => c.diff)).toEqual([
      '--- a/locked.txt\n+++ b/locked.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Its size before the run is not known.)',
    ]);
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
