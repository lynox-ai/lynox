import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DataStore } from './data-store.js';
import type { SubjectColumnBridge } from './subject-store.js';
import type { MemoryScopeRef } from '../types/index.js';

const scope: MemoryScopeRef = { type: 'context', id: 'test-proj' };

function makeTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
  return join(dir, 'test.db');
}

// A findOrCreate-shaped bridge stub for the `subject`-column tests: `resolve`
// dedups by (kind, lowercased name), mints a stable id per identity, and records
// every call so tests can assert the kind was threaded through. `find` is the
// get-ONLY twin (no create), and `name` reverses id → the original name — the
// R1.5 query round-trip — all without touching engine.db.
function makeStubBridge(): { bridge: SubjectColumnBridge; calls: Array<{ name: string; kind: string }> } {
  const idByKey = new Map<string, string>();
  const nameById = new Map<string, string>();
  const calls: Array<{ name: string; kind: string }> = [];
  let counter = 0;
  const keyOf = (name: string, kind: string): string => `${kind}::${name.toLowerCase()}`;
  const bridge: SubjectColumnBridge = {
    resolve(name, kind) {
      calls.push({ name, kind });
      const key = keyOf(name, kind);
      let id = idByKey.get(key);
      if (id === undefined) { counter += 1; id = `subj-${String(counter)}`; idByKey.set(key, id); nameById.set(id, name); }
      return id;
    },
    find(name, kind) { return idByKey.get(keyOf(name, kind)) ?? null; },
    name(id) { return nameById.get(id) ?? null; },
  };
  return { bridge, calls };
}

