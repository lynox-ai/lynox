import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The group a write asks for, recorded. The call goes on to the real `fchownSync` with the
 * process's own group, which the test may set: an `O_PATH` fd still fails there with EBADF, so a
 * group set on the wrong fd fails the test, while the group the layout names (1002) needs a
 * membership no test runner has.
 */
const chowns = vi.hoisted(() => [] as number[]);
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fchownSync: (fd: number, uid: number, gid: number): void => {
      chowns.push(gid);
      real.fchownSync(fd, uid, process.getgid!());
    },
  };
});

import { resetShellIsolationForTest, setShellIsolationForTest, SHARED_GROUP, type ShellIsolation } from './shell-isolation.js';
import { SIDECAR_DIR_MODE, SIDECAR_FILE_MODE, sidecarReplaceMode, sidecarWriteModes } from './workspace-write-modes.js';
import { anchoredWorkspaceWriter } from './bulk-apply.js';
import { ChangesetManager } from './changeset.js';
import { persistChatUploadInArea } from './file-area-anchor.js';
import { clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { writeFileTool } from '../tools/builtin/fs.js';
import { batchFilesTool } from '../tools/builtin/batch-files.js';
import type { IAgent, SessionCounters } from '../types/index.js';

/**
 * In sidecar mode what the engine creates in the context directory takes the modes and group of
 * the shell sidecar layout document (A2): files 0660, directories 02770, group 1002, whatever the
 * umask. Outside sidecar mode every site keeps the mode it had. Each site is checked under two
 * umasks, so a mode that follows the umask cannot pass.
 */

const SIDECAR = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
const UMASKS = [0o022, 0o077] as const;
const mode = (p: string): number => statSync(p).mode & 0o7777;
const agent = (): IAgent => ({ sessionCounters: { writeBytes: 0, httpRequests: 0 } as unknown as SessionCounters } as unknown as IAgent);

let ws: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-sidecar-modes-')));
  setTenantWorkspace(ws);
  chowns.length = 0;
});

afterEach(() => {
  resetShellIsolationForTest();
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
});

async function underUmask<T>(mask: number, run: () => Promise<T> | T): Promise<T> {
  const before = process.umask(mask);
  try { return await run(); } finally { process.umask(before); }
}

describe('the modes and group of a write in sidecar mode', () => {
  it('answers the layout\'s values in sidecar mode and nothing outside it', () => {
    expect(sidecarWriteModes()).toBeNull();
    setShellIsolationForTest(SIDECAR);
    expect(sidecarWriteModes()).toEqual({ fileMode: 0o660, dirMode: 0o2770, group: SHARED_GROUP });
    expect(SHARED_GROUP).toBe(1002);
  });

  it('a replaced file keeps the owner\'s and group\'s bits, gains group read and write, loses the rest', () => {
    expect(sidecarReplaceMode(0o644)).toBe(0o660);
    expect(sidecarReplaceMode(0o755)).toBe(0o770);
    expect(sidecarReplaceMode(0o600)).toBe(0o660);
    expect(sidecarReplaceMode(0o4755)).toBe(0o770);
    expect(sidecarReplaceMode(0o2775)).toBe(0o770);
  });
});

