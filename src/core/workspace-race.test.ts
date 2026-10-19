import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Two checks that only matter when the filesystem changes between two system calls. Each test
 * makes that change happen exactly there, from a stand-in around the call, instead of hoping a
 * second process hits the window.
 */
const hooks: { beforeOpen: ((flags: unknown) => void) | null; beforeAnchor: ((path: string) => void) | null } = {
  beforeOpen: null,
  beforeAnchor: null,
};

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync = (...args: Parameters<typeof real.openSync>) => {
    const hook = hooks.beforeOpen;
    if (hook !== null) hook(args[1]);
    return real.openSync(...args);
  };
  return { ...real, default: { ...real, openSync }, openSync };
});

vi.mock('./workspace-fd.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./workspace-fd.js')>();
  return {
    ...real,
    openAnchor: (path: string) => {
      const hook = hooks.beforeAnchor;
      if (hook !== null) hook(path);
      return real.openAnchor(path);
    },
  };
});

const fs = await import('node:fs');
const { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } = fs;
const { writeFileTool } = await import('../tools/builtin/fs.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('./workspace.js');
const { closeWorkspaceBase } = await import('./workspace-rel.js');
const { _resetWorkspaceAccess, workspaceAccess } = await import('./workspace-access.js');
import type { IAgent, SessionCounters } from '../types/index.js';

const agent = (): IAgent => ({ sessionCounters: { writeBytes: 0, httpRequests: 0 } as unknown as SessionCounters }) as unknown as IAgent;

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-race-')));
  for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
  process.env['LYNOX_DATA_DIR'] = join(tmp, 'data');
  delete process.env['LYNOX_DIR'];
  delete process.env['LYNOX_WORKSPACE_ROOT'];
  _resetWorkspaceAccess();
  closeWorkspaceBase();
});

afterEach(() => {
  hooks.beforeOpen = null;
  hooks.beforeAnchor = null;
  closeWorkspaceBase();
  clearTenantWorkspace();
  _resetWorkspaceAccess();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('a change between two system calls', () => {
  it('does not create a new file through a link that appears after the file was found missing', async () => {
    const ws = join(tmp, 'data', 'workspace', 'http-api');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(tmp, 'target'), 'outside');
    setTenantWorkspace(ws);
    const findWrite = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let planted = false;
    hooks.beforeOpen = (flags) => {
      // The open that finds the file missing: the link appears right after it.
      if (flags === findWrite && !planted) {
        planted = true;
        hooks.beforeOpen = null;
        const err = Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT' });
        symlinkSync(join(tmp, 'target'), join(ws, 'new.txt'));
        throw err;
      }
    };
    await expect(writeFileTool.handler({ path: join(ws, 'new.txt'), content: 'through the link' }, agent())).rejects.toThrow(/EEXIST|symlink/);
    expect(planted).toBe(true);
    expect(readFileSync(join(tmp, 'target'), 'utf8')).toBe('outside');
  });

  it('does not take over a file that someone else creates after the file was found missing', async () => {
    const ws = join(tmp, 'data', 'workspace', 'http-api');
    mkdirSync(ws, { recursive: true });
    setTenantWorkspace(ws);
    const findWrite = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let planted = false;
    hooks.beforeOpen = (flags) => {
      if (flags === findWrite && !planted) {
        planted = true;
        hooks.beforeOpen = null;
        writeFileSync(join(ws, 'new.txt'), 'theirs', { mode: 0o600 });
        throw Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT' });
      }
    };
    await expect(writeFileTool.handler({ path: join(ws, 'new.txt'), content: 'mine' }, agent())).rejects.toThrow(/EEXIST/);
    expect(planted).toBe(true);
    expect(readFileSync(join(ws, 'new.txt'), 'utf8')).toBe('theirs');
    expect(statSync(join(ws, 'new.txt')).mode & 0o777).toBe(0o600);
  });

  it('refuses the root as the workspace when another directory took its name after the root was checked', async () => {
    const root = join(tmp, 'data', 'workspace');
    mkdirSync(root, { recursive: true });
    setTenantWorkspace(root);
    workspaceAccess();
    let swapped = false;
    hooks.beforeAnchor = (path) => {
      // `workspaceAccess` has just found the root unchanged; it changes before the workspace's
      // own fd is opened by name.
      if (path === root && !swapped) {
        swapped = true;
        renameSync(root, `${root}-old`);
        mkdirSync(root);
      }
    };
    await expect(writeFileTool.handler({ path: join(root, 'x.txt'), content: 'x' }, agent())).rejects.toThrow(/no longer the directory this engine opened/);
    expect(swapped).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(`${root}-old`, 'x.txt'))).toBe(false);
  });
});
