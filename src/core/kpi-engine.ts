/**
 * KPI Engine — computes agent performance metrics from run history.
 *
 * Reads per-run data from RunHistory (runs + tool_calls).
 * Writes metrics to AgentMemoryDb.
 *
 * Computes:
 * - Agent performance metrics (success rate, avg duration, cost, tool usage)
 */
import type { AgentMemoryDb } from './agent-memory-db.js';
import type { RunHistory } from './run-history.js';

export class KpiEngine {
  constructor(
    private readonly runHistory: RunHistory,
    private readonly db: AgentMemoryDb,
  ) {}

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
