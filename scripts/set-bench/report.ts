/**
 * Set-Bench report aggregator — turns a flat `CellRun[]` into a structured
 * `BenchReport` plus a markdown-friendly summary. Per-axis tables surface
 * the headline claim ("Mistral Small at $0.20/M matches Haiku 4.5 at
 * $1.00/M on orchestration") AND the pinned-vs-latest drift gap.
 */

import type { BenchReport, CellRun, SetBenchAxis, SetBenchCell } from './types.js';

export function buildReport(runs: readonly CellRun[], cells: readonly SetBenchCell[]): BenchReport {
  const cellsByLabel = new Map(cells.map((c) => [c.label, c] as const));
  // Group runs by cellLabel — each cell runs the scenario for its own axis.
  const grouped = new Map<string, CellRun[]>();
  for (const run of runs) {
    const arr = grouped.get(run.cellLabel) ?? [];
    arr.push(run);
    grouped.set(run.cellLabel, arr);
  }

  const summary: BenchReport['summary'] = [...grouped.entries()].map(([label, cellRuns]) => {
    const cell = cellsByLabel.get(label)!;
    const passCount = cellRuns.filter((r) => r.pass).length;
    const passRate = cellRuns.length === 0 ? 0 : passCount / cellRuns.length;
    const avgCostUsd = cellRuns.reduce((acc, r) => acc + r.costUsd, 0) / Math.max(1, cellRuns.length);
    const avgDurationMs = cellRuns.reduce((acc, r) => acc + r.durationMs, 0) / Math.max(1, cellRuns.length);
    return {
      axis: cell.axis,
      cellLabel: label,
      passRate,
      avgCostUsd,
      avgDurationMs,
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
 * we emit a sorted table (descending pass-rate, then ascending cost), and
 * a pinned-vs-latest drift row when both flavours of the same base model
 * are present.
 */
export function formatReportMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Set-Bench report — ${report.generatedAt}`);
  lines.push('');

  for (const axis of ['tool-chain', 'orchestration'] as const) {
    const axisRows = report.summary.filter((s) => s.axis === axis);
    if (axisRows.length === 0) continue;
    lines.push(`## ${axisLabel(axis)}`);
    lines.push('');
    lines.push('| Cell | Pinned | Pass-rate | Avg cost | Avg duration |');
    lines.push('|---|---|---|---|---|');
    const sorted = [...axisRows].sort((a, b) => {
      if (a.passRate !== b.passRate) return b.passRate - a.passRate;
      return a.avgCostUsd - b.avgCostUsd;
    });
    for (const r of sorted) {
      lines.push(
        `| \`${r.cellLabel}\` | ${r.pinned ? 'pinned' : 'latest'} | ${(r.passRate * 100).toFixed(0)}% | $${r.avgCostUsd.toFixed(5)} | ${(r.avgDurationMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push('');

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
  if (axis === 'tool-chain') return 'TOOL_CHAIN axis (sonnet-tier bar: Anthropic Sonnet 4.6)';
  return 'ORCHESTRATION axis (haiku-tier bar: Anthropic Haiku 4.5)';
}

interface DriftRow {
  readonly baseName: string;
  readonly pinnedPassRate: number;
  readonly latestPassRate: number;
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
