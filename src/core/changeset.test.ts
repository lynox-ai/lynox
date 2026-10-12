import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
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

    // Write new content (simulating what write_file tool does)
    writeFileSync(filePath, 'modified content', 'utf-8');

    expect(mgr.hasChanges()).toBe(true);
    expect(mgr.size).toBe(1);

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
    writeFileSync(filePath, 'content, edited', 'utf-8');

    // Access backup dir via getChanges (it reads from backup dir internally)
    const changes = mgr.getChanges();
    expect(changes).toHaveLength(1);

    mgr.cleanup();
    // The changeset is over: nothing is left to show or to roll back.
    expect(mgr.getChanges()).toEqual([]);
  });

  // The backup is taken before the write tool runs. A write that failed — or wrote the same
  // text — leaves an entry behind; it must not open a review, because an open review holds
  // the next message until it is answered.
  describe('a tracked file that did not change is not a change', () => {
    it('backup without a write: nothing to review', () => {
      const cwd = makeTempDir();
      const filePath = join(cwd, 'failed-edit.txt');
      writeFileSync(filePath, 'as it was', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(filePath);
      expect(mgr.getChanges()).toEqual([]);
      expect(mgr.hasChanges()).toBe(false);
      expect(mgr.size).toBe(0);
      mgr.cleanup();
    });

    it('a write of the same text: nothing to review', () => {
      const cwd = makeTempDir();
      const filePath = join(cwd, 'same.txt');
      writeFileSync(filePath, 'same text', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(filePath);
      writeFileSync(filePath, 'same text', 'utf-8');
      expect(mgr.hasChanges()).toBe(false);
      expect(mgr.size).toBe(0);
      mgr.cleanup();
    });

    it('a new file that was never created: nothing to review', () => {
      const cwd = makeTempDir();
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(join(cwd, 'never-written.txt'));
      expect(mgr.hasChanges()).toBe(false);
      expect(mgr.size).toBe(0);
      mgr.cleanup();
    });

    it('next to an unchanged one, a changed file is still reported, and counted alone', () => {
      const cwd = makeTempDir();
      const untouched = join(cwd, 'untouched.txt');
      const edited = join(cwd, 'edited.txt');
      writeFileSync(untouched, 'a', 'utf-8');
      writeFileSync(edited, 'b', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(untouched);
      mgr.backupBeforeWrite(edited);
      writeFileSync(edited, 'b, edited', 'utf-8');
      expect(mgr.getChanges().map(c => c.file)).toEqual(['edited.txt']);
      expect(mgr.hasChanges()).toBe(true);
      expect(mgr.size).toBe(1);
      mgr.cleanup();
    });

    it('a write that changed only bytes the text decoding hides is still a change', () => {
      const cwd = makeTempDir();
      const filePath = join(cwd, 'not-utf8.bin');
      writeFileSync(filePath, Buffer.from([0x61, 0xff, 0x62]));
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(filePath);
      // Writing back the decoded text turns 0xff into U+FFFD: same string, other bytes.
      const decoded = readFileSync(filePath, 'utf-8');
      writeFileSync(filePath, decoded, 'utf-8');
      expect(readFileSync(filePath, 'utf-8'), 'positive control: the decoded text is unchanged').toBe(decoded);
      expect(readFileSync(filePath).equals(Buffer.from([0x61, 0xff, 0x62])), 'positive control: the bytes changed').toBe(false);
      expect(mgr.hasChanges()).toBe(true);
      expect(mgr.size).toBe(1);
      mgr.cleanup();
    });

    // The comparison is against bytes held in memory, never against the backup copy: that
    // copy is a symlink when the tracked path is one, and gone after cleanup().
    it('a write through a symlink is a change', () => {
      const cwd = makeTempDir();
      const target = join(cwd, 'target.txt');
      const link = join(cwd, 'link.txt');
      writeFileSync(target, 'before', 'utf-8');
      symlinkSync('target.txt', link);
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(link);
      writeFileSync(link, 'through the link', 'utf-8');
      expect(readFileSync(target, 'utf-8'), 'positive control: the write reached the target').toBe('through the link');
      expect(mgr.hasChanges()).toBe(true);
      expect(mgr.size).toBe(1);
      mgr.cleanup();
    });

    it('rollback restores bytes that are not UTF-8 exactly, and the review is settled', () => {
      const cwd = makeTempDir();
      const filePath = join(cwd, 'not-utf8.bin');
      const before = Buffer.from([0xff, 0x41]);
      writeFileSync(filePath, before);
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(filePath);
      writeFileSync(filePath, 'replaced', 'utf-8');
      expect(mgr.hasChanges(), 'positive control').toBe(true);
      mgr.rollbackAll();
      expect(readFileSync(filePath).equals(before)).toBe(true);
      expect(mgr.hasChanges()).toBe(false);
      mgr.cleanup();
    });

    it('after cleanup, a restored file leaves nothing to review', () => {
      const cwd = makeTempDir();
      const filePath = join(cwd, 'restored.txt');
      writeFileSync(filePath, 'before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(filePath);
      writeFileSync(filePath, 'after', 'utf-8');
      expect(mgr.hasChanges(), 'positive control').toBe(true);
      mgr.rollbackAll();
      mgr.cleanup();
      expect(mgr.hasChanges()).toBe(false);
      expect(mgr.size).toBe(0);
    });
  });

  // The run's end is the one point where the changeset is settled: what did not change is
  // dropped there, never in a query, and a manager with nothing left keeps no directory.
  describe('the end of the run', () => {
    const backupDirOf = (mgr: ChangesetManager): string | null =>
      (mgr as unknown as { backupDir: string | null }).backupDir;

    it('"Rollback all" resets only what the review showed, not a file backed up and left as it was', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      const y = join(cwd, 'y.txt');
      writeFileSync(x, 'x before', 'utf-8');
      writeFileSync(y, 'y before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(x); // the write to x failed
      mgr.backupBeforeWrite(y);
      writeFileSync(y, 'y by the run', 'utf-8');
      mgr.settle();
      expect(mgr.getChanges().map(c => c.file), 'the review shows y alone').toEqual(['y.txt']);
      // Before the answer comes, x is changed from outside the run.
      writeFileSync(x, 'x by the user', 'utf-8');
      mgr.rollbackAll();
      expect(readFileSync(x, 'utf-8')).toBe('x by the user');
      expect(readFileSync(y, 'utf-8')).toBe('y before');
      mgr.cleanup();
    });

    it('a run without a real change leaves no backup directory', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      writeFileSync(x, 'as it was', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(x);
      const dir = backupDirOf(mgr);
      expect(dir !== null && existsSync(dir), 'positive control: the backup made a directory').toBe(true);
      mgr.settle();
      expect(existsSync(dir!)).toBe(false);
    });

    it('a run that writes nothing makes no directory at all', () => {
      const mgr = new ChangesetManager(makeTempDir(), 'test-run');
      expect(backupDirOf(mgr), 'not made by the constructor').toBeNull();
      mgr.settle();
      expect(backupDirOf(mgr)).toBeNull();
    });

    it('a run with a real change keeps its directory for the review', () => {
      const cwd = makeTempDir();
      const y = join(cwd, 'y.txt');
      writeFileSync(y, 'before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(y);
      writeFileSync(y, 'after', 'utf-8');
      mgr.settle();
      expect(existsSync(backupDirOf(mgr)!)).toBe(true);
      expect(mgr.getChanges()[0]?.diff).toContain('+after');
      mgr.cleanup();
    });

    it('a query between the backup and the write changes nothing about the review or the rollback', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      writeFileSync(x, 'original', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(x);
      // GET /changeset while the run waits between backup and write, e.g. on a prompt.
      expect(mgr.getChanges(), 'positive control: nothing to show yet').toEqual([]);
      expect(mgr.hasChanges()).toBe(false);
      writeFileSync(x, 'write1', 'utf-8');
      mgr.backupBeforeWrite(x); // the second write keeps the first backup
      writeFileSync(x, 'write2', 'utf-8');
      mgr.settle();
      const diff = mgr.getChanges()[0]?.diff ?? '';
      expect(diff).toContain('-original');
      expect(diff).toContain('+write2');
      mgr.rollbackAll();
      expect(readFileSync(x, 'utf-8')).toBe('original');
      mgr.cleanup();
    });

    it('an existing file whose backup copy fails is restored by "Rollback all", never deleted', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      writeFileSync(x, 'the user had this', 'utf-8');
      // The backup directory cannot be made: TMPDIR names a file.
      const notADir = join(cwd, 'not-a-dir');
      writeFileSync(notADir, '', 'utf-8');
      const saved = process.env['TMPDIR'];
      process.env['TMPDIR'] = notADir;
      const mgr = new ChangesetManager(cwd, 'test-run');
      try {
        mgr.backupBeforeWrite(x);
      } finally {
        if (saved === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = saved;
      }
      expect(backupDirOf(mgr), 'positive control: the copy really failed').toBeNull();
      writeFileSync(x, 'the run wrote this', 'utf-8');
      mgr.settle();
      expect(mgr.getChanges().map(c => c.status)).toEqual(['modified']);
      expect(mgr.getChanges()[0]?.diff, 'no copy to diff against, and the review says so').toContain('(diff unavailable)');
      mgr.rollbackAll();
      expect(existsSync(x)).toBe(true);
      expect(readFileSync(x, 'utf-8')).toBe('the user had this');
    });

    it('a second answer to the same review finds nothing: an accepted change is not rolled back', () => {
      const cwd = makeTempDir();
      const y = join(cwd, 'y.txt');
      writeFileSync(y, 'before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(y);
      writeFileSync(y, 'accepted', 'utf-8');
      mgr.settle();
      expect(mgr.hasChanges(), 'positive control').toBe(true);
      mgr.acceptAll();
      expect(mgr.hasChanges()).toBe(false);
      mgr.rollbackAll(); // the other tab answers "Rollback all"
      expect(readFileSync(y, 'utf-8')).toBe('accepted');
    });

    it('a file the run deleted is kept by settle, and "Rollback all" brings it back', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      writeFileSync(x, 'was here', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(x);
      rmSync(x);
      mgr.settle();
      mgr.rollbackAll();
      expect(readFileSync(x, 'utf-8')).toBe('was here');
      mgr.cleanup();
    });

    it.skipIf(process.getuid?.() === 0)('an existing file that cannot be read is never deleted by "Rollback all"', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'locked.txt');
      writeFileSync(x, 'the user had this', 'utf-8');
      chmodSync(x, 0o000);
      const mgr = new ChangesetManager(cwd, 'test-run');
      try {
        mgr.backupBeforeWrite(x);
        mgr.rollbackAll();
        expect(existsSync(x)).toBe(true);
      } finally {
        chmodSync(x, 0o600);
        mgr.cleanup();
      }
      expect(readFileSync(x, 'utf-8')).toBe('the user had this');
    });

    it('a backup after cleanup makes a fresh directory and still diffs', () => {
      const cwd = makeTempDir();
      const x = join(cwd, 'x.txt');
      const y = join(cwd, 'y.txt');
      writeFileSync(x, 'x', 'utf-8');
      writeFileSync(y, 'y before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(x);
      const first = backupDirOf(mgr);
      mgr.cleanup();
      mgr.backupBeforeWrite(y);
      writeFileSync(y, 'y after', 'utf-8');
      expect(backupDirOf(mgr)).not.toBe(first);
      expect(mgr.getChanges().find(c => c.file === 'y.txt')?.diff).toContain('-y before');
      mgr.cleanup();
    });

    it('keeps the backup of a file outside the working directory inside its own directory', () => {
      const cwd = makeTempDir();
      const outside = join(makeTempDir(), 'elsewhere.txt');
      writeFileSync(outside, 'before', 'utf-8');
      const mgr = new ChangesetManager(cwd, 'test-run');
      mgr.backupBeforeWrite(outside);
      writeFileSync(outside, 'after', 'utf-8');
      const dir = backupDirOf(mgr)!;
      expect(readdirSync(dir)).toHaveLength(1);
      expect(mgr.getChanges()[0]?.diff).toContain('-before');
      mgr.cleanup();
      expect(existsSync(dir)).toBe(false);
    });
  });
});
