/**
 * Pure statistics + diff helpers for the Agent-Efficiency protocol.
 *
 * No I/O, no network — kept separate from the runner so it can be unit
 * tested in the vitest suite (`tests/agent-efficiency-stats.test.ts`).
 */
import type {
  Baseline,
  CompareRow,
  MetricStat,
  ScenarioResult,
  ScenarioStats,
  TurnRun,
} from './types.js';

/** Mean + min/max + sample stddev of a numeric sample. Empty → all zero. */
export function metricStat(values: readonly number[]): MetricStat {
  if (values.length === 0) {
    return { mean: 0, min: 0, max: 0, stddev: 0 };
  }
  let sum = 0;
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  // Sample (n-1) stddev; 0 for n < 2 (no spread to measure).
  let variance = 0;
  if (values.length > 1) {
    let sq = 0;
    for (const v of values) sq += (v - mean) ** 2;
    variance = sq / (values.length - 1);
  }
  return { mean, min, max, stddev: Math.sqrt(variance) };
}

/** Aggregate the OK repeats of one scenario into `ScenarioStats`. */
export function computeScenarioStats(okRuns: readonly TurnRun[]): ScenarioStats | undefined {
  if (okRuns.length === 0) return undefined;
  return {
    costUsd: metricStat(okRuns.map((r) => r.usage.costUsd)),
    tokensIn: metricStat(okRuns.map((r) => r.usage.tokensIn)),
    tokensOut: metricStat(okRuns.map((r) => r.usage.tokensOut)),
    tokensCacheRead: metricStat(okRuns.map((r) => r.usage.tokensCacheRead)),
    tokensCacheWrite: metricStat(okRuns.map((r) => r.usage.tokensCacheWrite)),
    cacheHitRatio: metricStat(okRuns.map((r) => r.cacheHitRatio)),
    wallMs: metricStat(okRuns.map((r) => r.wallMs)),
  };
}

/** Cache-hit ratio for one turn: read / (read + write); 0 when no cache I/O. */
export function cacheHitRatio(cacheRead: number, cacheWrite: number): number {
  const total = cacheRead + cacheWrite;
  return total > 0 ? cacheRead / total : 0;
}

/**
 * Compute the `--compare` diff between a stored baseline and a fresh run.
 *
 * Per PRD D3 the gate is: pass-rate >= baseline AND cost < baseline.
 * A scenario with no comparable signal on either side is `n/a` (it does
 * not pass and does not fail — it cannot gate).
 */
export function compareBaselines(
  baseline: Baseline,
  current: Baseline,
): CompareRow[] {
  const currentById = new Map<string, ScenarioResult>();
  for (const s of current.scenarios) currentById.set(s.scenarioId, s);

  const rows: CompareRow[] = [];
  for (const base of baseline.scenarios) {
    const cur = currentById.get(base.scenarioId);
    const baselinePassRate = base.totalCount > 0 ? base.okCount / base.totalCount : 0;
    const currentPassRate =
      cur && cur.totalCount > 0 ? cur.okCount / cur.totalCount : 0;

    const baselineCostUsd = base.stats?.costUsd.mean;
    const currentCostUsd = cur?.stats?.costUsd.mean;
    const baselineTokensIn = base.stats?.tokensIn.mean;
    const currentTokensIn = cur?.stats?.tokensIn.mean;

    let costDeltaPct: number | undefined;
    if (baselineCostUsd !== undefined && currentCostUsd !== undefined && baselineCostUsd > 0) {
      costDeltaPct = (currentCostUsd - baselineCostUsd) / baselineCostUsd;
    }
    let tokenDelta: number | undefined;
    if (baselineTokensIn !== undefined && currentTokensIn !== undefined) {
      tokenDelta = currentTokensIn - baselineTokensIn;
    }

    let verdict: CompareRow['verdict'];
    if (!cur || baselineCostUsd === undefined || currentCostUsd === undefined) {
      verdict = 'n/a';
    } else if (currentPassRate >= baselinePassRate && currentCostUsd < baselineCostUsd) {
      verdict = 'pass';
    } else {
      verdict = 'fail';
    }

    const row: CompareRow = {
      scenarioId: base.scenarioId,
      label: base.label,
      baselinePassRate,
      currentPassRate,
      verdict,
    };
    if (baselineCostUsd !== undefined) (row as { baselineCostUsd?: number }).baselineCostUsd = baselineCostUsd;
    if (currentCostUsd !== undefined) (row as { currentCostUsd?: number }).currentCostUsd = currentCostUsd;
    if (costDeltaPct !== undefined) (row as { costDeltaPct?: number }).costDeltaPct = costDeltaPct;
    if (tokenDelta !== undefined) (row as { tokenDelta?: number }).tokenDelta = tokenDelta;
    rows.push(row);
  }
  return rows;
}

/** Overall gate verdict: pass only if no scenario is `fail`. `n/a` is tolerated. */
export function overallVerdict(rows: readonly CompareRow[]): 'pass' | 'fail' {
  return rows.some((r) => r.verdict === 'fail') ? 'fail' : 'pass';
}
