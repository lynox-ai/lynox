import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, truncateSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepDataDir, OVERSIZE_BYTES } from './data-dir-sweep.js';

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
  /** A file of `bytes` that occupies almost nothing: the sweep reads `stat().size`, so a sparse
   *  file carries the same size without writing 100 MiB into a temp directory other runs share. */
  const sparse = (path: string, bytes: number): void => { writeFileSync(path, ''); truncateSync(path, bytes); };

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

  // The erasure files a measurement log's rotation under the live log; the sweep must not
  // call the same file undeclared, or it fails on every instance whose log rotated once.
  it('does not flag the rotation of a declared measurement log', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'retrieval-shadow.jsonl'), 'x', 'utf-8');
    writeFileSync(join(dir, 'retrieval-shadow.jsonl.1'), 'x', 'utf-8');
    writeFileSync(join(dir, 'notes.jsonl.1'), 'x', 'utf-8');            // not ours
    expect(sweepDataDir(dir).undeclared.map(f => f.name)).toEqual(['notes.jsonl.1']);
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

  it('flags a backed-up directory that has grown past the oversize bar', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'workspace'));
    sparse(join(dir, 'workspace', 'big.bin'), OVERSIZE_BYTES + 1024);
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'small.txt'), 'x', 'utf-8');

    const res = sweepDataDir(dir);
    expect(res.oversize.map(f => f.name)).toEqual(['workspace']);
    // The sweep sees the full size, and the file itself holds well under a megabyte on disk.
    expect(res.oversize[0]?.bytes).toBe(OVERSIZE_BYTES + 1024);
    expect(statSync(join(dir, 'workspace', 'big.bin')).blocks * 512).toBeLessThan(1024 * 1024);
    // It is declared, so it must NOT also be reported as an unknown store.
    expect(res.undeclared).toEqual([]);
  });

  it('does not flag an entry that is large but NOT in any backup', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'backups'));
    sparse(join(dir, 'backups', 'big.bin'), OVERSIZE_BYTES + 1024);
    // `backups/` is declared and deliberately not carried — its size costs nothing per run.
    expect(sweepDataDir(dir).oversize).toEqual([]);
  });

  describe('the workspace root (P18 D8)', () => {
    it('says the root is unknown when none is given, never assumes the default', () => {
      const dir = tmp();
      mkdirSync(join(dir, 'workspace'));
      writeFileSync(join(dir, 'workspace', 'a.txt'), 'x');
      const res = sweepDataDir(dir);
      expect(res.workspace).toEqual({ root: null, mode: 'unknown', leftover: null });
      expect(sweepDataDir(dir, { workspaceRoot: '' }).workspace.mode).toBe('unknown');
    });

    it('a root that is <data>/workspace is the default: nothing left over', () => {
      const dir = tmp();
      mkdirSync(join(dir, 'workspace'));
      writeFileSync(join(dir, 'workspace', 'a.txt'), 'x');
      const res = sweepDataDir(dir, { workspaceRoot: join(dir, 'workspace') });
      expect(res.workspace.mode).toBe('default');
      expect(res.workspace.leftover).toBeNull();
    });

    it('with an external root, reports files at the old place and does not list it as absent', () => {
      const dir = tmp();
      const root = tmp();
      expect(sweepDataDir(dir, { workspaceRoot: root }).workspace).toEqual({ root, mode: 'external', leftover: null });
      expect(sweepDataDir(dir, { workspaceRoot: root }).declaredButAbsent).not.toContain('workspace');
      expect(sweepDataDir(dir).declaredButAbsent).toContain('workspace');

      mkdirSync(join(dir, 'workspace'));
      expect(sweepDataDir(dir, { workspaceRoot: root }).workspace.leftover).toBeNull();
      writeFileSync(join(dir, 'workspace', 'old.txt'), 'y'.repeat(2048));
      const res = sweepDataDir(dir, { workspaceRoot: root });
      expect(res.workspace.leftover).toEqual({ name: 'workspace', kind: 'dir', bytes: 2048 });
    });

    it('measures an external root for oversize, not <data>/workspace', () => {
      const dir = tmp();
      const root = tmp();
      sparse(join(root, 'big.bin'), OVERSIZE_BYTES + 1);
      expect(sweepDataDir(dir, { workspaceRoot: root }).oversize.map(f => f.name)).toEqual(['workspace']);
    });
  });
});
