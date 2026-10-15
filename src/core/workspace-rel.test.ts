import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toWorkspaceRel, workspaceBase, closeWorkspaceBase, WorkspacePathRefused } from './workspace-rel.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { _resetWorkspaceAccess } from './workspace-access.js';
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
    const dirA = join(tmp, 'rootA');
    const dirB = join(tmp, 'rootB');
    mkdirSync(join(dirA, 'http-api'), { recursive: true });
    mkdirSync(join(dirB, 'http-api'), { recursive: true });
    const link = join(tmp, 'root');
    symlinkSync(dirA, link);
    process.env['LYNOX_WORKSPACE_ROOT'] = link;
    _resetWorkspaceAccess();
    setTenantWorkspace(join(link, 'http-api'));

    await writeFileTool.handler({ path: join(link, 'http-api', 'one.txt'), content: '1' }, agent());
    expect(existsSync(join(dirA, 'http-api', 'one.txt'))).toBe(true);

    // The root now names another directory: the held root is a new object, and the context
    // workspace follows it instead of writing on into the old one.
    unlinkSync(link);
    symlinkSync(dirB, link);
    _resetWorkspaceAccess();
    await writeFileTool.handler({ path: join(link, 'http-api', 'two.txt'), content: '2' }, agent());
    expect(existsSync(join(dirB, 'http-api', 'two.txt'))).toBe(true);
    expect(existsSync(join(dirA, 'http-api', 'two.txt'))).toBe(false);
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
