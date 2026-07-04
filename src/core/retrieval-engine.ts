import type Anthropic from '@anthropic-ai/sdk';
import type {
  MemoryNamespace,
  MemoryScopeRef,
  MemoryScopeType,
  EntityRecord,
  KnowledgeRetrievalResult,
  ProvenanceKind,
} from '../types/index.js';
import { NAMESPACE_HALF_LIFE } from '../types/index.js';
import { getActiveProvider, clientForTierSnapshot } from './llm-client.js';
import { calculateCost } from './pricing.js';
import { reportMeteredCost, type HookHost } from './metered-request.js';
import { randomUUID } from 'node:crypto';
import { resolveTierModel } from './tier-resolver.js';
import { scopeWeight } from './scope-resolver.js';
import type { AgentMemoryDb, MemoryRow, ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineSimilarity, blobToEmbed } from './embedding.js';
import { extractEntitiesRegex } from './entity-extractor.js';
import type { ExtractedEntity } from './entity-extractor.js';
import type { EntityResolver } from './entity-resolver.js';
import type { MemoryGraphStore } from './memory-graph-store.js';
import { entityTypeToSubjectKind } from './subject-store.js';
import type { SubjectStore, SubjectRow } from './subject-store.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import type { RunHistory } from './run-history.js';
import { escapeXml, renderProvenanceFact, detectInjectionAttempt } from './data-boundary.js';
import { channels } from './observability.js';

/** Default retrieval options. */
const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.55;
const MMR_LAMBDA = 0.7;

/** Max chars for formatted knowledge context (~3K tokens). */
const DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS = 12_000;

/** Weight allocation for multi-signal scoring. */
const VECTOR_WEIGHT = 0.55;
const GRAPH_BOOST = 0.15;
const THREAD_BOOST = 0.10;

/**
 * Context-Hierarchy Scoping (Slice C) — the SOFT walk-up weights that replace the
 * flat `scopeWeight(scope_type)` when the active thread is anchored to a subject.
 * A memory is weighted by how its PRIMARY subject relates to the anchor's hierarchy:
 * in-context (the anchor itself) strongest, each step UP the Projekt→Kunde→… chain
 * weaker, a sibling/cousin (shares an ancestor, off-chain) weakest, and an unrelated
 * subject a visible floor. NONE is hidden — this is a soft re-rank, not a filter, so
 * a strongly-matching cross-project memory still surfaces (Fable CORR-2: no security
 * boundary here, only relevance ordering). Kept within the existing `scopeWeight`
 * range [0.3, 1.0] so the downstream scoring dynamics (decay/MMR/caps) are unchanged.
 */
const ANCHOR_WEIGHT = 1.0;
const ANCESTOR_PARENT_WEIGHT = 0.7;
const ANCESTOR_STEP = 0.15;
const ANCESTOR_FLOOR = 0.4;
const SIBLING_WEIGHT = 0.35;
const UNRELATED_WEIGHT = 0.3;

/** Weight for an ancestor `depth` steps above the anchor (depth 1 = parent). */
function ancestorWeight(depth: number): number {
  return Math.max(ANCESTOR_FLOOR, ANCESTOR_PARENT_WEIGHT - ANCESTOR_STEP * (depth - 1));
}

/**
 * The active thread's context hierarchy, resolved ONCE per retrieve() from the
 * thread anchor. `chainWeights` maps the anchor + each ancestor id to its walk-up
 * weight; `ancestorSet` is the same id set (for off-chain sibling detection); the
 * `siblingCache` memoises the per-candidate-subject ancestor walk within one retrieve.
 */
interface AnchorContext {
  chainWeights: Map<string, number>;
  ancestorSet: Set<string>;
  siblingCache: Map<string, boolean>;
}

export interface RetrievalOptions {
  topK?: number | undefined;
  threshold?: number | undefined;
  useHyDE?: boolean | undefined;
  useGraphExpansion?: boolean | undefined;
  namespace?: MemoryNamespace | undefined;
  /**
   * Context-Hierarchy Scoping (Slice C): the active thread's anchor subject
   * (`threads.primary_subject_id`). When set AND the engine.db subject store is
   * wired, Step-6 scoring weights each candidate by its subject's position in this
   * anchor's hierarchy (see {@link AnchorContext}). Null/absent, or a stale anchor,
   * or a candidate with no subject → the flat `scopeWeight(scope_type)` (back-compat).
   */
  threadAnchorSubjectId?: string | null | undefined;
}

