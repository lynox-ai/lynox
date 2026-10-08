import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, parseAcknowledged, removeOwedEntries, sameUnknownSet, scanDataDir } from './data-dir-erase.js';
import { ERASE_BY_REMOVE, ERASE_KEPT } from './data-dir-inventory.js';

describe('data-dir erasure — classification', () => {
  it('classifies declared entries, sidecars, atomic temps, residue, litter and the rest', () => {
    expect(classifyEntry('artifacts').kind).toBe('declared');
    expect(classifyEntry('mail-state.db-wal')).toEqual({ kind: 'sidecar', of: 'mail-state.db' });
    expect(classifyEntry('config.json.4242.deadbeef.tmp')).toEqual({ kind: 'temp', of: 'config.json' });
    expect(classifyEntry('engine.db.corrupt-1700000000000').kind).toBe('residue');
    expect(classifyEntry('engine.db.corrupt-1700000000000-wal').kind).toBe('residue');
    expect(classifyEntry('vault.db.rotate-bak').kind).toBe('residue');
    expect(classifyEntry('.DS_Store').kind).toBe('litter');
    // Unanchored lookalikes in a broad data dir stay UNKNOWN, never residue.
    expect(classifyEntry('thesis.bak-2024').kind).toBe('unknown');
    expect(classifyEntry('my.engine.db.corrupt-1').kind).toBe('unknown');
    expect(classifyEntry('notes.txt.123.deadbeef.tmp').kind).toBe('unknown');
    expect(classifyEntry('ads-optimizer.db').kind).toBe('unknown');
  });

  it('rejects a malformed or path-shaped acknowledgement', () => {
    expect(parseAcknowledged(undefined)).toEqual([]);
    expect(parseAcknowledged('x')).toBeNull();
    expect(parseAcknowledged([{ name: '../etc', dev: 1, ino: 1, size: 1, mtimeMs: 1 }])).toBeNull();
    expect(parseAcknowledged([{ name: 'a/b', dev: 1, ino: 1, size: 1, mtimeMs: 1 }])).toBeNull();
    expect(parseAcknowledged([{ name: 'ok', dev: 1, ino: 1, size: 1 }])).toBeNull();
  });
});

describe('data-dir erasure — on disk', () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-dde-'));
    outside = mkdtempSync(join(tmpdir(), 'lynox-dde-outside-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const seed = (name: string, body = `ZZ-${name}`): void => { writeFileSync(join(dir, name), body); };
  const seedDir = (name: string): void => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'inside.txt'), `ZZ-${name}`);
  };

  it('removes every `remove` entry, with sidecars, temps and residue, and keeps the rest byte-identical', () => {
    for (const name of ERASE_BY_REMOVE) {
      if (['artifacts', 'apis', 'workspace', 'sweeps', 'sessions', 'backups', 'wire-sink', 'wire-sink-raw'].includes(name)) seedDir(name);
      else seed(name);
    }
    for (const name of ERASE_KEPT) seed(name);
    seed('config.json.77.0badcafe.tmp');
    seed('engine.db.corrupt-1');
    seed('engine.db.corrupt-1-wal');
    seed('vault.db.rotate-bak');
    // The sidecars of a store the route empties IN PLACE belong to an open connection:
    // removing a `-wal` under it would lose committed pages. They stay.
    seed('mail-state.db-wal');
    seed('engine.db-shm');

    const scan = scanDataDir(dir);
    expect(scan.unknown).toEqual([]);
    const out = removeOwedEntries(scan, []);
    expect(out.failures).toEqual([]);

    for (const name of ERASE_BY_REMOVE) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isDirectory()) expect(readdirSync(p), `${name} kept content`).toEqual([]);
      else expect(existsSync(p), `${name} survived`).toBe(false);
    }
    for (const name of ['config.json.77.0badcafe.tmp', 'engine.db.corrupt-1', 'engine.db.corrupt-1-wal', 'vault.db.rotate-bak']) {
      expect(existsSync(join(dir, name)), `${name} survived`).toBe(false);
    }
    for (const name of ERASE_KEPT) expect(readFileSync(join(dir, name), 'utf8')).toBe(`ZZ-${name}`);
    for (const name of ['mail-state.db-wal', 'engine.db-shm']) expect(existsSync(join(dir, name)), `${name} was removed`).toBe(true);
    // `backups` goes last, after every other owed entry.
    expect(out.removed.at(-1)).toBe('backups');
  });

  it('reports an unknown entry and leaves it alone unless it is acknowledged', () => {
    seed('ads-optimizer.db');
    seed('.DS_Store');
    const scan = scanDataDir(dir);
    expect(scan.unknown.map(u => u.name)).toEqual(['ads-optimizer.db']);
    expect(scan.litter).toEqual(['.DS_Store']);
    removeOwedEntries(scan, []);
    expect(existsSync(join(dir, 'ads-optimizer.db'))).toBe(true);
    removeOwedEntries(scan, ['ads-optimizer.db']);
    expect(existsSync(join(dir, 'ads-optimizer.db'))).toBe(false);
  });

  it('accepts an acknowledgement only for the same entries with the same identity', () => {
    seed('a.db');
    const scan = scanDataDir(dir);
    expect(sameUnknownSet(scan.unknown, scan.unknown)).toBe(true);
    expect(sameUnknownSet(scan.unknown, [])).toBe(false);
    expect(sameUnknownSet(scan.unknown, [{ ...scan.unknown[0]!, ino: scan.unknown[0]!.ino + 1 }])).toBe(false);
    expect(sameUnknownSet(scan.unknown, [...scan.unknown, { ...scan.unknown[0]!, name: 'b.db' }])).toBe(false);
  });

  it('unlinks a symlinked `remove` entry and never empties its target', () => {
    writeFileSync(join(outside, 'precious.txt'), 'ZZ-outside');
    symlinkSync(outside, join(dir, 'workspace'));
    const out = removeOwedEntries(scanDataDir(dir), []);
    expect(out.failures).toEqual([]);
    expect(existsSync(join(dir, 'workspace'))).toBe(false);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('ZZ-outside');
  });

  it('refuses to empty an entry that sits on another device (a mount)', async () => {
    seedDir('workspace');
    const { lstatSync } = await import('node:fs');
    const scan = scanDataDir(dir);
    const out = removeOwedEntries(scan, [], (p) => {
      const st = lstatSync(p);
      return p.endsWith('/workspace') ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as typeof st, st, { dev: scan.dev + 1 }) : st;
    });
    expect(out.failures.map(f => f.name)).toEqual(['workspace']);
    expect(readFileSync(join(dir, 'workspace', 'inside.txt'), 'utf8')).toBe('ZZ-workspace');
  });

  it('compares against the data dir as resolved, so a data dir that is a symlink still works', () => {
    const link = join(outside, 'lynox-link');
    symlinkSync(dir, link);
    seed('stray.bin');
    seedDir('artifacts');
    const scan = scanDataDir(link);
    expect(scan.unknown.map(u => u.name)).toEqual(['stray.bin']);
    expect(removeOwedEntries(scan, []).failures).toEqual([]);
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
  });
});
