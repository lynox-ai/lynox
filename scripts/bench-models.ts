#!/usr/bin/env npx tsx
/**
 * lynox Model Bench — compare models and configs across realistic scenarios
 * to find Pareto-optimal sweet spots.
 *
 * Usage:
 *   npx tsx scripts/bench-models.ts --smoke              # 1 run  (~$0.001)
 *   npx tsx scripts/bench-models.ts --phase1             # 60 runs (~$5-10)
 *   npx tsx scripts/bench-models.ts --phase2             # 24 runs (~$3-6), Opus 4.7 + new scenarios
 *   npx tsx scripts/bench-models.ts --scenario <id>      # single scenario, all phase-1 configs
 *   npx tsx scripts/bench-models.ts --config <label>     # single config, all scenarios
 *   npx tsx scripts/bench-models.ts --runs N             # override iterations (default 2)
 *   npx tsx scripts/bench-models.ts --list               # list scenarios + configs
 *
 * API key from ANTHROPIC_API_KEY env var or ~/.lynox/config.json.
 * Output: scripts/bench-models/results/<timestamp>.{json,md}
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runOne } from './bench-models/run-one.js';
import { judgeRun } from './bench-models/judge.js';
import { buildMarkdownReport } from './bench-models/report.js';
import { SCENARIOS, PHASE_2_SCENARIOS, ALL_SCENARIOS, getScenario } from './bench-models/scenarios.js';
import { PHASE_1_CONFIGS, PHASE_2_CONFIGS, SMOKE_CONFIG, getConfig } from './bench-models/configs.js';
import type { BenchConfig, BenchReport, BenchScenario, JudgedRun } from './bench-models/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'bench-models', 'results');

interface CliArgs {
  mode: 'smoke' | 'phase1' | 'phase2' | 'list' | 'custom';
  scenarioId?: string;
  configLabel?: string;
  iterations: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { mode: 'phase1', iterations: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.mode = 'smoke';
    else if (a === '--phase1') args.mode = 'phase1';
    else if (a === '--phase2') args.mode = 'phase2';
    else if (a === '--list') args.mode = 'list';
    else if (a === '--scenario') { args.scenarioId = argv[++i]; args.mode = 'custom'; }
    else if (a === '--config') { args.configLabel = argv[++i]; args.mode = 'custom'; }
    else if (a === '--runs') args.iterations = parseInt(argv[++i]!, 10);
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  }
  return args;
}

function printUsage(): void {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const header = src.split('\n').slice(1, 20).map(l => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '').replace(/\*\//, '')).join('\n');
  process.stdout.write(header + '\n');
}

function getApiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];
  try {
    const configPath = join(homedir(), '.lynox', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    if (typeof config['api_key'] === 'string' && config['api_key'].length > 0) return config['api_key'];
  } catch { /* not found */ }
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or configure ~/.lynox/config.json');
}

function buildMatrix(args: CliArgs): { scenarios: readonly BenchScenario[]; configs: readonly BenchConfig[]; runs: number } {
  if (args.mode === 'smoke') {
    return { scenarios: [SCENARIOS[0]!], configs: [SMOKE_CONFIG], runs: 1 };
  }
  if (args.mode === 'phase1') {
    return { scenarios: SCENARIOS, configs: PHASE_1_CONFIGS, runs: args.iterations };
  }
  if (args.mode === 'phase2') {
    return { scenarios: PHASE_2_SCENARIOS, configs: PHASE_2_CONFIGS, runs: args.iterations };
  }
  // custom
  const scenarios = args.scenarioId
    ? [getScenario(args.scenarioId) ?? throwError(`Unknown scenario: ${args.scenarioId}`)]
    : ALL_SCENARIOS;
  const configs = args.configLabel
    ? [getConfig(args.configLabel) ?? throwError(`Unknown config: ${args.configLabel}`)]
    : PHASE_1_CONFIGS;
  return { scenarios, configs, runs: args.iterations };
}

function throwError(msg: string): never { throw new Error(msg); }

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'list') {
    process.stdout.write('Phase 1 Scenarios:\n');
    for (const s of SCENARIOS) process.stdout.write(`  ${s.id.padEnd(22)} ${s.category.padEnd(14)} ${s.description}\n`);
    process.stdout.write('\nPhase 2 Scenarios:\n');
    for (const s of PHASE_2_SCENARIOS) process.stdout.write(`  ${s.id.padEnd(22)} ${s.category.padEnd(14)} ${s.description}\n`);
    process.stdout.write('\nPhase 1 Configs:\n');
    for (const c of PHASE_1_CONFIGS) process.stdout.write(`  ${c.label.padEnd(18)} ${c.modelId.padEnd(32)} effort=${c.effort} thinking=${c.thinking}\n`);
    process.stdout.write('\nPhase 2 Configs:\n');
    for (const c of PHASE_2_CONFIGS) process.stdout.write(`  ${c.label.padEnd(18)} ${c.modelId.padEnd(32)} effort=${c.effort} thinking=${c.thinking}\n`);
    return;
  }

  const apiKey = getApiKey();
  const { scenarios, configs, runs } = buildMatrix(args);
  const totalRuns = scenarios.length * configs.length * runs;

  process.stdout.write(`Matrix: ${scenarios.length} scenarios × ${configs.length} configs × ${runs} runs = ${totalRuns} total\n\n`);

  const started = Date.now();
  const judged: JudgedRun[] = [];
  let i = 0;
  for (const scenario of scenarios) {
    for (const config of configs) {
      for (let iter = 1; iter <= runs; iter++) {
        i++;
        const prefix = `[${String(i).padStart(String(totalRuns).length)}/${totalRuns}]`;
        process.stdout.write(`${prefix} ${scenario.id.padEnd(24)} × ${config.label.padEnd(18)} iter=${iter} ... `);
        const tStart = Date.now();
        try {
          const run = await runOne({ scenario, config, iteration: iter, apiKey });
          const judgedRun = await judgeRun(scenario, run, apiKey);
          judged.push(judgedRun);
          const elapsed = Date.now() - tStart;
          process.stdout.write(`score=${judgedRun.score} cost=$${judgedRun.costUSD.toFixed(4)} lat=${fmtDuration(elapsed)}${run.error ? ' [ERROR]' : ''}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`CRASH: ${msg}\n`);
        }
      }
    }
  }

  const totalElapsed = Date.now() - started;
  const report: BenchReport = {
    timestamp: new Date().toISOString(),
    totalRuns: judged.length,
    totalCostUSD: judged.reduce((sum, r) => sum + r.costUSD + r.judgeCostUSD, 0),
    totalLatencyMs: judged.reduce((sum, r) => sum + r.latencyMs, 0),
    runs: judged,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  const suffix = args.mode === 'phase2' ? '-phase2' : args.mode === 'phase1' ? '-phase1' : '';
  const jsonPath = join(RESULTS_DIR, `${stamp}${suffix}.json`);
  const mdPath = join(RESULTS_DIR, `${stamp}${suffix}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, buildMarkdownReport(report));

  process.stdout.write(`\n==================================================\n`);
  process.stdout.write(`Done: ${judged.length}/${totalRuns} runs in ${fmtDuration(totalElapsed)}\n`);
  process.stdout.write(`Total cost (incl. judge): $${report.totalCostUSD.toFixed(4)}\n`);
  process.stdout.write(`Report: ${mdPath}\n`);
  process.stdout.write(`Data:   ${jsonPath}\n`);
}

main().catch(err => {
  process.stderr.write(`bench-models failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
