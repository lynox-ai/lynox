import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangesetManager } from './changeset.js';
import { clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { batchFilesTool } from '../tools/builtin/batch-files.js';
import type { ChangesetManagerLike } from '../types/index.js';

// Off unless a test turns it on: the context workspace then cannot be reached.
const unreachable = vi.hoisted(() => ({ on: false }));
vi.mock('./workspace-rel.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./workspace-rel.js')>();
  return {
    ...real,
    workspaceBase: (...args: Parameters<typeof real.workspaceBase>): ReturnType<typeof real.workspaceBase> => {
      if (unreachable.on) throw new Error('workspace root unreachable');
      return real.workspaceBase(...args);
    },
  };
});

/**
 * batch_files changes files the review must show and "Rollback all" must undo, as write_file's.
 * Run once through the context workspace's open directory (isolation) and once by path, the two
 * branches of the tool.
 */

let root: string;
let mgr: ChangesetManager;

const batch = (input: Record<string, unknown>, changeset: ChangesetManagerLike | undefined = mgr): Promise<string> =>
  batchFilesTool.handler({ pattern: '*.txt', ...input } as never, { changeset } as never);

/** Replaces a file by a new one with the same bytes: a different file at the same path. */
function replaceWithCopy(path: string): void {
  const bytes = readFileSync(path);
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

describe.each([
  ['through the workspace', true],
  ['by path', false],
] as const)('batch_files with the review on, %s', (_label, isolated) => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-writers-')));
    if (isolated) setTenantWorkspace(root);
    mgr = new ChangesetManager(root, 'run');
  });

  afterEach(() => {
    mgr.cleanup();
    closeWorkspaceBase();
    clearTenantWorkspace();
    unreachable.on = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('a move is rolled back to where the file was, and nothing of it is left where it went', async () => {
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'report.txt'), 'the user wrote this');
    const out = await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') });
    expect(out).not.toContain('Error');
    expect(existsSync(join(root, 'in', 'report.txt'))).toBe(false);
    // The review shows the file where it went; it shows no deletion, here as for any other writer.
    expect(mgr.getChanges().map((c) => [c.file, c.status])).toEqual([[join('out', 'report.txt'), 'added']]);

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'in', 'report.txt'), 'utf8')).toBe('the user wrote this');
    expect(existsSync(join(root, 'out', 'report.txt'))).toBe(false);
  });

  it('a move onto a file that was there gives both files back', async () => {
    mkdirSync(join(root, 'in'));
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'in', 'report.txt'), 'moved');
    writeFileSync(join(root, 'out', 'report.txt'), 'was there before');
    await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') });
    expect(readFileSync(join(root, 'out', 'report.txt'), 'utf8')).toBe('moved');

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'in', 'report.txt'), 'utf8')).toBe('moved');
    expect(readFileSync(join(root, 'out', 'report.txt'), 'utf8')).toBe('was there before');
  });

  it('a rename is rolled back to the old name, and the new name is gone', async () => {
    writeFileSync(join(root, 'a.txt'), 'a by the user');
    const out = await batch({ directory: root, operation: 'rename', rename_pattern: '$1-renamed.txt' });
    expect(out).toContain('a.txt → a-renamed.txt');

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a by the user');
    expect(existsSync(join(root, 'a-renamed.txt'))).toBe(false);
  });

  it('a rename onto a file that was there gives that file back', async () => {
    writeFileSync(join(root, 'a.txt'), 'a by the user');
    writeFileSync(join(root, 'a.md'), 'was there before');
    await batch({ directory: root, operation: 'rename', rename_pattern: '$1.md' });
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('a by the user');

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a by the user');
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('was there before');
  });

  it('a transform is in the review, and rolled back to the original bytes', async () => {
    writeFileSync(join(root, 'notes.txt'), 'colour and colour');
    const out = await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' });
    expect(out).toContain('Transformed');
    expect(mgr.getChanges().map((c) => [c.file, c.status])).toEqual([['notes.txt', 'modified']]);

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('colour and colour');
  });

  it('a file the run created and then moved is gone after the rollback, from both places', async () => {
    const made = join(root, 'in', 'made.txt');
    mkdirSync(join(root, 'in'));
    // What write_file does with the review on.
    mgr.backupBeforeWrite(made);
    writeFileSync(made, 'made by the run');
    mgr.recordWritten(made);
    await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') });

    mgr.rollbackAll();
    expect(existsSync(made)).toBe(false);
    expect(existsSync(join(root, 'out', 'made.txt'))).toBe(false);
  });

  it('a file the run created and then transformed is gone after the rollback', async () => {
    const made = join(root, 'made.txt');
    mgr.backupBeforeWrite(made);
    writeFileSync(made, 'colour');
    mgr.recordWritten(made);
    await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' });
    expect(readFileSync(made, 'utf8')).toBe('color');

    mgr.rollbackAll();
    expect(existsSync(made)).toBe(false);
  });

  it('keeps a moved-in file the user changed after the run, and still restores the source', async () => {
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'report.txt'), 'the user wrote this');
    await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') });
    const ino = statSync(join(root, 'out', 'report.txt')).ino;
    // The user goes on working on the file where it is now: same file, other bytes.
    writeFileSync(join(root, 'out', 'report.txt'), 'the user wrote this, and more after the run');
    expect(statSync(join(root, 'out', 'report.txt')).ino).toBe(ino);

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'out', 'report.txt'), 'utf8')).toBe('the user wrote this, and more after the run');
    expect(readFileSync(join(root, 'in', 'report.txt'), 'utf8')).toBe('the user wrote this');
  });

  it('keeps a file that stands where the run created one but is another file, even with the same bytes', async () => {
    const made = join(root, 'made.txt');
    mgr.backupBeforeWrite(made);
    writeFileSync(made, 'same bytes');
    mgr.recordWritten(made);
    replaceWithCopy(made);

    mgr.rollbackAll();
    expect(readFileSync(made, 'utf8')).toBe('same bytes');
  });

  it('deletes the file the run created when it is still that file (positive control)', async () => {
    const made = join(root, 'made.txt');
    mgr.backupBeforeWrite(made);
    writeFileSync(made, 'same bytes');
    mgr.recordWritten(made);

    mgr.rollbackAll();
    expect(existsSync(made)).toBe(false);
  });

  it('changes nothing it could not save for the review', async () => {
    writeFileSync(join(root, 'a.txt'), 'colour');
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'b.txt'), 'b');
    const unsaved: ChangesetManagerLike = { active: true, backupBeforeWrite: () => false, recordWritten: () => {} };

    const transformed = await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' }, unsaved);
    expect(transformed).toContain('could not be saved for the review');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('colour');

    const renamed = await batch({ directory: root, operation: 'rename', rename_pattern: '$1.md' }, unsaved);
    expect(renamed).toContain('could not be saved for the review');
    expect(existsSync(join(root, 'a.txt'))).toBe(true);

    const moved = await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') }, unsaved);
    expect(moved).toContain('could not be saved for the review');
    expect(existsSync(join(root, 'in', 'b.txt'))).toBe(true);
  });
});

