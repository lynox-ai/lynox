import type Anthropic from '@anthropic-ai/sdk';
import type {
  MemoryNamespace,
  MemoryScopeRef,
  MemoryScopeType,
  EntityRecord,
  KnowledgeRetrievalResult,
} from '../types/index.js';
import { SCOPE_WEIGHTS, MODEL_MAP, NODYN_BETAS, NAMESPACE_HALF_LIFE } from '../types/index.js';
import type { KuzuGraph } from './knowledge-graph.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineSimilarity } from './embedding.js';
import { extractEntitiesRegex } from './entity-extractor.js';
import type { EntityResolver } from './entity-resolver.js';
import type { DataStoreBridge } from './datastore-bridge.js';
import type { LbugValue } from '@ladybugdb/core';
import { escapeXml } from './data-boundary.js';

/** Default retrieval options. */
const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.55;
const MMR_LAMBDA = 0.7; // 0.7 relevance, 0.3 diversity

/** Max chars for formatted knowledge context injected into system prompt (~3K tokens). */
const DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS = 12_000;

/** Weight allocation for multi-signal scoring. */
const VECTOR_WEIGHT = 0.55;
const GRAPH_BOOST = 0.15;

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
  vectorScore: number;
  ftsScore: number;
  graphBoost: number;
  finalScore: number;
  source: 'vector' | 'graph' | 'fts';
}

/**
 * Graph-augmented retrieval engine.
 *
 * Pipeline: HyDE → Vector Search → FTS → Graph Expansion → Merge → Score → MMR → Format
 */
export class RetrievalEngine {
  private dataStoreBridge: DataStoreBridge | null = null;

  constructor(
    private readonly graph: KuzuGraph,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly entityResolver: EntityResolver,
    private readonly anthropicClient?: Anthropic | undefined,
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

    // === Step 1: HyDE (Hypothetical Document Embedding) ===
    let queryForEmbedding = query;
    if (options?.useHyDE && this.anthropicClient && query.length >= 20) {
      const hypothetical = await this._generateHyDE(query);
      if (hypothetical) {
        queryForEmbedding = `${query} ${hypothetical}`;
      }
    }

    // === Step 2: Embed query ===
    const queryEmbedding = await this.embeddingProvider.embed(queryForEmbedding);

    // === Step 3: Multi-signal search (parallel) ===
    const scopeTypes = scopes.map(s => s.type);

    const [vectorResults, graphExpanded] = await Promise.all([
      // 3a. Vector search
      this.graph.findSimilarMemories(queryEmbedding, 50, threshold * 0.8, {
        namespace: options?.namespace,
        scopeTypes,
        activeOnly: true,
      }),
      // 3b. Graph expansion (entity-based)
      options?.useGraphExpansion !== false
        ? this._graphExpand(query, scopes)
        : Promise.resolve([]),
    ]);

    // === Step 4: Merge candidates ===
    const candidateMap = new Map<string, ScoredCandidate>();

    // Vector results (primary signal)
    for (const row of vectorResults) {
      const id = row['m.id'] as string;
      candidateMap.set(id, {
        id,
        text: row['m.text'] as string,
        namespace: row['m.namespace'] as string,
        scopeType: row['m.scope_type'] as string,
        scopeId: row['m.scope_id'] as string,
        createdAt: String(row['m.created_at'] ?? ''),
        embedding: (row['m.embedding'] as number[]) ?? [],
        vectorScore: row._similarity * VECTOR_WEIGHT,
        ftsScore: 0,
        graphBoost: 0,
        finalScore: 0,
        source: 'vector',
      });
    }

    // Graph-expanded results (boost signal)
    for (const row of graphExpanded) {
      const id = row['m.id'] as string;
      const existing = candidateMap.get(id);
      if (existing) {
        existing.graphBoost = GRAPH_BOOST;
        // Promote source to 'graph' if it wasn't found by vector
        if (existing.vectorScore === 0) existing.source = 'graph';
      } else {
        candidateMap.set(id, {
          id,
          text: row['m.text'] as string,
          namespace: row['m.namespace'] as string,
          scopeType: row['m.scope_type'] as string,
          scopeId: row['m.scope_id'] as string,
          createdAt: String(row['m.created_at'] ?? ''),
          embedding: [],
          vectorScore: 0,
          ftsScore: 0,
          graphBoost: GRAPH_BOOST,
          finalScore: 0,
          source: 'graph',
        });
      }
    }

    // === Step 5: Scope filtering ===
    const scopeSet = new Set(scopes.map(s => `${s.type}:${s.id}`));
    const candidates = [...candidateMap.values()].filter(c =>
      scopeSet.has(`${c.scopeType}:${c.scopeId}`),
    );

    // === Step 6: Scoring with namespace-specific decay + scope weight ===
    for (const c of candidates) {
      const scopeWeight = SCOPE_WEIGHTS[c.scopeType as MemoryScopeType] ?? 0.3;
      const decay = this._namespacedDecay(c.createdAt, c.namespace as MemoryNamespace);

      c.finalScore = (c.vectorScore + c.ftsScore + c.graphBoost) * scopeWeight * decay;
    }

    // Filter below threshold
    const aboveThreshold = candidates.filter(c => c.finalScore > threshold * 0.3);

    // === Step 7: MMR Re-Ranking ===
    const selected = this._mmrRerank(aboveThreshold, queryEmbedding, topK);

    // === Step 8: Update retrieval metadata ===
    for (const c of selected) {
      void this.graph.updateMemoryRetrieved(c.id).catch(() => { /* fire-and-forget */ });
    }

    // === Step 9: Build entity context + DataStore hints ===
    const entities = await this._extractQueryEntities(query, scopes);
    const contextGraph = await this._formatContextGraphWithData(entities);

    return {
      memories: selected.map(c => ({
        id: c.id,
        text: c.text,
        namespace: c.namespace as MemoryNamespace,
        scopeType: c.scopeType as MemoryScopeType,
        scopeId: c.scopeId,
        score: c.vectorScore / VECTOR_WEIGHT, // raw similarity
        finalScore: c.finalScore,
        source: c.source,
      })),
      entities,
      contextGraph,
    };
  }

