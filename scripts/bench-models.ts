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
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runOne } from './bench-models/run-one.js';
import { judgeRun } from './bench-models/judge.js';
import { buildMarkdownReport } from './bench-models/report.js';
import { SCENARIOS, PHASE_2_SCENARIOS, PHASE_3_SCENARIOS, HN_SCENARIOS, ALL_SCENARIOS, getScenario } from './bench-models/scenarios.js';
import { PHASE_1_CONFIGS, PHASE_2_CONFIGS, PHASE_3_CONFIGS, HN_BENCH_CONFIGS, SMOKE_CONFIG, getConfig } from './bench-models/configs.js';
import type { BenchConfig, BenchReport, BenchScenario, JudgedRun } from './bench-models/types.js';

type ApiKeys = Readonly<Record<BenchConfig['apiKeyEnv'], string | undefined>>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'bench-models', 'results');

interface CliArgs {
  mode: 'smoke' | 'phase1' | 'phase2' | 'phase3' | 'hn' | 'list' | 'custom';
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
    else if (a === '--phase3') args.mode = 'phase3';
    else if (a === '--hn') args.mode = 'hn';
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

/**
 * Resolve all required API keys. Priority order per key:
 *   1. `process.env[ENV_NAME]`
 *   2. Matching field in `~/.lynox/config.json`
 *      - `ANTHROPIC_API_KEY` → reads `anthropic_api_key` (with `api_key`
 *         as a backward-compat fallback for the legacy single-provider field)
 *      - `MISTRAL_API_KEY`    → reads `mistral_api_key`
 *      - `OPENROUTER_API_KEY` → reads `openrouter_api_key`
 *
 * Why config.json instead of a separate keys file: one source of truth,
 * already gitignored by virtue of living outside the repo, already where
 * the engine reads its own keys. The runner refuses to start if the file
 * permissions are looser than 0600 — bench keys must not be world-readable.
 *
 * ANTHROPIC is always required because the judge step runs Haiku
 * regardless of which models the matrix includes.
 */
function getApiKeys(configs: readonly BenchConfig[]): ApiKeys {
  const cfg = readLynoxConfig();

  const anthropic = process.env['ANTHROPIC_API_KEY']
    ?? readStr(cfg, 'anthropic_api_key')
    ?? readStr(cfg, 'api_key');
  if (!anthropic) {
    throw new Error(
      'No Anthropic key found. Required for the judge step. Set ANTHROPIC_API_KEY ' +
      'in env or add `"anthropic_api_key": "sk-ant-..."` to ~/.lynox/config.json (chmod 600).',
    );
  }

  const keys: ApiKeys = {
    ANTHROPIC_API_KEY: anthropic,
    MISTRAL_API_KEY:    process.env['MISTRAL_API_KEY']    ?? readStr(cfg, 'mistral_api_key'),
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'] ?? readStr(cfg, 'openrouter_api_key'),
  };

  // Fail fast on any config whose key resolved to undefined. Better than
  // getting cryptic per-run errors deep in the matrix loop.
  const needed = new Set(configs.map(c => c.apiKeyEnv));
  const missing = [...needed].filter(env => !keys[env]);
  if (missing.length > 0) {
    throw new Error(
      `Missing API keys for configs in this matrix: ${missing.join(', ')}.\n` +
      `Add them to ~/.lynox/config.json (snake_case field names: ` +
      `anthropic_api_key, mistral_api_key, openrouter_api_key) or export the ` +
      `equivalent env vars before running.`,
    );
  }
  return keys;
}

/**
 * Read ~/.lynox/config.json with a strict permission check — if the file
 * is world-readable we refuse to load keys from it. Returns an empty
 * record if the file doesn't exist (env-only operation is still valid).
 */
function readLynoxConfig(): Record<string, unknown> {
  const configPath = join(homedir(), '.lynox', 'config.json');
  let raw: string;
  try {
    const stat = statSync(configPath);
    // Posix-mode bits: anything beyond owner (0o600) is a leak surface.
    // 0o077 catches "group" and "other" perms. Skip on Windows (no posix mode).
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      process.stderr.write(
        `[bench] WARNING: ~/.lynox/config.json has mode ${(stat.mode & 0o777).toString(8)}; ` +
        `expected 0600. Refusing to read keys from a world/group-readable file. ` +
        `Fix: chmod 600 ~/.lynox/config.json\n`,
      );
      return {};
    }
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* corrupt JSON → treat as empty */ }
  return {};
}

function readStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
  if (args.mode === 'phase3') {
    return { scenarios: PHASE_3_SCENARIOS, configs: PHASE_3_CONFIGS, runs: args.iterations };
  }
  if (args.mode === 'hn') {
    // HN-companion-post matrix — 4 scenarios × 8 configs × N runs.
    return { scenarios: HN_SCENARIOS, configs: HN_BENCH_CONFIGS, runs: args.iterations };
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
    process.stdout.write('\nPhase 3 Scenarios:\n');
    for (const s of PHASE_3_SCENARIOS) process.stdout.write(`  ${s.id.padEnd(22)} ${s.category.padEnd(14)} ${s.description}\n`);
    process.stdout.write('\nPhase 1 Configs:\n');
    for (const c of PHASE_1_CONFIGS) process.stdout.write(`  ${c.label.padEnd(18)} ${c.modelId.padEnd(32)} effort=${c.effort} thinking=${c.thinking}\n`);
    process.stdout.write('\nPhase 2 Configs:\n');
    for (const c of PHASE_2_CONFIGS) process.stdout.write(`  ${c.label.padEnd(18)} ${c.modelId.padEnd(32)} effort=${c.effort} thinking=${c.thinking}\n`);
    process.stdout.write('\nPhase 3 Configs:\n');
    for (const c of PHASE_3_CONFIGS) process.stdout.write(`  ${c.label.padEnd(18)} ${c.modelId.padEnd(32)} effort=${c.effort} thinking=${c.thinking}\n`);
    process.stdout.write('\nHN Scenarios:\n');
    for (const s of HN_SCENARIOS) process.stdout.write(`  ${s.id.padEnd(28)} ${s.category.padEnd(14)} ${s.description}\n`);
    process.stdout.write('\nHN Configs:\n');
    for (const c of HN_BENCH_CONFIGS) process.stdout.write(`  ${c.label.padEnd(20)} tier=${c.tier.padEnd(18)} provider=${c.provider} keyEnv=${c.apiKeyEnv}\n`);
    return;
  }

  const { scenarios, configs, runs } = buildMatrix(args);
  const apiKeys = getApiKeys(configs);
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
          const run = await runOne({ scenario, config, iteration: iter, apiKeys });
          // Judge always uses Anthropic Haiku — apiKeys.ANTHROPIC_API_KEY is
          // verified non-null by getApiKeys() at startup.
          const judgedRun = await judgeRun(scenario, run, apiKeys.ANTHROPIC_API_KEY!);
          judged.push(judgedRun);
          const elapsed = Date.now() - tStart;
          process.stdout.write(`score=${judgedRun.score} pass=${judgedRun.passed ? 'Y' : 'N'} cost=$${judgedRun.costUSD.toFixed(4)} lat=${fmtDuration(elapsed)}${run.error ? ' [ERROR]' : ''}\n`);
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
  const suffix = args.mode === 'hn' ? '-hn'
    : args.mode === 'phase3' ? '-phase3'
    : args.mode === 'phase2' ? '-phase2'
    : args.mode === 'phase1' ? '-phase1'
    : '';
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
