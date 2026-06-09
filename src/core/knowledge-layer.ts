import type Anthropic from '@anthropic-ai/sdk';
import type {
  IKnowledgeLayer,
  MemoryNamespace,
  MemoryScopeRef,
  EntityRecord,
  RelationRecord,
  ContradictionInfo,
  KnowledgeStoreResult,
  KnowledgeRetrievalResult,
  KnowledgeGraphStats,
  KnowledgeGcResult,
  MetricWindow,
  MetricRecord,
  ProvenanceKind,
} from '../types/index.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { EntityResolver, toEntityRecord } from './entity-resolver.js';
import { RetrievalEngine } from './retrieval-engine.js';
import type { RetrievalOptions } from './retrieval-engine.js';
import { extractEntities } from './entity-extractor.js';
import { extractEntitiesV2, shouldExtractV2 } from './entity-extractor-v2.js';
import { detectContradictions, hasHeuristicContradiction } from './contradiction-detector.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import { KpiEngine } from './kpi-engine.js';
import type { RunHistory } from './run-history.js';
import { channels } from './observability.js';

/** Dedup threshold: skip store if a memory with cosine > this exists. */
const DEDUP_THRESHOLD = 0.95;

/**
 * Unified Knowledge Layer — the primary API for storing and retrieving knowledge.
 *
 * Integrates: AgentMemoryDb (SQLite) + EntityResolver + RetrievalEngine +
 * ContradictionDetector + KpiEngine + RunHistory (for insights).
 */
export class KnowledgeLayer implements IKnowledgeLayer {
  private readonly db: AgentMemoryDb;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly entityResolver: EntityResolver;
  private readonly retrievalEngine: RetrievalEngine;
  private anthropicClient: Anthropic | undefined;
  private readonly kpiEngine: KpiEngine | null;
  private readonly runHistory: RunHistory | null;
  /** Tool-call extractor (Haiku + strict schema). Default since v1.3.4; opt-out via LYNOX_KG_EXTRACTOR=v1. */
  private readonly useV2Extractor: boolean;

  constructor(
    dbPath: string,
    embeddingProvider: EmbeddingProvider,
    anthropicClient?: Anthropic | undefined,
    runHistory?: RunHistory | undefined,
  ) {
    this.db = new AgentMemoryDb(dbPath);
    this.db.setEmbeddingDimensions(embeddingProvider.dimensions);
    this.embeddingProvider = embeddingProvider;
    this.entityResolver = new EntityResolver(this.db, embeddingProvider);
    this.retrievalEngine = new RetrievalEngine(
      this.db, embeddingProvider, this.entityResolver, anthropicClient, runHistory,
    );
    this.anthropicClient = anthropicClient;
    this.runHistory = runHistory ?? null;
    this.kpiEngine = runHistory ? new KpiEngine(runHistory, this.db) : null;
    this.useV2Extractor = process.env['LYNOX_KG_EXTRACTOR'] !== 'v1';
  }

  /**
   * Replace the LLM client after a runtime provider switch. KG entity
   * extraction + HyDE retrieval both embed user content (mail, memory
   * text, customer data) in LLM prompts. Without this setter a UI
   * provider-switch leaves these calls hitting the old provider until
   * container restart — a GDPR / EU-residency leak.
   *
   * Also propagates to the RetrievalEngine which holds its own client
   * reference (for HyDE).
   */
  setAnthropicClient(client: Anthropic | undefined): void {
    this.anthropicClient = client;
    this.retrievalEngine.setAnthropicClient(client);
  }

  // === Lifecycle ===

  async init(): Promise<void> {
    // Schema already created in AgentMemoryDb constructor (synchronous)
  }

  async close(): Promise<void> {
    this.db.close();
  }

  get isReady(): boolean { return true; }

  /** Access the underlying DB (for DataStore bridge and advanced queries). */
  getDb(): AgentMemoryDb { return this.db; }

