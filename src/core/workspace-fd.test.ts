import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  closeAnchor, copyIn, copyOut, emptyDir, ensureSubAnchor, listDir, mkdirAt, mountIdOf, openAnchor,
  readFileAt, renameAt, splitRel, statEntry, walk, writeFileAt, WorkspaceAccessError, type WorkspaceAnchor,
} from './workspace-fd.js';

vi.setConfig({ testTimeout: 60_000 });

const LINUX = process.platform === 'linux';

let root: string;
let ws: string;
let outside: string;
let anchor: WorkspaceAnchor;

function code(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (err) {
    if (err instanceof WorkspaceAccessError) return err.code;
    return (err as NodeJS.ErrnoException).code ?? 'unknown';
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsfd-'));
  ws = join(root, 'ws');
  outside = join(root, 'engine');
  mkdirSync(ws);
  mkdirSync(join(outside, 'private'), { recursive: true });
  writeFileSync(join(outside, 'private', 'real.js'), 'PRIVATE');
  writeFileSync(join(outside, 'secret'), 'OUTSIDE');
  anchor = openAnchor(ws);
});

afterEach(() => {
  closeAnchor(anchor);
  rmSync(root, { recursive: true, force: true });
});

describe('splitRel', () => {
  it.each(['/abs', 'a/../b', '..', './a', 'a//b', 'a/./b', 'a\0b', 'a\\b'])('refuses %j', (rel) => {
    expect(code(() => splitRel(rel))).toBe('BAD_PATH');
  });
  it('splits a plain path and tolerates one trailing slash', () => {
    expect(splitRel('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(splitRel('a/b/')).toEqual(['a', 'b']);
    expect(splitRel('')).toEqual([]);
  });
});

describe('reading', () => {
  it('reads a regular file below the anchor (control)', () => {
    mkdirSync(join(ws, 'd'));
    writeFileSync(join(ws, 'd', 'f.txt'), 'inside');
    expect(readFileAt(anchor, 'd/f.txt').toString()).toBe('inside');
  });
  it('refuses a symlink at the leaf', () => {
    symlinkSync(join(outside, 'secret'), join(ws, 'leak'));
    expect(code(() => readFileAt(anchor, 'leak'))).toBe('SYMLINK');
  });
  it('refuses a symlinked intermediate directory', () => {
    symlinkSync(outside, join(ws, 'd'));
    expect(code(() => readFileAt(anchor, 'd/secret'))).toBe('SYMLINK');
  });
  it('refuses a FIFO without blocking', () => {
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    expect(code(() => readFileAt(anchor, 'pipe'))).toBe('NOT_FILE');
  });
  it('refuses a file over the byte limit', () => {
    writeFileSync(join(ws, 'big'), 'x'.repeat(100));
    expect(code(() => readFileAt(anchor, 'big', 99))).toBe('LIMIT');
    expect(readFileAt(anchor, 'big', 100).length).toBe(100);
  });
});

describe('writing', () => {
  it('creates directories with the given mode and the file with its mode', () => {
    writeFileAt(anchor, 'a/b/f.txt', 'hello', { fileMode: 0o640, dirMode: 0o750 });
    expect(readFileSync(join(ws, 'a/b/f.txt'), 'utf8')).toBe('hello');
    expect(statSync(join(ws, 'a/b/f.txt')).mode & 0o7777).toBe(0o640);
    expect(statSync(join(ws, 'a')).mode & 0o7777).toBe(0o750);
    expect(statSync(join(ws, 'a/b')).mode & 0o7777).toBe(0o750);
  });
  it('without dirMode a missing directory is an error, not created', () => {
    expect(code(() => writeFileAt(anchor, 'nope/f', 'x', { fileMode: 0o600 }))).toBe('ENOENT');
    expect(existsSync(join(ws, 'nope'))).toBe(false);
  });
  it('replaces a symlink at the target instead of writing through it', () => {
    symlinkSync(join(outside, 'secret'), join(ws, 'f'));
    writeFileAt(anchor, 'f', 'new', { fileMode: 0o600 });
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('OUTSIDE');
    expect(lstatSync(join(ws, 'f')).isFile()).toBe(true);
    expect(readFileSync(join(ws, 'f'), 'utf8')).toBe('new');
  });
  it('refuses to write through a symlinked intermediate directory', () => {
    symlinkSync(join(outside, 'private'), join(ws, 'inbox'));
    expect(code(() => writeFileAt(anchor, 'inbox/x.js', 'x', { fileMode: 0o600, dirMode: 0o700 }))).toBe('SYMLINK');
    expect(readdirSync(join(outside, 'private'))).toEqual(['real.js']);
  });
  it('refuses a directory at the target and leaves no temp file', () => {
    mkdirSync(join(ws, 'dir'));
    expect(code(() => writeFileAt(anchor, 'dir', 'x', { fileMode: 0o600 }))).toBe('NOT_FILE');
    expect(readdirSync(ws)).toEqual(['dir']);
  });
});

describe('ensureSubAnchor', () => {
  it('creates the context directory with the mode and opens it', () => {
    const ctx = ensureSubAnchor(anchor, 'http-api', 0o750);
    try {
      writeFileAt(ctx, 'f', 'x', { fileMode: 0o600 });
      expect(readFileSync(join(ws, 'http-api', 'f'), 'utf8')).toBe('x');
      expect(statSync(join(ws, 'http-api')).mode & 0o7777).toBe(0o750);
    } finally {
      closeAnchor(ctx);
    }
  });
  it('refuses a symlink planted at the context name', () => {
    symlinkSync(join(outside, 'private'), join(ws, 'http-api'));
    expect(code(() => ensureSubAnchor(anchor, 'http-api', 0o700))).toBe('SYMLINK');
  });
  it('keeps pointing at the opened directory after the name is swapped', () => {
    const ctx = ensureSubAnchor(anchor, 'c', 0o700);
    try {
      execFileSync('mv', [join(ws, 'c'), join(ws, 'c-moved')]);
      symlinkSync(outside, join(ws, 'c'));
      writeFileAt(ctx, 'x', 'y', { fileMode: 0o600 });
      expect(existsSync(join(ws, 'c-moved', 'x'))).toBe(true);
      expect(existsSync(join(outside, 'x'))).toBe(false);
    } finally {
      closeAnchor(ctx);
    }
  });
});

describe('single-entry operations', () => {
  it('statEntry reports a symlink without following it; null when absent', () => {
    symlinkSync(outside, join(ws, 'l'));
    expect(statEntry(anchor, 'l')?.type).toBe('symlink');
    expect(statEntry(anchor, 'missing')).toBeNull();
  });
  it('listDir lists without following', () => {
    mkdirSync(join(ws, 'd'));
    symlinkSync(outside, join(ws, 'l'));
    writeFileSync(join(ws, 'f'), '1');
    const byName = Object.fromEntries(listDir(anchor, '').map((e) => [e.name, e.type]));
    expect(byName).toEqual({ d: 'dir', l: 'symlink', f: 'file' });
  });
  it('renameAt moves within the anchor; a symlinked target dir is refused', () => {
    writeFileSync(join(ws, 'a'), '1');
    mkdirSync(join(ws, 'sub'));
    renameAt(anchor, 'a', 'sub/b');
    expect(readFileSync(join(ws, 'sub', 'b'), 'utf8')).toBe('1');
    symlinkSync(outside, join(ws, 'out'));
    expect(code(() => renameAt(anchor, 'sub/b', 'out/b'))).toBe('SYMLINK');
    expect(existsSync(join(outside, 'b'))).toBe(false);
  });
  it('mkdirAt refuses to create below a symlink', () => {
    symlinkSync(outside, join(ws, 'l'));
    expect(code(() => mkdirAt(anchor, 'l/new', 0o700))).toBe('SYMLINK');
    expect(existsSync(join(outside, 'new'))).toBe(false);
  });
});

describe('walk', () => {
  beforeEach(() => {
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'a', 'f1'), '123');
    writeFileSync(join(ws, 'a', 'b', 'f2'), '45');
    symlinkSync(outside, join(ws, 'a', 'link'));
  });
  it('lists every entry, sums the bytes, reports links without following them', () => {
    const r = walk(anchor, '');
    expect(r.entries.map((e) => `${e.rel}:${e.type}`).sort()).toEqual(['a/b/f2:file', 'a/b:dir', 'a/f1:file', 'a/link:symlink', 'a:dir'].sort());
    expect([r.files, r.dirs, r.symlinks, r.bytes]).toEqual([2, 2, 1, 5]);
    expect(r.entries.some((e) => e.rel.includes('secret'))).toBe(false);
  });
  it.each([
    [{ maxDepth: 1, maxEntries: 100, maxBytes: 100 }],
    [{ maxDepth: 10, maxEntries: 3, maxBytes: 100 }],
    [{ maxDepth: 10, maxEntries: 100, maxBytes: 4 }],
  ])('throws on a limit instead of truncating (%j)', (limits) => {
    expect(code(() => walk(anchor, '', limits))).toBe('LIMIT');
  });
  it.runIf(LINUX)('reads a mount id for an open fd', () => {
    expect(typeof mountIdOf(anchor.fd)).toBe('number');
  });
});

