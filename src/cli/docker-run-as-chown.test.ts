// The chown walk that hands ~/.lynox to the image's user when the installer
// runs as root. It needs root to run for real, so fs's chown calls are
// recorded here instead. What matters is where the walk goes: into real
// directories, never through a symlink.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls = vi.hoisted(() => ({ chown: [] as string[], lchown: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chownSync: (path: string) => { calls.chown.push(path); },
    lchownSync: (path: string) => { calls.lchown.push(path); },
  };
});

const { chownDataDirToImage } = await import('./docker-run-as.js');

describe('chownDataDirToImage walks the data dir only', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lynox-chown-'));
    calls.chown.length = 0;
    calls.lchown.length = 0;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('re-owns every file and directory inside, and a symlink only itself, never what it points to', () => {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep', 'secret'), '');
    const dir = join(root, '.lynox');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'engine.db'), '');
    writeFileSync(join(dir, 'memory', 'a.md'), '');
    symlinkSync(outside, join(dir, 'escape'));
    symlinkSync('/', join(dir, 'root'));

    chownDataDirToImage(dir, root);

    expect(calls.chown.sort()).toEqual([dir, join(dir, 'engine.db'), join(dir, 'memory'), join(dir, 'memory', 'a.md')].sort());
    expect(calls.lchown.sort()).toEqual([join(dir, 'escape'), join(dir, 'root')].sort());
    expect([...calls.chown, ...calls.lchown].some((p) => p.startsWith(outside) || p === '/')).toBe(false);
  });
});
