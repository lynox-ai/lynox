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
import { embedToBlob } from './embedding.js';
import { EntityResolver, toEntityRecord } from './entity-resolver.js';
import { RetrievalEngine } from './retrieval-engine.js';
import type { RetrievalOptions } from './retrieval-engine.js';
import { extractEntities } from './entity-extractor.js';
import { extractEntitiesV2, shouldExtractV2 } from './entity-extractor-v2.js';
import { fireBeforeRunGate, reportMeteredCost, type HookHost } from './metered-request.js';
import { detectContradictions, hasHeuristicContradiction } from './contradiction-detector.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import { KpiEngine } from './kpi-engine.js';
import type { RunHistory } from './run-history.js';
import type { EngineDb } from './engine-db.js';
import { SubjectStore, entityTypeToSubjectKind, subjectKindToEntityType, ENTITY_MAPPABLE_SUBJECT_KINDS } from './subject-store.js';
import type { SubjectRow } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import type { RelationshipRow } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
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
  /**
   * Foundation Rework v2 (S1b): when `subjectGraphEnabled`, each stored memory's
   * extraction is additively mirrored into the engine.db subject-graph via these
   * stores. Null when no engine.db was provided (older callers / tests). The
   * legacy agent-memory.db writes above stay authoritative regardless.
   */
  private readonly subjectGraphEnabled: boolean;
  private readonly subjectStore: SubjectStore | null;
  private readonly relationshipStore: RelationshipStore | null;
  private readonly memoryGraphStore: MemoryGraphStore | null;
  private readonly engineDb: EngineDb | null;
  /**
   * Managed gate+debit host for the pool-key KG-extraction call. Set by the
   * engine after construction (the engine isn't available at construction time).
   * Null on self-host / tests → extraction runs ungated + undebited, exactly as
   * before. When set on a managed instance, extraction clears the same
   * onBeforeRun credit gate as a chat run (so an exhausted tenant is blocked on
   * every ingest-triggered extraction path) and reports its cost via onAfterRun.
   */
  private meteredHost: HookHost | null = null;

  constructor(
    dbPath: string,
    embeddingProvider: EmbeddingProvider,
    anthropicClient?: Anthropic | undefined,
    runHistory?: RunHistory | undefined,
    engineDb?: EngineDb | undefined,
    subjectGraphEnabled?: boolean | undefined,
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
    this.engineDb = engineDb ?? null;
    this.subjectGraphEnabled = subjectGraphEnabled ?? false;
    if (this.engineDb) {
      this.subjectStore = new SubjectStore(this.engineDb);
      this.relationshipStore = new RelationshipStore(this.engineDb);
      this.memoryGraphStore = new MemoryGraphStore(this.engineDb);
    } else {
      this.subjectStore = null;
      this.relationshipStore = null;
      this.memoryGraphStore = null;
    }
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

  /**
   * Wire the managed gate+debit host so pool-key KG-extraction converges on the
   * same onBeforeRun gate + onAfterRun debit as chat/voice. No-op path when
   * unset (self-host / tests).
   */
  setMeteredHost(host: HookHost | null): void {
    this.meteredHost = host;
    // Also let the retrieval engine debit its own pool-key HyDE call.
    this.retrievalEngine.setMeteredHost(host);
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
      // Scan the whole scope, not just the newest 100 — else an older duplicate
      // past that window is missed and the fact is stored twice.
      exhaustive: true,
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

    // 6. Extract entities and relations (async LLM call — outside transaction).
    // Managed credit lifecycle for the pool-key extraction call: gate BEFORE the
    // spend so an exhausted/stale tenant is blocked (extraction is best-effort
    // enrichment, safely skipped), debit AFTER with the extractor's reported
    // cost. The gate fires only when a host is wired AND a client exists (an LLM
    // call is possible); a null gate (self-host / no client) runs extraction
    // unchanged + never debits.
    let resolvedEntities: EntityRecord[] = [];
    let resolvedRelations: RelationRecord[] = [];
    const extractGate = this.meteredHost && this.anthropicClient
      ? await fireBeforeRunGate(this.meteredHost, 'fast')
      : null;
    if (!extractGate || extractGate.blockedReason === null) {
      const extracted = this.useV2Extractor
        && this.anthropicClient
        && shouldExtractV2(trimmedText, namespace)
        ? await this._extractAndPersistV2(trimmedText, scope, memoryId)
        : await this._extractAndPersistV1(trimmedText, namespace, scope, memoryId);
      resolvedEntities = extracted.resolvedEntities;
      resolvedRelations = extracted.resolvedRelations;
      if (extractGate && this.meteredHost && extracted.costUsd) {
        reportMeteredCost(this.meteredHost, extractGate.runId, extracted.costUsd, 'fast');
      }
    }

    // 9. Foundation Rework v2 (S1b): additively mirror the extraction into the
    // engine.db subject-graph behind the flag. Fully isolated — the legacy writes
    // above are authoritative; a mirror failure is logged and swallowed so the
    // agent's memory/retrieval path is never affected.
    if (this.subjectGraphEnabled && this.subjectStore && this.relationshipStore && this.memoryGraphStore) {
      try {
        this._mirrorToSubjectGraph(
          memoryId, trimmedText, namespace, scope, options,
          resolvedEntities, resolvedRelations, contradictions, embedding,
        );
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] mirror failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

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
  ): Promise<{ resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[]; costUsd?: number | undefined }> {
    const extraction = await extractEntities(trimmedText, namespace, this.anthropicClient);

    const persisted = this.db.transaction(() => {
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
    return { ...persisted, costUsd: extraction.costUsd };
  }

  /** V2 extraction path — Haiku + strict tool-call schema with aliases. */
  private async _extractAndPersistV2(
    trimmedText: string,
    scope: MemoryScopeRef,
    memoryId: string,
  ): Promise<{ resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[]; costUsd?: number | undefined }> {
    const extraction = await extractEntitiesV2(trimmedText, this.anthropicClient!);

    const persisted = this.db.transaction(() => {
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
    return { ...persisted, costUsd: extraction.costUsd };
  }

  /**
   * Foundation Rework v2 (S1b): additively mirror one stored memory's extraction
   * into the engine.db subject-graph. In execution order: a supersession mirror
   * (flips superseded old stubs), then entities → subjects (the converged
   * `findOrCreate` dedup, kind-mapped; concept/location/collection dropped), the
   * memory provenance stub, relations → typed relationships, subject links, and
   * pairwise co-occurrence counts. One engine.db transaction (atomic per memory).
   * Re-resolves from the extraction by name/type — it does NOT reuse the legacy
   * agent-memory.db entity ids (those stay on the legacy graph).
   */
  private _mirrorToSubjectGraph(
    memoryId: string,
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    options: {
      sourceRunId?: string | undefined;
      sourceType?: ProvenanceKind | undefined;
      sourceToolName?: string | undefined;
    } | undefined,
    entities: EntityRecord[],
    relations: RelationRecord[],
    contradictions: ContradictionInfo[],
    embedding: number[],
  ): void {
    const subjects = this.subjectStore!;
    const relationships = this.relationshipStore!;
    const memoryGraph = this.memoryGraphStore!;

    this.engineDb!.getDb().transaction(() => {
      // 1. Supersession mirror FIRST. It only flips OLD memories' stubs and is
      //    independent of whether THIS memory resolves any subjects, so it must
      //    run even when the subject-less branch below skips the graph links —
      //    else a subject-less superseding memory would leave the old stub
      //    is_active=1, diverging from the legacy store. markSuperseded no-ops
      //    when the old memory has no stub; superseded_by is a soft column (no
      //    FK), so it may point at this memory even if it gets no stub of its own.
      for (const c of contradictions) {
        if (c.resolution === 'superseded') memoryGraph.markSuperseded(c.existingMemoryId, memoryId);
      }

      // 2. entities → subjects (kind-mapped; non-subject kinds dropped). Build an
      //    entity-id → subject-id map so relations can re-point onto subjects.
      const entityToSubject = new Map<string, string>();
      const subjectIds: string[] = [];
      let primarySubjectId: string | null = null;
      let primaryIsPersonOrg = false;

      for (const e of entities) {
        const kind = entityTypeToSubjectKind(e.entityType);
        if (!kind) continue;
        const { id: subjectId } = subjects.findOrCreate({ kind, name: e.canonicalName, aliases: e.aliases });
        entityToSubject.set(e.id, subjectId);
        subjectIds.push(subjectId);
        // primary = the first person/organization the memory concerns; else the
        // first resolved subject of any kind. Deterministic (extraction order).
        const isPersonOrg = kind === 'person' || kind === 'organization';
        if (primarySubjectId === null || (isPersonOrg && !primaryIsPersonOrg)) {
          primarySubjectId = subjectId;
          primaryIsPersonOrg = isPersonOrg;
        }
      }

      // 3. memory provenance stub — written UNCONDITIONALLY (S5a mirror-harden).
      //    A subject-less memory (subject_id nullable) is still a real memory that
      //    must land in engine.db so the S5b vector-recall cutover sees it; the old
      //    early-return dropped it, leaving engine.db recall lossy vs. the legacy
      //    store. Carries the embedding so recall has the vector. Must exist before
      //    the relationship / memory_subjects FKs (step 4-6) reference it.
      memoryGraph.upsertStub({
        id: memoryId, text, namespace, scopeType: scope.type, scopeId: scope.id,
        subjectId: primarySubjectId,
        sourceRunId: options?.sourceRunId ?? null,
        sourceType: options?.sourceType,
        sourceToolName: options?.sourceToolName ?? null,
        provider: this.embeddingProvider.name,
        embedding: embedToBlob(embedding),
      });

      // Steps 4-6 are the subject-graph links — meaningful only when the memory
      // resolved at least one subject. A subject-less memory keeps its stub (above)
      // but contributes no edges / junction rows / co-occurrences.
      if (subjectIds.length === 0) return;

      // 4. relations → typed subject↔subject edges. Skip any endpoint that
      //    mapped to no subject (a concept/location), and any self-loop — two
      //    surface forms of one subject (V2-alias dedup) collapse to one node.
      for (const r of relations) {
        const fromSid = entityToSubject.get(r.fromEntityId);
        const toSid = entityToSubject.get(r.toEntityId);
        if (!fromSid || !toSid || fromSid === toSid) continue;
        relationships.createRelationship({
          fromSubjectId: fromSid, toSubjectId: toSid,
          kind: r.relationType, description: r.description,
          sourceMemoryId: memoryId, confidence: r.confidence,
        });
      }

      // 5. mention junction + 6. co-occurrence counts.
      memoryGraph.linkSubjects(memoryId, new Set(subjectIds));
      memoryGraph.bumpCooccurrences(subjectIds);
    })();
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
    if (this.subjectGraphEnabled && this.subjectStore) {
      try { return this._listSubjectEntities(opts); }
      catch (err: unknown) { this._logReadFallback('listEntities', err); }
    }
    return this.db.listEntities(opts).map(toEntityRecord);
  }

  /**
   * Entity browse-search (the `/api/kg/entities?q=` path). When the subject-graph
   * read path is active this is a case-insensitive name/alias substring match over
   * subjects (no semantic search over subjects yet — substring is predictable for a
   * "find by name" browse box); otherwise the legacy semantic `retrieve`. Kept
   * ID-coherent with {@link listEntities}/{@link getEntity} so a searched entity
   * resolves through `/api/kg/entities/:id`.
   */
  async searchEntities(query: string, limit: number): Promise<EntityRecord[]> {
    if (this.subjectGraphEnabled && this.subjectStore) {
      try { return this._listSubjectEntities({ q: query, limit }); }
      catch (err: unknown) { this._logReadFallback('searchEntities', err); }
    }
    const result = await this.retrieve(query, [{ type: 'global', id: 'global' }], { topK: limit });
    return result.entities ?? [];
  }

  async getEntity(id: string): Promise<EntityRecord | null> {
    if (this.subjectGraphEnabled && this.subjectStore) {
      try {
        const row = this.subjectStore.getSubject(id);
        return row ? this._subjectRowToEntityRecord(row) : null;
      } catch (err: unknown) { this._logReadFallback('getEntity', err); }
    }
    const row = this.db.getEntity(id);
    return row ? toEntityRecord(row) : null;
  }

  async resolveEntity(name: string, scopes: MemoryScopeRef[]): Promise<EntityRecord | null> {
    return this.entityResolver.resolve(name, 'concept', scopes, { createIfMissing: false });
  }

  async getEntityRelations(entityId: string, depth?: number | undefined): Promise<RelationRecord[]> {
    // The legacy `depth` arg is really a row LIMIT (db.getEntityRelations(id, limit), newest-first,
    // clamped [1,200]). Mirror the same bound + ORDER on the subject path so a hub entity can't return
    // unbounded edges (the export loops this over 200 entities) and the cap returns the SAME newest-N as legacy.
    const limit = Math.max(1, Math.min(depth === undefined ? 50 : depth * 20, 200));
    if (this.subjectGraphEnabled && this.relationshipStore) {
      try {
        return this.relationshipStore.getRelationshipsForSubject(entityId, limit).map(r => this._relRowToRelationRecord(r));
      } catch (err: unknown) { this._logReadFallback('getEntityRelations', err); }
    }
    const rows = this.db.getEntityRelations(entityId, limit);
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

  // === Subject-graph read mappers (S1d — flag-gated, additive) ===

  /**
   * A subject-graph READ that throws (closed/corrupt engine.db) must never crash the
   * API — it falls back to the legacy store (the read authority through S1) and logs
   * for observability, mirroring the S1b mirror-WRITE isolation. A by-id fallback
   * degrades to "not found" (subject ids don't resolve legacy rows) rather than
   * returning wrong data.
   */
  private _logReadFallback(method: string, err: unknown): void {
    process.stderr.write(
      `[lynox:subject-graph] read ${method} fell back to legacy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  /**
   * The subject-graph read of the entity list: maps Subjects back to the stable
   * `EntityRecord` DTO, dropping kinds with no KG equivalent (service/other).
   * Filter order: kind (`type`) → name/alias substring (`q`) → offset/limit slice.
   * Rows come `updated_at DESC` (via `listSubjects`); the legacy path orders by
   * `mention_count DESC`, but subjects carry no mention count, so browse order +
   * `mentionCount` (0) differ from legacy — tracked with the memory sprint.
   */
  private _listSubjectEntities(
    opts?: { type?: string | undefined; q?: string | undefined; limit?: number | undefined; offset?: number | undefined },
  ): EntityRecord[] {
    const store = this.subjectStore;
    if (!store) return [];
    // A `type` from the legacy KG vocabulary maps to a subject kind; one that maps
    // to nothing (concept/location/collection) yields no rows.
    const kindFilter = opts?.type ? entityTypeToSubjectKind(opts.type) : null;
    if (opts?.type && !kindFilter) return [];
    const rows = store.listSubjects(kindFilter ? { kind: kindFilter } : undefined);
    let mapped = rows
      .map(r => this._subjectRowToEntityRecord(r))
      .filter((e): e is EntityRecord => e !== null);
    const q = opts?.q?.trim().toLowerCase();
    if (q) {
      mapped = mapped.filter(e =>
        e.canonicalName.toLowerCase().includes(q) ||
        e.aliases.some(a => a.toLowerCase().includes(q)),
      );
    }
    const offset = Math.max(opts?.offset ?? 0, 0);
    const limit = opts?.limit ?? mapped.length;
    return mapped.slice(offset, offset + limit);
  }

  /** Map a Subject row to the stable `EntityRecord` DTO, or null when the kind has no KG equivalent. */
  private _subjectRowToEntityRecord(row: SubjectRow): EntityRecord | null {
    const entityType = subjectKindToEntityType(row.kind);
    if (!entityType) return null;
    let aliases: string[];
    try {
      const parsed: unknown = JSON.parse(row.aliases || '[]');
      aliases = Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
    } catch {
      aliases = [];
    }
    return {
      id: row.id,
      canonicalName: row.name,
      entityType,
      aliases,
      description: '',
      scopeType: 'global',
      scopeId: 'global',
      mentionCount: 0,
      firstSeenAt: row.created_at,
      lastSeenAt: row.updated_at,
    };
  }

  /** Map a relationship row to the stable `RelationRecord` DTO. */
  private _relRowToRelationRecord(r: RelationshipRow): RelationRecord {
    return {
      fromEntityId: r.from_subject_id,
      toEntityId: r.to_subject_id,
      relationType: r.kind,
      description: r.description,
      confidence: r.confidence,
      sourceMemoryId: r.source_memory_id ?? '',
      createdAt: r.created_at,
    };
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
    // Re-embed the new text so the persisted vector matches it. Without this the
    // memory keeps embed(oldText) while its text is new, so `findSimilarMemories`
    // scores the changed memory against a stale vector (recall silently wrong).
    const embedding = await this.embeddingProvider.embed(newText);
    const id = this.db.updateMemoryText(oldText, newText, namespace, embedding);
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
    if (this.subjectGraphEnabled && this.subjectStore && this.relationshipStore) {
      try {
        return {
          // Entities + relations are mirrored into the subject-graph (S1b/S1c), so
          // they count from there. MEMORIES are NOT migrated in S1 — the engine.db
          // `memories` table holds only a provenance STUB, and only for memories that
          // resolved a subject (knowledge-layer store(): no subject → no stub). Counting
          // it would undercount + skew the legacy memory-gc consolidation trigger, so
          // memoryCount stays on the legacy authority until the memory sprint.
          memoryCount: this.db.getActiveMemoryCount(),
          entityCount: this.subjectStore.count({ kinds: ENTITY_MAPPABLE_SUBJECT_KINDS }),
          relationCount: this.relationshipStore.count(),
          communityCount: 0,
        };
      } catch (err: unknown) { this._logReadFallback('stats', err); }
    }
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
