import type Anthropic from '@anthropic-ai/sdk';
import type {
  IKnowledgeLayer,
  MemoryNamespace,
  MemoryScopeRef,
  MemoryScopeType,
  EntityRecord,
  RelationRecord,
  ContradictionInfo,
  KnowledgeStoreResult,
  KnowledgeRetrievalResult,
  KnowledgeGraphStats,
  KnowledgeGcResult,
  PatternType,
  PatternRecord,
  MetricWindow,
  MetricRecord,
} from '../types/index.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { EntityResolver, toEntityRecord } from './entity-resolver.js';
import { RetrievalEngine } from './retrieval-engine.js';
import type { RetrievalOptions } from './retrieval-engine.js';
import { extractEntities } from './entity-extractor.js';
import { detectContradictions } from './contradiction-detector.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import { PatternEngine } from './pattern-engine.js';
import type { RunHistory } from './run-history.js';
import { channels } from './observability.js';

/** Dedup threshold: skip store if a memory with cosine > this exists. */
const DEDUP_THRESHOLD = 0.90;

/**
 * Unified Knowledge Layer — the primary API for storing and retrieving knowledge.
 *
 * Integrates: AgentMemoryDb (SQLite) + EntityResolver + RetrievalEngine +
 * ContradictionDetector + PatternEngine + RunHistory (for insights).
 */
export class KnowledgeLayer implements IKnowledgeLayer {
  private readonly db: AgentMemoryDb;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly entityResolver: EntityResolver;
  private readonly retrievalEngine: RetrievalEngine;
  private readonly anthropicClient: Anthropic | undefined;
  private readonly patternEngine: PatternEngine | null;
  private readonly runHistory: RunHistory | null;

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
    this.patternEngine = runHistory ? new PatternEngine(runHistory, this.db) : null;
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

    // 2. Dedup check
    const similar = this.db.findSimilarMemories(embedding, 1, DEDUP_THRESHOLD, {
      namespace, scopeTypes: [scope.type], activeOnly: true,
    });

    if (similar.length > 0) {
      // Boost confidence of the existing memory — repeated storage = confirmation
      const existingId = similar[0]!.id;
      this.db.confirmMemory(existingId);
      return { memoryId: existingId, entities: [], relations: [], contradictions: [], stored: false, deduplicated: true };
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
        sourceRunId: options?.sourceRunId, provider: this.embeddingProvider.name, embedding,
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
    const extraction = await extractEntities(trimmedText, namespace, this.anthropicClient);

    // 7+8+9. Resolve entities, create mentions/relations/cooccurrences (atomic transaction)
    const { resolvedEntities, resolvedRelations } = this.db.transaction(() => {
      const entities: EntityRecord[] = [];
      const entityIdMap = new Map<string, string>();

      for (const ext of extraction.entities) {
        // entityResolver.resolve is sync internally (all DB ops are sync)
        const row = this.db.findEntityByCanonicalName(ext.name)
          ?? this.db.findEntityByAlias(ext.name);
        let entity: EntityRecord | null = null;
        if (row) {
          this.db.incrementEntityMentions(row.id);
          entity = toEntityRecord(row);
        } else {
          const scopeRef = scope;
          const id = this.db.createEntity({
            canonicalName: ext.name, entityType: ext.type,
            aliases: [ext.name], scopeType: scopeRef.type, scopeId: scopeRef.id,
          });
          entity = {
            id, canonicalName: ext.name, entityType: ext.type, aliases: [ext.name],
            description: '', scopeType: scopeRef.type, scopeId: scopeRef.id,
            mentionCount: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          };
        }
        if (entity) {
          entities.push(entity);
          entityIdMap.set(ext.name.toLowerCase(), entity.id);
          this.db.createMention(memoryId, entity.id);
        }
      }

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

      const eIds = [...entityIdMap.values()];
      for (let i = 0; i < eIds.length; i++) {
        for (let j = i + 1; j < eIds.length; j++) {
          this.db.updateCooccurrence(eIds[i]!, eIds[j]!);
        }
      }

      return { resolvedEntities: entities, resolvedRelations: relations };
    });

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

  // === Retrieve ===

  async retrieve(
    query: string,
    scopes: MemoryScopeRef[],
    options?: RetrievalOptions,
  ): Promise<KnowledgeRetrievalResult> {
    return this.retrievalEngine.retrieve(query, scopes, options);
  }

  formatRetrievalContext(result: KnowledgeRetrievalResult, maxChars?: number | undefined): string {
    let context = this.retrievalEngine.formatContext(result, maxChars);

    // Inject active patterns and recent relevant episodes into context
    const extras = this._formatIntelligenceContext();
    if (extras && context) {
      context = context.replace('</relevant_context>', `${extras}\n</relevant_context>`);
    } else if (extras && !context) {
      context = `<relevant_context>\n${extras}\n</relevant_context>`;
    }

    return context;
  }

  /** Format patterns + recent episodes as context for the agent. */
  private _formatIntelligenceContext(): string {
    const parts: string[] = [];

    // Active patterns with high confidence
    const patterns = this.db.getPatterns({ activeOnly: true, limit: 5 });
    const strongPatterns = patterns.filter(p => p.confidence >= 0.6 && p.evidence_count >= 3);
    if (strongPatterns.length > 0) {
      const lines = strongPatterns.map(p =>
        `- [${p.pattern_type}] ${p.description} (${(p.confidence * 100).toFixed(0)}% confidence, ${p.evidence_count}x observed)`,
      );
      parts.push(`<learned_patterns>\n${lines.join('\n')}\n</learned_patterns>`);
    }

    // Recent successful runs for context
    if (this.runHistory) {
      const recent = this.runHistory.getRunsForAnalysis(10);
      const successful = recent.filter(r => r.status === 'completed' && r.toolNames.length > 0);
      if (successful.length > 0) {
        const lines = successful.slice(0, 3).map(r => {
          const toolStr = r.toolNames.length > 0 ? ` (tools: ${r.toolNames.join(', ')})` : '';
          return `- run ${r.id.slice(0, 8)}${toolStr}`;
        });
        parts.push(`<recent_successes>\n${lines.join('\n')}\n</recent_successes>`);
      }
    }

    return parts.join('\n');
  }

  // === Entity Operations ===

  async listEntities(opts?: { type?: string; limit?: number }): Promise<EntityRecord[]> {
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
      patternCount: this.db.getPatternCount(),
    };
  }

  // === Pattern Engine ===

  getPatterns(opts?: {
    patternType?: PatternType | undefined;
    activeOnly?: boolean | undefined;
    limit?: number | undefined;
  }): PatternRecord[] {
    return this.db.getPatterns(opts).map(r => ({
      id: r.id, patternType: r.pattern_type as PatternType,
      description: r.description, evidenceCount: r.evidence_count,
      confidence: r.confidence, lastSeenAt: r.last_seen_at,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      isActive: r.is_active === 1, createdAt: r.created_at,
    }));
  }

  getMetrics(metricName?: string | undefined, window?: MetricWindow | undefined): MetricRecord[] {
    return this.db.getMetrics(metricName, window).map(r => ({
      id: r.id, metricName: r.metric_name,
      scopeType: r.scope_type, scopeId: r.scope_id,
      value: r.value, sampleCount: r.sample_count,
      window: r.window as MetricWindow, computedAt: r.computed_at,
    }));
  }

  // === Intelligence Layer ===

  /** Run pattern detection + KPI computation. Called periodically by engine. */
  runIntelligence(): void {
    if (!this.patternEngine) return;
    try {
      this.patternEngine.detectPatterns();
      this.patternEngine.computeKPIs();
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
