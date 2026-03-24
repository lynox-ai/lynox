import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from './data-store.js';
import type { MemoryScopeRef } from '../types/index.js';

const scope: MemoryScopeRef = { type: 'context', id: 'test-proj' };

function makeTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
  return join(dir, 'test.db');
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
});
