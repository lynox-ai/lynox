import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceRootError,
  ensureWorkspaceContextDir,
  ensureWorkspaceRoot,
  getWorkspaceRoot,
  resolveWorkspaceRoot,
  translateLegacyWorkspacePath,
  workspaceLegacyPending,
  workspaceRootIsMount,
} from './workspace-root.js';
import { resolveContext } from './context.js';
import { getFileAreaDir, _resetCache } from './workspace.js';
import type { LynoxConfig } from '../types/index.js';

const IS_ROOT = process.getuid?.() === 0;

describe('workspace root', () => {
  let tmp: string;
  let data: string;
  let byName: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-ws-root-')));
    data = join(tmp, 'data');
    mkdirSync(data);
    byName = join(data, 'workspace');
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT', 'LYNOX_WORKSPACE']) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = data;
    delete process.env['LYNOX_DIR'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    delete process.env['LYNOX_WORKSPACE'];
    _resetCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetCache();
    // Restore modes a test took away, so the tree can be removed.
    try { chmodSync(byName, 0o700); } catch { /* not there */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  const contextDir = (): string => resolveContext({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as unknown as LynoxConfig).workspaceDir;

  describe('the default is what it was (I3)', () => {
    it('unset: <data>/workspace by name, created 0700 at boot, and every consumer resolves under it', () => {
      expect(resolveWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
      expect(ensureWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
      expect(statSync(byName).mode & 0o777).toBe(0o700);
      expect(contextDir()).toBe(join(byName, 'http-api'));
      expect(getFileAreaDir()).toBe(byName);
    });

    it('empty counts as unset', () => {
      process.env['LYNOX_WORKSPACE_ROOT'] = '';
      expect(resolveWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
    });

    it('a variable that names the default by another spelling is the default, returned by name', () => {
      mkdirSync(byName);
      const alias = join(tmp, 'alias');
      symlinkSync(byName, alias);
      for (const spelling of [`${byName}/`, join(data, '.', 'workspace'), alias]) {
        process.env['LYNOX_WORKSPACE_ROOT'] = spelling;
        expect(resolveWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
      }
    });

    it('a symlinked <data>/workspace is the default, and the paths stay the by-name ones, not the target', () => {
      const target = join(tmp, 'elsewhere');
      mkdirSync(target);
      symlinkSync(target, byName);
      expect(ensureWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
      expect(contextDir()).toBe(join(byName, 'http-api'));
      expect(getWorkspaceRoot()).toBe(byName);
      // And with the variable set to the link's target: the same object, so the default (stat, not lstat).
      process.env['LYNOX_WORKSPACE_ROOT'] = target;
      expect(resolveWorkspaceRoot()).toEqual({ path: byName, mode: 'default' });
    });
  });

  describe('an external root is refused by this engine (I7)', () => {
    it('refuses a root that is another directory, naming both', () => {
      const other = join(tmp, 'volume');
      mkdirSync(other);
      mkdirSync(byName);
      process.env['LYNOX_WORKSPACE_ROOT'] = other;
      expect(() => resolveWorkspaceRoot()).toThrow(WorkspaceRootError);
      expect(() => resolveWorkspaceRoot()).toThrow(`LYNOX_WORKSPACE_ROOT names ${other}, a workspace root other than ${byName}. This engine version does not support that`);
      expect(() => ensureWorkspaceRoot()).toThrow(WorkspaceRootError);
      expect(() => contextDir()).toThrow(WorkspaceRootError);
      expect(() => getFileAreaDir()).toThrow(WorkspaceRootError);
    });

    it('refuses it when <data>/workspace does not exist (the state after a move)', () => {
      const other = join(tmp, 'volume');
      mkdirSync(other);
      process.env['LYNOX_WORKSPACE_ROOT'] = other;
      expect(() => resolveWorkspaceRoot()).toThrow('a workspace root other than');
    });

    it('with the seam open, an external root is its realpath', () => {
      const other = join(tmp, 'volume');
      mkdirSync(other);
      const link = join(tmp, 'volume-link');
      symlinkSync(other, link);
      process.env['LYNOX_WORKSPACE_ROOT'] = link;
      expect(resolveWorkspaceRoot({ allowExternal: true })).toEqual({ path: other, mode: 'external' });
    });
  });

  describe('a root that cannot be used stops the boot, naming the path (I11)', () => {
    it('a variable naming a missing path', () => {
      const missing = join(tmp, 'missing');
      process.env['LYNOX_WORKSPACE_ROOT'] = missing;
      expect(() => ensureWorkspaceRoot()).toThrow(`LYNOX_WORKSPACE_ROOT names ${missing}, which cannot be used (ENOENT).`);
    });

    it('a variable naming a file', () => {
      const file = join(tmp, 'file');
      writeFileSync(file, 'x');
      process.env['LYNOX_WORKSPACE_ROOT'] = file;
      expect(() => ensureWorkspaceRoot()).toThrow(`LYNOX_WORKSPACE_ROOT names ${file}, which is not a directory.`);
    });

    it('a dangling symlink at <data>/workspace', () => {
      symlinkSync(join(tmp, 'gone'), byName);
      expect(() => ensureWorkspaceRoot()).toThrow(`The workspace root ${byName} cannot be created (ENOENT).`);
    });

    it('a file at <data>/workspace', () => {
      writeFileSync(byName, 'x');
      expect(() => ensureWorkspaceRoot()).toThrow(WorkspaceRootError);
      expect(() => ensureWorkspaceRoot()).toThrow(byName);
    });

    it.skipIf(IS_ROOT)('a root that cannot be read (skipped as root, which reads anything)', () => {
      mkdirSync(byName, { mode: 0o700 });
      chmodSync(byName, 0o000);
      expect(() => ensureWorkspaceRoot()).toThrow(`The workspace root ${byName} cannot be used (EACCES).`);
    });

    it.skipIf(IS_ROOT)('a context directory that cannot be created under a root the engine does not own (skipped as root)', () => {
      mkdirSync(byName, { mode: 0o700 });
      chmodSync(byName, 0o555);
      const dir = join(byName, 'http-api');
      expect(() => ensureWorkspaceContextDir(dir)).toThrow(`The workspace directory ${dir} cannot be created (EACCES).`);
    });

    it.skipIf(IS_ROOT)('a context directory that exists but cannot be written (skipped as root)', () => {
      const dir = join(byName, 'http-api');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o500);
      try {
        expect(() => ensureWorkspaceContextDir(dir)).toThrow(`The workspace directory ${dir} cannot be used (EACCES).`);
      } finally { chmodSync(dir, 0o700); }
    });

    it('a usable context directory is created 0700 and returned', () => {
      const dir = join(byName, 'http-api');
      expect(ensureWorkspaceContextDir(dir)).toBe(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });
  });

  describe('the old path in history (D7, inactive until an external root is accepted)', () => {
    const external = (): { path: string; mode: 'external' } => {
      const other = join(tmp, 'volume');
      mkdirSync(other, { recursive: true });
      return { path: other, mode: 'external' };
    };

    it('maps a path under <data>/workspace to the same place under an external root', () => {
      const root = external();
      expect(translateLegacyWorkspacePath(join(byName, 'http-api', 'a.txt'), root)).toBe(join(root.path, 'http-api', 'a.txt'));
      expect(translateLegacyWorkspacePath(byName, root)).toBe(root.path);
    });

    it('leaves other paths, a sibling with the same prefix, and the default mode alone', () => {
      const root = external();
      expect(translateLegacyWorkspacePath(join(data, 'vault.db'), root)).toBe(join(data, 'vault.db'));
      expect(translateLegacyWorkspacePath(`${byName}-other/x`, root)).toBe(`${byName}-other/x`);
      expect(translateLegacyWorkspacePath(join(byName, 'x'), { path: byName, mode: 'default' })).toBe(join(byName, 'x'));
    });

    it('refuses while files are left in the old place, naming it', () => {
      const root = external();
      mkdirSync(join(byName, 'http-api'), { recursive: true });
      writeFileSync(join(byName, 'http-api', 'left.txt'), 'x');
      expect(() => translateLegacyWorkspacePath(join(byName, 'http-api', 'a.txt'), root))
        .toThrow(`which still holds files while the workspace root is ${root.path}`);
    });
  });

  describe('observables', () => {
    it('nothing is pending in the default mode, even with files in it', () => {
      mkdirSync(byName);
      writeFileSync(join(byName, 'f'), 'x');
      expect(workspaceLegacyPending({ path: byName, mode: 'default' })).toBe(false);
    });

    it('external: pending exactly when <data>/workspace holds something', () => {
      const root = { path: join(tmp, 'volume'), mode: 'external' as const };
      expect(workspaceLegacyPending(root)).toBe(false);
      mkdirSync(byName);
      expect(workspaceLegacyPending(root)).toBe(false);
      writeFileSync(join(byName, 'f'), 'x');
      expect(workspaceLegacyPending(root)).toBe(true);
    });

    it.runIf(process.platform === 'linux')('is_mount: false for a plain directory, true for a mount point (mount id, not device)', () => {
      mkdirSync(byName);
      expect(workspaceRootIsMount(byName)).toBe(false);
      expect(workspaceRootIsMount('/proc')).toBe(true);
    });

    it('is_mount: null for a path that does not exist', () => {
      expect(workspaceRootIsMount(join(tmp, 'missing'))).toBeNull();
    });
  });
});