interface ScoredCandidate {
  id: string;
  text: string;
  namespace: string;
  scopeType: string;
  scopeId: string;
  /** The memory's primary subject (engine.db recall path); null on the legacy path. */
  subjectId: string | null;
  createdAt: string;
  embedding: number[];
  confidence: number;
  confirmationCount: number;
  sourceRunId: string | null;
  sourceType: ProvenanceKind;
  sourceToolName: string | null;
  vectorScore: number;
  ftsScore: number;
  graphBoost: number;
  runBoost: number;
  finalScore: number;
  source: 'vector' | 'graph' | 'fts';
}

/** Simple LRU cache with max size. */
class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly maxSize: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      // Delete oldest entry
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
  }
}

/**
 * Graph-augmented retrieval engine.
 *
 * Pipeline: HyDE -> Vector Search -> Graph Expansion -> Merge -> Score -> MMR -> Format
 */
export class RetrievalEngine {
  private dataStoreBridge: DataStoreBridge | null = null;
  private meteredHost: HookHost | null = null;
  private readonly _embeddingCache = new LruCache<number[]>(64);
  private readonly _hydeCache = new LruCache<string>(32);
  /**
   * S5b memory read-cutover: the engine.db recall store + subject resolver, wired
   * by KnowledgeLayer.setMemoryGraphReads. `memoryGraphReads` is the co-gated flag
   * (memory_graph_reads AND subject_graph_enabled AND a store present). When on,
   * `retrieve` reads memories from engine.db; a per-read throw falls back to legacy.
   * The query-ENTITY resolution for the display graph stays legacy either way.
   */
  private memoryRecall: MemoryGraphStore | null = null;
  private subjectStore: SubjectStore | null = null;
  private memoryGraphReads = false;

  constructor(
    private readonly db: AgentMemoryDb,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly entityResolver: EntityResolver,
    private anthropicClient?: Anthropic | undefined,
    private readonly runHistory?: RunHistory | undefined,
  ) {}

  setDataStoreBridge(bridge: DataStoreBridge): void {
    this.dataStoreBridge = bridge;
  }

  /** Propagate provider switch from KnowledgeLayer.setAnthropicClient(). */
  setAnthropicClient(client: Anthropic | undefined): void {
    this.anthropicClient = client;
  }

  /** Managed credit host for debiting the HyDE pool-key call (set by
   *  KnowledgeLayer.setMeteredHost). Null on self-host / BYOK. */
  setMeteredHost(host: HookHost | null): void {
    this.meteredHost = host;
  }

  /**
   * Wire the S5b engine.db recall path. `enabled` is the fully co-gated flag
   * (memory_graph_reads AND subject_graph_enabled) resolved by KnowledgeLayer;
   * when true, `retrieve` reads memories from engine.db with a per-read legacy
   * fallback. Idempotent — safe to call once at construction.
   */
  setMemoryGraphReads(recallStore: MemoryGraphStore, subjectStore: SubjectStore, enabled: boolean): void {
    this.memoryRecall = recallStore;
    this.subjectStore = subjectStore;
    this.memoryGraphReads = enabled;
  }

  async retrieve(
    query: string,
    scopes: MemoryScopeRef[],
    options?: RetrievalOptions | undefined,
  ): Promise<KnowledgeRetrievalResult> {
    const topK = options?.topK ?? DEFAULT_TOP_K;
    const threshold = options?.threshold ?? DEFAULT_THRESHOLD;

    // === Step 1: HyDE (cached) ===
    let queryForEmbedding = query;
    if (options?.useHyDE && this.anthropicClient && query.length >= 20) {
      const cachedHyDE = this._hydeCache.get(query);
      if (cachedHyDE !== undefined) {
        queryForEmbedding = `${query} ${cachedHyDE}`;
      } else {
        const hypothetical = await this._generateHyDE(query);
        if (hypothetical) {
          this._hydeCache.set(query, hypothetical);
          queryForEmbedding = `${query} ${hypothetical}`;
        }
      }
    }

    // === Step 2: Embed query (cached) ===
    let queryEmbedding = this._embeddingCache.get(queryForEmbedding);
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingProvider.embed(queryForEmbedding);
      this._embeddingCache.set(queryForEmbedding, queryEmbedding);
    }

