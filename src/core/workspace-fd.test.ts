import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  anchorFromFd, closeAnchor, copyOut, emptyDir, ensureSubAnchor, listDir, mkdirAt, mountIdOf, openAnchor, stageIn, STAGE_PREFIX,
  readFileAt, removeStaleStages, renameAt, splitRel, statEntry, walk, writeFileAt, WorkspaceAccessError, type WorkspaceAnchor,
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
  it('names an absolute path as such, for callers that pass one by mistake', () => {
    expect(() => splitRel('/proc/self/fd/3/x')).toThrow(/absolute path refused/);
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
  it('takes exactly one component', () => {
    expect(code(() => ensureSubAnchor(anchor, 'a/b', 0o700))).toBe('BAD_PATH');
    expect(existsSync(join(ws, 'a'))).toBe(false);
  });
  it('anchorFromFd refuses a file descriptor that is not a directory', () => {
    writeFileSync(join(ws, 'f'), '1');
    const fd = openSync(join(ws, 'f'), 'r');
    try {
      expect(code(() => anchorFromFd(fd, 'f'))).toBe('NOT_DIR');
    } finally {
      closeSync(fd);
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
  it('skips a unix socket without trying to open it', () => {
    const sock = join(ws, 's');
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
    expect(lstatSync(sock).isSocket()).toBe(true);
    const r = copyOut(anchor, '', () => { /* nothing to copy */ });
    expect(r.skipped).toEqual(['s']);
  });
  it.runIf(process.getuid?.() !== 0)('fails on an unreadable file instead of leaving it out', () => {
    writeFileSync(join(ws, 'hidden'), 'x');
    chmodSync(join(ws, 'hidden'), 0o000);
    expect(code(() => copyOut(anchor, '', () => { /* sink */ }))).toBe('EACCES');
  });
});

describe('stageIn', () => {
  const MODES = { fileMode: 0o640, dirMode: 0o750 };
  const leftovers = (): string[] => walk(anchor, '').entries.map((e) => e.rel).filter((r) => r.includes(STAGE_PREFIX));
  beforeEach(() => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'f'), 'old');
    writeFileSync(join(ws, 'keep'), 'mine');
  });
  it('leaves the targets alone until commit, then overlays with the modes', () => {
    const s = stageIn(anchor, '', [{ rel: 'sub/f', data: 'restored' }, { rel: 'new/n', data: 'n' }], MODES);
    expect(readFileSync(join(ws, 'sub', 'f'), 'utf8')).toBe('old');
    expect(existsSync(join(ws, 'new', 'n'))).toBe(false);
    expect([s.files, s.bytes]).toEqual([2, 9]);
    s.commit();
    expect(readFileSync(join(ws, 'sub', 'f'), 'utf8')).toBe('restored');
    expect(readFileSync(join(ws, 'keep'), 'utf8')).toBe('mine');
    expect(statSync(join(ws, 'new', 'n')).mode & 0o7777).toBe(0o640);
    expect(statSync(join(ws, 'new')).mode & 0o7777).toBe(0o750);
    expect(leftovers()).toEqual([]);
  });
  it('abort removes every staged file and changes no target', () => {
    const s = stageIn(anchor, '', [{ rel: 'sub/f', data: 'restored' }, { rel: 'keep', data: 'x' }], MODES);
    expect(leftovers().length).toBe(2);
    s.abort();
    expect(leftovers()).toEqual([]);
    expect(readFileSync(join(ws, 'sub', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(ws, 'keep'), 'utf8')).toBe('mine');
  });
  it('fails in the staging phase on a directory at a target, and leaves nothing staged', () => {
    mkdirSync(join(ws, 'isdir'));
    expect(code(() => stageIn(anchor, '', [{ rel: 'keep', data: 'x' }, { rel: 'isdir', data: 'y' }], MODES))).toBe('NOT_FILE');
    expect(leftovers()).toEqual([]);
    expect(readFileSync(join(ws, 'keep'), 'utf8')).toBe('mine');
  });
  it('removeStaleStages removes left-over temps of that exact shape and nothing else', () => {
    const stale = `${STAGE_PREFIX}${'a'.repeat(24)}`;
    writeFileSync(join(ws, 'sub', stale), 'x');
    writeFileSync(join(ws, `${STAGE_PREFIX}notmine`), 'y');
    mkdirSync(join(ws, `${STAGE_PREFIX}${'b'.repeat(24)}`));
    expect(removeStaleStages(anchor, '')).toBe(1);
    expect(existsSync(join(ws, 'sub', stale))).toBe(false);
    expect(existsSync(join(ws, `${STAGE_PREFIX}notmine`))).toBe(true);
    expect(existsSync(join(ws, `${STAGE_PREFIX}${'b'.repeat(24)}`))).toBe(true);
  });
  it('is not blocked by entries another writer planted with the temp shape', () => {
    for (let i = 0; i < 5; i++) mkdirSync(join(ws, 'sub', `${STAGE_PREFIX}${String(i).repeat(24)}`));
    stageIn(anchor, '', [{ rel: 'sub/f', data: 'restored' }], MODES).commit();
    expect(readFileSync(join(ws, 'sub', 'f'), 'utf8')).toBe('restored');
  });
  it.each([
    [['a', 'a/b']],
    [['a/b', 'a']],
  ])('refuses a path that is both a file and a directory (%j)', (rels) => {
    expect(code(() => stageIn(anchor, '', rels.map((rel) => ({ rel, data: 'x' })), MODES))).toBe('BAD_PATH');
    expect(leftovers()).toEqual([]);
  });
  it('a failed commit says how far it got and leaves no temps', () => {
    const s = stageIn(anchor, '', [{ rel: 'one', data: '1' }, { rel: 'two', data: '2' }], MODES);
    mkdirSync(join(ws, 'two'));
    expect(code(() => s.commit())).toBe('PARTIAL');
    expect(readFileSync(join(ws, 'one'), 'utf8')).toBe('1');
    expect(leftovers()).toEqual([]);
  });
  it('refuses the same path twice', () => {
    expect(code(() => stageIn(anchor, '', [{ rel: 'keep', data: 'a' }, { rel: 'keep', data: 'b' }], MODES))).toBe('BAD_PATH');
    expect(leftovers()).toEqual([]);
  });
  it('refuses a symlinked directory on the way and writes nothing outside', () => {
    symlinkSync(outside, join(ws, 'out'));
    expect(code(() => stageIn(anchor, '', [{ rel: 'out/f', data: 'x' }], MODES))).toBe('SYMLINK');
    expect(readdirSync(outside).sort()).toEqual(['private', 'secret']);
  });
  it('commit replaces a symlink at the target instead of writing through it', () => {
    symlinkSync(join(outside, 'secret'), join(ws, 'link'));
    stageIn(anchor, '', [{ rel: 'link', data: 'mine now' }], MODES).commit();
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('OUTSIDE');
    expect(lstatSync(join(ws, 'link')).isFile()).toBe(true);
  });
  it('commits only once', () => {
    const s = stageIn(anchor, '', [{ rel: 'keep', data: 'x' }], MODES);
    s.commit();
    expect(() => s.commit()).toThrow(/already/);
  });
});

describe.runIf(LINUX)('names that are not UTF-8', () => {
  const raw = (): Buffer => Buffer.concat([Buffer.from(`${ws}/`), Buffer.from([0x66, 0xff])]);
  beforeEach(() => { writeFileSync(raw(), 'bytes'); writeFileSync(join(ws, 'normal'), 'n'); });
  it('copyOut never copies another file under the lossy name', () => {
    writeFileSync(join(ws, 'f\uFFFD'), 'real');
    const copied: string[] = [];
    copyOut(anchor, '', (rel) => { copied.push(rel); });
    expect(copied.sort()).toEqual(['f\uFFFD', 'normal']);
  });
  it('are listed as not exact, skipped by copyOut, and removed by emptyDir', () => {
    const odd = listDir(anchor, '').find((e) => !e.exactName);
    expect(odd?.type).toBe('file');
    expect(walk(anchor, '').entries.filter((e) => !e.exactName).length).toBe(1);
    const copied: string[] = [];
    const r = copyOut(anchor, '', (rel) => { copied.push(rel); });
    expect(copied).toEqual(['normal']);
    expect(r.skipped.length).toBe(1);
    emptyDir(anchor, '');
    expect(readdirSync(ws)).toEqual([]);
  });
});

describe('emptyDir depth', () => {
  it('refuses a tree deeper than maxDepth before deleting anything', () => {
    mkdirSync(join(ws, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(join(ws, 'keep'), '1');
    expect(code(() => emptyDir(anchor, '', 3))).toBe('LIMIT');
    expect(existsSync(join(ws, 'keep'))).toBe(true);
    expect(emptyDir(anchor, '', 4).removed).toBe(5);
  });
  it('empties a tree deeper than the default walk depth of old', () => {
    let p = ws;
    for (let i = 0; i < 100; i++) { p = join(p, 'd'); mkdirSync(p); }
    writeFileSync(join(p, 'f'), '1');
    emptyDir(anchor, '');
    expect(readdirSync(ws)).toEqual([]);
  });
});

it('readFileAt refuses a socket as not a regular file', () => {
  const sock = join(ws, 's');
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
  expect(code(() => readFileAt(anchor, 's'))).toBe('NOT_FILE');
});

/**
 * Ordinary activity in the tree must not break a walk, and a file that keeps
 * growing must not get past the byte limit of a read.
 */
describe.runIf(LINUX)('concurrent writers', () => {
  let churn: ChildProcess;
  afterEach(() => { churn.kill('SIGKILL'); });
  it('walk and copyOut survive files appearing and vanishing', async () => {
    mkdirSync(join(ws, 'c'));
    churn = spawn(process.execPath, ['-e', `
      const fs = require('fs'), d = process.argv[1];
      for (let i = 0;; i++) { const f = d + '/t' + (i % 50); try { fs.mkdirSync(f + 'd'); fs.writeFileSync(f, 'x'); fs.rmdirSync(f + 'd'); fs.unlinkSync(f); } catch {} }`, join(ws, 'c')], { stdio: 'ignore' });
    await sleep(200);
    const failures: string[] = [];
    for (let i = 0; i < 300; i++) {
      const c = code(() => { walk(anchor, ''); copyOut(anchor, '', () => { /* sink */ }); });
      if (c !== 'ok') failures.push(c);
    }
    expect(failures).toEqual([]);
  });
  it('readFileAt never returns more than maxBytes from a growing file', async () => {
    writeFileSync(join(ws, 'grow'), '');
    churn = spawn(process.execPath, ['-e', `
      const fs = require('fs'), f = process.argv[1], b = Buffer.alloc(65536, 120);
      for (;;) { try { fs.truncateSync(f, 0); for (let i = 0; i < 64; i++) fs.appendFileSync(f, b); } catch {} }`, join(ws, 'grow')], { stdio: 'ignore' });
    await sleep(200);
    let largest = 0;
    for (let i = 0; i < 300; i++) {
      try { largest = Math.max(largest, readFileAt(anchor, 'grow', 1000).length); } catch { /* LIMIT */ }
    }
    expect(largest).toBeLessThanOrEqual(1000);
  });
});

describe.runIf(LINUX)('a removed anchor', () => {
  it('refuses every operation instead of seeing an empty tree', () => {
    const gone = join(root, 'gone');
    mkdirSync(gone);
    const a = openAnchor(gone);
    try {
      rmSync(gone, { recursive: true });
      expect(code(() => walk(a, ''))).toBe('GONE');
      expect(code(() => listDir(a, ''))).toBe('GONE');
      expect(code(() => statEntry(a, ''))).toBe('GONE');
      expect(code(() => emptyDir(a, ''))).toBe('GONE');
    } finally {
      closeAnchor(a);
    }
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

describe('walk — watching for a directory by identity', () => {
  it('names every directory that is the watched one, the walked root included', () => {
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    mkdirSync(join(ws, 'c'));
    const id = (p: string): { dev: number; ino: number } => { const st = statSync(p); return { dev: st.dev, ino: st.ino }; };
    expect(walk(anchor, '', undefined, id(join(ws, 'a', 'b'))).watchedAt).toEqual(['a/b']);
    expect(walk(anchor, '', undefined, id(ws)).watchedAt).toEqual(['']);
    expect(walk(anchor, '', undefined, id(outside)).watchedAt).toEqual([]);
    expect(walk(anchor, '').watchedAt).toEqual([]);
  });
  it('copyOut refuses before copying anything when the refused directory is inside', () => {
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'a', 'f.txt'), 'x');
    const st = statSync(join(ws, 'a', 'b'));
    let copied = 0;
    expect(code(() => copyOut(anchor, '', () => { copied++; }, undefined, { dev: st.dev, ino: st.ino }))).toBe('OVERLAP');
    expect(copied).toBe(0);
    expect(copyOut(anchor, '', () => { copied++; }).files).toBe(1);
  });
  it('does not follow a link to the watched directory', () => {
    symlinkSync(outside, join(ws, 'to-outside'));
    const st = statSync(outside);
    expect(walk(anchor, '', undefined, { dev: st.dev, ino: st.ino }).watchedAt).toEqual([]);
  });
});

/**
 * Mount boundaries need a real mount; an unprivileged test cannot make one. /dev
 * carries several (shm, pts, mqueue) wherever this runs on Linux, so walk it
 * read-only. The emptyDir case runs only unprivileged: a mutant that drops the
 * refusal must not be able to delete anything under /dev.
 */
const DEV_SHM_IS_MOUNT = LINUX && / \/dev\/shm /.test(readFileSync('/proc/self/mountinfo', 'utf8'));
describe.runIf(DEV_SHM_IS_MOUNT)('mount boundaries', () => {
  let dev: WorkspaceAnchor;
  beforeEach(() => { dev = openAnchor('/dev'); });
  afterEach(() => { closeAnchor(dev); });
  it('walk reports a mount below and does not descend into it', () => {
    const r = walk(dev, '');
    expect(r.mountBoundaries).toContain('shm');
    expect(r.entries.some((e) => e.rel.startsWith('shm/'))).toBe(false);
  });
  it('copyOut refuses before copying anything', () => {
    let copied = 0;
    expect(code(() => copyOut(dev, '', () => { copied++; }))).toBe('MOUNT');
    expect(copied).toBe(0);
  });
  it.runIf(process.getuid?.() !== 0)('emptyDir refuses before deleting anything', () => {
    expect(code(() => emptyDir(dev, ''))).toBe('MOUNT');
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