describe('the review, when the workspace cannot be reached', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-writers-')));
    setTenantWorkspace(root);
    mgr = new ChangesetManager(root, 'run');
  });

  afterEach(() => {
    mgr.cleanup();
    unreachable.on = false;
    closeWorkspaceBase();
    clearTenantWorkspace();
    rmSync(root, { recursive: true, force: true });
  });

  it('tells the writer it saved nothing, so the write does not go ahead', () => {
    unreachable.on = true;
    expect(mgr.backupBeforeWrite(join(root, 'a.txt'))).toBe(false);
    unreachable.on = false;
    // positive control: reachable again, the same path is saved
    expect(mgr.backupBeforeWrite(join(root, 'a.txt'))).toBe(true);
  });
});

describe('a moved file whose source cannot be restored', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-writers-')));
    setTenantWorkspace(root);
    mgr = new ChangesetManager(root, 'run');
  });

  afterEach(() => {
    mgr.cleanup();
    closeWorkspaceBase();
    clearTenantWorkspace();
    rmSync(root, { recursive: true, force: true });
  });

  it('is kept where it went, so the user\'s file is not lost', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-elsewhere-')));
    try {
      mkdirSync(join(root, 'in'));
      writeFileSync(join(root, 'in', 'report.txt'), 'the user wrote this');
      await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') });
      // The source directory is now a link: the rollback does not follow it, and cannot restore there.
      rmSync(join(root, 'in'), { recursive: true });
      symlinkSync(elsewhere, join(root, 'in'));

      mgr.rollbackAll();
      expect(existsSync(join(elsewhere, 'report.txt'))).toBe(false);
      expect(readFileSync(join(root, 'out', 'report.txt'), 'utf8')).toBe('the user wrote this');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
