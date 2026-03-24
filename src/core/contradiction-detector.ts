import type { MemoryNamespace, MemoryScopeRef, ContradictionInfo } from '../types/index.js';
import type { KuzuGraph } from './knowledge-graph.js';
import type { EmbeddingProvider } from './embedding.js';

/** Namespaces where contradiction detection applies (factual content). */
const FACTUAL_NAMESPACES: ReadonlySet<MemoryNamespace> = new Set(['knowledge', 'learnings']);

/** Minimum similarity threshold to consider two memories as potentially contradictory. */
const CONTRADICTION_SIMILARITY_THRESHOLD = 0.80;

/** Maximum candidates to check for contradictions. */
const MAX_CANDIDATES = 10;

/**
 * Detects contradictions between a new memory and existing active memories.
 *
 * Strategy:
 * 1. Find semantically similar existing memories (cosine > 0.80)
 * 2. Apply heuristic checks (negation, number change, state change)
 * 3. Mark contradicted memories as superseded
 *
 * Only applies to factual namespaces (knowledge, learnings).
 * Methods and project-state are additive, not contradictory.
 */
export async function detectContradictions(
  newText: string,
  namespace: MemoryNamespace,
  scope: MemoryScopeRef,
  graph: KuzuGraph,
  embeddingProvider: EmbeddingProvider,
): Promise<ContradictionInfo[]> {
  // Only check factual namespaces
  if (!FACTUAL_NAMESPACES.has(namespace)) return [];

  // Embed the new text
  const embedding = await embeddingProvider.embed(newText);

  // Find similar existing memories
  const similar = await graph.findSimilarMemories(
    embedding,
    MAX_CANDIDATES,
    CONTRADICTION_SIMILARITY_THRESHOLD,
    {
      namespace,
      scopeTypes: [scope.type],
      activeOnly: true,
    },
  );

  if (similar.length === 0) return [];

  const results: ContradictionInfo[] = [];

  for (const existing of similar) {
    const existingText = existing['m.text'] as string;
    const existingId = existing['m.id'] as string;
    const similarity = existing._similarity;

    const isContradiction =
      checkNegation(newText, existingText) ||
      checkNumberChange(newText, existingText) ||
      checkStateChange(newText, existingText);

    if (isContradiction) {
      results.push({
        existingMemoryId: existingId,
        existingText,
        similarity,
        resolution: 'superseded',
      });
    }
  }

  return results;
}

// === Heuristic Contradiction Checks ===

/** Negation patterns in multiple languages. */
const NEGATION_PATTERNS_EN = [
  "doesn't", "does not", "don't", "do not",
  "no longer", "not anymore", "never", "isn't", "is not",
  "won't", "will not", "can't", "cannot", "shouldn't",
];

const NEGATION_PATTERNS_DE = [
  'nicht mehr', 'kein', 'keine', 'keinen', 'nie', 'niemals',
  'nicht', 'unmöglich', 'ohne',
];

const ALL_NEGATION_PATTERNS = [...NEGATION_PATTERNS_EN, ...NEGATION_PATTERNS_DE];

/**
 * Check if one text negates the other.
 * "X uses Y" vs "X doesn't use Y" → contradiction.
 */
function checkNegation(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  const aHasNeg = ALL_NEGATION_PATTERNS.some(p => aLower.includes(p));
  const bHasNeg = ALL_NEGATION_PATTERNS.some(p => bLower.includes(p));

  // One negated, one not → potential contradiction
  // But only if both are about the same topic (high similarity already ensured by caller)
  return aHasNeg !== bHasNeg;
}

/**
 * Check if numbers in similar statements have changed.
 * "budget is 5000" vs "budget is 8000" → contradiction.
 */
function checkNumberChange(a: string, b: string): boolean {
  // Extract numbers with context (word before number)
  const numberContextRe = /(\w+)\s+(?:is|sind|beträgt|=|:)\s*(\d[\d,.]*)/gi;

  const aNumbers = new Map<string, string>();
  for (const match of a.matchAll(numberContextRe)) {
    if (match[1] && match[2]) {
      aNumbers.set(match[1].toLowerCase(), match[2].replace(/,/g, ''));
    }
  }

  for (const match of b.matchAll(numberContextRe)) {
    const context = match[1]?.toLowerCase();
    const value = match[2]?.replace(/,/g, '');
    if (context && value && aNumbers.has(context)) {
      const aValue = aNumbers.get(context);
      if (aValue !== value) return true;
    }
  }

  return false;
}

/** State transition words that indicate a change. */
const STATE_WORDS: ReadonlyMap<string, string[]> = new Map([
  ['active', ['inactive', 'completed', 'done', 'closed', 'archived', 'cancelled']],
  ['open', ['closed', 'resolved', 'done', 'completed']],
  ['pending', ['approved', 'rejected', 'done', 'cancelled']],
  ['enabled', ['disabled']],
  ['true', ['false']],
  ['yes', ['no']],
  // German
  ['aktiv', ['inaktiv', 'abgeschlossen', 'fertig', 'geschlossen']],
  ['offen', ['geschlossen', 'erledigt', 'fertig']],
]);

/**
 * Check if state descriptions have changed.
 * "project is active" vs "project is completed" → contradiction.
 */
function checkStateChange(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  for (const [state, opposites] of STATE_WORDS) {
    const aHasState = aLower.includes(state);
    const bHasOpposite = opposites.some(o => bLower.includes(o));
    if (aHasState && bHasOpposite) return true;

    const bHasState = bLower.includes(state);
    const aHasOpposite = opposites.some(o => aLower.includes(o));
    if (bHasState && aHasOpposite) return true;
  }

  return false;
}
