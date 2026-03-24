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
