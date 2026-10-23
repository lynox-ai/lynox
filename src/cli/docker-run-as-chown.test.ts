// The chown walk that hands ~/.lynox to the image's user when the installer
// runs as root. It needs root to run for real, so fs's chown calls are
// recorded here instead, and the home reports root as its owner. What matters
// is where the walk goes and which ids it sets: into real directories on one
// filesystem, never through a symlink, never onto a file with another name.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  chown: [] as string[],
  lchown: [] as Array<[string, number, number]>,
  rootOwned: new Set<string>(),
  otherDev: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chownSync: (path: string) => { state.chown.push(path); },
    lchownSync: (path: string, uid: number, gid: number) => { state.lchown.push([path, uid, gid]); },
    lstatSync: ((path: string) => {
      const st = actual.lstatSync(path);
      const over: { uid?: number; dev?: number } = {};
      if (state.rootOwned.has(path)) over.uid = 0;
      if (state.otherDev.has(path)) over.dev = st.dev + 1;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, over);
    }) as typeof actual.lstatSync,
  };
});

const { chownDataDirToImage } = await import('./docker-run-as.js');

describe('chownDataDirToImage walks the data dir only', () => {
  let root: string;
  let dir: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lynox-chown-'));
    state.chown.length = 0;
    state.lchown.length = 0;
    state.rootOwned.clear();
    state.otherDev.clear();
    state.rootOwned.add(root);
    outside = join(root, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep', 'secret'), '');
    dir = join(root, '.lynox');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'engine.db'), '');
    writeFileSync(join(dir, 'memory', 'a.md'), '');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const touched = (): string[] => [...state.chown, ...state.lchown.map(([p]) => p)];

  it('re-owns everything inside to 1001:1001, and a symlink pointing out only itself, never its target', () => {
    symlinkSync(outside, join(dir, 'escape'));
    symlinkSync('/', join(dir, 'root'));
    symlinkSync(join(outside, 'deep', 'secret'), join(dir, 'memory', 'secret-link'));

    chownDataDirToImage(dir, root);

    expect(state.chown).toEqual([]);
    expect(state.lchown.map(([p]) => p).sort()).toEqual([
      dir, join(dir, 'engine.db'), join(dir, 'escape'), join(dir, 'memory'),
      join(dir, 'memory', 'a.md'), join(dir, 'memory', 'secret-link'), join(dir, 'root'),
    ].sort());
    expect(state.lchown.every(([, uid, gid]) => uid === 1001 && gid === 1001)).toBe(true);
    expect(touched().some((p) => p.startsWith(outside) || p === '/')).toBe(false);
  });

  it('refuses a file with a second name, before re-owning it', () => {
    linkSync(join(outside, 'deep', 'secret'), join(dir, 'memory', 'hard'));
    expect(() => { chownDataDirToImage(dir, root); }).toThrow(/has 2 hard links/);
    expect(touched()).not.toContain(join(dir, 'memory', 'hard'));
  });

  it('refuses to cross onto another filesystem', () => {
    state.otherDev.add(join(dir, 'memory'));
    expect(() => { chownDataDirToImage(dir, root); }).toThrow(/another filesystem/);
    expect(touched().some((p) => p.startsWith(join(dir, 'memory')))).toBe(false);
  });

  it('refuses <home>/.lynox when it is a symlink, even to a real directory, and touches nothing', () => {
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir);
    expect(() => { chownDataDirToImage(dir, root); }).toThrow(/not a real directory/);
    expect(touched()).toEqual([]);
  });

  it('refuses a home root does not own, and touches nothing', () => {
    state.rootOwned.clear();
    expect(() => { chownDataDirToImage(dir, root); }).toThrow(/does not belong to root/);
    expect(touched()).toEqual([]);
  });
});
