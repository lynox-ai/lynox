/**
 * Set-Bench report aggregator — turns a flat `CellRun[]` into a structured
 * `BenchReport` plus a markdown-friendly summary. Per-axis tables surface
 * the headline claim ("Mistral Small at $0.20/M matches Haiku 4.5 at
 * $1.00/M on orchestration") AND the pinned-vs-latest drift gap.
 *
 * Phase 3 additions:
 *   - p50 / p95 latency per cell — exposes burst-throttle tail behaviour
 *     that the avg alone hides on Mistral cells under RPM pressure.
 *   - Pareto frontier section per axis — drops dominated cells so the
 *     "best cost-vs-quality tradeoff" answer is one glance away.
 */

import type { BenchReport, CellRun, SetBenchAxis, SetBenchCell } from './types.js';

/**
 * Linear-interpolation percentile (R-7 method, the numpy/pandas default).
 * Stable across small n: at n=1 it returns the single value, at n=2 the
 * weighted average. Input MUST be sorted ascending.
 *
 * Exported for direct test coverage so the bench-grade statistic doesn't
 * silently drift if someone swaps in nearest-rank semantics later.
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
  // Group runs by cellLabel — each cell runs the scenario for its own axis.
  const grouped = new Map<string, CellRun[]>();
  for (const run of runs) {
    const arr = grouped.get(run.cellLabel) ?? [];
    arr.push(run);
    grouped.set(run.cellLabel, arr);
  }

  // Orphan-run guard: if a CellRun references a label that's not in `cells`,
  // skip it. This shouldn't happen in normal use (runs are produced from
  // the same cell list passed here), but the silent contract drift would
  // surface as a TypeError on `.axis` access — keep the report robust.
  const summary: BenchReport['summary'] = [...grouped.entries()].flatMap(([label, cellRuns]) => {
    const cell = cellsByLabel.get(label);
    if (!cell) return [];
    const passCount = cellRuns.filter((r) => r.pass).length;
    const passRate = cellRuns.length === 0 ? 0 : passCount / cellRuns.length;
    const avgCostUsd = cellRuns.reduce((acc, r) => acc + r.costUsd, 0) / Math.max(1, cellRuns.length);
    const avgDurationMs = cellRuns.reduce((acc, r) => acc + r.durationMs, 0) / Math.max(1, cellRuns.length);
    const durations = cellRuns.map((r) => r.durationMs).sort((a, b) => a - b);
    return {
      axis: cell.axis,
      cellLabel: label,
      passRate,
      avgCostUsd,
      avgDurationMs,
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      pinned: cell.pinned,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    cells: runs,
    summary,
  };
}

/**
 * Markdown summary keyed off the BenchReport.summary entries. Per axis
 * we emit a sorted table (descending pass-rate, then ascending cost), a
 * Pareto-frontier section listing only non-dominated cells, and a
 * pinned-vs-latest drift row when both flavours of the same base model
 * are present.
 */