describe('DataStore', () => {
  let ds: DataStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    ds = new DataStore(dbPath);
  });

  afterEach(() => {
    ds.close();
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  // === Collection Creation ===

  describe('createCollection', () => {
    it('creates a collection with typed columns', () => {
      const info = ds.createCollection({
        name: 'kpis',
        scope,
        columns: [
          { name: 'campaign', type: 'string' },
          { name: 'clicks', type: 'number' },
          { name: 'date', type: 'date' },
        ],
      });

      expect(info.name).toBe('kpis');
      expect(info.scopeType).toBe('context');
      expect(info.scopeId).toBe('test-proj');
      expect(info.columns).toHaveLength(3);
      expect(info.recordCount).toBe(0);
      expect(info.uniqueKey).toBeNull();
    });

    it('creates collection with unique key', () => {
      const info = ds.createCollection({
        name: 'daily_stats',
        scope,
        columns: [
          { name: 'campaign', type: 'string' },
          { name: 'date', type: 'date' },
          { name: 'clicks', type: 'number' },
        ],
        uniqueKey: ['campaign', 'date'],
      });

      expect(info.uniqueKey).toEqual(['campaign', 'date']);
    });

    it('rejects invalid collection names', () => {
      expect(() => ds.createCollection({
        name: 'Invalid',
        scope,
        columns: [{ name: 'x', type: 'string' }],
      })).toThrow('is not valid');
    });

    it('rejects reserved names', () => {
      expect(() => ds.createCollection({
        name: 'meta',
        scope,
        columns: [{ name: 'x', type: 'string' }],
      })).toThrow('reserved');
    });

    it('rejects duplicate collection names', () => {
      ds.createCollection({ name: 'test', scope, columns: [{ name: 'x', type: 'string' }] });
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [{ name: 'y', type: 'string' }],
      })).toThrow('already exists');
    });

    it('rejects empty columns', () => {
      expect(() => ds.createCollection({
        name: 'empty',
        scope,
        columns: [],
      })).toThrow('At least one column');
    });

    it('rejects invalid column names', () => {
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [{ name: 'Invalid-Name', type: 'string' }],
      })).toThrow('is not valid');
    });

    it('rejects reserved column names', () => {
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [{ name: '_id', type: 'number' }],
      })).toThrow(); // _id rejected by name regex (underscore prefix) or reserved check
    });

    it('rejects duplicate column names', () => {
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [
          { name: 'x', type: 'string' },
          { name: 'x', type: 'number' },
        ],
      })).toThrow('Duplicate column name');
    });

    it('rejects invalid column types', () => {
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [{ name: 'x', type: 'invalid' as never }],
      })).toThrow('is not supported');
    });

    it('rejects unique key referencing non-existent column', () => {
      expect(() => ds.createCollection({
        name: 'test',
        scope,
        columns: [{ name: 'x', type: 'string' }],
        uniqueKey: ['y'],
      })).toThrow('not defined in the table');
    });

    it('supports all column types', () => {
      const info = ds.createCollection({
        name: 'all_types',
        scope,
        columns: [
          { name: 'str', type: 'string' },
          { name: 'num', type: 'number' },
          { name: 'dt', type: 'date' },
          { name: 'flag', type: 'boolean' },
          { name: 'data', type: 'json' },
        ],
      });
      expect(info.columns).toHaveLength(5);
    });

    it('supports unique column constraint', () => {
      ds.createCollection({
        name: 'unique_col',
        scope,
        columns: [{ name: 'email', type: 'string', unique: true }],
      });
      ds.insertRecords({ collection: 'unique_col', records: [{ email: 'a@b.com' }] });
      const result = ds.insertRecords({ collection: 'unique_col', records: [{ email: 'a@b.com' }] });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // === Insert Records ===

  describe('insertRecords', () => {
    beforeEach(() => {
      ds.createCollection({
        name: 'ads',
        scope,
        columns: [
          { name: 'campaign', type: 'string' },
          { name: 'clicks', type: 'number' },
          { name: 'active', type: 'boolean' },
        ],
      });
    });

    it('inserts records and updates count', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [
          { campaign: 'Brand', clicks: 100, active: true },
          { campaign: 'Search', clicks: 200, active: false },
        ],
      });

      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.errors).toHaveLength(0);

      const info = ds.getCollectionInfo('ads');
      expect(info?.recordCount).toBe(2);
    });

    it('counts upserts correctly when records carry unknown fields (no negative/under-count)', () => {
      ds.createCollection({
        name: 'up',
        scope,
        columns: [
          { name: 'email', type: 'string' },
          { name: 'name', type: 'string' },
        ],
        uniqueKey: ['email'], // enables ON CONFLICT DO UPDATE (upsert)
      });
      ds.insertRecords({ collection: 'up', records: [{ email: 'a@b.com', name: 'A' }] });
      // Update the existing row + insert a new one; BOTH carry an unknown field,
      // which pushes a NON-fatal "unknown field ignored" warning into `errors`.
      const result = ds.insertRecords({
        collection: 'up',
        records: [
          { email: 'a@b.com', name: 'A2', bogus: 1 }, // update
          { email: 'c@d.com', name: 'C', bogus: 2 },  // insert
        ],
      });
      expect(result.inserted).toBe(1);
      // Pre-fix `updated` used `records.length - errors.length`, so the two
      // warnings were counted as failures and `updated` went NEGATIVE (-1).
      expect(result.updated).toBe(1);
    });

    it('handles empty records', () => {
      const result = ds.insertRecords({ collection: 'ads', records: [] });
      expect(result.inserted).toBe(0);
    });

    it('rejects non-existent collection', () => {
      expect(() => ds.insertRecords({
        collection: 'nonexistent',
        records: [{ x: 1 }],
      })).toThrow('not found');
    });

    it('rejects batch exceeding limit', () => {
      const records = Array.from({ length: 1001 }, (_, i) => ({ campaign: `c${i}`, clicks: i, active: true }));
      expect(() => ds.insertRecords({ collection: 'ads', records })).toThrow('Maximum 1000');
    });

    it('coerces number values', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [{ campaign: 'Test', clicks: '42', active: true }],
      });
      expect(result.inserted).toBe(1);

      const { rows } = ds.queryRecords({ collection: 'ads' });
      expect(rows[0]!['clicks']).toBe(42);
    });

    it('coerces boolean values', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [{ campaign: 'Test', clicks: 0, active: 'true' }],
      });
      expect(result.inserted).toBe(1);

      const { rows } = ds.queryRecords({ collection: 'ads' });
      expect(rows[0]!['active']).toBe(1);
    });

    it('warns about unknown fields', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [{ campaign: 'Test', clicks: 1, active: true, unknown_field: 'x' }],
      });
      expect(result.inserted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('unknown field');
    });

    it('handles null values', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [{ campaign: 'Test' }],
      });
      expect(result.inserted).toBe(1);

      const { rows } = ds.queryRecords({ collection: 'ads' });
      expect(rows[0]!['clicks']).toBeNull();
    });

    it('reports coercion errors per record', () => {
      const result = ds.insertRecords({
        collection: 'ads',
        records: [
          { campaign: 'Good', clicks: 10, active: true },
          { campaign: 'Bad', clicks: 'notanumber', active: true },
        ],
      });
      // The 'notanumber' will coerce to NaN for REAL type — but Number('notanumber') = NaN which fails
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // === Upsert ===

  describe('upsert', () => {
    beforeEach(() => {
      ds.createCollection({
        name: 'metrics',
        scope,
        columns: [
          { name: 'date', type: 'date' },
          { name: 'campaign', type: 'string' },
          { name: 'spend', type: 'number' },
        ],
        uniqueKey: ['date', 'campaign'],
      });
    });

    it('inserts new records', () => {
      const result = ds.insertRecords({
        collection: 'metrics',
        records: [{ date: '2026-01-01', campaign: 'Brand', spend: 100 }],
      });
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('updates existing records on conflict', () => {
      ds.insertRecords({
        collection: 'metrics',
        records: [{ date: '2026-01-01', campaign: 'Brand', spend: 100 }],
      });

      const result = ds.insertRecords({
        collection: 'metrics',
        records: [{ date: '2026-01-01', campaign: 'Brand', spend: 150 }],
      });
      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(0);

      const { rows } = ds.queryRecords({ collection: 'metrics' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['spend']).toBe(150);
    });
  });

  // === Query ===

  describe('queryRecords', () => {
    beforeEach(() => {
      ds.createCollection({
        name: 'orders',
        scope,
        columns: [
          { name: 'customer', type: 'string' },
          { name: 'amount', type: 'number' },
          { name: 'status', type: 'string' },
          { name: 'region', type: 'string' },
        ],
      });
      ds.insertRecords({
        collection: 'orders',
        records: [
          { customer: 'Alice', amount: 100, status: 'paid', region: 'EU' },
          { customer: 'Bob', amount: 200, status: 'pending', region: 'US' },
          { customer: 'Charlie', amount: 50, status: 'paid', region: 'EU' },
          { customer: 'Diana', amount: 300, status: 'paid', region: 'US' },
          { customer: 'Eve', amount: 75, status: 'pending', region: 'EU' },
        ],
      });
    });

    it('returns all records by default', () => {
      const { rows, total } = ds.queryRecords({ collection: 'orders' });
      expect(total).toBe(5);
      expect(rows).toHaveLength(5);
    });

    it('filters by equality', () => {
      const { rows, total } = ds.queryRecords({
        collection: 'orders',
        filter: { status: 'paid' },
      });
      expect(total).toBe(3);
      expect(rows).toHaveLength(3);
    });

    it('filters with $gt', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { amount: { $gt: 100 } },
      });
      expect(rows).toHaveLength(2);
    });

    it('filters with $gte and $lte', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { amount: { $gte: 75, $lte: 200 } },
      });
      expect(rows).toHaveLength(3);
    });

    it('filters with $in', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { customer: { $in: ['Alice', 'Bob'] } },
      });
      expect(rows).toHaveLength(2);
    });

    it('filters with $nin', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { customer: { $nin: ['Alice', 'Bob'] } },
      });
      expect(rows).toHaveLength(3);
    });

    it('filters with $like', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { customer: { $like: '%li%' } },
      });
      expect(rows).toHaveLength(2); // Alice, Charlie
    });

    it('filters with $is_null', () => {
      ds.insertRecords({
        collection: 'orders',
        records: [{ customer: 'Frank', amount: 0, status: 'draft' }],
      });
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { region: { $is_null: true } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['customer']).toBe('Frank');
    });

    it('filters with $or', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { $or: [{ status: 'pending' }, { amount: { $gt: 200 } }] },
      });
      expect(rows).toHaveLength(3); // Bob, Diana, Eve
    });

    it('filters with $neq', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        filter: { status: { $neq: 'paid' } },
      });
      expect(rows).toHaveLength(2);
    });

    it('sorts ascending', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        sort: [{ field: 'amount', order: 'asc' }],
      });
      expect(rows[0]!['customer']).toBe('Charlie');
      expect(rows[4]!['customer']).toBe('Diana');
    });

    it('sorts descending', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        sort: [{ field: 'amount', order: 'desc' }],
      });
      expect(rows[0]!['customer']).toBe('Diana');
    });

    it('respects limit and offset', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        sort: [{ field: 'amount', order: 'asc' }],
        limit: 2,
        offset: 1,
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]!['customer']).toBe('Eve');
    });

    it('caps limit at 500', () => {
      const { rows } = ds.queryRecords({
        collection: 'orders',
        limit: 1000,
      });
      expect(rows).toHaveLength(5); // all fit within 500
    });

    it('rejects unknown column in filter', () => {
      expect(() => ds.queryRecords({
        collection: 'orders',
        filter: { nonexistent: 'x' },
      })).toThrow('No column named');
    });

    it('rejects unknown column in sort', () => {
      expect(() => ds.queryRecords({
        collection: 'orders',
        sort: [{ field: 'nonexistent', order: 'asc' }],
      })).toThrow('no such column');
    });

    it('rejects unknown operator', () => {
      expect(() => ds.queryRecords({
        collection: 'orders',
        filter: { amount: { $badop: 5 } },
      })).toThrow('is not recognized');
    });

    it('rejects non-existent collection', () => {
      expect(() => ds.queryRecords({ collection: 'nope' })).toThrow('not found');
    });
  });

  // === Aggregation ===

  describe('aggregation', () => {
    beforeEach(() => {
      ds.createCollection({
        name: 'sales',
        scope,
        columns: [
          { name: 'region', type: 'string' },
          { name: 'product', type: 'string' },
          { name: 'revenue', type: 'number' },
          { name: 'quantity', type: 'number' },
        ],
      });
      ds.insertRecords({
        collection: 'sales',
        records: [
          { region: 'EU', product: 'A', revenue: 100, quantity: 10 },
          { region: 'EU', product: 'B', revenue: 200, quantity: 5 },
          { region: 'US', product: 'A', revenue: 150, quantity: 8 },
          { region: 'US', product: 'B', revenue: 300, quantity: 12 },
          { region: 'EU', product: 'A', revenue: 50, quantity: 3 },
        ],
      });
    });

    it('aggregates with sum', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          groupBy: ['region'],
          metrics: [{ field: 'revenue', fn: 'sum', alias: 'total_revenue' }],
        },
      });
      expect(rows).toHaveLength(2);
      const eu = rows.find(r => r['region'] === 'EU') as Record<string, unknown>;
      const us = rows.find(r => r['region'] === 'US') as Record<string, unknown>;
      expect(eu['total_revenue']).toBe(350);
      expect(us['total_revenue']).toBe(450);
    });

    it('aggregates with a filter but NO groupBy without throwing (single-row result)', () => {
      // Pre-fix this threw `RangeError: Too many parameter values` — the
      // non-grouped branch built the paramless `SELECT 1 as cnt` yet still bound
      // the filter's WHERE params to it.
      const { rows, total } = ds.queryRecords({
        collection: 'sales',
        filter: { region: 'EU' },
        aggregate: {
          metrics: [{ field: 'revenue', fn: 'sum', alias: 'total' }],
        },
      });
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>)['total']).toBe(350); // EU: 100+200+50
      expect(total).toBe(1);
    });

    it('aggregates with avg', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          groupBy: ['region'],
          metrics: [{ field: 'quantity', fn: 'avg', alias: 'avg_qty' }],
        },
      });
      const eu = rows.find(r => r['region'] === 'EU') as Record<string, unknown>;
      expect(eu['avg_qty']).toBe(6);
    });

    it('aggregates with count', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          groupBy: ['region'],
          metrics: [{ field: '*', fn: 'count', alias: 'cnt' }],
        },
      });
      const eu = rows.find(r => r['region'] === 'EU') as Record<string, unknown>;
      expect(eu['cnt']).toBe(3);
    });

    it('aggregates with count_distinct', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          groupBy: ['region'],
          metrics: [{ field: 'product', fn: 'count_distinct', alias: 'unique_products' }],
        },
      });
      const eu = rows.find(r => r['region'] === 'EU') as Record<string, unknown>;
      expect(eu['unique_products']).toBe(2);
    });

    it('aggregates with min and max', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          metrics: [
            { field: 'revenue', fn: 'min', alias: 'min_rev' },
            { field: 'revenue', fn: 'max', alias: 'max_rev' },
          ],
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['min_rev']).toBe(50);
      expect(rows[0]!['max_rev']).toBe(300);
    });

    it('aggregates with filter', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        filter: { region: 'EU' },
        aggregate: {
          groupBy: ['product'],
          metrics: [{ field: 'revenue', fn: 'sum', alias: 'total' }],
        },
      });
      expect(rows).toHaveLength(2);
    });

    it('sorts aggregated results', () => {
      const { rows } = ds.queryRecords({
        collection: 'sales',
        aggregate: {
          groupBy: ['region'],
          metrics: [{ field: 'revenue', fn: 'sum', alias: 'total' }],
        },
        sort: [{ field: 'total', order: 'desc' }],
      });
      expect(rows[0]!['region']).toBe('US');
    });

    it('rejects unknown aggregation function', () => {
      expect(() => ds.queryRecords({
        collection: 'sales',
        aggregate: {
          metrics: [{ field: 'revenue', fn: 'unknown' as never }],
        },
      })).toThrow('is not supported');
    });
  });

  // === Collection Info & Listing ===

  describe('listCollections / getCollectionInfo', () => {
    it('lists all collections', () => {
      ds.createCollection({ name: 'a', scope, columns: [{ name: 'x', type: 'string' }] });
      ds.createCollection({ name: 'b', scope, columns: [{ name: 'y', type: 'number' }] });

      const list = ds.listCollections();
      expect(list).toHaveLength(2);
    });

    it('returns null for non-existent collection', () => {
      expect(ds.getCollectionInfo('nope')).toBeNull();
    });

    it('returns correct info', () => {
      ds.createCollection({
        name: 'info_test',
        scope,
        columns: [{ name: 'val', type: 'number' }],
        uniqueKey: ['val'],
      });
      ds.insertRecords({ collection: 'info_test', records: [{ val: 1 }, { val: 2 }] });

      const info = ds.getCollectionInfo('info_test');
      expect(info?.recordCount).toBe(2);
      expect(info?.uniqueKey).toEqual(['val']);
    });
  });

  // === Schema Evolution ===

  describe('alterCollection', () => {
    it('adds columns to existing collection', () => {
      ds.createCollection({ name: 'evolve', scope, columns: [{ name: 'x', type: 'string' }] });

      const info = ds.alterCollection({
        collection: 'evolve',
        addColumns: [{ name: 'y', type: 'number' }],
      });
      expect(info.columns).toHaveLength(2);
    });

    it('new columns have null for existing rows', () => {
      ds.createCollection({ name: 'evolve2', scope, columns: [{ name: 'x', type: 'string' }] });
      ds.insertRecords({ collection: 'evolve2', records: [{ x: 'hello' }] });
      ds.alterCollection({ collection: 'evolve2', addColumns: [{ name: 'y', type: 'number' }] });

      const { rows } = ds.queryRecords({ collection: 'evolve2' });
      expect(rows[0]!['y']).toBeNull();
    });

    it('rejects duplicate column names', () => {
      ds.createCollection({ name: 'evolve3', scope, columns: [{ name: 'x', type: 'string' }] });
      expect(() => ds.alterCollection({
        collection: 'evolve3',
        addColumns: [{ name: 'x', type: 'number' }],
      })).toThrow('already exists');
    });

    it('rejects non-existent collection', () => {
      expect(() => ds.alterCollection({
        collection: 'nope',
        addColumns: [{ name: 'x', type: 'string' }],
      })).toThrow('not found');
    });
  });

  // === Drop Collection ===

  describe('dropCollection', () => {
    it('drops existing collection', () => {
      ds.createCollection({ name: 'drop_me', scope, columns: [{ name: 'x', type: 'string' }] });
      expect(ds.dropCollection('drop_me')).toBe(true);
      expect(ds.getCollectionInfo('drop_me')).toBeNull();
      expect(ds.listCollections()).toHaveLength(0);
    });

    it('returns false for non-existent collection', () => {
      expect(ds.dropCollection('nope')).toBe(false);
    });

    it('allows re-creating after drop', () => {
      ds.createCollection({ name: 'recreate', scope, columns: [{ name: 'x', type: 'string' }] });
      ds.dropCollection('recreate');
      const info = ds.createCollection({ name: 'recreate', scope, columns: [{ name: 'y', type: 'number' }] });
      expect(info.columns[0]!.name).toBe('y');
    });
  });

  describe('dropEmptyCrmOverlaps', () => {
    it('drops empty CRM-shaped collections and reports their names', () => {
      ds.createCollection({ name: 'contacts', scope, columns: [{ name: 'email', type: 'string' }] });
      ds.createCollection({ name: 'deals', scope, columns: [{ name: 'amount', type: 'number' }] });
      ds.createCollection({ name: 'sales_data', scope, columns: [{ name: 'q', type: 'string' }] });

      const dropped = ds.dropEmptyCrmOverlaps();
      expect(dropped.sort()).toEqual(['contacts', 'deals']);
      expect(ds.getCollectionInfo('contacts')).toBeNull();
      expect(ds.getCollectionInfo('deals')).toBeNull();
      // Non-CRM-shaped name must survive even when empty.
      expect(ds.getCollectionInfo('sales_data')).not.toBeNull();
    });

    it('preserves a CRM-shaped collection with data — the user may rely on it', () => {
      ds.createCollection({ name: 'contacts', scope, columns: [{ name: 'email', type: 'string' }] });
      ds.insertRecords({ collection: 'contacts', records: [{ email: 'alice@example.com' }] });
      ds.dropEmptyCrmOverlaps();
      expect(ds.getCollectionInfo('contacts')).not.toBeNull();
    });

    it('returns empty array when nothing matches', () => {
      ds.createCollection({ name: 'monthly_kpis', scope, columns: [{ name: 'revenue', type: 'number' }] });
      expect(ds.dropEmptyCrmOverlaps()).toEqual([]);
    });
  });

  // === JSON columns ===

  describe('json columns', () => {
    it('stores and retrieves JSON objects', () => {
      ds.createCollection({
        name: 'json_test',
        scope,
        columns: [
          { name: 'name', type: 'string' },
          { name: 'metadata', type: 'json' },
        ],
      });
      ds.insertRecords({
        collection: 'json_test',
        records: [{ name: 'test', metadata: { tags: ['a', 'b'], score: 42 } }],
      });

      const { rows } = ds.queryRecords({ collection: 'json_test' });
      const parsed = JSON.parse(rows[0]!['metadata'] as string);
      expect(parsed.tags).toEqual(['a', 'b']);
      expect(parsed.score).toBe(42);
    });
  });

  // === $and filter ===

  describe('$and filter', () => {
    it('combines conditions with AND', () => {
      ds.createCollection({
        name: 'and_test',
        scope,
        columns: [
          { name: 'a', type: 'number' },
          { name: 'b', type: 'string' },
        ],
      });
      ds.insertRecords({
        collection: 'and_test',
        records: [
          { a: 1, b: 'x' },
          { a: 2, b: 'x' },
          { a: 1, b: 'y' },
        ],
      });

      const { rows } = ds.queryRecords({
        collection: 'and_test',
        filter: { $and: [{ a: 1 }, { b: 'x' }] },
      });
      expect(rows).toHaveLength(1);
    });
  });

  // === Disk size limit ===

  describe('disk size limit', () => {
    it('throws when database exceeds 500MB', () => {
      ds.createCollection({
        name: 'size_test',
        scope,
        columns: [{ name: 'val', type: 'string' }],
      });

      // Mock PRAGMA to return large values that simulate >500MB
      // page_count * page_size > 500MB
      const origPrepare = ds['db'].prepare.bind(ds['db']);
      const origFn = ds['db'].prepare;
      ds['db'].prepare = function (sql: string) {
        if (sql === 'PRAGMA page_count') {
          return { get: () => ({ page_count: 200_000 }) } as never;
        }
        if (sql === 'PRAGMA page_size') {
          return { get: () => ({ page_size: 4096 }) } as never;
        }
        return origPrepare(sql);
      } as typeof origFn;

      expect(() => ds.insertRecords({
        collection: 'size_test',
        records: [{ val: 'test' }],
      })).toThrow(/DataStore disk size.*exceeds limit/);

      // Restore
      ds['db'].prepare = origFn;
    });
  });

  // === System columns in filter ===

  describe('system columns', () => {
    it('filters by _id', () => {
      ds.createCollection({ name: 'sys_test', scope, columns: [{ name: 'x', type: 'string' }] });
      ds.insertRecords({ collection: 'sys_test', records: [{ x: 'a' }, { x: 'b' }] });

      const { rows } = ds.queryRecords({
        collection: 'sys_test',
        filter: { _id: 1 },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['x']).toBe('a');
    });
  });

  // === subject columns (Record-on-spine R1) ===

  describe('subject columns', () => {
    it('resolves a name to a subject_id and dedups the same name to one id', () => {
      const { bridge, calls } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'appointments',
        scope,
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'appointments',
        records: [
          { note: 'first visit', patient: 'Anna Meier' },
          { note: 'follow-up', patient: 'Anna Meier' },
          { note: 'new patient', patient: 'Ben Roth' },
        ],
      });

      const { rows } = ds.queryRecords({ collection: 'appointments', sort: [{ field: '_id', order: 'asc' }] });
      expect(rows[0]!['patient']).toBe('subj-1');
      expect(rows[1]!['patient']).toBe('subj-1'); // same name → same subject
      expect(rows[2]!['patient']).toBe('subj-2');
      // Every resolve carried the column's declared kind.
      expect(calls.every(c => c.kind === 'person')).toBe(true);
    });

    it('stores null for an empty/missing subject value (unlinked row allowed)', () => {
      const { bridge, calls } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'tickets',
        scope,
        columns: [
          { name: 'title', type: 'string' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
        ],
      });
      ds.insertRecords({
        collection: 'tickets',
        records: [
          { title: 'unassigned', client: '' },
          { title: 'also unassigned' }, // omitted entirely
        ],
      });

      const { rows } = ds.queryRecords({ collection: 'tickets', sort: [{ field: '_id', order: 'asc' }] });
      expect(rows[0]!['client']).toBeNull();
      expect(rows[1]!['client']).toBeNull();
      // Empty/omitted never reaches the resolver.
      expect(calls).toHaveLength(0);
    });

    it('degrades to storing the raw string when no resolver is injected (flag off)', () => {
      // No setSubjectBridge call — mirrors subject_graph_enabled === false.
      ds.createCollection({
        name: 'orders',
        scope,
        columns: [
          { name: 'sku', type: 'string' },
          { name: 'buyer', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'orders',
        records: [{ sku: 'A-1', buyer: 'Clara Vogt' }],
      });

      const { rows } = ds.queryRecords({ collection: 'orders' });
      // Raw name preserved — column still usable without the subject graph.
      expect(rows[0]!['buyer']).toBe('Clara Vogt');
    });

    it('supports adding a subject column via alterCollection', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'deliverables',
        scope,
        columns: [{ name: 'title', type: 'string' }],
      });
      ds.alterCollection({
        collection: 'deliverables',
        addColumns: [{ name: 'client', type: 'subject', subjectKind: 'organization' }],
      });
      ds.insertRecords({
        collection: 'deliverables',
        records: [{ title: 'Logo v1', client: 'Acme GmbH' }],
      });

      const { rows } = ds.queryRecords({ collection: 'deliverables' });
      expect(rows[0]!['client']).toBe('subj-1');
    });

    // The universality proof: one mechanism links rows in a CLINIC shape and an
    // AGENCY shape, with different subject kinds, through the same resolver.
    it('links subjects across unrelated domains via one mechanism', () => {
      const { bridge, calls } = makeStubBridge();
      ds.setSubjectBridge(bridge);

      // Clinic: an appointment links to a patient (person).
      ds.createCollection({
        name: 'clinic_appointments',
        scope,
        columns: [
          { name: 'when', type: 'date' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'clinic_appointments',
        records: [{ when: '2026-07-10', patient: 'Anna Meier' }],
      });

      // Agency: a deliverable links to a client company (organization).
      ds.createCollection({
        name: 'agency_deliverables',
        scope,
        columns: [
          { name: 'title', type: 'string' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
        ],
      });
      ds.insertRecords({
        collection: 'agency_deliverables',
        records: [{ title: 'Landing page', client: 'Acme GmbH' }],
      });

      const clinic = ds.queryRecords({ collection: 'clinic_appointments' });
      const agency = ds.queryRecords({ collection: 'agency_deliverables' });
      expect(typeof clinic.rows[0]!['patient']).toBe('string');
      expect(typeof agency.rows[0]!['client']).toBe('string');
      // Distinct identities (different kind AND name) → distinct ids.
      expect(clinic.rows[0]!['patient']).not.toBe(agency.rows[0]!['client']);
      // Both kinds flowed through the single resolver.
      expect(calls.map(c => c.kind).sort()).toEqual(['organization', 'person']);
    });

    it('stores null (not the raw name) when the resolver is present but returns null', () => {
      // A resolve FAILURE (distinct from flag-off) must keep the column id-pure —
      // never mix a raw name into a UUID column.
      ds.setSubjectBridge({ resolve: () => null, find: () => null, name: () => null });
      ds.createCollection({
        name: 'leads',
        scope,
        columns: [
          { name: 'label', type: 'string' },
          { name: 'contact', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'leads',
        records: [{ label: 'unresolvable', contact: 'Ghost Name' }],
      });

      const { rows } = ds.queryRecords({ collection: 'leads' });
      expect(rows[0]!['contact']).toBeNull();
    });

    it('treats a whitespace-only subject value as unlinked (null)', () => {
      const { bridge, calls } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'visits',
        scope,
        columns: [
          { name: 'day', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'visits',
        records: [{ day: 'mon', patient: '   ' }],
      });

      const { rows } = ds.queryRecords({ collection: 'visits' });
      expect(rows[0]!['patient']).toBeNull();
      expect(calls).toHaveLength(0); // whitespace never reaches the resolver
    });

    it('resolves a subject column that is part of a unique_key (upsert path)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'subscriptions',
        scope,
        columns: [
          { name: 'client', type: 'subject', subjectKind: 'organization' },
          { name: 'plan', type: 'string' },
          { name: 'seats', type: 'number' },
        ],
        uniqueKey: ['client', 'plan'],
      });
      // Two inserts with the SAME (resolved client, plan) → the ON CONFLICT path
      // must dedup on the resolved subject_id, updating rather than duplicating.
      ds.insertRecords({ collection: 'subscriptions', records: [{ client: 'Acme GmbH', plan: 'pro', seats: 5 }] });
      const second = ds.insertRecords({ collection: 'subscriptions', records: [{ client: 'acme gmbh', plan: 'pro', seats: 9 }] });

      expect(second.updated).toBe(1);
      const { rows } = ds.queryRecords({ collection: 'subscriptions' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['client']).toBe('subj-1'); // both resolved to the one subject
      expect(rows[0]!['seats']).toBe(9); // upsert updated the row
    });
  });

  // ── R1.5: the subject-column QUERY round-trip ────────────────────
  // Insert BY NAME (R1) → filter BY NAME + display the NAME (R1.5), so a subject
  // column is usable end-to-end under the flag, never as raw UUIDs. Uses the same
  // makeStubBridge as the write tests, and the agent-facing `subjectsByName` path.
  describe('subject columns — name-facing query (R1.5)', () => {
    function seedAppointments(ds: DataStore): void {
      ds.createCollection({
        name: 'appointments',
        scope,
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'appointments',
        records: [
          { note: 'first visit', patient: 'Anna Meier' },
          { note: 'new patient', patient: 'Ben Roth' },
          { note: 'follow-up', patient: 'anna meier' }, // case-variant → same subject
        ],
      });
    }

    it('filters by exact name and displays the name, not the UUID (full round-trip)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows, total } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: 'Anna Meier' },
        subjectsByName: true,
        sort: [{ field: '_id', order: 'asc' }],
      });

      // Name resolved to the id → both Anna rows match (case-insensitive dedup).
      expect(total).toBe(2);
      // Result cells show the display NAME, not subj-1.
      expect(rows.every(r => r['patient'] === 'Anna Meier')).toBe(true);
    });

    it('without subjectsByName, filtering by name misses and cells stay raw ids', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      // Default path (programmatic): stored value is the id, so a name filter
      // matches nothing and the returned cell is the raw id.
      const byName = ds.queryRecords({ collection: 'appointments', filter: { patient: 'Anna Meier' } });
      expect(byName.total).toBe(0);
      const all = ds.queryRecords({ collection: 'appointments', sort: [{ field: '_id', order: 'asc' }] });
      expect(all.rows[0]!['patient']).toBe('subj-1');
    });

    it('filters by a name list ($in)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: { $in: ['Anna Meier', 'Ben Roth'] } },
        subjectsByName: true,
        sort: [{ field: '_id', order: 'asc' }],
      });
      expect(rows).toHaveLength(3); // 2 Anna + 1 Ben
      expect([...new Set(rows.map(r => r['patient']))].sort()).toEqual(['Anna Meier', 'Ben Roth']);
    });

    it('an unresolvable name matches no rows (not everything)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows, total } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: 'Ghost Name' },
        subjectsByName: true,
      });
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });

    it('excludes a name via $neq', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: { $neq: 'Anna Meier' } },
        subjectsByName: true,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!['patient']).toBe('Ben Roth');
    });

    it('filters linked/unlinked rows via $is_null on a subject column', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'tickets',
        scope,
        columns: [
          { name: 'title', type: 'string' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
        ],
      });
      ds.insertRecords({
        collection: 'tickets',
        records: [
          { title: 'linked', client: 'Acme GmbH' },
          { title: 'unlinked' }, // no client → null
        ],
      });

      const linked = ds.queryRecords({ collection: 'tickets', filter: { client: { $is_null: false } }, subjectsByName: true });
      const unlinked = ds.queryRecords({ collection: 'tickets', filter: { client: { $is_null: true } }, subjectsByName: true });
      expect(linked.rows.map(r => r['title'])).toEqual(['linked']);
      expect(unlinked.rows.map(r => r['title'])).toEqual(['unlinked']);
    });

    it('rejects $like and range operators on a subject column (identity, not text/range)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      expect(() => ds.queryRecords({ collection: 'appointments', filter: { patient: { $like: 'An%' } }, subjectsByName: true }))
        .toThrow(/links to a subject/);
      expect(() => ds.queryRecords({ collection: 'appointments', filter: { patient: { $gt: 'A' } }, subjectsByName: true }))
        .toThrow(/links to a subject/);
    });

    it('shows the raw id when the subject name can no longer be resolved (stale)', () => {
      // resolve+find work, but name() is null → the subject was purged. The id is
      // shown (never dropped) rather than a blank or a crash.
      const bridge: SubjectColumnBridge = { resolve: () => 'subj-x', find: () => 'subj-x', name: () => null };
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'orders',
        scope,
        columns: [{ name: 'buyer', type: 'subject', subjectKind: 'person' }],
      });
      ds.insertRecords({ collection: 'orders', records: [{ buyer: 'Anyone' }] });

      const { rows } = ds.queryRecords({ collection: 'orders', subjectsByName: true });
      expect(rows[0]!['buyer']).toBe('subj-x');
    });

    it('flag off (no bridge): a subject column filters + displays by raw name', () => {
      // No setSubjectBridge — subject columns store raw names, so the name path is
      // a pure pass-through: filter by name hits the stored string, display is the
      // string. subjectsByName is a no-op without a bridge.
      ds.createCollection({
        name: 'orders',
        scope,
        columns: [{ name: 'buyer', type: 'subject', subjectKind: 'person' }],
      });
      ds.insertRecords({ collection: 'orders', records: [{ buyer: 'Clara Vogt' }, { buyer: 'Dan Ott' }] });

      const { rows, total } = ds.queryRecords({ collection: 'orders', filter: { buyer: 'Clara Vogt' }, subjectsByName: true });
      expect(total).toBe(1);
      expect(rows[0]!['buyer']).toBe('Clara Vogt');
    });

    it('resolves a subject-column operand nested in $or', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { $or: [{ patient: 'Ben Roth' }, { note: 'first visit' }] },
        subjectsByName: true,
        sort: [{ field: '_id', order: 'asc' }],
      });
      // Ben's row (by resolved subject) + Anna's first-visit row (by note).
      expect(rows.map(r => r['note'])).toEqual(['first visit', 'new patient']);
    });

    it('resolves a subject-column operand nested in $and', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { $and: [{ patient: 'Anna Meier' }, { note: 'first visit' }] },
        subjectsByName: true,
      });
      // Only Anna's first-visit row satisfies BOTH the resolved subject and the note.
      expect(rows.map(r => r['note'])).toEqual(['first visit']);
    });

    it('excludes a name list via $nin', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: { $nin: ['Anna Meier'] } },
        subjectsByName: true,
      });
      // Both Anna rows excluded → only Ben remains.
      expect(rows.map(r => r['patient'])).toEqual(['Ben Roth']);
    });

    it('$in with a mix of resolvable and unresolvable names matches only the resolvable', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: { $in: ['Anna Meier', 'Ghost Name'] } },
        subjectsByName: true,
        sort: [{ field: '_id', order: 'asc' }],
      });
      // The unresolvable name resolves to a per-element sentinel (NOT match-all),
      // so only the two Anna rows come back.
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r['patient'] === 'Anna Meier')).toBe(true);
    });

    it('aggregates with a subject name-filter (count of one subject) without grouping by it', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: 'Anna Meier' },
        subjectsByName: true,
        aggregate: { metrics: [{ field: '*', fn: 'count', alias: 'n' }] },
      });
      // Filter resolves the name → id, then counts the two Anna rows.
      expect(rows[0]!['n']).toBe(2);
    });

    it('rejects sorting by a subject column (name is cross-DB, breaks the row limit)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      expect(() => ds.queryRecords({
        collection: 'appointments',
        sort: [{ field: 'patient', order: 'asc' }],
        subjectsByName: true,
      })).toThrow(/sort by subject column/);
    });

    it('groups by a subject column and returns hydrated NAME keys (R2a fence-lift)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      const { rows, total } = ds.queryRecords({
        collection: 'appointments',
        subjectsByName: true,
        aggregate: { groupBy: ['patient'], metrics: [{ field: '*', fn: 'count', alias: 'n' }] },
        sort: [{ field: 'n', order: 'desc' }], // sort by the metric alias, not the subject col
      });

      // Two subjects (Anna ×2, Ben ×1) → two groups, keyed by the display NAME, not a UUID.
      expect(total).toBe(2);
      const byName = new Map(rows.map(r => [r['patient'], r['n']]));
      expect(byName.get('Anna Meier')).toBe(2);
      expect(byName.get('Ben Roth')).toBe(1);
    });

    it('still rejects ordering the grouped subject column BY name (the fenced half)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      seedAppointments(ds);

      // Group-by is lifted, but sorting those groups by the subject name is the
      // cross-DB case that can't respect LIMIT/OFFSET → still fenced.
      expect(() => ds.queryRecords({
        collection: 'appointments',
        subjectsByName: true,
        aggregate: { groupBy: ['patient'], metrics: [{ field: '*', fn: 'count', alias: 'n' }] },
        sort: [{ field: 'patient', order: 'asc' }],
      })).toThrow(/sort by subject column/);
    });
  });

  // === R2a enablers: subject-column index + occurred_at role ===
  describe('subject columns — R2a enablers (index + occurred_at)', () => {
    function indexNames(path: string, table: string): string[] {
      const db = new Database(path, { readonly: true });
      try {
        const rows = db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>;
        return rows.map(r => r.name);
      } finally {
        db.close();
      }
    }

    it('creates a secondary index on each subject column at createCollection', () => {
      ds.createCollection({
        name: 'invoices',
        scope,
        columns: [
          { name: 'amount', type: 'number' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
          { name: 'vendor', type: 'subject', subjectKind: 'organization' },
        ],
      });
      // Assert on the column suffix, not the exact prefix, so the test doesn't
      // couple to the collision-safe naming scheme (length-prefixed).
      const idx = indexNames(dbPath, 'ds_invoices');
      expect(idx.some(n => n.endsWith('_client_subj'))).toBe(true);
      expect(idx.some(n => n.endsWith('_vendor_subj'))).toBe(true);
    });

    it('indexes a subject column added later via alterCollection', () => {
      ds.createCollection({ name: 'leads', scope, columns: [{ name: 'title', type: 'string' }] });
      expect(indexNames(dbPath, 'ds_leads').some(n => n.endsWith('_owner_subj'))).toBe(false);
      ds.alterCollection({ collection: 'leads', addColumns: [{ name: 'owner', type: 'subject', subjectKind: 'person' }] });
      expect(indexNames(dbPath, 'ds_leads').some(n => n.endsWith('_owner_subj'))).toBe(true);
    });

    it('does not index a non-subject column', () => {
      ds.createCollection({ name: 'plain', scope, columns: [{ name: 'x', type: 'number' }] });
      expect(indexNames(dbPath, 'ds_plain').some(n => n.endsWith('_subj'))).toBe(false);
    });

    it('two collections whose <name>_<col> concatenations coincide do not collide', () => {
      // SQLite index names are database-global. A bare `<coll>_<col>` join is
      // ambiguous: `crm_deals`+`owner` vs `crm`+`deals_owner` both flatten to
      // "crm_deals_owner". Both subject indexes must still create cleanly.
      ds.createCollection({
        name: 'crm_deals',
        scope,
        columns: [{ name: 'owner', type: 'subject', subjectKind: 'person' }],
      });
      expect(() => ds.createCollection({
        name: 'crm',
        scope,
        columns: [{ name: 'deals_owner', type: 'subject', subjectKind: 'person' }],
      })).not.toThrow();
      expect(indexNames(dbPath, 'ds_crm_deals').some(n => n.endsWith('_owner_subj'))).toBe(true);
      expect(indexNames(dbPath, 'ds_crm').some(n => n.endsWith('_deals_owner_subj'))).toBe(true);
    });

    it('persists an occurred_at role on a date column (round-trips through the schema)', () => {
      ds.createCollection({
        name: 'events',
        scope,
        columns: [
          { name: 'label', type: 'string' },
          { name: 'happened_on', type: 'date', role: 'occurred_at' },
        ],
      });
      const info = ds.getCollectionInfo('events');
      expect(info?.columns.find(c => c.name === 'happened_on')?.role).toBe('occurred_at');
    });

    it('rejects occurred_at on a non-date column', () => {
      expect(() => ds.createCollection({
        name: 'bad_role',
        scope,
        columns: [{ name: 'when', type: 'string', role: 'occurred_at' }],
      })).toThrow(/Only a "date" column/);
    });

    it('rejects a second occurred_at column at create', () => {
      expect(() => ds.createCollection({
        name: 'bad_two',
        scope,
        columns: [
          { name: 'a', type: 'date', role: 'occurred_at' },
          { name: 'b', type: 'date', role: 'occurred_at' },
        ],
      })).toThrow(/at most one "occurred_at"/);
    });

    it('rejects adding a second occurred_at column via alterCollection', () => {
      ds.createCollection({
        name: 'evt_alter',
        scope,
        columns: [{ name: 'a', type: 'date', role: 'occurred_at' }],
      });
      expect(() => ds.alterCollection({
        collection: 'evt_alter',
        addColumns: [{ name: 'b', type: 'date', role: 'occurred_at' }],
      })).toThrow(/at most one "occurred_at"/);
    });

    it('persists a first occurred_at role added via alterCollection', () => {
      // The alter path re-serializes the merged schema; prove `role` survives that
      // write (the create path can't cover it — separate schema_json write).
      ds.createCollection({ name: 'evt_pos', scope, columns: [{ name: 'label', type: 'string' }] });
      ds.alterCollection({
        collection: 'evt_pos',
        addColumns: [{ name: 'happened_on', type: 'date', role: 'occurred_at' }],
      });
      const info = ds.getCollectionInfo('evt_pos');
      expect(info?.columns.find(c => c.name === 'happened_on')?.role).toBe('occurred_at');
    });

    it('hydrates only the subject key in a multi-column group-by (plain key passes through)', () => {
      const { bridge } = makeStubBridge();
      ds.setSubjectBridge(bridge);
      ds.createCollection({
        name: 'appointments',
        scope,
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'appointments',
        records: [
          { note: 'first visit', patient: 'Anna Meier' },
          { note: 'new patient', patient: 'Ben Roth' },
          { note: 'follow-up', patient: 'anna meier' }, // case-variant → same subject
        ],
      });

      const { rows } = ds.queryRecords({
        collection: 'appointments',
        subjectsByName: true,
        aggregate: { groupBy: ['patient', 'note'], metrics: [{ field: '*', fn: 'count', alias: 'n' }] },
      });

      // 3 distinct (patient, note) groups: the subject key hydrates to the display
      // NAME (not subj-1), the plain `note` key stays the raw string.
      const keys = rows.map(r => `${String(r['patient'])}|${String(r['note'])}`).sort();
      expect(keys).toEqual(
        ['Anna Meier|first visit', 'Anna Meier|follow-up', 'Ben Roth|new patient'].sort(),
      );
    });
  });

  // === R2b: cross-collection subject footprint (getRecordsForSubject) ===
  describe('getRecordsForSubject — R2b subject footprint', () => {
    // No bridge wired (the default) → a `subject` column stores the raw string, so we
    // seed the subject_id directly and read it back by id. getRecordsForSubject is
    // id-keyed and bridge-agnostic (it queries the stored value), so this exercises
    // the real cross-collection gather + occurred_at projection without engine.db.
    const ACME = 'subj-acme';
    const OTHER = 'subj-other';

    it('gathers rows across collections, newest occurred_at first, with event-time provenance', () => {
      ds.createCollection({
        name: 'invoices', scope,
        columns: [
          { name: 'amount', type: 'number' },
          { name: 'client', type: 'subject', subjectKind: 'organization' },
          { name: 'invoice_date', type: 'date', role: 'occurred_at' },
        ],
      });
      ds.createCollection({
        name: 'meetings', scope,
        columns: [
          { name: 'topic', type: 'string' },
          { name: 'org', type: 'subject', subjectKind: 'organization' },
          { name: 'met_on', type: 'date', role: 'occurred_at' },
        ],
      });
      ds.insertRecords({ collection: 'invoices', records: [
        { amount: 100, client: ACME, invoice_date: '2026-01-10' },
        { amount: 200, client: ACME, invoice_date: '2026-03-15' },
        { amount: 999, client: OTHER, invoice_date: '2026-06-01' }, // different subject
      ] });
      ds.insertRecords({ collection: 'meetings', records: [
        { topic: 'kickoff', org: ACME, met_on: '2026-02-20' },
      ] });

      const { occurrences, truncated } = ds.getRecordsForSubject(ACME);
      expect(truncated).toBe(false);
      expect(occurrences.map(o => o.occurredAt)).toEqual(['2026-03-15', '2026-02-20', '2026-01-10']);
      expect(occurrences.map(o => o.collection)).toEqual(['invoices', 'meetings', 'invoices']);
      expect(occurrences.every(o => o.occurredAtIsEventTime)).toBe(true);
      expect(occurrences.some(o => o.row['amount'] === 999)).toBe(false); // OTHER excluded
      expect(occurrences[0]!.matchedColumns).toEqual(['client']);
    });

    it('falls back to _created_at when a collection declares no occurred_at (flagged not event-time)', () => {
      ds.createCollection({
        name: 'notes', scope,
        columns: [
          { name: 'body', type: 'string' },
          { name: 'about', type: 'subject', subjectKind: 'organization' },
        ],
      });
      ds.insertRecords({ collection: 'notes', records: [{ body: 'hi', about: ACME }] });
      const { occurrences } = ds.getRecordsForSubject(ACME);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]!.occurredAtIsEventTime).toBe(false);
      // the fallback is the insert timestamp (an ISO string), never null/empty
      expect(typeof occurrences[0]!.occurredAt).toBe('string');
      expect(occurrences[0]!.occurredAt).not.toBe('');
    });

    it('folds a row linking the subject through two columns into ONE occurrence (both matched)', () => {
      ds.createCollection({
        name: 'transfers', scope,
        columns: [
          { name: 'sender', type: 'subject', subjectKind: 'organization' },
          { name: 'receiver', type: 'subject', subjectKind: 'organization' },
          { name: 'moved_on', type: 'date', role: 'occurred_at' },
        ],
      });
      ds.insertRecords({ collection: 'transfers', records: [
        { sender: ACME, receiver: ACME, moved_on: '2026-05-05' },   // intra-org — one row
        { sender: ACME, receiver: OTHER, moved_on: '2026-04-04' },
      ] });
      const { occurrences } = ds.getRecordsForSubject(ACME);
      expect(occurrences).toHaveLength(2); // NOT 3 — the both-columns row is one occurrence
      const both = occurrences.find(o => o.occurredAt === '2026-05-05')!;
      expect(both.matchedColumns.slice().sort()).toEqual(['receiver', 'sender']);
      const one = occurrences.find(o => o.occurredAt === '2026-04-04')!;
      expect(one.matchedColumns).toEqual(['sender']);
    });

    it('skips collections with no subject column and returns empty for an unknown subject', () => {
      ds.createCollection({ name: 'plain', scope, columns: [{ name: 'x', type: 'string' }] });
      ds.insertRecords({ collection: 'plain', records: [{ x: 'a' }] });
      ds.createCollection({ name: 'linked', scope, columns: [
        { name: 'y', type: 'string' }, { name: 'who', type: 'subject', subjectKind: 'person' },
      ] });
      ds.insertRecords({ collection: 'linked', records: [{ y: 'b', who: ACME }] });
      expect(ds.getRecordsForSubject(ACME).occurrences).toHaveLength(1);
      expect(ds.getRecordsForSubject('subj-nobody').occurrences).toHaveLength(0);
    });

    it('caps at limit (newest kept) and reports truncated when more rows exist', () => {
      ds.createCollection({ name: 'events', scope, columns: [
        { name: 'seq', type: 'number' },
        { name: 'org', type: 'subject', subjectKind: 'organization' },
        { name: 'on_date', type: 'date', role: 'occurred_at' },
      ] });
      ds.insertRecords({ collection: 'events', records: Array.from({ length: 5 }, (_, i) => ({
        seq: i, org: ACME, on_date: `2026-01-0${String(i + 1)}`,
      })) });
      const { occurrences, truncated } = ds.getRecordsForSubject(ACME, { limit: 3 });
      expect(occurrences).toHaveLength(3);
      expect(truncated).toBe(true);
      expect(occurrences.map(o => o.occurredAt)).toEqual(['2026-01-05', '2026-01-04', '2026-01-03']);
    });
  });
});
