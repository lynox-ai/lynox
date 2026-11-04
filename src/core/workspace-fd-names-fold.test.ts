import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `namesFoldAt` on a filesystem that folds, simulated: this machine's does not, so a hook on
 * `lstatSync` answers for the probe's upper-case or NFD name as a folding filesystem would.
 */
const fold = vi.hoisted(() => ({ as: null as 'upper' | 'nfd' | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const name = String(args[0]).split('/').pop() ?? '';
      const upper = /^\.LYNOX-FOLD-PROBE-[0-9A-F]{12}-ÉA$/.test(name);
      const nfd = name.startsWith('.lynox-fold-probe-') && name.endsWith('éa');
      if ((fold.as === 'upper' && upper) || (fold.as === 'nfd' && nfd)) return fs.lstatSync(String(args[0]).slice(0, -name.length - 1));
      return fs.lstatSync(...args);
    }) as typeof fs.lstatSync,
  };
});

const { closeAnchor, namesFoldAt, openAnchor } = await import('./workspace-fd.js');

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-fold-')));
  mkdirSync(join(root, 'sub'));
});
afterEach(() => {
  fold.as = null;
  rmSync(root, { recursive: true, force: true });
});

describe('namesFoldAt', () => {
  it.each([['upper'], ['nfd']] as const)('answers true where the filesystem finds the probe by its %s name, and removes the probe', (as) => {
    fold.as = as;
    const anchor = openAnchor(root);
    try {
      expect(namesFoldAt(anchor, 'sub')).toBe(true);
    } finally {
      closeAnchor(anchor);
    }
    expect(readdirSync(join(root, 'sub'))).toEqual([]);
  });

  it('control: answers false on this filesystem, and removes the probe', () => {
    const anchor = openAnchor(root);
    try {
      expect(namesFoldAt(anchor, 'sub')).toBe(false);
      expect(namesFoldAt(anchor, '')).toBe(false);
    } finally {
      closeAnchor(anchor);
    }
    expect(readdirSync(join(root, 'sub'))).toEqual([]);
    expect(readdirSync(root)).toEqual(['sub']);
  });
});
