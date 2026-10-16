import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangesetManager } from './changeset.js';
import { readForDiffPreview } from './agent.js';
import { clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';

/**
 * With isolation, the changeset reaches a file in the context workspace only through the
 * workspace's open directory, one component at a time without following a link. Every case has
 * a positive control: the same steps without the link or second name are tracked and rolled back.
 */

let ws: string;
let outside: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-ws-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-out-')));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('the changeset with isolation', () => {
  it('tracks, shows and rolls back a modified and an added file, and keeps the workspace', () => {
    writeFileSync(join(ws, 'a.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'a.txt'));
    mgr.backupBeforeWrite(join(ws, 'new', 'deep', 'b.txt'));
    writeFileSync(join(ws, 'a.txt'), 'after', 'utf-8');
    mkdirSync(join(ws, 'new', 'deep'), { recursive: true });
    writeFileSync(join(ws, 'new', 'deep', 'b.txt'), 'made', 'utf-8');
    expect(mgr.getChanges().map(c => c.file).sort()).toEqual(['a.txt', 'new/deep/b.txt']);
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('before');
    expect(existsSync(join(ws, 'new')), 'the empty directories the run made go').toBe(false);
    expect(existsSync(ws), 'the workspace itself stays').toBe(true);
    mgr.cleanup();
  });

  it('a file the run deleted is made again with the mode a write by name gives it', () => {
    writeFileSync(join(ws, 'a.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'a.txt'));
    rmSync(join(ws, 'a.txt'));
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('before');
    writeFileSync(join(ws, 'byname.txt'), 'x');
    expect(statSync(join(ws, 'a.txt')).mode & 0o777).toBe(statSync(join(ws, 'byname.txt')).mode & 0o777);
    mgr.cleanup();
  });

  it('does not follow a directory link that stays in the workspace, neither to show nor to roll back', () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'before', 'utf-8');
    // positive control: the same file by its own path is tracked and restored
    const control = new ChangesetManager(ws, 'run');
    control.backupBeforeWrite(join(ws, 'real', 'f.txt'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'after', 'utf-8');
    expect(control.getChanges().map(c => c.file)).toEqual(['real/f.txt']);
    control.rollbackAll();
    expect(readFileSync(join(ws, 'real', 'f.txt'), 'utf-8')).toBe('before');
    control.cleanup();

    symlinkSync(join(ws, 'real'), join(ws, 'ln'));
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'ln', 'f.txt'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'after', 'utf-8');
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'real', 'f.txt'), 'utf-8')).toBe('after');
    mgr.cleanup();
  });

  it('a directory swapped for a link within the workspace after the backup is left alone', () => {
    mkdirSync(join(ws, 'sub'));
    mkdirSync(join(ws, 'other'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'before', 'utf-8');
    writeFileSync(join(ws, 'other', 'f.txt'), 'other', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'sub', 'f.txt'));
    mgr.backupBeforeWrite(join(ws, 'sub', 'g.txt'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'after', 'utf-8');
    writeFileSync(join(ws, 'sub', 'g.txt'), 'added', 'utf-8');
    writeFileSync(join(ws, 'other', 'g.txt'), 'kept', 'utf-8');
    expect(mgr.getChanges().map(c => c.file).sort(), 'positive control: tracked before the swap').toEqual(['sub/f.txt', 'sub/g.txt']);
    renameSync(join(ws, 'sub'), join(ws, 'moved'));
    symlinkSync(join(ws, 'other'), join(ws, 'sub'));
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'other', 'f.txt'), 'utf-8')).toBe('other');
    expect(readFileSync(join(ws, 'other', 'g.txt'), 'utf-8'), 'an added file is not removed through the link').toBe('kept');
    mgr.cleanup();
  });

  it('a path through a link at its first backup is recorded by its second, once it is a real directory', () => {
    mkdirSync(join(ws, 'real'));
    symlinkSync(join(ws, 'real'), join(ws, 'sub'));
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'sub', 'f.txt'));
    rmSync(join(ws, 'sub'));
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'pre', 'utf-8');
    mgr.backupBeforeWrite(join(ws, 'sub', 'f.txt'));
    writeFileSync(join(ws, 'sub', 'f.txt'), 'post', 'utf-8');
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'sub', 'f.txt'), 'utf-8')).toBe('pre');
    mgr.cleanup();
  });

  it('a link at the file is not tracked, and a rollback leaves what it points to', () => {
    writeFileSync(join(ws, 'target.txt'), 'kept', 'utf-8');
    symlinkSync(join(ws, 'target.txt'), join(ws, 'ln.txt'));
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'ln.txt'));
    rmSync(join(ws, 'ln.txt'));
    writeFileSync(join(ws, 'ln.txt'), 'made in the run', 'utf-8');
    mgr.backupBeforeWrite(join(ws, 'ln.txt'));
    expect(mgr.getChanges(), 'not tracked: the second backup saw a file that was there').toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'ln.txt'), 'utf-8')).toBe('made in the run');
    expect(readFileSync(join(ws, 'target.txt'), 'utf-8')).toBe('kept');
    mgr.cleanup();
  });

  it('a file given a second name outside during the run is neither shown nor written', () => {
    writeFileSync(join(ws, 'f.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    writeFileSync(join(ws, 'f.txt'), 'after', 'utf-8');
    expect(mgr.getChanges().map(c => c.file), 'positive control: tracked before the second name').toEqual(['f.txt']);
    writeFileSync(join(outside, 'vault.txt'), 'outside', 'utf-8');
    rmSync(join(ws, 'f.txt'));
    linkSync(join(outside, 'vault.txt'), join(ws, 'f.txt'));
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(outside, 'vault.txt'), 'utf-8')).toBe('outside');
    mgr.cleanup();
  });

  it('a file with a second name at the backup is not copied', () => {
    writeFileSync(join(outside, 'vault.txt'), 'outside', 'utf-8');
    linkSync(join(outside, 'vault.txt'), join(ws, 'f.txt'));
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    writeFileSync(join(outside, 'vault.txt'), 'changed', 'utf-8');
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(outside, 'vault.txt'), 'utf-8')).toBe('changed');
    mgr.cleanup();
  });

  it.runIf(process.platform === 'linux')('a FIFO in place of the file neither hangs the review nor the rollback', () => {
    writeFileSync(join(ws, 'f.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    mgr.backupBeforeWrite(join(ws, 'p'));
    rmSync(join(ws, 'f.txt'));
    execFileSync('mkfifo', [join(ws, 'f.txt')]);
    execFileSync('mkfifo', [join(ws, 'p')]);
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(statSync(join(ws, 'f.txt')).isFIFO()).toBe(true);
    mgr.cleanup();
  }, 10_000);

  it('a rollback after the context workspace changed reaches nothing in the new one', () => {
    writeFileSync(join(ws, 'f.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    mgr.backupBeforeWrite(join(ws, 'added.txt'));
    writeFileSync(join(ws, 'f.txt'), 'after', 'utf-8');
    writeFileSync(join(ws, 'added.txt'), 'added', 'utf-8');
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-ws2-')));
    try {
      writeFileSync(join(other, 'f.txt'), 'theirs', 'utf-8');
      writeFileSync(join(other, 'added.txt'), 'theirs', 'utf-8');
      setTenantWorkspace(other);
      mgr.rollbackAll();
      expect(readFileSync(join(other, 'f.txt'), 'utf-8')).toBe('theirs');
      expect(readFileSync(join(other, 'added.txt'), 'utf-8')).toBe('theirs');
      // positive control: back in its own workspace, the same rollback restores
      setTenantWorkspace(ws);
      mgr.rollbackAll();
      expect(readFileSync(join(ws, 'f.txt'), 'utf-8')).toBe('before');
      expect(existsSync(join(ws, 'added.txt'))).toBe(false);
    } finally {
      mgr.cleanup();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a file outside the workspace in another root is still tracked by name', () => {
    const mgr = new ChangesetManager(ws, 'run', [outside]);
    writeFileSync(join(outside, 'o.txt'), 'before', 'utf-8');
    mgr.backupBeforeWrite(join(outside, 'o.txt'));
    writeFileSync(join(outside, 'o.txt'), 'after', 'utf-8');
    expect(mgr.getChanges()).toHaveLength(1);
    mgr.rollbackAll();
    expect(readFileSync(join(outside, 'o.txt'), 'utf-8')).toBe('before');
    mgr.cleanup();
  });

  it('a path in another root that reaches the workspace through a link is not tracked by name', () => {
    writeFileSync(join(ws, 'f.txt'), 'before', 'utf-8');
    symlinkSync(ws, join(outside, 'into'));
    const mgr = new ChangesetManager(ws, 'run', [outside]);
    mgr.backupBeforeWrite(join(outside, 'into', 'f.txt'));
    writeFileSync(join(ws, 'f.txt'), 'after', 'utf-8');
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'f.txt'), 'utf-8')).toBe('after');
    mgr.cleanup();
  });
});

describe('the diff preview with isolation', () => {
  it('reads a file in the workspace', () => {
    writeFileSync(join(ws, 'f.txt'), 'text', 'utf-8');
    expect(readForDiffPreview(join(ws, 'f.txt'))).toBe('text');
  });

  it('does not follow a directory link on the way, even one that stays in the workspace', () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'text', 'utf-8');
    symlinkSync(join(ws, 'real'), join(ws, 'ln'));
    expect(readForDiffPreview(join(ws, 'real', 'f.txt')), 'positive control').toBe('text');
    expect(readForDiffPreview(join(ws, 'ln', 'f.txt'))).toBe('');
  });

  it('shows nothing for a file with a second name', () => {
    writeFileSync(join(outside, 'vault.txt'), 'outside', 'utf-8');
    linkSync(join(outside, 'vault.txt'), join(ws, 'f.txt'));
    expect(readForDiffPreview(join(ws, 'f.txt'))).toBe('');
  });

  it('reads a file outside the workspace by name, as before', () => {
    writeFileSync(join(outside, 'o.txt'), 'other root', 'utf-8');
    expect(readForDiffPreview(join(outside, 'o.txt'))).toBe('other root');
  });
});
