/**
 * Pattern Engine — detects recurring patterns from episodic memory and computes KPIs.
 *
 * Analyzes episode history to find:
 * - Tool sequences that correlate with success/failure
 * - User preferences (consistent choices)
 * - Anti-patterns (approaches that frequently fail)
 *
 * Computes agent performance metrics (success rate, avg duration, cost).
 */
import type { AgentMemoryDb, EpisodeRow, PatternRow } from './agent-memory-db.js';

/** Minimum episodes needed before pattern detection runs. */
const MIN_EPISODES_FOR_DETECTION = 5;

/** Minimum occurrences to consider something a pattern. */
const MIN_PATTERN_EVIDENCE = 3;

/** Failure rate threshold to flag an anti-pattern. */
const ANTI_PATTERN_FAILURE_RATE = 0.5;

export class PatternEngine {
  constructor(private readonly db: AgentMemoryDb) {}

  // ── Pattern Detection ─────────────────────────────────────────

  /** Analyze recent episodes and detect/update patterns. Returns count of new patterns. */
  detectPatterns(): number {
    const episodes = this.db.queryEpisodes({ limit: 200 });
    if (episodes.length < MIN_EPISODES_FOR_DETECTION) return 0;

    let detected = 0;
    detected += this._detectToolSequences(episodes);
    detected += this._detectOutcomePatterns(episodes);
    return detected;
  }

  /**
   * Find tool combinations that appear repeatedly in successful episodes.
   * E.g., "file_read + file_write" appears in 8/10 successful runs → sequence pattern.
   */
  private _detectToolSequences(episodes: EpisodeRow[]): number {
    const successful = episodes.filter(e => e.outcome_signal === 'success');
    if (successful.length < MIN_PATTERN_EVIDENCE) return 0;

    // Count tool-set occurrences (sorted for consistency)
    const comboCounts = new Map<string, number>();
    for (const ep of successful) {
      const tools = JSON.parse(ep.tools_used) as string[];
      if (tools.length < 2) continue;
      const key = [...new Set(tools)].sort().join(' + ');
      comboCounts.set(key, (comboCounts.get(key) ?? 0) + 1);
    }

    let detected = 0;
    for (const [combo, count] of comboCounts) {
      if (count < MIN_PATTERN_EVIDENCE) continue;

      const desc = `Tool combination "${combo}" used in ${count} successful runs`;
      detected += this._upsertPattern('sequence', desc, {
        tools: combo.split(' + '),
        occurrences: count,
        successRate: count / successful.length,
      });
    }

    return detected;
  }

  /**
   * Find tools/approaches with high failure rates → anti-patterns.
   * E.g., runs using only "bash" fail 60% of the time → anti-pattern.
   */
  private _detectOutcomePatterns(episodes: EpisodeRow[]): number {
    // Group by primary tool (first tool used)
    const toolOutcomes = new Map<string, { success: number; total: number }>();

    for (const ep of episodes) {
      const tools = JSON.parse(ep.tools_used) as string[];
      if (tools.length === 0) continue;
      const primaryTool = tools[0]!;
      const entry = toolOutcomes.get(primaryTool) ?? { success: 0, total: 0 };
      entry.total++;
      if (ep.outcome_signal === 'success') entry.success++;
      toolOutcomes.set(primaryTool, entry);
    }

    let detected = 0;
    for (const [tool, stats] of toolOutcomes) {
      if (stats.total < MIN_PATTERN_EVIDENCE) continue;
      const failureRate = 1 - stats.success / stats.total;

      if (failureRate >= ANTI_PATTERN_FAILURE_RATE) {
        const desc = `Tool "${tool}" as primary has ${(failureRate * 100).toFixed(0)}% failure rate (${stats.total - stats.success}/${stats.total})`;
        detected += this._upsertPattern('anti-pattern', desc, {
          tool,
          failureRate,
          totalRuns: stats.total,
        });
      }
    }

    return detected;
  }

  /**
   * Upsert a pattern: if a similar description exists, increment evidence.
   * Returns 1 if new pattern created, 0 if existing updated.
   */
  private _upsertPattern(
    patternType: string,
    description: string,
    metadata: Record<string, unknown>,
  ): number {
    // Check if pattern with same type and similar description already exists
    const existing = this.db.getPatterns({ patternType, activeOnly: true, limit: 100 });
    const match = existing.find(p => p.description === description);

    if (match) {
      this.db.incrementPatternEvidence(match.id);
      return 0;
    }

    this.db.createPattern({ patternType, description, metadata, confidence: 0.5 });
    return 1;
  }

  // ── KPI Computation ───────────────────────────────────────────

  /** Compute and store agent performance metrics from recent episodes. */
  computeKPIs(): void {
    const episodes = this.db.queryEpisodes({ limit: 200 });
    if (episodes.length === 0) return;

    const total = episodes.length;

    // Success rate
    const successes = episodes.filter(e => e.outcome_signal === 'success').length;
    this.db.upsertMetric({
      metricName: 'success_rate',
      value: total > 0 ? successes / total : 0,
      sampleCount: total,
    });

    // Average duration
    const durations = episodes
      .filter((e): e is EpisodeRow & { duration_ms: number } => e.duration_ms !== null)
      .map(e => e.duration_ms);
    if (durations.length > 0) {
      this.db.upsertMetric({
        metricName: 'avg_duration_ms',
        value: durations.reduce((a, b) => a + b, 0) / durations.length,
        sampleCount: durations.length,
      });
    }

    // Total cost
    const costs = episodes
      .filter((e): e is EpisodeRow & { token_cost: number } => e.token_cost !== null)
      .map(e => e.token_cost);
    if (costs.length > 0) {
      this.db.upsertMetric({
        metricName: 'total_cost_usd',
        value: costs.reduce((a, b) => a + b, 0),
        sampleCount: costs.length,
      });
    }

    // Tool usage frequency
    const toolCounts = new Map<string, number>();
    for (const ep of episodes) {
      const tools = JSON.parse(ep.tools_used) as string[];
      for (const tool of tools) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }
    for (const [tool, count] of toolCounts) {
      this.db.upsertMetric({
        metricName: `tool_usage.${tool}`,
        value: count,
        sampleCount: total,
      });
    }

    // Run count
    this.db.upsertMetric({
      metricName: 'total_runs',
      value: total,
      sampleCount: total,
    });
  }
}
