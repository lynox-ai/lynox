import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A one-shot hook on reading a backup's source file: the restore reads an entry's bytes after its
 * last check of the live path and right before it opens the entry's folder, so a link swapped in
 * here lands in exactly that window. The verify pass reads the same file first; `skip` lets the
 * reads before the restore's own one go by.
 */
const readHook = vi.hoisted(() => ({ path: null as string | null, skip: 0, run: null as (() => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      if (readHook.run !== null && String(args[0]) === readHook.path && readHook.skip-- <= 0) {
        const run = readHook.run;
        readHook.run = null;
        run();
      }
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
  };
});

const { BackupManager, RESTORE_RUNNING } = await import('./backup.js');
const { reloadConfig } = await import('./config.js');
const { _resetWorkspaceAccess } = await import('./workspace-access.js');
type WorkspaceFoldSeam = { workspaceNamesFold: (anchor: unknown, relDir: string) => boolean };

let tmp: string;
let data: string;
let backupDir: string;
let outside: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-guards-')));
  data = join(tmp, 'data');
  backupDir = join(tmp, 'backups');
  outside = join(tmp, 'outside');
  mkdirSync(join(data, 'workspace', 'http-api'), { recursive: true });
  mkdirSync(join(data, 'memory'), { recursive: true });
  mkdirSync(outside);
  for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
  process.env['LYNOX_DATA_DIR'] = data;
  delete process.env['LYNOX_DIR'];
  delete process.env['LYNOX_WORKSPACE_ROOT'];
  reloadConfig();
  _resetWorkspaceAccess();
});

afterEach(() => {
  readHook.path = null;
  readHook.skip = 0;
  readHook.run = null;
  _resetWorkspaceAccess();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  reloadConfig();
  rmSync(tmp, { recursive: true, force: true });
});

const manager = (): InstanceType<typeof BackupManager> => new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, null);
const ws = (rel: string): string => join(data, 'workspace', rel);

/** The refusals for a folded pair (ux U-139), word for word. */
const foldedText = (a: string, b: string): string =>
  `This backup holds "${a}" and "${b}", and this machine's filesystem takes them for one name: it does not tell upper from lower case, or two ways of writing the same letter, apart. ` +
  'Restoring would fail halfway, so the restore was refused; nothing was replaced. ' +
  'To restore this backup, use a machine whose filesystem tells these names apart (Linux usually does), or rename one of the two where the backup was made and back up again.';
const unaskedText = (a: string, b: string, code: string): string =>
  `Could not check whether this machine's filesystem tells "${a}" and "${b}" apart (${code}), so the restore was refused; nothing was replaced. ` +
  `Check that lynox can create a file in the folder of "${a}" (a full disk or a missing permission are the usual causes), then start the restore again.`;

describe('two restores at once', () => {
  it('refuses the second while the first runs, word for word, and the first goes through', async () => {
    writeFileSync(join(data, 'memory', 'x.md'), 'backed up');
    const m = manager();
    const created = await m.createBackup();
    expect(created.success).toBe(true);
    writeFileSync(join(data, 'memory', 'x.md'), 'live');

    const first = m.restoreBackup(created.path, { allowUnverified: true });
    const second = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(second).toEqual({ success: false, pre_restore_backup_path: '', files_restored: 0, duration_ms: 0, code: 'restore_in_progress', error: RESTORE_RUNNING });
    expect(RESTORE_RUNNING).toBe('A restore is already running, so this one was not started. Wait for the running restore: when it succeeds, the instance restarts. If the instance does not restart, the running restore did not succeed, and you can start a restore again.');

    const done = await first;
    expect(done.success, String(done.error)).toBe(true);
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('backed up');
    // Control: once the first has finished, a restore runs again.
    const third = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(third.success, String(third.error)).toBe(true);
  });

  it('lets a restore run again after one that failed', async () => {
    const m = manager();
    const failed = await m.restoreBackup(join(tmp, 'no-such-backup'), { allowUnverified: true });
    expect(failed.success).toBe(false);
    expect(failed.code).toBeUndefined();
    const created = await m.createBackup();
    const after = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(after.success, String(after.error)).toBe(true);
  });
});