    // === Step 3: Multi-signal search ===
    const scopeTypes = scopes.map(s => s.type);
    // Extract query terms ONCE — both the legacy display resolver and the S5b
    // subject resolver consume them (avoids a second regex pass on the hot path).
    const queryTerms = extractEntitiesRegex(query).entities;
    // Display / DataStore-hint entities stay on the legacy KG resolver regardless
    // of the memory-read flag — the `<knowledge_graph>` block + DataStore bridge
    // are keyed on legacy entity ids (a separate concern from which memories to
    // recall). Only the MEMORY reads (vector + graph-expand) re-point in S5b.
    const queryEntities = await this._resolveQueryEntities(queryTerms, scopes);
    const dim = this.embeddingProvider.dimensions;

    let vectorResults: ScoredMemoryRow[] | undefined;
    let graphExpanded: MemoryRow[] = [];
    // S5b: engine.db memory recall when memory_graph_reads is on (co-gated on the
    // subject-graph mirror + a populated store). Both reads share one try — a throw
    // in either falls the WHOLE recall back to legacy, so the flip can never fail a
    // recall and the two signals never straddle the two stores.
    if (this.memoryGraphReads && this.memoryRecall) {
      try {
        vectorResults = this.memoryRecall.findSimilarRecall(queryEmbedding, dim, 50, threshold * 0.8, {
          namespace: options?.namespace,
          scopeTypes,
          activeOnly: true,
        });
        graphExpanded = options?.useGraphExpansion !== false
          ? this._graphExpandSubjects(this._resolveQuerySubjects(queryTerms))
          : [];
      } catch (err: unknown) {
        this._logReadFallback('retrieve', err);
        vectorResults = undefined;
      }
    }
    if (vectorResults === undefined) {
      vectorResults = this.db.findSimilarMemories(queryEmbedding, 50, threshold * 0.8, {
        namespace: options?.namespace,
        scopeTypes,
        activeOnly: true,
      });
      graphExpanded = options?.useGraphExpansion !== false
        ? this._graphExpand(queryEntities)
        : [];
    }

    // === Step 4: Merge candidates ===
    const candidateMap = new Map<string, ScoredCandidate>();

    for (const row of vectorResults) {
      const emb = row.embedding ? blobToEmbed(row.embedding, dim) : [];
      candidateMap.set(row.id, {
        id: row.id,
        text: row.text,
        namespace: row.namespace,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        subjectId: row.subject_id ?? null,
        createdAt: row.created_at,
        embedding: emb,
        confidence: row.confidence,
        confirmationCount: row.confirmation_count,
        sourceRunId: row.source_run_id,
        sourceType: row.source_type as ProvenanceKind,
        sourceToolName: row.source_tool_name,
        vectorScore: row._similarity * VECTOR_WEIGHT,
        ftsScore: 0,
        graphBoost: 0,
        runBoost: 0,
        finalScore: 0,
        source: 'vector',
      });
    }

    for (const row of graphExpanded) {
      const existing = candidateMap.get(row.id);
      if (existing) {
        existing.graphBoost = GRAPH_BOOST;
        if (existing.vectorScore === 0) existing.source = 'graph';
      } else {
        const emb = row.embedding ? blobToEmbed(row.embedding, dim) : [];
        candidateMap.set(row.id, {
          id: row.id, text: row.text, namespace: row.namespace,
          scopeType: row.scope_type, scopeId: row.scope_id,
          subjectId: row.subject_id ?? null,
          createdAt: row.created_at, embedding: emb,
          confidence: row.confidence, confirmationCount: row.confirmation_count,
          sourceRunId: row.source_run_id,
          sourceType: row.source_type as ProvenanceKind,
          sourceToolName: row.source_tool_name,
          vectorScore: 0, ftsScore: 0, graphBoost: GRAPH_BOOST, runBoost: 0,
          finalScore: 0, source: 'graph',
        });
      }
    }