  /**
   * Format retrieval results as a system prompt context block.
   * When maxChars is set, drops lowest-scored memories to stay within budget
   * (preserves complete memories rather than truncating individual texts).
   */
  formatContext(result: KnowledgeRetrievalResult, maxChars?: number | undefined): string {
    if (result.memories.length === 0 && result.entities.length === 0) return '';

    const limit = maxChars ?? DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS;
    let memories = [...result.memories];

    // Build context, dropping lowest-scored memories if over budget
    let formatted = this._buildContextString(memories, result.contextGraph);
    while (formatted.length > limit && memories.length > 1) {
      // Drop the lowest-scored memory across all scopes
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

  /** Assemble the <relevant_context> XML block from memories and entity graph. */
  private _buildContextString(
    memories: KnowledgeRetrievalResult['memories'],
    contextGraph: string | undefined,
  ): string {
    const sections: string[] = [];

    // Group memories by scope (user > context > global)
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

      const entries = bucket.map(m =>
        `[${escapeXml(m.namespace)}] (${(m.finalScore * 100).toFixed(0)}%)\n${escapeXml(m.text)}`,
      ).join('\n\n');

      sections.push(`<scope type="${escapeXml(scopeType)}">\n${entries}\n</scope>`);
    }

    // Add entity graph context if available
    if (contextGraph) {
      sections.push(contextGraph);
    }

    if (sections.length === 0) return '';
    return `<relevant_context>\n${sections.join('\n')}\n</relevant_context>`;
  }

  // === Private Methods ===

  /**
   * HyDE: Generate a hypothetical answer to improve embedding quality.
   */
  private async _generateHyDE(query: string): Promise<string | null> {
    if (!this.anthropicClient) return null;

    try {
      const stream = this.anthropicClient.beta.messages.stream({
        model: MODEL_MAP['haiku'],
        max_tokens: 256,
        betas: [...NODYN_BETAS],
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

  /**
   * Graph expansion: extract entities from query, find connected memories.
   */
  private async _graphExpand(
    query: string,
    scopes: MemoryScopeRef[],
  ): Promise<Record<string, LbugValue>[]> {
    // Extract entities from the query text
    const { entities } = extractEntitiesRegex(query);
    if (entities.length === 0) return [];

    const results: Record<string, LbugValue>[] = [];
    const seenIds = new Set<string>();

    for (const entity of entities.slice(0, 5)) { // Max 5 entities to limit scope
      const resolved = await this.entityResolver.resolve(
        entity.name,
        entity.type,
        scopes,
        { createIfMissing: false },
      );
      if (!resolved) continue;

      // 1-hop: memories directly mentioning this entity
      const direct = await this.graph.getMemoriesMentioningEntity(resolved.id, true, 5);
      for (const row of direct) {
        const id = row['m.id'] as string;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          results.push(row);
        }
      }

      // 2-hop: memories mentioning related entities
      const related = await this.graph.getRelatedMemoriesViaEntities(resolved.id, 2, true, 3);
      for (const row of related) {
        const id = row['m.id'] as string;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          results.push(row);
        }
      }
    }

    return results;
  }

  /**
   * Namespace-specific temporal decay.
   * knowledge: 365d half-life (quasi permanent)
   * methods: 180d
   * learnings: 120d
   * project-state: 21d (fast decay)
   */
  private _namespacedDecay(createdAt: string, namespace: MemoryNamespace): number {
    const created = new Date(createdAt).getTime();
    if (Number.isNaN(created)) return 1.0;
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    if (ageDays <= 0) return 1.0;
    const halfLife = NAMESPACE_HALF_LIFE[namespace] ?? 90;
    return Math.exp(-ageDays / halfLife);
  }

  /**
   * Maximal Marginal Relevance re-ranking.
   * Balances relevance and diversity to avoid near-duplicate results.
   */
  private _mmrRerank(
    candidates: ScoredCandidate[],
    queryEmbedding: number[],
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

        // Max similarity to any already-selected item
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
        if (mmr > bestMMR) {
          bestMMR = mmr;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]!);
    }

    return selected;
  }

  /**
   * Extract and resolve entities mentioned in the query.
   */
  private async _extractQueryEntities(
    query: string,
    scopes: MemoryScopeRef[],
  ): Promise<EntityRecord[]> {
    const { entities } = extractEntitiesRegex(query);
    const resolved: EntityRecord[] = [];

    for (const entity of entities.slice(0, 5)) {
      const record = await this.entityResolver.resolve(
        entity.name,
        entity.type,
        scopes,
        { createIfMissing: false },
      );
      if (record) resolved.push(record);
    }

    return resolved;
  }

  /**
   * Format entity context graph with optional DataStore hints.
   */
  private async _formatContextGraphWithData(entities: EntityRecord[]): Promise<string> {
    if (entities.length === 0) return '';

    const entityLines = entities.map(e =>
      `${escapeXml(e.canonicalName)} (${e.entityType}, ${e.mentionCount} mentions)`,
    );

    const parts = [`Entities: ${entityLines.join(', ')}`];

    // Add DataStore hints if bridge is available
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
        // Non-critical — DataStore hints are best-effort
      }
    }

    return `<knowledge_graph>\n${parts.join('\n')}\n</knowledge_graph>`;
  }
}

// escapeXml imported from data-boundary.ts