describe('a link swapped into the data dir after the last check', () => {
  it('is refused, nothing lands where it points, and no live file is replaced', async () => {
    writeFileSync(join(data, 'memory', 'x.md'), 'backed up');
    const m = manager();
    const created = await m.createBackup();
    writeFileSync(join(data, 'memory', 'x.md'), 'live');
    readHook.path = join(created.path, 'memory', 'x.md');
    readHook.skip = 1; // the verify pass
    readHook.run = () => {
      renameSync(join(data, 'memory'), join(data, 'memory.real'));
      symlinkSync(outside, join(data, 'memory'));
    };

    const result = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(readHook.run).toBeNull(); // the hook ran
    expect(result.success).toBe(false);
    // Refused by the anchored write, not by the check before it (which the swap came after).
    expect(result.error).not.toMatch(/is a link on this machine/);
    expect(result.error).toMatch(/symlink|not a directory|ELOOP|ENOTDIR/i);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(data, 'memory.real', 'x.md'), 'utf8')).toBe('live');
  });

  it('control: without the swap, the same backup is restored', async () => {
    writeFileSync(join(data, 'memory', 'x.md'), 'backed up');
    const m = manager();
    const created = await m.createBackup();
    writeFileSync(join(data, 'memory', 'x.md'), 'live');
    const result = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(result.success, String(result.error)).toBe(true);
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('backed up');
    expect(readdirSync(join(data, 'memory')).filter(n => n.startsWith('.lynox-stage-'))).toEqual([]);
  });
});

describe('the workspace set, where its filesystem folds names', () => {
  /** A backup whose workspace set holds `http-api/A` (a file) beside `http-api/a/b` (a file in a folder). */
  async function foldingBackup(): Promise<{ m: InstanceType<typeof BackupManager>; path: string }> {
    writeFileSync(ws('http-api/A'), 'a file');
    mkdirSync(ws('http-api/a'));
    writeFileSync(ws('http-api/a/b'), 'in a folder');
    writeFileSync(join(data, 'memory', 'x.md'), 'backed up');
    const m = manager();
    const created = await m.createBackup();
    expect(created.success).toBe(true);
    writeFileSync(join(data, 'memory', 'x.md'), 'live');
    writeFileSync(ws('http-api/A'), 'live file');
    return { m, path: created.path };
  }

  it('is refused word for word before any live file is replaced, asked in the pair\'s folder', async () => {
    const { m, path } = await foldingBackup();
    const folds = vi.spyOn(m as unknown as WorkspaceFoldSeam, 'workspaceNamesFold').mockReturnValue(true);
    const result = await m.restoreBackup(path, { allowUnverified: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe(foldedText('workspace/http-api/A', 'workspace/http-api/a/b'));
    expect(result.pre_restore_backup_path).toBe('');
    expect(folds).toHaveBeenCalledTimes(1);
    expect(folds.mock.calls[0]?.[1]).toBe('http-api');
    // Nothing replaced: neither the data-dir set nor the workspace set.
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('live');
    expect(readFileSync(ws('http-api/A'), 'utf8')).toBe('live file');
  });

  it('is refused word for word when the filesystem cannot be asked', async () => {
    const { m, path } = await foldingBackup();
    vi.spyOn(m as unknown as WorkspaceFoldSeam, 'workspaceNamesFold').mockImplementation(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    const result = await m.restoreBackup(path, { allowUnverified: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe(unaskedText('workspace/http-api/A', 'workspace/http-api/a/b', 'ENOSPC'));
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('live');
  });

  it('control: where the filesystem keeps the names apart, both are restored', async () => {
    const { m, path } = await foldingBackup();
    const result = await m.restoreBackup(path, { allowUnverified: true });
    expect(result.success, String(result.error)).toBe(true);
    expect(readFileSync(ws('http-api/A'), 'utf8')).toBe('a file');
    expect(readFileSync(ws('http-api/a/b'), 'utf8')).toBe('in a folder');
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('backed up');
  });

  it('asks the real filesystem through the root\'s anchor, and leaves no probe behind', async () => {
    const { m, path } = await foldingBackup();
    const result = await m.restoreBackup(path, { allowUnverified: true });
    expect(result.success, String(result.error)).toBe(true);
    expect(readdirSync(ws('http-api')).filter(n => n.startsWith('.lynox-fold-probe-'))).toEqual([]);
    expect(existsSync(ws('http-api/A'))).toBe(true);
  });
});
