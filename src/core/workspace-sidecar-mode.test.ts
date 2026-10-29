import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL, type ShellIsolation } from './shell-isolation.js';
import { anchorFromFd, closeAnchor, writeFileAt, type WorkspaceAnchor } from './workspace-fd.js';
import { ensureWorkspaceRoot, resolveWorkspaceRoot, translateLegacyWorkspacePath, workspaceLegacyPending } from './workspace-root.js';
import { _resetWorkspaceAccess, leaseWorkspaceFor, workspaceAccess } from './workspace-access.js';
import { closeWorkspaceBase, workspaceBase } from './workspace-rel.js';
import { _resetCache, setTenantWorkspace } from './workspace.js';

/**
 * In shell sidecar mode the workspace is the fd the entrypoint hands over, and `/workspace` is only
 * a label (PRD shell-sidecar-activation D3). The label does not exist on the test machine, so any
 * site that still reached the tree by name would fail here or land somewhere else; each test below
 * names the by-name outcome it rules out.
 */
describe('the workspace in shell sidecar mode (D3)', () => {
  let tmp: string;
  let tree: string;
  let data: string;
  let anchor: WorkspaceAnchor;
  let isolation: ShellIsolation;
  let prevData: string | undefined;
  let prevRoot: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-sidecar-')));
    tree = join(tmp, 'tree');
    data = join(tmp, 'data');
    mkdirSync(join(tree, 'ctx1'), { recursive: true });
    mkdirSync(data);
    prevData = process.env['LYNOX_DATA_DIR'];
    prevRoot = process.env['LYNOX_WORKSPACE_ROOT'];
    process.env['LYNOX_DATA_DIR'] = data;
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    anchor = anchorFromFd(openSync(tree, constants.O_RDONLY | constants.O_DIRECTORY), WORKSPACE_LABEL);
    isolation = { kind: 'sidecar', socket: join(tmp, 'exec.sock'), root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } };
    setShellIsolationForTest(isolation);
    _resetCache();
    setTenantWorkspace(`${WORKSPACE_LABEL}/ctx1`);
  });

  afterEach(() => {
    closeWorkspaceBase();
    _resetWorkspaceAccess();
    _resetCache();
    resetShellIsolationForTest();
    closeAnchor(anchor);
    if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
    if (prevRoot === undefined) delete process.env['LYNOX_WORKSPACE_ROOT']; else process.env['LYNOX_WORKSPACE_ROOT'] = prevRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the root is the label, whatever a root variable names', () => {
    // By name this would be the directory the variable names.
    mkdirSync(join(tmp, 'elsewhere'));
    process.env['LYNOX_WORKSPACE_ROOT'] = join(tmp, 'elsewhere');
    expect(resolveWorkspaceRoot()).toEqual({ path: WORKSPACE_LABEL, mode: 'sidecar' });
  });

  it('the boot check of the root creates and checks nothing by name', () => {
    // By name this would make `<data>/workspace` or fail on the label it cannot read.
    expect(ensureWorkspaceRoot()).toEqual({ path: WORKSPACE_LABEL, mode: 'sidecar' });
    expect(existsSync(join(data, 'workspace'))).toBe(false);
  });

  it('the held root is fd 3 itself, the same object on every call', () => {
    const first = workspaceAccess();
    expect(first.anchor).toBe(anchor);
    expect(first.root).toEqual({ path: WORKSPACE_LABEL, mode: 'sidecar' });
    expect(workspaceAccess()).toBe(first);
  });

  it('the engine\'s own data directory leases fd 3; another one is refused and nothing is made there', () => {
    expect(leaseWorkspaceFor(data)?.access.anchor).toBe(anchor);
    const foreign = join(tmp, 'foreign');
    mkdirSync(foreign);
    expect(() => leaseWorkspaceFor(foreign, { create: true })).toThrow(/not opened by name/);
    expect(existsSync(join(foreign, 'workspace'))).toBe(false);
  });

  it('the context workspace is reached from fd 3: a write lands in the handed-over tree', () => {
    const base = workspaceBase();
    expect(base?.ws).toBe(`${WORKSPACE_LABEL}/ctx1`);
    writeFileAt(base!.anchor, 'note.txt', 'hello', { fileMode: 0o600 });
    expect(readFileSync(join(tree, 'ctx1', 'note.txt'), 'utf8')).toBe('hello');
    expect(workspaceBase()).toBe(base);
  });

  it('a context workspace outside the label is refused, even where a directory of that name exists', () => {
    // By name this directory would be opened as the workspace.
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    setTenantWorkspace(outside);
    expect(() => workspaceBase()).toThrow(/must be a directory below \/workspace/);
    setTenantWorkspace(WORKSPACE_LABEL);
    expect(() => workspaceBase()).toThrow(/must be a directory below \/workspace/);
  });

  it('old workspace paths map onto the label without reading `<data>/workspace`', () => {
    // By name a non-empty `<data>/workspace` counts as pending, and the old path is refused.
    mkdirSync(join(data, 'workspace'));
    writeFileSync(join(data, 'workspace', 'left.txt'), 'x');
    const root = resolveWorkspaceRoot();
    expect(workspaceLegacyPending(root)).toBe(false);
    expect(translateLegacyWorkspacePath(join(data, 'workspace', 'ctx1', 'a.txt'), root)).toBe(`${WORKSPACE_LABEL}/ctx1/a.txt`);
  });
});

describe('the workspace outside shell sidecar mode is unchanged (D3)', () => {
  let tmp: string;
  let data: string;
  let prevData: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-local-')));
    data = join(tmp, 'data');
    mkdirSync(data);
    prevData = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = data;
    setShellIsolationForTest({ kind: 'local' });
    _resetCache();
  });

  afterEach(() => {
    closeWorkspaceBase();
    _resetWorkspaceAccess();
    _resetCache();
    resetShellIsolationForTest();
    if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the default root is still `<data>/workspace`, made by name at boot and opened by name', () => {
    expect(ensureWorkspaceRoot()).toEqual({ path: join(data, 'workspace'), mode: 'default' });
    expect(existsSync(join(data, 'workspace'))).toBe(true);
    expect(workspaceAccess().root).toEqual({ path: join(data, 'workspace'), mode: 'default' });
  });

  it('another data directory\'s workspace is still leased by name', () => {
    const foreign = join(tmp, 'foreign');
    mkdirSync(foreign);
    const lease = leaseWorkspaceFor(foreign, { create: true });
    expect(existsSync(join(foreign, 'workspace'))).toBe(true);
    lease?.release();
  });

  it('a context workspace outside the root is still opened by name', () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    setTenantWorkspace(outside);
    writeFileAt(workspaceBase()!.anchor, 'note.txt', 'hello', { fileMode: 0o600 });
    expect(readFileSync(join(outside, 'note.txt'), 'utf8')).toBe('hello');
  });
});
