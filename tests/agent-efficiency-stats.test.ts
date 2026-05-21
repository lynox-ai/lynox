/**
 * Unit coverage for the Agent-Efficiency protocol's pure stats + diff
 * helpers (`scripts/agent-efficiency/stats.ts`).
 *
 * These run in the normal vitest suite — no network, no engine. They
 * lock in the maths the `--compare` D3 gate (PRD-AGENT-EFFICIENCY §6,
 * D3: "pass-rate ≥ baseline AND cost < baseline") depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  cacheHitRatio,
  compareBaselines,
  computeScenarioStats,
  metricStat,
  overallVerdict,
} from '../scripts/agent-efficiency/stats.js';
import type { Baseline, ScenarioResult, TurnRun } from '../scripts/agent-efficiency/types.js';

function turn(over: Partial<TurnRun> & { costUsd?: number }): TurnRun {
  const costUsd = over.costUsd ?? 0;
  return {
    scenarioId: over.scenarioId ?? 's',
    iteration: over.iteration ?? 1,
    ok: over.ok ?? true,
    usage: over.usage ?? {
      tokensIn: 1000,
      tokensOut: 100,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costUsd,
    },
    cacheHitRatio: over.cacheHitRatio ?? 0,
    wallMs: over.wallMs ?? 1000,
    finalText: over.finalText ?? 'ok',
  };
}

function scenarioResult(
  id: string,
  okRuns: TurnRun[],
  totalCount: number,
): ScenarioResult {
  const stats = computeScenarioStats(okRuns);
  const base: ScenarioResult = {
    scenarioId: id,
    label: id,
    evidenceRow: 'row',
    qualityRubric: 'rubric',
    runs: okRuns,
    okCount: okRuns.length,
    totalCount,
  };
  if (stats) (base as { stats?: typeof stats }).stats = stats;
  return base;
}

function baseline(scenarios: ScenarioResult[]): Baseline {
  return {
    capturedAt: new Date().toISOString(),
    target: 'https://engine.example',
    buildSha: 'deadbeef',
    version: '1.6.0',
    iterations: 3,
    totalMeanCostUsd: scenarios.reduce((s, x) => s + (x.stats?.costUsd.mean ?? 0), 0),
    scenarios,
  };
}

describe('metricStat', () => {
  it('returns all-zero for an empty sample', () => {
    expect(metricStat([])).toEqual({ mean: 0, min: 0, max: 0, stddev: 0 });
  });

  it('computes mean / min / max and zero stddev for n=1', () => {
    expect(metricStat([4])).toEqual({ mean: 4, min: 4, max: 4, stddev: 0 });
  });

  it('computes sample (n-1) stddev', () => {
    // [2,4,4,4,5,5,7,9] — classic sample with sample stddev ≈ 2.138.
    const s = metricStat([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.stddev).toBeCloseTo(2.13809, 4);
  });
});

describe('cacheHitRatio', () => {
  it('is 0 when there is no cache I/O', () => {
    expect(cacheHitRatio(0, 0)).toBe(0);
  });

  it('is 1 on a fully warm cache', () => {
    expect(cacheHitRatio(1000, 0)).toBe(1);
  });

  it('is the read fraction of total cache traffic', () => {
    expect(cacheHitRatio(750, 250)).toBe(0.75);
  });
});

describe('computeScenarioStats', () => {
  it('is undefined when there are no OK runs', () => {
    expect(computeScenarioStats([])).toBeUndefined();
  });

  it('aggregates cost across OK runs', () => {
    const stats = computeScenarioStats([turn({ costUsd: 0.1 }), turn({ costUsd: 0.3 })]);
    expect(stats?.costUsd.mean).toBeCloseTo(0.2, 6);
    expect(stats?.costUsd.min).toBeCloseTo(0.1, 6);
    expect(stats?.costUsd.max).toBeCloseTo(0.3, 6);
  });
});

describe('compareBaselines — D3 gate', () => {
  it('passes when cost drops and pass-rate holds', () => {
    const base = baseline([scenarioResult('a', [turn({ costUsd: 0.2 })], 1)]);
    const cur = baseline([scenarioResult('a', [turn({ costUsd: 0.1 })], 1)]);
    const rows = compareBaselines(base, cur);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('pass');
    expect(rows[0]!.costDeltaPct).toBeCloseTo(-0.5, 6);
    expect(overallVerdict(rows)).toBe('pass');
  });

  it('fails when cost rises even if pass-rate holds', () => {
    const base = baseline([scenarioResult('a', [turn({ costUsd: 0.1 })], 1)]);
    const cur = baseline([scenarioResult('a', [turn({ costUsd: 0.2 })], 1)]);
    const rows = compareBaselines(base, cur);
    expect(rows[0]!.verdict).toBe('fail');
    expect(rows[0]!.costDeltaPct).toBeCloseTo(1.0, 6);
    expect(overallVerdict(rows)).toBe('fail');
  });

  it('fails when pass-rate regresses even if cost drops', () => {
    // baseline 2/2 OK; current 1/2 OK → pass-rate regressed.
    const base = baseline([
      scenarioResult('a', [turn({ costUsd: 0.2 }), turn({ costUsd: 0.2 })], 2),
    ]);
    const cur = baseline([scenarioResult('a', [turn({ costUsd: 0.05 })], 2)]);
    const rows = compareBaselines(base, cur);
    expect(rows[0]!.currentPassRate).toBe(0.5);
    expect(rows[0]!.baselinePassRate).toBe(1);
    expect(rows[0]!.verdict).toBe('fail');
  });

  it('marks a scenario n/a when one side has no signal', () => {
    const base = baseline([scenarioResult('a', [], 3)]); // no OK runs
    const cur = baseline([scenarioResult('a', [turn({ costUsd: 0.1 })], 3)]);
    const rows = compareBaselines(base, cur);
    expect(rows[0]!.verdict).toBe('n/a');
    // n/a does not fail the overall gate.
    expect(overallVerdict(rows)).toBe('pass');
  });

  it('marks a scenario n/a when it is missing from the current run', () => {
    const base = baseline([scenarioResult('a', [turn({ costUsd: 0.1 })], 1)]);
    const cur = baseline([]); // scenario 'a' absent
    const rows = compareBaselines(base, cur);
    expect(rows[0]!.verdict).toBe('n/a');
    expect(rows[0]!.currentPassRate).toBe(0);
  });

  it('reports token delta on tokensIn means', () => {
    const mk = (tokensIn: number): TurnRun =>
      turn({ usage: { tokensIn, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0.1 } });
    const base = baseline([scenarioResult('a', [mk(100_000)], 1)]);
    const cur = baseline([scenarioResult('a', [mk(40_000)], 1)]);
    const rows = compareBaselines(base, cur);
    expect(rows[0]!.tokenDelta).toBe(-60_000);
  });

  it('overallVerdict fails if any scenario fails', () => {
    const base = baseline([
      scenarioResult('a', [turn({ costUsd: 0.2 })], 1),
      scenarioResult('b', [turn({ costUsd: 0.1 })], 1),
    ]);
    const cur = baseline([
      scenarioResult('a', [turn({ costUsd: 0.1 })], 1), // pass
      scenarioResult('b', [turn({ costUsd: 0.3 })], 1), // fail
    ]);
    const rows = compareBaselines(base, cur);
    expect(overallVerdict(rows)).toBe('fail');
  });
});
