import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, fstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { getWorkspaceDir, _resetCache } from './workspace.js';
import { WorkspaceRootError } from './workspace-root.js';
import { workspaceAccess, _resetWorkspaceAccess } from './workspace-access.js';

/**
 * The workspace root as a real Engine boots on it. The unit tests call the root's functions
 * directly; only a boot shows that `Engine.init` calls them, and that a root it cannot use stops
 * the start instead of every upload falling back to inline text later.
 */
describe('Engine boot — workspace root', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const IS_ROOT = process.getuid?.() === 0;

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    _resetCache();
    reloadConfig();
  });

  function setEnv(name: string, value: string | undefined): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }

  function dataDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-wsrootboot-')));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_DIR', undefined);
    setEnv('LYNOX_WORKSPACE', undefined);
    setEnv('LYNOX_WORKSPACE_ROOT', undefined);
    reloadConfig();
    _resetCache();
    _resetWorkspaceAccess();
    return dir;
  }

  async function boot(): Promise<Engine> {
    const engine = new Engine({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { await engine.init(); } finally { stderr.mockRestore(); }
    return engine;
  }

  it('boots on the default root as before: <data>/workspace/http-api, 0700, by name', async () => {
    const data = dataDir();
    await boot();
    const ws = join(data, 'workspace', 'http-api');
    expect(getWorkspaceDir()).toBe(ws);
    expect(statSync(ws).mode & 0o777).toBe(0o700);
  });

  it('holds the workspace anchor from boot (D1)', async () => {
    const data = dataDir();
    await boot();
    const booted = statSync(join(data, 'workspace')).ino;
    // Replaced by name after boot: an anchor held since boot still names the booted directory;
    // one opened lazily now would name the new one.
    rmSync(join(data, 'workspace'), { recursive: true });
    mkdirSync(join(data, 'workspace'));
    expect(fstatSync(workspaceAccess().anchor.fd).ino).toBe(booted);
  });

  it('boots on a symlinked <data>/workspace and keeps the by-name path', async () => {
    const data = dataDir();
    const target = join(data, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, join(data, 'workspace'));
    await boot();
    expect(getWorkspaceDir()).toBe(join(data, 'workspace', 'http-api'));
    expect(statSync(join(target, 'http-api')).isDirectory()).toBe(true);
  });

  it('refuses to start on an external root (I7)', async () => {
    const data = dataDir();
    const other = join(data, 'volume');
    mkdirSync(other);
    setEnv('LYNOX_WORKSPACE_ROOT', other);
    await expect(boot()).rejects.toThrow(WorkspaceRootError);
    await expect(boot()).rejects.toThrow('This engine version does not support that');
  });

  it.skipIf(IS_ROOT)('refuses to start when the root cannot be read, naming the root (I11; skipped as root)', async () => {
    const data = dataDir();
    const root = join(data, 'workspace');
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o000);
    try {
      await expect(boot()).rejects.toThrow(`The workspace root ${root} cannot be used (EACCES).`);
    } finally { chmodSync(root, 0o700); }
  });

  it.skipIf(IS_ROOT)('refuses to start when the context directory cannot be written, naming it (I11; skipped as root)', async () => {
    const data = dataDir();
    const ws = join(data, 'workspace', 'http-api');
    mkdirSync(ws, { recursive: true, mode: 0o700 });
    chmodSync(ws, 0o500);
    try {
      await expect(boot()).rejects.toThrow(`The workspace directory ${ws} cannot be used (EACCES).`);
    } finally { chmodSync(ws, 0o700); }
  });
});
