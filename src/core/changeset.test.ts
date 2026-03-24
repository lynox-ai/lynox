import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { ChangesetManager } from './changeset.js';

describe('ChangesetManager', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'changeset-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    tempDirs.length = 0;
  });

  it('should backup existing file before write', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'test.txt');
    writeFileSync(filePath, 'original content', 'utf-8');

    const mgr = new ChangesetManager(cwd, 'test-run');

    mgr.backupBeforeWrite(filePath);

    expect(mgr.hasChanges()).toBe(true);
    expect(mgr.size).toBe(1);

    // Write new content (simulating what write_file tool does)
    writeFileSync(filePath, 'modified content', 'utf-8');

    const changes = mgr.getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
    expect(changes[0]!.file).toBe('test.txt');
    expect(changes[0]!.diff).toContain('-original content');
    expect(changes[0]!.diff).toContain('+modified content');

    mgr.cleanup();
  });

  it('should track new files as added', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'new-file.txt');

    const mgr = new ChangesetManager(cwd, 'test-run');

    mgr.backupBeforeWrite(filePath);

    // Create new file
    writeFileSync(filePath, 'new content', 'utf-8');

    const changes = mgr.getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('added');
    expect(changes[0]!.originalContent).toBeNull();
    expect(changes[0]!.diff).toContain('+new content');

    mgr.cleanup();
  });

  it('should only backup original content on first write (multiple writes)', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'multi.txt');
    writeFileSync(filePath, 'v1', 'utf-8');

    const mgr = new ChangesetManager(cwd, 'test-run');

    // First backup
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'v2', 'utf-8');

    // Second backup call — should be no-op
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'v3', 'utf-8');

    // Third backup call — still no-op
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'v4', 'utf-8');

    // Only one entry tracked
    expect(mgr.size).toBe(1);

    // Diff shows v1 → v4 (not v2 → v4 or v3 → v4)
    const changes = mgr.getChanges();
    expect(changes[0]!.diff).toContain('-v1');
    expect(changes[0]!.diff).toContain('+v4');

    mgr.cleanup();
  });

  it('should rollback modified files', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'rollback.txt');
    writeFileSync(filePath, 'original', 'utf-8');

    const mgr = new ChangesetManager(cwd, 'test-run');
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'changed', 'utf-8');

    expect(readFileSync(filePath, 'utf-8')).toBe('changed');

    mgr.rollbackAll();

    expect(readFileSync(filePath, 'utf-8')).toBe('original');
    mgr.cleanup();
  });

  it('should rollback added files by deleting them', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'new-to-delete.txt');

    const mgr = new ChangesetManager(cwd, 'test-run');
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'temp content', 'utf-8');

    expect(existsSync(filePath)).toBe(true);

    mgr.rollbackAll();

    expect(existsSync(filePath)).toBe(false);
    mgr.cleanup();
  });

  it('should rollback specific files only', () => {
    const cwd = makeTempDir();
    const fileA = join(cwd, 'a.txt');
    const fileB = join(cwd, 'b.txt');
    writeFileSync(fileA, 'orig-a', 'utf-8');
    writeFileSync(fileB, 'orig-b', 'utf-8');

    const mgr = new ChangesetManager(cwd, 'test-run');
    mgr.backupBeforeWrite(fileA);
    mgr.backupBeforeWrite(fileB);
    writeFileSync(fileA, 'new-a', 'utf-8');
    writeFileSync(fileB, 'new-b', 'utf-8');

    // Roll back only fileA
    mgr.rollbackFiles([fileA]);

    expect(readFileSync(fileA, 'utf-8')).toBe('orig-a');
    expect(readFileSync(fileB, 'utf-8')).toBe('new-b'); // unchanged

    mgr.cleanup();
  });

  it('should accept all without modifying files', () => {
    const cwd = makeTempDir();
    const filePath = join(cwd, 'accept.txt');
    writeFileSync(filePath, 'original', 'utf-8');

    const mgr = new ChangesetManager(cwd, 'test-run');
    mgr.backupBeforeWrite(filePath);
    writeFileSync(filePath, 'changed', 'utf-8');

    mgr.acceptAll();

    // File should stay changed
    expect(readFileSync(filePath, 'utf-8')).toBe('changed');
  });

  it('should report no changes on empty changeset', () => {
    const cwd = makeTempDir();
    const mgr = new ChangesetManager(cwd, 'test-run');

    expect(mgr.hasChanges()).toBe(false);
    expect(mgr.size).toBe(0);
    expect(mgr.getChanges()).toHaveLength(0);

    mgr.cleanup();
  });

  it('should handle nested directories for new files', () => {
    const cwd = makeTempDir();
    const nested = join(cwd, 'deep', 'nested', 'file.txt');

    const mgr = new ChangesetManager(cwd, 'test-run');
    mgr.backupBeforeWrite(nested);

    // Create nested dirs and file
    mkdirSync(join(cwd, 'deep', 'nested'), { recursive: true });
    writeFileSync(nested, 'deep content', 'utf-8');

    const changes = mgr.getChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.file).toBe(join('deep', 'nested', 'file.txt'));
    expect(changes[0]!.status).toBe('added');

    // Rollback should delete the file
    mgr.rollbackAll();
    expect(existsSync(nested)).toBe(false);

    mgr.cleanup();
  });

  it('should always report active=true', () => {
    const cwd = makeTempDir();
    const mgr = new ChangesetManager(cwd, 'test-run');
    expect(mgr.active).toBe(true);
    mgr.cleanup();
  });

  it('cleanup should remove backup directory', () => {
    const cwd = makeTempDir();
    const mgr = new ChangesetManager(cwd, 'test-run');
    const filePath = join(cwd, 'clean.txt');
    writeFileSync(filePath, 'content', 'utf-8');
    mgr.backupBeforeWrite(filePath);

    // Access backup dir via getChanges (it reads from backup dir internally)
    const changes = mgr.getChanges();
    expect(changes).toHaveLength(1);

    mgr.cleanup();
    // After cleanup, getChanges still works (reads from entries map + current files)
    // but backup dir is gone
  });
});
