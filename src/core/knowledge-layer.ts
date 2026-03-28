import type Anthropic from '@anthropic-ai/sdk';
import type {
  IKnowledgeLayer,
  MemoryNamespace,
  MemoryScopeRef,
  MemoryScopeType,
  EntityRecord,
  EntityType,
  RelationRecord,
  ContradictionInfo,
  KnowledgeStoreResult,
  KnowledgeRetrievalResult,
  KnowledgeGraphStats,
  KnowledgeGcResult,
} from '../types/index.js';
import { KuzuGraph } from './knowledge-graph.js';
import type { EmbeddingProvider } from './embedding.js';
import { EntityResolver } from './entity-resolver.js';
import { RetrievalEngine } from './retrieval-engine.js';
import type { RetrievalOptions } from './retrieval-engine.js';
import { extractEntities } from './entity-extractor.js';
import { detectContradictions } from './contradiction-detector.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import { channels } from './observability.js';
import type { LbugValue } from '@ladybugdb/core';

/** Dedup threshold: skip store if a memory with cosine > this exists. */
const DEDUP_THRESHOLD = 0.90;

/**
 * Unified Knowledge Layer — the primary API for storing and retrieving knowledge.
 *
 * Integrates: KuzuGraph (storage) + EntityExtractor + EntityResolver +
 * ContradictionDetector + RetrievalEngine.
 */
export class KnowledgeLayer implements IKnowledgeLayer {
  private readonly graph: KuzuGraph;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly entityResolver: EntityResolver;
  private readonly retrievalEngine: RetrievalEngine;
  private readonly anthropicClient: Anthropic | undefined;

  constructor(
    dbPath: string,
    embeddingProvider: EmbeddingProvider,
    anthropicClient?: Anthropic | undefined,
  ) {
    this.graph = new KuzuGraph(dbPath);
    this.embeddingProvider = embeddingProvider;
    this.entityResolver = new EntityResolver(this.graph, embeddingProvider);
    this.retrievalEngine = new RetrievalEngine(
      this.graph,
      embeddingProvider,
      this.entityResolver,
      anthropicClient,
    );
    this.anthropicClient = anthropicClient;
  }

  // === Lifecycle ===

  async init(): Promise<void> {
    await this.graph.init();
  }

  async close(): Promise<void> {
    await this.graph.close();
  }

  get isReady(): boolean {
    return this.graph.isReady;
  }

  /** Access the underlying graph (for DataStore bridge and advanced queries). */
  getGraph(): KuzuGraph {
    return this.graph;
  }

  /** Access the entity resolver (for DataStore bridge). */
  getEntityResolver(): EntityResolver {
    return this.entityResolver;
  }

  /** Connect DataStore bridge to retrieval engine for data hints. */
  setDataStoreBridge(bridge: DataStoreBridge): void {
    this.retrievalEngine.setDataStoreBridge(bridge);
  }

  // === Store ===

