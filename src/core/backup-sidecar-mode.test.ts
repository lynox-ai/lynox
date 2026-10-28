import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager, OMITTED_SIDECAR } from './backup.js';
import type { BackupFileEntry } from './backup-verify.js';
import { reloadConfig } from './config.js';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from './shell-isolation.js';
import { _resetWorkspaceAccess } from './workspace-access.js';

const IS_ROOT = process.getuid?.() === 0;
const SIDECAR = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;

/**
 * Backup in shell sidecar mode (PRD D7, walker 1): the engine does not walk the shared workspace
 * tree. The workspace is omitted and the omission recorded in the result, the manifest and the
 * log; it never throws for the mode, and everything else is backed up as before. A pool
 * directory at `chmod 000` is present in every case, the shape that makes a walk throw.
 */
describe('backup — shell sidecar mode', () => {
  let tmp: string;
  let data: string;
  let backupDir: string;
  let locked: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-sidecar-')));
    data = join(tmp, 'data');
    backupDir = join(tmp, 'backups');
    mkdirSync(join(data, 'memory'), { recursive: true });
    writeFileSync(join(data, 'memory', 'note.md'), 'ZZ-memory');
    writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
    locked = join(data, 'workspace', 'pool-7');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'theirs.txt'), 'ZZ-pool');
    chmodSync(locked, 0o000);
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = data;
    delete process.env['LYNOX_DIR'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    reloadConfig();
    _resetWorkspaceAccess();
  });

  afterEach(() => {
    resetShellIsolationForTest();
    _resetWorkspaceAccess();
    chmodSync(locked, 0o700);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    reloadConfig();
    rmSync(tmp, { recursive: true, force: true });
  });

  const manager = (vaultKey: string | null = null): BackupManager =>
    new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, vaultKey);
  type WithCopy = { copyWorkspaceOut(tmpDir: string, files: BackupFileEntry[], isolation?: ShellIsolation): string[] | typeof OMITTED_SIDECAR };

  it('copyWorkspaceOut itself walks nothing in sidecar mode and returns the record', () => {
    const files: BackupFileEntry[] = [];
    const out = join(tmp, 'out');
    mkdirSync(out);
    const result = (manager() as unknown as WithCopy).copyWorkspaceOut(out, files, SIDECAR);
    expect(result).toBe(OMITTED_SIDECAR);
    expect(files).toEqual([]);
    expect(existsSync(join(out, 'workspace'))).toBe(false);
  });

  it.skipIf(IS_ROOT)('control: in local mode the same tree makes the walk throw', () => {
    const out = join(tmp, 'out');
    mkdirSync(out);
    expect(() => (manager() as unknown as WithCopy).copyWorkspaceOut(out, [], { kind: 'local' } as ShellIsolation)).toThrow(/EACCES|permission/i);
  });

  it('createBackup succeeds, carries the rest, and records the omission in result, manifest and log', async () => {
    setShellIsolationForTest(SIDECAR);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const created = await manager().createBackup();
      expect(created.error).toBeUndefined();
      expect(created.success).toBe(true);
      expect(created.workspace).toBe('omitted-sidecar');
      expect(created.manifest.coverage).toEqual({ workspace: 'omitted-sidecar' });
      const onDisk = JSON.parse(readFileSync(join(created.path, 'manifest.json'), 'utf8')) as { coverage?: unknown };
      expect(onDisk.coverage).toEqual({ workspace: 'omitted-sidecar' });
      const paths = created.manifest.files.map(f => f.path);
      expect(paths).toContain('memory/note.md');
      expect(paths).toContain('config.json');
      expect(paths.filter(p => p === 'workspace' || p.startsWith('workspace/'))).toEqual([]);
      expect(err.mock.calls.map(c => String(c[0])).join('')).toContain(
        '[lynox:backup] The workspace files are not in this backup: in shell sidecar mode lynox does not read the shared workspace tree. Back them up where the workspace is managed.',
      );
    } finally {
      err.mockRestore();
    }
  });

  it('the record is covered by the MAC: a signed backup with coverage stripped no longer verifies', async () => {
    setShellIsolationForTest(SIDECAR);
    const signed = manager('vault-key-sidecar');
    const created = await signed.createBackup();
    expect(created.success).toBe(true);
    expect(created.manifest.auth).toBeDefined();
    const path = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete manifest['coverage'];
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const restored = await signed.restoreBackup(created.path);
    expect(restored.success).toBe(false);
    expect(restored.code).toBe('unverified_backup');
  });

  it('control: in local mode the backup carries no record', async () => {
    chmodSync(locked, 0o700);
    const created = await manager().createBackup();
    expect(created.success).toBe(true);
    expect(created.workspace).toBeUndefined();
    expect(created.manifest.coverage).toBeUndefined();
    expect(created.manifest.files.map(f => f.path)).toContain('workspace/pool-7/theirs.txt');
  });

  /**
   * The list (row 987): each backup carries the provenance a restore would compute, so the web UI
   * trusts `coverage`, or its absence, only on a manifest whose origin is shown.
   */
  describe('listBackups: provenance next to coverage', () => {
    const KEY = 'vault-key-list';
    const entry = (m: BackupManager, path: string) => m.listBackups().find(b => join(backupDir, b.backup_id) === path)!;
    const rewrite = (path: string, change: (m: Record<string, unknown>) => void): void => {
      const file = join(path, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      change(manifest);
      writeFileSync(file, JSON.stringify(manifest, null, 2));
    };

    it('a signed backup made in sidecar mode is verified and carries the record', async () => {
      setShellIsolationForTest(SIDECAR);
      const created = await manager(KEY).createBackup();
      expect(created.success).toBe(true);
      const listed = entry(manager(KEY), created.path);
      expect(listed.provenance).toBe('verified');
      expect(listed.coverage).toEqual({ workspace: 'omitted-sidecar' });
    });

    it('control: a signed backup made in local mode is verified and carries no record', async () => {
      chmodSync(locked, 0o700);
      const created = await manager(KEY).createBackup();
      const listed = entry(manager(KEY), created.path);
      expect(listed.provenance).toBe('verified');
      expect(listed.coverage).toBeUndefined();
    });

    it('stripping the record from a signed manifest shows as mismatch, not as a complete backup', async () => {
      setShellIsolationForTest(SIDECAR);
      const created = await manager(KEY).createBackup();
      rewrite(created.path, m => { delete m['coverage']; });
      const listed = entry(manager(KEY), created.path);
      expect(listed.coverage).toBeUndefined();
      expect(listed.provenance).toBe('mismatch');
    });

    it('a manifest without a MAC is none, and an engine without a vault key says no-key', async () => {
      setShellIsolationForTest(SIDECAR);
      const created = await manager(KEY).createBackup();
      expect(entry(manager(null), created.path).provenance).toBe('no-key');
      rewrite(created.path, m => { delete m['auth']; delete m['coverage']; });
      expect(entry(manager(KEY), created.path).provenance).toBe('none');
    });

    it('a backup under another vault key is mismatch', async () => {
      setShellIsolationForTest(SIDECAR);
      const created = await manager(KEY).createBackup();
      expect(entry(manager('another-vault-key'), created.path).provenance).toBe('mismatch');
    });
  });

  it('the inventory row for the workspace is decided by mode', () => {
    expect(DATA_DIR_INVENTORY.filter(e => e.backup === 'unless-sidecar').map(e => e.name)).toEqual(['workspace']);
  });

  describe('restore (walker 4): refused by content', () => {
    const RESTORE_SELF_HOST = 'This backup contains files from the workspace. On this instance lynox does not restore them from a backup; nothing was changed. You can restore the rest from a backup without the workspace. On this instance you manage the workspace files outside lynox.';
    const RESTORE_MANAGED = 'This backup contains files from the workspace. On this instance lynox does not restore them from a backup; nothing was changed. You can restore the rest from a backup without the workspace. For the files, write to support@lynox.ai.';
    let savedTier: string | undefined;
    beforeEach(() => { savedTier = process.env['LYNOX_BILLING_TIER']; delete process.env['LYNOX_BILLING_TIER']; });
    afterEach(() => { if (savedTier === undefined) delete process.env['LYNOX_BILLING_TIER']; else process.env['LYNOX_BILLING_TIER'] = savedTier; });

    /** A backup made in local mode, so it holds the workspace; then the live config moves on. */
    const withWorkspace = async (): Promise<string> => {
      chmodSync(locked, 0o700);
      const created = await manager().createBackup();
      expect(created.success).toBe(true);
      expect(created.manifest.files.map(f => f.path)).toContain('workspace/pool-7/theirs.txt');
      chmodSync(locked, 0o000);
      writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
      return created.path;
    };
    const liveConfig = (): string => readFileSync(join(data, 'config.json'), 'utf8');

    it('refuses a backup with workspace entries before anything is staged, without a tier', async () => {
      const path = await withWorkspace();
      setShellIsolationForTest(SIDECAR);
      const restored = await manager().restoreBackup(path, { allowUnverified: true });
      expect(restored.success).toBe(false);
      expect(restored.code).toBe('workspace_sidecar_mode');
      expect(restored.error).toBe(RESTORE_SELF_HOST);
      expect(restored.pre_restore_backup_path).toBe('');
      expect(liveConfig()).toBe(JSON.stringify({ default_tier: 'deep' }));
    });

    it('names support on a managed instance', async () => {
      const path = await withWorkspace();
      setShellIsolationForTest(SIDECAR);
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      const restored = await manager().restoreBackup(path, { allowUnverified: true });
      expect(restored.code).toBe('workspace_sidecar_mode');
      expect(restored.error).toBe(RESTORE_MANAGED);
    });

    it('restores a backup made in sidecar mode, which holds no workspace entries', async () => {
      setShellIsolationForTest(SIDECAR);
      const created = await manager().createBackup();
      expect(created.success).toBe(true);
      writeFileSync(join(data, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
      const restored = await manager().restoreBackup(created.path, { allowUnverified: true });
      expect(restored.error).toBeUndefined();
      expect(restored.success).toBe(true);
      expect(liveConfig()).toBe(JSON.stringify({ default_tier: 'balanced' }));
    });

    it('control: in local mode the same backup is restored', async () => {
      const path = await withWorkspace();
      chmodSync(locked, 0o700);
      const restored = await manager().restoreBackup(path, { allowUnverified: true });
      expect(restored.error).toBeUndefined();
      expect(restored.success).toBe(true);
      expect(liveConfig()).toBe(JSON.stringify({ default_tier: 'balanced' }));
    });

    it('stageWorkspaceIn itself refuses in sidecar mode', () => {
      type WithStage = { stageWorkspaceIn(backupPath: string, entries: readonly BackupFileEntry[], key: Buffer | null, isolation?: ShellIsolation): unknown };
      const entry: BackupFileEntry = { path: 'workspace/pool-7/theirs.txt', size_bytes: 7, checksum_sha256: '', type: 'file' };
      expect(() => (manager() as unknown as WithStage).stageWorkspaceIn(join(tmp, 'nowhere'), [entry], null, SIDECAR)).toThrow(RESTORE_SELF_HOST);
    });
  });
});