  /** Access the entity resolver (for DataStore bridge). */
  getEntityResolver(): EntityResolver { return this.entityResolver; }

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
      sourceThreadId?: string | undefined;
      sourceType?: ProvenanceKind | undefined;
      sourceToolName?: string | undefined;
      skipContradictionCheck?: boolean | undefined;
      reuseEmbedding?: number[] | undefined;
    },
  ): Promise<KnowledgeStoreResult> {
    const trimmedText = text.trim();
    if (trimmedText.length < 5) {
      return { memoryId: '', entities: [], relations: [], contradictions: [], stored: false, deduplicated: false };
    }

    // 1. Embed the text
    const embedding = options?.reuseEmbedding ?? await this.embeddingProvider.embed(trimmedText);

    // 2. Dedup check — but bypass dedup when contradiction signals are present.
    // Filter by `scopeIds:[scope.id]` so a `context:acme` memory cannot dedup
    // against a `context:beta` memory with similar text (cross-project bleed).
    const similar = this.db.findSimilarMemories(embedding, 1, DEDUP_THRESHOLD, {
      namespace, scopeTypes: [scope.type], scopeIds: [scope.id], activeOnly: true,
    });

    if (similar.length > 0) {
      const candidate = similar[0]!;
      // If the texts contain contradictory signals (different numbers, negation,
      // state change), this is an update — not a duplicate. Skip dedup and let
      // the contradiction detector handle it.
      if (!hasHeuristicContradiction(trimmedText, candidate.text)) {
        this.db.confirmMemory(candidate.id);
        return { memoryId: candidate.id, entities: [], relations: [], contradictions: [], stored: false, deduplicated: true };
      }
      // Fall through to contradiction detection
    }

    // 3. Contradiction detection
    let contradictions: ContradictionInfo[] = [];
    if (!options?.skipContradictionCheck) {
      contradictions = await detectContradictions(
        trimmedText, namespace, scope, this.db, this.embeddingProvider, embedding,
      );
    }

    // 4+5. Create memory + supersede contradicted (atomic transaction)
    const memoryId = this.db.transaction(() => {
      const id = this.db.createMemory({
        text: trimmedText, namespace, scopeType: scope.type, scopeId: scope.id,
        sourceRunId: options?.sourceRunId, sourceThreadId: options?.sourceThreadId,
        sourceType: options?.sourceType, sourceToolName: options?.sourceToolName,
        provider: this.embeddingProvider.name, embedding,
      });
      for (const c of contradictions) {
        if (c.resolution === 'superseded') {
          this.db.supersedMemory(c.existingMemoryId, id);
          this.db.createSupersedes(id, c.existingMemoryId, 'contradiction');
        }
      }
      return id;
    });

    // 6. Extract entities and relations (async LLM call — outside transaction)
    const { resolvedEntities, resolvedRelations } = this.useV2Extractor
      && this.anthropicClient
      && shouldExtractV2(trimmedText, namespace)
      ? await this._extractAndPersistV2(trimmedText, scope, memoryId)
      : await this._extractAndPersistV1(trimmedText, namespace, scope, memoryId);

    // 10. Publish event
    if (channels.knowledgeGraph.hasSubscribers) {
      channels.knowledgeGraph.publish({
        event: 'memory_stored', memoryId, namespace,
        entityCount: resolvedEntities.length,
        relationCount: resolvedRelations.length,
        contradictionCount: contradictions.length,
      });
    }

    return {
      memoryId, entities: resolvedEntities, relations: resolvedRelations,
      contradictions, stored: true, deduplicated: false,
    };
  }

  /** V1 extraction path — regex + optional Haiku free-text JSON. */
  private async _extractAndPersistV1(
    trimmedText: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    memoryId: string,
  ): Promise<{ resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[] }> {
    const extraction = await extractEntities(trimmedText, namespace, this.anthropicClient);

    return this.db.transaction(() => {
      const entities: EntityRecord[] = [];
      const entityIdMap = new Map<string, string>();

      const entityNames = extraction.entities.map(e => e.name);
      const existingEntities = this.db.findEntitiesByNames(entityNames);
      const idsToIncrement: string[] = [];

      for (const ext of extraction.entities) {
        const row = existingEntities.get(ext.name.toLowerCase());
        let entity: EntityRecord | null = null;
        if (row) {
          idsToIncrement.push(row.id);
          entity = toEntityRecord(row);
        } else {
          const id = this.db.createEntity({
            canonicalName: ext.name, entityType: ext.type,
            aliases: [ext.name], scopeType: scope.type, scopeId: scope.id,
          });
          entity = {
            id, canonicalName: ext.name, entityType: ext.type, aliases: [ext.name],
            description: '', scopeType: scope.type, scopeId: scope.id,
            mentionCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          };
        }
        entities.push(entity);
        entityIdMap.set(ext.name.toLowerCase(), entity.id);
        this.db.createMention(memoryId, entity.id);
      }

      this.db.incrementEntityMentionsBatch(idsToIncrement);

      const relations: RelationRecord[] = [];
      for (const rel of extraction.relations) {
        const fromId = entityIdMap.get(rel.from.toLowerCase());
        const toId = entityIdMap.get(rel.to.toLowerCase());
        if (fromId && toId && fromId !== toId) {
          this.db.createRelation(fromId, toId, rel.relationType, rel.description, memoryId);
          relations.push({
            fromEntityId: fromId, toEntityId: toId,
            relationType: rel.relationType, description: rel.description,
            confidence: 1.0, sourceMemoryId: memoryId, createdAt: new Date().toISOString(),
          });
        }
      }

      this.db.updateCooccurrencesBatch([...entityIdMap.values()]);
      return { resolvedEntities: entities, resolvedRelations: relations };
    });
  }

  /** V2 extraction path — Haiku + strict tool-call schema with aliases. */
  private async _extractAndPersistV2(
    trimmedText: string,
    scope: MemoryScopeRef,
    memoryId: string,
  ): Promise<{ resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[] }> {
    const extraction = await extractEntitiesV2(trimmedText, this.anthropicClient!);

    return this.db.transaction(() => {
      const entities: EntityRecord[] = [];
      const entityIdMap = new Map<string, string>();

      const canonicalNames = extraction.entities.map(e => e.canonicalName);
      const existing = this.db.findEntitiesByNames(canonicalNames);
      const idsToIncrement: string[] = [];

      for (const ext of extraction.entities) {
        const row = existing.get(ext.canonicalName.toLowerCase());
        let entity: EntityRecord;
        if (row) {
          idsToIncrement.push(row.id);
          entity = toEntityRecord(row);
          // Register any new aliases seen in this chunk
          for (const alias of ext.aliases) this.db.addEntityAlias(row.id, alias);
        } else {
          const id = this.db.createEntity({
            canonicalName: ext.canonicalName, entityType: ext.type,
            aliases: [ext.canonicalName, ...ext.aliases],
            scopeType: scope.type, scopeId: scope.id,
          });
          entity = {
            id, canonicalName: ext.canonicalName, entityType: ext.type,
            aliases: [ext.canonicalName, ...ext.aliases],
            description: '', scopeType: scope.type, scopeId: scope.id,
            mentionCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          };
        }
        entities.push(entity);
        entityIdMap.set(ext.canonicalName.toLowerCase(), entity.id);
        this.db.createMention(memoryId, entity.id);
      }

      this.db.incrementEntityMentionsBatch(idsToIncrement);

      const relations: RelationRecord[] = [];
      for (const rel of extraction.relations) {
        const fromId = entityIdMap.get(rel.subject.toLowerCase());
        const toId = entityIdMap.get(rel.object.toLowerCase());
        if (fromId && toId && fromId !== toId) {
          this.db.createRelation(fromId, toId, rel.predicate, '', memoryId);
          relations.push({
            fromEntityId: fromId, toEntityId: toId,
            relationType: rel.predicate, description: '',
            confidence: rel.confidence, sourceMemoryId: memoryId,
            createdAt: new Date().toISOString(),
          });
        }
      }

      this.db.updateCooccurrencesBatch([...entityIdMap.values()]);
      return { resolvedEntities: entities, resolvedRelations: relations };
    });
  }

  /**
   * Purge all knowledge extracted from a specific thread.
   * Deletes memories and orphaned entities (reference-counted).
   */
  purgeThread(threadId: string): number {
    return this.db.purgeByThread(threadId);
  }

  // === Retrieve ===

  async retrieve(
    query: string,
    scopes: MemoryScopeRef[],
    options?: RetrievalOptions,
  ): Promise<KnowledgeRetrievalResult> {
    return this.retrievalEngine.retrieve(query, scopes, options);
  }

  /**
   * List the most-recent active memories for a namespace+scope set, ordered
   * by `created_at DESC`. Used by `memory_recall` for the no-query path (the
   * query path uses vector retrieval via `retrieve()`). Returns a thin
   * `KnowledgeRetrievalResult.memories`-shaped slice so the caller can format
   * uniformly with ranked recall — `finalScore` is left at 0 (recency-ordered,
   * not similarity-ranked) and `source` is `'vector'` as a placeholder.
   */
  listRecentActive(
    namespace: MemoryNamespace,
    scopes: MemoryScopeRef[],
    limit = 20,
  ): KnowledgeRetrievalResult['memories'] {
    const scopeFilters = scopes.map(s => ({ type: s.type, id: s.id }));
    const rows = this.db.listActiveMemories(namespace, scopeFilters, limit);
    return rows.map(r => ({
      id: r.id,
      text: r.text,
      namespace: r.namespace as MemoryNamespace,
      scopeType: r.scope_type as MemoryScopeRef['type'],
      scopeId: r.scope_id,
      score: r.confidence,
      finalScore: 0,
      source: 'recency' as const,
      sourceType: r.source_type as ProvenanceKind,
      sourceToolName: r.source_tool_name,
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  formatRetrievalContext(
    result: KnowledgeRetrievalResult,
    maxChars?: number | undefined,
    _query?: string | undefined,
  ): string {
    return this.retrievalEngine.formatContext(result, maxChars);
  }

  // === Entity Operations ===

  async listEntities(opts?: { type?: string; limit?: number; offset?: number }): Promise<EntityRecord[]> {
    return this.db.listEntities(opts).map(toEntityRecord);
  }

  async getEntity(id: string): Promise<EntityRecord | null> {
    const row = this.db.getEntity(id);
    return row ? toEntityRecord(row) : null;
  }

  async resolveEntity(name: string, scopes: MemoryScopeRef[]): Promise<EntityRecord | null> {
    return this.entityResolver.resolve(name, 'concept', scopes, { createIfMissing: false });
  }

  async getEntityRelations(entityId: string, depth?: number | undefined): Promise<RelationRecord[]> {
    const rows = this.db.getEntityRelations(entityId, depth === undefined ? 50 : depth * 20);
    return rows.map(r => ({
      fromEntityId: r.from_entity_id,
      toEntityId: r.to_entity_id,
      relationType: r.relation_type,
      description: r.description,
      confidence: r.confidence,
      sourceMemoryId: r.source_memory_id ?? '',
      createdAt: r.created_at,
    }));
  }

  async mergeEntities(sourceId: string, targetId: string): Promise<void> {
    return this.entityResolver.merge(sourceId, targetId);
  }

  async findPath(fromEntityId: string, toEntityId: string, maxHops?: number | undefined): Promise<RelationRecord[]> {
    const rows = this.db.findPath(fromEntityId, toEntityId, maxHops);
    return rows.map(r => ({
      fromEntityId: r.from_entity_id, toEntityId: r.to_entity_id,
      relationType: r.relation_type, description: r.description,
      confidence: r.confidence, sourceMemoryId: r.source_memory_id ?? '',
      createdAt: r.created_at,
    }));
  }

  async getNeighborhood(entityId: string, hops?: number | undefined): Promise<{
    entities: EntityRecord[];
    relations: RelationRecord[];
  }> {
    const result = this.db.getNeighborhood(entityId, hops);
    return {
      entities: result.entities.map(toEntityRecord),
      relations: result.relations.map(r => ({
        fromEntityId: r.from_entity_id, toEntityId: r.to_entity_id,
        relationType: r.relation_type, description: r.description,
        confidence: r.confidence, sourceMemoryId: r.source_memory_id ?? '',
        createdAt: r.created_at,
      })),
    };
  }

  // === Update/Delete ===

  async checkContradictions(text: string, namespace: MemoryNamespace, scope: MemoryScopeRef): Promise<ContradictionInfo[]> {
    return detectContradictions(text, namespace, scope, this.db, this.embeddingProvider);
  }

  async deactivateByPattern(pattern: string, namespace?: MemoryNamespace | undefined): Promise<number> {
    return this.db.deactivateMemoriesByPattern(pattern, namespace);
  }

  async updateMemoryText(
    oldText: string, newText: string, namespace: MemoryNamespace, scope: MemoryScopeRef,
  ): Promise<boolean> {
    const id = this.db.updateMemoryText(oldText, newText, namespace);
    if (!id) return false;

    // Re-extract entities for the updated text
    const extraction = await extractEntities(newText, namespace, this.anthropicClient);
    for (const ext of extraction.entities) {
      const entity = await this.entityResolver.resolve(ext.name, ext.type, [scope], { createIfMissing: true });
      if (entity) this.db.createMention(id, entity.id);
    }

    return true;
  }

  // === Maintenance ===

  async gc(options?: { dryRun?: boolean | undefined }): Promise<KnowledgeGcResult> {
    return this.db.gc(options?.dryRun ?? false);
  }

  async stats(): Promise<KnowledgeGraphStats> {
    return {
      memoryCount: this.db.getActiveMemoryCount(),
      entityCount: this.db.getEntityCount(),
      relationCount: this.db.getRelationCount(),
      communityCount: 0,
    };
  }

  // === Metrics ===

  getMetrics(metricName?: string | undefined, window?: MetricWindow | undefined): MetricRecord[] {
    return this.db.getMetrics(metricName, window).map(r => ({
      id: r.id, metricName: r.metric_name,
      scopeType: r.scope_type, scopeId: r.scope_id,
      value: r.value, sampleCount: r.sample_count,
      window: r.window as MetricWindow, computedAt: r.computed_at,
    }));
  }

  // === Intelligence Layer ===

  /** Run KPI computation. Called periodically by engine. */
  runIntelligence(): void {
    if (!this.kpiEngine) return;
    try {
      this.kpiEngine.computeKPIs();
    } catch { /* non-critical */ }
  }

  /** Provide feedback on retrieved memories. */
  feedbackOnRetrieval(memoryIds: string[], signal: 'useful' | 'wrong'): void {
    for (const id of memoryIds) {
      if (signal === 'useful') this.db.confirmMemory(id);
      else this.db.penalizeMemory(id);
    }
  }

  /** Consolidate similar memories within a scope. Returns count merged. */
  consolidateMemories(namespace: MemoryNamespace, scopeType: string, scopeId: string): number {
    return this.db.consolidateMemories(namespace, scopeType, scopeId);
  }
}
