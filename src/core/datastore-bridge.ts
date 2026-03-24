import type {
  MemoryScopeRef,
  DataStoreColumnDef,
} from '../types/index.js';
import type { KuzuGraph } from './knowledge-graph.js';
import type { EntityResolver } from './entity-resolver.js';
import type { DataStore } from './data-store.js';
import { extractEntitiesRegex } from './entity-extractor.js';
import { channels } from './observability.js';

/** Max entities to extract per insert batch (prevents excessive graph writes). */
const MAX_ENTITIES_PER_BATCH = 20;

/** Max records to scan for entities per insert (skip bulk imports). */
const MAX_RECORDS_TO_SCAN = 100;

export interface DataStoreHint {
  collection: string;
  entityName: string;
  preview: string;
}

/**
 * Bridge between DataStore (structured SQLite tables) and Knowledge Graph.
 *
 * Responsibilities:
 * 1. Register collections as Entity nodes (type: 'collection')
 * 2. Extract entities from inserted records and link to collection
 * 3. Provide DataStore hints during retrieval when entities have related data
 */
export class DataStoreBridge {
  constructor(
    private readonly graph: KuzuGraph,
    private readonly entityResolver: EntityResolver,
    private readonly dataStore: DataStore,
  ) {}

  /**
   * Register a DataStore collection as an entity in the Knowledge Graph.
   * Called after data_store_create.
   */
  async registerCollection(
    name: string,
    columns: DataStoreColumnDef[],
    scope: MemoryScopeRef,
  ): Promise<void> {
    // Check if collection entity already exists
    const existing = await this.graph.findEntityByCanonicalName(name);
    if (existing) return;

    const colDesc = columns.map(c => `${c.name} (${c.type})`).join(', ');
    await this.graph.createEntity({
      canonicalName: name,
      entityType: 'collection',
      aliases: [name],
      description: `Data table: ${name} — columns: ${colDesc}`,
      scopeType: scope.type,
      scopeId: scope.id,
    });

    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'collection_registered',
        collection: name,
      });
    }
  }

  /**
   * Extract entities from inserted records and create has_data_in relationships.
   * Only scans string-type columns. Uses Tier-1 regex (zero cost).
   */
  async indexRecords(
    collectionName: string,
    records: Record<string, unknown>[],
    scope: MemoryScopeRef,
  ): Promise<void> {
    // 1. Get schema to identify string columns
    const info = this.dataStore.getCollectionInfo(collectionName);
    if (!info) return;

    const stringColumns = info.columns
      .filter(c => c.type === 'string')
      .map(c => c.name);
    if (stringColumns.length === 0) return;

    // 2. Concatenate string values (limit scan to MAX_RECORDS_TO_SCAN)
    const textParts: string[] = [];
    const recordsToScan = records.slice(0, MAX_RECORDS_TO_SCAN);

    for (const record of recordsToScan) {
      for (const col of stringColumns) {
        const val = record[col];
        if (typeof val === 'string' && val.length >= 2) {
          textParts.push(val);
        }
      }
    }
    if (textParts.length === 0) return;

    // 3. Extract entities (regex only — no LLM for bulk data)
    const { entities } = extractEntitiesRegex(textParts.join(' '));
    if (entities.length === 0) return;

    // 4. Resolve collection entity
    const collectionEntity = await this.entityResolver.resolve(
      collectionName,
      'collection',
      [scope],
      { createIfMissing: false },
    );
    if (!collectionEntity) return;

    // 5. Resolve each extracted entity and create has_data_in relationship
    const linked = new Set<string>(); // Avoid duplicate links per batch

    for (const ext of entities.slice(0, MAX_ENTITIES_PER_BATCH)) {
      const entity = await this.entityResolver.resolve(
        ext.name,
        ext.type,
        [scope],
        { createIfMissing: true },
      );
      if (!entity || entity.id === collectionEntity.id) continue;

      const linkKey = `${entity.id}:${collectionEntity.id}`;
      if (linked.has(linkKey)) continue;
      linked.add(linkKey);

      // Check if relationship already exists
      const existing = await this.graph.queryOne(
        `MATCH (a:Entity)-[r:RELATES_TO {relation_type: 'has_data_in'}]->(b:Entity)
         WHERE a.id = $fromId AND b.id = $toId
         RETURN r.relation_type`,
        { fromId: entity.id, toId: collectionEntity.id },
      );

      if (!existing) {
        await this.graph.createRelation(
          entity.id,
          collectionEntity.id,
          'has_data_in',
          `${ext.name} appears in ${collectionName}`,
          '',
        );
      }
    }

    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'datastore_indexed',
        collection: collectionName,
        entitiesLinked: linked.size,
      });
    }
  }

  /**
   * Find DataStore collections related to given entities.
   * Returns collection names + a preview of matching data.
   */
  async findRelatedData(entityIds: string[]): Promise<DataStoreHint[]> {
    if (entityIds.length === 0) return [];

    const hints: DataStoreHint[] = [];
    const seenCollections = new Set<string>();

    for (const entityId of entityIds) {
      const rows = await this.graph.query(
        `MATCH (e:Entity)-[:RELATES_TO {relation_type: 'has_data_in'}]->(c:Entity {entity_type: 'collection'})
         WHERE e.id = $entityId
         RETURN e.canonical_name AS entity_name, c.canonical_name AS collection_name`,
        { entityId },
      );

      for (const row of rows) {
        const entityName = row['entity_name'] as string;
        const collectionName = row['collection_name'] as string;
        const key = `${entityName}:${collectionName}`;
        if (seenCollections.has(key)) continue;
        seenCollections.add(key);

        // Get a small preview from the DataStore
        const preview = this._getPreview(collectionName, entityName);
        hints.push({ collection: collectionName, entityName, preview });
      }
    }

    return hints;
  }

  /**
   * Get a brief preview of data from a collection matching an entity name.
   */
  private _getPreview(collectionName: string, entityName: string): string {
    try {
      const info = this.dataStore.getCollectionInfo(collectionName);
      if (!info) return '';

      // Find string columns that might contain the entity name
      const stringColumns = info.columns
        .filter(c => c.type === 'string')
        .map(c => c.name);
      if (stringColumns.length === 0) return `${info.recordCount} records`;

      // Try to find a record matching the entity name via $like
      for (const col of stringColumns) {
        try {
          const result = this.dataStore.queryRecords({
            collection: collectionName,
            filter: { [col]: { $like: `%${entityName}%` } },
            limit: 1,
          });
          if (result.rows.length > 0) {
            const row = result.rows[0]!;
            // Build a compact preview from non-null values
            const parts: string[] = [];
            for (const [key, val] of Object.entries(row)) {
              if (key.startsWith('_') || val === null || val === undefined) continue;
              parts.push(`${key}: ${String(val).slice(0, 50)}`);
            }
            return parts.slice(0, 4).join(', ');
          }
        } catch {
          // Column might not support LIKE — skip
        }
      }

      return `${info.recordCount} records`;
    } catch {
      return '';
    }
  }
}
