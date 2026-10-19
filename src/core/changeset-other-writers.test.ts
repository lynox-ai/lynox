import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * The run's review ("Rollback all") next to the other writers. A transform by batch_files is in
 * the review as write_file's writes are; a rename or move is refused while the review holds
 * anything, because its rollback cannot follow a moved file. Run once through the context
 * workspace's open directory (isolation) and once by path, the two branches of the tool.
 */

let root: string;
let mgr: ChangesetManager;

/** `changeset: null` runs it with the review off. */
const batch = (input: Record<string, unknown>, changeset: ChangesetManagerLike | null = mgr): Promise<string> =>
  batchFilesTool.handler({ pattern: '*.txt', ...input } as never, { changeset: changeset ?? undefined } as never);

/** What write_file does with the review on. */
function writeAsTheRun(path: string, text: string): void {
  mgr.backupBeforeWrite(path);
  writeFileSync(path, text);
  mgr.recordWritten(path);
}

/** Replaces a file by a new one with the same bytes: a different file at the same path. */
function replaceWithCopy(path: string): void {
  const bytes = readFileSync(path);
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

describe.each([
  ['through the workspace', true],
  ['by path', false],
] as const)('the review and batch_files, %s', (_label, isolated) => {
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

  it('the measured case: after the run created a file, the user\'s file is not moved onto its name, and both come out right', async () => {
    mkdirSync(join(root, 'out'));
    mkdirSync(join(root, 'in'));
    const created = join(root, 'out', 'report.txt');
    writeAsTheRun(created, 'made by the run');
    writeFileSync(join(root, 'in', 'report.txt'), 'the user wrote this');

    await expect(batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') }))
      .rejects.toThrow(/did not move anything.*accepted or rolled back/);
    expect(readFileSync(join(root, 'in', 'report.txt'), 'utf8')).toBe('the user wrote this');
    mgr.settle();

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'in', 'report.txt'), 'utf8')).toBe('the user wrote this');
    expect(existsSync(created)).toBe(false);
  });

  it('refuses a rename while the review holds a change', async () => {
    writeAsTheRun(join(root, 'notes.md'), 'made by the run');
    writeFileSync(join(root, 'a.txt'), 'a by the user');
    await expect(batch({ directory: root, operation: 'rename', rename_pattern: '$1-renamed.txt' }))
      .rejects.toThrow(/did not rename anything/);
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
    expect(existsSync(join(root, 'a-renamed.txt'))).toBe(false);
  });

  it('refuses a move while the review holds a file it saved and the write left as it was', async () => {
    writeFileSync(join(root, 'kept.md'), 'as it was');
    mgr.backupBeforeWrite(join(root, 'kept.md')); // the write failed
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'a.txt'), 'a');
    await expect(batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') }))
      .rejects.toThrow(/did not move anything/);
    expect(existsSync(join(root, 'in', 'a.txt'))).toBe(true);
  });

  it('without the review, renames and moves as it does with no review at all', async () => {
    writeAsTheRun(join(root, 'notes.md'), 'made by the run');
    writeFileSync(join(root, 'a.txt'), 'a by the user');
    expect(await batch({ directory: root, operation: 'rename', rename_pattern: '$1-renamed.txt' }, null)).toContain('a.txt → a-renamed.txt');
    expect(readFileSync(join(root, 'a-renamed.txt'), 'utf8')).toBe('a by the user');
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'b.txt'), 'b');
    expect(await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') }, null)).not.toContain('Error');
    expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('b');
  });

  it('with the review on but nothing in it yet, moves; the move is not in the review', async () => {
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in', 'b.txt'), 'b');
    expect(await batch({ directory: join(root, 'in'), operation: 'move', destination: join(root, 'out') })).not.toContain('Error');
    expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('b');
    expect(mgr.getChanges()).toEqual([]);
  });

  it('a transform is in the review, and rolled back to the original bytes', async () => {
    writeFileSync(join(root, 'notes.txt'), 'colour and colour');
    const out = await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' });
    expect(out).toContain('Transformed');
    expect(mgr.getChanges().map((c) => [c.file, c.status])).toEqual([['notes.txt', 'modified']]);

    mgr.rollbackAll();
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('colour and colour');
  });

  it('a file the run created and then transformed is gone after the rollback', async () => {
    const made = join(root, 'made.txt');
    writeAsTheRun(made, 'colour');
    await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' });
    expect(readFileSync(made, 'utf8')).toBe('color');

    mgr.rollbackAll();
    expect(existsSync(made)).toBe(false);
  });

  it('keeps a file the run created when the user changed it after the run (same file, other bytes)', async () => {
    const made = join(root, 'made.txt');
    writeAsTheRun(made, 'made by the run');
    const ino = statSync(made).ino;
    writeFileSync(made, 'made by the run, and more by the user');
    expect(statSync(made).ino).toBe(ino);

    mgr.rollbackAll();
    expect(readFileSync(made, 'utf8')).toBe('made by the run, and more by the user');
  });

  it('keeps a file that stands where the run created one but is another file, even with the same bytes', async () => {
    const made = join(root, 'made.txt');
    writeAsTheRun(made, 'same bytes');
    replaceWithCopy(made);

    mgr.rollbackAll();
    expect(readFileSync(made, 'utf8')).toBe('same bytes');
  });

  it('deletes the file the run created when it is still that file (positive control)', async () => {
    const made = join(root, 'made.txt');
    writeAsTheRun(made, 'same bytes');

    mgr.rollbackAll();
    expect(existsSync(made)).toBe(false);
  });

  it('does not transform a file it could not save for the review', async () => {
    writeFileSync(join(root, 'a.txt'), 'colour');
    const unsaved: ChangesetManagerLike = { active: true, backupBeforeWrite: () => false, recordWritten: () => {}, isEmpty: () => true };
    const transformed = await batch({ directory: root, operation: 'transform', find: 'colour', replace: 'color' }, unsaved);
    expect(transformed).toContain('could not be saved for the review');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('colour');
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
