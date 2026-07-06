import type { MemoryNamespace, MemoryScopeRef, ContradictionInfo } from '../types/index.js';
import type { ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';

/**
 * A cosine-recall over active memories — either legacy `AgentMemoryDb.findSimilarMemories`
 * or the engine.db `MemoryGraphStore.findSimilarRecall` (S5b'-a). Parametrizing the
 * detector on the recall SOURCE (rather than binding it to `AgentMemoryDb`) lets the
 * write-path consult the SAME store the S5b read cutover reads from, so a store()'s
 * contradiction decision stays consistent with what recall surfaces. Returns the
 * caller's `ScoredMemoryRow` shape unchanged.
 */
export type MemoryRecall = (
  embedding: number[],
  topK: number,
  threshold: number,
  filters: {
    namespace?: string | undefined;
    scopeTypes?: string[] | undefined;
    scopeIds?: string[] | undefined;
    activeOnly?: boolean | undefined;
  },
) => ScoredMemoryRow[];

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
 * Methods and status are additive, not contradictory.
 */
export async function detectContradictions(
  newText: string,
  namespace: MemoryNamespace,
  scope: MemoryScopeRef,
  recall: MemoryRecall,
  embeddingProvider: EmbeddingProvider,
  reuseEmbedding?: number[] | undefined,
): Promise<ContradictionInfo[]> {
  if (!FACTUAL_NAMESPACES.has(namespace)) return [];

  const embedding = reuseEmbedding ?? await embeddingProvider.embed(newText);

  const similar = recall(
    embedding,
    MAX_CANDIDATES,
    CONTRADICTION_SIMILARITY_THRESHOLD,
    {
      namespace,
      scopeTypes: [scope.type],
      // Filter by scope ID too — without it a memory in one scope (e.g.
      // `context:acme`) can supersede a contradicting memory in a DIFFERENT
      // scope of the same type (`context:beta`), a cross-project data leak. The
      // sibling dedup path in knowledge-layer already scopes this way.
      scopeIds: [scope.id],
      activeOnly: true,
    },
  );

  if (similar.length === 0) return [];

  const results: ContradictionInfo[] = [];

  for (const existing of similar) {
    const isContradiction =
      checkNegation(newText, existing.text) ||
      checkNumberChange(newText, existing.text) ||
      checkStateChange(newText, existing.text);

    if (isContradiction) {
      results.push({
        existingMemoryId: existing.id,
        existingText: existing.text,
        similarity: existing._similarity,
        resolution: 'superseded',
      });
    }
  }

  return results;
}

/**
 * Lightweight heuristic check: does the new text contradict the existing text?
 * Used by KnowledgeLayer to bypass dedup when a dedup candidate contains
 * contradictory signals (number change, negation, state change).
 *
 * No DB/embedding needed — pure text comparison.
 */
export function hasHeuristicContradiction(newText: string, existingText: string): boolean {
  return (
    checkNegation(newText, existingText) ||
    checkNumberChange(newText, existingText) ||
    checkStateChange(newText, existingText)
  );
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
 * Matches "<attribute> <connector> <number>" so a value change under the SAME
 * attribute can be flagged as a contradiction. Module-scoped (mirrors
 * `ALL_NEGATION_PATTERNS` / `STATE_WORDS`) — the `/g` regex is safe to share
 * because `String.matchAll` clones it (no `lastIndex` re-entrancy). Handles the
 * shapes real memories use:
 *   - symbol connectors ':' '=' may abut the attribute ("Projektbudget: …"),
 *     while word connectors (is/sind/beträgt) stay space-delimited;
 *   - the attribute key folds in ONE preceding qualifier token so a shared bare
 *     noun does not collapse distinct facts: "Q1 budget:" ≠ "Q2 budget:", while
 *     "Projektbudget:" (qualifier-less) still equals itself;
 *   - an optional currency/unit token may sit between the connector and the
 *     number ("Budget: CHF 24'000", "budget = $5,000");
 *   - the number tolerates ' ’ , . thousands separators (Swiss "24'000",
 *     EN "24,000", DE "24.000"), normalised to bare digits before compare.
 * (Pre-fix the regex required a space before BOTH the connector and the digit,
 * so "Projektbudget: CHF 24'000" never matched → a budget correction was never
 * seen as a contradiction → an orphaned stale memory. Staging dogfood 2026-07-06.)
 *
 * Deliberate limitation: `toDigits` strips ALL non-digits, so magnitude/decimal
 * notation is not normalised ("100k"≠"100000", "3.5"→"35"). The failure mode is
 * a MISS or a same-value re-supersede (no data loss), never a wrong drop of a
 * distinct fact — acceptable for a coarse heuristic gated by ≥0.80 similarity.
 */
const NUMBER_CONTEXT_RE =
  /((?:[\p{L}\d][\p{L}\d_-]*\s+)?[\p{L}][\p{L}\d_-]*)(?:\s*[:=]|\s+(?:is|sind|beträgt)\b)\s*(?:(?:CHF|EUR|USD|GBP|Fr|Rp)\.?\s*|[$€£]\s*)?(\d[\d.,'’]*\d|\d)/giu;

/**
 * Check if numbers in similar statements have changed.
 * "budget is 5000" vs "budget is 8000" → contradiction.
 */
function checkNumberChange(a: string, b: string): boolean {
  const toDigits = (raw: string): string => raw.replace(/\D/g, '');
  const collect = (text: string): Map<string, string> => {
    const nums = new Map<string, string>();
    for (const match of text.matchAll(NUMBER_CONTEXT_RE)) {
      // Collapse internal whitespace so "Q1  budget" and "Q1 budget" key alike.
      const attr = match[1]?.toLowerCase().replace(/\s+/g, ' ').trim();
      const value = match[2] ? toDigits(match[2]) : '';
      // First occurrence wins so a later restatement in the SAME text can't
      // shadow the attribute we compare against the other text.
      if (attr && value && !nums.has(attr)) nums.set(attr, value);
    }
    return nums;
  };

  const aNumbers = collect(a);
  for (const [attr, value] of collect(b)) {
    const aValue = aNumbers.get(attr);
    if (aValue !== undefined && aValue !== value) return true;
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
