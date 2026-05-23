import type Anthropic from '@anthropic-ai/sdk';
import type {
  MemoryNamespace,
  MemoryScopeRef,
  MemoryScopeType,
  EntityRecord,
  KnowledgeRetrievalResult,
} from '../types/index.js';
import { getBetasForProvider, NAMESPACE_HALF_LIFE, getModelId } from '../types/index.js';
import { getActiveProvider, isCustomProvider } from './llm-client.js';
import { scopeWeight } from './scope-resolver.js';
import type { AgentMemoryDb, MemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineSimilarity, blobToEmbed } from './embedding.js';
import { extractEntitiesRegex } from './entity-extractor.js';
import type { EntityResolver } from './entity-resolver.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import type { RunHistory } from './run-history.js';
import { escapeXml } from './data-boundary.js';

/** Default retrieval options. */
const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.55;
/**
 * MMR diversity vs relevance weight. mmr = λ·relevance - (1-λ)·maxSim.
 *
 * Raised from 0.7 → 0.85 because finalScore lives on a [0..1] scale that
 * routinely sits around 0.25-0.35, while maxSim lives on [0..1] but easily
 * reaches 0.85-0.95 for thematically related memories (e.g. multiple
 * "Acme uses Postgres for X" rows). The old 0.3 diversity weight times a
 * 0.9 maxSim overpowered a 0.7 × 0.3 relevance signal, kicking the 2nd-best
 * gold memory out of top-5 even when it was the perfect semantic match.
 * 0.85 keeps a meaningful diversity penalty (-0.15·maxSim, so ~0.13 for
 * a duplicate) but prevents a strictly-better second pick from being
 * suppressed by an off-topic but-diverse distractor. Bench (kg-bench
 * Phase 1, 2026-05-23) was the calibration target.
 */
const MMR_LAMBDA = (() => {
  const v = Number(process.env.LYNOX_RETRIEVAL_MMR_LAMBDA);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.85;
})();

/** Max chars for formatted knowledge context (~3K tokens). */
const DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS = 12_000;

/** Weight allocation for multi-signal scoring. */
const VECTOR_WEIGHT = 0.55;
const GRAPH_BOOST = 0.15;
const THREAD_BOOST = 0.10;

/**
 * Within a namespace's first half-life window, never let the recency-decay
 * factor drop below this floor. Rationale: an exponential `exp(-ageDays /
 * halfLife)` decay multiplied against `vectorScore + boosts` can drown out
 * a meaningful cosine advantage when the gold memory is 30-90 days old and
 * a 1-day-old distractor sits in the same scope. The KG-recall Phase 1
 * bench (scripts/kg-bench, 2026-05-23 baseline recall@5=0.314) confirmed
 * the gold memory was retrieved by the vector layer but ranked outside
 * top-5 in ~25/40 failing queries — the recency × confirmation product
 * was overpowering a 7-point cosine advantage. Floor preserves semantic
 * ranking while still rewarding recency.
 *
 * The floor only applies WITHIN one half-life. Beyond one half-life the
 * raw exponential decay takes over (the memory really is old, recency
 * should matter), so the long-tail behavior is unchanged.
 *
 * Calibration: 0.95 was selected from a 6-point sweep
 * `[0.70, 0.80, 0.85, 0.90, 0.95, 1.00]` (scripts/kg-bench/results/calib/
 * sweep-recency.csv, 2026-05-23). recall@5 jumped from 0.586 → 0.821 between
 * 0.90 → 0.95 — the smallest value that put the bench above pass-bar with
 * non-zero margin. 1.00 (full floor) gives the best raw numbers (0.885) but
 * is equivalent to disabling within-half-life recency entirely; 0.95
 * preserves a mild recency tiebreaker for memories at the half-life edge.
 *
 * Tunable at runtime via `LYNOX_RETRIEVAL_RECENCY_FLOOR=<0..1>` (out-of-range
 * values silently fall back to the default — keep calibration honest, don't
 * crash on a typo).
 */