describe.each(UMASKS)('in sidecar mode under umask %o', (mask) => {
  beforeEach(() => { setShellIsolationForTest(SIDECAR); });

  it('write_file (and media_process, through the same writeInPlace) makes 0660 files in 02770 directories with the group', async () => {
    await underUmask(mask, () => writeFileTool.handler({ path: join(ws, 'deep', 'new.txt'), content: 'n' }, agent()));
    expect(mode(join(ws, 'deep', 'new.txt'))).toBe(SIDECAR_FILE_MODE);
    expect(mode(join(ws, 'deep'))).toBe(SIDECAR_DIR_MODE);
    expect(chowns).toEqual([SHARED_GROUP, SHARED_GROUP]);
  });

  it('write_file over an existing file writes in place and changes neither mode nor group', async () => {
    writeFileSync(join(ws, 'kept.sh'), 'one');
    chmodSync(join(ws, 'kept.sh'), 0o750);
    await underUmask(mask, () => writeFileTool.handler({ path: join(ws, 'kept.sh'), content: 'two' }, agent()));
    expect(mode(join(ws, 'kept.sh'))).toBe(0o750);
    expect(chowns).toEqual([]);
  });

  it('batch_files makes a move\'s destination directories 02770 with the group', async () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    await underUmask(mask, () => batchFilesTool.handler({ operation: 'move', pattern: 'a.txt', directory: ws, destination: join(ws, 'to', 'here') }, agent()));
    expect(readFileSync(join(ws, 'to', 'here', 'a.txt'), 'utf8')).toBe('a');
    expect(mode(join(ws, 'to'))).toBe(SIDECAR_DIR_MODE);
    expect(mode(join(ws, 'to', 'here'))).toBe(SIDECAR_DIR_MODE);
    expect(chowns).toEqual([SHARED_GROUP, SHARED_GROUP]);
  });

  it('a changeset rollback makes a file the run deleted again 0660 with the group', async () => {
    writeFileSync(join(ws, 'a.txt'), 'before');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'a.txt'));
    rmSync(join(ws, 'a.txt'));
    await underUmask(mask, () => mgr.rollbackAll());
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('before');
    expect(mode(join(ws, 'a.txt'))).toBe(SIDECAR_FILE_MODE);
    expect(chowns).toEqual([SHARED_GROUP]);
    mgr.cleanup();
  });

  it('bulk apply makes new files 0660 in 02770 directories, and a pool file it replaces stays group-writable', async () => {
    writeFileSync(join(ws, 'pool.txt'), 'before');
    chmodSync(join(ws, 'pool.txt'), 0o644);
    const writer = anchoredWorkspaceWriter();
    await underUmask(mask, async () => {
      await writer.write(join(ws, 'pool.txt'), { absent: false, value: 'after' });
      await writer.write(join(ws, 'new/deep/n.txt'), { absent: false, value: 'n' });
    });
    expect(readFileSync(join(ws, 'pool.txt'), 'utf8')).toBe('after');
    expect(mode(join(ws, 'pool.txt'))).toBe(0o660);
    expect(mode(join(ws, 'new', 'deep', 'n.txt'))).toBe(SIDECAR_FILE_MODE);
    expect(mode(join(ws, 'new'))).toBe(SIDECAR_DIR_MODE);
    expect(mode(join(ws, 'new', 'deep'))).toBe(SIDECAR_DIR_MODE);
    // The replacement, the two directories and the new file.
    expect(chowns).toEqual([SHARED_GROUP, SHARED_GROUP, SHARED_GROUP, SHARED_GROUP]);
  });

  it('a chat upload is 0660 in a 02770 directory with the group, so the shell can read it', async () => {
    const stored = await underUmask(mask, () => persistChatUploadInArea('Buchungen.csv', 'id\n1\n'));
    expect(stored).not.toBeNull();
    expect(mode(stored!.abs)).toBe(SIDECAR_FILE_MODE);
    expect(mode(join(ws, 'uploads'))).toBe(SIDECAR_DIR_MODE);
    expect(chowns).toEqual([SHARED_GROUP, SHARED_GROUP]);
  });
});

describe.each(UMASKS)('outside sidecar mode under umask %o every site keeps its mode', (mask) => {
  it('write_file follows the umask and sets no group', async () => {
    await underUmask(mask, () => writeFileTool.handler({ path: join(ws, 'deep', 'new.txt'), content: 'n' }, agent()));
    expect(mode(join(ws, 'deep', 'new.txt'))).toBe(0o666 & ~mask);
    expect(mode(join(ws, 'deep'))).toBe(0o777 & ~mask);
    expect(chowns).toEqual([]);
  });

  it('batch_files follows the umask', async () => {
    writeFileSync(join(ws, 'a.txt'), 'a');
    await underUmask(mask, () => batchFilesTool.handler({ operation: 'move', pattern: 'a.txt', directory: ws, destination: join(ws, 'to') }, agent()));
    expect(mode(join(ws, 'to'))).toBe(0o777 & ~mask);
    expect(chowns).toEqual([]);
  });

  it('a changeset rollback follows the umask', async () => {
    writeFileSync(join(ws, 'a.txt'), 'before');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'a.txt'));
    rmSync(join(ws, 'a.txt'));
    await underUmask(mask, () => mgr.rollbackAll());
    expect(mode(join(ws, 'a.txt'))).toBe(0o666 & ~mask);
    expect(chowns).toEqual([]);
    mgr.cleanup();
  });

  it('bulk apply keeps a replaced file\'s mode and follows the umask for new ones', async () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'pool.txt'), 'before');
    chmodSync(join(ws, 'sub', 'pool.txt'), 0o644);
    const writer = anchoredWorkspaceWriter();
    await underUmask(mask, async () => {
      await writer.write(join(ws, 'sub/pool.txt'), { absent: false, value: 'after' });
      await writer.write(join(ws, 'new/n.txt'), { absent: false, value: 'n' });
    });
    expect(mode(join(ws, 'sub', 'pool.txt'))).toBe(0o644);
    expect(mode(join(ws, 'new', 'n.txt'))).toBe(0o666 & ~mask);
    expect(mode(join(ws, 'new'))).toBe(0o777 & ~mask);
    expect(chowns).toEqual([]);
  });

  it('a chat upload stays private', async () => {
    const stored = await underUmask(mask, () => persistChatUploadInArea('a.csv', 'x'));
    expect(mode(stored!.abs)).toBe(0o600);
    expect(mode(join(ws, 'uploads'))).toBe(0o700);
    expect(chowns).toEqual([]);
  });
});
