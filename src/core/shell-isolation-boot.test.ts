import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Every `node:fs` call whose path argument names `/workspace` or a path below it is recorded: the
 * start must reach the workspace only through fd 3 (PRD shell-sidecar-activation D3). The image of
 * the engine may hold a `/workspace` of its own, so a call by name could answer, and this records
 * it whether or not the path exists on the test machine. `fchownSync` records the group asked for
 * and goes on with the process's own group: the layout's group 1002 needs a membership no test
 * runner has.
 */
const touched = vi.hoisted(() => [] as string[]);
const chowns = vi.hoisted(() => [] as number[]);
// The group each inode was given, as fstat reports it back (the real call ran with the runner's own).
const chownedTo = vi.hoisted(() => new Map<number, number>());
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const namesLabel = (a: unknown): boolean => typeof a === 'string' && (a === '/workspace' || a.startsWith('/workspace/'));
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    wrapped[name] = typeof value === 'function' && /^[a-z]/.test(name)
      ? (...args: unknown[]) => {
        if (args.some(namesLabel)) touched.push(`${name}(${String(args.find(namesLabel))})`);
        return (value as (...a: unknown[]) => unknown)(...args);
      }
      : value;
  }
  wrapped['fchownSync'] = (fd: number, uid: number, gid: number): void => {
    chowns.push(gid);
    real.fchownSync(fd, uid, process.getgid!());
    chownedTo.set(real.fstatSync(fd).ino, gid);
  };
  wrapped['fstatSync'] = (fd: number, opts?: never) => {
    const st = real.fstatSync(fd, opts);
    const gid = chownedTo.get(Number(st.ino));
    if (gid !== undefined) Object.defineProperty(st, 'gid', { value: gid });
    return st;
  };
  return { ...wrapped, default: wrapped };
});

const { constants, existsSync, mkdtempSync, mkdirSync, openSync, realpathSync, rmSync, statSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { Engine } = await import('./engine.js');
const { reloadConfig } = await import('./config.js');
const { createToolContext } = await import('./tool-context.js');
const { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL } = await import('./shell-isolation.js');
const { anchorFromFd, closeAnchor } = await import('./workspace-fd.js');
const { getWorkspaceDir, _resetCache } = await import('./workspace.js');
const { _resetWorkspaceAccess } = await import('./workspace-access.js');
const { closeWorkspaceBase } = await import('./workspace-rel.js');
type ShellIsolation = import('./shell-isolation.js').ShellIsolation;
type LynoxConfig = import('../types/index.js').LynoxConfig;

/**
 * The mode reaches what the engine builds at boot, and the boot goes through to the end: a unit
 * test that hands the mode in itself cannot see that the engine passes it on, or that the start
 * order reaches the workspace by name somewhere (fb_boot_wiring_test), so it is measured on a
 * booted engine with a real fd-3 tree.
 */
describe('Engine boot in sidecar mode', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const anchors: ReturnType<typeof anchorFromFd>[] = [];
  const saved = process.env['LYNOX_DATA_DIR'];

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    closeWorkspaceBase();
    _resetWorkspaceAccess();
    _resetCache();
    for (const a of anchors) closeAnchor(a);
    anchors.length = 0;
    if (saved === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = saved;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    resetShellIsolationForTest();
    reloadConfig();
  });

  it('starts, makes the context directory from fd 3 with the layout\'s group and mode, and reaches nothing by name', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-sidecar-boot-')));
    dirs.push(dir);
    const data = join(dir, 'data');
    const tree = join(dir, 'tree');
    mkdirSync(data);
    mkdirSync(tree);
    process.env['LYNOX_DATA_DIR'] = data;
    reloadConfig();
    const anchor = anchorFromFd(openSync(tree, constants.O_PATH | constants.O_DIRECTORY), WORKSPACE_LABEL);
    anchors.push(anchor);
    const sidecar: ShellIsolation = { kind: 'sidecar', socket: join(dir, 'exec.sock'), root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } };
    setShellIsolationForTest(sidecar);
    touched.length = 0;
    chowns.length = 0;

    const engine = new Engine({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as unknown as LynoxConfig);
    engines.push(engine);
    await engine.init();

    expect(engine.getToolContext().shellIsolation).toBe(sidecar);
    expect(engine.getContext()?.workspaceDir).toBe('/workspace/http-api');
    expect(getWorkspaceDir()).toBe('/workspace/http-api');
    // Made below fd 3, with the layout's mode and group, and nothing under the data directory.
    expect(statSync(join(tree, 'http-api')).mode & 0o7777).toBe(0o2770);
    expect(chowns).toContain(1002);
    expect(existsSync(join(data, 'workspace'))).toBe(false);
    // The one call by name is start check (i) for the context label (`resolveContext`): it tries to
    // create a child there and must fail (ENOENT or EROFS). Everything else goes through fd 3.
    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatch(/^openSync\(\/workspace\/http-api\/\.lynox-probe-[0-9a-f]+\)$/);
  });

  it('gives a context made without an engine the process\'s mode, not "local"', () => {
    const sidecar = { kind: 'sidecar', socket: '/run/lynox-exec/exec.sock', root: { mode: 'sidecar', anchor: {}, label: '/workspace' } } as unknown as ShellIsolation;
    setShellIsolationForTest(sidecar);
    expect(createToolContext({}).shellIsolation).toBe(sidecar);
  });
});
