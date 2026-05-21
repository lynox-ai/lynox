#!/usr/bin/env npx tsx
/**
 * Agent-Efficiency measurement protocol — Phase 0 of
 * `pro/docs/internal/PRD-AGENT-EFFICIENCY.md` §6 (O10 staging-`usage` protocol).
 *
 * Runs the 6 evidence scenarios (PRD §2) against a live lynox engine,
 * reads the per-turn `usage` the engine persists, and writes a baseline
 * artifact. `--compare` re-runs the scenarios against a stored baseline
 * and prints the D3 cost gate — that mode is the reusable gate Phases
 * 2-5 call before merging.
 *
 * Usage:
 *   AE_COOKIE=$(scripts/mint-staging-cookie.sh) \
 *     npx tsx scripts/agent-efficiency/measure.ts                # n=3 vs staging
 *   ... measure.ts --n 5                                         # 5 repeats
 *   ... measure.ts --target https://engine.lynox.cloud           # explicit target
 *   ... measure.ts --scenario weather-simple                     # one scenario
 *   ... measure.ts --compare baselines/baseline-<ISO>.json       # D3 gate diff
 *   ... measure.ts --list                                        # list scenarios
 *
 * Auth: the `lynox_session` cookie value via `AE_COOKIE` (preferred —
 * keeps the secret out of argv / process listings) or `--cookie <v>`.
 * Mint it with `scripts/mint-staging-cookie.sh`; NEVER commit the value.
 *
 * Cost: a full n=3 run spends a few dollars of real LLM cost on the
 * target engine. That is the explicit, authorized Phase-0 deliverable.
 *
 * Exit ramp (PRD §6): if no scenario produces a trustworthy usage
 * signal, no baseline artifact is written and the script exits non-zero
 * — Phases 2-5 then pause (Phase 1 correctness work is unaffected).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient } from './engine-client.js';
import { SCENARIOS, groupByThread } from './scenarios.js';
import {
  cacheHitRatio,
  compareBaselines,
  computeScenarioStats,
  overallVerdict,
} from './stats.js';
import { renderBaselineMarkdown, renderCompareMarkdown } from './report.js';
import type {
  Baseline,
  Scenario,
  ScenarioResult,
  TurnRun,
  TurnUsage,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, 'baselines');
const DEFAULT_TARGET = 'https://engine.lynox.cloud';

const ZERO_USAGE: TurnUsage = {
  tokensIn: 0,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUsd: 0,
};

interface CliArgs {
  n: number;
  target: string;
  scenarioId?: string;
  comparePath?: string;
  list: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { n: 3, target: DEFAULT_TARGET, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') args.n = Math.max(1, parseInt(argv[++i] ?? '3', 10) || 3);
    else if (a === '--target') args.target = argv[++i] ?? DEFAULT_TARGET;
    else if (a === '--scenario') {
      const v = argv[++i];
      if (v !== undefined) args.scenarioId = v;
    } else if (a === '--compare') {
      const v = argv[++i];
      if (v !== undefined) args.comparePath = v;
    } else if (a === '--cookie') {
      const v = argv[++i];
      if (v !== undefined) process.env['AE_COOKIE'] = v;
    }
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage(): void {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const header = src
    .split('\n')
    .slice(1, 33)
    .map((l) => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '').replace(/\*\//, ''))
    .join('\n');
  process.stdout.write(header + '\n');
}

function getCookie(): string {
  const c = process.env['AE_COOKIE'];
  if (!c || c.trim().length === 0) {
    throw new Error(
      'No session cookie. Set AE_COOKIE (preferred) or pass --cookie. ' +
        'Mint it with: scripts/mint-staging-cookie.sh',
    );
  }
  return c.trim();
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
}

/** Resolve which scenarios to run, honoring `--scenario`. */
function resolveScenarios(args: CliArgs): readonly Scenario[] {
  if (!args.scenarioId) return SCENARIOS;
  const one = SCENARIOS.find((s) => s.id === args.scenarioId);
  if (!one) {
    throw new Error(
      `Unknown scenario '${args.scenarioId}'. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }
  return [one];
}

/**
 * Run one full pass of every scenario, n repeats each, and aggregate.
 *
 * Each repeat of a thread-group uses a FRESH session so warm/cold-cache
 * behaviour is consistent across repeats (a reused session would carry
 * a warm cache into repeat 2). Within a repeat, scenarios sharing a
 * `threadKey` run sequentially in one session — the multi-turn case.
 */
async function runPass(
  client: EngineClient,
  scenarios: readonly Scenario[],
  n: number,
  expectedBuildSha: string,
): Promise<ScenarioResult[]> {
  const groups = groupByThread(scenarios);
  // Accumulate runs per scenario id across all repeats.
  const runsById = new Map<string, TurnRun[]>();
  for (const s of scenarios) runsById.set(s.id, []);

  for (let iter = 1; iter <= n; iter++) {
    for (const [threadKey, groupScenarios] of groups) {
      // Ride out a transient redeploy / restart: a managed engine can
      // briefly 404/502 while a container swaps. Without this, one
      // redeploy mid-batch cascades into a wall of false failures.
      const healthy = await client.waitForHealthy(180_000);
      if (!healthy) {
        const msg = 'engine unhealthy — did not recover within 180s';
        for (const s of groupScenarios) {
          runsById.get(s.id)!.push(failRun(s.id, iter, msg));
        }
        process.stdout.write(`  [iter ${iter}] thread '${threadKey}': ${msg}\n`);
        continue;
      }
      if (healthy.buildSha !== expectedBuildSha) {
        // Build drifted mid-run — the numbers would mix two builds.
        // Flag loudly; the artifact still records the original pin.
        process.stdout.write(
          `  [iter ${iter}] thread '${threadKey}': WARNING build drift — ` +
            `expected ${expectedBuildSha.slice(0, 8)}, engine now ${healthy.buildSha.slice(0, 8)}\n`,
        );
      }
      let sessionId: string;
      try {
        sessionId = await client.createSession();
      } catch (err) {
        // Whole thread-group failed to start — record a failure per
        // scenario in the group and move on; never abort the batch.
        const msg = err instanceof Error ? err.message : String(err);
        for (const s of groupScenarios) {
          runsById.get(s.id)!.push(failRun(s.id, iter, `session create failed: ${msg}`));
        }
        process.stdout.write(`  [iter ${iter}] thread '${threadKey}': session create FAILED — ${msg}\n`);
        continue;
      }
      for (const scenario of groupScenarios) {
        const run = await runScenarioTurn(client, sessionId, scenario, iter);
        runsById.get(scenario.id)!.push(run);
        const status = run.ok
          ? `cost=$${run.usage.costUsd.toFixed(4)} in=${run.usage.tokensIn} ` +
            `cache=${(run.cacheHitRatio * 100).toFixed(0)}% ${fmtDuration(run.wallMs)}`
          : `FAIL — ${run.error}`;
        process.stdout.write(`  [iter ${iter}] ${scenario.id.padEnd(22)} ${status}\n`);
      }
    }
  }

  // Aggregate.
  return scenarios.map((s) => {
    const runs = runsById.get(s.id) ?? [];
    const okRuns = runs.filter((r) => r.ok);
    const result: ScenarioResult = {
      scenarioId: s.id,
      label: s.label,
      evidenceRow: s.evidenceRow,
      qualityRubric: s.qualityRubric,
      runs,
      okCount: okRuns.length,
      totalCount: runs.length,
    };
    if (s.fidelityCaveat) (result as { fidelityCaveat?: string }).fidelityCaveat = s.fidelityCaveat;
    const stats = computeScenarioStats(okRuns);
    if (stats) (result as { stats?: typeof stats }).stats = stats;
    return result;
  });
}

function failRun(scenarioId: string, iteration: number, error: string): TurnRun {
  return {
    scenarioId,
    iteration,
    ok: false,
    error,
    usage: ZERO_USAGE,
    cacheHitRatio: 0,
    wallMs: 0,
    finalText: '',
  };
}

/** Run one turn of one scenario and read its per-turn usage. */
async function runScenarioTurn(
  client: EngineClient,
  sessionId: string,
  scenario: Scenario,
  iteration: number,
): Promise<TurnRun> {
  // Snapshot the highest seq BEFORE the run so we can isolate exactly
  // the assistant message this turn produces.
  let sinceSeq = 0;
  try {
    sinceSeq = await client.maxSeq(sessionId);
  } catch {
    // A messages-read failure here is non-fatal — fall back to seq 0
    // (the new assistant message will still be the highest-seq one).
    sinceSeq = 0;
  }

  const outcome = await client.runTurn(sessionId, scenario.prompt, scenario.timeoutMs);

  if (!outcome.completed) {
    // The client aborted (timeout) or the stream dropped — the engine
    // run may still be locking the session. Abort it, then give the
    // engine a short grace window to unwind before the next turn in
    // this multi-turn thread fires (an immediate /run still 409s while
    // the aborted run drains).
    await client.abortSession(sessionId);
    await new Promise<void>((r) => setTimeout(r, 5_000));
    return {
      scenarioId: scenario.id,
      iteration,
      ok: false,
      error: outcome.error ?? 'run did not complete',
      usage: ZERO_USAGE,
      cacheHitRatio: 0,
      wallMs: outcome.wallMs,
      finalText: '',
    };
  }

  // Run completed — read the per-turn usage from the messages projection.
  let turn: { usage: TurnUsage; finalText: string } | undefined;
  try {
    turn = await client.getTurnUsage(sessionId, sinceSeq);
  } catch (err) {
    return {
      scenarioId: scenario.id,
      iteration,
      ok: false,
      error: `usage read failed: ${err instanceof Error ? err.message : String(err)}`,
      usage: ZERO_USAGE,
      cacheHitRatio: 0,
      wallMs: outcome.wallMs,
      finalText: '',
    };
  }
  if (!turn) {
    return {
      scenarioId: scenario.id,
      iteration,
      ok: false,
      error: 'run completed but no usage-stamped assistant message was found',
      usage: ZERO_USAGE,
      cacheHitRatio: 0,
      wallMs: outcome.wallMs,
      finalText: '',
    };
  }

  return {
    scenarioId: scenario.id,
    iteration,
    ok: true,
    usage: turn.usage,
    cacheHitRatio: cacheHitRatio(turn.usage.tokensCacheRead, turn.usage.tokensCacheWrite),
    wallMs: outcome.wallMs,
    finalText: turn.finalText,
  };
}

function buildBaseline(
  target: string,
  health: { buildSha: string; version: string },
  iterations: number,
  scenarios: readonly ScenarioResult[],
): Baseline {
  const totalMeanCostUsd = scenarios.reduce(
    (sum, s) => sum + (s.stats?.costUsd.mean ?? 0),
    0,
  );
  return {
    capturedAt: new Date().toISOString(),
    target,
    buildSha: health.buildSha,
    version: health.version,
    iterations,
    totalMeanCostUsd,
    scenarios,
  };
}

function loadBaseline(path: string): Baseline {
  const resolved = path.startsWith('/') ? path : join(process.cwd(), path);
  const raw = readFileSync(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as Baseline;
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error(`Not a valid baseline artifact: ${path}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    process.stdout.write('Agent-Efficiency scenarios (PRD §2 evidence):\n\n');
    for (const s of SCENARIOS) {
      process.stdout.write(`  ${s.id.padEnd(22)} [${s.threadKey}] ${s.label}\n`);
      process.stdout.write(`  ${' '.repeat(22)} ${s.evidenceRow}\n`);
      if (s.fidelityCaveat) {
        process.stdout.write(`  ${' '.repeat(22)} ⚠ ${s.fidelityCaveat}\n`);
      }
    }
    return;
  }

  const cookie = getCookie();
  const client = new EngineClient(args.target, cookie);
  const scenarios = resolveScenarios(args);

  process.stdout.write(`Agent-Efficiency measurement protocol\n`);
  process.stdout.write(`  target:    ${args.target}\n`);
  process.stdout.write(`  scenarios: ${scenarios.length}\n`);
  process.stdout.write(`  repeats:   n=${args.n}\n`);
  if (args.comparePath) process.stdout.write(`  mode:      compare vs ${args.comparePath}\n`);
  process.stdout.write('\n');

  // Probe the engine — pins the run to a concrete build.
  let health: { buildSha: string; version: string };
  try {
    health = await client.health();
  } catch (err) {
    process.stderr.write(
      `EXIT RAMP: engine unreachable (${err instanceof Error ? err.message : String(err)}).\n` +
        `No baseline written. Per PRD §6, Phases 2-5 pause until a signal exists.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`  engine:    ${health.version} @ ${health.buildSha}\n\n`);

  const started = Date.now();
  const results = await runPass(client, scenarios, args.n, health.buildSha);
  const elapsed = Date.now() - started;

  const okScenarios = results.filter((r) => r.okCount > 0).length;
  process.stdout.write(
    `\nDone in ${fmtDuration(elapsed)} — ${okScenarios}/${results.length} scenarios produced a signal\n`,
  );

  // Exit ramp: zero trustworthy signal → no artifact, non-zero exit.
  if (okScenarios === 0) {
    process.stderr.write(
      `\nEXIT RAMP (PRD §6): no scenario produced a trustworthy usage signal.\n` +
        `No baseline artifact written. Phases 2-5 must pause; Phase 1 is unaffected.\n`,
    );
    process.exit(1);
  }

  const current = buildBaseline(args.target, health, args.n, results);

  if (args.comparePath) {
    // ── Compare mode — the reusable D3 gate ──
    const baseline = loadBaseline(args.comparePath);
    const rows = compareBaselines(baseline, current);
    process.stdout.write('\n' + renderCompareMarkdown(baseline, current, rows));
    const verdict = overallVerdict(rows);
    // Also persist the comparison run so it is auditable.
    mkdirSync(BASELINES_DIR, { recursive: true });
    const stamp = current.capturedAt.replace(/[:.]/g, '-');
    writeFileSync(
      join(BASELINES_DIR, `compare-${stamp}.json`),
      JSON.stringify({ baseline: baseline.capturedAt, current, rows }, null, 2),
    );
    process.stdout.write(`Compare run saved: baselines/compare-${stamp}.json\n`);
    // Non-zero exit on gate fail so CI / a phase PR can hard-block on it.
    process.exit(verdict === 'fail' ? 1 : 0);
  }

  // ── Baseline mode — write both artifacts ──
  mkdirSync(BASELINES_DIR, { recursive: true });
  const stamp = current.capturedAt.replace(/[:.]/g, '-');
  const jsonPath = join(BASELINES_DIR, `baseline-${stamp}.json`);
  const mdPath = join(BASELINES_DIR, `baseline-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(current, null, 2));
  writeFileSync(mdPath, renderBaselineMarkdown(current));
  process.stdout.write(`\nBaseline artifacts written:\n`);
  process.stdout.write(`  ${jsonPath}\n`);
  process.stdout.write(`  ${mdPath}\n`);
  process.stdout.write(`\nTotal mean cost across scenarios: $${current.totalMeanCostUsd.toFixed(4)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `measure.ts failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
