import type {
  MemoryScopeRef,
  DataStoreColumnDef,
} from '../types/index.js';
import type { AgentMemoryDb } from './agent-memory-db.js';
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
    private readonly db: AgentMemoryDb,
    private readonly entityResolver: EntityResolver,
    private readonly dataStore: DataStore,
  ) {}

  /**
   * Register a DataStore collection as an entity in the Knowledge Graph.
   */
  async registerCollection(
    name: string,
    columns: DataStoreColumnDef[],
    scope: MemoryScopeRef,
  ): Promise<void> {
    const existing = this.db.findEntityByCanonicalName(name);
    if (existing) return;

    const colDesc = columns.map(c => `${c.name} (${c.type})`).join(', ');
    this.db.createEntity({
      canonicalName: name,
      entityType: 'collection',
      aliases: [name],
      description: `Data table: ${name} — columns: ${colDesc}`,
      scopeType: scope.type,
      scopeId: scope.id,
    });

    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({ event: 'collection_registered', collection: name });
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
    const info = this.dataStore.getCollectionInfo(collectionName);
    if (!info) return;

    const stringColumns = info.columns
      .filter(c => c.type === 'string')
      .map(c => c.name);
    if (stringColumns.length === 0) return;

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

    const { entities } = extractEntitiesRegex(textParts.join(' '));
    if (entities.length === 0) return;

    const collectionEntity = await this.entityResolver.resolve(
      collectionName, 'collection', [scope], { createIfMissing: false },
    );
    if (!collectionEntity) return;

    const linked = new Set<string>();

    for (const ext of entities.slice(0, MAX_ENTITIES_PER_BATCH)) {
      const entity = await this.entityResolver.resolve(
        ext.name, ext.type, [scope], { createIfMissing: true },
      );
      if (!entity || entity.id === collectionEntity.id) continue;

      const linkKey = `${entity.id}:${collectionEntity.id}`;
      if (linked.has(linkKey)) continue;
      linked.add(linkKey);

      // Check if relationship already exists
      const existingRels = this.db.getEntityRelations(entity.id);
      const hasLink = existingRels.some(
        r => r.relation_type === 'has_data_in'
          && ((r.from_entity_id === entity.id && r.to_entity_id === collectionEntity.id)
            || (r.to_entity_id === entity.id && r.from_entity_id === collectionEntity.id)),
      );

      if (!hasLink) {
        this.db.createRelation(
          entity.id, collectionEntity.id, 'has_data_in',
          `${ext.name} appears in ${collectionName}`, '',
        );
      }
    }

    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'datastore_indexed', collection: collectionName, entitiesLinked: linked.size,
      });
    }
  }

  /**
   * Find DataStore collections related to given entities.
   */
  async findRelatedData(entityIds: string[]): Promise<DataStoreHint[]> {
    if (entityIds.length === 0) return [];

    const hints: DataStoreHint[] = [];
    const seen = new Set<string>();

    for (const entityId of entityIds) {
      const entity = this.db.getEntity(entityId);
      if (!entity) continue;

      const rels = this.db.getEntityRelations(entityId);
      for (const rel of rels) {
        if (rel.relation_type !== 'has_data_in') continue;
        const collectionId = rel.from_entity_id === entityId ? rel.to_entity_id : rel.from_entity_id;
        const collectionEntity = this.db.getEntity(collectionId);
        if (!collectionEntity || collectionEntity.entity_type !== 'collection') continue;

        const key = `${entity.canonical_name}:${collectionEntity.canonical_name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const preview = this._getPreview(collectionEntity.canonical_name, entity.canonical_name);
        hints.push({ collection: collectionEntity.canonical_name, entityName: entity.canonical_name, preview });
      }
    }

    return hints;
  }

  private _getPreview(collectionName: string, entityName: string): string {
    try {
      const info = this.dataStore.getCollectionInfo(collectionName);
      if (!info) return '';

      const stringColumns = info.columns.filter(c => c.type === 'string').map(c => c.name);
      if (stringColumns.length === 0) return `${info.recordCount} records`;

      for (const col of stringColumns) {
        try {
          const result = this.dataStore.queryRecords({
            collection: collectionName,
            filter: { [col]: { $like: `%${entityName}%` } },
            limit: 1,
          });
          if (result.rows.length > 0) {
            const row = result.rows[0]!;
            const parts: string[] = [];
            for (const [key, val] of Object.entries(row)) {
              if (key.startsWith('_') || val === null || val === undefined) continue;
              parts.push(`${key}: ${String(val).slice(0, 50)}`);
            }
            return parts.slice(0, 4).join(', ');
          }
        } catch {
          // Column might not support LIKE
        }
      }

      return `${info.recordCount} records`;
    } catch {
      return '';
    }
  }
}
