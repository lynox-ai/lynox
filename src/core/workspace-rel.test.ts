import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toWorkspaceRel, workspaceBase, closeWorkspaceBase, WorkspacePathRefused } from './workspace-rel.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { _resetWorkspaceAccess, workspaceAccess } from './workspace-access.js';
import { writeFileAt } from './workspace-fd.js';
import { writeFileTool } from '../tools/builtin/fs.js';
import type { IAgent, SessionCounters } from '../types/index.js';

function agent(): IAgent {
  const sessionCounters: SessionCounters = { writeBytes: 0, httpRequests: 0, httpBytes: 0, spawnDepth: 0 } as unknown as SessionCounters;
  return { sessionCounters } as unknown as IAgent;
}

describe('toWorkspaceRel', () => {
  const ws = '/srv/ws/http-api';

  it('refuses every path through a process handle, before touching the filesystem', () => {
    for (const p of [
      '/proc/self/fd/3/a.txt',
      '/proc/self/fd/3',
      '/proc/thread-self/fd/3/a.txt',
      '/proc/1/root/etc/passwd',
      '/proc/self/root/srv/ws/http-api/a.txt',
      '/proc/self/cwd/a.txt',
      '/proc/self/fdinfo/3',
      '/proc/self/map_files/x',
      '/dev/fd/3/a.txt',
      '/dev/fd',
      '/proc/self/task/12/fd/3/a.txt',
      '/proc/1/task/1/root/etc/passwd',
      '/proc/self/task/12/cwd/a.txt',
      '/dev/stdin',
      '/dev/stderr',
      '//proc/./self/fd/0',
      '/proc/net/../self/root/srv/ws/http-api/a.txt',
    ]) {
      expect(() => toWorkspaceRel(p, ws), p).toThrow(WorkspacePathRefused);
    }
  });

  it('leaves other /proc and /dev paths to the boundary check, which keeps them outside', () => {
    expect(toWorkspaceRel('/proc/self/status', ws)).toEqual({ kind: 'outside', abs: '/proc/self/status' });
    expect(toWorkspaceRel('/dev/null', ws)).toEqual({ kind: 'outside', abs: '/dev/null' });
  });

  it('maps a path in the workspace onto its relative path, and leaves the rest outside', () => {
    expect(toWorkspaceRel('/srv/ws/http-api/a/b.txt', ws)).toEqual({ kind: 'inside', rel: 'a/b.txt', shown: '/srv/ws/http-api/a/b.txt' });
    expect(toWorkspaceRel('/srv/ws/http-api/a/../b.txt', ws)).toMatchObject({ kind: 'inside', rel: 'b.txt' });
    expect(toWorkspaceRel('/srv/ws/http-api', ws)).toMatchObject({ kind: 'inside', rel: '' });
    expect(toWorkspaceRel('/srv/ws/http-api/../other/x', ws)).toEqual({ kind: 'outside', abs: '/srv/ws/other/x' });
    expect(toWorkspaceRel('/srv/ws/http-api-2/x', ws)).toMatchObject({ kind: 'outside' });
    expect(toWorkspaceRel('/tmp/x', ws)).toEqual({ kind: 'outside', abs: '/tmp/x' });
  });

  it('accepts the workspace under its real path too, the path the tools answer with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-rel-'));
    try {
      const real = realpathSync(dir);
      const link = `${dir}-link`;
      symlinkSync(real, link);
      try {
        expect(toWorkspaceRel(join(real, 'f.txt'), link)).toMatchObject({ kind: 'inside', rel: 'f.txt', shown: join(link, 'f.txt') });
      } finally {
        unlinkSync(link);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a NUL byte', () => {
    expect(() => toWorkspaceRel('/srv/ws/http-api/a\0b', ws)).toThrow(WorkspacePathRefused);
  });
});

