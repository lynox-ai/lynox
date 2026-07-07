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
  EntityType,
} from '../types/index.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import type { MemoryRow, ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { embedToBlob } from './embedding.js';
import { EntityResolver, toEntityRecord } from './entity-resolver.js';
import { RetrievalEngine } from './retrieval-engine.js';
import type { RetrievalOptions } from './retrieval-engine.js';
import { extractEntities } from './entity-extractor.js';
import { extractEntitiesV2, shouldExtractV2 } from './entity-extractor-v2.js';
import { fireBeforeRunGate, reportMeteredCost, type HookHost } from './metered-request.js';
import { detectContradictions, hasHeuristicContradiction, subjectsDisagree, properNounTokens, subjectTokensDisagree } from './contradiction-detector.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import { KpiEngine } from './kpi-engine.js';
import type { RunHistory } from './run-history.js';
import type { EngineDb } from './engine-db.js';
import { SubjectStore, entityTypeToSubjectKind, subjectKindToEntityType, ENTITY_MAPPABLE_SUBJECT_KINDS } from './subject-store.js';
import type { SubjectRow } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';
import type { RelationshipRow } from './relationship-store.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { ThreadStore } from './thread-store.js';
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
  /**
   * Foundation Rework v2 (S5b): when `memoryGraphReads` AND `subjectGraphEnabled`,
   * memory RECALL reads (vector + graph-expand via RetrievalEngine, and the no-query
   * `listRecentActive`) re-point onto engine.db `memories`. Co-gated: the store is
   * only populated when the mirror is on + the s5-backfill ran. Dual-write stays
   * legacy through S5b'; a failed engine.db read falls back to legacy per-read.
   */
  private readonly memoryGraphReads: boolean;
  /**
   * The effective read-cutover co-gate (`memoryGraphReads && subjectGraphEnabled`),
   * resolved once. When true the engine.db store is the populated authoritative
   * recall source, so the WRITE-path dedup + contradiction scan (S5b'-a) consults it
   * too — keeping a store()'s confirm-vs-create / supersede decision consistent with
   * what RECALL surfaces. False → both stay on legacy. Also gates `setMemoryGraphReads`.
   */
  private readonly memoryReadsActive: boolean;
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
  /**
   * Foundation Rework v2 — Context-Hierarchy Scoping (Slice B). Lazily-built
   * ThreadStore over the SAME history.db handle `this.runHistory` wraps (where the
   * live `threads.primary_subject_id` anchor lives — engine.db's threads spine is
   * empty pre-S2). Built only on first anchor read (i.e. only under the flag), so a
   * flag-off KnowledgeLayer and mock-runHistory tests never touch `getDb()`.
   * `undefined` = not yet attempted; `null` = unavailable (no runHistory / build failed).
   */
  private _anchorThreadStore: ThreadStore | null | undefined;

  constructor(
    dbPath: string,
    embeddingProvider: EmbeddingProvider,
    anthropicClient?: Anthropic | undefined,
    runHistory?: RunHistory | undefined,
    engineDb?: EngineDb | undefined,
    subjectGraphEnabled?: boolean | undefined,
    memoryGraphReads?: boolean | undefined,
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
    this.kpiEngine = runHistory ? new KpiEngine(runHistory) : null;
    this.useV2Extractor = process.env['LYNOX_KG_EXTRACTOR'] !== 'v1';
    this.engineDb = engineDb ?? null;
    this.subjectGraphEnabled = subjectGraphEnabled ?? false;
    this.memoryGraphReads = memoryGraphReads ?? false;
    // The engine.db store is only populated (dual-write) when the mirror
    // (subject_graph_enabled) is on, so a memory_graph_reads flip without the mirror
    // would recall over an empty store — co-gate on BOTH. Resolved once for both the
    // read cutover (setMemoryGraphReads) and the S5b'-a write-path recall routing.
    this.memoryReadsActive = this.memoryGraphReads && this.subjectGraphEnabled && this.engineDb !== null;
    if (this.engineDb) {
      this.subjectStore = new SubjectStore(this.engineDb);
      this.relationshipStore = new RelationshipStore(this.engineDb);
      this.memoryGraphStore = new MemoryGraphStore(this.engineDb);
      this.retrievalEngine.setMemoryGraphReads(
        this.memoryGraphStore, this.subjectStore, this.memoryReadsActive,
      );
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

  /**
   * Write-path memory recall (S5b'-a) — routes the store()-time dedup + contradiction
   * candidate scan to the SAME store the read cutover reads from. When
   * {@link memoryReadsActive}, engine.db `MemoryGraphStore.findSimilarRecall` (which
   * S5b re-pointed RECALL onto); else legacy `AgentMemoryDb.findSimilarMemories`.
   * Both return `ScoredMemoryRow` (decrypted text, `_similarity`) so the dedup /
   * contradiction logic is store-agnostic. The memory ROW itself stays dual-written
   * through S5b'-a (the legacy row anchors the still-legacy entity/mention FK); the
   * dual-write end + entity cutover is the FK-coupled S5b'-b bundle. Ids are parity
   * across the stores (the mirror shares the legacy id), so a candidate found on
   * engine.db is confirm/supersede-addressable on legacy unchanged.
   */
  private _dedupRecall(
    embedding: number[],
    topK: number,
    threshold: number,
    filters: {
      namespace?: string | undefined;
      scopeTypes?: string[] | undefined;
      scopeIds?: string[] | undefined;
      activeOnly?: boolean | undefined;
      exhaustive?: boolean | undefined;
    },
  ): ScoredMemoryRow[] {
    if (this.memoryReadsActive && this.memoryGraphStore) {
      return this.memoryGraphStore.findSimilarRecall(
        embedding, this.embeddingProvider.dimensions, topK, threshold, filters,
      );
    }
    return this.db.findSimilarMemories(embedding, topK, threshold, filters);
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
    // Routed through _dedupRecall (S5b'-a): consults engine.db when the read cutover
    // is active, so the dedup decision matches what recall surfaces.
    const similar = this._dedupRecall(embedding, 1, DEDUP_THRESHOLD, {
      namespace, scopeTypes: [scope.type], scopeIds: [scope.id], activeOnly: true,
      // Scan the whole scope, not just the newest 100 — else an older duplicate
      // past that window is missed and the fact is stored twice.
      exhaustive: true,
    });

    if (similar.length > 0) {
      const candidate = similar[0]!;
      // If the texts contain contradictory signals (different numbers, negation,
      // state change), this is an update — not a duplicate. Skip dedup and let
      // the contradiction detector handle it. Also skip when the two texts name
      // DIFFERENT subjects (`subjectsDisagree`): at 0.95 similarity a cross-project
      // near-twin ("Orion budget 30000" vs "Vega budget 30000") would otherwise be
      // silently absorbed as a confirmation of the wrong project's fact — the same
      // subject-blind data-loss class the supersede veto guards, at the dedup gate.
      if (!hasHeuristicContradiction(trimmedText, candidate.text) && !subjectsDisagree(trimmedText, candidate.text)) {
        this.db.confirmMemory(candidate.id);
        // S5b recall parity: mirror the confirmation onto the engine.db stub so its
        // confirmation_count/confidence don't go stale under the read cutover. Dual-
        // write gate (subject_graph_enabled), isolated — a mirror failure never
        // affects the authoritative legacy confirm above.
        this._mirrorConfidence(candidate.id, 'confirm');
        return { memoryId: candidate.id, entities: [], relations: [], contradictions: [], stored: false, deduplicated: true };
      }
      // Fall through to contradiction detection
    }

    // 3. Contradiction detection
    let contradictions: ContradictionInfo[] = [];
    if (!options?.skipContradictionCheck) {
      contradictions = await detectContradictions(
        trimmedText, namespace, scope,
        (emb, topK, thr, f) => this._dedupRecall(emb, topK, thr, f),
        this.embeddingProvider, embedding,
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
    //
    // The extraction SPEND is what the gate blocks — NOT the engine.db memory STUB.
    // The stub (subject-graph mirror / authoritative write) must land on every stored
    // memory so recall (which reads engine.db under the cutover) never loses it, even
    // for a blocked/exhausted tenant. So `extractionAllowed` gates only the extractor
    // call; the stub/subject persistence always runs.
    let resolvedEntities: EntityRecord[] = [];
    let resolvedRelations: RelationRecord[] = [];
    const extractGate = this.meteredHost && this.anthropicClient
      ? await fireBeforeRunGate(this.meteredHost, 'fast')
      : null;
    const extractionAllowed = !extractGate || extractGate.blockedReason === null;

    // Slice B (Context-Hierarchy Scoping): if this memory's source thread is anchored
    // to a subject (project/client via set_thread_context), that anchor becomes the
    // memory's PRIMARY subject, overriding the person/org extraction heuristic below.
    // Resolved ONCE here and only under the flag (both subject-write branches are
    // flag-gated) — a flag-off tenant never reads the thread; unanchored → null → heuristic.
    const threadAnchorSubjectId = this.subjectGraphEnabled
      ? this._readThreadAnchor(options?.sourceThreadId)
      : null;

    let extracted: { resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[]; costUsd?: number | undefined };
    if (this.memoryReadsActive && this.subjectStore && this.relationshipStore && this.memoryGraphStore) {
      // S5b'-b entity write-cutover: the extraction persists to the subject graph as the
      // AUTHORITATIVE entity store — the legacy entities/mentions/relations writes are
      // dropped (their only readers — graph-expand recall, listEntities — already read
      // engine.db under the flag). The legacy MEMORY row stays dual-written (created
      // above) as the rollback anchor for vector recall; it ends at the S5b'-d legacy
      // DROP. The stub always lands (even when the extractor is gated); createdAt carries
      // the legacy row's creation time so the stub time-decays correctly.
      const createdAt = this.db.getMemoryCreatedAt(memoryId);
      extracted = await this._extractAndPersistToSubjects(
        trimmedText, namespace, scope, memoryId, embedding, options, contradictions, createdAt, extractionAllowed,
        threadAnchorSubjectId,
      );
    } else {
      // Pre-cutover (every current tenant): legacy persist is authoritative (gated), and
      // the engine.db mirror below is an additive dual-write that runs REGARDLESS of the
      // gate so a blocked store still lands its (subject-less) stub.
      resolvedEntities = [];
      resolvedRelations = [];
      let costUsd: number | undefined;
      if (extractionAllowed) {
        const legacy = this.useV2Extractor
          && this.anthropicClient
          && shouldExtractV2(trimmedText, namespace)
          ? await this._extractAndPersistV2(trimmedText, scope, memoryId)
          : await this._extractAndPersistV1(trimmedText, namespace, scope, memoryId);
        resolvedEntities = legacy.resolvedEntities;
        resolvedRelations = legacy.resolvedRelations;
        costUsd = legacy.costUsd;
      }

      // 9. Foundation Rework v2 (S1b): additively mirror the extraction into the
      // engine.db subject-graph behind the flag. Fully isolated — the legacy writes
      // above are authoritative; a mirror failure is logged and swallowed so the
      // agent's memory/retrieval path is never affected.
      if (this.subjectGraphEnabled && this.subjectStore && this.relationshipStore && this.memoryGraphStore) {
        try {
          const createdAt = this.db.getMemoryCreatedAt(memoryId);
          this._mirrorToSubjectGraph(
            memoryId, trimmedText, namespace, scope, options,
            resolvedEntities, resolvedRelations, contradictions, embedding, createdAt,
            threadAnchorSubjectId,
          );
        } catch (err: unknown) {
          process.stderr.write(
            `[lynox:subject-graph] mirror failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      extracted = { resolvedEntities, resolvedRelations, ...(costUsd === undefined ? {} : { costUsd }) };
    }
    resolvedEntities = extracted.resolvedEntities;
    resolvedRelations = extracted.resolvedRelations;
    if (extractGate && this.meteredHost && extracted.costUsd) {
      reportMeteredCost(this.meteredHost, extractGate.runId, extracted.costUsd, 'fast');
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
   * Slice B — resolve the current thread's anchor subject (the project/client the
   * thread is scoped to via `set_thread_context`). Returns the thread's
   * `primary_subject_id`, or null when the thread is unanchored / unknown / the
   * store is unavailable. Reads history.db (where live threads live); memoized.
   * Only ever called under `subjectGraphEnabled`, so a flag-off layer never builds
   * a ThreadStore. Never throws — a read failure degrades to the heuristic.
   */
  private _readThreadAnchor(threadId: string | undefined): string | null {
    if (!threadId || !this.runHistory) return null;
    if (this._anchorThreadStore === undefined) {
      try {
        this._anchorThreadStore = new ThreadStore(this.runHistory.getDb());
      } catch {
        this._anchorThreadStore = null;
      }
    }
    if (!this._anchorThreadStore) return null;
    try {
      const rawAnchorId = this._anchorThreadStore.getThread(threadId)?.primary_subject_id ?? null;
      if (!rawAnchorId) return null;
      // Resolve the v7 merge redirect FORWARD: if the anchor's subject was folded into a
      // canonical (merged_into), use the canonical — so a thread anchored to a since-merged
      // dup keeps attaching memories to the LIVE subject, not the archived stub. This is the
      // read-side of the three-store merge repoint (the write side repoints the history.db
      // anchor directly; this also masks any stale id a pre-fix ledger never repointed).
      const anchorId = this.subjectStore?.resolveActiveSubject(rawAnchorId) ?? rawAnchorId;
      // Validate the cross-DB soft ref (no enforceable FK): the resolved subject must still
      // exist AND be active — a hard-deleted or archived anchor falls back to the heuristic
      // (null) rather than writing a dangling/archived memories.subject_id, which WOULD
      // FK-throw (or mis-attribute) on the authoritative cutover write.
      const subject = this.subjectStore?.getSubject(anchorId);
      if (subject && !subject.archived_at) return anchorId;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The organization to file an extracted engagement (project) under, derived from
   * the thread's anchor: an org anchor IS the parent; an engagement anchor lends its
   * OWN parent (a sibling project of the same client); anything else → unparented.
   * Passed to `findOrCreateEngagement` so extraction converges on the same
   * `(name, parent)` row `set_thread_context` would resolve.
   */
  private _engagementParent(subjects: SubjectStore, anchorId: string | null): string | null {
    if (!anchorId) return null;
    const anchor = subjects.getSubject(anchorId);
    if (!anchor) return null;
    if (anchor.kind === 'organization') return anchor.id;
    if (anchor.kind === 'engagement') return anchor.parent_id;
    return null;
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
    createdAt: string | undefined,
    threadAnchorSubjectId: string | null,
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
        // Engagements route through the single (name, parent) resolver — filed under
        // the thread's client anchor — so extraction converges with set_thread_context
        // instead of minting a duplicate project row on every store.
        // Persons route through the subset resolver: a new surface form that is an
        // unambiguous token-subset of exactly one existing person folds in as an alias
        // ("Ada" → the existing "Dr. Ada Lovelace") instead of minting a duplicate.
        const { id: subjectId } = kind === 'engagement'
          ? subjects.findOrCreateEngagement(e.canonicalName, this._engagementParent(subjects, threadAnchorSubjectId), { aliases: e.aliases })
          : kind === 'person'
            ? subjects.resolvePersonSubject(e.canonicalName, { aliases: e.aliases })
            : subjects.findOrCreate({ kind, name: e.canonicalName, aliases: e.aliases });
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
      // Slice B: an anchored thread's memories take the thread's project/client as
      // their PRIMARY subject (anchor > the person/org heuristic). The anchor is
      // deliberately the primary CONTEXT only — it is NOT linked into memory_subjects
      // (which stays the set of textually-MENTIONED subjects), so memoriesMentioningSubject
      // keeps mention-true semantics; the project-scoped recall (Slice C) reads
      // memories.subject_id, not the junction. NULL anchor → the heuristic pick stands.
      memoryGraph.upsertStub({
        id: memoryId, text, namespace, scopeType: scope.type, scopeId: scope.id,
        subjectId: threadAnchorSubjectId ?? primarySubjectId,
        sourceRunId: options?.sourceRunId ?? null,
        sourceType: options?.sourceType,
        sourceToolName: options?.sourceToolName ?? null,
        provider: this.embeddingProvider.name,
        embedding: embedToBlob(embedding),
        createdAt,
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
   * S5b'-b entity write-cutover: the AUTHORITATIVE subject-graph persistence. Runs the
   * SAME extractor dispatch as the legacy path (only the persistence target differs),
   * then writes the extraction straight onto engine.db subjects — no legacy
   * entities/mentions/relations. Returns subject-sourced records for the `store()`
   * result (nothing consumes the ids; both callers discard the result). Used when
   * {@link memoryReadsActive}; the legacy `_extractAndPersistV1/V2` + `_mirrorToSubjectGraph`
   * pair stays for the pre-cutover path and is deleted at the S5b'-d legacy DROP.
   */
  private async _extractAndPersistToSubjects(
    trimmedText: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    memoryId: string,
    embedding: number[],
    options: {
      sourceRunId?: string | undefined;
      sourceType?: ProvenanceKind | undefined;
      sourceToolName?: string | undefined;
    } | undefined,
    contradictions: ContradictionInfo[],
    createdAt: string | undefined,
    extractionAllowed: boolean,
    threadAnchorSubjectId: string | null,
  ): Promise<{ resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[]; costUsd?: number | undefined }> {
    // Normalize both extractor shapes to one name-keyed form. The aliases carried
    // MATCH what the mirror passed to findOrCreate — V1: [name]; V2: [canonical, ...aliases].
    // When the extractor is gated off (exhausted tenant) we skip it entirely and still
    // write the (subject-less) stub below, so recall never loses the memory.
    let entities: Array<{ name: string; type: EntityType; aliases: string[] }> = [];
    let relations: Array<{ from: string; to: string; kind: string; description: string; confidence: number }> = [];
    let costUsd: number | undefined;
    if (extractionAllowed) {
      if (this.useV2Extractor && this.anthropicClient && shouldExtractV2(trimmedText, namespace)) {
        const ex = await extractEntitiesV2(trimmedText, this.anthropicClient);
        entities = ex.entities.map(e => ({ name: e.canonicalName, type: e.type, aliases: [e.canonicalName, ...e.aliases] }));
        relations = ex.relations.map(r => ({ from: r.subject, to: r.object, kind: r.predicate, description: '', confidence: r.confidence }));
        costUsd = ex.costUsd;
      } else {
        const ex = await extractEntities(trimmedText, namespace, this.anthropicClient);
        entities = ex.entities.map(e => ({ name: e.name, type: e.type, aliases: [e.name] }));
        relations = ex.relations.map(r => ({ from: r.from, to: r.to, kind: r.relationType, description: r.description, confidence: 1.0 }));
        costUsd = ex.costUsd;
      }
    }

    const { resolvedEntities, resolvedRelations } = this._writeSubjectsFromExtraction(
      memoryId, trimmedText, namespace, scope, options, entities, relations, contradictions, embedding, createdAt,
      threadAnchorSubjectId,
    );
    return { resolvedEntities, resolvedRelations, ...(costUsd === undefined ? {} : { costUsd }) };
  }

  /**
   * Write a normalized extraction directly onto the engine.db subject graph (one
   * atomic transaction) and return subject-sourced `EntityRecord`/`RelationRecord`s.
   * The name-keyed twin of {@link _mirrorToSubjectGraph}: identical steps
   * (supersession → subjects via findOrCreate → provenance stub → relationship edges →
   * mention junction → co-occurrences) but resolving relations by extraction NAME
   * (the authoritative path has no legacy entity ids). The two consolidate into one
   * when the legacy/mirror branch is removed at S5b'-d.
   *
   * Equivalence to the mirror is exact for a FRESH mention. On a RE-mention whose legacy
   * entity type had drifted, the mirror mapped the subject kind from the legacy STORED
   * type (via `toEntityRecord`) while this path uses the FRESH extraction type — a
   * deliberate, more-correct divergence (the latest extraction wins), not a regression.
   */
  private _writeSubjectsFromExtraction(
    memoryId: string,
    text: string,
    namespace: MemoryNamespace,
    scope: MemoryScopeRef,
    options: {
      sourceRunId?: string | undefined;
      sourceType?: ProvenanceKind | undefined;
      sourceToolName?: string | undefined;
    } | undefined,
    entities: Array<{ name: string; type: EntityType; aliases: string[] }>,
    relations: Array<{ from: string; to: string; kind: string; description: string; confidence: number }>,
    contradictions: ContradictionInfo[],
    embedding: number[],
    createdAt: string | undefined,
    threadAnchorSubjectId: string | null,
  ): { resolvedEntities: EntityRecord[]; resolvedRelations: RelationRecord[] } {
    const subjects = this.subjectStore!;
    const relationships = this.relationshipStore!;
    const memoryGraph = this.memoryGraphStore!;
    const resolvedEntities: EntityRecord[] = [];
    const resolvedRelations: RelationRecord[] = [];
    const stamp = createdAt ?? new Date().toISOString();

    this.engineDb!.getDb().transaction(() => {
      // 1. Supersession mirror FIRST (flips OLD stubs; independent of this memory's subjects).
      for (const c of contradictions) {
        if (c.resolution === 'superseded') memoryGraph.markSuperseded(c.existingMemoryId, memoryId);
      }

      // 2. entities → subjects (kind-mapped; non-subject kinds dropped). Name-keyed so
      //    relations re-point without a legacy id hop.
      const nameToSubject = new Map<string, string>();
      const subjectIds: string[] = [];
      let primarySubjectId: string | null = null;
      let primaryIsPersonOrg = false;

      for (const e of entities) {
        const kind = entityTypeToSubjectKind(e.type);
        if (!kind) continue;
        // Engagements route through the single (name, parent) resolver (see the twin
        // above) so extraction converges with set_thread_context, not a fresh row.
        // Person subset-resolver (see the twin above) so "Ada" folds into an existing
        // "Dr. Ada Lovelace" as an alias rather than a duplicate person row.
        const { id: subjectId } = kind === 'engagement'
          ? subjects.findOrCreateEngagement(e.name, this._engagementParent(subjects, threadAnchorSubjectId), { aliases: e.aliases })
          : kind === 'person'
            ? subjects.resolvePersonSubject(e.name, { aliases: e.aliases })
            : subjects.findOrCreate({ kind, name: e.name, aliases: e.aliases });
        nameToSubject.set(e.name.toLowerCase(), subjectId);
        subjectIds.push(subjectId);
        resolvedEntities.push({
          id: subjectId, canonicalName: e.name, entityType: e.type, aliases: e.aliases,
          description: '', scopeType: scope.type, scopeId: scope.id,
          mentionCount: 1, firstSeenAt: stamp, lastSeenAt: stamp,
        });
        const isPersonOrg = kind === 'person' || kind === 'organization';
        if (primarySubjectId === null || (isPersonOrg && !primaryIsPersonOrg)) {
          primarySubjectId = subjectId;
          primaryIsPersonOrg = isPersonOrg;
        }
      }

      // 3. memory provenance stub — written UNCONDITIONALLY (subject-less memories still
      //    land so vector recall sees them). Refreshes text/embedding on a re-store.
      //    Slice B: the thread anchor (project/client) wins over the person/org heuristic
      //    for the PRIMARY subject; NULL anchor → the heuristic pick stands.
      memoryGraph.upsertStub({
        id: memoryId, text, namespace, scopeType: scope.type, scopeId: scope.id,
        subjectId: threadAnchorSubjectId ?? primarySubjectId,
        sourceRunId: options?.sourceRunId ?? null,
        sourceType: options?.sourceType,
        sourceToolName: options?.sourceToolName ?? null,
        provider: this.embeddingProvider.name,
        embedding: embedToBlob(embedding),
        createdAt,
      });

      if (subjectIds.length === 0) return;

      // 4. relations → typed subject↔subject edges (skip unmapped endpoints + self-loops).
      for (const r of relations) {
        const fromSid = nameToSubject.get(r.from.toLowerCase());
        const toSid = nameToSubject.get(r.to.toLowerCase());
        if (!fromSid || !toSid || fromSid === toSid) continue;
        relationships.createRelationship({
          fromSubjectId: fromSid, toSubjectId: toSid,
          kind: r.kind, description: r.description,
          sourceMemoryId: memoryId, confidence: r.confidence,
        });
        resolvedRelations.push({
          fromEntityId: fromSid, toEntityId: toSid, relationType: r.kind,
          description: r.description, confidence: r.confidence,
          sourceMemoryId: memoryId, createdAt: stamp,
        });
      }

      // 5. mention junction + 6. co-occurrence counts.
      memoryGraph.linkSubjects(memoryId, new Set(subjectIds));
      memoryGraph.bumpCooccurrences(subjectIds);
    })();

    return { resolvedEntities, resolvedRelations };
  }

  /**
   * Purge all knowledge extracted from a specific thread.
   * Deletes memories and orphaned entities (reference-counted).
   */
  purgeThread(threadId: string): number {
    // S5b'-c: under the MIRROR flag, ALSO reap the thread's engine.db stubs — the
    // authoritative recall store — else the purged (privacy) statement text lingers
    // there. id-parity bridge: read the thread's ids from legacy (which owns
    // source_thread_id) BEFORE the legacy purge deletes them, then delete the same
    // stub ids from engine.db (cascades reap the junction; durable subjects survive).
    // Gated on `subjectGraphEnabled`, NOT reads — the mirror WRITES stubs whenever it's
    // on, so a purge must reap them whenever it's on (matching _mirrorConfidence).
    // Isolated: an engine.db failure is logged + swallowed so the legacy purge below
    // still runs. Residual gap (tracked for the reads-flip reconcile, NOT this slice):
    // once `memoryGraphReads` is on, a swallowed reap leaves the stub recallable AND
    // unrecoverable (the legacy ids vanish once the legacy purge runs). Surfacing that
    // end-to-end is a route change — the caller (http-api private-mode purge) already
    // treats purge as best-effort-logged — so hardening it here alone wouldn't reach
    // the user. No live tenant has reads on yet.
    if (this.subjectGraphEnabled && this.memoryGraphStore) {
      try {
        const ids = this.db.getMemoryIdsByThread(threadId);
        this.memoryGraphStore.purgeMemories(ids);
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] purge mirror failed for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
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
    // S5b: the no-query recency path re-points onto engine.db when both flags are
    // on; a read throw falls back to legacy (the write authority through S5b').
    let rows: MemoryRow[];
    if (this.memoryGraphReads && this.subjectGraphEnabled && this.memoryGraphStore) {
      try {
        rows = this.memoryGraphStore.listRecentActiveRecall(namespace, scopeFilters, limit);
      } catch (err: unknown) {
        this._logReadFallback('listRecentActive', err);
        rows = this.db.listActiveMemories(namespace, scopeFilters, limit);
      }
    } else {
      rows = this.db.listActiveMemories(namespace, scopeFilters, limit);
    }
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
    return detectContradictions(
      text, namespace, scope,
      (emb, topK, thr, f) => this._dedupRecall(emb, topK, thr, f),
      this.embeddingProvider,
    );
  }

  async deactivateByPattern(pattern: string, namespace?: MemoryNamespace | undefined): Promise<number> {
    const ids = this.db.deactivateMemoriesByPattern(pattern, namespace);
    // S5b'-c: mirror the deactivation onto the engine.db stubs (the authoritative
    // recall store under the read cutover) so the deleted content stops surfacing
    // there too — else `memory_delete` leaves the statement recallable via
    // engine.db, breaking the "deleted means gone" privacy promise. id-parity
    // bridge: the pattern is matched on legacy (plaintext), then the SAME ids are
    // reaped in engine.db (encrypted text can't be LIKE-matched). Gated on
    // subjectGraphEnabled (NOT reads) — the mirror WRITES stubs whenever it's on,
    // so a delete must reap them whenever it's on (matching purgeThread /
    // _mirrorConfidence). Isolated: an engine.db failure is logged + swallowed so
    // the legacy deactivation above still stands. Residual (tracked for the
    // reads-flip reconcile, like purgeThread): once memoryGraphReads is on, a
    // swallowed reap leaves the deleted content recallable in engine.db — and a
    // re-run finds ids=[] (the legacy rows are already inactive), so it is not
    // self-healing. No live tenant has reads on yet.
    if (this.subjectGraphEnabled && this.memoryGraphStore) {
      try {
        this.memoryGraphStore.deactivateByIds(ids);
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] deactivate mirror failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return ids.length;
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

    // Privacy/recall parity: refresh the engine.db stub's text + embedding under the
    // WRITE flag (subject_graph_enabled) — NOT the read flag — so a correction/redaction
    // made during the dual-write window (write-on, read-off, e.g. cat's soak) is present
    // in engine.db when reads flip on, instead of recall serving the stale pre-edit text
    // (the same divergence the deactivate/consolidate mirrors close). No-op when the memory
    // has no stub; isolated so a mirror failure never fails the legacy edit.
    if (this.subjectGraphEnabled && this.memoryGraphStore) {
      try {
        this.memoryGraphStore.updateStubText(id, newText, embedToBlob(embedding));
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] text-edit mirror failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Re-extract for the corrected text. Under the read cutover (S5b'-b) the re-extraction
    // re-resolves the subject linkage and re-upserts the stub; pre-cutover: the legacy
    // mention path, unchanged. The stub's TEXT is already refreshed above under the write
    // flag, independent of this read-gated (cost-bearing) re-extraction.
    if (this.memoryReadsActive && this.subjectStore && this.relationshipStore && this.memoryGraphStore) {
      // A text correction is not credit-gated (the legacy path re-extracts unconditionally).
      const createdAt = this.db.getMemoryCreatedAt(id);
      // Slice B: keep the memory's project/client anchor across a text edit — resolve
      // its SOURCE thread's anchor (not the current thread; this is an edit, not a new
      // write) so re-extraction doesn't silently revert the primary subject to the heuristic.
      const threadAnchorSubjectId = this._readThreadAnchor(this.db.getMemorySourceThread(id));
      await this._extractAndPersistToSubjects(newText, namespace, scope, id, embedding, undefined, [], createdAt, true, threadAnchorSubjectId);
    } else {
      const extraction = await extractEntities(newText, namespace, this.anthropicClient);
      for (const ext of extraction.entities) {
        const entity = await this.entityResolver.resolve(ext.name, ext.type, [scope], { createIfMissing: true });
        if (entity) this.db.createMention(id, entity.id);
      }
    }

    return true;
  }

  // === Maintenance ===

  async gc(options?: { dryRun?: boolean | undefined }): Promise<KnowledgeGcResult> {
    const result = this.db.gc(options?.dryRun ?? false);
    // S5b'-c: under the MIRROR flag, also GC the engine.db stub store (the recall
    // authority) so superseded/dead stubs don't linger in recall. Real GC only
    // (dry-run touches nothing). Isolated — a mirror failure never fails legacy GC.
    if (!options?.dryRun && this.subjectGraphEnabled && this.memoryGraphStore) {
      try {
        this.memoryGraphStore.gcInactiveStubs();
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] gc mirror failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return result;
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
    // S5b'-c: KPI metrics now live on history.db (RunHistory), moved off the legacy
    // agent-memory.db. A null runHistory (no-history KnowledgeLayer / older tests)
    // means no KPI engine ran, so there are no metrics to read.
    if (!this.runHistory) return [];
    return this.runHistory.getMetrics(metricName, window).map(r => ({
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
      // S5b recall parity: mirror the confidence delta onto the engine.db stub.
      this._mirrorConfidence(id, signal === 'useful' ? 'confirm' : 'penalize');
    }
  }

  /**
   * Mirror a confidence-affecting mutation (dedup confirm / retrieval feedback) onto
   * the engine.db memory stub so recall (S5b) scores the SAME confirmation_count /
   * confidence as legacy. Gated on the dual-write mirror flag (subject_graph_enabled)
   * — NOT the read flag — so the history is present when reads flip on. Fully
   * isolated: a mirror failure is swallowed (legacy stays authoritative). Heavy
   * dedup/consolidation/gc write-porting stays legacy through S5b'.
   */
  private _mirrorConfidence(memoryId: string, kind: 'confirm' | 'penalize'): void {
    if (!this.subjectGraphEnabled || !this.memoryGraphStore) return;
    try {
      if (kind === 'confirm') this.memoryGraphStore.bumpConfirmation(memoryId);
      else this.memoryGraphStore.penalizeConfidence(memoryId);
    } catch (err: unknown) {
      process.stderr.write(
        `[lynox:subject-graph] confidence mirror (${kind}) failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** Consolidate similar memories within a scope. Returns count merged. */
  consolidateMemories(namespace: MemoryNamespace, scopeType: string, scopeId: string): number {
    // Inject the subject-agreement veto so the clusterer never merges two projects'
    // facts (cross-subject data loss — the same guard M1 added to supersede/dedup).
    // Pass the set-level primitives so each row is tokenized once, not per pair;
    // `undefined` keeps the DB method's default threshold.
    const pairs = this.db.consolidateMemories(
      namespace, scopeType, scopeId, undefined,
      { tokenize: properNounTokens, disagree: subjectTokensDisagree },
    );
    // S5b'-c: mirror every consolidation supersede + confirmation transfer onto the
    // engine.db stubs (the authoritative recall store under the cutover), else the
    // two stores diverge on the first GC — a consolidated-away duplicate stays
    // recallable from engine.db, and the keeper's confidence lags. Gated on
    // subjectGraphEnabled (the mirror writes stubs whenever it's on); one engine.db
    // transaction for atomicity; isolated so a mirror failure leaves the legacy
    // consolidation (already committed) standing. (Reads-flip reconcile residual as
    // in deactivateByPattern/purgeThread.)
    if (this.subjectGraphEnabled && this.memoryGraphStore && pairs.length > 0) {
      const memoryGraph = this.memoryGraphStore;
      try {
        this.engineDb!.getDb().transaction(() => {
          for (const p of pairs) {
            memoryGraph.markSuperseded(p.victimId, p.keeperId);
            memoryGraph.addConfirmations(p.keeperId, p.victimConfirmations);
          }
        })();
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] consolidation mirror failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return pairs.length;
  }
}
