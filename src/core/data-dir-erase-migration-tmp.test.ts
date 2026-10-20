import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, removeOwedEntries, scanDataDir } from './data-dir-erase.js';

// A migration stages a copy of each database it moves beside it (`<db>.migration-tmp`): the export
// through VACUUM INTO, the restore for the bytes it lands. Both remove it again in the same
// synchronous call; only a crash leaves one behind. The erasure stopped on such a copy as on a
// name it does not know. It is now a temp of its database and goes with it.

describe('a copy a migration left beside a database', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lynox-erase-mtmp-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('is a temp of its database, with its sidecars', () => {
    for (const db of ['engine.db', 'history.db', 'datastore.db', 'agent-memory.db']) {
      expect(classifyEntry(`${db}.migration-tmp`)).toEqual({ kind: 'temp', of: db });
      expect(classifyEntry(`${db}.migration-tmp-wal`)).toEqual({ kind: 'temp', of: db });
      expect(classifyEntry(`${db}.migration-tmp-shm`)).toEqual({ kind: 'temp', of: db });
    }
  });

  it('control: a name the migration does not write stays unknown', () => {
    expect(classifyEntry('notes.migration-tmp')).toEqual({ kind: 'unknown' });
    expect(classifyEntry('my.engine.db.migration-tmp')).toEqual({ kind: 'unknown' });
    // A store no migration moves has no staged copy, and a migrated directory is no database.
    expect(classifyEntry('mail-state.db.migration-tmp')).toEqual({ kind: 'unknown' });
    expect(classifyEntry('memory.migration-tmp')).toEqual({ kind: 'unknown' });
    // The copy EngineDb moves aside stays residue, as before.
    expect(classifyEntry('engine.db.migration-tmp.corrupt-1700000000000').kind).toBe('residue');
  });

  it('the erasure goes through and removes every such copy', () => {
    const dir = tmp();
    const left = ['engine.db.migration-tmp', 'engine.db.migration-tmp-wal', 'history.db.migration-tmp'];
    for (const name of left) writeFileSync(join(dir, name), `ZZ-${name}`);
    const scan = scanDataDir(dir);
    expect(scan.unknown, 'the erasure stops on a name it does not know').toEqual([]);
    expect(scan.linked, 'the route refuses while an owed entry is a link or a mount').toEqual([]);
    const out = removeOwedEntries(scan, []);
    expect(out.failures).toEqual([]);
    for (const name of left) expect(existsSync(join(dir, name)), `${name} survived`).toBe(false);
  });
});
