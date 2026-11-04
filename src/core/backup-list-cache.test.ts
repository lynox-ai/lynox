import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from './backup.js';
import { reloadConfig } from './config.js';
import { _resetWorkspaceAccess } from './workspace-access.js';

/**
 * `listBackups` keeps each backup's provenance while its manifest holds the bytes it checked: a
 * second list does not check again, and changed content is checked afresh — also when the file's
 * size and mtime were put back, since the cache is bound to the content, not to the file's times.
 */
type ProvenanceSeam = { provenanceOf: (manifest: unknown) => string; _listProvenance: Map<string, unknown> };

let tmp: string;
let data: string;
let backupDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-list-')));
  data = join(tmp, 'data');
  backupDir = join(tmp, 'backups');
  mkdirSync(join(data, 'memory'), { recursive: true });
  writeFileSync(join(data, 'memory', 'x.md'), 'x');
  for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
  process.env['LYNOX_DATA_DIR'] = data;
  delete process.env['LYNOX_DIR'];
  delete process.env['LYNOX_WORKSPACE_ROOT'];
  reloadConfig();
  _resetWorkspaceAccess();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetWorkspaceAccess();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  reloadConfig();
  rmSync(tmp, { recursive: true, force: true });
});

const signed = (): BackupManager => new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, 'vault-key-list');

/** Wait until the filesystem's coarse clock has moved on, so a later write gets a later ctime. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('the backup list', () => {
  it('checks each manifest once, and answers the same from the cache', async () => {
    const m = signed();
    await m.createBackup();
    await tick();
    await m.createBackup();
    const spy = vi.spyOn(m as unknown as ProvenanceSeam, 'provenanceOf');
    const first = m.listBackups();
    expect(first.map(b => b.provenance)).toEqual(['verified', 'verified']);
    expect(spy).toHaveBeenCalledTimes(2);
    const second = m.listBackups();
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('checks a manifest again whose content changed', async () => {
    const m = signed();
    const created = await m.createBackup();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    await tick();
    const path = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: 'changed' }));
    expect(m.listBackups()[0]?.provenance).toBe('mismatch');
  });

  it('checks a manifest again whose content changed while its size and mtime were put back', async () => {
    const m = signed();
    const created = await m.createBackup();
    const path = join(created.path, 'manifest.json');
    const before = statSync(path, { bigint: true });
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    await tick();
    const text = readFileSync(path, 'utf8');
    const version = /"version":\s*"([^"]+)"/.exec(text)?.[1] ?? '';
    expect(version.length).toBeGreaterThan(0);
    const swapped = text.replace(`"${version}"`, `"${'9'.repeat(version.length)}"`);
    expect(swapped.length).toBe(text.length);
    expect(swapped).not.toBe(text);
    writeFileSync(path, swapped);
    // The old mtime put back to the nanosecond (`utimes` through a Date would round it).
    const ns = before.mtimeNs % 1_000_000_000n;
    execFileSync('touch', ['-m', '-d', `@${String(before.mtimeNs / 1_000_000_000n)}.${String(ns).padStart(9, '0')}`, path]);
    const after = statSync(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
    expect(m.listBackups()[0]?.provenance).toBe('mismatch');
  });

  it('forgets a backup that is gone', async () => {
    const m = signed();
    const created = await m.createBackup();
    m.listBackups();
    const cache = (m as unknown as ProvenanceSeam)._listProvenance;
    expect(cache.size).toBe(1);
    rmSync(created.path, { recursive: true });
    expect(m.listBackups()).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it('without a vault key, shows no-key and keeps nothing', async () => {
    const m = new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, null);
    await m.createBackup();
    expect(m.listBackups().map(b => b.provenance)).toEqual(['no-key']);
    expect((m as unknown as ProvenanceSeam)._listProvenance.size).toBe(0);
  });

  it('does not answer a restore from the list\'s cache', async () => {
    const m = signed();
    const created = await m.createBackup();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    const spy = vi.spyOn(m as unknown as ProvenanceSeam, 'provenanceOf');
    const result = await m.restoreBackup(created.path);
    expect(result.success, String(result.error)).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});
