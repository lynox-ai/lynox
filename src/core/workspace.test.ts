import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getWorkspaceDir, isWorkspaceActive, getWorkspaceCwd, validatePath, _resetCache } from './workspace.js';

describe('workspace', () => {
  let tmpDir: string;
  let realTmpDir: string;
  const origEnv = process.env['LYNOX_WORKSPACE'];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lynox-ws-'));
    realTmpDir = realpathSync(tmpDir);
    _resetCache();
    delete process.env['LYNOX_WORKSPACE'];
  });

  afterEach(() => {
    _resetCache();
    if (origEnv !== undefined) {
      process.env['LYNOX_WORKSPACE'] = origEnv;
    } else {
      delete process.env['LYNOX_WORKSPACE'];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getWorkspaceDir returns null when env not set', () => {
    expect(getWorkspaceDir()).toBeNull();
  });

  it('getWorkspaceDir returns real path when LYNOX_WORKSPACE is set', () => {
    process.env['LYNOX_WORKSPACE'] = tmpDir;
    expect(getWorkspaceDir()).toBe(realTmpDir);
  });

  it('isWorkspaceActive returns false by default', () => {
    expect(isWorkspaceActive()).toBe(false);
  });

  it('isWorkspaceActive returns true when workspace set', () => {
    process.env['LYNOX_WORKSPACE'] = tmpDir;
    expect(isWorkspaceActive()).toBe(true);
  });

  it('getWorkspaceCwd returns process.cwd() when inactive', () => {
    expect(getWorkspaceCwd()).toBe(process.cwd());
  });

  it('getWorkspaceCwd returns workspace dir when active', () => {
    process.env['LYNOX_WORKSPACE'] = tmpDir;
    expect(getWorkspaceCwd()).toBe(realTmpDir);
  });

  describe('validatePath', () => {
    beforeEach(() => {
      process.env['LYNOX_WORKSPACE'] = tmpDir;
      _resetCache();
    });

    it('allows paths within workspace for write', () => {
      const filePath = join(tmpDir, 'test.txt');
      writeFileSync(filePath, 'hello');
      const result = validatePath(filePath, 'write');
      expect(result).toBe(join(realTmpDir, 'test.txt'));
    });

    it('allows /tmp paths for write', () => {
      const filePath = join(realTmpDir, 'nested-tmp-test.txt');
      writeFileSync(filePath, 'tmp');
      const result = validatePath(filePath, 'write');
      expect(result).toBe(filePath);
    });

    it('rejects paths outside workspace for write', () => {
      expect(() => validatePath('/etc/passwd', 'write')).toThrow(/outside allowed directories/);
    });

    it('rejects paths outside workspace for read', () => {
      expect(() => validatePath('/etc/passwd', 'read')).toThrow(/outside allowed directories/);
    });

    it('allows non-existent files with parent in workspace', () => {
      const filePath = join(tmpDir, 'new-file.txt');
      const result = validatePath(filePath, 'write');
      expect(result).toBe(join(realTmpDir, 'new-file.txt'));
    });

    it('catches symlink escape from workspace', () => {
      const link = join(tmpDir, 'escape');
      symlinkSync('/etc', link);
      const target = join(link, 'passwd');
      expect(() => validatePath(target, 'read')).toThrow(/outside allowed directories/);
    });

    it('rejects path when neither file nor parent exists', () => {
      expect(() => validatePath(join(tmpDir, 'nonexistent', 'deep', 'file.txt'), 'write'))
        .toThrow(/cannot be validated.*parent directory does not exist/i);
    });

    it('rejects write through symlink pointing outside workspace', () => {
      // Use cwd (repo root) for outside dir — NOT tmpdir() — because on Linux
      // both workspace and outside would be in /tmp, which is an allowed target.
      const outsideDir = mkdtempSync(join(process.cwd(), '.lynox-outside-'));
      try {
        const outsideFile = join(outsideDir, 'target.txt');
        writeFileSync(outsideFile, 'outside');
        const link = join(tmpDir, 'escape-link');
        symlinkSync(outsideFile, link);
        expect(() => validatePath(link, 'write')).toThrow(/symlink.*outside the workspace/i);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('allows write through symlink pointing within workspace', () => {
      const innerDir = join(tmpDir, 'inner');
      mkdirSync(innerDir);
      const innerFile = join(innerDir, 'target.txt');
      writeFileSync(innerFile, 'inside');
      const link = join(tmpDir, 'inner-link');
      symlinkSync(innerFile, link);
      expect(() => validatePath(link, 'write')).not.toThrow();
    });

    it('returns resolved path as-is when workspace inactive', () => {
      _resetCache();
      delete process.env['LYNOX_WORKSPACE'];
      _resetCache();
      const result = validatePath('/any/path', 'write');
      expect(result).toBe('/any/path');
    });
  });
});
