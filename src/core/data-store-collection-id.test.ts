import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DataStore } from './data-store.js';

/**
 * The opaque id of a collection (`dsc_` and 16 hex), by which a mandate's row in the instance
 * trail names a table instead of its name: how a new file carries it, how the boot migration
 * gives it to an older one, and that a store asked to write a given id writes exactly it or
 * creates nothing.
 */

const SCOPE = { type: 'global' as const, id: '' };
const COLS = [{ name: 'v', type: 'string' as const }];
const ID = /^dsc_[0-9a-f]{16}$/;

/** What an older build left: `ds_collections` without the id column, with the given tables. */
function legacyFile(path: string, names: readonly unknown[]): void {
  const raw = new Database(path);
  raw.exec(`CREATE TABLE ds_collections (
    name TEXT PRIMARY KEY, scope_type TEXT NOT NULL DEFAULT 'project', scope_id TEXT NOT NULL DEFAULT '',
    schema_json TEXT NOT NULL, unique_key TEXT, record_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const ins = raw.prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES (?, 'global', '', '[]', NULL, 0, 'x', 'x')");
  for (const n of names) ins.run(n);
  raw.close();
}

describe('DataStore collection id', () => {
  let dir: string;
  let path: string;
  let ds: DataStore | undefined;
  let other: DataStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-ds-cid-'));
    path = join(dir, 'datastore.db');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of [ds, other]) { try { s?.close(); } catch { /* closed by the test */ } }
    ds = undefined;
    other = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const db = (s: DataStore): Database.Database => s['db'] as Database.Database;
  const ids = (s: DataStore): Array<{ name: unknown; collection_id: unknown }> =>
    db(s).prepare('SELECT name, collection_id FROM ds_collections ORDER BY rowid').all() as Array<{ name: unknown; collection_id: unknown }>;

  describe('a new file', () => {
    it('gives each created table its own id and names it by collectionIdOf', () => {
      ds = new DataStore(path);
      expect(ds.hasCollectionIdColumn()).toBe(true);
      ds.createCollection({ name: 'projekt_geheim', scope: SCOPE, columns: COLS });
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      const a = ds.collectionIdOf('projekt_geheim');
      const b = ds.collectionIdOf('leads');
      expect(a).toMatch(ID);
      expect(b).toMatch(ID);
      expect(a).not.toBe(b);
      expect(ds.collectionIdOf('missing')).toBeUndefined();
    });

    it('writes exactly the id it is given', () => {
      ds = new DataStore(path);
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS, collectionId: 'dsc_00000000000000aa' });
      expect(ds.collectionIdOf('leads')).toBe('dsc_00000000000000aa');
    });

    it('a table dropped and created again under the same name is another table with another id', () => {
      ds = new DataStore(path);
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      const first = ds.collectionIdOf('leads');
      ds.dropCollection('leads');
      expect(ds.collectionIdOf('leads')).toBeUndefined();
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      expect(ds.collectionIdOf('leads')).toMatch(ID);
      expect(ds.collectionIdOf('leads')).not.toBe(first);
    });

    it('names no id for a table whose id is NULL or empty: never the word "null"', () => {
      ds = new DataStore(path);
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      db(ds).prepare("UPDATE ds_collections SET collection_id = NULL WHERE name = 'leads'").run();
      expect(ds.collectionIdOf('leads')).toBeUndefined();
      db(ds).prepare("UPDATE ds_collections SET collection_id = '' WHERE name = 'leads'").run();
      expect(ds.collectionIdOf('leads')).toBeUndefined();
    });

    it('a failure that is not the missing column is thrown, not read as "no id"', () => {
      ds = new DataStore(path);
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      const real = db(ds).prepare.bind(db(ds));
      vi.spyOn(db(ds), 'prepare').mockImplementation(((sql: string) => {
        if (sql.startsWith('SELECT collection_id FROM ds_collections')) throw new Error('disk I/O error');
        return real(sql);
      }) as never);
      expect(() => ds!.collectionIdOf('leads')).toThrow('disk I/O error');
    });
  });

  describe('a file from before the id column', () => {
    it('opening it changes nothing: no column, and a table created without an id still works', () => {
      legacyFile(path, ['old']);
      ds = new DataStore(path);
      expect(ds.hasCollectionIdColumn()).toBe(false);
      expect(ds.collectionIdOf('old')).toBeUndefined();
      ds.createCollection({ name: 'fresh', scope: SCOPE, columns: COLS });
      expect(ds.listCollections().map(c => c.name)).toContain('fresh');
      expect(ds.hasCollectionIdColumn()).toBe(false);
    });

    it('a table asked to carry a given id is not created at all when the column is missing', () => {
      legacyFile(path, []);
      ds = new DataStore(path);
      expect(() => ds!.createCollection({ name: 'leads', scope: SCOPE, columns: COLS, collectionId: 'dsc_00000000000000aa' })).toThrow(/collection_id/);
      expect(ds.listCollections().map(c => c.name)).not.toContain('leads');
      expect(db(ds).prepare("SELECT name FROM sqlite_master WHERE name = 'ds_leads'").get()).toBeUndefined();
    });

    it('the boot migration adds the column, gives every table a unique id, and a second run changes nothing', () => {
      legacyFile(path, ['a', 'b', 'c']);
      ds = new DataStore(path);
      const first = ds.ensureCollectionIds();
      expect(first).toEqual({ assigned: 3, renumbered: [], failed: null, indexFailed: null });
      const after = ids(ds);
      expect(after.every(r => typeof r.collection_id === 'string' && ID.test(r.collection_id))).toBe(true);
      expect(new Set(after.map(r => r.collection_id)).size).toBe(3);
      expect(db(ds).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ds_collections_collection_id'").get()).toBeDefined();
      expect(ds.ensureCollectionIds()).toEqual({ assigned: 0, renumbered: [], failed: null, indexFailed: null });
      expect(ids(ds)).toEqual(after);
    });

    it('a table without an id on a migrated file (written by an older build) gets one at the next boot', () => {
      ds = new DataStore(path);
      ds.createCollection({ name: 'leads', scope: SCOPE, columns: COLS });
      db(ds).prepare("UPDATE ds_collections SET collection_id = NULL WHERE name = 'leads'").run();
      expect(ds.ensureCollectionIds().assigned).toBe(1);
      expect(ds.collectionIdOf('leads')).toMatch(ID);
    });

    it('duplicate ids: the first keeps its id, the others get a new one, named by a valid name only', () => {
      const crafted = 'x"; DROP TABLE y; --\n\u001b[31m';
      legacyFile(path, ['a', 'b', crafted]);
      const raw = new Database(path);
      raw.exec('ALTER TABLE ds_collections ADD COLUMN collection_id TEXT');
      raw.prepare("UPDATE ds_collections SET collection_id = 'dsc_00000000000000dd'").run();
      raw.close();
      ds = new DataStore(path);
      const r = ds.ensureCollectionIds();
      expect(r.assigned).toBe(0);
      expect(r.failed).toBeNull();
      expect(r.indexFailed).toBeNull();
      expect(r.renumbered.map(x => [x.name, x.from])).toEqual([['b', 'dsc_00000000000000dd'], [null, 'dsc_00000000000000dd']]);
      expect(r.renumbered.every(x => ID.test(x.to) && x.to !== x.from)).toBe(true);
      expect(ds.collectionIdOf('a')).toBe('dsc_00000000000000dd');
      expect(new Set(ids(ds).map(x => x.collection_id)).size).toBe(3);
    });

    it('a failing index leaves the column and the ids in place', () => {
      legacyFile(path, ['a']);
      // An index cannot take a name a table already has.
      const raw = new Database(path);
      raw.exec('CREATE TABLE idx_ds_collections_collection_id (x TEXT)');
      raw.close();
      ds = new DataStore(path);
      const r = ds.ensureCollectionIds();
      expect(r.failed).toBeNull();
      expect(r.indexFailed).toMatch(/already/);
      expect(r.assigned).toBe(1);
      expect(ds.collectionIdOf('a')).toMatch(ID);
    });

    it('a store opened before another process migrated the file writes ids once the column is there', () => {
      legacyFile(path, []);
      ds = new DataStore(path);
      expect(ds.hasCollectionIdColumn()).toBe(false);
      other = new DataStore(path);
      other.ensureCollectionIds();
      ds.createCollection({ name: 'later', scope: SCOPE, columns: COLS });
      expect(ds.collectionIdOf('later')).toMatch(ID);
    });

    it('creating without an id survives a failing column check: the table is created, without an id', () => {
      ds = new DataStore(path);
      vi.spyOn(ds, 'hasCollectionIdColumn').mockImplementation(() => { throw new Error('disk I/O error'); });
      expect(() => ds!.createCollection({ name: 'leads', scope: SCOPE, columns: COLS })).not.toThrow();
      vi.restoreAllMocks();
      expect(ds.listCollections().map(c => c.name)).toContain('leads');
      expect(ds.collectionIdOf('leads')).toBeUndefined();
    });
  });
});