describe('copyOut', () => {
  it('hands every regular file to the sink and skips links and FIFOs', () => {
    mkdirSync(join(ws, 'd'));
    writeFileSync(join(ws, 'd', 'f'), 'data');
    symlinkSync(join(outside, 'secret'), join(ws, 'd', 'l'));
    execFileSync('mkfifo', [join(ws, 'd', 'p')]);
    const got: Record<string, string> = {};
    const r = copyOut(anchor, '', (rel, fd, size) => {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      got[rel] = buf.toString();
    });
    expect(got).toEqual({ 'd/f': 'data' });
    expect(r.skipped.sort()).toEqual(['d/l', 'd/p']);
    expect([r.files, r.dirs, r.bytes]).toEqual([1, 1, 4]);
  });
});

describe('copyIn', () => {
  let src: string;
  beforeEach(() => {
    src = join(root, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'sub', 'f'), 'restored');
  });
  it('overlays: replaces existing files, keeps others, applies the modes', () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'f'), 'old');
    writeFileSync(join(ws, 'keep'), 'mine');
    writeFileSync(join(src, 'new'), 'n');
    const r = copyIn(anchor, '', src, { fileMode: 0o640, dirMode: 0o750 });
    expect(readFileSync(join(ws, 'sub', 'f'), 'utf8')).toBe('restored');
    expect(readFileSync(join(ws, 'keep'), 'utf8')).toBe('mine');
    expect(statSync(join(ws, 'new')).mode & 0o7777).toBe(0o640);
    expect([r.files, r.dirs]).toEqual([2, 1]);
  });
  it('refuses symlinks in the source and counts them', () => {
    symlinkSync(join(outside, 'secret'), join(src, 'l'));
    const r = copyIn(anchor, '', src, { fileMode: 0o600, dirMode: 0o700 });
    expect(r.skipped).toEqual(['l']);
    expect(existsSync(join(ws, 'l'))).toBe(false);
  });
  it('does not write through a symlink the workspace already holds', () => {
    symlinkSync(outside, join(ws, 'sub'));
    expect(code(() => copyIn(anchor, '', src, { fileMode: 0o600, dirMode: 0o700 }))).toBe('SYMLINK');
    expect(existsSync(join(outside, 'f'))).toBe(false);
  });
});

