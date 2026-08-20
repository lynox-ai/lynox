// === Durable Knowledge Substrate — score persisted replay runs (the gate CLI) ===
//
// Scores one or two persisted replay results (the JSON files
// `knowledge-substrate-eval.test.ts` writes per run) through the §5.6 gate
// metric: tiered COVERAGE over the user-provenance denominator, and — with two
// results — the BINDING comparison gate (`meetsComparisonGate`). One result
// gives the per-run report only; the verdict needs both sides.
//
//   npx tsx tests/eval/knowledge-substrate-score.ts <dk-result.json> [<legacy-result.json>]
//
// The INSTRUMENT lives here; the DATA stays with the operator. Inputs:
//   LYNOX_KNOWLEDGE_GOLD    path to the gold corpus (.json GoldCorpus or .jsonl of
//                           GoldThread rows). Default: the path recorded in the
//                           result file itself — always vintage-checked by sha256.
//   LYNOX_KNOWLEDGE_LABELS  path to the fact labels (tier + provenance); both
//                           accepted shapes are parsed by `parseGoldFactLabels`.
//   SCORE_PROXY_URL         OpenAI-compatible /v1 base for the coverage judge.
//                           NO default — this is a public repo and operator-local
//                           endpoints do not belong in it.
//   SCORE_PROXY_KEY         bearer key (or SCORE_PROXY_KEY_FILE to read one).
//   SCORE_MODEL             judge model id.
//
// The scoring core (`scoreRuns`, `checkComparability`, `assertGoldVintage`) is
// exported and unit-tested in `knowledge-substrate-score.test.ts` — the gate's
// refuse-to-score paths must be able to FAIL a test, not just look right.
// Judge-error handling matches `scoreTieredCoverage`: a failed call is a
// MISSING verdict, counted and reported — never folded into the miss column.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  scoreTieredCoverage,
  meetsComparisonGate,
  formatTieredReport,
  formatComparison,
  parseGoldFactLabels,
  parseJudgeVerdict,
  JUDGE_SYSTEM_PROMPT,
  buildCoverageJudgePrompt,
  type CapturedEntry,
  type ComparisonVerdict,
  type CoverageJudge,
  type GoldCorpus,
  type GoldFactLabels,
  type GoldThread,
  type KnowledgeReplayReport,
  type TieredCoverageReport,
} from './knowledge-substrate-runner.js';

// ── Result-file shape (what the eval test persists) ──────────────────────────

export interface RunFile {
  mode?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  gold?: { path?: string | undefined; sha256?: string | undefined; threads?: number | undefined } | undefined;
  turnFailures?: { sends: number; turns: number } | undefined;
  report: KnowledgeReplayReport;
  captures?: Array<{ threadId: string; captured?: CapturedEntry[] | undefined }> | undefined;
}

export interface RunInput { file: string; run: RunFile }

// ── Refuse-to-score guards (each one throws — a broken guard must fail a test) ─

/** Every run must have been produced against the gold being scored with. */
export function assertGoldVintage(runs: ReadonlyArray<RunInput>, goldHash: string, goldPath: string): void {
  for (const r of runs) {
    const recorded = r.run.gold?.sha256;
    if (recorded !== undefined && recorded !== goldHash) {
      throw new Error(`⛔ GOLD VINTAGE MISMATCH: ${r.file} was produced against sha256=${recorded}, but ${goldPath} hashes to ${goldHash}. Scoring would judge a run against gold it never saw.`);
    }
  }
}

/**
 * The gate is ASYMMETRIC (routing-zero and junk-beat bind the DK side), so
 * which run is which must never depend on argument order alone: when the runs
 * carry a `mode`, it decides — and a swap is an error, not a reinterpretation.
 */
