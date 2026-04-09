/**
 * Pattern Engine — detects recurring patterns from run history and computes KPIs.
 *
 * Reads per-run data from RunHistory (runs + tool_calls).
 * Writes detected patterns and metrics to AgentMemoryDb.
 *
 * Analyzes:
 * - Tool sequences that correlate with success/failure (per-run)
 * - Anti-patterns (tools with high failure rates)
 * - Agent performance metrics (success rate, avg duration, cost, tool usage)
 */
import type { AgentMemoryDb } from './agent-memory-db.js';
import type { RunHistory, AnalysisRun } from './run-history.js';

/** Minimum runs needed before pattern detection runs. */
const MIN_RUNS_FOR_DETECTION = 5;

/** Minimum occurrences to consider something a pattern. */
const MIN_PATTERN_EVIDENCE = 3;

/** Failure rate threshold to flag an anti-pattern. */
const ANTI_PATTERN_FAILURE_RATE = 0.5;

export class PatternEngine {
  constructor(
    private readonly runHistory: RunHistory,
    private readonly db: AgentMemoryDb,
  ) {}

  // ── Pattern Detection ─────────────────────────────────────────

  /** Analyze recent runs and detect/update patterns. Returns count of new patterns. */
  detectPatterns(): number {
    const runs = this.runHistory.getRunsForAnalysis(200);
    if (runs.length < MIN_RUNS_FOR_DETECTION) return 0;

    let detected = 0;
    detected += this._detectToolSequences(runs);
    detected += this._detectOutcomePatterns(runs);
    return detected;
  }

  /**
   * Find tool combinations that appear repeatedly in successful runs.
   */
  private _detectToolSequences(runs: AnalysisRun[]): number {
    const successful = runs.filter(r => r.status === 'completed');
    if (successful.length < MIN_PATTERN_EVIDENCE) return 0;

    const comboCounts = new Map<string, number>();
    for (const run of successful) {
      if (run.toolNames.length < 2) continue;
      const key = [...new Set(run.toolNames)].sort().join(' + ');
      comboCounts.set(key, (comboCounts.get(key) ?? 0) + 1);
    }

    let detected = 0;
    for (const [combo, count] of comboCounts) {
      if (count < MIN_PATTERN_EVIDENCE) continue;
      const toolList = combo.split(' + ');
      const desc = `Tool combination "${combo}" correlates with success`;
      detected += this._upsertPattern('sequence', desc, toolList, {
        tools: toolList,
        occurrences: count,
        successRate: count / successful.length,
      });
    }

    return detected;
  }

  /**
   * Find tools/approaches with high failure rates.
   */
  private _detectOutcomePatterns(runs: AnalysisRun[]): number {
    const toolOutcomes = new Map<string, { success: number; total: number }>();

    for (const run of runs) {
      if (run.toolNames.length === 0) continue;
      const primaryTool = run.toolNames[0]!;
      const entry = toolOutcomes.get(primaryTool) ?? { success: 0, total: 0 };
      entry.total++;
      if (run.status === 'completed') entry.success++;
      toolOutcomes.set(primaryTool, entry);
    }

    let detected = 0;
    for (const [tool, stats] of toolOutcomes) {
      if (stats.total < MIN_PATTERN_EVIDENCE) continue;
      const failureRate = 1 - stats.success / stats.total;

      if (failureRate >= ANTI_PATTERN_FAILURE_RATE) {
        const desc = `Primary tool "${tool}" has high failure rate`;
        detected += this._upsertPattern('anti-pattern', desc, [tool], {
          tool,
          failureRate,
          totalRuns: stats.total,
        });
      }
    }

    return detected;
  }

  /**
   * Upsert a pattern: match by type + key tools to prevent duplicates.
   */
  private _upsertPattern(
    patternType: string,
    description: string,
    keyTools: string[],
    metadata: Record<string, unknown>,
  ): number {
    const existing = this.db.getPatterns({ patternType, activeOnly: true, limit: 200 });
    const sortedKey = [...keyTools].sort().join(',');

    const match = existing.find(p => {
      try {
        const m = JSON.parse(p.metadata) as Record<string, unknown>;
        const mTools = Array.isArray(m['tools']) ? (m['tools'] as string[]).sort().join(',')
          : typeof m['tool'] === 'string' ? m['tool'] : '';
        return mTools === sortedKey;
      } catch {
        return false;
      }
    });

    if (match) {
      this.db.incrementPatternEvidence(match.id);
      return 0;
    }

    this.db.createPattern({ patternType, description, metadata, confidence: 0.5 });
    return 1;
  }

  // ── KPI Computation ───────────────────────────────────────────

  /** Compute and store agent performance metrics from recent runs. */
  computeKPIs(): void {
    const runs = this.runHistory.getRunsForAnalysis(200);
    if (runs.length === 0) return;

    const total = runs.length;

    // Success rate
    const successes = runs.filter(r => r.status === 'completed').length;
    this.db.upsertMetric({
      metricName: 'success_rate',
      value: total > 0 ? successes / total : 0,
      sampleCount: total,
    });

    // Average duration
    const durations = runs.filter(r => r.durationMs > 0).map(r => r.durationMs);
    if (durations.length > 0) {
      this.db.upsertMetric({
        metricName: 'avg_duration_ms',
        value: durations.reduce((a, b) => a + b, 0) / durations.length,
        sampleCount: durations.length,
      });
    }

    // Total cost
    const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
    if (totalCost > 0) {
      this.db.upsertMetric({
        metricName: 'total_cost_usd',
        value: totalCost,
        sampleCount: total,
      });
    }

    // Tool usage frequency
    const toolCounts = new Map<string, number>();
    for (const run of runs) {
      for (const tool of run.toolNames) {
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

    // Threads: avg runs per thread
    const sessionCounts = new Map<string, number>();
    for (const run of runs) {
      if (run.sessionId) {
        sessionCounts.set(run.sessionId, (sessionCounts.get(run.sessionId) ?? 0) + 1);
      }
    }
    if (sessionCounts.size > 0) {
      this.db.upsertMetric({
        metricName: 'avg_runs_per_thread',
        value: total / sessionCounts.size,
        sampleCount: sessionCounts.size,
      });
    }
  }
}
