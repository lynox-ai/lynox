import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from './backup.js';
import { reloadConfig } from './config.js';
import { _resetWorkspaceAccess } from './workspace-access.js';

/**
 * Each entry of `listBackups` carries `file_count` and `total_bytes`, the totals of its manifest's
 * `files`, next to the full list.
 */
let tmp: string;
let data: string;
let backupDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-totals-')));
  data = join(tmp, 'data');
  backupDir = join(tmp, 'backups');
  mkdirSync(join(data, 'memory'), { recursive: true });
  writeFileSync(join(data, 'memory', 'a.md'), 'abc');
  writeFileSync(join(data, 'memory', 'b.md'), 'abcdefgh');
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

const manager = (): BackupManager => new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, null);

/** A backup folder with a hand-written manifest, as an older engine or a changed file leaves it. */
function writeManifest(id: string, files: unknown): void {
  mkdirSync(join(backupDir, id), { recursive: true });
  writeFileSync(join(backupDir, id, 'manifest.json'), JSON.stringify({
    version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', lynox_dir: data, encrypted: false, files, checksum: 'c',
  }));
}

describe('the backup list totals', () => {
  it('counts the files of a real backup and sums their sizes', async () => {
    const m = manager();
    await m.createBackup();
    const [entry] = m.listBackups();
    expect(entry).toBeDefined();
    const files = entry!.files;
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(entry!.file_count).toBe(files.length);
    expect(entry!.total_bytes).toBe(files.reduce((s, f) => s + f.size_bytes, 0));
    expect(entry!.total_bytes).toBeGreaterThanOrEqual(11);
  });

  it('counts every entry and sums only usable sizes', () => {
    writeManifest('b-odd', [{ path: 'a', size_bytes: 5 }, { path: 'b', size_bytes: '7' }, { path: 'c' }, { path: 'd', size_bytes: -3 }, null, { path: 'e', size_bytes: 2 }]);
    const [entry] = manager().listBackups();
    expect(entry?.file_count).toBe(6);
    expect(entry?.total_bytes).toBe(7);
  });

  it('skips a size that is not finite', () => {
    mkdirSync(join(backupDir, 'b-inf'), { recursive: true });
    // JSON has no Infinity, but `1e999` parses to it.
    writeFileSync(join(backupDir, 'b-inf', 'manifest.json'),
      `{"version":"2.17.0","created_at":"2026-10-28T08:00:00.000Z","lynox_dir":"x","encrypted":false,"checksum":"c","files":[{"path":"a","size_bytes":1e999},{"path":"b","size_bytes":4}]}`);
    const [entry] = manager().listBackups();
    expect(entry?.file_count).toBe(2);
    expect(entry?.total_bytes).toBe(4);
  });

  it('overwrites totals that the manifest itself carries', () => {
    mkdirSync(join(backupDir, 'b-own'), { recursive: true });
    writeFileSync(join(backupDir, 'b-own', 'manifest.json'), JSON.stringify({
      version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', lynox_dir: data, encrypted: false, checksum: 'c',
      files: [{ path: 'a', size_bytes: 4 }], file_count: 999, total_bytes: 999,
    }));
    const [entry] = manager().listBackups();
    expect(entry?.file_count).toBe(1);
    expect(entry?.total_bytes).toBe(4);
  });

  it('gives 0 and 0 for a manifest whose files are not a list, and still lists it', () => {
    writeManifest('b-none', { not: 'a list' });
    const list = manager().listBackups();
    expect(list.map(b => b.backup_id)).toEqual(['b-none']);
    expect(list[0]?.file_count).toBe(0);
    expect(list[0]?.total_bytes).toBe(0);
  });
});
