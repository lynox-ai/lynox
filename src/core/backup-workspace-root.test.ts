import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BackupManager } from './backup.js';
import { reloadConfig } from './config.js';
import { _resetWorkspaceAccess, workspaceAccess } from './workspace-access.js';

const IS_ROOT = process.getuid?.() === 0;

/**
 * Backup and restore carry the workspace through its anchored root (PRD P18 D6, I2): copied out
 * without following a link, each path once in the manifest, restored as an overlay, and a
 * staging failure in EITHER set leaves every live file as it was.
 */
describe('backup — the workspace root', () => {
  let tmp: string;
  let data: string;
  let backupDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-ws-')));
    data = join(tmp, 'data');
    backupDir = join(tmp, 'backups');
    mkdirSync(join(data, 'workspace', 'http-api'), { recursive: true });
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = data;
    delete process.env['LYNOX_DIR'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    reloadConfig();
    _resetWorkspaceAccess();
  });

  afterEach(() => {
    _resetWorkspaceAccess();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    reloadConfig();
    rmSync(tmp, { recursive: true, force: true });
  });

  const ws = (rel: string): string => join(data, 'workspace', rel);
  const manager = (dir = data): BackupManager => new BackupManager(dir, { backupDir, retentionDays: 30, encrypt: false }, null);

  it('backs up the root and restores it as an overlay; a later file survives (I2)', async () => {
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    mkdirSync(ws('http-api/deep/er'), { recursive: true });
    writeFileSync(ws('http-api/deep/er/b.bin'), Buffer.from([0, 1, 2, 255]));
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    const paths = created.manifest.files.map(f => f.path);
    expect(paths.filter(p => p === 'workspace/http-api/a.txt')).toHaveLength(1);
    expect(paths).toContain('workspace/http-api/deep/er/b.bin');

    rmSync(ws('http-api/a.txt'));
    writeFileSync(ws('http-api/deep/er/b.bin'), 'changed');
    writeFileSync(ws('http-api/later.txt'), 'ZZ-later');
    const restored = await manager().restoreBackup(created.path, { allowUnverified: true });
    expect(restored.error).toBeUndefined();
    expect(restored.success).toBe(true);
    expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-a');
    expect([...readFileSync(ws('http-api/deep/er/b.bin'))]).toEqual([0, 1, 2, 255]);
    expect(readFileSync(ws('http-api/later.txt'), 'utf8')).toBe('ZZ-later');
    // No temp of the stage left behind.
    expect(readdirSync(ws('http-api')).filter(n => n.startsWith('.lynox-stage-'))).toEqual([]);
  });

  it('refuses a workspace file swapped after the verify pass, and leaves the live one', async () => {
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const signed = new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, 'vault-key-ws');
    const created = await signed.createBackup();
    writeFileSync(ws('http-api/a.txt'), 'ZZ-live');
    const spy = vi.spyOn(signed, 'createBackup').mockImplementation(async () => {
      writeFileSync(join(created.path, 'workspace', 'http-api', 'a.txt'), 'ZZ-swapped');
      return { success: false, path: '', manifest: created.manifest, duration_ms: 0, error: 'stub' };
    });
    try {
      const restored = await signed.restoreBackup(created.path);
      expect(restored.success).toBe(false);
      expect(restored.error).toMatch(/changed after it was verified/);
      expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-live');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a workspace file deleted after the verify pass instead of skipping it', async () => {
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const signed = new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, 'vault-key-ws');
    const created = await signed.createBackup();
    writeFileSync(ws('http-api/a.txt'), 'ZZ-live');
    const spy = vi.spyOn(signed, 'createBackup').mockImplementation(async () => {
      rmSync(join(created.path, 'workspace', 'http-api', 'a.txt'));
      return { success: false, path: '', manifest: created.manifest, duration_ms: 0, error: 'stub' };
    });
    try {
      const restored = await signed.restoreBackup(created.path);
      expect(restored.success).toBe(false);
      expect(restored.error).toMatch(/changed after it was verified/);
      expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-live');
    } finally {
      spy.mockRestore();
    }
  });

  it('stages the workspace bytes it checked, never a second read by name', async () => {
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const signed = new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, 'vault-key-ws');
    const created = await signed.createBackup();
    writeFileSync(ws('http-api/a.txt'), 'ZZ-live');
    const src = join(created.path, 'workspace', 'http-api', 'a.txt');
    const fifoDir = mkdtempSync(join(tmpdir(), 'lynox-fifo-ws-'));
    writeFileSync(join(fifoDir, 'first'), 'ZZ-a');
    writeFileSync(join(fifoDir, 'second'), 'ZZ-second-read');
    let writer: ReturnType<typeof spawn> | null = null;
    const spy = vi.spyOn(signed, 'createBackup').mockImplementation(async () => {
      rmSync(src);
      execFileSync('mkfifo', [src]);
      // Every OPEN of the FIFO reads the next write: a second read by name would get 'second'.
      writer = spawn('sh', ['-c', 'cat "$1" > "$3"; sleep 2; cat "$2" > "$3"', 'sh', join(fifoDir, 'first'), join(fifoDir, 'second'), src], { stdio: 'ignore' });
      return { success: false, path: '', manifest: created.manifest, duration_ms: 0, error: 'stub' };
    });
    try {
      const restored = await signed.restoreBackup(created.path);
      expect(restored.success, String(restored.error)).toBe(true);
      expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-a');
    } finally {
      (writer as ReturnType<typeof spawn> | null)?.kill('SIGKILL');
      rmSync(fifoDir, { recursive: true, force: true });
      spy.mockRestore();
    }
  });

  it('restores an encrypted backup, decrypting in memory with nothing left beside the backup', async () => {
    writeFileSync(ws('http-api/a.txt'), 'ZZ-secret');
    const key = ['test', 'vault', 'k'.repeat(24)].join('-');
    const encrypted = new BackupManager(data, { backupDir, retentionDays: 30, encrypt: true }, key);
    const created = await encrypted.createBackup();
    expect(created.success).toBe(true);
    expect(readFileSync(join(created.path, 'workspace', 'http-api', 'a.txt')).includes('ZZ-secret')).toBe(false);
    rmSync(ws('http-api/a.txt'));
    // A backup that cannot be written to: a plaintext copy beside it would fail the restore.
    if (!IS_ROOT) chmodSync(created.path, 0o500);
    try {
      const restored = await encrypted.restoreBackup(created.path);
      expect(restored.error).toBeUndefined();
    } finally {
      chmodSync(created.path, 0o700);
    }
    expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-secret');
    expect(readdirSync(created.path).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('skips a link and a FIFO, never follows them, and names them in the result (I2)', async () => {
    writeFileSync(join(tmp, 'outside.txt'), 'ZZ-outside');
    symlinkSync(join(tmp, 'outside.txt'), ws('http-api/link'));
    let fifo = false;
    try { execFileSync('mkfifo', [ws('http-api/pipe')]); fifo = true; } catch { /* no mkfifo here */ }
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    const paths = created.manifest.files.map(f => f.path);
    expect(paths).not.toContain('workspace/http-api/link');
    expect(created.skipped).toContain('workspace/http-api/link');
    if (fifo) expect(created.skipped).toContain('workspace/http-api/pipe');
    expect(existsSync(join(created.path, 'workspace', 'http-api', 'link'))).toBe(false);
  });

  it('backs up a default root that is a symlink', async () => {
    const real = join(tmp, 'elsewhere');
    mkdirSync(join(real, 'http-api'), { recursive: true });
    writeFileSync(join(real, 'http-api', 'a.txt'), 'ZZ-a');
    rmSync(join(data, 'workspace'), { recursive: true });
    symlinkSync(real, join(data, 'workspace'));
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    expect(created.manifest.files.map(f => f.path)).toContain('workspace/http-api/a.txt');
  });

  it.skipIf(IS_ROOT)('fails the backup when a workspace file cannot be read, never a silent gap', async () => {
    writeFileSync(ws('http-api/locked.txt'), 'ZZ-locked');
    chmodSync(ws('http-api/locked.txt'), 0o000);
    try {
      const created = await manager().createBackup();
      expect(created.success).toBe(false);
      expect(created.error).toMatch(/EACCES|permission/i);
    } finally {
      chmodSync(ws('http-api/locked.txt'), 0o600);
    }
  });

  it('a staging failure in the WORKSPACE set changes no live file in either set (I2)', async () => {
    writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
    writeFileSync(ws('http-api/b.txt'), 'ZZ-b-live');
    // A directory where the backup has a file: the workspace set fails in phase 1.
    rmSync(ws('http-api/a.txt'));
    mkdirSync(ws('http-api/a.txt'));
    const restored = await manager().restoreBackup(created.path, { allowUnverified: true });
    expect(restored.success).toBe(false);
    expect(JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))).toEqual({ default_tier: 'deep' });
    expect(existsSync(join(data, 'config.json.restore-staging'))).toBe(false);
    expect(readFileSync(ws('http-api/b.txt'), 'utf8')).toBe('ZZ-b-live');
  });

  it('a staging failure in the DATA-DIR set changes no workspace file (I2)', async () => {
    writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a-live');
    mkdirSync(join(data, 'config.json.restore-staging'));
    const restored = await manager().restoreBackup(created.path, { allowUnverified: true });
    expect(restored.success).toBe(false);
    expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-a-live');
    expect(readdirSync(ws('http-api')).filter(n => n.startsWith('.lynox-stage-'))).toEqual([]);
  });

  it('a failed swap of the DATA-DIR set never commits the workspace set (I2)', async () => {
    writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a');
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    writeFileSync(ws('http-api/a.txt'), 'ZZ-a-live');
    // A directory where the backup has a file: staging beside it succeeds, the rename over it fails.
    rmSync(join(data, 'config.json'));
    mkdirSync(join(data, 'config.json'));
    writeFileSync(join(data, 'config.json', 'keep'), 'x');
    const restored = await manager().restoreBackup(created.path, { allowUnverified: true });
    expect(restored.success).toBe(false);
    expect(readFileSync(ws('http-api/a.txt'), 'utf8')).toBe('ZZ-a-live');
    expect(readdirSync(ws('http-api')).filter(n => n.startsWith('.lynox-stage-'))).toEqual([]);
  });

  it('fails the backup when the root was moved away and replaced, never backs up the old one', async () => {
    writeFileSync(ws('http-api/old.txt'), 'ZZ-old');
    workspaceAccess();
    renameSync(join(data, 'workspace'), join(tmp, 'archived'));
    mkdirSync(join(data, 'workspace', 'http-api'), { recursive: true });
    writeFileSync(ws('http-api/new.txt'), 'ZZ-new');
    const created = await manager().createBackup();
    expect(created.success).toBe(false);
    expect(created.error).toMatch(/no longer the directory/);
  });

  it('fails the backup when the data directory is inside the root, never copies it into itself', async () => {
    // A manager on another data directory opens `<that>/workspace` by its resolved path: a link to the
    // directory that holds the data directory stands in for a bind mount, which takes privileges.
    const other = join(tmp, 'nest', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'store.txt'), 'ZZ-store');
    symlinkSync(dirname(other), join(other, 'workspace'));
    const created = await manager(other).createBackup();
    expect(created.success).toBe(false);
    expect(created.error).toMatch(/data directory is inside/);
    expect(readdirSync(backupDir).filter(n => !n.endsWith('.tmp'))).toEqual([]);
  });

  it('a manager on another data directory backs up that directory\'s workspace, not this engine\'s', async () => {
    writeFileSync(ws('http-api/engine.txt'), 'ZZ-engine');
    const other = join(tmp, 'other');
    mkdirSync(join(other, 'workspace'), { recursive: true });
    writeFileSync(join(other, 'workspace', 'own.txt'), 'ZZ-own');
    const created = await manager(other).createBackup();
    expect(created.success).toBe(true);
    const paths = created.manifest.files.map(f => f.path);
    expect(paths).toContain('workspace/own.txt');
    expect(paths).not.toContain('workspace/http-api/engine.txt');
  });

  it('with an external root, backs up the root and restores into it, never into <data>/workspace (I2)', async () => {
    const ext = join(tmp, 'volume');
    mkdirSync(join(ext, 'http-api'), { recursive: true });
    writeFileSync(join(ext, 'http-api', 'a.txt'), 'ZZ-ext');
    rmSync(join(data, 'workspace'), { recursive: true });
    process.env['LYNOX_WORKSPACE_ROOT'] = ext;
    _resetWorkspaceAccess();
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    expect(created.manifest.files.map(f => f.path)).toContain('workspace/http-api/a.txt');

    rmSync(join(ext, 'http-api', 'a.txt'));
    const restored = await manager().restoreBackup(created.path);
    expect(restored.error).toBeUndefined();
    expect(restored.success).toBe(true);
    expect(readFileSync(join(ext, 'http-api', 'a.txt'), 'utf8')).toBe('ZZ-ext');
    expect(existsSync(join(data, 'workspace'))).toBe(false);
  });
});
