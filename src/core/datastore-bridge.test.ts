import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStoreBridge } from './datastore-bridge.js';
import { KuzuGraph } from './knowledge-graph.js';
import { EntityResolver } from './entity-resolver.js';
import { LocalProvider } from './embedding.js';
import type { DataStore } from './data-store.js';
import type { DataStoreCollectionInfo } from '../types/index.js';

/**
 * Tests for DataStoreBridge using a real LadybugDB graph but mocked DataStore.
 * DataStore is mocked because better-sqlite3 native binary may not be available
 * in all environments (same issue as existing data-store.test.ts).
 */
function createMockDataStore(): DataStore {
  const collections = new Map<string, DataStoreCollectionInfo>();

  return {
    getCollectionInfo: vi.fn((name: string) => collections.get(name) ?? null),
    createCollection: vi.fn((params: { name: string; scope: { type: string; id: string }; columns: Array<{ name: string; type: string }> }) => {
      const info: DataStoreCollectionInfo = {
        name: params.name,
        scopeType: params.scope.type,
        scopeId: params.scope.id,
        columns: params.columns.map(c => ({ name: c.name, type: c.type as DataStoreCollectionInfo['columns'][number]['type'] })),
        uniqueKey: null,
        recordCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      collections.set(params.name, info);
      return info;
    }),
    queryRecords: vi.fn(() => ({ rows: [{ name: 'Thomas', revenue: 5000, status: 'active' }], total: 1 })),
    listCollections: vi.fn(() => [...collections.values()]),
    close: vi.fn(),
  } as unknown as DataStore;
}

describe('DataStoreBridge', () => {
  let bridge: DataStoreBridge;
  let graph: KuzuGraph;
  let mockStore: DataStore;
  let tempDir: string;
  const scope = { type: 'context' as const, id: 'test' };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nodyn-bridge-test-'));
    graph = new KuzuGraph(join(tempDir, 'test-graph'));
    await graph.init();
    mockStore = createMockDataStore();

    const resolver = new EntityResolver(graph, new LocalProvider());
    bridge = new DataStoreBridge(graph, resolver, mockStore);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- Collection Registration ---

  it('registers a collection as entity in the graph', async () => {
    await bridge.registerCollection(
      'customers',
      [{ name: 'name', type: 'string' }, { name: 'revenue', type: 'number' }],
      scope,
    );

    const entity = await graph.findEntityByCanonicalName('customers');
    expect(entity).not.toBeNull();
    expect(entity!['e.entity_type']).toBe('collection');
    expect((entity!['e.description'] as string)).toContain('name (string)');
  });

  it('is idempotent — does not duplicate collection entities', async () => {
    await bridge.registerCollection('customers', [{ name: 'name', type: 'string' }], scope);
    await bridge.registerCollection('customers', [{ name: 'name', type: 'string' }], scope);

    const rows = await graph.query(
      `MATCH (e:Entity) WHERE e.canonical_name = 'customers' RETURN e.id`,
    );
    expect(rows.length).toBe(1);
  });

  // --- Entity Indexing ---

  it('extracts entities from string fields and links to collection', async () => {
    // Mock DataStore returns collection info with string columns
    (mockStore.getCollectionInfo as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'contacts',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'company', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      recordCount: 1,
    });

    // Register collection first
    await bridge.registerCollection(
      'contacts',
      [{ name: 'name', type: 'string' }, { name: 'company', type: 'string' }, { name: 'revenue', type: 'number' }],
      scope,
    );

    await bridge.indexRecords(
      'contacts',
      [{ name: 'Herr Schmidt', company: 'test-firma.ch', revenue: 5000 }],
      scope,
    );

    const schmidt = await graph.findEntityByCanonicalName('Schmidt');
    expect(schmidt).not.toBeNull();
    expect(schmidt!['e.entity_type']).toBe('person');

    const firma = await graph.findEntityByCanonicalName('test-firma.ch');
    expect(firma).not.toBeNull();
    expect(firma!['e.entity_type']).toBe('organization');
  });

  it('skips collections with only non-string columns', async () => {
    (mockStore.getCollectionInfo as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'numbers_only',
      columns: [{ name: 'amount', type: 'number' }, { name: 'active', type: 'boolean' }],
      recordCount: 1,
    });

    await bridge.registerCollection(
      'numbers_only',
      [{ name: 'amount', type: 'number' }, { name: 'active', type: 'boolean' }],
      scope,
    );

    const countBefore = await graph.getEntityCount();
    await bridge.indexRecords('numbers_only', [{ amount: 1000, active: true }], scope);
    const countAfter = await graph.getEntityCount();

    // numbers_only collection entity was added, but no data entities
    expect(countAfter - countBefore).toBeLessThanOrEqual(0);
  });

  // --- Find Related Data ---

  it('finds collections related to an entity', async () => {
    const schmidt = await graph.findEntityByCanonicalName('Schmidt');
    if (!schmidt) return;

    const hints = await bridge.findRelatedData([schmidt['e.id'] as string]);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.some(h => h.collection === 'contacts')).toBe(true);
  });

  it('returns preview data from DataStore', async () => {
    const schmidt = await graph.findEntityByCanonicalName('Schmidt');
    if (!schmidt) return;

    const hints = await bridge.findRelatedData([schmidt['e.id'] as string]);
    const contactsHint = hints.find(h => h.collection === 'contacts');
    if (contactsHint) {
      // Preview should contain data from the mock queryRecords
      expect(contactsHint.preview.length).toBeGreaterThan(0);
    }
  });

  it('returns empty for unknown entities', async () => {
    const hints = await bridge.findRelatedData(['non-existent-id']);
    expect(hints).toHaveLength(0);
  });

  it('returns empty for empty input', async () => {
    const hints = await bridge.findRelatedData([]);
    expect(hints).toHaveLength(0);
  });
});
