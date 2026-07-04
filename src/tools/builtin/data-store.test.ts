import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../../core/data-store.js';
import {
  dataStoreCreateTool,
  dataStoreInsertTool,
  dataStoreQueryTool,
  dataStoreListTool,
} from './data-store.js';
import { createToolContext } from '../../core/tool-context.js';
import type { IAgent } from '../../types/index.js';

const mockAgent = {
  toolContext: createToolContext({}),
} as unknown as IAgent;

function makeTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-tool-test-'));
  return join(dir, 'test.db');
}

describe('DataStore tools', () => {
  let ds: DataStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    ds = new DataStore(dbPath);
    mockAgent.toolContext.dataStore = ds;
  });

  afterEach(() => {
    mockAgent.toolContext.dataStore = null;
    ds.close();
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  // === data_store_create ===

  describe('data_store_create', () => {
    it('creates a collection', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'test_kpis',
        columns: [
          { name: 'campaign', type: 'string' },
          { name: 'clicks', type: 'number' },
        ],
      }, mockAgent);

      expect(result).toContain('Created collection "test_kpis"');
      expect(result).toContain('campaign (string)');
      expect(result).toContain('clicks (number)');
    });

    it('creates collection with unique key', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'daily_stats',
        columns: [
          { name: 'date', type: 'date' },
          { name: 'campaign', type: 'string' },
          { name: 'spend', type: 'number' },
        ],
        unique_key: ['date', 'campaign'],
      }, mockAgent);

      expect(result).toContain('Unique key: [date, campaign]');
    });

    it('creates collection with scope', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'client_kpis',
        columns: [{ name: 'value', type: 'number' }],
        scope: 'context:acme',
      }, mockAgent);

      expect(result).toContain('context:acme');
    });

    it('returns error for invalid name', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'INVALID',
        columns: [{ name: 'x', type: 'string' }],
      }, mockAgent);

      expect(result).toContain('Error');
    });

    it('returns error for duplicate collection', async () => {
      await dataStoreCreateTool.handler({
        name: 'dupe',
        columns: [{ name: 'x', type: 'string' }],
      }, mockAgent);
      const result = await dataStoreCreateTool.handler({
        name: 'dupe',
        columns: [{ name: 'y', type: 'number' }],
      }, mockAgent);

      expect(result).toContain('Error');
      expect(result).toContain('already exists');
    });

    it('returns unavailable when store is null', async () => {
      mockAgent.toolContext.dataStore = null;
      const result = await dataStoreCreateTool.handler({
        name: 'test',
        columns: [{ name: 'x', type: 'string' }],
      }, mockAgent);
      expect(result).toContain('not available');
    });

    // Record-on-spine R1: a `subject` column must declare its subjectKind (the
    // kind is dedup identity — a silent wrong kind = permanent spine pollution).
    it('rejects a subject column with no subjectKind', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'appointments',
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject' },
        ],
      }, mockAgent);

      expect(result).toContain('subjectKind');
      // Nothing was created.
      expect(ds.listCollections().find(c => c.name === 'appointments')).toBeUndefined();
    });

    it('rejects a subject column with an invalid subjectKind', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'appointments',
        columns: [
          { name: 'patient', type: 'subject', subjectKind: 'patient' },
        ],
      }, mockAgent);

      expect(result).toContain('not valid');
      expect(ds.listCollections().find(c => c.name === 'appointments')).toBeUndefined();
    });

    it('accepts a subject column with a valid subjectKind and resolves through insert', async () => {
      ds.setSubjectBridge({
        resolve: (name, kind) => `subj:${kind}:${name.toLowerCase()}`,
        find: () => null,
        name: () => null,
      });

      const created = await dataStoreCreateTool.handler({
        name: 'appointments',
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      }, mockAgent);
      expect(created).toContain('Created collection "appointments"');
      expect(created).toContain('patient (subject)');

      await dataStoreInsertTool.handler({
        collection: 'appointments',
        records: [{ note: 'first visit', patient: 'Anna Meier' }],
      }, mockAgent);

      const { rows } = ds.queryRecords({ collection: 'appointments' });
      expect(rows[0]!['patient']).toBe('subj:person:anna meier');
    });

    // A subject column resolves BY NAME, so engagement (composite identity) and
    // other (unstructured) are NOT offered — they'd mint a fresh subject per
    // insert. The tool must reject them even though they are real subject kinds.
    it('rejects engagement/other as a subject column kind (not name-deduped)', async () => {
      for (const kind of ['engagement', 'other']) {
        const result = await dataStoreCreateTool.handler({
          name: `projects_${kind}`,
          columns: [{ name: 'ref', type: 'subject', subjectKind: kind }],
        }, mockAgent);
        expect(result).toContain('not valid');
        expect(ds.listCollections().find(c => c.name === `projects_${kind}`)).toBeUndefined();
      }
    });

    it('degrades a subject column to raw-string storage when no resolver is wired (flag off)', async () => {
      // No setSubjectBridge — mirrors subject_graph_enabled === false.
      await dataStoreCreateTool.handler({
        name: 'orders',
        columns: [{ name: 'buyer', type: 'subject', subjectKind: 'person' }],
      }, mockAgent);
      await dataStoreInsertTool.handler({
        collection: 'orders',
        records: [{ buyer: 'Clara Vogt' }],
      }, mockAgent);

      const { rows } = ds.queryRecords({ collection: 'orders' });
      expect(rows[0]!['buyer']).toBe('Clara Vogt');
    });

    // Record-on-spine R2a: an occurred_at role on a date column marks the event
    // time (not insert time). The handler must map it through to the schema, and
    // the store's date-only validation must surface on a wrong column type.
    it('threads an occurred_at role through to the persisted schema (R2a)', async () => {
      const created = await dataStoreCreateTool.handler({
        name: 'events',
        columns: [
          { name: 'label', type: 'string' },
          { name: 'happened_on', type: 'date', role: 'occurred_at' },
        ],
      }, mockAgent);
      expect(created).toContain('Created collection "events"');
      const info = ds.getCollectionInfo('events');
      expect(info?.columns.find(c => c.name === 'happened_on')?.role).toBe('occurred_at');
    });

    it('surfaces the store rejection when occurred_at is set on a non-date column (R2a)', async () => {
      const result = await dataStoreCreateTool.handler({
        name: 'bad_role',
        columns: [{ name: 'when', type: 'string', role: 'occurred_at' }],
      }, mockAgent);
      expect(result).toContain('Only a "date" column');
      expect(ds.listCollections().find(c => c.name === 'bad_role')).toBeUndefined();
    });
  });

  // === data_store_insert ===

  describe('data_store_insert', () => {
    beforeEach(async () => {
      await dataStoreCreateTool.handler({
        name: 'orders',
        columns: [
          { name: 'customer', type: 'string' },
          { name: 'amount', type: 'number' },
        ],
      }, mockAgent);
    });

    it('inserts records', async () => {
      const result = await dataStoreInsertTool.handler({
        collection: 'orders',
        records: [
          { customer: 'Alice', amount: 100 },
          { customer: 'Bob', amount: 200 },
        ],
      }, mockAgent);

      expect(result).toContain('Inserted 2');
      expect(result).toContain('orders');
    });

    it('returns error for non-existent collection', async () => {
      const result = await dataStoreInsertTool.handler({
        collection: 'nonexistent',
        records: [{ x: 1 }],
      }, mockAgent);

      expect(result).toContain('Error');
    });

    it('reports warnings for unknown fields', async () => {
      const result = await dataStoreInsertTool.handler({
        collection: 'orders',
        records: [{ customer: 'Test', amount: 1, extra: 'ignored' }],
      }, mockAgent);

      expect(result).toContain('Inserted 1');
      expect(result).toContain('Warnings');
      expect(result).toContain('unknown field');
    });

    it('returns unavailable when store is null', async () => {
      mockAgent.toolContext.dataStore = null;
      const result = await dataStoreInsertTool.handler({
        collection: 'orders',
        records: [{ customer: 'Test', amount: 1 }],
      }, mockAgent);
      expect(result).toContain('not available');
    });
  });

  // === data_store_query ===

  describe('data_store_query', () => {
    beforeEach(async () => {
      await dataStoreCreateTool.handler({
        name: 'products',
        columns: [
          { name: 'name', type: 'string' },
          { name: 'price', type: 'number' },
          { name: 'category', type: 'string' },
        ],
      }, mockAgent);
      await dataStoreInsertTool.handler({
        collection: 'products',
        records: [
          { name: 'Widget', price: 10, category: 'A' },
          { name: 'Gadget', price: 20, category: 'B' },
          { name: 'Gizmo', price: 30, category: 'A' },
        ],
      }, mockAgent);
    });

    it('queries all records', async () => {
      const result = await dataStoreQueryTool.handler({
        collection: 'products',
      }, mockAgent);

      expect(result).toContain('3 of 3');
      expect(result).toContain('Widget');
      expect(result).toContain('raw_json');
    });

    it('queries with filter', async () => {
      const result = await dataStoreQueryTool.handler({
        collection: 'products',
        filter: { category: 'A' },
      }, mockAgent);

      expect(result).toContain('2 of 2');
    });

    it('queries with aggregation', async () => {
      const result = await dataStoreQueryTool.handler({
        collection: 'products',
        aggregate: {
          group_by: ['category'],
          metrics: [{ field: 'price', fn: 'sum', alias: 'total_price' }],
        },
      }, mockAgent);

      expect(result).toContain('total_price');
    });

    it('returns no results message', async () => {
      const result = await dataStoreQueryTool.handler({
        collection: 'products',
        filter: { name: 'NonExistent' },
      }, mockAgent);

      expect(result).toContain('No results found');
    });

    it('returns error for non-existent collection', async () => {
      const result = await dataStoreQueryTool.handler({
        collection: 'nonexistent',
      }, mockAgent);

      expect(result).toContain('Error');
    });

    it('returns unavailable when store is null', async () => {
      mockAgent.toolContext.dataStore = null;
      const result = await dataStoreQueryTool.handler({
        collection: 'products',
      }, mockAgent);
      expect(result).toContain('not available');
    });
  });

  // === data_store_query — subject columns (R1.5) ===
  // The agent-facing round-trip: create + insert BY NAME, then query BY NAME and
  // see the NAME rendered — the whole point of the subject-column query slice.
  describe('data_store_query subject columns (R1.5)', () => {
    function wireBridge(): void {
      const idByKey = new Map<string, string>();
      const nameById = new Map<string, string>();
      let n = 0;
      const key = (name: string, kind: string): string => `${kind}::${name.toLowerCase()}`;
      ds.setSubjectBridge({
        resolve(name, kind) {
          const k = key(name, kind);
          let id = idByKey.get(k);
          if (id === undefined) { n += 1; id = `s${String(n)}`; idByKey.set(k, id); nameById.set(id, name); }
          return id;
        },
        find(name, kind) { return idByKey.get(key(name, kind)) ?? null; },
        name(id) { return nameById.get(id) ?? null; },
      });
    }

    it('filters by the linked name and renders the name, not the id', async () => {
      wireBridge();
      await dataStoreCreateTool.handler({
        name: 'appointments',
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      }, mockAgent);
      await dataStoreInsertTool.handler({
        collection: 'appointments',
        records: [{ note: 'x', patient: 'Anna Meier' }, { note: 'y', patient: 'Ben Roth' }],
      }, mockAgent);

      const result = await dataStoreQueryTool.handler({
        collection: 'appointments',
        filter: { patient: 'Anna Meier' },
      }, mockAgent);

      expect(result).toContain('1 of 1');
      expect(result).toContain('Anna Meier'); // hydrated display name
      expect(result).not.toContain('Ben Roth'); // filtered out
      expect(result).toContain('x');
    });

    it('an unknown name yields no results (find-only, no mint)', async () => {
      wireBridge();
      await dataStoreCreateTool.handler({
        name: 'appointments',
        columns: [{ name: 'patient', type: 'subject', subjectKind: 'person' }],
      }, mockAgent);
      await dataStoreInsertTool.handler({
        collection: 'appointments',
        records: [{ patient: 'Anna Meier' }],
      }, mockAgent);

      const result = await dataStoreQueryTool.handler({
        collection: 'appointments',
        filter: { patient: 'Nobody' },
      }, mockAgent);
      expect(result).toContain('No results found');
    });
  });

  // === data_store_list ===

  describe('data_store_list', () => {
    it('lists collections', async () => {
      await dataStoreCreateTool.handler({
        name: 'coll_a',
        columns: [{ name: 'x', type: 'string' }],
      }, mockAgent);
      await dataStoreCreateTool.handler({
        name: 'coll_b',
        columns: [{ name: 'y', type: 'number' }],
      }, mockAgent);

      const result = await dataStoreListTool.handler({}, mockAgent);

      expect(result).toContain('coll_a');
      expect(result).toContain('coll_b');
      expect(result).toContain('0 records');
    });

    it('returns no collections message', async () => {
      const result = await dataStoreListTool.handler({}, mockAgent);
      expect(result).toContain('No data tables found');
    });

    it('includes schema when requested', async () => {
      await dataStoreCreateTool.handler({
        name: 'schema_test',
        columns: [
          { name: 'email', type: 'string', unique: true },
          { name: 'score', type: 'number' },
        ],
      }, mockAgent);

      const result = await dataStoreListTool.handler({ include_schema: true }, mockAgent);

      expect(result).toContain('email: string (unique)');
      expect(result).toContain('score: number');
    });

    it('returns unavailable when store is null', async () => {
      mockAgent.toolContext.dataStore = null;
      const result = await dataStoreListTool.handler({}, mockAgent);
      expect(result).toContain('not available');
    });
  });

  // === Tool definitions ===

  describe('tool definitions', () => {
    it('has correct tool names', () => {
      expect(dataStoreCreateTool.definition.name).toBe('data_store_create');
      expect(dataStoreInsertTool.definition.name).toBe('data_store_insert');
      expect(dataStoreQueryTool.definition.name).toBe('data_store_query');
      expect(dataStoreListTool.definition.name).toBe('data_store_list');
    });

    it('has eager_input_streaming enabled', () => {
      expect(dataStoreCreateTool.definition.eager_input_streaming).toBe(true);
      expect(dataStoreInsertTool.definition.eager_input_streaming).toBe(true);
      expect(dataStoreQueryTool.definition.eager_input_streaming).toBe(true);
      expect(dataStoreListTool.definition.eager_input_streaming).toBe(true);
    });
  });
});
