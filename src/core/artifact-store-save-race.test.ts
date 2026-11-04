import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync as writeNow } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * An update opens and checks the content file, snapshots its prior content, then writes. Two
 * windows in that order are forced here with one-shot hooks on `node:fs`:
 * - a link swapped in after the check: the snapshot must not read through it;
 * - a write that fails after the check: the index must keep the entry as it was.
 */

let swap: { ino: number; run: () => void } | null = null;
let failWrite = false;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fstatSync: ((...args: Parameters<typeof real.fstatSync>) => {
      const st = real.fstatSync(...args);
      if (swap !== null && st.isFile() && st.ino === swap.ino) {
        const { run } = swap;
        swap = null;
        run();
      }
      return st;
    }) as typeof real.fstatSync,
    writeFileSync: ((...args: Parameters<typeof real.writeFileSync>) => {
      if (failWrite && typeof args[0] === 'number') {
        failWrite = false;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return real.writeFileSync(...args);
    }) as typeof real.writeFileSync,
  };
});

const { ArtifactStore } = await import('./artifact-store.js');

let dir: string;
let outside: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-save-race-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-save-race-out-')));
  writeNow(join(outside, 'secret.txt'), 'SECRET\n');
});
afterEach(() => {
  swap = null;
  failWrite = false;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('an update', () => {
  it('does not snapshot through a link swapped in after the content file was checked', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    const file = join(dir, `${a.id}.html`);
    swap = {
      ino: statSync(file).ino,
      run: () => {
        renameSync(file, `${file}.moved`);
        symlinkSync(join(outside, 'secret.txt'), file);
      },
    };
    store.save({ id: a.id, title: 't', content: 'second' });
    expect(swap).toBeNull(); // the hook ran
    const versions = (() => { try { return readdirSync(join(dir, 'versions')); } catch { return []; } })();
    for (const v of versions) expect(readFileSync(join(dir, 'versions', v), 'utf-8')).not.toContain('SECRET');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
  });

  it('whose write fails after the check leaves the entry as it was', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    failWrite = true;
    expect(() => store.save({ id: a.id, title: 'changed', content: 'second' })).toThrow(/ENOSPC/);
    expect(failWrite).toBe(false); // the hook ran
    const meta = new ArtifactStore(dir).list().find(m => m.id === a.id);
    expect(meta?.version).toBe(1);
    expect(meta?.title).toBe('t');
  });
});