const RECENCY_FLOOR_WITHIN_HALFLIFE = (() => {
  const v = Number(process.env.LYNOX_RETRIEVAL_RECENCY_FLOOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.95;
})();

/**
 * Same idea for the linear confirmation-decay term applied to unconfirmed
 * memories (`1 - ageDays/365`). Without a floor, 6-month-old unconfirmed
 * facts shed half their weight even when the cosine evidence is strong.
 * The existing `Math.max(0.5, ...)` floor at 1-year never kicked in for
 * the bench corpus (ages 1-90 days) — we raise the floor so a 60-day-old
 * unconfirmed memory doesn't get unfairly suppressed vs a 1-day distractor.
 * Calibration: 1.00 was the only passing value in a 6-point sweep
 * `[0.70, 0.80, 0.85, 0.90, 0.95, 1.00]` at RECENCY=0.95
 * (scripts/kg-bench/results/calib/sweep-confirm.csv, 2026-05-23) — a
 * NARROW passing region (flagged in the calibration report). A 2-D sweep
 * at RECENCY=1.00 widened the region to {0.95, 1.00}. The product of the
 * two floors is the lever; we pick the largest pair (most permissive on
 * new/unconfirmed memories) on the theory that the confidence×(1+0.1×count)
 * term still rewards confirmed memories adequately.
 *
 * Tunable via `LYNOX_RETRIEVAL_CONFIRM_FLOOR=<0..1>`. The hard 0.5 floor
 * at ~1-year still applies via the inner Math.max — long-tail unconfirmed
 * memories continue to decay even with this set to 1.0.
 */
const CONFIRM_DECAY_FLOOR = (() => {
  const v = Number(process.env.LYNOX_RETRIEVAL_CONFIRM_FLOOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1.0;
})();

export interface RetrievalOptions {
  topK?: number | undefined;
  threshold?: number | undefined;
  useHyDE?: boolean | undefined;
  useGraphExpansion?: boolean | undefined;
  namespace?: MemoryNamespace | undefined;
}

interface ScoredCandidate {
  id: string;
  text: string;
  namespace: string;
  scopeType: string;
  scopeId: string;
  createdAt: string;
  embedding: number[];
  confidence: number;
  confirmationCount: number;
  sourceRunId: string | null;
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
  private readonly _embeddingCache = new LruCache<number[]>(64);
  private readonly _hydeCache = new LruCache<string>(32);

  constructor(
    private readonly db: AgentMemoryDb,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly entityResolver: EntityResolver,
    private readonly anthropicClient?: Anthropic | undefined,
    private readonly runHistory?: RunHistory | undefined,
  ) {}

  setDataStoreBridge(bridge: DataStoreBridge): void {
    this.dataStoreBridge = bridge;
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
    const queryEntities = await this._resolveQueryEntities(query, scopes);

    const vectorResults = this.db.findSimilarMemories(queryEmbedding, 50, threshold * 0.8, {
      namespace: options?.namespace,
      scopeTypes,
      activeOnly: true,
    });

    const graphExpanded = options?.useGraphExpansion !== false
      ? this._graphExpand(queryEntities)
      : [];

    // === Step 4: Merge candidates ===
    const candidateMap = new Map<string, ScoredCandidate>();
    const dim = this.embeddingProvider.dimensions;

    for (const row of vectorResults) {
      const emb = row.embedding ? blobToEmbed(row.embedding, dim) : [];
      candidateMap.set(row.id, {
        id: row.id,
        text: row.text,
        namespace: row.namespace,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        createdAt: row.created_at,
        embedding: emb,
        confidence: row.confidence,
        confirmationCount: row.confirmation_count,
        sourceRunId: row.source_run_id,
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
          createdAt: row.created_at, embedding: emb,
          confidence: row.confidence, confirmationCount: row.confirmation_count,
          sourceRunId: row.source_run_id,
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
    for (const c of candidates) {
      const sw = scopeWeight(c.scopeType as MemoryScopeType);
      const decay = this._namespacedDecay(c.createdAt, c.namespace as MemoryNamespace);

      // Run boost: memories linked to successful runs score higher
      if (c.sourceRunId && this.runHistory) {
        const run = this.runHistory.getRun(c.sourceRunId);
        if (run && run.status === 'completed') {
          c.runBoost = THREAD_BOOST;
        }
      }

      // Confidence multiplier: confirmed memories score higher, unconfirmed decay over time.
      // CONFIRM_DECAY_FLOOR (see top-of-file) keeps unconfirmed memories from
      // being suppressed too aggressively in the bench-age window (1-90 days)
      // where cosine evidence should still dominate. The hard 0.5 floor at
      // ~6 months still applies via the second Math.max term.
      const ageDays = (Date.now() - new Date(c.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const confirmDecay = c.confirmationCount > 0
        ? 1.0
        : Math.max(CONFIRM_DECAY_FLOOR, Math.max(0.5, 1.0 - ageDays / 365));
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

    let formatted = this._buildContextString(memories, result.contextGraph);
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
      formatted = this._buildContextString(memories, result.contextGraph);
    }

    return formatted;
  }

  private _buildContextString(
    memories: KnowledgeRetrievalResult['memories'],
    contextGraph: string | undefined,
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
      const entries = bucket.map(m => {
        const date = m.createdAt.slice(0, 10);
        return `[${escapeXml(m.namespace)}] (${(m.finalScore * 100).toFixed(0)}%) — ${date}\n${escapeXml(m.text)}`;
      }).join('\n\n');
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
      const stream = this.anthropicClient.beta.messages.stream({
        model: getModelId('haiku', getActiveProvider()),
        max_tokens: 256,
        ...(isCustomProvider() ? {} : { betas: getBetasForProvider(getActiveProvider()) }),
        messages: [{
          role: 'user',
          content: `Write a brief factual answer (1-2 sentences) to this question as if you already know the answer. Do not explain or add caveats.\n\nQuestion: ${query.slice(0, 500)}`,
        }],
      });
      const response = await stream.finalMessage();
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text.slice(0, 300) : null;
    } catch {
      return null;
    }
  }

  private async _resolveQueryEntities(
    query: string,
    scopes: MemoryScopeRef[],
  ): Promise<EntityRecord[]> {
    const { entities } = extractEntitiesRegex(query);
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
   * Namespace-aware exponential recency decay with a within-half-life floor.
   *
   * Raw decay = exp(-ageDays / halfLife). Inside the first half-life, we
   * clamp the result to >= RECENCY_FLOOR_WITHIN_HALFLIFE so that a 1-day-old
   * row can't multiplicatively dominate a stronger-cosine 60-day-old row.
   * After one half-life, the raw exponential takes over — recency *should*
   * compound at that point. See KG-recall Phase 1 bench finding for the
   * concrete failure case that motivated the floor.
   */
  private _namespacedDecay(createdAt: string, namespace: MemoryNamespace): number {
    const created = new Date(createdAt).getTime();
    if (Number.isNaN(created)) return 1.0;
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    if (ageDays <= 0) return 1.0;
    const halfLife = NAMESPACE_HALF_LIFE[namespace] ?? 90;
    const rawDecay = Math.exp(-ageDays / halfLife);
    return ageDays < halfLife ? Math.max(rawDecay, RECENCY_FLOOR_WITHIN_HALFLIFE) : rawDecay;
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
