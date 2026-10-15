import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * media_process with isolation reaches its input and output through the context workspace's open
 * directory. ffmpeg is stood in for: the stand-in writes its input's bytes to a new output file,
 * so what lands in the workspace is exactly what the tool read.
 */
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
const h = vi.hoisted(() => ({ spawns: 0, reads: 0, onFirstRead: null as null | (() => void) }));

// readSync is counted, and can run a step at the first read: the moment between the size check
// on the open file and the copy, which no static setup reaches.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      if (h.reads++ === 0 && h.onFirstRead) h.onFirstRead();
      return actual.readSync(...args);
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    execFile: (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      h.spawns++;
      const input = args[args.indexOf('-i') + 1]!;
      // A new file, as ffmpeg makes it: mode from the umask, not from the input.
      fs.writeFileSync(args[args.length - 1]!, fs.readFileSync(input));
      cb(null, '', '');
      return {};
    },
  };
});

const { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { mediaProcessTool } = await import('./media-process.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('../../core/workspace.js');
const { closeWorkspaceBase } = await import('../../core/workspace-rel.js');

let ws: string;
let outside: string;

beforeEach(() => {
  h.spawns = 0;
  h.reads = 0;
  h.onFirstRead = null;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-media-ws-')));
  outside = realpathSync(mkdtempSync('/tmp/lynox-media-out-'));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const run = (input: string): Promise<string> =>
  mediaProcessTool.handler({ operation: 'transcode', input, format: 'mp4' }, {} as never);

const landed = (): string[] => readdirSync(ws).filter((n) => n.startsWith('media_'));

describe('media_process reaches the files area through its open directory', () => {
  it('reads the input and writes the output in the workspace, with the umask\'s mode', async () => {
    mkdirSync(join(ws, 'clips'));
    writeFileSync(join(ws, 'clips', 'a.mov'), Buffer.from([0, 1, 2, 255, 254]));
    const before = process.umask(0o027);
    let out: string;
    try {
      out = await run('clips/a.mov');
    } finally {
      process.umask(before);
    }
    expect(out).toMatch(/Saved to your files area as "media_\d+_[0-9a-f]{8}\.mp4"/);
    const [name] = landed();
    expect(name).toBeDefined();
    expect(readFileSync(join(ws, name!))).toEqual(Buffer.from([0, 1, 2, 255, 254]));
    expect(statSync(join(ws, name!)).mode & 0o777).toBe(0o640);
    // The same file named by its absolute workspace path.
    await run(join(ws, 'clips', 'a.mov'));
    expect(landed()).toHaveLength(2);
  });

  it('resolves a relative input against the files area, not the working directory', async () => {
    writeFileSync(join(ws, 'rel.mov'), 'in ws');
    const cwd = process.cwd();
    process.chdir(outside);
    try {
      writeFileSync(join(outside, 'rel.mov'), 'in cwd');
      await run('rel.mov');
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(ws, landed()[0]!), 'utf8')).toBe('in ws');
  });

  it('refuses a link at the input or on the way, before ffmpeg runs', async () => {
    writeFileSync(join(outside, 'secret.mov'), 'outside');
    symlinkSync(join(outside, 'secret.mov'), join(ws, 'leaf.mov'));
    symlinkSync(outside, join(ws, 'dir'));
    await expect(run('leaf.mov')).rejects.toThrow(/leaf\.mov is a symlink/);
    await expect(run('dir/secret.mov')).rejects.toThrow(/dir is a symlink/);
    expect(h.spawns).toBe(0);
    expect(landed()).toEqual([]);
  });

  it('refuses an input with a second name, before ffmpeg runs', async () => {
    writeFileSync(join(outside, 'target.mov'), 'outside');
    linkSync(join(outside, 'target.mov'), join(ws, 'hard.mov'));
    await expect(run('hard.mov')).rejects.toThrow(/more than one name/);
    expect(h.spawns).toBe(0);
  });

  it('refuses a FIFO as the input without blocking, a directory, and the files area itself', async () => {
    execFileSync('mkfifo', [join(ws, 'pipe.mov')]);
    mkdirSync(join(ws, 'adir.mov'));
    for (const input of ['pipe.mov', 'adir.mov', '.', ws]) {
      await expect(run(input), input).rejects.toThrow(/^input is not a regular file\.$/);
    }
    expect(h.spawns).toBe(0);
  });

  it('refuses an input over the size limit, before ffmpeg runs', async () => {
    // Sparse: the size is what the open file says, not bytes on disk.
    execFileSync('truncate', ['-s', String(100 * 1024 * 1024 + 1), join(ws, 'big.mov')]);
    await expect(run('big.mov')).rejects.toThrow(/input is too large \(max 100 MB\)/);
    // Refused by the open file's size, before a byte is copied.
    expect(h.reads).toBe(0);
    expect(h.spawns).toBe(0);
    expect(landed()).toEqual([]);
  });

  it('stops copying an input that grows past the size limit after the size check', async () => {
    writeFileSync(join(ws, 'grow.mov'), 'small');
    h.onFirstRead = () => execFileSync('truncate', ['-s', String(100 * 1024 * 1024 + 1), join(ws, 'grow.mov')]);
    await expect(run('grow.mov')).rejects.toThrow(/input is too large \(max 100 MB\)/);
    expect(h.reads).toBeGreaterThan(1);
    expect(h.spawns).toBe(0);
    expect(landed()).toEqual([]);
  });

  it('refuses an input outside the files area, also through /proc', async () => {
    writeFileSync(join(outside, 'o.mov'), 'o');
    await expect(run(join(outside, 'o.mov'))).rejects.toThrow(/outside your files area/);
    await expect(run(`/proc/self/root${ws}/x.mov`)).rejects.toThrow(/process handle/);
    await expect(run('../x.mov')).rejects.toThrow(/outside your files area/);
    expect(h.spawns).toBe(0);
  });

  it('says a missing input is missing, and names no fd path in an error', async () => {
    await expect(run('none.mov')).rejects.toThrow('input file not found in your files area: none.mov');
    writeFileSync(join(ws, 'locked.mov'), 'x');
    chmodSync(join(ws, 'locked.mov'), 0o000);
    if (process.getuid?.() !== 0) {
      const err = await run('locked.mov').then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toBe(`EACCES: permission denied: ${join(ws, 'locked.mov')}`);
    }
    expect(existsSync(join(ws, 'locked.mov'))).toBe(true);
  });
});
