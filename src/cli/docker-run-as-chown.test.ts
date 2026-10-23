// Handing a fresh ~/.lynox to the image's user when the installer runs as
// root. That needs root to run for real, so fs's chown calls are recorded
// here instead, and lstat reports root as the owner of what the test says.
// What matters: only a fresh directory and its .env are re-owned, with
// lchown, and anything else is refused before a single call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  chown: [] as string[],
  lchown: [] as Array<[string, number, number]>,
  rootOwned: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chownSync: (path: string) => { state.chown.push(path); },
    lchownSync: (path: string, uid: number, gid: number) => { state.lchown.push([path, uid, gid]); },
    lstatSync: ((path: string) => {
      const st = actual.lstatSync(path);
      if (!state.rootOwned.has(path)) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, { uid: 0, gid: 0 });
    }) as typeof actual.lstatSync,
  };
});

const { freshDataDirProblem, handOverFreshDataDir } = await import('./docker-run-as.js');

describe('handOverFreshDataDir hands over a fresh data dir only', () => {
  let root: string;
  let dir: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lynox-chown-'));
    state.chown.length = 0;
    state.lchown.length = 0;
    state.rootOwned.clear();
    outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), '');
    dir = join(root, '.lynox');
    mkdirSync(dir);
    state.rootOwned.add(root);
    state.rootOwned.add(dir);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const touched = (): string[] => [...state.chown, ...state.lchown.map(([p]) => p)];
  const HAND_BACK = (): string => `chown -R -P 1001:1001 '${dir}'`;

  it('re-owns the .env and then the directory to 1001:1001 with lchown, and nothing else', () => {
    writeFileSync(join(dir, '.env'), 'LYNOX_VAULT_KEY=k\n');
    expect(freshDataDirProblem(dir, root)).toBeNull();
    handOverFreshDataDir(dir, root);
    expect(state.chown).toEqual([]);
    expect(state.lchown).toEqual([[join(dir, '.env'), 1001, 1001], [dir, 1001, 1001]]);
  });

  it('an empty directory: only the directory', () => {
    handOverFreshDataDir(dir, root);
    expect(state.lchown).toEqual([[dir, 1001, 1001]]);
  });

  it('refuses a directory that already holds anything else, a symlink pointing out included, and touches nothing', () => {
    for (const make of [
      () => { symlinkSync(outside, join(dir, 'escape')); },
      () => { mkdirSync(join(dir, 'memory')); },
      () => { writeFileSync(join(dir, 'engine.db'), ''); },
    ]) {
      rmSync(dir, { recursive: true });
      mkdirSync(dir);
      make();
      expect(freshDataDirProblem(dir, root)?.command).toBe(HAND_BACK());
      expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/already holds/);
    }
    expect(touched()).toEqual([]);
  });

  it('refuses a .env that is a symlink or has a second name, and touches nothing', () => {
    symlinkSync(join(outside, 'secret'), join(dir, '.env'));
    expect(freshDataDirProblem(dir, root)).toEqual({ reason: `${join(dir, '.env')} is not a regular file with one name.`, command: null });
    expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/not a regular file/);
    rmSync(join(dir, '.env'));
    linkSync(join(outside, 'secret'), join(dir, '.env'));
    expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/not a regular file/);
    expect(touched()).toEqual([]);
  });

  it('refuses <home>/.lynox when it is a symlink, even to a real directory, and touches nothing', () => {
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir);
    expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/not a real directory/);
    expect(touched()).toEqual([]);
  });

  it('refuses a directory that does not belong to root, with the hand-back command', () => {
    state.rootOwned.delete(dir);
    expect(freshDataDirProblem(dir, root)?.command).toBe(HAND_BACK());
    expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/not to root/);
    expect(touched()).toEqual([]);
  });

  it('refuses a home root does not own, and touches nothing', () => {
    state.rootOwned.delete(root);
    expect(() => { handOverFreshDataDir(dir, root); }).toThrow(/does not belong to root/);
    expect(touched()).toEqual([]);
  });
});