  async store(
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    options?: {
      sourceRunId?: string | undefined;
      skipContradictionCheck?: boolean | undefined;
      reuseEmbedding?: number[] | undefined;
    },
  ): Promise<KnowledgeStoreResult> {
    const trimmedText = text.trim();
    if (trimmedText.length < 5) {
      return {
        memoryId: '',
        entities: [],
        relations: [],
        contradictions: [],
        stored: false,
        deduplicated: false,
      };
    }

    // 1. Embed the text
    const embedding = options?.reuseEmbedding ?? await this.embeddingProvider.embed(trimmedText);

    // 2. Dedup check
    const similar = await this.graph.findSimilarMemories(embedding, 1, DEDUP_THRESHOLD, {
      namespace,
      scopeTypes: [scope.type],
      activeOnly: true,
    });

    if (similar.length > 0) {
      return {
        memoryId: similar[0]!['m.id'] as string,
        entities: [],
        relations: [],
        contradictions: [],
        stored: false,
        deduplicated: true,
      };
    }

    // 3. Contradiction detection (reuse embedding to avoid duplicate embed call)
    let contradictions: ContradictionInfo[] = [];
    if (!options?.skipContradictionCheck) {
      contradictions = await detectContradictions(
        trimmedText,
        namespace,
        scope,
        this.graph,
        this.embeddingProvider,
        embedding,
      );
    }

    // 4. Create memory node
    const memoryId = await this.graph.createMemory({
      text: trimmedText,
      namespace,
      scopeType: scope.type,
      scopeId: scope.id,
      sourceRunId: options?.sourceRunId,
      provider: this.embeddingProvider.name,
      embedding,
    });

    // 5. Mark contradicted memories as superseded
    for (const c of contradictions) {
      if (c.resolution === 'superseded') {
        await this.graph.supersedMemory(c.existingMemoryId, memoryId);
        await this.graph.createSupersedes(memoryId, c.existingMemoryId, 'contradiction');
      }
    }

    // 6. Extract entities and relations
    const extraction = await extractEntities(
      trimmedText,
      namespace,
      this.anthropicClient,
    );

    // 7. Resolve entities and create graph nodes
    const resolvedEntities: EntityRecord[] = [];
    const entityIdMap = new Map<string, string>(); // name → entity ID

    for (const ext of extraction.entities) {
      const entity = await this.entityResolver.resolve(
        ext.name,
        ext.type,
        [scope],
        { createIfMissing: true },
      );
      if (entity) {
        resolvedEntities.push(entity);
        entityIdMap.set(ext.name.toLowerCase(), entity.id);

        // Create MENTIONS relationship
        await this.graph.createMention(memoryId, entity.id);
      }
    }

    // 8. Create entity-entity relationships
    const resolvedRelations: RelationRecord[] = [];
    for (const rel of extraction.relations) {
      const fromId = entityIdMap.get(rel.from.toLowerCase());
      const toId = entityIdMap.get(rel.to.toLowerCase());
      if (fromId && toId && fromId !== toId) {
        await this.graph.createRelation(
          fromId,
          toId,
          rel.relationType,
          rel.description,
          memoryId,
        );
        resolvedRelations.push({
          fromEntityId: fromId,
          toEntityId: toId,
          relationType: rel.relationType,
          description: rel.description,
          confidence: 1.0,
          sourceMemoryId: memoryId,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // 9. Update co-occurrence for all entity pairs in this memory
    const entityIds = [...entityIdMap.values()];
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        await this.graph.updateCooccurrence(entityIds[i]!, entityIds[j]!);
      }
    }

    // 10. Publish diagnostics
    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'memory_stored',
        memoryId,
        namespace,
        entityCount: resolvedEntities.length,
        relationCount: resolvedRelations.length,
        contradictionCount: contradictions.length,
      });
    }

