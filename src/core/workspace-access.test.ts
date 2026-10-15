import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAnchoredRoot, workspaceAccess, _resetWorkspaceAccess } from './workspace-access.js';
import { emptyDir, WorkspaceAccessError } from './workspace-fd.js';
import { WorkspaceRootError } from './workspace-root.js';

describe('workspace access — the anchored root', () => {
  let tmp: string;
  let data: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-access-')));
    data = join(tmp, 'data');
    mkdirSync(data);
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = data;
    delete process.env['LYNOX_DIR'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    _resetWorkspaceAccess();
  });

  afterEach(() => {
    _resetWorkspaceAccess();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('anchors the default root, and knows <data>/workspace as that root', () => {
    mkdirSync(join(data, 'workspace'));
    const access = workspaceAccess();
    expect(access.root.mode).toBe('default');
    expect(fstatSync(access.anchor.fd).ino).toBe(statSync(join(data, 'workspace')).ino);
    expect(isAnchoredRoot(access, join(data, 'workspace'))).toBe(true);
    expect(isAnchoredRoot(access, data)).toBe(false);
    expect(isAnchoredRoot(access, join(data, 'missing'))).toBe(false);
  });

  it('anchors a default root that is a symlink, and knows the link as the root (I12d)', () => {
    const real = join(tmp, 'elsewhere');
    mkdirSync(real);
    symlinkSync(real, join(data, 'workspace'));
    const access = workspaceAccess();
    expect(access.root.mode).toBe('default');
    // Compared through the link (stat), not on the link itself (lstat).
    expect(isAnchoredRoot(access, join(data, 'workspace'))).toBe(true);
  });

  it('keeps one anchor for one root and opens a new one when the root names another path', () => {
    mkdirSync(join(data, 'workspace'));
    const first = workspaceAccess();
    expect(workspaceAccess()).toBe(first);
    const other = join(tmp, 'other');
    mkdirSync(join(other, 'workspace'), { recursive: true });
    process.env['LYNOX_DATA_DIR'] = other;
    const second = workspaceAccess();
    expect(second).not.toBe(first);
    expect(fstatSync(second.anchor.fd).ino).toBe(statSync(join(other, 'workspace')).ino);
  });

  it('a root removed under the anchor is loud, never an empty success (I1g)', () => {
    mkdirSync(join(data, 'workspace'));
    writeFileSync(join(data, 'workspace', 'a.txt'), 'x');
    const access = workspaceAccess();
    rmSync(join(data, 'workspace'), { recursive: true });
    mkdirSync(join(data, 'workspace'));
    // Same name, another directory: the held anchor is not silently reopened.
    expect(() => workspaceAccess()).toThrow('no longer the directory this engine opened');
    expect(() => emptyDir(access.anchor, '')).toThrow(WorkspaceAccessError);
    try { emptyDir(access.anchor, ''); } catch (err) { expect((err as WorkspaceAccessError).code).toBe('GONE'); }
  });

  it('a root moved away and replaced is loud, never the old directory taken for the workspace', () => {
    mkdirSync(join(data, 'workspace'));
    workspaceAccess();
    // The old directory still lives (no GONE), so only the identity check sees the swap.
    renameSync(join(data, 'workspace'), join(tmp, 'archived'));
    mkdirSync(join(data, 'workspace'));
    expect(() => workspaceAccess()).toThrow(WorkspaceRootError);
    expect(() => workspaceAccess()).toThrow('no longer the directory this engine opened');
  });

  it('a default link pointed somewhere else is loud', () => {
    const first = join(tmp, 'first');
    const second = join(tmp, 'second');
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, join(data, 'workspace'));
    workspaceAccess();
    rmSync(join(data, 'workspace'));
    symlinkSync(second, join(data, 'workspace'));
    expect(() => workspaceAccess()).toThrow('no longer the directory this engine opened');
  });

  it('throws WorkspaceRootError when the root cannot be opened', () => {
    writeFileSync(join(data, 'workspace'), 'not a directory');
    expect(() => workspaceAccess()).toThrow(WorkspaceRootError);
  });
});
