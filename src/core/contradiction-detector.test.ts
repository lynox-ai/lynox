import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectContradictions, hasHeuristicContradiction, type MemoryRecall } from './contradiction-detector.js';
import type { ScoredMemoryRow } from './agent-memory-db.js';
import type { EmbeddingProvider } from './embedding.js';

// Mock recall that returns configurable similar memories. detectContradictions is
// parametrized on the recall SOURCE (S5b'-a) — legacy AgentMemoryDb.findSimilarMemories
// or engine.db MemoryGraphStore.findSimilarRecall — so the test injects the recall fn
// directly instead of a whole db.
function createMockRecall(similarMemories: ScoredMemoryRow[]): MemoryRecall & { mock: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockReturnValue(similarMemories);
  return Object.assign(((...args: Parameters<MemoryRecall>) => fn(...args)) as MemoryRecall, { mock: fn });
}

function mockMemory(id: string, text: string, similarity: number): ScoredMemoryRow {
  return {
    id, text, namespace: 'knowledge', scope_type: 'context', scope_id: 'test',
    source_run_id: null, source_episode_id: null, provider: 'test',
    embedding: null, confidence: 0.75, is_active: 1, superseded_by: null,
    retrieval_count: 0, confirmation_count: 0, last_retrieved_at: null,
    created_at: '', updated_at: '', source_type: 'agent_inferred', source_tool_name: null,
    _similarity: similarity,
  };
}