    return {
      memoryId,
      entities: resolvedEntities,
      relations: resolvedRelations,
      contradictions,
      stored: true,
      deduplicated: false,
    };
  }

  // === Retrieve ===

  async retrieve(
    query: string,
    scopes: MemoryScopeRef[],
    options?: RetrievalOptions | undefined,
  ): Promise<KnowledgeRetrievalResult> {
    return this.retrievalEngine.retrieve(query, scopes, options);
  }

  /**
   * Format retrieval results as system prompt context.
   * @param maxChars — optional budget; drops lowest-scored memories if exceeded.
   */
  formatRetrievalContext(result: KnowledgeRetrievalResult, maxChars?: number | undefined): string {
    return this.retrievalEngine.formatContext(result, maxChars);
  }

  // === Entity Operations ===

  async listEntities(opts?: { type?: string; limit?: number }): Promise<EntityRecord[]> {
    const limit = opts?.limit ?? 50;
    const typeFilter = opts?.type ? `WHERE e.entity_type = $type` : '';
    const params: Record<string, unknown> = opts?.type ? { type: opts.type } : {};
    const rows = await this.graph.query(
      `MATCH (e:Entity) ${typeFilter} RETURN e.id, e.canonical_name, e.entity_type, e.aliases, e.description, e.scope_type, e.scope_id, e.mention_count, e.first_seen_at, e.last_seen_at ORDER BY e.mention_count DESC LIMIT ${limit}`,
      params as Record<string, import('@ladybugdb/core').LbugValue>,
    );
    return rows.map(r => this._rowToEntity(r));
  }

  async getEntity(id: string): Promise<EntityRecord | null> {
    const rows = await this.graph.query(
      `MATCH (e:Entity) WHERE e.id = $id RETURN e.id, e.canonical_name, e.entity_type, e.aliases, e.description, e.scope_type, e.scope_id, e.mention_count, e.first_seen_at, e.last_seen_at`,
      { id } as Record<string, import('@ladybugdb/core').LbugValue>,
    );
    const r = rows[0];
    if (!r) return null;
    return this._rowToEntity(r);
  }

  private _rowToEntity(r: Record<string, import('@ladybugdb/core').LbugValue>): EntityRecord {
    return {
      id: String(r['e.id'] ?? ''),
      canonicalName: String(r['e.canonical_name'] ?? ''),
      entityType: (String(r['e.entity_type'] ?? 'concept')) as EntityType,
      aliases: Array.isArray(r['e.aliases']) ? r['e.aliases'].map(String) : [],
      description: String(r['e.description'] ?? ''),
      scopeType: (String(r['e.scope_type'] ?? 'global')) as MemoryScopeType,
      scopeId: String(r['e.scope_id'] ?? ''),
      mentionCount: Number(r['e.mention_count'] ?? 0),
      firstSeenAt: String(r['e.first_seen_at'] ?? ''),
      lastSeenAt: String(r['e.last_seen_at'] ?? ''),
    };
  }

  async resolveEntity(name: string, scopes: MemoryScopeRef[]): Promise<EntityRecord | null> {
    return this.entityResolver.resolve(name, 'concept', scopes, { createIfMissing: false });
  }

  async getEntityRelations(entityId: string, depth?: number | undefined): Promise<RelationRecord[]> {
    const maxDepth = depth ?? 1;
    const rows = await this.graph.query(
      `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
       WHERE a.id = $entityId
       RETURN a.id AS from_id, b.id AS to_id, r.relation_type, r.description,
              r.confidence, r.source_memory_id, r.created_at
       LIMIT ${maxDepth * 20}`,
      { entityId },
    );

    return rows.map(row => ({
      fromEntityId: row['from_id'] as string,
      toEntityId: row['to_id'] as string,
      relationType: row['r.relation_type'] as string,
      description: (row['r.description'] as string) ?? '',
      confidence: (row['r.confidence'] as number) ?? 1.0,
      sourceMemoryId: (row['r.source_memory_id'] as string) ?? '',
      createdAt: String(row['r.created_at'] ?? ''),
    }));
  }

  async mergeEntities(sourceId: string, targetId: string): Promise<void> {
    return this.entityResolver.merge(sourceId, targetId);
  }

  // === Relationship Queries ===

  async findPath(
    fromEntityId: string,
    toEntityId: string,
    maxHops?: number | undefined,
  ): Promise<RelationRecord[]> {
    const hops = maxHops ?? 3;
    const rows = await this.graph.query(
      `MATCH path = (a:Entity)-[:RELATES_TO* ..${hops}]->(b:Entity)
       WHERE a.id = $fromId AND b.id = $toId
       RETURN nodes(path), rels(path)
       LIMIT 1`,
      { fromId: fromEntityId, toId: toEntityId },
    );

    // Parse path into relation records
    if (rows.length === 0) return [];

    const rels = rows[0]!['rels(path)'];
    if (!Array.isArray(rels)) return [];

    return rels.map((rel: LbugValue) => {
      const r = rel as Record<string, LbugValue>;
      return {
        fromEntityId: '',
        toEntityId: '',
        relationType: (r['relation_type'] as string) ?? '',
        description: (r['description'] as string) ?? '',
        confidence: (r['confidence'] as number) ?? 1.0,
        sourceMemoryId: (r['source_memory_id'] as string) ?? '',
        createdAt: String(r['created_at'] ?? ''),
      };
    });
  }

  async getNeighborhood(
    entityId: string,
    hops?: number | undefined,
  ): Promise<{ entities: EntityRecord[]; relations: RelationRecord[] }> {
    const maxHops = hops ?? 1;

    // Get related entities
    const entityRows = await this.graph.query(
      `MATCH (a:Entity)-[:RELATES_TO* ..${maxHops}]-(b:Entity)
       WHERE a.id = $entityId AND a.id <> b.id
       RETURN DISTINCT b.id, b.canonical_name, b.entity_type, b.aliases,
              b.description, b.scope_type, b.scope_id, b.mention_count,
              b.first_seen_at, b.last_seen_at
       LIMIT 20`,
      { entityId },
    );

    const entities: EntityRecord[] = entityRows.map(row => ({
      id: row['b.id'] as string,
      canonicalName: row['b.canonical_name'] as string,
      entityType: row['b.entity_type'] as EntityRecord['entityType'],
      aliases: (row['b.aliases'] as string[]) ?? [],
      description: (row['b.description'] as string) ?? '',
      scopeType: row['b.scope_type'] as EntityRecord['scopeType'],
      scopeId: (row['b.scope_id'] as string) ?? '',
      mentionCount: Number(row['b.mention_count'] ?? 1),
      firstSeenAt: String(row['b.first_seen_at'] ?? ''),
      lastSeenAt: String(row['b.last_seen_at'] ?? ''),
    }));

    // Get relations between the entity and its neighbors
    const relations = await this.getEntityRelations(entityId, maxHops);

    return { entities, relations };
  }

  // === Update / Delete ===

  /**
   * Deactivate memories matching a text pattern in the graph.
   * Called by memory_delete tool to keep graph in sync with flat files.
   */
  async deactivateByPattern(pattern: string, namespace?: MemoryNamespace | undefined): Promise<number> {
    return this.graph.deactivateMemoriesByPattern(pattern, namespace);
  }

  /**
   * Update memory text in the graph and re-extract entities.
   * Called by memory_update tool to keep graph in sync with flat files.
   */
  async updateMemoryText(
    oldText: string,
    newText: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
  ): Promise<boolean> {
    const memoryId = await this.graph.updateMemoryText(oldText, newText, namespace);
    if (!memoryId) return false;

    // Re-extract entities for the new text and link them
    const extraction = await extractEntities(newText, namespace, this.anthropicClient);
    for (const ext of extraction.entities) {
      const entity = await this.entityResolver.resolve(ext.name, ext.type, [scope], { createIfMissing: true });
      if (entity) {
        await this.graph.createMention(memoryId, entity.id);
      }
    }

    return true;
  }

  // === Contradiction Detection ===

  async checkContradictions(
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
  ): Promise<ContradictionInfo[]> {
    return detectContradictions(text, namespace, scope, this.graph, this.embeddingProvider);
  }

  // === Maintenance ===

  async gc(options?: { dryRun?: boolean | undefined }): Promise<KnowledgeGcResult> {
    const dryRun = options?.dryRun ?? false;
    const result: KnowledgeGcResult = {
      supersededRemoved: 0,
      orphanEntitiesRemoved: 0,
      staleMemoriesRemoved: 0,
    };

    // 1. Count superseded memories (already marked inactive)
    const superseded = await this.graph.queryScalar<bigint>(
      'MATCH (m:Memory) WHERE m.is_active = false RETURN count(m) AS cnt',
    );
    result.supersededRemoved = Number(superseded ?? 0);

    if (!dryRun && result.supersededRemoved > 0) {
      // Delete superseded memories older than 90 days
      await this.graph.execute(
        `MATCH (m:Memory)
         WHERE m.is_active = false
         DETACH DELETE m`,
      );
    }

    // 2. Find orphan entities (not mentioned by any active memory)
    const orphans = await this.graph.query(
      `MATCH (e:Entity)
       WHERE NOT EXISTS {
         MATCH (m:Memory)-[:MENTIONS]->(e) WHERE m.is_active = true
       }
       RETURN e.id`,
    );
    result.orphanEntitiesRemoved = orphans.length;

    if (!dryRun && orphans.length > 0) {
      for (const row of orphans) {
        await this.graph.execute(
          'MATCH (e:Entity) WHERE e.id = $id DETACH DELETE e',
          { id: row['e.id'] as string },
        );
      }
    }

    return result;
  }

  // === Stats ===

  async stats(): Promise<KnowledgeGraphStats> {
    const [memoryCount, entityCount, relationCount, communityCount] = await Promise.all([
      this.graph.getActiveMemoryCount(),
      this.graph.getEntityCount(),
      this.graph.getRelationCount(),
      this.graph.getCommunityCount(),
    ]);

    return { memoryCount, entityCount, relationCount, communityCount };
  }
}
