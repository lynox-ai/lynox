import type { IMemory, MemoryScopeRef, IKnowledgeLayer } from '../types/index.js';
import { ALL_NAMESPACES } from '../types/index.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineSimilarity, blobToEmbed } from './embedding.js';
import type { RunHistory } from './run-history.js';

/** Half-life for temporal decay in days. Memories older than this lose ~50% of their score. */
export const MEMORY_HALF_LIFE_DAYS = 90;

/**
 * Temporal decay multiplier based on age.
 * Returns exp(-age_days / HALF_LIFE) so recent memories score ~1.0
 * and old memories decay smoothly.
 */
export function temporalDecay(createdAt: string, halfLifeDays = MEMORY_HALF_LIFE_DAYS): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 1.0; // Unknown date → no penalty
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.exp(-ageDays / halfLifeDays);
}

const DEFAULT_DEDUP_THRESHOLD = 0.85;
const DEFAULT_AGE_DAYS = 180;
const MIN_LINE_LENGTH = 10;

export interface GcOptions {
  dedupThreshold?: number | undefined;
  ageDays?: number | undefined;
  dryRun?: boolean | undefined;
}

export interface GcResult {
  deduplicated: number;
  pruned: number;
  scopesProcessed: number;
  namespacesProcessed: number;
}

/**
 * Run garbage collection across memory scopes.
 *
 * Two passes per scope+namespace:
 * 1. **Dedup** — embed all lines, remove near-duplicates (cosine > threshold),
 *    keeping the longest line in each cluster.
 * 2. **Prune** — remove lines whose embeddings in RunHistory are stale
 *    (not created or retrieved within `ageDays`).
 */
export async function runMemoryGc(
  memory: IMemory,
  scopes: MemoryScopeRef[],
  provider: EmbeddingProvider,
  runHistory: RunHistory,
  options?: GcOptions | undefined,
): Promise<GcResult> {
  const threshold = options?.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  const ageDays = options?.ageDays ?? DEFAULT_AGE_DAYS;
  const dryRun = options?.dryRun ?? false;

  const result: GcResult = {
    deduplicated: 0,
    pruned: 0,
    scopesProcessed: 0,
    namespacesProcessed: 0,
  };

  for (const scope of scopes) {
    let scopeTouched = false;

    // Load existing embeddings from DB once per scope to avoid redundant embed() calls
    const existingEmbeddings = runHistory.getEmbeddingsByScope(scope.type, scope.id);
    const embeddingCache = new Map<string, number[]>();
    for (const row of existingEmbeddings) {
      if (!embeddingCache.has(row.text)) {
        embeddingCache.set(row.text, blobToEmbed(row.embedding, row.embedding_dim));
      }
    }

    for (const ns of ALL_NAMESPACES) {
      const content = await memory.loadScoped(ns, scope);
      if (!content) continue;

      const allLines = content.split('\n');
      const indexedLines = allLines
        .map((text, idx) => ({ text, idx }))
        .filter(l => l.text.trim().length >= MIN_LINE_LENGTH);

      if (indexedLines.length === 0) continue;

      // Track which original indices to remove
      const removeIndices = new Set<number>();

      // --- Dedup pass ---
      // Reuse cached embeddings from DB; only call provider.embed() for uncached lines
      const embeddings = await Promise.all(
        indexedLines.map(l => {
          const cached = embeddingCache.get(l.text);
          if (cached) return Promise.resolve(cached);
          return provider.embed(l.text);
        }),
      );

      // Mark shorter duplicate in each near-duplicate pair
      const dedupRemoved = new Set<number>(); // indices into indexedLines
      for (let i = 0; i < indexedLines.length; i++) {
        if (dedupRemoved.has(i)) continue;
        for (let j = i + 1; j < indexedLines.length; j++) {
          if (dedupRemoved.has(j)) continue;
          const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);
          if (sim > threshold) {
            // Keep the longer line, remove the shorter
            const lineI = indexedLines[i]!;
            const lineJ = indexedLines[j]!;
            if (lineI.text.length >= lineJ.text.length) {
              dedupRemoved.add(j);
              removeIndices.add(lineJ.idx);
            } else {
              dedupRemoved.add(i);
              removeIndices.add(lineI.idx);
              break; // i is removed, no need to compare further
            }
          }
        }
      }
      result.deduplicated += dedupRemoved.size;

      // --- Prune pass ---
      const staleEmbeddings = runHistory.getStaleEmbeddings(scope.type, scope.id, ageDays);
      const staleTexts = new Map<string, string>(); // text → embedding id
      for (const emb of staleEmbeddings) {
        if (emb.namespace === ns) {
          staleTexts.set(emb.text, emb.id);
        }
      }

      const prunedEmbeddingIds: string[] = [];
      for (const entry of indexedLines) {
        if (removeIndices.has(entry.idx)) continue; // already removed by dedup
        const embId = staleTexts.get(entry.text);
        if (embId !== undefined) {
          removeIndices.add(entry.idx);
          prunedEmbeddingIds.push(embId);
        }
      }
      result.pruned += prunedEmbeddingIds.length;

      // --- Write back ---
      if (removeIndices.size > 0 && !dryRun) {
        // Delete stale embeddings from SQLite
        for (const embId of prunedEmbeddingIds) {
          runHistory.deleteEmbedding(embId);
        }

        // Remove lines from flat file via deleteScoped for each removed line.
        // Process in reverse to avoid reloading between deletes (deleteScoped
        // uses String.includes internally — exact full-line match is safe when
        // the line is >=10 chars).
        const linesToRemove = [...removeIndices]
          .sort((a, b) => b - a)
          .map(idx => allLines[idx]!)
          .filter(line => line.length > 0);

        for (const line of linesToRemove) {
          await memory.deleteScoped(ns, line, scope);
        }
      }

      if (removeIndices.size > 0 || staleTexts.size > 0) {
        scopeTouched = true;
      }
      result.namespacesProcessed++;
    }

    if (scopeTouched) {
      result.scopesProcessed++;
    }
  }

  return result;
}

/**
 * Run garbage collection on the Knowledge Graph.
 * Removes superseded memories and orphan entities.
 */
export async function runGraphGc(
  knowledgeLayer: IKnowledgeLayer,
  options?: { dryRun?: boolean | undefined },
): Promise<{ supersededRemoved: number; orphanEntitiesRemoved: number; staleMemoriesRemoved: number }> {
  return knowledgeLayer.gc(options);
}