describe('workspaceBase', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-base-')));
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = join(tmp, 'data');
    mkdirSync(join(tmp, 'data'), { recursive: true });
    delete process.env['LYNOX_DIR'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    _resetWorkspaceAccess();
    closeWorkspaceBase();
  });

  afterEach(() => {
    closeWorkspaceBase();
    clearTenantWorkspace();
    _resetWorkspaceAccess();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is null without isolation', () => {
    clearTenantWorkspace();
    expect(workspaceBase()).toBeNull();
  });

  it('derives the context workspace from the root it holds, and keeps it across calls', () => {
    const root = join(tmp, 'data', 'workspace');
    mkdirSync(join(root, 'http-api'), { recursive: true });
    setTenantWorkspace(join(root, 'http-api'));
    const first = workspaceBase();
    expect(first).not.toBeNull();
    expect(workspaceBase()).toBe(first);
    writeFileAt(first!.anchor, 'probe.txt', 'p', { fileMode: 0o600 });
    expect(readFileSync(join(root, 'http-api', 'probe.txt'), 'utf8')).toBe('p');
  });

  it('derives again when the root was reconfigured to another directory under the same name', async () => {
    // The default root is `<data>/workspace` by name, and it may be a link (PRD D2): re-pointing
    // the link and reopening the root gives the same workspace path a different directory.
    const dirA = join(tmp, 'rootA');
    const dirB = join(tmp, 'rootB');
    mkdirSync(join(dirA, 'http-api'), { recursive: true });
    mkdirSync(join(dirB, 'http-api'), { recursive: true });
    const link = join(tmp, 'data', 'workspace');
    symlinkSync(dirA, link);
    _resetWorkspaceAccess();
    const ws = join(link, 'http-api');
    setTenantWorkspace(ws);

    await writeFileTool.handler({ path: join(ws, 'one.txt'), content: '1' }, agent());
    expect(existsSync(join(dirA, 'http-api', 'one.txt'))).toBe(true);

    // The root now names another directory: the held root is a new object, and the context
    // workspace follows it instead of writing on into the old one.
    unlinkSync(link);
    symlinkSync(dirB, link);
    _resetWorkspaceAccess();
    await writeFileTool.handler({ path: join(ws, 'two.txt'), content: '2' }, agent());
    expect(existsSync(join(dirB, 'http-api', 'two.txt'))).toBe(true);
    expect(existsSync(join(dirA, 'http-api', 'two.txt'))).toBe(false);
  });

  it('refuses a context directory that is a symlink, and writes nothing where it points', async () => {
    const root = join(tmp, 'data', 'workspace');
    const foreign = join(tmp, 'foreign');
    mkdirSync(root, { recursive: true });
    mkdirSync(foreign);
    symlinkSync(foreign, join(root, 'http-api'));
    setTenantWorkspace(join(root, 'http-api'));
    expect(() => workspaceBase()).toThrow(/http-api is a symlink/);
    await expect(writeFileTool.handler({ path: join(root, 'http-api', 'x.txt'), content: 'x' }, agent())).rejects.toThrow(/symlink/);
    expect(readdirSync(foreign)).toEqual([]);
  });

  it('descends to a context directory deeper below the root, and refuses a link on the way', async () => {
    const root = join(tmp, 'data', 'workspace');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    setTenantWorkspace(join(root, 'a', 'b'));
    await writeFileTool.handler({ path: join(root, 'a', 'b', 'deep.txt'), content: 'd' }, agent());
    expect(readFileSync(join(root, 'a', 'b', 'deep.txt'), 'utf8')).toBe('d');

    closeWorkspaceBase();
    const foreign = join(tmp, 'foreign');
    mkdirSync(join(foreign, 'b'), { recursive: true });
    rmSync(join(root, 'a'), { recursive: true });
    symlinkSync(foreign, join(root, 'a'));
    expect(() => workspaceBase()).toThrow(/a is a symlink/);
    expect(readdirSync(join(foreign, 'b'))).toEqual([]);
  });

  it('does not make a missing context directory below the root', () => {
    const root = join(tmp, 'data', 'workspace');
    mkdirSync(root, { recursive: true });
    setTenantWorkspace(join(root, 'gone'));
    expect(() => workspaceBase()).toThrow(/ENOENT/);
    expect(existsSync(join(root, 'gone'))).toBe(false);
  });

  it('works on the root itself as the workspace, without closing the root', async () => {
    const root = join(tmp, 'data', 'workspace');
    mkdirSync(root, { recursive: true });
    setTenantWorkspace(root);
    await writeFileTool.handler({ path: join(root, 'top.txt'), content: 't' }, agent());
    expect(readFileSync(join(root, 'top.txt'), 'utf8')).toBe('t');
    closeWorkspaceBase();
    // The held root still works after the workspace's own fd was closed.
    expect(() => workspaceAccess()).not.toThrow();
    await writeFileTool.handler({ path: join(root, 'again.txt'), content: 'a' }, agent());
    expect(readFileSync(join(root, 'again.txt'), 'utf8')).toBe('a');
  });

  it('finds the workspace below a root spelled through a link, by the root\'s real path', async () => {
    const realData = join(tmp, 'real-data');
    mkdirSync(join(realData, 'workspace', 'http-api'), { recursive: true });
    const dataLink = join(tmp, 'data-link');
    symlinkSync(realData, dataLink);
    process.env['LYNOX_DATA_DIR'] = dataLink;
    _resetWorkspaceAccess();
    const ws = join(realData, 'workspace', 'http-api');
    setTenantWorkspace(ws);
    await writeFileTool.handler({ path: join(ws, 'r.txt'), content: 'r' }, agent());
    expect(readFileSync(join(ws, 'r.txt'), 'utf8')).toBe('r');
  });

  it('refuses a workspace that reaches the root only through a link', async () => {
    const dirA = join(tmp, 'rootA');
    mkdirSync(join(dirA, 'http-api'), { recursive: true });
    const link = join(tmp, 'root');
    symlinkSync(dirA, link);
    process.env['LYNOX_WORKSPACE_ROOT'] = link;
    _resetWorkspaceAccess();
    setTenantWorkspace(join(link, 'http-api'));
    expect(() => workspaceBase()).toThrow(/only through a link/);
    await expect(writeFileTool.handler({ path: join(link, 'http-api', 'x.txt'), content: 'x' }, agent())).rejects.toThrow(/only through a link/);
    expect(existsSync(join(dirA, 'http-api', 'x.txt'))).toBe(false);
  });

  it('reaches the context directory again after it was emptied and made again below the root', async () => {
    const root = join(tmp, 'data', 'workspace');
    const ws = join(root, 'http-api');
    mkdirSync(ws, { recursive: true });
    setTenantWorkspace(ws);
    await writeFileTool.handler({ path: join(ws, 'before.txt'), content: 'b' }, agent());
    // What the erasure does: the root is emptied, the context directory made again.
    rmSync(ws, { recursive: true });
    mkdirSync(ws);
    await writeFileTool.handler({ path: join(ws, 'after.txt'), content: 'a' }, agent());
    expect(readFileSync(join(ws, 'after.txt'), 'utf8')).toBe('a');
  });

  it('refuses a workspace outside the root that holds the data directory', async () => {
    setTenantWorkspace(tmp);
    expect(() => workspaceBase()).toThrow(/is the data directory or contains it/);
    await expect(writeFileTool.handler({ path: join(tmp, 'data', 'engine.db'), content: 'x' }, agent())).rejects.toThrow(/data directory/);
    expect(existsSync(join(tmp, 'data', 'engine.db'))).toBe(false);
  });

  it('does not reopen a workspace directory that was removed and made again under its name', async () => {
    const ws = join(tmp, 'own-ws');
    mkdirSync(ws);
    setTenantWorkspace(ws);
    await writeFileTool.handler({ path: join(ws, 'a.txt'), content: 'a' }, agent());

    rmSync(ws, { recursive: true });
    mkdirSync(ws);
    await expect(writeFileTool.handler({ path: join(ws, 'b.txt'), content: 'b' }, agent())).rejects.toThrow(/removed while held open/);
    expect(existsSync(join(ws, 'b.txt'))).toBe(false);
  });

  it('closes its directory on dispose', () => {
    const ws = join(tmp, 'own-ws');
    mkdirSync(ws);
    setTenantWorkspace(ws);
    const fd = workspaceBase()!.anchor.fd;
    expect(() => fstatSync(fd)).not.toThrow();
    closeWorkspaceBase();
    expect(() => fstatSync(fd)).toThrow(/EBADF/);
  });
});
