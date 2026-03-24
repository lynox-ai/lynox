/**
 * Benchmark: DataStore CRUD operations
 *
 * Measures collection creation, record insert (single/batch),
 * query with filters, upsert, and aggregation.
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { DataStore } from '../../src/core/data-store.js';
import { createBenchDir } from './setup.js';
import { join } from 'node:path';

let ds: DataStore;
let cleanup: () => void;
let counter = 0;

const SCOPE = { type: 'context' as const, id: 'bench' };

beforeAll(() => {
  const tmp = createBenchDir('nodyn-bench-ds-');
  cleanup = tmp.cleanup;
  ds = new DataStore(join(tmp.path, 'bench.db'));

  // Pre-seed collections for insert and query benchmarks
  ds.createCollection({
    name: 'insert_single',
    scope: SCOPE,
    columns: [
      { name: 'title', type: 'string' },
      { name: 'value', type: 'number' },
      { name: 'active', type: 'boolean' },
    ],
  });
  ds.createCollection({
    name: 'insert_batch',
    scope: SCOPE,
    columns: [
      { name: 'title', type: 'string' },
      { name: 'value', type: 'number' },
      { name: 'active', type: 'boolean' },
    ],
  });
  ds.createCollection({
    name: 'query_bench',
    scope: SCOPE,
    columns: [
      { name: 'title', type: 'string' },
      { name: 'value', type: 'number' },
      { name: 'category', type: 'string' },
    ],
  });

  // Seed query collection with 1000 rows
  const records = Array.from({ length: 1000 }, (_, i) => ({
    title: `Item ${i}`,
    value: i * 0.5,
    category: ['alpha', 'beta', 'gamma'][i % 3],
  }));
  ds.insertRecords({ collection: 'query_bench', records: records.slice(0, 500) });
  ds.insertRecords({ collection: 'query_bench', records: records.slice(500) });

  // Seed list benchmark collections
  for (let i = 0; i < 10; i++) {
    ds.createCollection({
      name: `list_bench_${i}`,
      scope: SCOPE,
      columns: [{ name: 'data', type: 'string' }],
    });
  }
});

afterAll(() => {
  cleanup();
});

describe('DataStore — collection lifecycle', () => {
  bench('createCollection', () => {
    // Uses its own DataStore to avoid hitting the 100 collection limit
    const tmp = createBenchDir('nodyn-bench-ds-coll-');
    const localDs = new DataStore(join(tmp.path, 'bench.db'));
    localDs.createCollection({
      name: 'bench_coll',
      scope: SCOPE,
      columns: [
        { name: 'title', type: 'string' },
        { name: 'value', type: 'number' },
        { name: 'active', type: 'boolean' },
      ],
    });
    tmp.cleanup();
  });

  bench('listCollections (13+ collections)', () => {
    ds.listCollections();
  });
});

describe('DataStore — insert', () => {
  bench('single record insert', () => {
    ds.insertRecords({
      collection: 'insert_single',
      records: [{ title: `Benchmark item ${counter++}`, value: Math.random() * 100, active: true }],
    });
  });

  bench('batch insert (100 records)', () => {
    const name = `batch_${counter++}`;
    ds.createCollection({
      name,
      scope: SCOPE,
      columns: [
        { name: 'title', type: 'string' },
        { name: 'value', type: 'number' },
        { name: 'active', type: 'boolean' },
      ],
    });
    const records = Array.from({ length: 100 }, (_, i) => ({
      title: `Item ${i}`,
      value: i * 1.5,
      active: i % 2 === 0,
    }));
    ds.insertRecords({ collection: name, records });
  });
});

describe('DataStore — query', () => {
  bench('query without filter (1000 rows)', () => {
    ds.queryRecords({ collection: 'query_bench', limit: 50 });
  });

  bench('query with $eq filter', () => {
    ds.queryRecords({
      collection: 'query_bench',
      filter: { category: { $eq: 'beta' } },
      limit: 50,
    });
  });

  bench('query with compound $and filter', () => {
    ds.queryRecords({
      collection: 'query_bench',
      filter: {
        $and: [
          { category: { $eq: 'alpha' } },
          { value: { $gt: 100 } },
        ],
      },
      limit: 50,
    });
  });

  bench('query with sort', () => {
    ds.queryRecords({
      collection: 'query_bench',
      sort: [{ column: 'value', direction: 'desc' }],
      limit: 20,
    });
  });

  bench('query with aggregation (avg)', () => {
    ds.queryRecords({
      collection: 'query_bench',
      aggregate: {
        groupBy: ['category'],
        metrics: [{ fn: 'avg' as const, column: 'value', alias: 'avg_value' }],
      },
    });
  });
});
