import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A platform without the fd-relative open (Windows): `openAnchor` refuses with UNSUPPORTED for the
 * data dir, and the restore writes the data-dir set by name, as it did before it had an anchor.
 */
const unsupported = vi.hoisted(() => ({ dir: null as string | null }));
vi.mock('./workspace-fd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-fd.js')>();
  return {
    ...actual,
    openAnchor: ((dir: string) => {
      if (dir === unsupported.dir) throw new actual.WorkspaceAccessError('UNSUPPORTED', 'fd-based workspace access is not available here');
      return actual.openAnchor(dir);
    }) as typeof actual.openAnchor,
  };
});

const { BackupManager } = await import('./backup.js');
const { reloadConfig } = await import('./config.js');
const { _resetWorkspaceAccess } = await import('./workspace-access.js');

let tmp: string;
let data: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-unsup-')));
  data = join(tmp, 'data');
  mkdirSync(join(data, 'memory'), { recursive: true });
  for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
  process.env['LYNOX_DATA_DIR'] = data;
  delete process.env['LYNOX_DIR'];
  delete process.env['LYNOX_WORKSPACE_ROOT'];
  reloadConfig();
  _resetWorkspaceAccess();
});
afterEach(() => {
  unsupported.dir = null;
  _resetWorkspaceAccess();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  reloadConfig();
  rmSync(tmp, { recursive: true, force: true });
});

describe('a restore where the platform has no fd-relative open', () => {
  it('writes the data-dir set by name, and leaves no temp behind', async () => {
    writeFileSync(join(data, 'memory', 'x.md'), 'backed up');
    const m = new BackupManager(data, { backupDir: join(tmp, 'backups'), retentionDays: 30, encrypt: false }, null);
    const created = await m.createBackup();
    expect(created.success).toBe(true);
    writeFileSync(join(data, 'memory', 'x.md'), 'live');
    unsupported.dir = realpathSync(data);
    const result = await m.restoreBackup(created.path, { allowUnverified: true });
    expect(result.success, String(result.error)).toBe(true);
    expect(readFileSync(join(data, 'memory', 'x.md'), 'utf8')).toBe('backed up');
    expect(readdirSync(join(data, 'memory')).filter(n => n.includes('restore-staging'))).toEqual([]);
  });
});
