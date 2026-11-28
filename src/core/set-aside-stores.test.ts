import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSetAsideStores } from './set-aside-stores.js';

describe('listSetAsideStores', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('lists the set-aside files of the four databases by database, the older engine.db staging copy included, without their -wal and -shm or other names', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-set-aside-'));
    for (const f of [
      'history.db', 'engine.db', 'datastore.db',
      'history.db.corrupt-200', 'history.db.corrupt-100', 'history.db.corrupt-100-wal', 'history.db.corrupt-100-shm',
      'engine.db.corrupt-300', 'datastore.db.corrupt-400', 'engine.db.migration-tmp.corrupt-500', 'notes-history.db.corrupt-600', 'vault.db.corrupt-700',
      'agent-memory.db.corrupt-800', 'history.db.migration-tmp.corrupt-900',
    ]) writeFileSync(join(dir, f), '');
    expect(listSetAsideStores(dir)).toEqual([
      { database: 'agent-memory.db', files: ['agent-memory.db.corrupt-800'] },
      { database: 'datastore.db', files: ['datastore.db.corrupt-400'] },
      { database: 'engine.db', files: ['engine.db.corrupt-300', 'engine.db.migration-tmp.corrupt-500'] },
      { database: 'history.db', files: ['history.db.corrupt-100', 'history.db.corrupt-200'] },
    ]);
  });

  it('returns nothing when no database was set aside', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-set-aside-'));
    writeFileSync(join(dir, 'history.db'), '');
    expect(listSetAsideStores(dir)).toEqual([]);
  });

  it('throws when the directory cannot be listed', () => {
    expect(() => listSetAsideStores(join(tmpdir(), 'lynox-set-aside-missing-dir-x'))).toThrow();
  });
});
