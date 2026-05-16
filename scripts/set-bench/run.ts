#!/usr/bin/env npx tsx
/**
 * Set-Bench Phase 2 — top-level driver.
 *
 * Reads API keys from ~/.lynox/config.json (chmod 600), iterates every
 * (scenario, cell) pair where the scenario's axis matches the cell's
 * axis, repeats each `runsPerCell` times, and writes both JSON + Markdown
 * report files into `scripts/set-bench/results/`.
 *
 * Usage:
 *   npx tsx scripts/set-bench/run.ts                  # full matrix, 3 runs/cell
 *   npx tsx scripts/set-bench/run.ts --cells mistral-large-2512,mistral-large-latest --runs 5
 *   npx tsx scripts/set-bench/run.ts --axis orchestration
 *
 * API keys: reads `anthropic_api_key` + `mistral_api_key` from the same
 * `~/.lynox/config.json` your local engine uses. Bench never writes back.
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
import type { CellRun, SetBenchAxis, SetBenchCell } from './types.js';

interface CliArgs {
  axis?: SetBenchAxis;
  cellLabels?: string[];
  runsPerCell: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { runsPerCell: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--axis') {
      const v = argv[++i];
      if (v !== 'tool-chain' && v !== 'orchestration') throw new Error(`--axis must be tool-chain|orchestration`);
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
    } else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log('usage: run.ts [--axis tool-chain|orchestration] [--cells a,b,c] [--runs N]');
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

/**
 * Source API keys for the bench. Precedence: shell env wins over the local
 * config file — so an operator can override per-run via
 * `MISTRAL_API_KEY=... npx tsx scripts/set-bench/run.ts` without editing
 * `~/.lynox/config.json`. Missing config file is fine when the shell
 * already has both keys; only hard-error when nothing satisfies a needed
 * `apiKeyEnv` (the per-cell check in `run-cell.ts` surfaces that).
 */
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

function pickCells(args: CliArgs): readonly SetBenchCell[] {
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

  const runs: CellRun[] = [];
  for (const cell of cells) {
    const scenario = SET_BENCH_SCENARIOS.find((s) => s.axis === cell.axis);
    if (!scenario) {
      process.stderr.write(`! no scenario for axis ${cell.axis} (cell ${cell.label}) — skipping\n`);
      continue;
    }
    for (let i = 0; i < args.runsPerCell; i++) {
      const tag = `[${cell.label} ${i + 1}/${args.runsPerCell}]`;
      process.stdout.write(`${tag} running... `);
      const t0 = Date.now();
      const result = await runCell(cell, scenario);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'} (${dt}s, $${result.costUsd.toFixed(5)})`);
      if (!result.pass) process.stdout.write(` — ${result.reason ?? ''}`);
      process.stdout.write('\n');
      runs.push(result);
    }
  }

  const report = buildReport(runs, cells);
  const here = dirname(fileURLToPath(import.meta.url));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(here, 'results', `set-bench-${stamp}.json`);
  const mdPath = join(here, 'results', `set-bench-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatReportMarkdown(report));
  process.stdout.write(`\nReport written:\n  ${jsonPath}\n  ${mdPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
