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

import { ALL_AXES } from './types.js';
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
  // Index cells by (axis, label) — NOT by label alone, because the v4
  // matrix uses ONE label per model spread across 8 axes, so a label-only
  // Map collapses 64 cells to 8 entries and every group misattributes
  // the axis. Use a string sentinel that can never appear in a label.
  const SEP = '\x1f';
  // Explicit <string, …> key type: the composite `${axis}${SEP}${label}` key
  // is rebuilt as a plain string in the grouping loop below, so a template-
  // literal-typed Map key would reject the lookup (latent pre-2026-05-29
  // type error, harmless at runtime, surfaced once the harness is tsc-checked).
  const cellsByKey = new Map<string, SetBenchCell>(
    cells.map((c) => [`${c.axis}${SEP}${c.label}`, c] as const),
  );

  const grouped = new Map<string, CellRun[]>();
  for (const run of runs) {
    const key = `${run.axis}${SEP}${run.cellLabel}`;
    const arr = grouped.get(key) ?? [];
    arr.push(run);
    grouped.set(key, arr);
  }

  const summary: BenchReport['summary'] = [...grouped.entries()].flatMap(([key, cellRuns]) => {
    const cell = cellsByKey.get(key);
    if (!cell) return [];
    const label = cell.label;
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
    // Graded quality: average only over runs the judge actually scored. A
    // cell with 0 scored runs reports undefined (not 0) so the report can
    // render "—" instead of a misleading floor.
    const scored = cellRuns.filter((r): r is CellRun & { qualityScore: number } =>
      typeof r.qualityScore === 'number');
    const avgQualityScore = scored.length === 0
      ? undefined
      : scored.reduce((acc, r) => acc + r.qualityScore, 0) / scored.length;
    // Per-judge mean for this cell — the spread between judges is the
    // cross-family bias signal surfaced in the bias section below.
    const judgeIds = new Set<string>();
    for (const r of cellRuns) {
      if (r.qualityByJudge) for (const id of Object.keys(r.qualityByJudge)) judgeIds.add(id);
    }
    const qualityByJudge: Record<string, number> = {};
    for (const id of judgeIds) {
      const vals = cellRuns
        .map((r) => r.qualityByJudge?.[id])
        .filter((v): v is number => typeof v === 'number');
      if (vals.length > 0) qualityByJudge[id] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return [{
      axis: cell.axis,
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
      ...(avgQualityScore !== undefined ? { avgQualityScore } : {}),
      qualityScoredRuns: scored.length,
      ...(Object.keys(qualityByJudge).length > 0 ? { qualityByJudge } : {}),
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
  'hard-deductive-reasoning': 'Hard deductive reasoning (closed — CoT-equalised, ceilings)',
  'multi-hop-quant-chain': 'Multi-hop quant chain (closed — CoT-equalised, ceilings)',
  'deep-strategy-tradeoff': 'Deep strategy trade-off (judge-scored)',
  'deep-ambiguous-design': 'Deep ambiguous design (judge-scored)',
};

const AXIS_ORDER: readonly SetBenchAxis[] = ALL_AXES;

export function formatReportMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Set-Bench v4 report — ${report.generatedAt}`);
  lines.push('');
  lines.push('Cost columns: **cold** = no cache discount, **warm** = cache_read tokens billed at the published cache-read rate. Anthropic cells use `cache_control` block markers; Mistral cells use `prompt_cache_key` routing (request body) — both surface as `cache_read_input_tokens` in the SSE response.');
  lines.push('');

  const hasQuality = report.summary.some((s) => s.avgQualityScore !== undefined);
  if (hasQuality) {
    lines.push('**Quality** = mean score 1–5 from a cross-family judge PANEL (one judge per model family — Anthropic + Mistral), scored ABOVE the deterministic pass/fail gate. `(n)` = runs scored. The panel design cancels symmetric self-preference in the mean; the per-judge spread is reported in the bias section below — read it before trusting any cross-vendor quality gap.');
    lines.push('');
    lines.push(...formatJudgeBiasSection(report));
  }

  for (const axis of AXIS_ORDER) {
    const axisRows = report.summary.filter((s) => s.axis === axis);
    if (axisRows.length === 0) continue;
    lines.push(`## ${AXIS_DISPLAY[axis]}`);
    lines.push('');
    const q = (r: BenchReport['summary'][number]): string =>
      r.avgQualityScore === undefined ? '—' : `${r.avgQualityScore.toFixed(2)} (${r.qualityScoredRuns})`;
    lines.push('| Cell | Pinned | Pass | Quality | Cost (cold) | Cost (warm) | Cache hit | p50 | p95 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    const sorted = [...axisRows].sort((a, b) => {
      if (a.passRate !== b.passRate) return b.passRate - a.passRate;
      // Tie-break passing cells by graded quality before cost, so the
      // best-quality model floats to the top of an all-pass axis.
      const qa = a.avgQualityScore ?? -1;
      const qb = b.avgQualityScore ?? -1;
      if (qa !== qb) return qb - qa;
      return a.avgCostColdUsd - b.avgCostColdUsd;
    });
    for (const r of sorted) {
      lines.push(
        `| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | ${(r.passRate * 100).toFixed(0)}% | ${q(r)} | $${r.avgCostColdUsd.toFixed(5)} | $${r.avgCostWarmUsd.toFixed(5)} | ${(r.cacheHitRate * 100).toFixed(0)}% | ${(r.p50DurationMs / 1000).toFixed(1)}s | ${(r.p95DurationMs / 1000).toFixed(1)}s |`,
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

/**
 * Cross-family bias check: per judge, the mean score it awarded to
 * Anthropic-family vs Mistral-family cells across all judge-scored axes.
 * Same-sign Δ across judges → the quality gap is genuine; opposite signs
 * (each judge favouring its own family) → self-preference, and the panel
 * mean is the fair estimate. This is the artefact that makes the judge fair.
 */
function formatJudgeBiasSection(report: BenchReport): string[] {
  const rows = report.summary.filter((s) => s.qualityByJudge !== undefined);
  if (rows.length === 0) return [];
  const judgeIds = new Set<string>();
  for (const r of rows) for (const id of Object.keys(r.qualityByJudge ?? {})) judgeIds.add(id);
  const family = (label: string): 'anthropic' | 'mistral' | 'other' =>
    label.startsWith('anthropic') ? 'anthropic' : label.startsWith('mistral') ? 'mistral' : 'other';
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

  const lines: string[] = [];
  lines.push('### Judge panel — cross-family bias check');
  lines.push('');
  lines.push('Mean score each judge awarded to Anthropic-family vs Mistral-family cells (all judge-scored axes). Same-sign Δ across judges = the gap is genuine; opposite signs (each judge favouring its OWN family) = self-preference, and the panel mean is the fair estimate.');
  lines.push('');
  lines.push('| Judge | → Anthropic cells | → Mistral cells | Δ (Anth − Mist) |');
  lines.push('|---|---|---|---|');
  for (const id of judgeIds) {
    const a: number[] = [];
    const m: number[] = [];
    for (const r of rows) {
      const v = r.qualityByJudge?.[id];
      if (typeof v !== 'number') continue;
      const f = family(r.cellLabel);
      if (f === 'anthropic') a.push(v);
      else if (f === 'mistral') m.push(v);
    }
    const am = mean(a);
    const mm = mean(m);
    const delta = am - mm;
    const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');
    const dfmt = Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)}` : '—';
    lines.push(`| \`${id}\` | ${fmt(am)} | ${fmt(mm)} | ${dfmt} |`);
  }
  lines.push('');
  return lines;
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