describe('emptyDir', () => {
  it('removes everything below, keeps the directory, never follows a link', () => {
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'a', 'b', 'f'), '1');
    symlinkSync(outside, join(ws, 'a', 'link'));
    const r = emptyDir(anchor, '');
    expect(r.removed).toBe(4);
    expect(readdirSync(ws)).toEqual([]);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('OUTSIDE');
    expect(readdirSync(join(outside, 'private'))).toEqual(['real.js']);
  });
  it.runIf(process.getuid?.() !== 0)('throws REMAINDER when an entry cannot be removed', () => {
    mkdirSync(join(ws, 'locked'));
    writeFileSync(join(ws, 'locked', 'f'), '1');
    chmodSync(join(ws, 'locked'), 0o500);
    try {
      expect(code(() => emptyDir(anchor, ''))).toBe('REMAINDER');
    } finally {
      chmodSync(join(ws, 'locked'), 0o700);
    }
  });
});

/**
 * The race the primitive exists for: a second process flips `d` between a real
 * directory and a symlink to the engine's files while the engine reads and writes
 * `d/...`. The positive control runs the same loop by name and must catch the
 * outside content at least once — otherwise the race never opened and the
 * primitive's zero would prove nothing.
 */
describe.runIf(LINUX)('race against a second process', () => {
  let swapper: ChildProcess;
  const SWAP = `
    const fs = require('fs'), p = require('path'), ws = process.argv[1];
    const d = p.join(ws, 'd'), real = p.join(ws, 'd.real'), link = p.join(ws, 'd.link');
    for (;;) {
      try { fs.renameSync(real, d); fs.renameSync(d, real); fs.renameSync(link, d); fs.renameSync(d, link); } catch {}
    }`;

  beforeEach(async () => {
    mkdirSync(join(ws, 'd.real'));
    writeFileSync(join(ws, 'd.real', 'secret'), 'inside');
    symlinkSync(outside, join(ws, 'd.link'));
    swapper = spawn(process.execPath, ['-e', SWAP, ws], { stdio: 'ignore' });
    await sleep(200);
  });
  afterEach(() => {
    swapper.kill('SIGKILL');
  });

  it('reads never return the outside file; reading by name does (control)', () => {
    let byNameLeaks = 0;
    let primitiveLeaks = 0;
    for (let i = 0; i < 20000; i++) {
      try { if (readFileSync(join(ws, 'd', 'secret'), 'utf8') === 'OUTSIDE') byNameLeaks++; } catch { /* mid-swap */ }
      try { if (readFileAt(anchor, 'd/secret').toString() === 'OUTSIDE') primitiveLeaks++; } catch { /* refused or mid-swap */ }
    }
    expect(byNameLeaks).toBeGreaterThan(0);
    expect(primitiveLeaks).toBe(0);
  });

  it('writes never land outside; writing by name does (control)', () => {
    for (let i = 0; i < 5000; i++) {
      try { writeFileSync(join(ws, 'd', `n${i}`), 'x'); } catch { /* mid-swap */ }
      try { writeFileAt(anchor, `d/w${i}`, 'x', { fileMode: 0o600 }); } catch { /* refused or mid-swap */ }
    }
    const landed = readdirSync(outside);
    expect(landed.filter((n) => n.startsWith('n')).length).toBeGreaterThan(0);
    expect(landed.filter((n) => n.startsWith('w'))).toEqual([]);
  });
});

it.runIf(LINUX)('an O_PATH anchor survives a parent the process can no longer traverse', () => {
  const parent = join(root, 'p');
  mkdirSync(join(parent, 'w'), { recursive: true });
  const a = openAnchor(join(parent, 'w'));
  try {
    chmodSync(parent, 0o000);
    writeFileAt(a, 'f', 'via fd', { fileMode: 0o600 });
    expect(listDir(a, '').map((e) => e.name)).toEqual(['f']);
  } finally {
    chmodSync(parent, 0o700);
    closeSync(a.fd);
  }
});
