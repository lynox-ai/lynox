import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Pruning lists the versions, then removes the oldest. A folder swapped for a link between the two
 * must not let the removal reach outside the store. A one-shot hook on `listDir` swaps `versions/`
 * for a link right after the listing.
 */

let swap: (() => void) | null = null;
vi.mock('./workspace-fd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-fd.js')>();
  return {
    ...actual,
    listDir: ((...args: Parameters<typeof actual.listDir>) => {
      const out = actual.listDir(...args);
      const run = args[1] === 'versions' ? swap : null;
      if (run !== null) { swap = null; run(); }
      return out;
    }) as typeof actual.listDir,
  };
});

const { ArtifactStore } = await import('./artifact-store.js');

let dir: string;
let outside: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-prune-race-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-prune-race-out-')));
});
afterEach(() => {
  swap = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('pruning versions while versions/ is swapped for a link', () => {
  it('removes nothing where the link points', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    for (let n = 2; n <= 11; n++) store.save({ id: a.id, title: 't', content: `v${n}` });
    // The next update snapshots v11 and prunes the oldest, v1 — by then versions/ points outside.
    writeFileSync(join(outside, `${a.id}.v1.html`), 'kept');
    swap = () => {
      renameSync(join(dir, 'versions'), join(dir, 'versions.real'));
      symlinkSync(outside, join(dir, 'versions'));
    };
    store.save({ id: a.id, title: 't', content: 'v12' });
    expect(swap).toBeNull(); // the hook ran
    expect(existsSync(join(outside, `${a.id}.v1.html`))).toBe(true);
    expect(readFileSync(join(outside, `${a.id}.v1.html`), 'utf-8')).toBe('kept');
  });
});