function createMockProvider(): EmbeddingProvider {
  return {
    name: 'test',
    dimensions: 384,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
}

describe('detectContradictions', () => {
  let mockProvider: EmbeddingProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  it('skips non-factual namespaces', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'Use technique X', 'methods', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
    expect(recall.mock).not.toHaveBeenCalled();
  });

  it('skips status namespace', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'Project is active', 'status', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty when no similar memories found', async () => {
    const recall = createMockRecall([]);
    const result = await detectContradictions(
      'PostgreSQL is required', 'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('detects negation contradiction (English)', async () => {
    const recall = createMockRecall([mockMemory('old-1', 'The project uses PostgreSQL.', 0.92)]);
    const result = await detectContradictions(
      "The project doesn't use PostgreSQL anymore.",
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
    expect(result[0]!.existingMemoryId).toBe('old-1');
  });

  it('detects negation contradiction (German)', async () => {
    const recall = createMockRecall([mockMemory('old-2', 'Das Projekt nutzt PostgreSQL.', 0.90)]);
    const result = await detectContradictions(
      'Das Projekt nutzt nicht mehr PostgreSQL.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('detects number change', async () => {
    const recall = createMockRecall([mockMemory('old-3', 'Budget is 5000 per month.', 0.88)]);
    const result = await detectContradictions(
      'Budget is 8000 per month.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.existingMemoryId).toBe('old-3');
  });

  it('detects state change', async () => {
    const recall = createMockRecall([mockMemory('old-4', 'The project is active.', 0.91)]);
    const result = await detectContradictions(
      'The project is completed.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.resolution).toBe('superseded');
  });

  // Regression: a currency-prefixed, apostrophe-grouped budget correction with a
  // colon connector ("Projektbudget: CHF 24'000" → "CHF 30'000") was never seen
  // as a contradiction, so the corrected value stored as an ORPHANED active memory
  // beside the stale one (staging dogfood 2026-07-06). checkNumberChange now skips
  // the currency token + tolerates the Swiss apostrophe separator.
  it('detects a CHF budget correction (currency token + apostrophe + colon)', async () => {
    const recall = createMockRecall([mockMemory(
      'old-chf', "Meridian AG – Projektbudget: CHF 24'000 (bestätigt). Deadline: 15. September 2027.", 0.97,
    )]);
    const result = await detectContradictions(
      "Meridian AG – Projektbudget: CHF 30'000. Deadline: 15. September 2027.",
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.existingMemoryId).toBe('old-chf');
    expect(result[0]!.resolution).toBe('superseded');
  });

  it('does not flag similar non-contradictory memories', async () => {
    const recall = createMockRecall([mockMemory('old-5', 'The project uses PostgreSQL 16.', 0.95)]);
    const result = await detectContradictions(
      'The project uses PostgreSQL 16 for JSONB queries.',
      'knowledge', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(0);
  });

  it('works with learnings namespace', async () => {
    const recall = createMockRecall([mockMemory('old-6', 'Mocking the database is fine for tests.', 0.85)]);
    const result = await detectContradictions(
      "Don't mock the database in tests.",
      'learnings', { type: 'context', id: 'test' }, recall, mockProvider,
    );
    expect(result).toHaveLength(1);
  });

  it('scopes the similarity query by scope ID so a memory cannot supersede across projects', async () => {
    const recall = createMockRecall([]);
    await detectContradictions(
      'PostgreSQL is required', 'knowledge', { type: 'context', id: 'acme' }, recall, mockProvider,
    );
    // Without scopeIds a `context:acme` memory could supersede a contradicting
    // `context:beta` memory of the same type (cross-project data leak).
    expect(recall.mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ scopeIds: ['acme'] }),
    );
  });
});

describe('hasHeuristicContradiction — number-change robustness', () => {
  it('flags a plain "attr is N" value change (baseline)', () => {
    expect(hasHeuristicContradiction('Budget is 8000.', 'Budget is 5000.')).toBe(true);
  });

  it('flags a colon-abutting value change ("Budget: 8000")', () => {
    expect(hasHeuristicContradiction('Budget: 8000', 'Budget: 5000')).toBe(true);
  });

  it('flags a currency-prefixed value change ("Budget: CHF 30000")', () => {
    expect(hasHeuristicContradiction('Budget: CHF 30000', 'Budget: CHF 24000')).toBe(true);
  });

  it('flags a Swiss-apostrophe-grouped currency change (straight + curly ’)', () => {
    // straight ASCII apostrophe (U+0027)
    expect(hasHeuristicContradiction("Projektbudget: CHF 30'000", "Projektbudget: CHF 24'000 (bestätigt)")).toBe(true);
    // curly apostrophe (U+2019) — what an autoformatted memory actually stores
    expect(hasHeuristicContradiction('Projektbudget: CHF 30’000', 'Projektbudget: CHF 24’000')).toBe(true);
  });

  it('flags a currency-AFTER-number change ("24000 CHF")', () => {
    expect(hasHeuristicContradiction('Budget: 30000 CHF', 'Budget: 24000 CHF')).toBe(true);
  });

  it('flags a "sind" connector value change', () => {
    expect(hasHeuristicContradiction('Mitarbeiter sind 12', 'Mitarbeiter sind 8')).toBe(true);
  });

  it('flags an EN comma-grouped $ change ("$ 5,000" → "$ 8,000")', () => {
    expect(hasHeuristicContradiction('budget = $8,000', 'budget = $5,000')).toBe(true);
  });

  it('flags a "beträgt <currency> <apostrophe>" change', () => {
    expect(hasHeuristicContradiction("Das Budget beträgt CHF 35'000.", "Das Budget beträgt CHF 30'000.")).toBe(true);
  });

  it('does NOT flag the same value written with a different separator', () => {
    // 24'000 and 24,000 both normalise to 24000 — no contradiction.
    expect(hasHeuristicContradiction("Budget: CHF 24'000", 'Budget: CHF 24,000')).toBe(false);
  });

  it('does NOT flag numbers under DIFFERENT attributes (false-positive guard)', () => {
    expect(hasHeuristicContradiction('Budget: CHF 30000', 'Team: 30 people')).toBe(false);
    expect(hasHeuristicContradiction('Team: 5 people', 'Budget: CHF 5000')).toBe(false);
  });

  it('does NOT collapse qualified attributes that share a bare noun', () => {
    // "Q1 budget" and "Q2 budget" are DISTINCT facts — the qualifier folds into
    // the key so the older is not wrongly superseded (staging-review 2026-07-06).
    expect(hasHeuristicContradiction('Q1 budget: CHF 100000', 'Q2 budget: CHF 150000')).toBe(false);
    expect(hasHeuristicContradiction('Marketing budget: 5000', 'Sales budget: 8000')).toBe(false);
    // …but the SAME qualified attribute with a changed value still flags.
    expect(hasHeuristicContradiction('Q1 budget: CHF 150000', 'Q1 budget: CHF 100000')).toBe(true);
  });

  it('flags only the changed attribute in a multi-attribute string', () => {
    // Team unchanged (8), Budget changed (5000→9000) → still a contradiction.
    expect(hasHeuristicContradiction('Budget: 9000, Team: 8', 'Budget: 5000, Team: 8')).toBe(true);
    // Both attributes unchanged → no contradiction.
    expect(hasHeuristicContradiction('Budget: 5000, Team: 8', 'Team: 8, Budget: 5000')).toBe(false);
  });

  it('does NOT flag an unchanged budget restatement', () => {
    expect(hasHeuristicContradiction("Projektbudget: CHF 24'000 (final)", "Projektbudget: CHF 24'000")).toBe(false);
  });

  it('documents the deliberate magnitude/decimal limitation (digit-strip)', () => {
    // "100k" and "100000" strip to different digit strings → treated as a change
    // (a same-value re-supersede: no data loss). This pins the intended behavior.
    expect(hasHeuristicContradiction('Budget: 100k', 'Budget: 100000')).toBe(true);
    // "3.5" and "35" both strip to "35" → NOT flagged (a miss, not a false drop).
    expect(hasHeuristicContradiction('Rate: 3.5', 'Rate: 35')).toBe(false);
  });
});
