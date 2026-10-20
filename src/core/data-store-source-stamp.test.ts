import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DataStore, SOURCE_COLUMNS, type RowStamp } from './data-store.js';
import { CRM } from './crm.js';
import { ConversationGrants, UNKNOWN_GRANT } from './conversation-grants.js';
import { createToolContext } from './tool-context.js';
import { dataStoreInsertTool } from '../tools/builtin/data-store.js';
import { contactsSaveTool } from '../tools/builtin/contacts.js';
import { dataStoreWriter } from './bulk-apply.js';
import type { IAgent } from '../types/index.js';

/**
 * The DataStore's source stamp (PRD connection-attribution A5, the columns): what a write
 * records, how an upsert unions it, that no read but the export returns it, and the boot
 * migration that adds the columns to tables created before them.
 */

const SCOPE = { type: 'global' as const, id: '' };
const stamp = (grants: readonly string[] | null, runId: string | null = null): RowStamp => ({ grants, runId });

describe('DataStore source stamp', () => {
  let dir: string;
  let path: string;
  let ds: DataStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-ds-stamp-'));
    path = join(dir, 'datastore.db');
    ds = new DataStore(path);
  });

  afterEach(() => {
    try { ds.close(); } catch { /* closed by the test */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const db = (): Database.Database => ds['db'] as Database.Database;
  const raw = (collection: string): Array<{ _source_grants: string | null; _source_run_id: string | null }> =>
    db().prepare(`SELECT _source_grants, _source_run_id FROM "ds_${collection}" ORDER BY _id`).all() as Array<{ _source_grants: string | null; _source_run_id: string | null }>;
  const grantsOf = (collection: string): Array<string[] | null> =>
    raw(collection).map(r => r._source_grants === null ? null : JSON.parse(r._source_grants) as string[]);

  const keyed = (name = 'leads'): void => {
    ds.createCollection({ name, scope: SCOPE, columns: [{ name: 'email', type: 'string' }, { name: 'note', type: 'string' }], uniqueKey: ['email'] });
  };

  describe('what a write records', () => {
    it('stores the grants sorted and de-duplicated, with the run id', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x', note: 'n' }], stamp: stamp(['g-b', 'g-a', 'g-b'], 'run-1') });
      expect(raw('leads')).toEqual([{ _source_grants: '["g-a","g-b"]', _source_run_id: 'run-1' }]);
    });

    it('stores an empty set as [], and a missing set as unknown', () => {
      ds.createCollection({ name: 'plain', scope: SCOPE, columns: [{ name: 'v', type: 'string' }] });
      ds.insertRecords({ collection: 'plain', records: [{ v: 'nothing resolved' }], stamp: stamp([]) });
      ds.insertRecords({ collection: 'plain', records: [{ v: 'no set' }], stamp: stamp(null) });
      expect(grantsOf('plain')).toEqual([[], [UNKNOWN_GRANT]]);
    });

    it('putRowVerbatim records the stamp on insert', () => {
      keyed();
      ds.putRowVerbatim('leads', { email: 'a@x', note: 'n' }, stamp(['g-a'], 'run-2'));
      expect(raw('leads')).toEqual([{ _source_grants: '["g-a"]', _source_run_id: 'run-2' }]);
    });

    it('a write without a stamp throws before anything is written', () => {
      keyed();
      // Through an untyped caller (a test or script tsc does not check): the record must
      // not turn into a per-record warning and a skipped row.
      const insert = ds.insertRecords.bind(ds) as unknown as (p: { collection: string; records: Record<string, unknown>[] }) => unknown;
      expect(() => insert({ collection: 'leads', records: [{ email: 'a@x' }] })).toThrow(TypeError);
      const put = ds.putRowVerbatim.bind(ds) as unknown as (c: string, r: Record<string, unknown>) => unknown;
      expect(() => put('leads', { email: 'b@x' })).toThrow(TypeError);
      expect(raw('leads')).toEqual([]);
    });
  });

  describe('an upsert unions the grants', () => {
    const upsert = (grants: readonly string[] | null, runId: string | null = null): void => {
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x', note: 'n' }], stamp: stamp(grants, runId) });
    };
    const setStored = (value: string | null): void => {
      db().prepare('UPDATE ds_leads SET _source_grants = ?').run(value);
    };

    beforeEach(() => keyed());

    it('[A] then [B] reads [A, B], and the run id is the last writer\'s', () => {
      upsert(['g-a'], 'run-1');
      upsert(['g-b'], 'run-2');
      expect(raw('leads')).toEqual([{ _source_grants: '["g-a","g-b"]', _source_run_id: 'run-2' }]);
    });

    it('a row from before the columns (NULL) updated from A reads [A, unknown]', () => {
      upsert(['g-x']);
      setStored(null);
      upsert(['g-a']);
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });

    it('a row stored with [] updated from A reads [A, unknown]', () => {
      upsert([]);
      upsert(['g-a']);
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });

    it('a row stored with [A] updated with [] reads [A, unknown]', () => {
      upsert(['g-a']);
      upsert([]);
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });

    it('[A, unknown] updated with [] stays [A, unknown]', () => {
      upsert(['g-a', UNKNOWN_GRANT]);
      upsert([]);
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });

    it('putRowVerbatim unions the same way, and a writer without a set adds unknown', () => {
      upsert(['g-a'], 'run-1');
      ds.putRowVerbatim('leads', { email: 'a@x', note: 'changed' }, stamp(null));
      expect(raw('leads')).toEqual([{ _source_grants: '["g-a","unknown"]', _source_run_id: null }]);
    });

    it('putRowVerbatim on a NULL row adds unknown beside the new grant', () => {
      upsert(['g-x']);
      setStored(null);
      ds.putRowVerbatim('leads', { email: 'a@x', note: 'n' }, stamp(['g-a']));
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });
  });

  describe('no read but the export returns the stamp', () => {
    beforeEach(() => {
      ds.createCollection({ name: 'deals', scope: SCOPE, columns: [{ name: 'title', type: 'string' }, { name: 'org', type: 'subject', subjectKind: 'organization' }] });
      ds.insertRecords({ collection: 'deals', records: [{ title: 't', org: 'subj-1' }], stamp: stamp(['g-a'], 'run-1') });
    });

    it('queryRecords leaves both columns out', () => {
      const { rows } = ds.queryRecords({ collection: 'deals' });
      expect(rows).toHaveLength(1);
      for (const col of SOURCE_COLUMNS) expect(rows[0]).not.toHaveProperty(col);
      expect(rows[0]).toMatchObject({ title: 't', org: 'subj-1' });
      expect(rows[0]).toHaveProperty('_id');
    });

    it('getRecordsForSubject leaves both columns out', () => {
      const { occurrences } = ds.getRecordsForSubject('subj-1');
      expect(occurrences).toHaveLength(1);
      for (const col of SOURCE_COLUMNS) expect(occurrences[0]!.row).not.toHaveProperty(col);
      expect(occurrences[0]!.row).toMatchObject({ title: 't' });
    });

    it('listRecordsForExport returns both columns', () => {
      const rows = ds.listRecordsForExport({ collection: 'deals', limit: 10 });
      expect(rows[0]).toMatchObject({ title: 't', _source_grants: '["g-a"]', _source_run_id: 'run-1' });
    });

    it('a filter, a sort or an aggregate cannot name a source column', () => {
      expect(() => ds.queryRecords({ collection: 'deals', filter: { _source_grants: '["g-a"]' } })).toThrow();
      expect(() => ds.queryRecords({ collection: 'deals', sort: [{ field: '_source_run_id', order: 'asc' }] })).toThrow();
      expect(() => ds.queryRecords({ collection: 'deals', aggregate: { groupBy: ['_source_grants'], metrics: [{ field: '_id', fn: 'count' }] } })).toThrow();
      expect(() => ds.deleteRecords({ collection: 'deals', filter: { _source_run_id: 'run-1' } })).toThrow();
    });
  });

  describe('the boot migration', () => {
    /** A collection as `createCollection` made it before the source columns, with one row. */
    const oldTable = (name: string): void => {
      db().exec(`CREATE TABLE "ds_${name}" (_id INTEGER PRIMARY KEY AUTOINCREMENT, _created_at TEXT NOT NULL, _updated_at TEXT NOT NULL, "v" TEXT)`);
      db().prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES (?, 'global', '', ?, NULL, 1, 'x', 'x')")
        .run(name, JSON.stringify([{ name: 'v', type: 'string' }]));
      db().prepare(`INSERT INTO "ds_${name}" (_created_at, _updated_at, v) VALUES ('x', 'x', 'old')`).run();
    };
    const columnsOf = (name: string): string[] =>
      (db().prepare('SELECT name FROM pragma_table_info(?)').all(`ds_${name}`) as Array<{ name: string }>).map(c => c.name);

    it('adds both columns to an older table, keeps its rows NULL, and runs once', () => {
      oldTable('old');
      expect(ds.ensureSourceColumns()).toEqual({ migrated: ['old'], missing: [], invalid: [], failed: [] });
      expect(columnsOf('old')).toEqual(expect.arrayContaining([...SOURCE_COLUMNS]));
      expect(raw('old')).toEqual([{ _source_grants: null, _source_run_id: null }]);
      expect(ds.ensureSourceColumns()).toEqual({ migrated: [], missing: [], invalid: [], failed: [] });
    });

    it('opening a store does not migrate it: only ensureSourceColumns does', () => {
      oldTable('old');
      ds.close();
      ds = new DataStore(path);
      expect(columnsOf('old')).not.toContain('_source_grants');
      expect(() => ds.insertRecords({ collection: 'old', records: [{ v: 'new' }], stamp: stamp([]) })).toThrow(/has not been migrated/);
      expect(db().prepare('SELECT COUNT(*) AS n FROM ds_old').get()).toEqual({ n: 1 });
    });

    it('a table that cannot be migrated is reported and refuses writes; the others migrate and take writes', () => {
      oldTable('good');
      // A view where the table should be: it has columns, but ALTER TABLE cannot add one.
      db().exec(`CREATE VIEW "ds_broken" AS SELECT 1 AS _id, 'x' AS _created_at, 'x' AS _updated_at, 'v' AS v`);
      db().prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES ('broken', 'global', '', ?, NULL, 0, 'x', 'x')")
        .run(JSON.stringify([{ name: 'v', type: 'string' }]));

      let result: ReturnType<DataStore['ensureSourceColumns']> | undefined;
      expect(() => { result = ds.ensureSourceColumns(); }).not.toThrow();
      expect(result!.migrated).toEqual(['good']);
      expect(result!.failed.map(f => f.collection)).toEqual(['broken']);

      expect(() => ds.insertRecords({ collection: 'broken', records: [{ v: 'x' }], stamp: stamp([]) })).toThrow(/has not been migrated/);
      ds.insertRecords({ collection: 'good', records: [{ v: 'new' }], stamp: stamp(['g-a']) });
      expect(grantsOf('good')).toEqual([null, ['g-a']]);
    });

    it('a listed table without a database table is reported as missing, not thrown', () => {
      db().prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES ('ghost', 'global', '', '[]', NULL, 0, 'x', 'x')").run();
      oldTable('real');
      expect(ds.ensureSourceColumns()).toEqual({ migrated: ['real'], missing: ['ghost'], invalid: [], failed: [] });
      expect(() => ds.insertRecords({ collection: 'ghost', records: [{ v: 'x' }], stamp: stamp([]) })).toThrow(/listed but has no data/);
    });

    it('a listed name that is not a valid table name is reported and runs nothing', () => {
      // A file not written by createCollection: a table whose quoted name carries SQL.
      const crafted = `a" ADD COLUMN "z" TEXT; CREATE TABLE pwn(x); --`;
      oldTable('a');
      db().exec(`CREATE TABLE "ds_${crafted.replace(/"/g, '""')}" (_id INTEGER PRIMARY KEY, _created_at TEXT, _updated_at TEXT)`);
      db().prepare("INSERT INTO ds_collections (name, scope_type, scope_id, schema_json, unique_key, record_count, created_at, updated_at) VALUES (?, 'global', '', '[]', NULL, 0, 'x', 'x')").run(crafted);

      expect(ds.ensureSourceColumns()).toEqual({ migrated: ['a'], missing: [], invalid: [crafted], failed: [] });
      expect(columnsOf('a')).not.toContain('z');
      expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'pwn'").all()).toEqual([]);
    });

    it('the column is added by one statement only', () => {
      oldTable('a');
      const add = (ds as unknown as { _addSourceColumn: (t: string, c: string) => void })._addSourceColumn.bind(ds);
      expect(() => add('ds_a" ADD COLUMN "z" TEXT; CREATE TABLE pwn(x); --', '_source_grants')).toThrow();
      expect(columnsOf('a')).not.toContain('z');
      expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'pwn'").all()).toEqual([]);
    });

    it('dropCollection takes the columns with the table', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp(['g-a']) });
      ds.dropCollection('leads');
      expect(columnsOf('leads')).toEqual([]);
    });
  });

  describe('bulk apply, which holds no grant set', () => {
    beforeEach(() => keyed());

    it('an update keeps the row\'s grants and adds unknown', async () => {
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x', note: 'n' }], stamp: stamp(['g-a'], 'run-1') });
      const writer = dataStoreWriter(ds, 'leads')!;
      await writer.write('a@x', { absent: false, value: { email: 'a@x', note: 'bulk' } });
      expect(grantsOf('leads')).toEqual([['g-a', UNKNOWN_GRANT]]);
    });

    it('a row it creates, or restores on undo, reads unknown only', async () => {
      const writer = dataStoreWriter(ds, 'leads')!;
      await writer.write('new@x', { absent: false, value: { email: 'new@x', note: 'bulk' } });
      expect(grantsOf('leads')).toEqual([[UNKNOWN_GRANT]]);
    });

    it('its before-image carries no source column, so a restore cannot write one', async () => {
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x', note: 'n' }], stamp: stamp(['g-a']) });
      const before = await dataStoreWriter(ds, 'leads')!.read('a@x', null);
      expect(before).toEqual({ absent: false, value: { email: 'a@x', note: 'n' } });
    });
  });

  describe('source guards', () => {
    const srcRoot = join(import.meta.dirname, '..');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(d, e.name)] : []);

    it('data-store.ts reads whole collection rows only in the export', () => {
      const text = readFileSync(join(import.meta.dirname, 'data-store.ts'), 'utf8');
      // Either spelling of a collection table (`"${tableName}"`, `"ds_${…}"`), a qualified
      // `t.*`, and a line break between the words.
      const hits = [...text.matchAll(/SELECT\s+(?:\w+\.)?\*\s+FROM\s+"(?:ds_|\$\{)/g)].map(m => m.index);
      const start = text.indexOf('listRecordsForExport(params');
      const end = text.indexOf('\n  }\n', start);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBeGreaterThan(start);
      expect(hits[0]).toBeLessThan(end);
    });

    it('only the engine migrates: no other source file calls ensureSourceColumns', () => {
      // With "opening a store does not migrate it" above, this is why the operator scripts,
      // which open a tenant's live store to report on it, leave its schema alone.
      const callers = walk(srcRoot).filter(f => /\.ensureSourceColumns\(/.test(readFileSync(f, 'utf8')));
      expect(callers.map(f => f.slice(srcRoot.length + 1))).toEqual(['core/engine.ts']);
    });
  });

  describe('the writers stamp what the writing agent holds', () => {
    const agentWith = (grants: ConversationGrants | undefined, runId?: string): IAgent => {
      const toolContext = createToolContext({});
      toolContext.dataStore = ds;
      toolContext.crm = new CRM(ds);
      return { toolContext, conversationGrants: grants, currentRunId: runId } as unknown as IAgent;
    };

    it('data_store_insert writes the conversation\'s set and the run id', async () => {
      ds.createCollection({ name: 'notes', scope: SCOPE, columns: [{ name: 'v', type: 'string' }] });
      const set = ConversationGrants.detached();
      set.add('g-a');
      await dataStoreInsertTool.handler({ collection: 'notes', records: [{ v: 'x' }] }, agentWith(set, 'run-7'));
      expect(raw('notes')).toEqual([{ _source_grants: '["g-a"]', _source_run_id: 'run-7' }]);
    });

    // That a step and a child get the conversation's set object itself is K7's wiring and is
    // pinned there (runtime-adapter.test.ts, spawn.test.ts). This pins the half K8 adds: the
    // write reads the shared set when it happens, not a copy taken earlier.
    it('a writer sharing a set reads, at write time, what another holder added before', async () => {
      ds.createCollection({ name: 'notes', scope: SCOPE, columns: [{ name: 'v', type: 'string' }] });
      const shared = ConversationGrants.detached();
      const earlier = agentWith(shared, 'step-1');
      const later = agentWith(shared, 'step-2');
      earlier.conversationGrants!.add('g-a');
      await dataStoreInsertTool.handler({ collection: 'notes', records: [{ v: 'x' }] }, later);
      expect(raw('notes')).toEqual([{ _source_grants: '["g-a"]', _source_run_id: 'step-2' }]);
    });

    it('an agent with no set writes unknown', async () => {
      ds.createCollection({ name: 'notes', scope: SCOPE, columns: [{ name: 'v', type: 'string' }] });
      await dataStoreInsertTool.handler({ collection: 'notes', records: [{ v: 'x' }] }, agentWith(undefined));
      expect(grantsOf('notes')).toEqual([[UNKNOWN_GRANT]]);
    });

    it('contacts_save writes the conversation\'s set and the run id', async () => {
      const set = ConversationGrants.detached();
      set.add('g-c');
      const out = await contactsSaveTool.handler({ name: 'Ada', email: 'ada@x' }, agentWith(set, 'run-9'));
      expect(out).toContain('Saved contact');
      expect(raw('contacts')).toEqual([{ _source_grants: '["g-c"]', _source_run_id: 'run-9' }]);
    });
  });
});
