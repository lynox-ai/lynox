import { describe, expect, it, vi } from 'vitest';

/**
 * Check (hardlinks) reads the host setting from its own /proc file. The value alone cannot show
 * that: on most hosts `protected_symlinks` and `protected_fifos` read `1` as well, so the file read
 * is recorded here.
 */
const reads: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      reads.push(String(path));
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFileSync,
  };
});

import { PROTECTED_HARDLINKS_PATH, processInputs } from './shell-isolation.js';

describe('check (hardlinks) reads fs.protected_hardlinks', () => {
  it('from /proc/sys/fs/protected_hardlinks', () => {
    expect(PROTECTED_HARDLINKS_PATH).toBe('/proc/sys/fs/protected_hardlinks');
  });

  it.runIf(process.platform === 'linux')('and from no other file', () => {
    const inputs = processInputs();
    reads.length = 0;
    inputs.protectedHardlinks();
    expect(reads).toEqual(['/proc/sys/fs/protected_hardlinks']);
  });
});