export function checkComparability(dk: RunInput, legacy: RunInput): string[] {
  const warnings: string[] = [];
  if (dk.run.model !== legacy.run.model) {
    throw new Error('⛔ DIFFERENT MODEL — these two runs are NOT comparable; no gate verdict.');
  }
  // A PRESENT mode that contradicts its position is already proof of a swap —
  // it must reject even when the other file predates the mode field.
  if (dk.run.mode !== undefined && dk.run.mode !== 'dk') {
    throw new Error(`⛔ MODE MISMATCH: first argument must be the dk result, got mode='${dk.run.mode}' — the gate's asymmetric clauses would bind the wrong side.`);
  }
  if (legacy.run.mode !== undefined && legacy.run.mode !== 'baseline') {
    throw new Error(`⛔ MODE MISMATCH: second argument must be the baseline result, got mode='${legacy.run.mode}' — the gate's asymmetric clauses would bind the wrong side.`);
  }
  if (dk.run.mode === undefined || legacy.run.mode === undefined) {
    warnings.push('⚠️ at least one run predates the mode field — argument order alone decides which side is DK.');
  }
  return warnings;
}

// ── The scoring core (pure given the judge; throws instead of exiting) ───────

export interface PerRunScore {
  file: string;
  run: RunFile;
  ranThreads: Set<string>;
  tiered: TieredCoverageReport;
}

export interface ScoreOutcome {
  perRun: PerRunScore[];
  /** Non-null only for a two-run invocation with IDENTICAL thread sets. */
  verdict: ComparisonVerdict | null;
  warnings: string[];
}

export async function scoreRuns(
  inputs: ReadonlyArray<RunInput>,
  corpus: GoldCorpus,
  labels: GoldFactLabels,
  judge: CoverageJudge,
): Promise<ScoreOutcome> {
  const warnings: string[] = [];
  const perRun: PerRunScore[] = [];
  for (const { file, run } of inputs) {
    const captures = run.captures ?? [];
    if (captures.length === 0) {
      throw new Error(`${file} has no per-thread captures — it predates the capture log and cannot be coverage-scored.`);
    }
    const ranThreads = new Set(captures.map(c => c.threadId));
    const captured = captures.flatMap(c => c.captured ?? []);
    const tiered = await scoreTieredCoverage(corpus, captured, labels, judge, { ranThreadIds: ranThreads });
    perRun.push({ file, run, ranThreads, tiered });
  }

  let verdict: ComparisonVerdict | null = null;
  if (inputs.length === 2) {
    const [dk, legacy] = perRun as [PerRunScore, PerRunScore];
    warnings.push(...checkComparability(dk, legacy));
    // The verdict's non-coverage axes (junk, attribution, routing) come
    // VERBATIM from each run's own report and cannot be re-scoped to a thread
    // subset here — so a verdict over differing thread sets would mix
    // denominators axis by axis. Refuse it instead of printing a plausible one:
    // the frozen-set workflow replays every thread on both sides anyway.
    const sameThreads = dk.ranThreads.size === legacy.ranThreads.size
      && [...dk.ranThreads].every(t => legacy.ranThreads.has(t));
    if (!sameThreads) {
      warnings.push('⚠️ thread sets differ — NO gate verdict (the junk/attribution/routing axes cannot be re-scoped to an intersection). Re-run both sides over the full frozen set.');
    } else {
      verdict = meetsComparisonGate(
        { tiered: dk.tiered, report: dk.run.report },
        { tiered: legacy.tiered, report: legacy.run.report },
      );
    }
  }
  return { perRun, verdict, warnings };
}

// ── CLI shell (env, fs, printing, exit codes) ────────────────────────────────

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function loadCorpus(path: string): GoldCorpus {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    const threads = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as GoldThread);
    return { version: 1, generatedAt: 'external', generator: path, threads };
  }
  return JSON.parse(raw) as GoldCorpus;
}

/** Exported for the fetch-mock test — the WIRING of the fenced prompt into the
 *  request body is what decides the gate, not the builders alone. */
