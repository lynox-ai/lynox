import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStoreBridge } from './datastore-bridge.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EntityResolver } from './entity-resolver.js';
import { LocalProvider } from './embedding.js';
import type { DataStore } from './data-store.js';
import type { DataStoreCollectionInfo } from '../types/index.js';

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
  let db: AgentMemoryDb;
  let mockStore: DataStore;
  let tempDir: string;
  const scope = { type: 'context' as const, id: 'test' };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-bridge-test-'));
    db = new AgentMemoryDb(join(tempDir, 'test.db'));
    db.setEmbeddingDimensions(10);
    mockStore = createMockDataStore();

    const resolver = new EntityResolver(db, new LocalProvider());
    bridge = new DataStoreBridge(db, resolver, mockStore);
  });

  afterAll(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('registers a collection as entity', async () => {
    await bridge.registerCollection(
      'customers',
      [{ name: 'name', type: 'string' }, { name: 'revenue', type: 'number' }],
      scope,
    );
    const entity = db.findEntityByCanonicalName('customers');
    expect(entity).not.toBeNull();
    expect(entity!.entity_type).toBe('collection');
    expect(entity!.description).toContain('name (string)');
  });

  it('is idempotent', async () => {
    await bridge.registerCollection('customers', [{ name: 'name', type: 'string' }], scope);
    await bridge.registerCollection('customers', [{ name: 'name', type: 'string' }], scope);
    const entities = db.listEntities({ type: 'collection' });
    const customers = entities.filter(e => e.canonical_name === 'customers');
    expect(customers).toHaveLength(1);
  });

  it('extracts entities from string fields and links to collection', async () => {
    (mockStore.getCollectionInfo as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'contacts',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'company', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      recordCount: 1,
    });

    await bridge.registerCollection(
      'contacts',
      [{ name: 'name', type: 'string' }, { name: 'company', type: 'string' }, { name: 'revenue', type: 'number' }],
      scope,
    );

    await bridge.indexRecords(
      'contacts',
      [{ name: 'Mr. Smith', company: 'acme-corp.com', revenue: 5000 }],
      scope,
    );

    const smith = db.findEntityByCanonicalName('Smith');
    expect(smith).not.toBeNull();
    expect(smith!.entity_type).toBe('person');

    const firma = db.findEntityByCanonicalName('acme-corp.com');
    expect(firma).not.toBeNull();
    expect(firma!.entity_type).toBe('organization');
  });

  it('finds collections related to an entity', async () => {
    const smith = db.findEntityByCanonicalName('Smith');
    if (!smith) return;
    const hints = await bridge.findRelatedData([smith.id]);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.some(h => h.collection === 'contacts')).toBe(true);
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
