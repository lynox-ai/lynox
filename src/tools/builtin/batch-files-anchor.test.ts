import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchFilesTool } from './batch-files.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import { closeWorkspaceBase } from '../../core/workspace-rel.js';

let ws: string;
let outside: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-batch-ws-')));
  // Under /tmp, which `validatePath` allows: a link from the workspace to it passed the old check.
  outside = realpathSync(mkdtempSync('/tmp/lynox-batch-out-'));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const run = (input: Record<string, unknown>): Promise<string> =>
  batchFilesTool.handler({ pattern: '*.txt', directory: ws, operation: 'transform', ...input } as never, {} as never);

describe('batch_files reaches the workspace through its open directory', () => {
  it('transforms the files below the directory, in place, and keeps their mode', async () => {
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'one.txt'), 'old one');
    writeFileSync(join(ws, 'a', 'b', 'two.txt'), 'old two');
    chmodSync(join(ws, 'one.txt'), 0o640);
    const ino = statSync(join(ws, 'one.txt')).ino;
    const out = await run({ find: 'old', replace: 'new' });
    expect(out).toContain(`Transformed: ${join(ws, 'one.txt')}`);
    expect(out).toContain(`Transformed: ${join(ws, 'a', 'b', 'two.txt')}`);
    expect(readFileSync(join(ws, 'a', 'b', 'two.txt'), 'utf8')).toBe('new two');
    expect(statSync(join(ws, 'one.txt')).ino).toBe(ino);
    expect(statSync(join(ws, 'one.txt')).mode & 0o777).toBe(0o640);
  });

  it('does not follow a link in the workspace to a directory outside, as the directory or below it', async () => {
    writeFileSync(join(outside, 'x.txt'), 'old outside');
    symlinkSync(outside, join(ws, 'sub'));
    await expect(run({ directory: join(ws, 'sub'), find: 'old', replace: 'new' })).rejects.toThrow(/sub is a symlink/);
    const below = await run({ find: 'old', replace: 'new' });
    expect(below).toMatch(/No files matching/);
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('old outside');
  });

  it('skips a link at a file and a FIFO, and refuses a file with a second name', async () => {
    writeFileSync(join(outside, 'target.txt'), 'old target');
    symlinkSync(join(outside, 'target.txt'), join(ws, 'link.txt'));
    execFileSync('mkfifo', [join(ws, 'pipe.txt')]);
    linkSync(join(outside, 'target.txt'), join(ws, 'hard.txt'));
    const out = await run({ find: 'old', replace: 'new' });
    expect(out).toMatch(/hard\.txt: .*more than one name/);
    expect(out).not.toContain('link.txt');
    expect(out).not.toContain('pipe.txt');
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('old target');
  });

  it('refuses to read a file with a second name, also when nothing in it would change', async () => {
    writeFileSync(join(outside, 'other.txt'), 'nothing to find');
    linkSync(join(outside, 'other.txt'), join(ws, 'hard.txt'));
    expect(await run({ find: 'old', replace: 'new' })).toMatch(/hard\.txt: it has more than one name/);
  });

  it('skips a file over the size limit, and names an unreadable file by its workspace path', async () => {
    execFileSync('truncate', ['-s', String(10 * 1024 * 1024 + 1), join(ws, 'big.txt')]);
    writeFileSync(join(ws, 'locked.txt'), 'old');
    chmodSync(join(ws, 'locked.txt'), 0o000);
    const out = await run({ find: 'old', replace: 'new' });
    expect(out).toContain(`Skipped (too large): ${join(ws, 'big.txt')}`);
    if (process.getuid?.() !== 0) expect(out).toContain(`Error transforming ${join(ws, 'locked.txt')}: EACCES: permission denied: ${join(ws, 'locked.txt')}`);
    expect(out).not.toMatch(/\/proc\//);
  });

  it('renames within the workspace, also one level up, and refuses a name that leaves it', async () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'r.txt'), 'r');
    const up = await run({ directory: join(ws, 'sub'), operation: 'rename', rename_pattern: '../$1-up.txt' });
    expect(up).toContain('r.txt → ../r-up.txt');
    expect(readFileSync(join(ws, 'r-up.txt'), 'utf8')).toBe('r');
    const out = await run({ operation: 'rename', rename_pattern: `../${'../'.repeat(8)}tmp/lynox-batch-esc-$1.txt` });
    expect(out).toMatch(/leaves the workspace/);
    expect(existsSync(join(ws, 'r-up.txt'))).toBe(true);
  });

  it('moves within the workspace, making the destination with the umask\'s mode', async () => {
    writeFileSync(join(ws, 'm.txt'), 'm');
    const before = process.umask(0o027);
    let out: string;
    try {
      out = await run({ operation: 'move', destination: join(ws, 'into', 'deep') });
    } finally {
      process.umask(before);
    }
    expect(out).toContain(`${join(ws, 'm.txt')} → ${join(ws, 'into', 'deep', 'm.txt')}`);
    expect(readFileSync(join(ws, 'into', 'deep', 'm.txt'), 'utf8')).toBe('m');
    expect(statSync(join(ws, 'into')).mode & 0o777).toBe(0o750);
  });

  it('refuses a move out of the workspace, or into it from outside, and leaves the files', async () => {
    writeFileSync(join(ws, 'stay.txt'), 's');
    expect(await run({ operation: 'move', destination: outside })).toMatch(/outside the workspace/);
    expect(existsSync(join(ws, 'stay.txt'))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);

    writeFileSync(join(outside, 'o.txt'), 'o');
    expect(await run({ directory: outside, operation: 'move', destination: join(ws, 'in') })).toMatch(/is in the workspace, the directory is not/);
    expect(existsSync(join(outside, 'o.txt'))).toBe(true);
    expect(existsSync(join(ws, 'in'))).toBe(false);
  });

  it('refuses a move through a link at the destination, and leaves the files', async () => {
    writeFileSync(join(ws, 'f.txt'), 'f');
    symlinkSync(outside, join(ws, 'dest'));
    expect(await run({ operation: 'move', destination: join(ws, 'dest') })).toMatch(/dest is a symlink/);
    expect(existsSync(join(ws, 'f.txt'))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses an outside directory that reaches the workspace through a link, and a rename from outside into it', async () => {
    writeFileSync(join(ws, 'w.txt'), 'old w');
    symlinkSync(ws, join(outside, 'to-ws'));
    await expect(run({ directory: join(outside, 'to-ws'), find: 'old', replace: 'new' })).rejects.toThrow(/reaches the workspace through a link/);
    expect(readFileSync(join(ws, 'w.txt'), 'utf8')).toBe('old w');

    mkdirSync(join(outside, 'src'));
    writeFileSync(join(outside, 'src', 'q.txt'), 'q');
    const rel = `../../${ws.slice(1).split('/').map(() => '..').join('/')}${ws}/landed-$1.txt`;
    const out = await run({ directory: join(outside, 'src'), operation: 'rename', rename_pattern: rel });
    expect(out).toMatch(/lands in the workspace/);
    expect(existsSync(join(ws, 'landed-q.txt'))).toBe(false);
    // A destination that reaches the workspace only through a link.
    symlinkSync(ws, join(outside, 'ws-link'));
    expect(await run({ directory: join(outside, 'src'), operation: 'move', destination: join(outside, 'ws-link', 'in') })).toMatch(/is in the workspace, the directory is not/);
    expect(existsSync(join(ws, 'in'))).toBe(false);
    // The control: an outside directory is still batch_files' to work on.
    expect(await run({ directory: join(outside, 'src'), find: 'q', replace: 'Q' })).toContain('Transformed');
  });

  it('refuses an outside directory that holds the workspace', async () => {
    // A workspace inside a directory batch_files may work on (here under /tmp).
    const nested = join(outside, 'ws');
    mkdirSync(nested);
    writeFileSync(join(nested, 'n.txt'), 'old n');
    closeWorkspaceBase();
    setTenantWorkspace(nested);
    await expect(run({ directory: outside, find: 'old', replace: 'new' })).rejects.toThrow(/holds the workspace/);
    expect(readFileSync(join(nested, 'n.txt'), 'utf8')).toBe('old n');
  });

  it('refuses a directory named through /proc', async () => {
    await expect(run({ directory: `/proc/self/root${ws}` })).rejects.toThrow(/process handle/);
  });

  it('names the workspace path in its errors, never the fd path', async () => {
    writeFileSync(join(ws, 'ro.txt'), 'old');
    chmodSync(join(ws, 'ro.txt'), 0o444);
    const out = await run({ find: 'old', replace: 'new' });
    if (process.getuid?.() !== 0) expect(out).toContain(`EACCES: permission denied: ${join(ws, 'ro.txt')}`);
    expect(out).not.toMatch(/\/proc\//);
  });
});
