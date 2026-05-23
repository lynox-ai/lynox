/**
 * Set-Bench v4 report aggregator — turns a flat `CellRun[]` into a structured
 * `BenchReport` plus a markdown-friendly summary. Per-axis tables surface
 * the headline cost / pass-rate / cache-hit tradeoff AND the pinned-vs-
 * latest drift gap.
 *
 * v4 additions:
 *   - Cache-aware cost columns: cold (no cache discount) vs warm
 *     (cache_read tokens at the published cache-read rate). Mistral cells
 *     report warm == cold (no native cache field).
 *   - cache-hit-rate per cell — input tokens served from cache /
 *     (input + cache_read). Honesty discipline: this is what the page
 *     promises to report when the long-context axis runs.
 *   - p50 / p95 latency per cell — exposes burst-throttle tail behaviour.
 *   - Pareto frontier section per axis — drops dominated cells so the
 *     "best cost-vs-quality tradeoff" answer is one glance away.
 */

import type { BenchReport, CellRun, SetBenchAxis, SetBenchCell } from './types.js';

/**
 * Linear-interpolation percentile (R-7 method, the numpy/pandas default).
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function buildReport(runs: readonly CellRun[], cells: readonly SetBenchCell[]): BenchReport {
  const cellsByLabel = new Map(cells.map((c) => [c.label, c] as const));
  // Group runs by (cellLabel, axis) — every cell × axis combination is its
  // own row (a model that runs ALL 8 axes shows up as 8 distinct rows).
  const grouped = new Map<string, CellRun[]>();
  for (const run of runs) {
    const cell = cellsByLabel.get(run.cellLabel);
    if (!cell) continue;
    const key = `${cell.axis}::${run.cellLabel}`;
    const arr = grouped.get(key) ?? [];
    arr.push(run);
    grouped.set(key, arr);
  }

  const summary: BenchReport['summary'] = [...grouped.entries()].flatMap(([key, cellRuns]) => {
    const [axisStr, label] = key.split('::', 2);
    if (!axisStr || !label) return [];
    const cell = cellsByLabel.get(label);
    if (!cell) return [];
    const passCount = cellRuns.filter((r) => r.pass).length;
    const passRate = cellRuns.length === 0 ? 0 : passCount / cellRuns.length;
    const avgCostColdUsd = cellRuns.reduce((acc, r) => acc + r.costUsdCold, 0) / Math.max(1, cellRuns.length);
    const avgCostWarmUsd = cellRuns.reduce((acc, r) => acc + r.costUsdWarm, 0) / Math.max(1, cellRuns.length);
    const avgCacheReadTokens = cellRuns.reduce((acc, r) => acc + r.cacheReadTokens, 0) / Math.max(1, cellRuns.length);
    const totalIn = cellRuns.reduce((acc, r) => acc + r.tokensIn + r.cacheReadTokens, 0);
    const totalCacheRead = cellRuns.reduce((acc, r) => acc + r.cacheReadTokens, 0);
    const cacheHitRate = totalIn === 0 ? 0 : totalCacheRead / totalIn;
    const avgDurationMs = cellRuns.reduce((acc, r) => acc + r.durationMs, 0) / Math.max(1, cellRuns.length);
    const durations = cellRuns.map((r) => r.durationMs).sort((a, b) => a - b);
    return [{
      axis: axisStr as SetBenchAxis,
      cellLabel: label,
      passRate,
      avgCostColdUsd,
      avgCostWarmUsd,
      avgCacheReadTokens,
      cacheHitRate,
      avgDurationMs,
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      pinned: cell.pinned,
    }];
  });

  return {
    generatedAt: new Date().toISOString(),
    cells: runs,
    summary,
  };
}

const AXIS_DISPLAY: Record<SetBenchAxis, string> = {
  'multi-turn-loop-completion': 'Multi-turn loop completion',
  'sub-agent-spawn-orchestration': 'Sub-agent spawn / orchestration',
  'memory-grounded-reasoning': 'Memory-grounded reasoning',
  'workflow-composition': 'Workflow composition',
  'long-context-with-tools': 'Long-context with tools',
  'tool-chain-with-backtrack': 'Tool-chain with back-track',
  'cron-task-cold-start': 'Cron task / cold-start',
  'real-world-grounded-strategy': 'Real-world grounded strategy',
};

const AXIS_ORDER: readonly SetBenchAxis[] = [
  'multi-turn-loop-completion',
  'sub-agent-spawn-orchestration',
  'memory-grounded-reasoning',
  'workflow-composition',
  'long-context-with-tools',
  'tool-chain-with-backtrack',
  'cron-task-cold-start',
  'real-world-grounded-strategy',
];

export function formatReportMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Set-Bench v4 report — ${report.generatedAt}`);
  lines.push('');
  lines.push('Cost columns: **cold** = no cache discount, **warm** = cache_read tokens billed at the published cache-read rate. Mistral cells expose no native prompt-cache field; warm == cold for those.');
  lines.push('');

  for (const axis of AXIS_ORDER) {
    const axisRows = report.summary.filter((s) => s.axis === axis);
    if (axisRows.length === 0) continue;
    lines.push(`## ${AXIS_DISPLAY[axis]}`);
    lines.push('');
    lines.push('| Cell | Pinned | Pass | Cost (cold) | Cost (warm) | Cache hit | p50 | p95 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const sorted = [...axisRows].sort((a, b) => {
      if (a.passRate !== b.passRate) return b.passRate - a.passRate;
      return a.avgCostColdUsd - b.avgCostColdUsd;
    });
    for (const r of sorted) {
      lines.push(
        `| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | ${(r.passRate * 100).toFixed(0)}% | $${r.avgCostColdUsd.toFixed(5)} | $${r.avgCostWarmUsd.toFixed(5)} | ${(r.cacheHitRate * 100).toFixed(0)}% | ${(r.p50DurationMs / 1000).toFixed(1)}s | ${(r.p95DurationMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');

    const pareto = computeParetoFrontier(axisRows);
    if (pareto.length > 0) {
      lines.push('### Pareto frontier (warm cost vs pass-rate)');
      lines.push('');
      lines.push('Cells where no other cell beats them on BOTH warm cost and pass-rate. Sorted cheapest → most expensive.');
      lines.push('');
      lines.push('| Cell | Pinned | Cost (warm) | Pass-rate |');
      lines.push('|---|---|---|---|');
      for (const r of pareto) {
        lines.push(`| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | $${r.avgCostWarmUsd.toFixed(5)} | ${(r.passRate * 100).toFixed(0)}% |`);
      }
      lines.push('');
    }

    const drift = computeDrift(axisRows);
    if (drift.length > 0) {
      lines.push('### Pinned vs latest drift');
      lines.push('');
      lines.push('| Base model | Pinned pass-rate | Latest pass-rate | Δ |');
      lines.push('|---|---|---|---|');
      for (const d of drift) {
        const delta = d.latestPassRate - d.pinnedPassRate;
        const sign = delta > 0 ? '+' : '';
        lines.push(`| \`${d.baseName}\` | ${(d.pinnedPassRate * 100).toFixed(0)}% | ${(d.latestPassRate * 100).toFixed(0)}% | ${sign}${(delta * 100).toFixed(0)}pp |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

interface DriftRow {
  readonly baseName: string;
  readonly pinnedPassRate: number;
  readonly latestPassRate: number;
}

export function computeParetoFrontier(
  rows: ReadonlyArray<BenchReport['summary'][number]>,
): ReadonlyArray<BenchReport['summary'][number]> {
  const seen = new Set<string>();
  const frontier: Array<BenchReport['summary'][number]> = [];
  for (const a of rows) {
    let dominated = false;
    for (const b of rows) {
      if (a === b) continue;
      const beats = b.avgCostWarmUsd <= a.avgCostWarmUsd && b.passRate >= a.passRate;
      const strict = b.avgCostWarmUsd < a.avgCostWarmUsd || b.passRate > a.passRate;
      if (beats && strict) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    const key = `${a.avgCostWarmUsd}:${a.passRate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frontier.push(a);
  }
  frontier.sort((a, b) => a.avgCostWarmUsd - b.avgCostWarmUsd);
  return frontier;
}

function computeDrift(rows: ReadonlyArray<BenchReport['summary'][number]>): DriftRow[] {
  const byBase = new Map<string, { pinned?: number; latest?: number }>();
  for (const r of rows) {
    const baseName = r.cellLabel.replace(/-(latest|\d{4})$/, '');
    if (baseName === r.cellLabel) continue;
    const entry = byBase.get(baseName) ?? {};
    if (r.pinned) entry.pinned = r.passRate;
    else entry.latest = r.passRate;
    byBase.set(baseName, entry);
  }
  const out: DriftRow[] = [];
  for (const [baseName, e] of byBase.entries()) {
    if (e.pinned === undefined || e.latest === undefined) continue;
    out.push({ baseName, pinnedPassRate: e.pinned, latestPassRate: e.latest });
  }
  out.sort((a, b) => a.baseName.localeCompare(b.baseName));
  return out;
}
