import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A one-shot hook right AFTER a file of this path is opened: it replaces the file by name while
 * the descriptor still holds the bytes it opened. A restore that reads a file once stages those
 * bytes; one that reads it again by name gets the replacement. (Until the restore refused FIFOs
 * at a backup entry, a FIFO serving two contents was this instrument.)
 */
const afterOpen = vi.hoisted(() => ({ path: null as string | null, run: null as (() => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (afterOpen.run !== null && String(args[0]) === afterOpen.path) {
        const run = afterOpen.run;
        afterOpen.run = null;
        run();
      }
      return fd;
    }) as typeof fs.openSync,
  };
});

const { BackupManager } = await import('./backup.js');

/** Put `content` where `path` is, by a rename of a new file: an open descriptor keeps the old one. */
function replaceByName(path: string, content: string): void {
  writeFileSync(`${path}.replacement`, content);
  renameSync(`${path}.replacement`, path);
}

describe('restoreBackup asks for the proof of origin', () => {
  let lynoxDir: string;
  let backupDir: string;
  const KEY = 'vault-key-provenance';

  beforeEach(() => {
    lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-backup-test-'));
    backupDir = join(lynoxDir, 'backups');
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));
  });

  afterEach(() => {
    afterOpen.path = null;
    afterOpen.run = null;
    rmSync(lynoxDir, { recursive: true, force: true });
  });

  const mgr = (encrypt: boolean, key: string | null = KEY): InstanceType<typeof BackupManager> =>
    new BackupManager(lynoxDir, { backupDir, retentionDays: 30, encrypt }, key);
  /** Drifts the live config so a restore that ran shows: the backup holds `balanced`. */
  function driftLive(): void {
    writeFileSync(join(lynoxDir, 'config.json'), JSON.stringify({ default_tier: 'deep' }));
  }
  const liveTier = (): unknown => (JSON.parse(readFileSync(join(lynoxDir, 'config.json'), 'utf-8')) as Record<string, unknown>)['default_tier'];

  it('stages the bytes it checked, never a second read of the file by name', async () => {
    const manager = mgr(false);
    const created = await manager.createBackup();
    const src = join(created.path, 'config.json');
    driftLive();
    // Armed in the safety backup, after the verify pass: the restore's own open of the file is the
    // next, and right after it the file by that name says something else.
    const spy = vi.spyOn(manager, 'createBackup').mockImplementation(async () => {
      afterOpen.path = src;
      afterOpen.run = () => { replaceByName(src, JSON.stringify({ default_tier: 'second-read' })); };
      return { success: false, path: '', manifest: created.manifest, duration_ms: 0, error: 'stub' };
    });
    try {
      const result = await manager.restoreBackup(created.path);
      expect(afterOpen.run).toBeNull(); // the hook ran
      expect(result.success, String(result.error)).toBe(true);
      expect(liveTier()).toBe('balanced');
    } finally {
      spy.mockRestore();
    }
  });
});
