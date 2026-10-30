import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The context directory in shell sidecar mode (layout W1): made or opened from fd 3, then given
 * group 1002 and mode 0o2770 through a reopened fd, whether it is new or was there. The group the
 * layout names needs a membership no test runner has, so `fchownSync` records the group asked for
 * and goes on with the process's own group. It still runs on the fd it is given, so a group set
 * on the O_PATH anchor fails here with EBADF, as it would in the container.
 */
const chowns = vi.hoisted(() => [] as number[]);
const chownFails = vi.hoisted(() => ({ on: false, onCall: undefined as ((fd: number) => void) | undefined }));
// The group each inode was given, as fstat reports it back: the real call ran with the runner's
// own group. `reported: false` reports the real group instead.
const chownedTo = vi.hoisted(() => ({ map: new Map<number, number>(), reported: true }));
// `chmodFails` fails fchmod; `dropsSetgid` makes it drop the set-group-ID bit without an error,
// as the kernel does for a process outside the directory's group.
const chmod = vi.hoisted(() => ({ fails: false, dropsSetgid: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fchownSync: (fd: number, uid: number, gid: number): void => {
      chowns.push(gid);
      chownFails.onCall?.(fd);
      if (chownFails.on) throw Object.assign(new Error('EPERM: operation not permitted, fchown'), { code: 'EPERM' });
      real.fchownSync(fd, uid, process.getgid!());
      chownedTo.map.set(real.fstatSync(fd).ino, gid);
    },
    fstatSync: ((fd: number, opts?: never) => {
      const st = real.fstatSync(fd, opts);
      const gid = chownedTo.reported ? chownedTo.map.get(Number(st.ino)) : undefined;
      if (gid !== undefined) Object.defineProperty(st, 'gid', { value: gid });
      return st;
    }) as typeof real.fstatSync,
    fchmodSync: (fd: number, mode: number): void => {
      if (chmod.fails) throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
      real.fchmodSync(fd, chmod.dropsSetgid ? mode & ~0o2000 : mode);
    },
  };
});

const { chmodSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL } = await import('./shell-isolation.js');
const { anchorFromFd, closeAnchor, openFds } = await import('./workspace-fd.js');
const { ensureContextWorkspace, _resetCache } = await import('./workspace.js');
const { WorkspaceRootError } = await import('./workspace-root.js');

const fstatModeOf = (fd: number): number => fstatSync(fd).mode & 0o7777;

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
    chownFails.onCall = undefined;
    chmod.fails = false;
    chmod.dropsSetgid = false;
    chownedTo.map.clear();
    chownedTo.reported = true;
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
    // The type the boot reports for a workspace it cannot use (`ensureContextWorkspace`'s contract).
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`))).toThrow(WorkspaceRootError);
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
      .toThrow(/The context directory \/workspace\/ctx1 cannot be made ready from fd 3 \(EPERM: operation not permitted, fchown\)/);
  });

  it('a context directory that belongs to another uid stops the start before anything is changed', () => {
    mkdirSync(join(tree, 'ctx1'));
    chmodSync(join(tree, 'ctx1'), 0o700);
    const geteuid = vi.spyOn(process, 'geteuid').mockReturnValue(4242);
    try {
      expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
        .toThrow(/The context directory \/workspace\/ctx1 cannot be made ready from fd 3 \(it belongs to uid \d+, not to uid 4242; give it to uid 4242 or remove it\)/);
    } finally {
      geteuid.mockRestore();
    }
    expect(chowns).toEqual([]);
    expect(statSync(join(tree, 'ctx1')).mode & 0o7777).toBe(0o700);
  });

  it('a set-group-ID bit the kernel dropped without an error stops the start', () => {
    chmod.dropsSetgid = true;
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
      .toThrow(/cannot be made ready from fd 3 \(after fchown and fchmod it has mode 0o770 and group \d+, not 0o2770 and 1002\)/);
  });

  it('a group the directory did not get stops the start', () => {
    // fchown ran with the runner's own group; reported as it is, the directory does not have 1002.
    chownedTo.reported = false;
    expect(statSync(tree).gid).not.toBe(GROUP);
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`))).toThrow(/not 0o2770 and 1002/);
  });

  it('a failed fchmod stops the start, naming the call, and leaves no fd open', () => {
    // An existing folder: the walk opens it without a call of its own, so the failure is this step's.
    mkdirSync(join(tree, 'ctx1'));
    chmod.fails = true;
    const before = openFds().length;
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`)))
      .toThrow(/cannot be made ready from fd 3 \(EPERM: operation not permitted, fchmod\)/);
    expect(openFds().length).toBe(before);
  });

  it('a new folder is never group-open before it has the group', () => {
    // fchown is the first call that changes the folder; at that moment it must still be 0700.
    const modes: number[] = [];
    chownFails.on = true;
    chownFails.onCall = (fd: number) => modes.push(fstatModeOf(fd));
    expect(() => ensureContextWorkspace(ctx('ctx1', `${WORKSPACE_LABEL}/ctx1`))).toThrow(/fchown/);
    expect(modes).toEqual([0o700]);
  });

  it('a file or a symlink at the context directory stops the start and stays as it is', () => {
    writeFileSync(join(tree, 'file'), 'x');
    expect(() => ensureContextWorkspace(ctx('file', `${WORKSPACE_LABEL}/file`))).toThrow(WorkspaceRootError);
    expect(lstatSync(join(tree, 'file')).isFile()).toBe(true);
    const target = join(tmp, 'elsewhere');
    mkdirSync(target);
    chmodSync(target, 0o700);
    symlinkSync(target, join(tree, 'link'));
    expect(() => ensureContextWorkspace(ctx('link', `${WORKSPACE_LABEL}/link`))).toThrow(WorkspaceRootError);
    expect(readlinkSync(join(tree, 'link'))).toBe(target);
    expect(statSync(target).mode & 0o7777).toBe(0o700);
    expect(chowns).toEqual([]);
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
