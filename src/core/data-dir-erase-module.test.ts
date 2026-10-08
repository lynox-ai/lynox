import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, parseAcknowledged, removeBackupsOutside, removeOwedEntries, sameUnknownSet, scanDataDir } from './data-dir-erase.js';
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
    // Only a SQLite store has sidecars; `workspace-journal` is a user's name, not ours.
    expect(classifyEntry('workspace-journal').kind).toBe('unknown');
    expect(classifyEntry('backups-wal').kind).toBe('unknown');
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

  it('reports a symlinked `remove` or `step` entry, and neither follows nor unlinks it', () => {
    writeFileSync(join(outside, 'precious.txt'), 'ZZ-outside');
    symlinkSync(outside, join(dir, 'workspace'));
    symlinkSync(outside, join(dir, 'memory'));
    const scan = scanDataDir(dir);
    expect(scan.linked.map(l => l.name)).toEqual(['memory', 'workspace']);
    // Its content is this instance's data: erased where it lives, not moved out of sight.
    expect(scan.linked[1]!.remedy).toMatch(/erase it where it lives/);
    // The stretch asks again, and reports rather than unlinking: an unlinked link would
    // read as erased while its content stays at the target.
    const out = removeOwedEntries(scan, []);
    expect(out.failures.map(f => f.name)).toEqual(['workspace']);
    expect(existsSync(join(dir, 'workspace'))).toBe(true);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('ZZ-outside');
  });

  it('does not report a symlinked kept entry or an unknown link, whose removal only unlinks', () => {
    symlinkSync(outside, join(dir, 'plugins'));
    symlinkSync(outside, join(dir, 'zz-link'));
    const scan = scanDataDir(dir);
    expect(scan.linked).toEqual([]);
    expect(scan.unknown.map(u => u.name)).toEqual(['zz-link']);
  });

  it('reports a mount point nested inside an entry it would remove, and leaves it', async () => {
    seedDir('workspace');
    mkdirSync(join(dir, 'workspace', 'proj', 'mnt'), { recursive: true });
    writeFileSync(join(dir, 'workspace', 'proj', 'mnt', 'disk.txt'), 'ZZ-disk');
    const { lstatSync } = await import('node:fs');
    const dev = scanDataDir(dir).dev;
    const mountAt = (p: string): ReturnType<typeof lstatSync> => {
      const st = lstatSync(p);
      return p.endsWith('/proj/mnt') ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as typeof st, st, { dev: dev + 1 }) : st;
    };
    const scan = scanDataDir(dir, { lstat: mountAt });
    expect(scan.linked.map(l => l.name)).toEqual(['workspace']);
    expect(scan.linked[0]!.reason).toMatch(/proj\/mnt/);
    const out = removeOwedEntries(scan, [], mountAt);
    expect(out.failures.map(f => f.name)).toEqual(['workspace']);
    expect(readFileSync(join(dir, 'workspace', 'proj', 'mnt', 'disk.txt'), 'utf8')).toBe('ZZ-disk');
  });

  it('checks an unknown entry for mounts only once it is acknowledged for removal', async () => {
    mkdirSync(join(dir, 'nas', 'share'), { recursive: true });
    const { lstatSync } = await import('node:fs');
    const dev = scanDataDir(dir).dev;
    const mountAt = (p: string): ReturnType<typeof lstatSync> => {
      const st = lstatSync(p);
      return p.endsWith('/nas/share') ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as typeof st, st, { dev: dev + 1 }) : st;
    };
    expect(scanDataDir(dir, { lstat: mountAt }).linked).toEqual([]);
    const acked = scanDataDir(dir, { lstat: mountAt, acknowledged: new Set(['nas']) }).linked;
    expect(acked.map(l => l.name)).toEqual(['nas']);
    // Not this instance's data: taken out of the data dir, never erased where it lives.
    expect(acked[0]!.remedy).toMatch(/move the entry out of the data directory instead of acknowledging it/);
    expect(acked[0]!.remedy).not.toMatch(/erase it where it lives/);
  });

  it('fails closed on a directory it cannot read, instead of throwing', () => {
    seedDir('workspace');
    const locked = join(dir, 'workspace', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      // Root reads anything; the property is only observable for an ordinary user.
      if (process.getuid?.() === 0) return;
      const scan = scanDataDir(dir);
      expect(scan.linked.map(l => l.name)).toEqual(['workspace']);
      expect(scan.linked[0]!.reason).toMatch(/could not be read/);
      expect(scan.linked[0]!.remedy).toBe('Make it readable to this instance, then erase.');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('reports a symlinked residue copy it owes, like a declared entry', () => {
    writeFileSync(join(outside, 'old-vault'), 'ZZ-old');
    symlinkSync(join(outside, 'old-vault'), join(dir, 'vault.db.rotate-bak'));
    expect(scanDataDir(dir).linked.map(l => l.name)).toEqual(['vault.db.rotate-bak']);
  });

  it('skips only an entry that vanished; any other error reaching an owed entry is reported', async () => {
    seedDir('workspace');
    const { lstatSync } = await import('node:fs');
    const failing = (p: string): ReturnType<typeof lstatSync> => {
      if (p.endsWith('/workspace')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return lstatSync(p);
    };
    expect(() => scanDataDir(dir, { lstat: failing })).toThrow(/EIO/);
    const out = removeOwedEntries(scanDataDir(dir), [], failing);
    expect(out.failures.map(f => f.name)).toEqual(['workspace']);
    expect(readdirSync(join(dir, 'workspace'))).toEqual(['inside.txt']);
  });

  it('does not refuse a SQLite store on another device: its handle empties it in place', async () => {
    seed('engine.db');
    const { lstatSync } = await import('node:fs');
    const dev = scanDataDir(dir).dev;
    const elsewhere = (p: string): ReturnType<typeof lstatSync> => {
      const st = lstatSync(p);
      return p.endsWith('/engine.db') ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as typeof st, st, { dev: dev + 1 }) : st;
    };
    expect(scanDataDir(dir, { lstat: elsewhere }).linked).toEqual([]);
  });

  it('names what it empties in place, apart from what it removes', () => {
    seed('engine.db');
    seed('config.json');
    seedDir('memory');
    seed('vault.key');
    expect(scanDataDir(dir).emptiedInPlace).toEqual(['config.json', 'engine.db', 'memory']);
  });

  it('reports, rather than throws, when the data dir cannot be listed at removal', () => {
    const scan = scanDataDir(dir);
    rmSync(dir, { recursive: true, force: true });
    const out = removeOwedEntries(scan, []);
    expect(out.failures.map(f => f.name)).toEqual(['.']);
    mkdirSync(dir);
  });

  it('names what it removes without asking, and keeps a temp beside a kept entry', () => {
    seedDir('workspace');
    seed('secrets.json');
    seed('vault.key');
    seed('vault.key.4242.deadbeef.tmp');
    seed('config.json.4242.deadbeef.tmp');
    const scan = scanDataDir(dir);
    expect(scan.removedWithoutAsking).toEqual(['config.json.4242.deadbeef.tmp', 'secrets.json', 'workspace']);
    removeOwedEntries(scan, []);
    expect(existsSync(join(dir, 'vault.key.4242.deadbeef.tmp'))).toBe(true);
    expect(existsSync(join(dir, 'config.json.4242.deadbeef.tmp'))).toBe(false);
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

  it('removes only backup-named entries from a backup_dir outside the data dir', () => {
    for (const n of ['2026-10-08T19301234Z', '2026-10-08T19301234Z-1', '2026-10-08T19301234Z.tmp']) {
      mkdirSync(join(outside, n));
      writeFileSync(join(outside, n, 'engine.db'), 'ZZ-copy');
    }
    writeFileSync(join(outside, 'my-notes.txt'), 'ZZ-mine');
    const out = removeBackupsOutside(outside, dir);
    expect(out.removed.sort()).toEqual(['2026-10-08T19301234Z', '2026-10-08T19301234Z-1', '2026-10-08T19301234Z.tmp']);
    expect(readdirSync(outside)).toEqual(['my-notes.txt']);
  });

  it('reports, rather than throws, when the backup_dir cannot be read', () => {
    writeFileSync(join(outside, 'not-a-dir'), 'x');
    const out = removeBackupsOutside(join(outside, 'not-a-dir'), dir);
    expect(out.removed).toEqual([]);
    expect(out.failures.length).toBe(1);
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
