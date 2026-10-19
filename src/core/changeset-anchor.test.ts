import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync, constants, existsSync, linkSync, openSync, readSync, writeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
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

  it('a path left untracked under isolation is tracked by name once isolation is off within the run', () => {
    writeFileSync(join(ws, 'target.txt'), 'kept', 'utf-8');
    symlinkSync(join(ws, 'target.txt'), join(ws, 'f.txt'));
    const mgr = new ChangesetManager(ws, 'run');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    closeWorkspaceBase();
    clearTenantWorkspace();
    rmSync(join(ws, 'f.txt'));
    writeFileSync(join(ws, 'f.txt'), 'pre', 'utf-8');
    mgr.backupBeforeWrite(join(ws, 'f.txt'));
    writeFileSync(join(ws, 'f.txt'), 'post', 'utf-8');
    mgr.rollbackAll();
    expect(readFileSync(join(ws, 'f.txt'), 'utf-8')).toBe('pre');
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

describe('the changeset, from the security round', () => {
  it('when the workspace cannot be reached, nothing is tracked by name instead', () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'before', 'utf-8');
    symlinkSync(join(ws, 'real'), join(ws, 'ln'));
    const mgr = new ChangesetManager(ws, 'run');
    setTenantWorkspace(join(outside, 'gone'));
    mgr.backupBeforeWrite(join(ws, 'ln', 'f.txt'));
    mgr.backupBeforeWrite(join(ws, 'real', 'f.txt'));
    setTenantWorkspace(ws);
    writeFileSync(join(ws, 'real', 'f.txt'), 'after', 'utf-8');
    expect(mgr.getChanges()).toEqual([]);
    // positive control: with the workspace reachable, the same file is tracked
    mgr.backupBeforeWrite(join(ws, 'real', 'f.txt'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'again', 'utf-8');
    expect(mgr.getChanges().map(c => c.file)).toEqual(['real/f.txt']);
    mgr.cleanup();
  });

  it('a rollback after the workspace became a directory holding the old one reaches nothing', () => {
    const inner = join(ws, 'ctx');
    mkdirSync(inner);
    writeFileSync(join(inner, 'f.txt'), 'before', 'utf-8');
    setTenantWorkspace(inner);
    const mgr = new ChangesetManager(inner, 'run');
    mgr.backupBeforeWrite(join(inner, 'f.txt'));
    mgr.backupBeforeWrite(join(inner, 'added.txt'));
    writeFileSync(join(inner, 'f.txt'), 'after', 'utf-8');
    writeFileSync(join(inner, 'added.txt'), 'added', 'utf-8');
    setTenantWorkspace(ws);
    mgr.rollbackAll();
    expect(readFileSync(join(inner, 'f.txt'), 'utf-8')).toBe('after');
    expect(existsSync(join(inner, 'added.txt'))).toBe(true);
    // positive control: back in its own workspace, the same rollback restores
    setTenantWorkspace(inner);
    mgr.rollbackAll();
    expect(readFileSync(join(inner, 'f.txt'), 'utf-8')).toBe('before');
    mgr.cleanup();
  });

  it('after the workspace changed, a file in the one the manager was made for is not tracked by name', () => {
    writeFileSync(join(ws, 'f.txt'), 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run');
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-cs-ws3-')));
    try {
      setTenantWorkspace(other);
      mgr.backupBeforeWrite(join(ws, 'f.txt'));
      writeFileSync(join(ws, 'f.txt'), 'after', 'utf-8');
      expect(mgr.getChanges()).toEqual([]);
      mgr.rollbackAll();
      expect(readFileSync(join(ws, 'f.txt'), 'utf-8')).toBe('after');
    } finally {
      setTenantWorkspace(ws);
      mgr.cleanup();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')('a FIFO in another root neither hangs the backup, the review nor the rollback', () => {
    const mgr = new ChangesetManager(ws, 'run', [outside]);
    writeFileSync(join(outside, 'f.txt'), 'before', 'utf-8');
    mgr.backupBeforeWrite(join(outside, 'f.txt'));
    execFileSync('mkfifo', [join(outside, 'p')]);
    mgr.backupBeforeWrite(join(outside, 'p'));
    rmSync(join(outside, 'f.txt'));
    execFileSync('mkfifo', [join(outside, 'f.txt')]);
    expect(mgr.getChanges()).toEqual([]);
    mgr.rollbackAll();
    expect(statSync(join(outside, 'f.txt')).isFIFO()).toBe(true);
    expect(readForDiffPreview(join(outside, 'p'))).toBe('');
    mgr.cleanup();
  }, 10_000);

  // A FIFO that holds bytes: its writer wrote and left, a reader keeps the pipe alive. An open by
  // name then succeeds at once and reads those bytes, so only the check for a regular file keeps
  // them out of the review and the preview, and keeps the rollback from writing into the pipe.
  it.runIf(process.platform === 'linux')('a FIFO holding bytes is neither shown nor written', () => {
    const fifo = join(outside, 'f.txt');
    writeFileSync(fifo, 'before', 'utf-8');
    const mgr = new ChangesetManager(ws, 'run', [outside]);
    mgr.backupBeforeWrite(fifo);
    rmSync(fifo);
    execFileSync('mkfifo', [fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(writer, 'in the pipe');
      closeSync(writer);
      expect(readForDiffPreview(fifo)).toBe('');
      expect(mgr.getChanges()).toEqual([]);
      mgr.rollbackAll();
      const buf = Buffer.alloc(64);
      let n = 0;
      try { n = readSync(reader, buf, 0, 64, null); } catch { /* EAGAIN: the pipe is empty */ }
      // Exactly the bytes the writer left: a read by the preview or the review would have taken
      // them, a write by the rollback would have added to them.
      expect(buf.subarray(0, n).toString()).toBe('in the pipe');
    } finally {
      closeSync(reader);
      mgr.cleanup();
    }
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

  // A path outside whose directory is a link into the workspace: the write tools accept it,
  // because its real path is in the workspace. The preview reads that real path through the
  // workspace's open directory, so a file there with a second name shows as new.
  it('the preview before a write, by a link from outside into the workspace, shows nothing for a second name', async () => {
    const { diffPreviewText } = await import('./agent.js');
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'plain.txt'), 'plain', 'utf-8');
    writeFileSync(join(outside, 'vault.txt'), 'outside', 'utf-8');
    linkSync(join(outside, 'vault.txt'), join(ws, 'sub', 'f.txt'));
    symlinkSync(join(ws, 'sub'), join(outside, 'd'));
    expect(diffPreviewText(join(outside, 'd', 'plain.txt')), 'positive control: the path is accepted and read').toBe('plain');
    expect(diffPreviewText(join(outside, 'd', 'f.txt'))).toBe('');
  });

  it('reads a file outside the workspace by name, as before', () => {
    writeFileSync(join(outside, 'o.txt'), 'other root', 'utf-8');
    expect(readForDiffPreview(join(outside, 'o.txt'))).toBe('other root');
  });
});
