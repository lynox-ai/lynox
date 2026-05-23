#!/usr/bin/env npx tsx
/**
 * Set-Bench v4 — top-level driver.
 *
 * Reads API keys from ~/.lynox/config.json (chmod 600) or env, iterates
 * every (cell, scenario) pair where the scenario's axis matches the
 * cell's axis, repeats each `runsPerCell` times, and writes both JSON +
 * Markdown report files into `scripts/set-bench/results/`.
 *
 * Default n=10 — matches the page's published methodology.
 *
 * Usage:
 *   npx tsx scripts/set-bench/run.ts                       # full matrix, 10 runs/cell
 *   npx tsx scripts/set-bench/run.ts --smoke               # 1 cheap cell × 1 run per axis (~5min, ~$0.50)
 *   npx tsx scripts/set-bench/run.ts --axis cron-task-cold-start
 *   npx tsx scripts/set-bench/run.ts --cells anthropic-haiku-4-5,mistral-ministral-3b-2410 --runs 3
 *
 * API keys: reads `anthropic_api_key` + `mistral_api_key` from
 * `~/.lynox/config.json` if not in env. Bench never writes back.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { ALL_CELLS } from './configs.js';
import { SET_BENCH_SCENARIOS } from './scenarios.js';
import { runCell } from './run-cell.js';
import { buildReport, formatReportMarkdown } from './report.js';
import { ALL_AXES } from './types.js';
import type { CellRun, SetBenchAxis, SetBenchCell } from './types.js';

interface CliArgs {
  axis?: SetBenchAxis;
  cellLabels?: string[];
  runsPerCell: number;
  smoke: boolean;
}

function isAxis(v: string): v is SetBenchAxis {
  return (ALL_AXES as readonly string[]).includes(v);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { runsPerCell: 10, smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--axis') {
      const v = argv[++i];
      if (!v || !isAxis(v)) {
        throw new Error(`--axis must be one of: ${ALL_AXES.join(', ')}`);
      }
      out.axis = v;
    } else if (a === '--cells') {
      const v = argv[++i];
      if (!v) throw new Error('--cells needs a value');
      out.cellLabels = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === '--runs') {
      const v = argv[++i];
      const n = parseInt(v ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--runs must be a positive integer');
      out.runsPerCell = n;
    } else if (a === '--smoke') {
      // Smoke mode: 1 cheap model × 1 run per axis. ~5min wall-clock,
      // ~$0.50 spend. Used to verify scenarios + mock-tools work end-to-
      // end before kicking off the overnight n=10 matrix.
      out.smoke = true;
      out.runsPerCell = 1;
    } else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(`usage: run.ts [--axis <axis>] [--cells a,b,c] [--runs N] [--smoke]\n\naxes: ${ALL_AXES.join(', ')}`);
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

function loadEnvFromConfig(): void {
  if (process.env['ANTHROPIC_API_KEY'] && process.env['MISTRAL_API_KEY']) return;
  const path = join(homedir(), '.lynox', 'config.json');
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  if (!process.env['ANTHROPIC_API_KEY'] && typeof cfg['anthropic_api_key'] === 'string') {
    process.env['ANTHROPIC_API_KEY'] = cfg['anthropic_api_key'];
  }
  if (!process.env['MISTRAL_API_KEY'] && typeof cfg['mistral_api_key'] === 'string') {
    process.env['MISTRAL_API_KEY'] = cfg['mistral_api_key'];
  }
}

/**
 * Pick cells per CLI args. Smoke mode shrinks the matrix to "one cheap
 * cell per axis" — ministral-3b for everything (cheapest model in the
 * panel). Catches scenario / mock-tool / harness bugs without burning
 * the matrix-run budget.
 */
function pickCells(args: CliArgs): readonly SetBenchCell[] {
  if (args.smoke) {
    // One representative cell per axis. We use ministral-3b across the
    // board — it's the cheapest Mistral cell and uses the openai-compat
    // path; a smoke-run pass here proves both Anthropic-SDK + openai-
    // compat code paths handle the scenario.
    return ALL_CELLS.filter((c) => c.label === 'mistral-ministral-3b-2410');
  }
  let cells: readonly SetBenchCell[] = ALL_CELLS;
  if (args.axis) cells = cells.filter((c) => c.axis === args.axis);
  if (args.cellLabels) {
    const wanted = new Set(args.cellLabels);
    cells = cells.filter((c) => wanted.has(c.label));
    const got = new Set(cells.map((c) => c.label));
    const missing = args.cellLabels.filter((l) => !got.has(l));
    if (missing.length > 0) throw new Error(`unknown cell labels: ${missing.join(', ')}`);
  }
  return cells;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFromConfig();
  const cells = pickCells(args);
  if (cells.length === 0) throw new Error('no cells selected');

  if (args.smoke) {
    process.stdout.write(`# Smoke mode — 1 cell × 1 run per axis (${cells.length} cells)\n\n`);
  } else {
    process.stdout.write(`# Set-Bench v4 — ${cells.length} cells × ${args.runsPerCell} runs = ${cells.length * args.runsPerCell} model calls\n\n`);
  }

  const runs: CellRun[] = [];
  for (const cell of cells) {
    const scenario = SET_BENCH_SCENARIOS.find((s) => s.axis === cell.axis);
    if (!scenario) {
      process.stderr.write(`! no scenario for axis ${cell.axis} (cell ${cell.label}) — skipping\n`);
      continue;
    }
    for (let i = 0; i < args.runsPerCell; i++) {
      const tag = args.runsPerCell === 1
        ? `[${cell.axis} / ${cell.label}]`
        : `[${cell.axis} / ${cell.label} ${i + 1}/${args.runsPerCell}]`;
      process.stdout.write(`${tag} running... `);
      const t0 = Date.now();
      const result = await runCell(cell, scenario);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'} (${dt}s, cold=$${result.costUsdCold.toFixed(5)}, warm=$${result.costUsdWarm.toFixed(5)}, cache_read=${result.cacheReadTokens})`);
      if (!result.pass) process.stdout.write(` — ${result.reason ?? ''}`);
      process.stdout.write('\n');
      runs.push(result);
    }
  }

  const report = buildReport(runs, cells);
  const here = dirname(fileURLToPath(import.meta.url));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = args.smoke ? '-smoke' : '';
  const jsonPath = join(here, 'results', `set-bench${suffix}-${stamp}.json`);
  const mdPath = join(here, 'results', `set-bench${suffix}-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatReportMarkdown(report));
  process.stdout.write(`\nReport written:\n  ${jsonPath}\n  ${mdPath}\n`);

  // Smoke-mode exit: non-zero if any cell failed, so the operator catches
  // scenario / mock-tool bugs BEFORE kicking off the full matrix run.
  if (args.smoke) {
    const failed = runs.filter((r) => !r.pass);
    if (failed.length > 0) {
      process.stderr.write(`\n! smoke mode found ${failed.length} failing cells — fix before the full matrix run\n`);
      for (const f of failed) {
        process.stderr.write(`  - ${f.cellLabel} / ${f.scenarioId}: ${f.reason ?? 'unknown'}\n`);
      }
      process.exit(1);
    }
    process.stdout.write(`\n✓ All ${runs.length} smoke cells passed — safe to run the full matrix.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