export function formatReportMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Set-Bench report — ${report.generatedAt}`);
  lines.push('');

  // Ordering: keep tool-chain + orchestration first (carry-over from
  // Phase 2 so existing report consumers see the familiar header order),
  // then the six Phase 3 axes in haiku-tier → sonnet-tier → opus-tier
  // ascending order.
  const AXES: readonly SetBenchAxis[] = [
    'tool-chain',
    'orchestration',
    'kg-extraction',
    'dag-planning',
    'memory-extraction',
    'long-context',
    'code-review',
    'multi-step-reasoning',
  ];
  for (const axis of AXES) {
    const axisRows = report.summary.filter((s) => s.axis === axis);
    if (axisRows.length === 0) continue;
    lines.push(`## ${axisLabel(axis)}`);
    lines.push('');
    lines.push('| Cell | Pinned | Pass-rate | Avg cost | p50 | p95 |');
    lines.push('|---|---|---|---|---|---|');
    const sorted = [...axisRows].sort((a, b) => {
      if (a.passRate !== b.passRate) return b.passRate - a.passRate;
      return a.avgCostUsd - b.avgCostUsd;
    });
    for (const r of sorted) {
      lines.push(
        `| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | ${(r.passRate * 100).toFixed(0)}% | $${r.avgCostUsd.toFixed(5)} | ${(r.p50DurationMs / 1000).toFixed(1)}s | ${(r.p95DurationMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');

    // Pareto frontier: keep cells where no other cell beats them on BOTH
    // pass-rate (higher) AND cost (lower). These are the "no-regret"
    // tradeoffs — anything off the frontier is dominated by something on
    // it. Sorted by cost ascending for left-to-right cost-quality reading.
    const pareto = computeParetoFrontier(axisRows);
    if (pareto.length > 0) {
      lines.push('### Pareto frontier (cost vs pass-rate)');
      lines.push('');
      lines.push('Cells where no other cell beats them on BOTH cost and pass-rate. Sorted cheapest → most expensive — read left-to-right as "what does an extra dollar of spend buy in pass-rate?".');
      lines.push('');
      lines.push('| Cell | Pinned | Cost | Pass-rate |');
      lines.push('|---|---|---|---|');
      for (const r of pareto) {
        lines.push(`| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | $${r.avgCostUsd.toFixed(5)} | ${(r.passRate * 100).toFixed(0)}% |`);
      }
      lines.push('');
    }

    // Pinned-vs-latest drift: pair entries whose labels match modulo the
    // -2YYMM date suffix vs the -latest suffix.
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

function axisLabel(axis: SetBenchAxis): string {
  switch (axis) {
    case 'tool-chain':
      return 'TOOL_CHAIN axis (sonnet-tier bar: Anthropic Sonnet 4.6)';
    case 'orchestration':
      return 'ORCHESTRATION axis (haiku-tier bar: Anthropic Haiku 4.5)';
    case 'kg-extraction':
      return 'KG_EXTRACTION axis (haiku-tier bar: Anthropic Haiku 4.5)';
    case 'dag-planning':
      return 'DAG_PLANNING axis (haiku-tier bar: Anthropic Haiku 4.5)';
    case 'memory-extraction':
      return 'MEMORY_EXTRACTION axis (haiku-tier bar: Anthropic Haiku 4.5)';
    case 'long-context':
      return 'LONG_CONTEXT axis (sonnet-tier bar: Anthropic Sonnet 4.6)';
    case 'code-review':
      return 'CODE_REVIEW axis (sonnet-tier bar: Anthropic Sonnet 4.6)';
    case 'multi-step-reasoning':
      return 'MULTI_STEP_REASONING axis (opus-tier bar: Anthropic Opus 4 / Sonnet 4.6 + thinking)';
  }
}

interface DriftRow {
  readonly baseName: string;
  readonly pinnedPassRate: number;
  readonly latestPassRate: number;
}

/**
 * Pareto-frontier filter on (cost, pass-rate). A cell `a` is dominated by
 * cell `b` iff b.cost <= a.cost AND b.passRate >= a.passRate AND at least
 * one of those is strict. The frontier is the non-dominated set, sorted
 * cheapest → most expensive. Ties (same cost AND same pass-rate) keep
 * the first occurrence to avoid duplicate rows in the rendered table.
 *
 * Exported so the test suite can pin the dominance semantics — it's
 * subtle enough that a reviewer could quietly flip strict/non-strict
 * and only notice when an HN reader complains the chart looks off.
 */
export function computeParetoFrontier(
  rows: ReadonlyArray<BenchReport['summary'][number]>,
): ReadonlyArray<BenchReport['summary'][number]> {
  const seen = new Set<string>();
  const frontier: Array<BenchReport['summary'][number]> = [];
  for (const a of rows) {
    let dominated = false;
    for (const b of rows) {
      if (a === b) continue;
      const beats = b.avgCostUsd <= a.avgCostUsd && b.passRate >= a.passRate;
      const strict = b.avgCostUsd < a.avgCostUsd || b.passRate > a.passRate;
      if (beats && strict) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    // Dedupe exact-tie cells (rare, but happens when two cells produce
    // the same n=5 trace). Key on the (cost, passRate) pair at full
    // numeric precision — Number.toString() round-trips losslessly for
    // JS numbers, so $1e-9 and $1.0000001e-9 won't collapse even though
    // both formatted-to-8-decimals would.
    const key = `${a.avgCostUsd}:${a.passRate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frontier.push(a);
  }
  frontier.sort((a, b) => a.avgCostUsd - b.avgCostUsd);
  return frontier;
}

function computeDrift(rows: ReadonlyArray<BenchReport['summary'][number]>): DriftRow[] {
  const byBase = new Map<string, { pinned?: number; latest?: number }>();
  for (const r of rows) {
    // Strip the trailing -YYMM dated snapshot OR -latest alias to recover
    // the base name. mistral-large-2512 -> mistral-large; mistral-large-latest
    // -> mistral-large.
    const baseName = r.cellLabel.replace(/-(latest|\d{4})$/, '');
    if (baseName === r.cellLabel) continue; // anthropic baseline etc. — no drift pair
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
