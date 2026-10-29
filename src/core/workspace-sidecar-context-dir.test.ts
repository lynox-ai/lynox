import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The context directory in shell sidecar mode (layout W1): made or opened from fd 3, then given
 * group 1002 and mode 0o2770 through a reopened fd, whether it is new or was there. The group the
 * layout names needs a membership no test runner has, so `fchownSync` records the group asked for
 * and goes on with the process's own group. It still runs on the fd it is given, so a group set
 * on the O_PATH anchor fails here with EBADF, as it would in the container.
 */
const chowns = vi.hoisted(() => [] as number[]);
const chownFails = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fchownSync: (fd: number, uid: number, gid: number): void => {
      chowns.push(gid);
      if (chownFails.on) throw Object.assign(new Error('EPERM: operation not permitted, fchown'), { code: 'EPERM' });
      real.fchownSync(fd, uid, process.getgid!());
    },
  };
});

const { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL } = await import('./shell-isolation.js');
const { anchorFromFd, closeAnchor, openFds } = await import('./workspace-fd.js');
const { ensureContextWorkspace, _resetCache } = await import('./workspace.js');

// The layout's values as literals: an expectation that imports the constant moves with it.
const GROUP = 1002;
const DIR_MODE = 0o2770;

const ctx = (id: string, workspaceDir: string) => ({ id, name: 'lynox', source: 'pwa', workspaceDir }) as never;

describe('the context directory in shell sidecar mode (W1)', () => {
  let tmp: string;
  let tree: string;
  let anchor: ReturnType<typeof anchorFromFd>;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ctx-dir-')));
    tree = join(tmp, 'tree');
    mkdirSync(tree);
    anchor = anchorFromFd(openSync(tree, constants.O_PATH | constants.O_DIRECTORY), WORKSPACE_LABEL);
    setShellIsolationForTest({ kind: 'sidecar', socket: join(tmp, 'exec.sock'), root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } });
    _resetCache();
    chowns.length = 0;
    chownFails.on = false;
  });

  afterEach(() => {
    resetShellIsolationForTest();
    _resetCache();
    closeAnchor(anchor);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a new context directory is made from fd 3 with group 1002 and mode 0o2770', () => {
    const before = openFds().length;
    expect(ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`))).toBe(`${WORKSPACE_LABEL}/ctx1`);
    expect(statSync(join(tree, 'ctx1')).mode & 0o7777).toBe(DIR_MODE);
    expect(chowns).toContain(GROUP);
    // The directory is only made ready here; its fd is closed again (workspaceBase opens its own).
    expect(openFds().length).toBe(before);
  });

  it('a context directory that was there gets them too, not only a new one', () => {
    mkdirSync(join(tree, 'ctx1'));
    chmodSync(join(tree, 'ctx1'), 0o700);
    ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`));
    expect(statSync(join(tree, 'ctx1')).mode & 0o7777).toBe(DIR_MODE);
    expect(chowns).toEqual([GROUP]);
  });

  it('a failed group change stops the start, naming the directory and the call', () => {
    chownFails.on = true;
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
      .toThrow(/The context directory \/workspace\/ctx1 cannot be made ready from fd 3 \(EPERM: operation not permitted, fchown\)/);
  });

  it('a context directory that belongs to another uid stops the start', () => {
    const geteuid = vi.spyOn(process, 'geteuid').mockReturnValue(4242);
    try {
      expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
        .toThrow(/The context directory \/workspace\/ctx1 belongs to uid \d+, not to the engine \(uid 4242\)/);
    } finally {
      geteuid.mockRestore();
    }
  });

  it('a context directory that is not one directory below the label is refused', () => {
    for (const dir of [WORKSPACE_LABEL, `${WORKSPACE_LABEL}/a/b`, '/elsewhere/ctx1']) {
      expect(() => ensureContextWorkspace(ctx('x', dir))).toThrow(/must be one directory below \/workspace/);
    }
    expect(existsSync(join(tree, 'a'))).toBe(false);
  });

  it('outside sidecar mode the context directory is made by name as before, without a group', () => {
    resetShellIsolationForTest();
    setShellIsolationForTest({ kind: 'local' });
    const dir = join(tmp, 'local-ctx');
    expect(ensureContextWorkspace(ctx('local', dir))).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(chowns).toEqual([]);
  });
});
