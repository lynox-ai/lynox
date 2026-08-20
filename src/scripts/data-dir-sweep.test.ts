import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepDataDir } from './data-dir-sweep.js';

/**
 * The runtime half of the coverage mechanism. It exists because the static gate reads the
 * SOURCE, and both leftovers found on a live instance on 2026-08-20 were created by code
 * that is not in the tree at all — a store from a feature that never merged, and a
 * hand-placed directory holding a customer document.
 */
describe('data-dir sweep', () => {
  const dirs: string[] = [];
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'lynox-sweep-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  it('reports a store no code creates — the shape the static scan cannot see', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'engine.db'), 'x', 'utf-8');            // declared
    writeFileSync(join(dir, 'ads-optimizer.db'), 'y'.repeat(2048), 'utf-8'); // the real 2026-08-20 leftover
    mkdirSync(join(dir, 'files'));                                  // the hand-placed one
    writeFileSync(join(dir, 'files', 'contract.docx'), 'z'.repeat(1024), 'utf-8');

    const found = sweepDataDir(dir).undeclared.map(f => f.name).sort();
    expect(found).toEqual(['ads-optimizer.db', 'files']);
  });

  it('does not flag a clean data dir, nor SQLite sidecars or engine backups', () => {
    const dir = tmp();
    for (const name of ['engine.db', 'engine.db-wal', 'engine.db-shm', 'history.db', 'config.json']) {
      writeFileSync(join(dir, name), 'x', 'utf-8');
    }
    writeFileSync(join(dir, 'engine.db.bak-relcleanup-2026-06-30T23-42-47-528Z'), 'x', 'utf-8');
    writeFileSync(join(dir, 'engine.db.pre-s2-20260630'), 'x', 'utf-8');
    mkdirSync(join(dir, 'memory'));
    mkdirSync(join(dir, 'sweeps'));

    expect(sweepDataDir(dir).undeclared).toEqual([]);
  });

  it('sorts by size, so the expensive surprise is the first line an operator reads', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'small-unknown.json'), 'x', 'utf-8');
    writeFileSync(join(dir, 'large-unknown.db'), 'y'.repeat(50_000), 'utf-8');
    expect(sweepDataDir(dir).undeclared.map(f => f.name)).toEqual(['large-unknown.db', 'small-unknown.json']);
  });

  it('lists declared entries that are absent without calling them a problem', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'engine.db'), 'x', 'utf-8');
    const res = sweepDataDir(dir);
    expect(res.undeclared).toEqual([]);
    expect(res.declaredButAbsent).toContain('vault.db');
    expect(res.declaredButAbsent).not.toContain('engine.db');
  });
});
