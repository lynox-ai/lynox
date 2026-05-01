import type { BenchReport, JudgedRun } from './types.js';

export function buildMarkdownReport(report: BenchReport): string {
  const lines: string[] = [];

  lines.push(`# lynox Model Bench Report`);
  lines.push(``);
  lines.push(`- **Timestamp:** ${report.timestamp}`);
  lines.push(`- **Total runs:** ${report.totalRuns}`);
  lines.push(`- **Total cost:** $${report.totalCostUSD.toFixed(4)}`);
  lines.push(`- **Total latency:** ${(report.totalLatencyMs / 1000).toFixed(1)}s (sum)`);
  lines.push(``);

  lines.push(`## Per-Config Summary`);
  lines.push(``);
  lines.push(`| Config | Runs | Avg Score | Avg Cost | Avg Latency | $/score-point |`);
  lines.push(`|--------|------|-----------|----------|-------------|---------------|`);
  const byConfig = groupBy(report.runs, r => r.configLabel);
  const configStats = Object.entries(byConfig).map(([label, runs]) => ({
    label,
    runs: runs.length,
    avgScore: avg(runs.map(r => r.score)),
    avgCost: avg(runs.map(r => r.costUSD)),
    avgLatency: avg(runs.map(r => r.latencyMs)),
  }));
  configStats.sort((a, b) => b.avgScore / (b.avgCost + 1e-9) - a.avgScore / (a.avgCost + 1e-9));
  for (const s of configStats) {
    const costPerPoint = s.avgScore > 0 ? (s.avgCost / s.avgScore).toFixed(5) : '—';
    lines.push(`| ${s.label} | ${s.runs} | ${s.avgScore.toFixed(2)} | $${s.avgCost.toFixed(4)} | ${(s.avgLatency / 1000).toFixed(1)}s | $${costPerPoint} |`);
  }
  lines.push(``);

  lines.push(`## Per-Scenario Breakdown`);
  lines.push(``);
  const byScenario = groupBy(report.runs, r => r.scenarioId);
  for (const [scenarioId, runs] of Object.entries(byScenario)) {
    lines.push(`### ${scenarioId}`);
    lines.push(``);
    lines.push(`| Config | Score | Cost | Latency | Tools |`);
    lines.push(`|--------|-------|------|---------|-------|`);
    const byCfg = groupBy(runs, r => r.configLabel);
    const rows = Object.entries(byCfg).map(([label, cfgRuns]) => ({
      label,
      score: avg(cfgRuns.map(r => r.score)),
      cost: avg(cfgRuns.map(r => r.costUSD)),
      latency: avg(cfgRuns.map(r => r.latencyMs)),
      tools: avg(cfgRuns.map(r => r.toolCallCount)),
    }));
    rows.sort((a, b) => b.score - a.score || a.cost - b.cost);
    for (const r of rows) {
      lines.push(`| ${r.label} | ${r.score.toFixed(2)} | $${r.cost.toFixed(4)} | ${(r.latency / 1000).toFixed(1)}s | ${r.tools.toFixed(1)} |`);
    }
    lines.push(``);
  }

  lines.push(`## Pareto Frontier`);
  lines.push(``);
  lines.push(`Configs die nicht dominiert werden (niedrigere Kosten ODER höherer Score bei gleichen Kosten).`);
  lines.push(``);
  const frontier = paretoFrontier(configStats);
  lines.push(`| Config | Avg Score | Avg Cost | Verdict |`);
  lines.push(`|--------|-----------|----------|---------|`);
  for (const p of frontier) {
    lines.push(`| **${p.label}** | ${p.avgScore.toFixed(2)} | $${p.avgCost.toFixed(4)} | On frontier |`);
  }
  const dominated = configStats.filter(s => !frontier.includes(s));
  for (const d of dominated) {
    lines.push(`| ${d.label} | ${d.avgScore.toFixed(2)} | $${d.avgCost.toFixed(4)} | Dominated |`);
  }
  lines.push(``);

  lines.push(`## Individual Runs`);
  lines.push(``);
  for (const run of report.runs) {
    lines.push(`### ${run.scenarioId} × ${run.configLabel} (iter ${run.iteration})`);
    lines.push(``);
    lines.push(`- Score: **${run.score}/5** — ${run.judgeReasoning}`);
    lines.push(`- Cost: $${run.costUSD.toFixed(5)} | Latency: ${(run.latencyMs / 1000).toFixed(2)}s | Tokens: in=${run.usage.inputTokens} out=${run.usage.outputTokens} cacheR=${run.usage.cacheReadTokens}`);
    lines.push(`- Tools: ${run.toolCallCount} | Iterations: ${run.iterationsUsed}`);
    if (run.error) lines.push(`- **Error:** ${run.error}`);
    lines.push(``);
    lines.push(`<details><summary>Output</summary>`);
    lines.push(``);
    lines.push('```');
    lines.push(run.output.slice(0, 2000));
    if (run.output.length > 2000) lines.push(`... [${run.output.length - 2000} more chars]`);
    lines.push('```');
    lines.push(``);
    lines.push(`</details>`);
    lines.push(``);
  }

  return lines.join('\n');
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function avg(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

interface ConfigStat {
  readonly label: string;
  readonly runs: number;
  readonly avgScore: number;
  readonly avgCost: number;
  readonly avgLatency: number;
}

function paretoFrontier(stats: readonly ConfigStat[]): ConfigStat[] {
  return stats.filter(a =>
    !stats.some(b =>
      b !== a && b.avgScore >= a.avgScore && b.avgCost <= a.avgCost &&
      (b.avgScore > a.avgScore || b.avgCost < a.avgCost)
    )
  );
}