export function makeFetchCoverageJudge(env: NodeJS.ProcessEnv = process.env): CoverageJudge {
  const base = env['SCORE_PROXY_URL'];
  if (!base) throw new Error('SCORE_PROXY_URL is not set — point it at an OpenAI-compatible /v1 base for the coverage judge.');
  const keyFile = env['SCORE_PROXY_KEY_FILE'];
  const key = (env['SCORE_PROXY_KEY'] ?? (keyFile ? readFileSync(keyFile, 'utf8') : '')).trim();
  if (!key) throw new Error('SCORE_PROXY_KEY (or SCORE_PROXY_KEY_FILE) is not set.');
  const model = env['SCORE_MODEL'];
  if (!model) throw new Error('SCORE_MODEL is not set.');

  const cache = new Map<string, boolean>();
  let done = 0;
  return async (gold: string, candidateBlock: string): Promise<boolean> => {
    const cacheKey = JSON.stringify([gold, candidateBlock]);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 10,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: buildCoverageJudgePrompt(gold, candidateBlock) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const out = body.choices?.[0]?.message?.content ?? '';
    done += 1;
    process.stderr.write(`\r  judging… ${done} calls`);
    const verdict = parseJudgeVerdict(out);
    cache.set(cacheKey, verdict);
    return verdict;
  };
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0 || files.length > 2) {
    fail('usage: npx tsx tests/eval/knowledge-substrate-score.ts <dk-result.json> [<legacy-result.json>]');
  }
  const inputs: RunInput[] = files.map(f => ({ file: f, run: JSON.parse(readFileSync(f, 'utf8')) as RunFile }));

  const goldPath = process.env['LYNOX_KNOWLEDGE_GOLD'] ?? inputs[0]!.run.gold?.path;
  if (!goldPath || goldPath === '(committed fixture)') {
    fail('No usable gold path — set LYNOX_KNOWLEDGE_GOLD (the result was scored against the committed fixture or predates the gold field).');
  }
  const goldHash = createHash('sha256').update(readFileSync(goldPath)).digest('hex').slice(0, 16);
  try {
    assertGoldVintage(inputs, goldHash, goldPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const corpus = loadCorpus(goldPath);

  const labelsPath = process.env['LYNOX_KNOWLEDGE_LABELS'];
  if (!labelsPath) fail('LYNOX_KNOWLEDGE_LABELS is not set — the tier/provenance labels are the gate\'s denominator.');
  const labels = parseGoldFactLabels(JSON.parse(readFileSync(labelsPath, 'utf8')));

  let judge: CoverageJudge;
  try {
    judge = makeFetchCoverageJudge();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let outcome: ScoreOutcome;
  try {
    outcome = await scoreRuns(inputs, corpus, labels, judge);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.stderr.write('\n');

  for (const { file, run, tiered } of outcome.perRun) {
    process.stdout.write(`\n### ${file}\n`);
    const tf = run.turnFailures;
    const failPct = tf && tf.turns > 0 ? (100 * tf.sends) / tf.turns : null;
    process.stdout.write(`  mode=${run.mode ?? '(unlabelled)'} model=${run.model ?? '?'} provider=${run.provider ?? '?'}\n`);
    process.stdout.write(`  turn failures: ${failPct !== null ? `${tf!.sends}/${tf!.turns} = ${failPct.toFixed(1)}%${failPct > 5 ? '   ⚠️ NOT A RESULT' : ''}` : 'NOT RECORDED'}\n`);
    process.stdout.write(`${formatTieredReport(tiered)}\n`);
    const j = run.report.junk;
    process.stdout.write(`  junk (verbatim from the run's own report): rate ${(100 * j.junkRate).toFixed(1)}% (${j.junkCount} of ${run.report.totalCaptured}) · junk-control writes ${j.junkControlWrites}\n`);
    process.stdout.write(`  routing: ${run.report.routing.violations.length} violation(s), ${run.report.routing.untrustedWrites} untrusted writes exercised\n`);
  }

  for (const w of outcome.warnings) process.stdout.write(`\n${w}\n`);
  if (outcome.verdict !== null) {
    process.stdout.write(`\n${formatComparison(outcome.verdict)}\n`);
    const errs = outcome.perRun.reduce((n, r) => n + r.tiered.judgeErrors.length, 0);
    if (errs > 0) {
      process.stdout.write(`⚠️ ${errs} judge call(s) failed across the two sides — those facts carry NO verdict; re-run before quoting the gate.\n`);
    }
  }
}

// Run only when invoked directly as a CLI (repo idiom, cf. gate-record.mjs) —
// an env sniff would also suppress a CLI spawned from inside a vitest process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