    // === Step 5: Scope filtering ===
    const scopeSet = new Set(scopes.map(s => `${s.type}:${s.id}`));
    const candidates = [...candidateMap.values()].filter(c =>
      scopeSet.has(`${c.scopeType}:${c.scopeId}`),
    );

    // === Step 6: Scoring with decay + confidence + run boost ===
    // Context-Hierarchy Scoping (Slice C): resolve the active thread's anchor
    // hierarchy ONCE. When present, the soft walk-up weight subsumes the flat
    // scope_type weight; when absent (no anchor / no subject store / stale anchor),
    // scoring is byte-identical to before (back-compat).
    const anchorCtx = this._resolveAnchorContext(options?.threadAnchorSubjectId);
    for (const c of candidates) {
      const sw = anchorCtx
        ? this._contextScopeWeight(c.subjectId, c.scopeType, anchorCtx)
        : scopeWeight(c.scopeType as MemoryScopeType);
      const decay = this._namespacedDecay(c.createdAt, c.namespace as MemoryNamespace);

      // Run boost: memories linked to successful runs score higher
      if (c.sourceRunId && this.runHistory) {
        const run = this.runHistory.getRun(c.sourceRunId);
        if (run && run.status === 'completed') {
          c.runBoost = THREAD_BOOST;
        }
      }

      // Confidence multiplier: confirmed memories score higher, unconfirmed decay over time
      const ageDays = (Date.now() - new Date(c.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const confirmDecay = c.confirmationCount > 0 ? 1.0 : Math.max(0.5, 1.0 - ageDays / 365);
      const confMult = (0.5 + 0.5 * Math.min(c.confidence * (1 + c.confirmationCount * 0.1), 1.0)) * confirmDecay;

      c.finalScore = (c.vectorScore + c.ftsScore + c.graphBoost + c.runBoost)
        * sw * decay * confMult;
    }

    const aboveThreshold = candidates.filter(c => c.finalScore > threshold * 0.3);

    // === Step 7: MMR Re-Ranking ===
    const selected = this._mmrRerank(aboveThreshold, queryEmbedding, topK);

    // === Step 8: Update retrieval metadata (fire-and-forget) ===
    for (const c of selected) {
      try { this.db.updateMemoryRetrieved(c.id); } catch { /* best-effort */ }
    }

    // === Step 9: Build context ===
    const entities = queryEntities;
    const contextGraph = await this._formatContextGraphWithData(entities);

    return {
      memories: selected.map(c => ({
        id: c.id, text: c.text,
        namespace: c.namespace as MemoryNamespace,
        scopeType: c.scopeType as MemoryScopeType,
        scopeId: c.scopeId,
        score: c.vectorScore / VECTOR_WEIGHT,
        finalScore: c.finalScore,
        source: c.source,
        sourceType: c.sourceType,
        sourceToolName: c.sourceToolName,
        confidence: c.confidence,
        createdAt: c.createdAt,
      })),
      entities,
      contextGraph,
    };
  }

  formatContext(result: KnowledgeRetrievalResult, maxChars?: number | undefined): string {
    if (result.memories.length === 0 && result.entities.length === 0) return '';

    const limit = maxChars ?? DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS;
    const memories = [...result.memories];

    // INV-1: the recall surface previously ran NO injection scan. Flag facts
    // whose stored body resembles an injection / marker-forgery attempt. The
    // body is still structurally escaped inside <fact>, so this is observability
    // + an agent hint — never a silent drop of the user's own memory. Scan once
    // here (not in the trim loop) to avoid duplicate security events.
    const flagged = new Set<string>();
    const labels = new Set<string>();
    for (const m of memories) {
      const det = detectInjectionAttempt(m.text);
      if (det.detected) {
        flagged.add(m.id);
        for (const l of det.patterns) labels.add(l);
      }
    }
    if (flagged.size > 0 && channels.securityInjection.hasSubscribers) {
      channels.securityInjection.publish({
        event_type: 'injection_detected',
        detail: `Suspected injection in ${flagged.size} recalled memor${flagged.size === 1 ? 'y' : 'ies'}: ${[...labels].join(', ')}`,
        decision: 'flagged',
        source: 'memory_recall',
      });
    }

    let formatted = this._buildContextString(memories, result.contextGraph, flagged);
    while (formatted.length > limit && memories.length > 1) {
      let lowestIdx = 0;
      let lowestScore = Infinity;
      for (let i = 0; i < memories.length; i++) {
        if (memories[i]!.finalScore < lowestScore) {
          lowestScore = memories[i]!.finalScore;
          lowestIdx = i;
        }
      }
      memories.splice(lowestIdx, 1);
      formatted = this._buildContextString(memories, result.contextGraph, flagged);
    }

    return formatted;
  }

  private _buildContextString(
    memories: KnowledgeRetrievalResult['memories'],
    contextGraph: string | undefined,
    flagged?: ReadonlySet<string> | undefined,
  ): string {
    const sections: string[] = [];
    const scopeOrder: MemoryScopeType[] = ['user', 'context', 'global'];
    const grouped = new Map<MemoryScopeType, typeof memories>();

    for (const m of memories) {
      const bucket = grouped.get(m.scopeType) ?? [];
      bucket.push(m);
      grouped.set(m.scopeType, bucket);
    }

    for (const scopeType of scopeOrder) {
      const bucket = grouped.get(scopeType);
      if (!bucket || bucket.length === 0) continue;
      // Structural provenance marker (PRD v3 / INV-1): the trust tier rides a
      // `<fact kind=…>` element whose body is escaped, so content embedding a
      // fake `<fact>`/`[tool_verified]` cannot launder itself into an engine
      // marker. The relevance %, namespace and date are engine-trusted attrs.
      const entries = bucket.map(m => renderProvenanceFact({
        text: m.text,
        kind: m.sourceType,
        tool: m.sourceToolName,
        confidence: m.confidence,
        attrs: {
          ns: m.namespace,
          relevance: `${(m.finalScore * 100).toFixed(0)}%`,
          date: m.createdAt.slice(0, 10),
          ...(flagged?.has(m.id) ? { flagged: 'suspected_injection' } : {}),
        },
      })).join('\n');
      sections.push(`<scope type="${escapeXml(scopeType)}">\n${entries}\n</scope>`);
    }

    if (contextGraph) sections.push(contextGraph);
    if (sections.length === 0) return '';
    return `<relevant_context>\n${sections.join('\n')}\n</relevant_context>`;
  }

  // === Private Methods ===

  private async _generateHyDE(query: string): Promise<string | null> {
    if (!this.anthropicClient) return null;
    try {
      const fast = resolveTierModel('fast', getActiveProvider());
      const fastClient = clientForTierSnapshot(fast, this.anthropicClient, getActiveProvider());
      const stream = fastClient.beta.messages.stream({
        model: fast.modelId,
        max_tokens: 256,
        ...(fast.betas ? { betas: fast.betas } : {}),
        messages: [{
          role: 'user',
          content: `Write a brief factual answer (1-2 sentences) to this question as if you already know the answer. Do not explain or add caveats.\n\nQuestion: ${query.slice(0, 500)}`,
        }],
      });
      const response = await stream.finalMessage();
      // Debit this pool-key HyDE call to the tenant balance (managed). It runs
      // inside the already-gated retrieval of a run, but its tokens never reach
      // the run's own accounting, so debit the marginal cost here on a fresh run
      // id (the CP dedups on it). No local-cap recording — the RetrievalEngine
      // holds no session counters and a 256-token call is immaterial there.
      const u = response.usage;
      if (this.meteredHost && u) {
        reportMeteredCost(
          this.meteredHost,
          randomUUID(),
          calculateCost(fast.modelId, {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
          }),
          'fast',
        );
      }
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text.slice(0, 300) : null;
    } catch {
      return null;
    }
  }

  private async _resolveQueryEntities(
    entities: ExtractedEntity[],
    scopes: MemoryScopeRef[],
  ): Promise<EntityRecord[]> {
    const resolved: EntityRecord[] = [];

    for (const entity of entities.slice(0, 5)) {
      const record = await this.entityResolver.resolve(
        entity.name, entity.type, scopes, { createIfMissing: false },
      );
      if (record) resolved.push(record);
    }

    return resolved;
  }

  private _graphExpand(resolvedEntities: EntityRecord[]): MemoryRow[] {
    if (resolvedEntities.length === 0) return [];

    const results: MemoryRow[] = [];
    const seenIds = new Set<string>();

    for (const resolved of resolvedEntities) {
      const direct = this.db.getMemoriesMentioningEntity(resolved.id, true, 5);
      for (const row of direct) {
        if (!seenIds.has(row.id)) { seenIds.add(row.id); results.push(row); }
      }

      const related = this.db.getRelatedMemoriesViaEntities(resolved.id, 2, true, 3);
      for (const row of related) {
        if (!seenIds.has(row.id)) { seenIds.add(row.id); results.push(row); }
      }
    }

    return results;
  }

  /**
   * S5b: resolve the (already-extracted) query terms to engine.db SUBJECT ids for
   * graph-expand. Takes the SAME pre-extracted terms as {@link _resolveQueryEntities}
   * (slice(0,5)) but resolves to subjects via canonical/alias lookup instead of the
   * legacy entity resolver. `engagement`-kind terms (project) miss the canonical index
   * — which covers person/organization/product/service — but resolve via findByAlias
   * (a subject's name is in its aliases). Subjects are owner-scoped (the mirror writes
   * them under the default owner), NOT memory-scoped, so no scope arg. A term whose
   * entity type has no subject kind (concept/location) is skipped, matching the mirror.
   */
  private _resolveQuerySubjects(entities: ExtractedEntity[]): SubjectRow[] {
    if (!this.subjectStore) return [];
    const resolved: SubjectRow[] = [];
    const seen = new Set<string>();
    for (const entity of entities.slice(0, 5)) {
      const kind = entityTypeToSubjectKind(entity.type);
      if (!kind) continue;
      const row = this.subjectStore.findCanonical(entity.name, kind)
        ?? this.subjectStore.findByAlias(entity.name, kind);
      if (row && !seen.has(row.id)) { seen.add(row.id); resolved.push(row); }
    }
    return resolved;
  }

  /**
   * S5b engine.db graph-expand — the subject-keyed twin of {@link _graphExpand}
   * (direct mentions + 1-relationship-hop related, same per-subject limits 5/3,
   * same de-dup by id).
   */
  private _graphExpandSubjects(subjects: SubjectRow[]): MemoryRow[] {
    if (subjects.length === 0 || !this.memoryRecall) return [];

    const results: MemoryRow[] = [];
    const seenIds = new Set<string>();

    for (const subject of subjects) {
      const direct = this.memoryRecall.memoriesMentioningSubject(subject.id, true, 5);
      for (const row of direct) {
        if (!seenIds.has(row.id)) { seenIds.add(row.id); results.push(row); }
      }

      const related = this.memoryRecall.relatedMemoriesViaSubjects(subject.id, true, 3);
      for (const row of related) {
        if (!seenIds.has(row.id)) { seenIds.add(row.id); results.push(row); }
      }
    }

    return results;
  }

  /**
   * A subject-graph recall read that throws (closed/corrupt engine.db) must never
   * crash retrieval — it falls back to the legacy store (the write authority through
   * S5b') and logs for observability, mirroring the S1b/S1d read-fallback isolation.
   */
  private _logReadFallback(method: string, err: unknown): void {
    process.stderr.write(
      `[lynox:subject-graph] recall ${method} fell back to legacy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  /**
   * Context-Hierarchy Scoping (Slice C): resolve the active thread's anchor into its
   * context hierarchy (anchor + ancestors + their walk-up weights), or null when
   * scoping is inactive. Null (→ flat scope_type weighting) when: no anchor id, no
   * engine.db subject store wired, or the anchor is a stale/purged subject (a
   * cross-DB soft ref — the anchor lives on history.db `threads`, the subject on
   * engine.db, with no enforceable FK; a dangling anchor must degrade, not scope).
   */
  private _resolveAnchorContext(anchorId: string | null | undefined): AnchorContext | null {
    if (!anchorId || !this.subjectStore) return null;
    if (!this.subjectStore.getSubject(anchorId)) return null; // stale anchor → no scoping
    const chainWeights = new Map<string, number>();
    chainWeights.set(anchorId, ANCHOR_WEIGHT);
    const ancestors = this.subjectStore.getAncestors(anchorId);
    ancestors.forEach((a, i) => {
      // A cycle already broken by getAncestors yields distinct rows; guard a
      // pathological repeat so an ancestor never downgrades an already-mapped id.
      if (!chainWeights.has(a.id)) chainWeights.set(a.id, ancestorWeight(i + 1));
    });
    return { chainWeights, ancestorSet: new Set(chainWeights.keys()), siblingCache: new Map() };
  }

  /**
   * The soft walk-up weight for a candidate given the active anchor context. Tiers:
   * on-chain (anchor or an ancestor) → its mapped weight; off-chain but sharing an
   * ancestor with the anchor (sibling/cousin) → {@link SIBLING_WEIGHT}; wholly
   * unrelated subject → {@link UNRELATED_WEIGHT} (still visible). A memory with NO
   * subject (legacy / un-anchored) falls back to the flat `scopeWeight(scope_type)`
   * — this is the subsumption of the degenerate scope_type axis: global/user memories
   * keep their scope weight, subject-bearing memories get the hierarchy weight.
   */
  private _contextScopeWeight(
    subjectId: string | null,
    scopeType: string,
    ctx: AnchorContext,
  ): number {
    if (!subjectId) return scopeWeight(scopeType as MemoryScopeType);
    const onChain = ctx.chainWeights.get(subjectId);
    if (onChain !== undefined) return onChain;
    let sibling = ctx.siblingCache.get(subjectId);
    if (sibling === undefined) {
      sibling = false;
      for (const a of this.subjectStore!.getAncestors(subjectId)) {
        if (ctx.ancestorSet.has(a.id)) { sibling = true; break; }
      }
      ctx.siblingCache.set(subjectId, sibling);
    }
    return sibling ? SIBLING_WEIGHT : UNRELATED_WEIGHT;
  }

  private _namespacedDecay(createdAt: string, namespace: MemoryNamespace): number {
    const created = new Date(createdAt).getTime();
    if (Number.isNaN(created)) return 1.0;
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    if (ageDays <= 0) return 1.0;
    const halfLife = NAMESPACE_HALF_LIFE[namespace] ?? 90;
    return Math.exp(-ageDays / halfLife);
  }

  private _mmrRerank(
    candidates: ScoredCandidate[],
    _queryEmbedding: number[],
    topK: number,
  ): ScoredCandidate[] {
    if (candidates.length <= topK) return candidates.sort((a, b) => b.finalScore - a.finalScore);

    const selected: ScoredCandidate[] = [];
    const remaining = [...candidates];

    while (selected.length < topK && remaining.length > 0) {
      let bestIdx = 0;
      let bestMMR = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]!;
        const relevance = candidate.finalScore;

        let maxSim = 0;
        if (candidate.embedding.length > 0) {
          for (const sel of selected) {
            if (sel.embedding.length === candidate.embedding.length) {
              const sim = cosineSimilarity(candidate.embedding, sel.embedding);
              if (sim > maxSim) maxSim = sim;
            }
          }
        }

        const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
        if (mmr > bestMMR) { bestMMR = mmr; bestIdx = i; }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]!);
    }

    return selected;
  }

  private async _formatContextGraphWithData(entities: EntityRecord[]): Promise<string> {
    if (entities.length === 0) return '';

    const entityLines = entities.map(e => {
      const seen = e.lastSeenAt.slice(0, 10);
      return `${escapeXml(e.canonicalName)} (${e.entityType}, ${e.mentionCount} mentions, last ${seen})`;
    });
    const parts = [`Entities: ${entityLines.join(', ')}`];

    if (this.dataStoreBridge && entities.length > 0) {
      try {
        const hints = await this.dataStoreBridge.findRelatedData(entities.map(e => e.id));
        if (hints.length > 0) {
          const dataLines = hints.map(h =>
            h.preview
              ? `${escapeXml(h.entityName)} in ${escapeXml(h.collection)} (${escapeXml(h.preview)})`
              : `${escapeXml(h.entityName)} in ${escapeXml(h.collection)}`,
          );
          parts.push(`Data: ${dataLines.join('; ')}`);
        }
      } catch {
        // Best-effort
      }
    }

    return `<knowledge_graph>\n${parts.join('\n')}\n</knowledge_graph>`;
  }
}
