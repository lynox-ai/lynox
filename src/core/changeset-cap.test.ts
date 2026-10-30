import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, linkSync, openSync, writeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
const grows = vi.hoisted(() => ({ on: false }));
/** While on, the first `fstatSync` after a `readSync` fails: as a size that cannot be read once the
 *  file was found over the cap. */
const fstatFailsAfterRead = vi.hoisted(() => ({ on: false, armed: false }));
/** When set, `execFileSync` throws this instead of running: as a `diff` stopped by its timeout would. */
const diffThrows = vi.hoisted(() => ({ err: null as Record<string, unknown> | null }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((...args: unknown[]) => {
      if (diffThrows.err !== null) throw Object.assign(new Error('diff stopped'), diffThrows.err);
      return (real.execFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.execFileSync,
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readSync: ((...args: unknown[]) => {
      grows.on = false;
      if (fstatFailsAfterRead.on) fstatFailsAfterRead.armed = true;
      const n = (real.readSync as (...a: unknown[]) => number)(...args);
      reads.bytes += n;
      return n;
    }) as typeof real.readSync,
    fstatSync: ((...args: unknown[]) => {
      if (fstatFailsAfterRead.armed) {
        fstatFailsAfterRead.armed = false;
        fstatFailsAfterRead.on = false;
        throw Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' });
      }
      const st = (real.fstatSync as (...a: unknown[]) => import('node:fs').Stats)(...args);
      if (!grows.on) return st;
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

/** Returns once a file written now gets a later ctime than `path` has. */
function afterCtimeTick(path: string): void {
  const before = statSync(path, { bigint: true }).ctimeNs;
  const probe = `${path}.tick`;
  const until = Date.now() + 2000;
  do writeFileSync(probe, 'x'); while (statSync(probe, { bigint: true }).ctimeNs <= before && Date.now() < until);
  rmSync(probe);
}

/** The bytes `op` read. */
function bytesReadBy(op: () => void): number {
  reads.bytes = 0;
  op();
  return reads.bytes;
}

afterEach(() => {
  grows.on = false;
  fstatFailsAfterRead.on = false;
  fstatFailsAfterRead.armed = false;
  diffThrows.err = null;
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
    expect(changes[0]!.compared, 'a note, not a diff').toBe(false);
    expect(changes[0]!.diff).toBe(
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Before the run it was 8 bytes. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.)',
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
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. It did not exist before the run. Look at the file yourself before you keep it; Rollback removes it unless it was changed or replaced after the run wrote it.)',
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
    const read = bytesReadBy(() => { changes = mgr.getChanges(); });
    expect(read, 'the read stops at the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(read, 'and did read up to it').toBeGreaterThan(CAP);
    expect(changes.map((c) => c.diff)).toEqual([
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Before the run it was 8 bytes. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.)',
    ]);
  });

  it(`[${branch}] a file that grows past the cap, whose size then cannot be read, is still shown as changed`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    plant(path, HUGE);

    grows.on = true;
    fstatFailsAfterRead.on = true;
    const changes = mgr.getChanges();
    expect(fstatFailsAfterRead.on, 'precondition: the size read after the capped read failed').toBe(false);
    expect(changes.map((c) => [c.diff, c.compared])).toEqual([[
      '--- a/notes.txt\n+++ b/notes.txt\n'
      + '(Content not compared: the file is now larger than the 5 MB the review reads. Before the run it was 8 bytes. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.)',
      false,
    ]]);
  });

  it(`[${branch}] recordWritten on a file that grows past the cap while it is read stops at the cap, and does not take it for the run's own`, () => {
    const path = join(ws, 'new.txt');
    mgr.backupBeforeWrite(path);
    writeFileSync(path, 'the run wrote this');
    plant(path, HUGE);

    grows.on = true;
    const read = bytesReadBy(() => mgr.recordWritten(path));
    expect(read, 'the read stops at the cap').toBeLessThanOrEqual(CAPPED_READ);
    expect(read, 'and did read up to it').toBeGreaterThan(CAP);
    mgr.rollbackAll();
    expect(statSync(path).size, 'not deleted').toBe(HUGE);
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
      + '(Content not compared: the file is 5.1 MB now, larger than the 5 MB the review reads. It did not exist before the run. Look at the file yourself before you keep it; Rollback removes it unless it was changed or replaced after the run wrote it.)',
    );
    expect(bytesReadBy(() => mgr.rollbackAll())).toBe(0);
    expect(existsSync(path), 'the run\'s own file is deleted').toBe(false);
  });

  it(`[${branch}] the run's own added file over the cap, changed in place since, is not deleted`, () => {
    const path = join(ws, 'big.txt');
    mgr.backupBeforeWrite(path);
    writeFileSync(path, 'b'.repeat(CAP + 1));
    mgr.recordWritten(path);
    // On a kernel with coarse timestamps, a write in the same tick keeps the ctime (see
    // `_identityOf`): the other writer comes after the clock has moved on.
    afterCtimeTick(path);
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
      + '(Content not compared: the file is 100 MB now, larger than the 5 MB the review reads. Its size before the run is not known. Look at the file yourself before you keep the change; Rollback cannot restore it, because the original could not be read.)',
    ]);
  });

  it(`[${branch}] a modified file whose backup copy is gone is shown with "(diff unavailable)", not compared`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    rmSync((mgr as unknown as { backupDir: string }).backupDir, { recursive: true, force: true });

    expect(mgr.getChanges().map((c) => [c.diff, c.compared])).toEqual([
      ['--- a/notes.txt\n+++ b/notes.txt\n(diff unavailable)', false],
    ]);
  });

  it(`[${branch}] a modified binary file, whose diff has no changed line, is not compared`, () => {
    const path = join(ws, 'image.bin');
    writeFileSync(path, Buffer.from([0, 1, 2, 3]));
    mgr.backupBeforeWrite(path);
    writeFileSync(path, Buffer.from([0, 9, 9, 9]));

    const [change] = mgr.getChanges();
    expect(change!.diff).toContain('Binary files');
    expect(change!.compared, 'its +0 -0 would read as unchanged').toBe(false);
  });

  it(`[${branch}] a file of exactly the cap is still read and diffed, and the run's added file still rolled back (control)`, () => {
    // Short lines, so the diff of one changed line stays far under the diff's own limit.
    const line = 'x'.repeat(63) + '\n';
    const original = 'o'.repeat(63) + '\n' + line.repeat(CAP / 64 - 1);
    const modified = join(ws, 'notes.txt');
    writeFileSync(modified, original);
    writeAsTheRun(modified, line.repeat(CAP / 64));
    const added = join(ws, 'new.txt');
    writeAsTheRun(added, 'y'.repeat(CAP));

    const changes = mgr.getChanges();
    expect(changes.map((c) => c.file).sort()).toEqual(['new.txt', 'notes.txt']);
    for (const c of changes) {
      expect(c.diff).not.toContain('Content not compared');
      expect(c.compared).toBe(true);
    }
    expect(changes.find((c) => c.file === 'notes.txt')!.diff).toContain('-' + 'o'.repeat(63));

    mgr.rollbackAll();
    expect(readFileSync(modified, 'utf-8')).toBe(original);
    expect(existsSync(added), 'the run\'s own file of exactly the cap is deleted').toBe(false);
  });

  it(`[${branch}] a diff longer than 1 MB is shown cut, with a note, and not compared`, () => {
    const path = join(ws, 'notes.txt');
    const original = ('a'.repeat(63) + '\n').repeat(40_000);
    writeFileSync(path, original);
    writeAsTheRun(path, ('b'.repeat(63) + '\n').repeat(40_000));

    const [change] = mgr.getChanges();
    expect(change!.diff.startsWith('--- a/notes.txt\n+++ b/notes.txt\n@@ ')).toBe(true);
    expect(change!.diff.endsWith(
      '\n(Diff cut: only its start is shown, as it is longer than 1 MB or took longer than 5 seconds. Look at the file yourself before you keep the change; Rollback restores the original, or says it could not.)',
    )).toBe(true);
    // Node stops the read after the chunk that crosses the limit; the whole diff is about 5 MB.
    expect(change!.diff.length, 'only the start').toBeLessThan(2 * 1024 * 1024);
    expect(change!.compared, 'its counts are those of the start only').toBe(false);

    mgr.rollbackAll();
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it(`[${branch}] a diff stopped by its timeout is shown cut, and not compared`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original\n');
    writeAsTheRun(path, 'changed\n');
    diffThrows.err = { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-orig' };

    const [change] = mgr.getChanges();
    expect(change!.diff, 'the last line, cut mid-line, is dropped').toMatch(/^--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1 \+1 @@\n\(Diff cut: /);
    expect(change!.compared).toBe(false);
  });

  it(`[${branch}] a diff over the limit that still exits with code 1 is shown cut`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original\n');
    writeAsTheRun(path, 'changed\n');
    diffThrows.err = { code: 'ENOBUFS', status: 1, stdout: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-original\n' };

    const [change] = mgr.getChanges();
    expect(change!.diff).toMatch(/^--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1 \+1 @@\n-original\n\(Diff cut: /);
    expect(change!.compared).toBe(false);
  });

  it(`[${branch}] a diff stopped before its first whole line is shown as unavailable`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original\n');
    writeAsTheRun(path, 'changed\n');
    diffThrows.err = { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '--- a/no' };

    expect(mgr.getChanges().map((c) => [c.diff, c.compared])).toEqual([
      ['--- a/notes.txt\n+++ b/notes.txt\n(diff unavailable)', false],
    ]);
  });

  it(`[${branch}] a diff stopped otherwise (a signal) is shown as unavailable, without a cause it cannot name`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original\n');
    writeAsTheRun(path, 'changed\n');
    diffThrows.err = { signal: 'SIGKILL', status: null, stdout: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-original\n' };

    expect(mgr.getChanges().map((c) => [c.diff, c.compared])).toEqual([
      ['--- a/notes.txt\n+++ b/notes.txt\n(diff unavailable)', false],
    ]);
  });

  it(`[${branch}] a diff that ends normally, with exit code 1, is whole and compared (control)`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original\n');
    writeAsTheRun(path, 'changed\n');

    const [change] = mgr.getChanges();
    expect(change!.diff).toBe('--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-original\n+changed\n');
    expect(change!.compared).toBe(true);
  });
});

/**
 * A rollback leaves a file as it is when it was replaced or linked since the run wrote it, or
 * cannot be written. It returns those files, so the answer to the review can name them: the review
 * promised the original back, and a skip nobody hears of reads as done.
 */
describe.each<Branch>(['anchor', 'name'])('what a rollback reports, %s branch', (branch) => {
  beforeEach(() => setup(branch));

  it(`[${branch}] a modified file restored, and an added file removed, are not reported (control)`, () => {
    const modified = join(ws, 'notes.txt');
    const added = join(ws, 'new.txt');
    writeFileSync(modified, 'original');
    writeAsTheRun(modified, 'the run wrote this');
    writeAsTheRun(added, 'the run made this');
    expect(mgr.rollbackAll()).toEqual([]);
    expect(readFileSync(modified, 'utf-8')).toBe('original');
    expect(existsSync(added)).toBe(false);
  });

  it(`[${branch}] a modified file replaced by a symlink since is left, not written through, and reported`, () => {
    const path = join(ws, 'notes.txt');
    const outside = join(data, 'outside.txt');
    writeFileSync(outside, 'not the workspace');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    rmSync(path);
    symlinkSync(outside, path);
    expect(mgr.rollbackAll()).toEqual([path]);
    expect(readFileSync(outside, 'utf-8'), 'the link target is not written').toBe('not the workspace');
  });

  // Inside the workspace, so the name passes its confinement and the write itself fails: a FIFO
  // without a reader refuses a non-blocking open for writing, and is never truncated.
  it(`[${branch}] a modified file replaced by a FIFO since is left and reported`, () => {
    const path = join(ws, 'notes.txt');
    writeFileSync(path, 'original');
    writeAsTheRun(path, 'the run wrote this');
    rmSync(path);
    execFileSync('mkfifo', [path]);
    expect(statSync(path).isFIFO(), 'precondition: a FIFO is at the name').toBe(true);
    expect(mgr.rollbackAll()).toEqual([path]);
  });

  it(`[${branch}] an added file replaced by another writer's file is left and reported`, () => {
    const path = join(ws, 'new.txt');
    writeAsTheRun(path, 'the run made this');
    plant(path, 5);
    expect(mgr.rollbackFiles([path])).toEqual([path]);
    expect(statSync(path).size, 'the other writer\'s file stays').toBe(5);
  });

  it(`[${branch}] an added file already gone is not reported: it is as it was before the run`, () => {
    const path = join(ws, 'new.txt');
    writeAsTheRun(path, 'the run made this');
    rmSync(path);
    expect(mgr.rollbackFiles([path])).toEqual([]);
  });

  if (branch === 'anchor') {
    it('[anchor] a modified file that got a second name since is left and reported', () => {
      const path = join(ws, 'notes.txt');
      writeFileSync(path, 'original');
      writeAsTheRun(path, 'the run wrote this');
      linkSync(path, join(data, 'second-name.txt'));
      expect(mgr.rollbackAll()).toEqual([path]);
      expect(readFileSync(path, 'utf-8'), 'not written').toBe('the run wrote this');
    });
  }
});
